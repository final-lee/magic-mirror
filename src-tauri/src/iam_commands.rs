//! IAM 작업 공간의 읽기 명령. 계정의 IAM 상태(스냅숏)는 프로필마다 한 번 읽어 캐시해 두고, 대부분의 명령은 그 스냅숏으로 계산한다.
//! IAM은 글로벌 서비스라 리전은 `GLOBAL_REGION`을 쓴다. 이 파일의 AWS 호출은 모두 읽기 전용이다.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use tauri::State;

use crate::aws::context::GLOBAL_REGION;
use crate::commands::AppState;
use crate::error::AppError;
use crate::iam::catalog::{catalog, AccessLevel};
use crate::iam::clock::now_secs;
use crate::iam::eval::{evaluate, principal_actions, principal_view, who_can};
use crate::iam::fetch::checks::{self, SimulateResult, ValidationResult};
use crate::iam::fetch::keys::{self, AccessKeyInfo};
use crate::iam::fetch::policies::{self, PolicyRef};
use crate::iam::fetch::{self, usage};
use crate::iam::findings::{findings, Findings};
use crate::iam::lastused::{last_accessed, LastAccessed};
use crate::iam::model::Snapshot;
use crate::iam::overview::{apply_credentials, overview, IamOverview};
use crate::iam::summary::policy_view;
use crate::iam::view::{ActionGrant, PolicyView, PrincipalView, WhoCanResult};

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 프로필마다 한 번 읽어 두는 값의 캐시. 같은 프로필에서 읽는 동안 다른 요청은 기다렸다가 그 결과를 쓴다(같은 일을 또 하지 않는다).
struct Cache<T> {
    entries: Mutex<HashMap<String, Arc<T>>>,
    /// 프로필마다 하나씩 읽는 차례를 지키는 자물쇠
    gates: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl<T> Default for Cache<T> {
    fn default() -> Self {
        Cache { entries: Mutex::default(), gates: Mutex::default() }
    }
}

impl<T> Cache<T> {
    fn get(&self, profile: &str) -> Option<Arc<T>> {
        locked(&self.entries).get(profile).cloned()
    }

    fn remove(&self, profile: &str) {
        locked(&self.entries).remove(profile);
    }

    /// 캐시에 있으면 그것을, 없으면 `fetch`로 읽어 담는다. 읽기에 실패하면 담지 않는다.
    async fn get_or_fetch<F, Fut>(&self, profile: &str, fetch: F) -> Result<Arc<T>, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, AppError>>,
    {
        let gate = locked(&self.gates).entry(profile.to_string()).or_default().clone();
        let _turn = gate.lock().await;
        if let Some(hit) = self.get(profile) {
            return Ok(hit);
        }
        let fresh = Arc::new(fetch().await?);
        locked(&self.entries).insert(profile.to_string(), fresh.clone());
        Ok(fresh)
    }
}

/// 읽어 둔 값들. 앱이 시작할 때 한 번 `manage`한다.
#[derive(Default)]
pub struct IamState {
    snapshots: Cache<Snapshot>,
    /// 정책 붙이기 선택용 목록(고객 관리형 + AWS 관리형, 이름순). 프로필마다 한 번만 읽는다
    policy_lists: Cache<Vec<PolicyRef>>,
}

/// 읽어 둔 스냅숏을 버린다. 다음 요청이 새로 읽는다. 변경을 적용한 뒤에 부른다.
pub fn invalidate(iam: &IamState, profile: &str) {
    iam.snapshots.remove(profile);
}

async fn snapshot_with<F, Fut>(iam: &IamState, profile: &str, force: bool, fetch: F) -> Result<Arc<Snapshot>, AppError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Snapshot, AppError>>,
{
    if force {
        // 새로 고침은 읽어 둔 것을 모두 버리고 다시 읽는다. 정책 목록은 다음에 필요할 때 읽는다.
        // 새로 고침이 겹치면 먼저 온 쪽이 읽는 동안 나머지는 기다렸다가 그 결과를 쓴다
        invalidate(iam, profile);
        iam.policy_lists.remove(profile);
    }
    iam.snapshots.get_or_fetch(profile, fetch).await
}

/// 프로필의 IAM 스냅숏. `force`면 캐시를 버리고 새로 읽는다.
pub async fn snapshot(state: &AppState, iam: &IamState, profile: &str, force: bool) -> Result<Arc<Snapshot>, AppError> {
    snapshot_with(iam, profile, force, || async {
        let cfg = state.ctx.config(profile, GLOBAL_REGION).await?;
        fetch::fetch_snapshot(&cfg).await
    })
    .await
}

async fn iam_client(state: &AppState, profile: &str) -> Result<aws_sdk_iam::Client, AppError> {
    let cfg = state.ctx.config(profile, GLOBAL_REGION).await?;
    Ok(aws_sdk_iam::Client::new(&cfg))
}

fn unknown_principal(arn: &str) -> AppError {
    AppError::other(format!("알 수 없는 사용자·그룹·역할이에요: {arn}"))
}

/// 스냅숏에 있는 사용자·그룹·역할인지. 지워졌거나 이름이 바뀐 주체를 빈 결과로 보여 주지 않으려고 먼저 확인한다.
fn known_principal(s: &Snapshot, arn: &str) -> Result<(), AppError> {
    s.principal_kind(arn).map(|_| ()).ok_or_else(|| unknown_principal(arn))
}

/// 비어 있거나 공백뿐인 리소스는 "대상을 정하지 않음"이다.
fn clean_resource(resource: Option<String>) -> Option<String> {
    resource.map(|r| r.trim().to_string()).filter(|r| !r.is_empty())
}

/// 카탈로그의 모든 작업 이름("s3:GetObject" …). 정렬돼 있고 한 번만 만든다.
fn action_names() -> &'static [String] {
    static NAMES: OnceLock<Vec<String>> = OnceLock::new();
    NAMES.get_or_init(|| catalog().all_action_names())
}

