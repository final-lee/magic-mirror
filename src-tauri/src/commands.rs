use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;
use tokio::sync::Notify;

use crate::adapters::{effective_region, find_adapter, service_info, AdapterRef};
use crate::adapters::s3::{self, S3Listing};
use crate::aws::context::{self, AwsContext, ProfileInfo};
use crate::aws::sso::{self, SsoLogins};
use crate::error::AppError;
use crate::model::{ListResult, ServiceInfo};
use crate::settings::{self, Settings};

pub struct AppState {
    pub ctx: AwsContext,
    pub adapters: Vec<AdapterRef>,
    pub settings_path: PathBuf,
    pub sso: SsoLogins,
}

impl AppState {
    fn service_ids(&self) -> Vec<&'static str> {
        self.adapters.iter().map(|a| a.service_id()).collect()
    }
}

#[tauri::command]
pub fn list_profiles() -> Vec<ProfileInfo> {
    context::list_profiles()
}

#[tauri::command]
pub async fn get_account(state: State<'_, AppState>, profile: String) -> Result<String, AppError> {
    state.ctx.account_id(&profile).await
}

#[tauri::command]
pub fn list_services(state: State<'_, AppState>) -> Vec<ServiceInfo> {
    state.adapters.iter().map(|a| service_info(a.as_ref())).collect()
}

#[tauri::command]
pub async fn list_resources(
    state: State<'_, AppState>,
    profile: String,
    region: String,
    service: String,
    type_id: String,
) -> Result<ListResult, AppError> {
    let adapter = find_adapter(&state.adapters, &service)?;
    let cfg = state.ctx.config(&profile, effective_region(adapter.as_ref(), &region)).await?;
    adapter.list(&cfg, &type_id).await
}

/// 이 프로필로 로그인할 때의 키와 `aws sso login`에 넘길 프로필. SSO 설정을 못 찾으면 그 프로필 자신이다(프론트엔드와 같은 규칙).
fn login_plan(profiles: &[ProfileInfo], profile: &str) -> (String, String) {
    match profiles.iter().find(|p| p.name == profile) {
        Some(ProfileInfo { sso_key: Some(key), sso_login: Some(target), .. }) => (key.clone(), target.clone()),
        _ => (format!("profile:{profile}"), profile.to_string()),
    }
}

/// 같은 로그인 키를 쓰는 프로필들: 로그인 뒤 새 토큰을 읽도록 캐시를 비울 대상. 요청한 프로필은 늘 들어 있다.
fn profiles_sharing(profiles: &[ProfileInfo], profile: &str, key: &str) -> Vec<String> {
    let mut names: Vec<String> = profiles.iter().filter(|p| p.sso_key.as_deref() == Some(key)).map(|p| p.name.clone()).collect();
    if !names.iter().any(|n| n == profile) {
        names.push(profile.to_string());
    }
    names
}

/// 로그인하고, 성공하면 같은 SSO 세션을 쓰는 프로필 전부의 SdkConfig 캐시를 비운다(실패하면 비우지 않는다).
/// `run`은 `aws sso login`에 넘길 프로필과 취소 신호를 받는다. 진행 중인 로그인은 그 프로필을 기억해서 `sso_login_cancel`이 찾는다.
async fn login_and_forget<F, Fut>(sso: &SsoLogins, ctx: &AwsContext, profiles: &[ProfileInfo], profile: &str, run: F) -> Result<(), AppError>
where
    F: FnOnce(String, Arc<Notify>) -> Fut,
    Fut: Future<Output = Result<(), AppError>> + Send + 'static,
{
    let (key, target) = login_plan(profiles, profile);
    sso.login(&key, &target, run).await?;
    ctx.forget_profiles(&profiles_sharing(profiles, profile, &key)).await;
    Ok(())
}

#[tauri::command]
pub async fn sso_login(state: State<'_, AppState>, profile: String) -> Result<(), AppError> {
    let profiles = context::list_profiles();
    login_and_forget(&state.sso, &state.ctx, &profiles, &profile, sso::run_aws_sso_login).await
}

/// 진행 중인 로그인을 취소한다. `profile`은 프론트엔드가 `sso_login`에 넘긴 프로필, 곧 `aws sso login`에 넘어간 대상이다.
/// 지금의 `~/.aws/config`로 키를 다시 계산하지 않는다. 로그인이 도는 동안 config를 고치면 키가 달라져서 [취소]가 빗나가기 때문이다.
/// 도는 로그인이 기억한 대상으로 찾는다.
#[tauri::command]
pub async fn sso_login_cancel(state: State<'_, AppState>, profile: String) -> Result<(), AppError> {
    state.sso.cancel_target(&profile).await;
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    settings::load(&state.settings_path, &state.service_ids())
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), AppError> {
    settings::save(&state.settings_path, &settings)
}

