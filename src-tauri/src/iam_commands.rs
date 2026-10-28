//! IAM 작업 공간의 명령. 계정의 IAM 상태(스냅숏)는 프로필마다 한 번 읽어 캐시해 두고, 대부분의 명령은 그 스냅숏으로 계산한다.
//! IAM은 글로벌 서비스라 리전은 `GLOBAL_REGION`을 쓴다. 이 파일의 AWS 호출은 모두 읽기 전용이다:
//! 변경(`iam_apply`, 묶음은 `iam_apply_batch`)은 `iam::commit`이 거른 뒤 `iam::write`가 한다.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use aws_config::SdkConfig;
use aws_credential_types::provider::ProvideCredentials;
use tauri::State;

use crate::aws::context::GLOBAL_REGION;
use crate::commands::AppState;
use crate::error::AppError;
use crate::iam::catalog::{catalog, AccessLevel};
use crate::iam::change::{deletes_policy_version, missing_policy, ordered, preview, preview_batch, ApiCall, BatchPreview, ChangePreview, Facts, IamChange, PolicyCheck, MAX_BATCH};
use crate::iam::clock::{now_secs, parse_iso};
use crate::iam::commit::batch::{commit_batch, undo_batch_of, BatchRequest, BatchResult, UndoBatch};
use crate::iam::commit::plan::BatchPlan;
use crate::iam::commit::{commit, is_stale, new_log_id, undo_change_of, ApplyResult, Plan, PlanStore, Request};
use crate::iam::eval::{evaluate, principal_actions, principal_view, who_can};
use crate::iam::fetch::checks::{self, FindingLevel, SimulateResult, ValidationResult};
use crate::iam::fetch::keys::{self, AccessKeyInfo, KeyStatus};
use crate::iam::fetch::policies::{self, PolicyRef};
use crate::iam::fetch::{self, usage};
use crate::iam::fetch_policy::ensure_policy;
use crate::iam::findings::{add_key_fixes, findings, key_fix_users, Findings};
use crate::iam::lastused::{last_accessed, LastAccessed};
use crate::iam::log::{self as change_log, ChangeLogEntry};
use crate::iam::model::Snapshot;
use crate::iam::overview::{apply_credentials, overview, IamOverview};
use crate::iam::summary::policy_view;
use crate::iam::view::{ActionGrant, PolicyView, PrincipalView, WhoCanResult};
use crate::iam::write;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 캐시의 프로필 한 칸. `generation`은 무효화(변경 적용 뒤, 새로 고침)할 때마다 오른다.
struct Slot<T> {
    generation: u64,
    value: Option<Arc<T>>,
}

impl<T> Default for Slot<T> {
    fn default() -> Self {
        Slot { generation: 0, value: None }
    }
}

/// 프로필마다 한 번 읽어 두는 값의 캐시. 같은 프로필에서 읽는 동안 다른 요청은 기다렸다가 그 결과를 쓴다(같은 일을 또 하지 않는다).
/// 읽기는 시작할 때의 세대를 기억해 두고, 끝났을 때 세대가 그대로일 때만 결과를 담는다. 읽는 도중에 무효화됐으면
/// 그 결과는 무효화 전의 상태일 수 있어서 담지 않는다: 그 읽기를 시작한 요청만 그 결과를 받고, 기다리던 요청은 차례가 오면 다시 읽는다.
struct Cache<T> {
    slots: Mutex<HashMap<String, Slot<T>>>,
    /// 프로필마다 하나씩 읽는 차례를 지키는 자물쇠
    gates: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl<T> Default for Cache<T> {
    fn default() -> Self {
        Cache { slots: Mutex::default(), gates: Mutex::default() }
    }
}

impl<T> Cache<T> {
    #[cfg(test)]
    fn get(&self, profile: &str) -> Option<Arc<T>> {
        locked(&self.slots).get(profile).and_then(|slot| slot.value.clone())
    }

    /// 담아 둔 값을 버리고 세대를 올린다. 지금 진행 중인 읽기의 결과도 담기지 않는다.
    fn invalidate(&self, profile: &str) {
        let mut slots = locked(&self.slots);
        let slot = slots.entry(profile.to_string()).or_default();
        slot.generation += 1;
        slot.value = None;
    }

    /// 캐시에 있으면 그것을, 없으면 `fetch`로 읽어 담는다. 읽기에 실패하면 담지 않는다.
    async fn get_or_fetch<F, Fut>(&self, profile: &str, fetch: F) -> Result<Arc<T>, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, AppError>>,
    {
        let gate = locked(&self.gates).entry(profile.to_string()).or_default().clone();
        let _turn = gate.lock().await;
        let started = {
            let slots = locked(&self.slots);
            let slot = slots.get(profile);
            if let Some(hit) = slot.and_then(|slot| slot.value.clone()) {
                return Ok(hit);
            }
            slot.map_or(0, |slot| slot.generation)
        };
        let fresh = Arc::new(fetch().await?);
        let mut slots = locked(&self.slots);
        let slot = slots.entry(profile.to_string()).or_default();
        if slot.generation == started {
            slot.value = Some(fresh.clone());
        }
        Ok(fresh)
    }
}

/// 읽어 둔 값들. 앱이 시작할 때 한 번 `manage`한다.
#[derive(Default)]
pub struct IamState {
    snapshots: Cache<Snapshot>,
    /// 정책 붙이기 선택용 목록(고객 관리형 + AWS 관리형, 이름순). 프로필마다 한 번만 읽는다
    policy_lists: Cache<Vec<PolicyRef>>,
    /// 변경 기록 파일(`iam-changes.jsonl`)의 경로
    log_path: PathBuf,
    /// 미리보기에서 사용자가 본 계획. 적용할 때 다시 계산한 계획과 견준다
    plans: Mutex<PlanStore>,
    /// 묶음 미리보기에서 사용자가 본 계획
    batch_plans: Mutex<PlanStore<BatchPlan>>,
    /// 프로필마다 마지막으로 IAM을 바꾼 시각(유닉스 초)
    written: Mutex<HashMap<String, i64>>,
}

impl IamState {
    pub fn new(log_path: PathBuf) -> IamState {
        IamState { log_path, ..Default::default() }
    }
}

/// 읽어 둔 스냅숏을 버린다. 다음 요청이 새로 읽고, 지금 진행 중인 읽기의 결과는 캐시에 남지 않는다. 변경을 적용한 뒤에 부른다.
pub fn invalidate(iam: &IamState, profile: &str) {
    iam.snapshots.invalidate(profile);
}

async fn snapshot_with<F, Fut>(iam: &IamState, profile: &str, force: bool, fetch: F) -> Result<Arc<Snapshot>, AppError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Snapshot, AppError>>,
{
    if force {
        // 새로 고침(⌘R)은 읽어 둔 것을 모두 버리고, 새로 고침보다 먼저 시작한 읽기의 결과도 쓰지 않는다. 정책 목록은 다음에 필요할 때 읽는다.
        // 새로 고침 뒤에 시작한 읽기는 함께 쓴다(새로 고침 여러 개가 같은 읽기를 기다리면 한 번만 읽는다)
        iam.policy_lists.invalidate(profile);
        return reread(iam, profile, fetch).await;
    }
    iam.snapshots.get_or_fetch(profile, fetch).await
}

/// 스냅숏만 버리고 새로 읽는다. 정책 붙이기 선택 목록은 그대로 둔다: 미리보기·적용 전에 낡은 스냅숏을 다시 읽을 때 쓰고,
/// 그 목록(정책 이름과 ARN)은 IAM 변경으로 달라지지 않는다.
async fn reread<F, Fut>(iam: &IamState, profile: &str, fetch: F) -> Result<Arc<Snapshot>, AppError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Snapshot, AppError>>,
{
    invalidate(iam, profile);
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

/// 점검에 액세스 키 빠른 조치를 단다. 액세스 키 점검에 걸린 사용자가 있을 때만 클라이언트를 만들어(`client`) 그 사용자들의 키 목록을
/// 읽는다(읽기만). 목록을 못 읽은 사용자는 경고로 남고(`add_key_fixes`), SSO 만료만 오류다(`keys::list_keys`).
async fn with_key_fixes<C, Fut>(mut found: Findings, client: C) -> Result<Findings, AppError>
where
    C: FnOnce() -> Fut,
    Fut: Future<Output = Result<aws_sdk_iam::Client, AppError>>,
{
    let users = key_fix_users(&found);
    if !users.is_empty() {
        add_key_fixes(&mut found, &keys::list_keys(&client().await?, users).await?);
    }
    Ok(found)
}

/// 보안 점검. 액세스 키 점검에 걸린 사용자가 있으면 그 사용자들의 키 목록을 읽어(읽기만) 키를 찾고 빠른 조치를 단다.
#[tauri::command]
pub async fn iam_findings(state: State<'_, AppState>, iam: State<'_, IamState>, profile: String) -> Result<Findings, AppError> {
    let s = snapshot(&state, &iam, &profile, false).await?;
    with_key_fixes(findings(&s, now_secs()), || iam_client(&state, &profile)).await
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
    // ListPolicies는 설명을 주지 않는다. 고객 관리형 정책의 설명은 스냅숏에서 채운다
    let s = snapshot(&state, &iam, &profile, false).await?;
    Ok(policies::describe(policies::search(&all, &query, policies::MAX_RESULTS), &s))
}

#[tauri::command]
pub async fn iam_validate_policy(state: State<'_, AppState>, profile: String, document: String) -> Result<ValidationResult, AppError> {
    // 문법이 틀리면 자격 증명 없이 바로 알려 준다
    if let Some(failure) = checks::syntax_failure(&document) {
        return Ok(failure);
    }
    let cfg = state.ctx.config(&profile, GLOBAL_REGION).await?;
    checks::validate(&cfg, &document).await
}

// ── 변경(쓰기) ──────────────────────────────────────────────────────────

fn now_millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis())
}

