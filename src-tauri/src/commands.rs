use std::path::PathBuf;

use tauri::State;

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

#[tauri::command]
pub async fn sso_login(state: State<'_, AppState>, profile: String) -> Result<(), AppError> {
    let profiles = context::list_profiles();
    let (key, target) = login_plan(&profiles, &profile);
    state.sso.login(&key, move |cancel| sso::run_aws_sso_login(target, cancel)).await?;
    state.ctx.forget_profiles(&profiles_sharing(&profiles, &profile, &key)).await;
    Ok(())
}

#[tauri::command]
pub async fn sso_login_cancel(state: State<'_, AppState>, profile: String) -> Result<(), AppError> {
    let (key, _) = login_plan(&context::list_profiles(), &profile);
    state.sso.cancel(&key).await;
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
}