#[tauri::command]
pub async fn iam_overview(state: State<'_, AppState>, iam: State<'_, IamState>, profile: String, force: bool) -> Result<IamOverview, AppError> {
    let s = snapshot(&state, &iam, &profile, force).await?;
    Ok(overview(&s, now_secs()))
}

#[tauri::command]
pub async fn iam_principal(state: State<'_, AppState>, iam: State<'_, IamState>, profile: String, arn: String) -> Result<PrincipalView, AppError> {
    let s = snapshot(&state, &iam, &profile, false).await?;
    let mut view = principal_view(&s, &arn).ok_or_else(|| unknown_principal(&arn))?;
    apply_credentials(&s, &mut view.summary, now_secs());
    Ok(view)
}

#[tauri::command]
pub async fn iam_principal_actions(
    state: State<'_, AppState>,
    iam: State<'_, IamState>,
    profile: String,
    arn: String,
    prefix: String,
    level: AccessLevel,
) -> Result<Vec<ActionGrant>, AppError> {
    let s = snapshot(&state, &iam, &profile, false).await?;
    known_principal(&s, &arn)?;
    Ok(principal_actions(&s, &arn, &prefix, level))
}

#[tauri::command]
pub async fn iam_policy(state: State<'_, AppState>, iam: State<'_, IamState>, profile: String, policy_id: String) -> Result<PolicyView, AppError> {
    let s = snapshot(&state, &iam, &profile, false).await?;
    policy_view(&s, &policy_id).ok_or_else(|| AppError::other(format!("정책을 찾을 수 없어요: {policy_id}")))
}

/// 작업 이름 2만여 개를 만들어 보내는 일이라 메인 스레드가 아니라 비동기 쪽에서 한다.
#[tauri::command]
pub async fn iam_actions() -> Vec<String> {
    action_names().to_vec()
}

#[tauri::command]
pub async fn iam_who_can(
    state: State<'_, AppState>,
    iam: State<'_, IamState>,
    profile: String,
    action: String,
    resource: Option<String>,
) -> Result<WhoCanResult, AppError> {
    let action = action.trim();
    if action.is_empty() {
        return Err(AppError::other("작업 이름을 입력해 주세요"));
    }
    let resource = clean_resource(resource);
    let s = snapshot(&state, &iam, &profile, false).await?;
    let mut result = who_can(&s, action, resource.as_deref());
    let now = now_secs();
    for hit in &mut result.hits {
        apply_credentials(&s, &mut hit.principal, now);
    }
    Ok(result)
}

#[tauri::command]
pub async fn iam_simulate(
    state: State<'_, AppState>,
    profile: String,
    principal_arns: Vec<String>,
    action: String,
    resource: Option<String>,
) -> Result<Vec<SimulateResult>, AppError> {
    let client = iam_client(&state, &profile).await?;
    checks::simulate(&client, principal_arns, action.trim(), clean_resource(resource).as_deref()).await
}

#[tauri::command]
pub async fn iam_findings(state: State<'_, AppState>, iam: State<'_, IamState>, profile: String) -> Result<Findings, AppError> {
    let s = snapshot(&state, &iam, &profile, false).await?;
    Ok(findings(&s, now_secs()))
}

#[tauri::command]
pub async fn iam_access_keys(state: State<'_, AppState>, profile: String, user_name: String) -> Result<Vec<AccessKeyInfo>, AppError> {
    let client = iam_client(&state, &profile).await?;
    keys::fetch_keys(&client, &user_name, now_secs()).await
}