/// IAM을 바꾼 뒤 그 변경이 모든 곳에 반영될 때까지 기다리는 시간(초). 이 사이에 읽은 스냅숏은 그 변경을 아직 못 봤을 수 있다.
const SETTLE_SECS: i64 = 10;

/// 이 프로필에서 IAM을 바꾼 시각을 적어 둔다. 실패했어도 일부가 적용됐을 수 있으니 쓰기를 시도했으면 적는다.
fn mark_written(iam: &IamState, profile: &str, at: i64) {
    locked(&iam.written).insert(profile.to_string(), at);
}

fn written_at(iam: &IamState, profile: &str) -> Option<i64> {
    locked(&iam.written).get(profile).copied()
}

/// 미리보기·적용에 쓰는 스냅숏: 읽은 지 60초가 넘었으면 새로 읽는다. 미리보기를 본 뒤에 계정이 바뀌었을 수 있어서다.
/// 이 프로필에서 IAM을 바꾼 뒤 10초 동안은 나이와 상관없이 늘 새로 읽고, 그 10초 안에 시작한 읽기의 스냅숏은 그 뒤에 한 번 더 읽는다
/// (읽기를 시작한 시각으로 본다: 끝난 시각은 10초가 지났어도 앞부분은 그 변경이 반영되기 전에 읽었을 수 있다).
/// 바꾸기 전에 시작한 읽기의 결과는 세대 캐시가 담지 않는다. 다시 읽을 때 정책 붙이기 선택 목록은 버리지 않는다.
async fn fresh_snapshot_with<F, Fut>(iam: &IamState, profile: &str, now: i64, fetch: F) -> Result<Arc<Snapshot>, AppError>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<Snapshot, AppError>>,
{
    let written = written_at(iam, profile);
    if written.is_some_and(|at| now - at < SETTLE_SECS) {
        return reread(iam, profile, &fetch).await;
    }
    let cached = snapshot_with(iam, profile, false, &fetch).await?;
    let read_from = cached.read_started_at.or_else(|| parse_iso(&cached.fetched_at));
    let unsettled = written.is_some_and(|at| read_from.is_none_or(|read| read - at < SETTLE_SECS));
    if is_stale(&cached.fetched_at, now) || unsettled {
        return reread(iam, profile, &fetch).await;
    }
    Ok(cached)
}

async fn fresh_snapshot(state: &AppState, iam: &IamState, profile: &str) -> Result<Arc<Snapshot>, AppError> {
    fresh_snapshot_with(iam, profile, now_secs(), || async {
        let cfg = state.ctx.config(profile, GLOBAL_REGION).await?;
        fetch::fetch_snapshot(&cfg).await
    })
    .await
}

/// 사용자의 액세스 키 목록에서 그 키의 상태. 없는 키면 오류.
fn key_status_in(keys: &[AccessKeyInfo], key_id: &str) -> Result<&'static str, AppError> {
    let key = keys.iter().find(|k| k.id == key_id).ok_or_else(|| AppError::other(format!("액세스 키를 찾을 수 없어요: {key_id}")))?;
    Ok(match key.status {
        KeyStatus::Active => "Active",
        KeyStatus::Inactive => "Inactive",
    })
}

/// 액세스 키 변경이면 그 키의 지금 상태(되돌리는 방향과 "이미 그 상태"를 판단하는 데 쓴다). 키 변경이 아니면 None.
async fn key_status_of(client: &aws_sdk_iam::Client, change: &IamChange) -> Result<Option<String>, AppError> {
    let (IamChange::SetAccessKeyStatus { user_name, access_key_id, .. } | IamChange::DeleteAccessKey { user_name, access_key_id }) = change else {
        return Ok(None);
    };
    let keys = keys::fetch_keys(client, user_name, now_secs()).await?;
    key_status_in(&keys, access_key_id).map(|status| Some(status.to_string()))
}

/// 앱이 이 프로필로 쓰는 자격 증명의 액세스 키 ID. 읽지 못하면 None. 비밀 키와 세션 토큰은 꺼내지도 돌려주지도 않는다.
async fn own_key_id(cfg: &SdkConfig) -> Option<String> {
    let provider = cfg.credentials_provider()?;
    let credentials = provider.provide_credentials().await.ok()?;
    Some(credentials.access_key_id().to_string()).filter(|id| !id.is_empty())
}

/// 정책 검사 결과를 미리보기의 재료로. 문법 오류와 Access Analyzer의 ERROR 결과는 오류이고, 검사기를 못 썼으면 그렇다고 적는다.
fn policy_check_of(result: &ValidationResult) -> PolicyCheck {
    if let Some(error) = &result.syntax_error {
        return PolicyCheck::Errors(vec![error.clone()]);
    }
    if !result.analyzer_available {
        return PolicyCheck::Unavailable;
    }
    let errors: Vec<String> =
        result.findings.iter().filter(|f| f.level == FindingLevel::Error).map(|f| if f.message.is_empty() { f.code.clone() } else { f.message.clone() }).collect();
    if errors.is_empty() {
        PolicyCheck::Passed
    } else {
        PolicyCheck::Errors(errors)
    }
}

/// 미리보기와 적용이 똑같이 읽는 재료: 최신 스냅숏(붙일 정책의 문서를 채운 것)과 스냅숏 밖의 사실들(키 상태, 이 앱이 쓰는 키,
/// 버전을 지워야 하는 편집이면 새 문서의 검사 결과, 붙일 정책을 읽지 못했으면 그 이유). 적용은 이것을 다시 읽어 미리보기를 다시 계산하고
/// 사용자가 본 계획과 견준다.
async fn gather(state: &AppState, iam: &IamState, profile: &str, change: &IamChange) -> Result<(Arc<Snapshot>, Facts, aws_sdk_iam::Client), AppError> {
    let s = fresh_snapshot(state, iam, profile).await?;
    let cfg = state.ctx.config(profile, GLOBAL_REGION).await?;
    let client = aws_sdk_iam::Client::new(&cfg);
    let key_status = key_status_of(&client, change).await?;
    let own_key_id = match change {
        IamChange::SetAccessKeyStatus { .. } | IamChange::DeleteAccessKey { .. } => own_key_id(&cfg).await,
        _ => None,
    };
    let (s, policy_error) = ensure_policy(&client, s, change).await?;
    let policy_check = match change {
        IamChange::UpdateManagedPolicy { document, .. } if deletes_policy_version(&s, change) => policy_check_of(&checks::validate(&cfg, document).await?),
        _ => PolicyCheck::NotRun,
    };
    Ok((s, Facts { key_status, own_key_id, policy_check, policy_error }, client))
}

/// 미리보기를 계산하고 사용자가 본 계획으로 기억해 둔다. 재료(`gather`)는 부르는 쪽이 읽어 넘긴다. 권한 계산은 CPU를 쓰는 일이라 따로 돌린다.
async fn preview_and_remember(iam: &IamState, profile: &str, s: Arc<Snapshot>, change: IamChange, facts: Facts) -> Result<ChangePreview, AppError> {
    let account_id = s.account_id.clone();
    let shown = tokio::task::spawn_blocking(move || preview(&s, &change, &facts))
        .await
        .map_err(|e| AppError::other(format!("미리보기를 계산하지 못했어요: {e}")))?;
    locked(&iam.plans).remember(profile, &shown.change, Plan::of(&account_id, &shown), now_secs());
    Ok(shown)
}

/// 확인을 마친 호출 목록을 IAM에 쓴다. 이 파일에서 IAM 쓰기를 부르는 곳은 여기 하나다: 하나짜리 적용(`iam_apply`)과 묶음 적용(`iam_apply_batch`)이
/// 같은 길을 쓴다. `write`의 `only_the_apply_command_reaches_the_writer`가 쓰기 호출이 이 파일에 한 번뿐인지, 이 함수를 부르는 곳이
/// 정해 둔 수(정의, 명령 둘, 테스트 하나)인지 센다: 관문을 거치지 않는 새 호출은 그 테스트의 숫자를 고쳐야 들어온다.
async fn write_calls(client: &aws_sdk_iam::Client, plan: &[ApiCall]) -> write::Applied {
    write::apply(client, plan).await
}

/// 적용 요청: 어느 프로필에서 무엇을, 어떤 확인 문구로, (되돌리기면) 어느 기록을 되돌리는지.
struct ApplyRequest {
    profile: String,
    change: IamChange,
    confirm_text: Option<String>,
    undo_of: Option<String>,
}

/// 미리보기에서 본 계획을 꺼내(꺼낸 계획은 맞든 틀리든 다시 쓰지 않는다) `commit`에 넘기고, IAM에 썼으면 읽어 둔 스냅숏을 버리고
/// 쓴 시각을 적는다. 쓰기는 `write`로 받는다: `iam_apply`는 실제 쓰기를, 테스트는 가짜 쓰기를 넣는다.
async fn apply_with<W, Fut>(iam: &IamState, req: ApplyRequest, s: Arc<Snapshot>, facts: Facts, write: W) -> Result<ApplyResult, AppError>
where
    W: FnOnce(Vec<ApiCall>) -> Fut,
    Fut: Future<Output = write::Applied>,
{
    let ApplyRequest { profile, change, confirm_text, undo_of } = req;
    let now = now_secs();
    let seen = locked(&iam.plans).take(&profile, &change, now);
    let request = Request {
        profile: profile.clone(),
        snapshot: s,
        facts,
        change,
        confirm_text,
        undo_of,
        seen,
        log_path: iam.log_path.clone(),
        now,
        log_id: new_log_id(now_millis()),
    };
    let committed = commit(request, write).await;
    if committed.wrote {
        // 일부만 적용되고 실패했을 수도 있으니 성공하지 않았어도 읽어 둔 것을 버린다. 쓴 시각을 먼저 적는다: 버린 직후에 들어온
        // 미리보기가 쓴 시각을 못 보면, 변경이 반영되기 전에 읽은 스냅숏을 "쓰기 뒤 10초" 규칙 없이 그대로 쓴다
        mark_written(iam, &profile, now_secs());
        invalidate(iam, &profile);
    }
    committed.result
}