#[tauri::command]
pub async fn list_s3_objects(
    state: State<'_, AppState>,
    profile: String,
    region: String,
    bucket: String,
    prefix: String,
    continuation_token: Option<String>,
) -> Result<S3Listing, AppError> {
    let region = if region.is_empty() { context::GLOBAL_REGION.to_string() } else { region };
    let cfg = state.ctx.config(&profile, &region).await?;
    s3::list_objects(&cfg, &bucket, &prefix, continuation_token).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn p(name: &str, sso: Option<(&str, &str)>) -> ProfileInfo {
        ProfileInfo { name: name.into(), region: None, sso_login: sso.map(|s| s.0.into()), sso_key: sso.map(|s| s.1.into()) }
    }

    #[test]
    fn login_plan_uses_the_sso_source_and_falls_back_to_the_profile() {
        let profiles = vec![p("base", Some(("base", "session:corp"))), p("admin", Some(("base", "session:corp"))), p("keys", None)];
        assert_eq!(login_plan(&profiles, "admin"), ("session:corp".into(), "base".into()));
        assert_eq!(login_plan(&profiles, "keys"), ("profile:keys".into(), "keys".into()));
        assert_eq!(login_plan(&profiles, "missing"), ("profile:missing".into(), "missing".into()));
    }

    #[test]
    fn profiles_sharing_lists_every_profile_of_the_session() {
        let profiles = vec![p("base", Some(("base", "session:corp"))), p("admin", Some(("base", "session:corp"))), p("other", Some(("other", "session:x")))];
        assert_eq!(profiles_sharing(&profiles, "admin", "session:corp"), vec!["base".to_string(), "admin".to_string()]);
        assert_eq!(profiles_sharing(&profiles, "keys", "profile:keys"), vec!["keys".to_string()]);
    }

    /// `base`와 `admin`은 같은 SSO 세션(`session:corp`)을 쓰고, `other`는 다른 세션, `keys`는 SSO가 아니다. 넷 다 캐시에 있다.
    async fn corp_fixture() -> (Vec<ProfileInfo>, AwsContext) {
        let profiles = vec![
            p("base", Some(("base", "session:corp"))),
            p("admin", Some(("base", "session:corp"))),
            p("other", Some(("other", "session:x"))),
            p("keys", None),
        ];
        let ctx = AwsContext::default();
        for name in ["base", "admin", "other", "keys"] {
            ctx.cache_profile_for_test(name).await;
        }
        (profiles, ctx)
    }

    #[tokio::test]
    async fn a_successful_login_forgets_every_profile_of_the_session_and_only_those() {
        let (profiles, ctx) = corp_fixture().await;
        let logged_in_as = Arc::new(std::sync::Mutex::new(Vec::new()));
        let run = {
            let logged_in_as = logged_in_as.clone();
            move |target: String, _cancel: Arc<Notify>| async move {
                logged_in_as.lock().unwrap().push(target);
                Ok(())
            }
        };
        let result = tokio::time::timeout(Duration::from_secs(5), login_and_forget(&SsoLogins::default(), &ctx, &profiles, "admin", run)).await;
        assert_eq!(result.expect("did not finish within 5s"), Ok(()));
        // admin을 눌러도 `aws sso login`은 SSO 프로필(base)로 돈다
        assert_eq!(*logged_in_as.lock().unwrap(), vec!["base".to_string()]);
        assert_eq!(ctx.cached_profiles_for_test().await, vec!["keys".to_string(), "other".to_string()]);
    }

    #[tokio::test]
    async fn cancel_ends_the_running_login_even_after_the_config_changed() {
        let (before, ctx) = corp_fixture().await;
        let sso = SsoLogins::default();
        let run = |_target: String, cancel: Arc<Notify>| async move {
            cancel.notified().await;
            Err(AppError::other(sso::CANCELLED))
        };
        // 프론트엔드가 admin으로 로그인을 열면 `aws sso login`은 base로 돈다(키는 session:corp)
        let login = login_and_forget(&sso, &ctx, &before, "admin", run);
        let edit_then_cancel = async {
            while !sso.is_running("session:corp").await {
                tokio::task::yield_now().await;
            }
            // 로그인이 도는 동안 sso-session 이름을 바꿨다: 지금의 설정으로 계산한 키는 도는 로그인의 키와 다르다
            let after = vec![p("base", Some(("base", "session:renamed"))), p("admin", Some(("base", "session:renamed")))];
            assert_eq!(login_plan(&after, "base"), ("session:renamed".into(), "base".into()));
            assert!(!sso.is_running("session:renamed").await);
            // [취소]는 `sso_login`에 넘긴 프로필만 보낸다
            sso.cancel_target("base").await;
        };
        let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(login, edit_then_cancel) })
            .await
            .expect("did not finish within 5s");
        assert_eq!(result, Err(AppError::other(sso::CANCELLED)));
        // 취소는 실패와 같다: 캐시를 비우지 않는다
        assert_eq!(
            ctx.cached_profiles_for_test().await,
            vec!["admin".to_string(), "base".to_string(), "keys".to_string(), "other".to_string()]
        );
    }

    #[tokio::test]
    async fn a_failed_login_forgets_nothing() {
        let (profiles, ctx) = corp_fixture().await;
        let run = |_target: String, _cancel: Arc<Notify>| async { Err(AppError::other("boom")) };
        let result = tokio::time::timeout(Duration::from_secs(5), login_and_forget(&SsoLogins::default(), &ctx, &profiles, "admin", run)).await;
        assert_eq!(result.expect("did not finish within 5s"), Err(AppError::other("boom")));
        assert_eq!(
            ctx.cached_profiles_for_test().await,
            vec!["admin".to_string(), "base".to_string(), "keys".to_string(), "other".to_string()]
        );
    }
}