#[tauri::command]
pub async fn iam_last_accessed(state: State<'_, AppState>, iam: State<'_, IamState>, profile: String, arn: String) -> Result<LastAccessed, AppError> {
    let s = snapshot(&state, &iam, &profile, false).await?;
    let eval = evaluate(&s, &arn).ok_or_else(|| unknown_principal(&arn))?;
    let client = iam_client(&state, &profile).await?;
    let raw = usage::fetch_usage(&client, &arn).await?;
    Ok(last_accessed(&eval, &raw, &s, &arn))
}

#[tauri::command]
pub async fn iam_list_policies(state: State<'_, AppState>, iam: State<'_, IamState>, profile: String, query: String) -> Result<Vec<PolicyRef>, AppError> {
    let all = iam
        .policy_lists
        .get_or_fetch(&profile, || async {
            let client = iam_client(&state, &profile).await?;
            policies::fetch_refs(&client).await
        })
        .await?;
    Ok(policies::search(&all, &query, policies::MAX_RESULTS))
}

#[tauri::command]
pub async fn iam_validate_policy(state: State<'_, AppState>, profile: String, document: String) -> Result<ValidationResult, AppError> {
    // 문법이 틀리면 자격 증명 없이 바로 알려 준다
    if let Some(failure) = checks::syntax_failure(&document) {
        return Ok(failure);
    }
    let cfg = state.ctx.config(&profile, GLOBAL_REGION).await?;
    Ok(checks::validate(&cfg, &document).await)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::iam::model::Scope;

    fn snapshot_of(account: &str) -> Snapshot {
        Snapshot { account_id: account.into(), ..Default::default() }
    }

    /// 읽을 때마다 번호를 올려 몇 번 읽었는지 센다. 읽기 도중 한 번 양보해서 다른 요청이 끼어들 틈을 준다.
    async fn counted(calls: &AtomicUsize, account: &str) -> Result<Snapshot, AppError> {
        calls.fetch_add(1, Ordering::SeqCst);
        tokio::task::yield_now().await;
        Ok(snapshot_of(account))
    }

    #[tokio::test]
    async fn a_cached_snapshot_is_reused() {
        let (iam, calls) = (IamState::default(), AtomicUsize::new(0));
        let a = snapshot_with(&iam, "dev", false, || counted(&calls, "1")).await.unwrap();
        let b = snapshot_with(&iam, "dev", false, || counted(&calls, "2")).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(b.account_id, "1");
    }

    #[tokio::test]
    async fn profiles_are_cached_separately() {
        let (iam, calls) = (IamState::default(), AtomicUsize::new(0));
        let dev = snapshot_with(&iam, "dev", false, || counted(&calls, "1")).await.unwrap();
        let prod = snapshot_with(&iam, "prod", false, || counted(&calls, "2")).await.unwrap();
        assert_eq!((dev.account_id.as_str(), prod.account_id.as_str()), ("1", "2"));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        invalidate(&iam, "dev");
        assert!(iam.snapshots.get("dev").is_none() && iam.snapshots.get("prod").is_some());
    }

    #[tokio::test]
    async fn force_reads_again_and_replaces_the_cached_snapshot() {
        let (iam, calls) = (IamState::default(), AtomicUsize::new(0));
        snapshot_with(&iam, "dev", false, || counted(&calls, "old")).await.unwrap();
        let fresh = snapshot_with(&iam, "dev", true, || counted(&calls, "new")).await.unwrap();
        assert_eq!((fresh.account_id.as_str(), calls.load(Ordering::SeqCst)), ("new", 2));
        let again = snapshot_with(&iam, "dev", false, || counted(&calls, "never")).await.unwrap();
        assert!(Arc::ptr_eq(&fresh, &again));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn invalidate_makes_the_next_request_read_again() {
        let (iam, calls) = (IamState::default(), AtomicUsize::new(0));
        snapshot_with(&iam, "dev", false, || counted(&calls, "1")).await.unwrap();
        invalidate(&iam, "dev");
        let next = snapshot_with(&iam, "dev", false, || counted(&calls, "2")).await.unwrap();
        assert_eq!((next.account_id.as_str(), calls.load(Ordering::SeqCst)), ("2", 2));
    }

    #[tokio::test]
    async fn requests_that_arrive_together_share_one_read() {
        let (iam, calls) = (IamState::default(), AtomicUsize::new(0));
        let (a, b, c) = tokio::join!(
            snapshot_with(&iam, "dev", false, || counted(&calls, "1")),
            snapshot_with(&iam, "dev", false, || counted(&calls, "2")),
            snapshot_with(&iam, "dev", false, || counted(&calls, "3")),
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(Arc::ptr_eq(&a.unwrap(), &b.unwrap()) && c.is_ok());
    }

    #[tokio::test]
    async fn refreshes_that_arrive_together_share_one_read() {
        let (iam, calls) = (IamState::default(), AtomicUsize::new(0));
        snapshot_with(&iam, "dev", false, || counted(&calls, "old")).await.unwrap();
        let (a, b) = tokio::join!(snapshot_with(&iam, "dev", true, || counted(&calls, "new-a")), snapshot_with(&iam, "dev", true, || counted(&calls, "new-b")));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!((a.unwrap().account_id.as_str(), b.unwrap().account_id.as_str()), ("new-a", "new-a"));
    }

    #[tokio::test]
    async fn a_failed_read_is_not_cached() {
        let iam = IamState::default();
        let failed = snapshot_with(&iam, "dev", false, || async { Err::<Snapshot, _>(AppError::SsoExpired) }).await;
        assert_eq!(failed.err(), Some(AppError::SsoExpired));
        let calls = AtomicUsize::new(0);
        let ok = snapshot_with(&iam, "dev", false, || counted(&calls, "1")).await.unwrap();
        assert_eq!((ok.account_id.as_str(), calls.load(Ordering::SeqCst)), ("1", 1));
    }

    #[tokio::test]
    async fn a_failed_refresh_leaves_no_stale_snapshot_behind() {
        let (iam, calls) = (IamState::default(), AtomicUsize::new(0));
        snapshot_with(&iam, "dev", false, || counted(&calls, "old")).await.unwrap();
        let failed = snapshot_with(&iam, "dev", true, || async { Err::<Snapshot, _>(AppError::Throttled) }).await;
        assert_eq!(failed.err(), Some(AppError::Throttled));
        assert!(iam.snapshots.get("dev").is_none());
    }

    fn one_policy(name: &str) -> Vec<PolicyRef> {
        vec![PolicyRef { arn: format!("arn:aws:iam::1:policy/{name}"), name: name.into(), scope: Scope::Local, description: None, badges: vec![] }]
    }

    #[tokio::test]
    async fn a_refresh_also_drops_the_policy_list_but_a_write_invalidation_keeps_it() {
        let iam = IamState::default();
        iam.policy_lists.get_or_fetch("dev", || async { Ok::<_, AppError>(one_policy("first")) }).await.unwrap();
        invalidate(&iam, "dev");
        assert_eq!(iam.policy_lists.get("dev").unwrap()[0].name, "first");
        snapshot_with(&iam, "dev", true, || async { Ok(snapshot_of("1")) }).await.unwrap();
        assert!(iam.policy_lists.get("dev").is_none());
        let second = iam.policy_lists.get_or_fetch("dev", || async { Ok::<_, AppError>(one_policy("second")) }).await.unwrap();
        assert_eq!(second[0].name, "second");
    }

    #[tokio::test]
    async fn policy_list_requests_that_arrive_together_share_one_read() {
        let (iam, calls) = (IamState::default(), AtomicUsize::new(0));
        let fetch = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok::<_, AppError>(Vec::new())
        };
        let (a, b) = tokio::join!(iam.policy_lists.get_or_fetch("dev", fetch), iam.policy_lists.get_or_fetch("dev", fetch));
        assert!(a.is_ok() && b.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn only_principals_in_the_snapshot_are_known() {
        let s = crate::iam::fixtures::snapshot();
        for arn in [crate::iam::fixtures::ALICE, crate::iam::fixtures::ADMINS, crate::iam::fixtures::DEPLOY] {
            assert_eq!(known_principal(&s, arn), Ok(()), "{arn}");
        }
        let missing = "arn:aws:iam::111111111111:user/nobody";
        assert_eq!(known_principal(&s, missing), Err(AppError::other(format!("알 수 없는 사용자·그룹·역할이에요: {missing}"))));
        assert!(known_principal(&s, "").is_err());
    }

    #[test]
    fn blank_resources_mean_no_target() {
        assert_eq!(clean_resource(None), None);
        assert_eq!(clean_resource(Some(String::new())), None);
        assert_eq!(clean_resource(Some("   ".into())), None);
        assert_eq!(clean_resource(Some(" arn:aws:s3:::b/* ".into())).as_deref(), Some("arn:aws:s3:::b/*"));
    }

    #[tokio::test]
    async fn the_action_list_is_sorted_complete_and_built_once() {
        let names = iam_actions().await;
        assert_eq!(names.len(), catalog().all_count());
        assert!(names.windows(2).all(|w| w[0] < w[1]));
        assert!(names.contains(&"s3:GetObject".to_string()));
        assert!(std::ptr::eq(action_names().as_ptr(), action_names().as_ptr()));
        assert_eq!(names, action_names());
    }
}