/// 변경 미리보기. 적용할 때와 같은 재료로 계산하고, 사용자가 본 계획을 기억해 둔다.
#[tauri::command]
pub async fn iam_preview(state: State<'_, AppState>, iam: State<'_, IamState>, profile: String, change: IamChange) -> Result<ChangePreview, AppError> {
    let (s, facts, _) = gather(&state, &iam, &profile, &change).await?;
    preview_and_remember(&iam, &profile, s, change, facts).await
}

/// 변경 적용. 최신 스냅숏으로 미리보기를 다시 계산해, 사용자가 미리보기에서 본 계획과 같고 막힘·확인 문구를 통과할 때만 IAM을 바꾸고,
/// 결과를 변경 기록에 남긴다. 미리보기 하나로는 한 번만 적용한다.
#[tauri::command]
pub async fn iam_apply(
    state: State<'_, AppState>,
    iam: State<'_, IamState>,
    profile: String,
    change: IamChange,
    confirm_text: Option<String>,
    undo_of: Option<String>,
) -> Result<ApplyResult, AppError> {
    let (s, facts, client) = gather(&state, &iam, &profile, &change).await?;
    let req = ApplyRequest { profile, change, confirm_text, undo_of };
    apply_with(&iam, req, s, facts, move |plan: Vec<ApiCall>| async move { write_calls(&client, &plan).await }).await
}

/// 붙일 정책이 스냅숏에 없으면 변경마다 읽어 넣고(앞 변경에서 읽은 정책은 다시 읽지 않는다), 변경마다의 재료를 `changes`와 같은 순서로 만든다.
/// 읽고도 문서를 얻지 못한 정책(읽지 못했거나 해석하지 못했다)은 그 이유와 함께 기억해 두고, 같은 정책을 붙이는 다음 변경은 다시 읽지 않고 같은 이유를 쓴다.
/// 50개를 넘는 묶음은 미리보기가 막으니 앞의 50개까지만 읽고 나머지에는 기본 재료를 둔다.
async fn read_missing_policies(client: &aws_sdk_iam::Client, mut s: Arc<Snapshot>, changes: &[IamChange]) -> Result<(Arc<Snapshot>, Vec<Facts>), AppError> {
    let mut facts = Vec::with_capacity(changes.len());
    let mut still_missing: HashMap<String, Option<String>> = HashMap::new();
    for c in changes.iter().take(MAX_BATCH) {
        let policy_error = match missing_policy(&s, c).and_then(|arn| still_missing.get(arn)) {
            Some(known) => known.clone(),
            None => {
                let (next, policy_error) = ensure_policy(client, s, c).await?;
                s = next;
                if let Some(arn) = missing_policy(&s, c) {
                    still_missing.insert(arn.to_string(), policy_error.clone());
                }
                policy_error
            }
        };
        facts.push(Facts { policy_error, ..Facts::default() });
    }
    facts.resize(changes.len(), Facts::default());
    Ok((s, facts))
}

/// 묶음의 재료: 최신 스냅숏(붙일 정책의 문서를 채운 것)과 변경마다의 재료(`read_missing_policies`).
async fn gather_batch(state: &AppState, iam: &IamState, profile: &str, changes: &[IamChange]) -> Result<(Arc<Snapshot>, Vec<Facts>, aws_sdk_iam::Client), AppError> {
    let s = fresh_snapshot(state, iam, profile).await?;
    let cfg = state.ctx.config(profile, GLOBAL_REGION).await?;
    let client = aws_sdk_iam::Client::new(&cfg);
    let (s, facts) = read_missing_policies(&client, s, changes).await?;
    Ok((s, facts, client))
}

/// 묶음 미리보기를 계산하고 사용자가 본 계획으로 기억해 둔다. 계획은 적용 순서로 늘어놓은 변경 목록 아래에 둔다: 담은 순서만 다른 묶음은 같은 미리보기다.
async fn preview_batch_and_remember(iam: &IamState, profile: &str, s: Arc<Snapshot>, changes: Vec<IamChange>, facts: Vec<Facts>) -> Result<BatchPreview, AppError> {
    let account_id = s.account_id.clone();
    let key = ordered(&changes);
    let shown = tokio::task::spawn_blocking(move || preview_batch(&s, &changes, &facts))
        .await
        .map_err(|e| AppError::other(format!("미리보기를 계산하지 못했어요: {e}")))?;
    locked(&iam.batch_plans).remember(profile, &key, BatchPlan::of(&account_id, &shown), now_secs());
    Ok(shown)
}

/// 묶음 적용 요청: 어느 프로필에서 어떤 변경들을(받은 순서), 어떤 확인 문구로, (되돌리기면) 변경마다 어느 기록을 되돌리는지.
struct BatchApplyRequest {
    profile: String,
    changes: Vec<IamChange>,
    confirm_text: Option<String>,
    undo_of: Option<Vec<String>>,
}

/// 묶음 미리보기에서 본 계획을 꺼내(꺼낸 계획은 맞든 틀리든 다시 쓰지 않는다) `commit_batch`에 넘기고, IAM에 썼으면 읽어 둔 스냅숏을 버리고 쓴 시각을 적는다.
/// 쓰기는 `write`로 받는다: `iam_apply_batch`는 실제 쓰기를, 테스트는 가짜 쓰기를 넣는다.
async fn apply_batch_with<W, Fut>(iam: &IamState, req: BatchApplyRequest, s: Arc<Snapshot>, facts: Vec<Facts>, write: W) -> Result<BatchResult, AppError>
where
    W: FnMut(Vec<ApiCall>) -> Fut,
    Fut: Future<Output = write::Applied>,
{
    let BatchApplyRequest { profile, changes, confirm_text, undo_of } = req;
    let now = now_secs();
    let seen = locked(&iam.batch_plans).take(&profile, &ordered(&changes), now);
    let request = BatchRequest {
        profile: profile.clone(),
        snapshot: s,
        facts,
        changes,
        confirm_text,
        undo_of,
        seen,
        log_path: iam.log_path.clone(),
        now,
        batch_id: new_log_id(now_millis()),
    };
    let committed = commit_batch(request, write).await;
    if committed.wrote {
        // 중간에 멈췄어도 앞 변경은 적용됐다. `apply_with`처럼 쓴 시각을 먼저 적고 읽어 둔 스냅숏을 버린다
        mark_written(iam, &profile, now_secs());
        invalidate(iam, &profile);
    }
    committed.result
}

/// 묶음 미리보기. 적용할 때와 같은 재료로 계산하고, 사용자가 본 계획을 기억해 둔다.
#[tauri::command]
pub async fn iam_preview_batch(state: State<'_, AppState>, iam: State<'_, IamState>, profile: String, changes: Vec<IamChange>) -> Result<BatchPreview, AppError> {
    let (s, facts, _) = gather_batch(&state, &iam, &profile, &changes).await?;
    preview_batch_and_remember(&iam, &profile, s, changes, facts).await
}

/// 묶음 적용. 최신 스냅숏으로 묶음 미리보기를 다시 계산해, 사용자가 본 계획과 같고 막힘·확인 문구를 통과할 때만 적용 순서대로 변경마다 IAM을 바꾸고
/// 변경마다 기록을 남긴다. 변경 하나가 실패하면 거기서 멈추고(앞 변경은 그대로) 실패한 위치를 결과로 알린다. 변경 기록을 저장하지 못하면
/// 그 변경은 적용된 채로 알림(notes)에 남기고 다음 변경에서 멈춘다. 미리보기 하나로는 한 번만 적용한다.
#[tauri::command]
pub async fn iam_apply_batch(
    state: State<'_, AppState>,
    iam: State<'_, IamState>,
    profile: String,
    changes: Vec<IamChange>,
    confirm_text: Option<String>,
    undo_of: Option<Vec<String>>,
) -> Result<BatchResult, AppError> {
    let (s, facts, client) = gather_batch(&state, &iam, &profile, &changes).await?;
    let req = BatchApplyRequest { profile, changes, confirm_text, undo_of };
    apply_batch_with(&iam, req, s, facts, move |plan: Vec<ApiCall>| {
        let client = client.clone();
        async move { write_calls(&client, &plan).await }
    })
    .await
}

/// 변경 기록, 최신순.
async fn change_log_of(iam: &IamState) -> Result<Vec<ChangeLogEntry>, AppError> {
    let path = iam.log_path.clone();
    let mut entries = tokio::task::spawn_blocking(move || change_log::read_all(&path)).await.map_err(|e| AppError::other(format!("변경 기록을 읽지 못했어요: {e}")))?;
    entries.reverse();
    Ok(entries)
}

#[tauri::command]
pub async fn iam_change_log(iam: State<'_, IamState>) -> Result<Vec<ChangeLogEntry>, AppError> {
    change_log_of(&iam).await
}

/// 기록의 역변경. 적용은 이 값을 미리보기로 확인한 뒤 `iam_apply(undo_of = 기록 id)`로 한다.
async fn undo_change_in(iam: &IamState, entry_id: &str) -> Result<IamChange, AppError> {
    undo_change_of(&change_log_of(iam).await?, entry_id)
}

#[tauri::command]
pub async fn iam_undo_change(iam: State<'_, IamState>, entry_id: String) -> Result<IamChange, AppError> {
    undo_change_in(&iam, &entry_id).await
}

/// 묶음의 역변경과 되돌릴 기록 id. 변경 기록(`change_log_of`)은 새것이 먼저라서 그 순서가 곧 되돌릴 순서다.
async fn undo_batch_in(iam: &IamState, batch_id: &str) -> Result<UndoBatch, AppError> {
    undo_batch_of(&change_log_of(iam).await?, batch_id)
}

/// 적용은 이 값을 묶음 미리보기로 확인한 뒤 `iam_apply_batch(undo_of = 기록 id들)`로 한다.
#[tauri::command]
pub async fn iam_undo_batch(iam: State<'_, IamState>, batch_id: String) -> Result<UndoBatch, AppError> {
    undo_batch_in(&iam, &batch_id).await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::iam::commit::plan::DRIFTED;
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

    /// 손으로 끝내는 읽기. 시작하면 `started`로 알리고 `release`가 올 때까지 끝나지 않는다.
    #[derive(Default)]
    struct Held {
        started: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }

    async fn held(calls: &AtomicUsize, gate: &Held, account: &str) -> Result<Snapshot, AppError> {
        calls.fetch_add(1, Ordering::SeqCst);
        gate.started.notify_one();
        gate.release.notified().await;
        Ok(snapshot_of(account))
    }

    #[tokio::test]
    async fn requests_that_arrive_during_a_read_share_it() {
        let (iam, calls, gate) = (IamState::default(), AtomicUsize::new(0), Held::default());
        let first = snapshot_with(&iam, "dev", false, || held(&calls, &gate, "1"));
        let others = async {
            gate.started.notified().await;
            let b = snapshot_with(&iam, "dev", false, || counted(&calls, "2"));
            let c = snapshot_with(&iam, "dev", false, || counted(&calls, "3"));
            tokio::pin!(b, c);
            assert!(futures::poll!(b.as_mut()).is_pending() && futures::poll!(c.as_mut()).is_pending());
            gate.release.notify_one();
            (b.await, c.await)
        };
        let (a, (b, c)) = tokio::join!(first, others);
        let (a, b, c) = (a.unwrap(), b.unwrap(), c.unwrap());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(Arc::ptr_eq(&a, &b) && Arc::ptr_eq(&a, &c));
        assert_eq!(a.account_id, "1");
    }

    #[tokio::test]
    async fn a_refresh_during_an_in_flight_read_reads_again() {
        let (iam, calls, gate) = (IamState::default(), AtomicUsize::new(0), Held::default());
        let first = snapshot_with(&iam, "dev", false, || held(&calls, &gate, "before"));
        let refresh = async {
            gate.started.notified().await;
            let forced = snapshot_with(&iam, "dev", true, || counted(&calls, "after"));
            tokio::pin!(forced);
            // 새로 고침이 도착해서 차례를 기다리는 동안 먼저 시작한 읽기가 끝난다
            assert!(futures::poll!(forced.as_mut()).is_pending());
            gate.release.notify_one();
            forced.await
        };
        let (first, forced) = tokio::join!(first, refresh);
        // 먼저 물은 쪽은 자기가 기다린 결과를 받고, 새로 고침은 그 뒤에 시작한 읽기의 결과를 받는다
        assert_eq!(first.unwrap().account_id, "before");
        let forced = forced.unwrap();
        assert_eq!((forced.account_id.as_str(), calls.load(Ordering::SeqCst)), ("after", 2));
        let again = snapshot_with(&iam, "dev", false, || counted(&calls, "never")).await.unwrap();
        assert!(Arc::ptr_eq(&forced, &again));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn an_invalidation_during_an_in_flight_read_keeps_its_result_out_of_the_cache() {
        let (iam, calls, gate) = (IamState::default(), AtomicUsize::new(0), Held::default());
        let first = snapshot_with(&iam, "dev", false, || held(&calls, &gate, "stale"));
        let write = async {
            gate.started.notified().await;
            // 읽는 도중에 변경을 적용했다
            invalidate(&iam, "dev");
            gate.release.notify_one();
        };
        let (first, ()) = tokio::join!(first, write);
        assert_eq!(first.unwrap().account_id, "stale");
        assert!(iam.snapshots.get("dev").is_none());
        let next = snapshot_with(&iam, "dev", false, || counted(&calls, "fresh")).await.unwrap();
        assert_eq!((next.account_id.as_str(), calls.load(Ordering::SeqCst)), ("fresh", 2));
        assert!(Arc::ptr_eq(&next, &iam.snapshots.get("dev").unwrap()));
    }

    #[tokio::test]
    async fn refreshes_that_arrive_while_a_read_is_in_flight_share_one_new_read() {
        let (iam, calls, gate) = (IamState::default(), AtomicUsize::new(0), Held::default());
        let first = snapshot_with(&iam, "dev", false, || held(&calls, &gate, "old"));
        let refreshes = async {
            gate.started.notified().await;
            let a = snapshot_with(&iam, "dev", true, || counted(&calls, "new-a"));
            let b = snapshot_with(&iam, "dev", true, || counted(&calls, "new-b"));
            tokio::pin!(a, b);
            assert!(futures::poll!(a.as_mut()).is_pending() && futures::poll!(b.as_mut()).is_pending());
            gate.release.notify_one();
            (a.await, b.await)
        };
        let (first, (a, b)) = tokio::join!(first, refreshes);
        assert_eq!(first.unwrap().account_id, "old");
        // 두 새로 고침 모두 그 뒤에 시작한 같은 읽기를 쓴다
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!((a.unwrap().account_id.as_str(), b.unwrap().account_id.as_str()), ("new-a", "new-a"));
    }

    #[tokio::test]
    async fn a_refresh_that_arrives_after_another_refresh_started_reading_reads_again() {
        let (iam, calls, gate) = (IamState::default(), AtomicUsize::new(0), Held::default());
        let first = snapshot_with(&iam, "dev", true, || held(&calls, &gate, "new-1"));
        let later = async {
            gate.started.notified().await;
            let second = snapshot_with(&iam, "dev", true, || counted(&calls, "new-2"));
            tokio::pin!(second);
            assert!(futures::poll!(second.as_mut()).is_pending());
            gate.release.notify_one();
            second.await
        };
        let (first, second) = tokio::join!(first, later);
        assert_eq!(first.unwrap().account_id, "new-1");
        let second = second.unwrap();
        assert_eq!((second.account_id.as_str(), calls.load(Ordering::SeqCst)), ("new-2", 2));
        assert!(Arc::ptr_eq(&second, &iam.snapshots.get("dev").unwrap()));
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
    async fn reading_again_before_a_preview_keeps_the_policy_list() {
        let iam = IamState::default();
        iam.policy_lists.get_or_fetch("dev", || async { Ok::<_, AppError>(one_policy("first")) }).await.unwrap();
        let now = crate::iam::clock::parse_iso("2026-10-27T00:00:00Z").unwrap();
        // 61초 전에 읽은 스냅숏이라 미리보기 전에 다시 읽는다
        snapshot_with(&iam, "dev", false, || async { Ok(read_at(&crate::iam::clock::iso(now - 61))) }).await.unwrap();
        let again = fresh_snapshot_with(&iam, "dev", now, || async { Ok(read_at(&crate::iam::clock::iso(now))) }).await.unwrap();
        assert_eq!(again.fetched_at, crate::iam::clock::iso(now));
        // 쓴 뒤 10초 동안 늘 다시 읽을 때도 마찬가지다
        mark_written(&iam, "dev", now);
        fresh_snapshot_with(&iam, "dev", now + 1, || async { Ok(read_at(&crate::iam::clock::iso(now + 1))) }).await.unwrap();
        assert_eq!(iam.policy_lists.get("dev").unwrap()[0].name, "first");
    }

    #[tokio::test]
    async fn a_read_that_started_within_ten_seconds_of_a_write_is_read_again_even_if_it_ended_later() {
        let (iam, calls) = (IamState::default(), AtomicUsize::new(0));
        let written = crate::iam::clock::parse_iso("2026-10-27T00:00:00Z").unwrap();
        mark_written(&iam, "dev", written);
        // 쓰고 8초 뒤에 시작해서 15초 뒤에 끝난 읽기(큰 계정)
        let slow = Snapshot { read_started_at: Some(written + 8), ..read_at(&crate::iam::clock::iso(written + 15)) };
        snapshot_with(&iam, "dev", false, || async { Ok(slow) }).await.unwrap();
        let read = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(Snapshot { read_started_at: Some(written + 20), ..read_at(&crate::iam::clock::iso(written + 21)) })
        };
        let used = fresh_snapshot_with(&iam, "dev", written + 30, &read).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1, "끝난 시각(15초)이 아니라 시작한 시각(8초)으로 봐서 다시 읽어요");
        assert_eq!(used.read_started_at, Some(written + 20));
        // 다시 읽은 것은 10초가 지난 뒤에 시작했으니 그대로 쓴다
        let cached = fresh_snapshot_with(&iam, "dev", written + 35, &read).await.unwrap();
        assert!(Arc::ptr_eq(&used, &cached));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
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

    // ── 변경 명령의 도우미 ──

    fn read_at(at: &str) -> Snapshot {
        Snapshot { fetched_at: at.into(), ..snapshot_of("1") }
    }

    #[tokio::test]
    async fn a_snapshot_read_within_a_minute_is_used_as_it_is_when_applying() {
        let (iam, calls) = (IamState::default(), AtomicUsize::new(0));
        let now = crate::iam::clock::parse_iso("2026-10-27T00:00:00Z").unwrap();
        let read = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(read_at(&crate::iam::clock::iso(now - 60)))
        };
        let first = fresh_snapshot_with(&iam, "dev", now, &read).await.unwrap();
        let second = fresh_snapshot_with(&iam, "dev", now, &read).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[tokio::test]
    async fn an_older_snapshot_is_read_again_before_applying() {
        let (iam, calls) = (IamState::default(), AtomicUsize::new(0));
        let now = crate::iam::clock::parse_iso("2026-10-27T00:00:00Z").unwrap();
        // 처음 읽은 것은 61초 전 모양이고, 다시 읽은 것은 지금 읽은 것이다
        let read = || async {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            Ok(read_at(&crate::iam::clock::iso(if n == 0 { now - 61 } else { now })))
        };
        let used = fresh_snapshot_with(&iam, "dev", now, &read).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(used.fetched_at, crate::iam::clock::iso(now));
        // 새로 읽은 것은 캐시에 남아서 다음 적용은 다시 읽지 않는다
        let again = fresh_snapshot_with(&iam, "dev", now + 10, &read).await.unwrap();
        assert!(Arc::ptr_eq(&used, &again));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_snapshot_whose_time_cannot_be_read_is_not_trusted() {
        let (iam, calls) = (IamState::default(), AtomicUsize::new(0));
        let read = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(read_at(""))
        };
        fresh_snapshot_with(&iam, "dev", 1_792_000_000, &read).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_failed_read_before_applying_is_an_error_and_leaves_no_stale_snapshot() {
        let iam = IamState::default();
        let now = crate::iam::clock::parse_iso("2026-10-27T00:00:00Z").unwrap();
        let old = crate::iam::clock::iso(now - 3_600);
        snapshot_with(&iam, "dev", false, || async { Ok(read_at(&old)) }).await.unwrap();
        let failed = fresh_snapshot_with(&iam, "dev", now, || async { Err::<Snapshot, _>(AppError::SsoExpired) }).await;
        assert_eq!(failed.err(), Some(AppError::SsoExpired));
        assert!(iam.snapshots.get("dev").is_none());
    }

    /// 읽을 때마다 번호를 올리고, 읽은 시각을 `at()`으로 찍는 읽기.
    fn read_now<'a>(calls: &'a AtomicUsize, at: &'a dyn Fn() -> i64) -> impl Fn() -> std::future::Ready<Result<Snapshot, AppError>> + 'a {
        move || {
            calls.fetch_add(1, Ordering::SeqCst);
            std::future::ready(Ok(read_at(&crate::iam::clock::iso(at()))))
        }
    }

    #[tokio::test]
    async fn for_ten_seconds_after_a_write_every_preview_and_apply_reads_again() {
        let (iam, calls) = (IamState::default(), AtomicUsize::new(0));
        let written = crate::iam::clock::parse_iso("2026-10-27T00:00:00Z").unwrap();
        let clock = std::cell::Cell::new(written - 5);
        let at = || clock.get();
        let read = read_now(&calls, &at);
        fresh_snapshot_with(&iam, "dev", clock.get(), &read).await.unwrap();
        mark_written(&iam, "dev", written);
        // 방금 읽은 스냅숏이 있어도 쓴 뒤 10초 동안은 매번 새로 읽는다
        for after in [1, 4, 9] {
            clock.set(written + after);
            fresh_snapshot_with(&iam, "dev", clock.get(), &read).await.unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        // 다른 프로필은 상관없다
        snapshot_with(&iam, "prod", false, &read).await.unwrap();
        fresh_snapshot_with(&iam, "prod", clock.get(), &read).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 5);
    }

    #[tokio::test]
    async fn a_snapshot_read_while_the_write_was_settling_is_read_once_more_afterwards() {
        let (iam, calls) = (IamState::default(), AtomicUsize::new(0));
        let written = crate::iam::clock::parse_iso("2026-10-27T00:00:00Z").unwrap();
        let clock = std::cell::Cell::new(written);
        let at = || clock.get();
        let read = read_now(&calls, &at);
        mark_written(&iam, "dev", written);
        clock.set(written + 8);
        let settling = fresh_snapshot_with(&iam, "dev", clock.get(), &read).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // 10초가 지난 뒤 처음 쓸 때: 8초에 읽은 것은 아직 그 변경을 못 봤을 수 있어 한 번 더 읽는다
        clock.set(written + 12);
        let settled = fresh_snapshot_with(&iam, "dev", clock.get(), &read).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(!Arc::ptr_eq(&settling, &settled));
        // 그 뒤로는 다시 캐시를 쓴다
        clock.set(written + 20);
        let cached = fresh_snapshot_with(&iam, "dev", clock.get(), &read).await.unwrap();
        assert!(Arc::ptr_eq(&settled, &cached));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    fn validation(syntax_error: Option<&str>, analyzer_available: bool, findings: &[(FindingLevel, &str, &str)]) -> ValidationResult {
        ValidationResult {
            syntax_error: syntax_error.map(str::to_string),
            analyzer_available,
            findings: findings.iter().map(|(level, code, message)| checks::ValidationFinding { level: *level, code: code.to_string(), message: message.to_string() }).collect(),
        }
    }

    #[test]
    fn only_analyzer_errors_and_syntax_errors_stop_a_version_from_being_deleted() {
        assert_eq!(policy_check_of(&validation(None, true, &[])), PolicyCheck::Passed);
        let advice = [(FindingLevel::SecurityWarning, "PASS_ROLE_WITH_STAR_IN_RESOURCE", "경고"), (FindingLevel::Suggestion, "EMPTY_ARRAY", "제안"), (FindingLevel::Warning, "W", "주의")];
        assert_eq!(policy_check_of(&validation(None, true, &advice)), PolicyCheck::Passed);
        let errors = [(FindingLevel::Error, "INVALID_ACTION", "작업 이름이 올바르지 않아요"), (FindingLevel::Suggestion, "S", "제안"), (FindingLevel::Error, "INVALID_ARN", "")];
        assert_eq!(policy_check_of(&validation(None, true, &errors)), PolicyCheck::Errors(vec!["작업 이름이 올바르지 않아요".into(), "INVALID_ARN".into()]));
        assert_eq!(policy_check_of(&validation(None, false, &[])), PolicyCheck::Unavailable);
        assert_eq!(policy_check_of(&validation(Some("JSON 형식이 올바르지 않아요"), true, &[])), PolicyCheck::Errors(vec!["JSON 형식이 올바르지 않아요".into()]));
    }

    #[test]
    fn previews_are_remembered_per_profile_and_taken_once() {
        let iam = IamState::default();
        let s = crate::iam::fixtures::snapshot();
        let change = IamChange::AttachPolicy { target: crate::iam::fixtures::BOB.into(), policy_arn: crate::iam::fixtures::S3_FULL.into() };
        let shown = preview(&s, &change, &Facts::default());
        locked(&iam.plans).remember("dev", &change, Plan::of(&s.account_id, &shown), 100);
        assert_eq!(locked(&iam.plans).take("prod", &change, 101), None);
        assert_eq!(locked(&iam.plans).take("dev", &change, 101), Some(Plan::of(&s.account_id, &shown)));
        assert_eq!(locked(&iam.plans).take("dev", &change, 102), None);
    }

    // ── 미리보기 → 적용 ──

    fn attach_s3_to_bob() -> IamChange {
        IamChange::AttachPolicy { target: crate::iam::fixtures::BOB.into(), policy_arn: crate::iam::fixtures::S3_FULL.into() }
    }

    fn apply_request(profile: &str, change: &IamChange) -> ApplyRequest {
        ApplyRequest { profile: profile.into(), change: change.clone(), confirm_text: None, undo_of: None }
    }

    /// 몇 번 불렸는지 세고, 받은 호출을 모두 성공시키는 가짜 쓰기.
    fn counting(writes: &AtomicUsize) -> impl FnOnce(Vec<ApiCall>) -> std::future::Ready<write::Applied> + '_ {
        move |plan| {
            writes.fetch_add(1, Ordering::SeqCst);
            std::future::ready(write::Applied { done: plan, result: Ok(()) })
        }
    }

    fn with_log() -> (tempfile::TempDir, IamState) {
        let dir = tempfile::tempdir().unwrap();
        let iam = IamState::new(dir.path().join("iam-changes.jsonl"));
        (dir, iam)
    }

    #[tokio::test]
    async fn an_apply_without_a_preview_is_refused_and_writes_nothing() {
        let ((_dir, iam), writes) = (with_log(), AtomicUsize::new(0));
        let s = Arc::new(crate::iam::fixtures::snapshot());
        let refused = apply_with(&iam, apply_request("dev", &attach_s3_to_bob()), s, Facts::default(), counting(&writes)).await;
        assert_eq!(refused, Err(AppError::other(crate::iam::commit::plan::DRIFTED)));
        assert_eq!(writes.load(Ordering::SeqCst), 0);
        assert_eq!(written_at(&iam, "dev"), None, "쓰지 않았으면 쓴 시각도 없어요");
    }

    #[tokio::test]
    async fn one_preview_allows_exactly_one_apply() {
        let ((_dir, iam), writes) = (with_log(), AtomicUsize::new(0));
        let s = Arc::new(crate::iam::fixtures::snapshot());
        let change = attach_s3_to_bob();
        let shown = preview_and_remember(&iam, "dev", s.clone(), change.clone(), Facts::default()).await.unwrap();
        assert_eq!(shown.change, change);

        let first = apply_with(&iam, apply_request("dev", &change), s.clone(), Facts::default(), counting(&writes)).await.unwrap();
        assert_eq!(first.summary, shown.summary);
        assert_eq!(writes.load(Ordering::SeqCst), 1);
        assert!(written_at(&iam, "dev").is_some());

        let second = apply_with(&iam, apply_request("dev", &change), s, Facts::default(), counting(&writes)).await;
        assert_eq!(second, Err(AppError::other(crate::iam::commit::plan::DRIFTED)));
        assert_eq!(writes.load(Ordering::SeqCst), 1, "같은 미리보기로 두 번 쓰지 않아요");
    }

    #[tokio::test]
    async fn a_preview_made_with_another_profile_does_not_count() {
        let ((_dir, iam), writes) = (with_log(), AtomicUsize::new(0));
        let s = Arc::new(crate::iam::fixtures::snapshot());
        let change = attach_s3_to_bob();
        preview_and_remember(&iam, "prod", s.clone(), change.clone(), Facts::default()).await.unwrap();
        let refused = apply_with(&iam, apply_request("dev", &change), s, Facts::default(), counting(&writes)).await;
        assert_eq!(refused, Err(AppError::other(crate::iam::commit::plan::DRIFTED)));
        assert_eq!(writes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_write_drops_the_cached_snapshot_and_records_when_it_happened() {
        let ((_dir, iam), writes) = (with_log(), AtomicUsize::new(0));
        let s = snapshot_with(&iam, "dev", false, || async { Ok(crate::iam::fixtures::snapshot()) }).await.unwrap();
        let change = attach_s3_to_bob();
        preview_and_remember(&iam, "dev", s.clone(), change.clone(), Facts::default()).await.unwrap();
        let before = now_secs();
        apply_with(&iam, apply_request("dev", &change), s, Facts::default(), counting(&writes)).await.unwrap();
        assert!(iam.snapshots.get("dev").is_none());
        assert!(written_at(&iam, "dev").is_some_and(|at| at >= before));
    }

    // ── 묶음: 미리보기 → 적용 ──

    fn remove_s3_from_carol() -> IamChange {
        IamChange::DetachPolicy { target: crate::iam::fixtures::CAROL.into(), policy_arn: crate::iam::fixtures::S3_FULL.into() }
    }

    fn batch_request(profile: &str, changes: &[IamChange]) -> BatchApplyRequest {
        BatchApplyRequest { profile: profile.into(), changes: changes.to_vec(), confirm_text: None, undo_of: None }
    }

    /// 몇 번 불렸는지 세고, 받은 호출을 모두 성공시키는 가짜 쓰기. 묶음은 변경마다 쓰기를 부르니 여러 번 쓸 수 있다.
    fn counting_each(writes: &AtomicUsize) -> impl FnMut(Vec<ApiCall>) -> std::future::Ready<write::Applied> + '_ {
        move |plan| {
            writes.fetch_add(1, Ordering::SeqCst);
            std::future::ready(write::Applied { done: plan, result: Ok(()) })
        }
    }

    fn logged_ids(iam: &IamState) -> Vec<(String, Option<String>)> {
        change_log::read_all(&iam.log_path).into_iter().map(|e| (e.id, e.batch_id)).collect()
    }

    #[tokio::test]
    async fn a_batch_apply_without_a_preview_is_refused_and_writes_nothing() {
        let ((_dir, iam), writes) = (with_log(), AtomicUsize::new(0));
        let s = snapshot_with(&iam, "dev", false, || async { Ok(crate::iam::fixtures::snapshot()) }).await.unwrap();
        let changes = vec![attach_s3_to_bob(), remove_s3_from_carol()];
        let refused = apply_batch_with(&iam, batch_request("dev", &changes), s, vec![Facts::default(); 2], counting_each(&writes)).await;
        assert_eq!(refused, Err(AppError::other(DRIFTED)));
        assert_eq!(writes.load(Ordering::SeqCst), 0);
        assert_eq!(written_at(&iam, "dev"), None, "쓰지 않았으면 쓴 시각도 없어요");
        assert!(iam.snapshots.get("dev").is_some(), "쓰지 않았으면 읽어 둔 스냅숏도 그대로예요");
        assert!(logged_ids(&iam).is_empty());
    }

    #[tokio::test]
    async fn one_batch_preview_allows_exactly_one_apply() {
        let ((_dir, iam), writes) = (with_log(), AtomicUsize::new(0));
        let s = Arc::new(crate::iam::fixtures::snapshot());
        let changes = vec![attach_s3_to_bob(), remove_s3_from_carol()];
        let facts = vec![Facts::default(); 2];
        let shown = preview_batch_and_remember(&iam, "dev", s.clone(), changes.clone(), facts.clone()).await.unwrap();
        assert_eq!(shown.changes.iter().map(|item| item.change.clone()).collect::<Vec<_>>(), changes);

        let first = apply_batch_with(&iam, batch_request("dev", &changes), s.clone(), facts.clone(), counting_each(&writes)).await.unwrap();
        assert_eq!((first.log_ids.len(), first.failed.is_none()), (2, true));
        assert_eq!(writes.load(Ordering::SeqCst), 2);
        assert!(written_at(&iam, "dev").is_some());
        assert_eq!(logged_ids(&iam), vec![(format!("{}-1", first.batch_id), Some(first.batch_id.clone())), (format!("{}-2", first.batch_id), Some(first.batch_id.clone()))]);

        let second = apply_batch_with(&iam, batch_request("dev", &changes), s, facts, counting_each(&writes)).await;
        assert_eq!(second, Err(AppError::other(DRIFTED)));
        assert_eq!(writes.load(Ordering::SeqCst), 2, "같은 미리보기로 두 번 쓰지 않아요");
    }

    #[tokio::test]
    async fn a_batch_preview_in_another_tray_order_with_the_same_ordered_changes_still_matches() {
        let ((_dir, iam), writes) = (with_log(), AtomicUsize::new(0));
        let s = Arc::new(crate::iam::fixtures::snapshot());
        // 붙이기가 먼저, 떼기가 나중: [a, b]도 [b, a]도 적용 순서는 [a, b]다
        let (a, b) = (attach_s3_to_bob(), remove_s3_from_carol());
        preview_batch_and_remember(&iam, "dev", s.clone(), vec![a.clone(), b.clone()], vec![Facts::default(); 2]).await.unwrap();

        let applied = apply_batch_with(&iam, batch_request("dev", &[b.clone(), a.clone()]), s, vec![Facts::default(); 2], counting_each(&writes)).await.unwrap();

        assert_eq!((applied.log_ids.len(), applied.failed), (2, None));
        assert_eq!(writes.load(Ordering::SeqCst), 2);
        let applied_changes: Vec<IamChange> = change_log::read_all(&iam.log_path).into_iter().map(|e| e.change).collect();
        assert_eq!(applied_changes, vec![a, b], "기록은 적용 순서대로예요");
    }

    #[tokio::test]
    async fn a_batch_preview_of_other_changes_or_another_profile_does_not_count() {
        let ((_dir, iam), writes) = (with_log(), AtomicUsize::new(0));
        let s = Arc::new(crate::iam::fixtures::snapshot());
        let changes = vec![attach_s3_to_bob(), remove_s3_from_carol()];
        preview_batch_and_remember(&iam, "prod", s.clone(), changes.clone(), vec![Facts::default(); 2]).await.unwrap();
        // 다른 프로필에서 적용한다
        let elsewhere = apply_batch_with(&iam, batch_request("dev", &changes), s.clone(), vec![Facts::default(); 2], counting_each(&writes)).await;
        assert_eq!(elsewhere, Err(AppError::other(DRIFTED)));
        // 미리보기에 없던 변경을 하나 더 얹어 적용한다
        let more = vec![attach_s3_to_bob(), remove_s3_from_carol(), IamChange::AddToGroup { user_name: "carol".into(), group_name: "admins".into() }];
        let bigger = apply_batch_with(&iam, batch_request("prod", &more), s, vec![Facts::default(); 3], counting_each(&writes)).await;
        assert_eq!(bigger, Err(AppError::other(DRIFTED)));
        assert_eq!(writes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_batch_that_stops_midway_still_drops_the_cached_snapshot_and_records_when_it_happened() {
        let ((_dir, iam), writes) = (with_log(), AtomicUsize::new(0));
        let s = snapshot_with(&iam, "dev", false, || async { Ok(crate::iam::fixtures::snapshot()) }).await.unwrap();
        let changes = vec![attach_s3_to_bob(), remove_s3_from_carol()];
        preview_batch_and_remember(&iam, "dev", s.clone(), changes.clone(), vec![Facts::default(); 2]).await.unwrap();
        let before = now_secs();
        // 두 번째 쓰기가 거부된다
        let denied = AppError::AccessDenied { action: "iam:DetachUserPolicy".into() };
        let failing = |plan: Vec<ApiCall>| {
            let n = writes.fetch_add(1, Ordering::SeqCst) + 1;
            let result = if n == 2 { Err(denied.clone()) } else { Ok(()) };
            std::future::ready(write::Applied { done: if n == 2 { Vec::new() } else { plan }, result })
        };

        let result = apply_batch_with(&iam, batch_request("dev", &changes), s, vec![Facts::default(); 2], failing).await.unwrap();

        assert_eq!(result.failed.as_ref().map(|f| (f.index, f.message.as_str())), Some((1, "권한 없음 (iam:DetachUserPolicy)")));
        assert_eq!(result.log_ids.len(), 1);
        assert_eq!(writes.load(Ordering::SeqCst), 2);
        assert!(iam.snapshots.get("dev").is_none(), "앞 변경은 적용됐으니 읽어 둔 스냅숏을 버려요");
        assert!(written_at(&iam, "dev").is_some_and(|at| at >= before));
    }

    #[tokio::test]
    async fn undoing_a_batch_walks_the_change_log_newest_first() {
        let (_dir, iam) = with_log();
        let attach_to_bob = |policy: &str| IamChange::AttachPolicy { target: crate::iam::fixtures::BOB.into(), policy_arn: policy.into() };
        let remove_from_bob = |policy: &str| IamChange::DetachPolicy { target: crate::iam::fixtures::BOB.into(), policy_arn: policy.into() };
        // 적용한 순서대로 쌓인 기록: b1-1, b1-2는 되고 b1-3은 실패했다. 묶음이 아닌 기록과 다른 묶음의 기록이 섞여 있다
        let batched = |id: &str, batch: &str, inverse: Option<IamChange>| ChangeLogEntry { batch_id: Some(batch.into()), ..log_entry(id, inverse) };
        let mut failed = batched("b1-3", "b1", None);
        failed.ok = false;
        for entry in [
            batched("b1-1", "b1", Some(remove_from_bob("arn:aws:iam::aws:policy/A"))),
            log_entry("single", Some(remove_from_bob("arn:aws:iam::aws:policy/S"))),
            batched("b1-2", "b1", Some(remove_from_bob("arn:aws:iam::aws:policy/B"))),
            batched("b2-1", "b2", Some(attach_to_bob("arn:aws:iam::aws:policy/C"))),
            failed,
        ] {
            change_log::append(&iam.log_path, &entry).unwrap();
        }

        let undo = undo_batch_in(&iam, "b1").await.unwrap();

        assert_eq!(undo.undo_of, vec!["b1-2", "b1-1"]);
        assert_eq!(undo.changes, vec![remove_from_bob("arn:aws:iam::aws:policy/B"), remove_from_bob("arn:aws:iam::aws:policy/A")]);
        assert_eq!(undo_batch_in(&iam, "nope").await, Err(AppError::other("변경 기록을 찾지 못했어요")));
        change_log::mark_undone(&iam.log_path, "b2-1").unwrap();
        assert_eq!(undo_batch_in(&iam, "b2").await, Err(AppError::other("되돌릴 변경이 없어요")));
    }

    const POLICY_DOC: &str = r#"{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"*"}]}"#;

    /// 어떤 정책이든 `POLICY_DOC`을 기본 버전 문서로 가진 것처럼 답한다. `hidden`으로 시작하는 ARN은 읽을 권한이 없다.
    fn serving_policies(hidden: &'static str) -> crate::iam::mock_aws::Recorder {
        use crate::iam::mock_aws::{error_xml, ok_with, Recorder, Sent};
        Recorder::new(move |sent: &Sent| match (sent.action.as_str(), sent.params.get("PolicyArn").map(String::as_str)) {
            ("GetPolicy", Some(arn)) if arn.starts_with(hidden) => (403, error_xml("AccessDenied", "no")),
            ("GetPolicy", Some(arn)) => {
                let name = arn.rsplit('/').next().unwrap_or(arn);
                let policy = format!("<Policy><PolicyName>{name}</PolicyName><PolicyId>ANPAEXAMPLE</PolicyId><Arn>{arn}</Arn><Path>/</Path><DefaultVersionId>v1</DefaultVersionId><AttachmentCount>0</AttachmentCount><IsAttachable>true</IsAttachable><UpdateDate>2026-01-02T03:04:05Z</UpdateDate></Policy>");
                (200, ok_with("GetPolicy", &policy))
            }
            ("GetPolicyVersion", _) => {
                let version = format!("<PolicyVersion><Document>{}</Document><VersionId>v1</VersionId><IsDefaultVersion>true</IsDefaultVersion><CreateDate>2026-01-02T03:04:05Z</CreateDate></PolicyVersion>", crate::adapters::util::url_encode(POLICY_DOC));
                (200, ok_with("GetPolicyVersion", &version))
            }
            (other, _) => (400, error_xml("InvalidAction", other)),
        })
    }

    #[tokio::test]
    async fn a_batch_reads_each_missing_policy_once_and_keeps_each_reason_with_its_change() {
        use crate::iam::fixtures::{ADMIN_POLICY, ALICE, BOB, CAROL};
        let (readable, hidden) = ("arn:aws:iam::aws:policy/Readable", "arn:aws:iam::aws:policy/Hidden");
        let recorder = serving_policies(hidden);
        let attach = |target: &str, policy: &str| IamChange::AttachPolicy { target: target.into(), policy_arn: policy.into() };
        // 읽을 수 있는 정책은 한 번만 읽고, 읽지 못한 이유는 그 정책을 붙이는 변경(받은 순서의 둘째)에만 붙는다. 스냅숏에 있는 정책은 읽지 않는다
        let changes = vec![attach(BOB, readable), attach(CAROL, hidden), attach(ALICE, readable), attach(BOB, ADMIN_POLICY)];
        let original = Arc::new(crate::iam::fixtures::snapshot());

        let (s, facts) = read_missing_policies(&recorder.client(), original.clone(), &changes).await.unwrap();

        let reads: Vec<String> = recorder.sent().into_iter().map(|sent| format!("{} {}", sent.action, sent.params["PolicyArn"])).collect();
        assert_eq!(reads, [format!("GetPolicy {readable}"), format!("GetPolicyVersion {readable}"), format!("GetPolicy {hidden}")]);
        let reasons: Vec<Option<&str>> = facts.iter().map(|f| f.policy_error.as_deref()).collect();
        assert_eq!(reasons, [None, Some("권한 없음 (iam:GetPolicy)"), None, None]);
        assert!(s.policies[readable].document.is_some() && !s.policies.contains_key(hidden));
        assert!(!original.policies.contains_key(readable), "캐시된 스냅숏은 그대로예요");
    }

    #[tokio::test]
    async fn a_policy_that_cannot_be_read_is_asked_for_once_for_the_whole_batch() {
        use crate::iam::fixtures::{ALICE, BOB, CAROL};
        let (readable, hidden) = ("arn:aws:iam::aws:policy/Readable", "arn:aws:iam::aws:policy/Hidden");
        let recorder = serving_policies(hidden);
        let attach = |target: &str, policy: &str| IamChange::AttachPolicy { target: target.into(), policy_arn: policy.into() };
        // 읽지 못하는 정책을 세 주체에게 붙이는데, 사이에 읽을 수 있는 정책을 붙이는 변경이 끼어 있다
        let changes = vec![attach(BOB, hidden), attach(CAROL, readable), attach(CAROL, hidden), attach(ALICE, hidden)];

        let (s, facts) = read_missing_policies(&recorder.client(), Arc::new(crate::iam::fixtures::snapshot()), &changes).await.unwrap();

        // 읽지 못한 정책은 한 번만 묻고, 이유는 그 정책을 붙이는 변경마다 그대로 붙는다
        let reads: Vec<String> = recorder.sent().into_iter().map(|sent| format!("{} {}", sent.action, sent.params["PolicyArn"])).collect();
        assert_eq!(reads, [format!("GetPolicy {hidden}"), format!("GetPolicy {readable}"), format!("GetPolicyVersion {readable}")]);
        let reasons: Vec<Option<&str>> = facts.iter().map(|f| f.policy_error.as_deref()).collect();
        let denied = Some("권한 없음 (iam:GetPolicy)");
        assert_eq!(reasons, [denied, None, denied, denied]);
        assert!(s.policies[readable].document.is_some() && !s.policies.contains_key(hidden));
    }

    #[tokio::test]
    async fn a_batch_over_the_limit_reads_policies_for_the_first_fifty_changes_only() {
        let recorder = serving_policies("arn:aws:iam::aws:policy/Nothing");
        let policy = |i: usize| format!("arn:aws:iam::aws:policy/P{i:02}");
        let changes: Vec<IamChange> = (0..=MAX_BATCH).map(|i| IamChange::AttachPolicy { target: crate::iam::fixtures::BOB.into(), policy_arn: policy(i) }).collect();
        assert_eq!(changes.len(), MAX_BATCH + 1);

        let (s, facts) = read_missing_policies(&recorder.client(), Arc::new(crate::iam::fixtures::snapshot()), &changes).await.unwrap();

        // 재료는 변경마다 하나이고, 51번째 정책은 읽지 않는다(미리보기가 막는 묶음이다)
        assert_eq!(facts.len(), MAX_BATCH + 1);
        assert_eq!(recorder.sent().len(), 2 * MAX_BATCH);
        assert!(s.policies.contains_key(&policy(MAX_BATCH - 1)) && !s.policies.contains_key(&policy(MAX_BATCH)));
    }

    #[tokio::test]
    async fn a_batch_sends_the_previewed_requests_in_application_order() {
        use crate::iam::mock_aws::Recorder;
        let ((_dir, iam), recorder) = (with_log(), Recorder::ok());
        let client = recorder.client();
        let s = Arc::new(crate::iam::fixtures::snapshot());
        // 받은 순서는 [떼기, 붙이기]이고 적용 순서는 [붙이기, 떼기]다
        let changes = vec![remove_s3_from_carol(), attach_s3_to_bob()];
        let shown = preview_batch_and_remember(&iam, "dev", s.clone(), changes.clone(), vec![Facts::default(); 2]).await.unwrap();

        let writer = move |plan: Vec<ApiCall>| {
            let client = client.clone();
            async move { write_calls(&client, &plan).await }
        };
        let result = apply_batch_with(&iam, batch_request("dev", &changes), s, vec![Facts::default(); 2], writer).await.unwrap();

        assert_eq!((result.log_ids.len(), result.failed), (2, None));
        let sent = recorder.sent();
        assert_eq!(sent.iter().map(|s| s.action.as_str()).collect::<Vec<_>>(), ["AttachUserPolicy", "DetachUserPolicy"]);
        // 미리보기에 보인 호출 그대로 나간다
        for (request, item) in sent.iter().zip(&shown.changes) {
            assert_eq!(item.calls.len(), 1);
            assert_eq!(request.params, item.calls[0].params, "{}", item.summary);
        }
        assert_eq!(sent[0].params["UserName"], "bob");
        assert_eq!(sent[1].params["UserName"], "carol");
    }

    #[tokio::test]
    async fn the_apps_own_key_id_is_read_from_the_credentials_it_uses() {
        use aws_credential_types::provider::SharedCredentialsProvider;
        use aws_credential_types::Credentials;
        let with_key = |id: &str| SdkConfig::builder().credentials_provider(SharedCredentialsProvider::new(Credentials::new(id, "test-secret", None, None, "test"))).build();
        assert_eq!(own_key_id(&with_key("AKIAEXAMPLEKEY")).await.as_deref(), Some("AKIAEXAMPLEKEY"));
        assert_eq!(own_key_id(&with_key("")).await, None);
        assert_eq!(own_key_id(&SdkConfig::builder().build()).await, None);
    }

    fn key(id: &str, status: KeyStatus) -> AccessKeyInfo {
        AccessKeyInfo { id: id.into(), status, created_at: None, age_days: None, last_used_at: None, last_used_service: None, last_used_region: None, last_used_unknown: false }
    }

    /// 2026-10-26 기준 점검. alice·bob·carol은 200일 전에 만든 활성 키(한 번도 안 씀)가 있어 오래된 키·안 쓰는 키에 걸리고,
    /// gina는 비활성 키만, dave는 키가 없다.
    fn findings_with_keys() -> Findings {
        use crate::iam::model::CredRow;
        let row = |name: &str, active: bool| CredRow {
            user: name.into(),
            arn: format!("arn:aws:iam::111111111111:user/{name}"),
            created_at: Some("2025-01-01T00:00:00+00:00".into()),
            mfa_active: true,
            key1_active: active,
            key1_rotated: Some("2026-04-09T00:00:00+00:00".into()),
            ..Default::default()
        };
        let names = ["alice", "bob", "carol", "dave", "gina"];
        let s = Snapshot {
            account_id: "111111111111".into(),
            fetched_at: "2026-10-26T00:00:00Z".into(),
            users: names.iter().map(|name| crate::iam::fixtures::user(name)).collect(),
            cred_report: Some(vec![row("alice", true), row("bob", true), row("carol", true), CredRow { key1_rotated: None, ..row("dave", false) }, row("gina", false)]),
            ..Default::default()
        };
        findings(&s, parse_iso("2026-10-26T00:00:00Z").unwrap())
    }

    fn listed_key_xml(id: &str, status: &str) -> String {
        let member = format!("<member><UserName>u</UserName><AccessKeyId>{id}</AccessKeyId><Status>{status}</Status><CreateDate>2026-04-09T00:00:00Z</CreateDate></member>");
        crate::iam::mock_aws::ok_with("ListAccessKeys", &format!("<AccessKeyMetadata>{member}</AccessKeyMetadata><IsTruncated>false</IsTruncated>"))
    }

    fn key_targets(f: &Findings, kind: crate::iam::findings::FindingKind) -> Vec<(&str, bool)> {
        f.groups.iter().find(|g| g.kind == kind).unwrap().items.iter().map(|i| (i.target_name.as_str(), i.fix.is_some())).collect()
    }

    #[tokio::test]
    async fn findings_list_keys_only_for_flagged_users_and_a_throttled_list_is_a_warning() {
        use crate::iam::findings::FindingKind::{OldAccessKey, UnusedAccessKey};
        use crate::iam::mock_aws::{error_xml, Recorder, Sent};
        let recorder = Recorder::new(|sent: &Sent| match sent.params.get("UserName").map(String::as_str) {
            Some("alice") => (200, listed_key_xml("AKIAALICE1", "Active")),
            Some("bob") => (400, error_xml("Throttling", "Rate exceeded")),
            // 보고서에는 아직 활성으로 적혀 있지만 그 사이 꺼진 키
            Some("carol") => (200, listed_key_xml("AKIACAROL1", "Inactive")),
            _ => (200, listed_key_xml("AKIAOTHER", "Active")),
        });
        let found = with_key_fixes(findings_with_keys(), || async { Ok(recorder.client()) }).await.unwrap();

        // 키 점검에 걸린 사용자의 키 목록만 읽는다(키가 없거나 비활성 키만 있는 dave·gina는 읽지 않는다)
        let mut asked: Vec<String> = recorder.sent().iter().map(|sent| format!("{} {}", sent.action, sent.params["UserName"])).collect();
        asked.sort();
        assert_eq!(asked, ["ListAccessKeys alice", "ListAccessKeys bob", "ListAccessKeys carol"]);
        // alice는 빠른 조치가 붙고, 요청 제한에 걸린 bob은 빠른 조치 없이 남고, 이미 꺼진 carol의 키 항목은 빠진다
        for kind in [OldAccessKey, UnusedAccessKey] {
            assert_eq!(key_targets(&found, kind), [("alice", true), ("bob", false)], "{kind:?}");
        }
        assert_eq!(found.warnings, ["일부 사용자의 액세스 키를 읽지 못해 빠른 조치를 만들지 못했어요 (1명): 요청이 너무 많아요"]);
    }

    #[tokio::test]
    async fn findings_fail_only_when_the_sso_session_expired_while_listing_keys() {
        use crate::iam::mock_aws::{error_xml, Recorder, Sent};
        let recorder = Recorder::new(|sent: &Sent| match sent.params.get("UserName").map(String::as_str) {
            Some("bob") => (400, error_xml("ExpiredToken", "expired")),
            _ => (200, listed_key_xml("AKIAOTHER", "Active")),
        });
        assert_eq!(with_key_fixes(findings_with_keys(), || async { Ok(recorder.client()) }).await, Err(AppError::SsoExpired));

        // 키 점검에 걸린 사용자가 없으면 클라이언트도 만들지 않는다
        let quiet = findings(&Snapshot { account_id: "111111111111".into(), ..Default::default() }, parse_iso("2026-10-26T00:00:00Z").unwrap());
        let unchanged = with_key_fixes(quiet.clone(), || async { Err(AppError::other("클라이언트를 만들면 안 돼요")) }).await;
        assert_eq!(unchanged, Ok(quiet));
    }

    #[test]
    fn a_keys_status_is_looked_up_by_id_and_a_missing_key_is_an_error() {
        let keys = [key("AKIA1", KeyStatus::Active), key("AKIA2", KeyStatus::Inactive)];
        assert_eq!(key_status_in(&keys, "AKIA1"), Ok("Active"));
        assert_eq!(key_status_in(&keys, "AKIA2"), Ok("Inactive"));
        assert_eq!(key_status_in(&keys, "AKIA3"), Err(AppError::other("액세스 키를 찾을 수 없어요: AKIA3")));
        assert!(key_status_in(&[], "AKIA1").is_err());
    }

    fn log_entry(id: &str, inverse: Option<IamChange>) -> ChangeLogEntry {
        ChangeLogEntry {
            id: id.into(),
            at: "2026-10-27T00:00:00Z".into(),
            profile: "prod".into(),
            account_id: "111111111111".into(),
            caller_arn: "arn:aws:iam::111111111111:user/alice".into(),
            change: IamChange::DeleteAccessKey { user_name: "bob".into(), access_key_id: "AKIA1".into() },
            summary: id.into(),
            calls: vec![],
            ok: true,
            error: None,
            inverse,
            undo_of: None,
            undone: false,
            batch_id: None,
        }
    }

    #[tokio::test]
    async fn the_change_log_lists_the_newest_first_and_an_empty_one_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let iam = IamState::new(dir.path().join("iam-changes.jsonl"));
        assert!(change_log_of(&iam).await.unwrap().is_empty());
        for id in ["first", "second", "third"] {
            change_log::append(&iam.log_path, &log_entry(id, None)).unwrap();
        }
        let ids: Vec<String> = change_log_of(&iam).await.unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, vec!["third", "second", "first"]);
    }

    #[tokio::test]
    async fn undoing_a_record_gives_back_its_inverse_or_says_why_not() {
        let dir = tempfile::tempdir().unwrap();
        let iam = IamState::new(dir.path().join("iam-changes.jsonl"));
        let inverse = IamChange::AttachPolicy { target: "arn:aws:iam::111111111111:user/bob".into(), policy_arn: "arn:aws:iam::aws:policy/X".into() };
        change_log::append(&iam.log_path, &log_entry("undoable", Some(inverse.clone()))).unwrap();
        change_log::append(&iam.log_path, &log_entry("final", None)).unwrap();
        assert_eq!(undo_change_in(&iam, "undoable").await, Ok(inverse));
        assert_eq!(undo_change_in(&iam, "final").await, Err(AppError::other("되돌릴 수 없는 변경이에요")));
        assert_eq!(undo_change_in(&iam, "missing").await, Err(AppError::other("변경 기록을 찾을 수 없어요")));
        change_log::mark_undone(&iam.log_path, "undoable").unwrap();
        assert_eq!(undo_change_in(&iam, "undoable").await, Err(AppError::other("이미 되돌린 변경이에요")));
    }
}
