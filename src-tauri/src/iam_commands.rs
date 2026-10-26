//! IAM 작업 공간의 명령. 계정의 IAM 상태(스냅숏)는 프로필마다 한 번 읽어 캐시해 두고, 대부분의 명령은 그 스냅숏으로 계산한다.
//! IAM은 글로벌 서비스라 리전은 `GLOBAL_REGION`을 쓴다. 이 파일의 AWS 호출은 모두 읽기 전용이다:
//! 변경(`iam_apply`)은 `iam::commit`이 거른 뒤 `iam::write`가 한다.

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
use crate::iam::change::{deletes_policy_version, preview, ApiCall, ChangePreview, Facts, IamChange, PolicyCheck};
use crate::iam::clock::{now_secs, parse_iso};
use crate::iam::commit::{commit, is_stale, new_log_id, undo_change_of, ApplyResult, Plan, PlanStore, Request};
use crate::iam::eval::{evaluate, principal_actions, principal_view, who_can};
use crate::iam::fetch::checks::{self, FindingLevel, SimulateResult, ValidationResult};
use crate::iam::fetch::keys::{self, AccessKeyInfo, KeyStatus};
use crate::iam::fetch::policies::{self, PolicyRef};
use crate::iam::fetch::{self, usage};
use crate::iam::fetch_policy::ensure_policy;
use crate::iam::findings::{findings, Findings};
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
/// 그 결과는 무효화 전의 상태일 수 있어서 담지 않는다(그 읽기를 기다리던 요청에게만 돌려준다).
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
        // 새로 고침은 읽어 둔 것을 모두 버리고, 새로 고침보다 먼저 시작한 읽기의 결과도 쓰지 않는다. 정책 목록은 다음에 필요할 때 읽는다.
        // 새로 고침 뒤에 시작한 읽기는 함께 쓴다(새로 고침 여러 개가 같은 읽기를 기다리면 한 번만 읽는다)
        invalidate(iam, profile);
        iam.policy_lists.invalidate(profile);
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
/// 이 프로필에서 IAM을 바꾼 뒤 10초 동안은 나이와 상관없이 늘 새로 읽고, 그 10초 안에 읽은 스냅숏은 그 뒤에 한 번 더 읽는다.
/// 바꾸기 전에 시작한 읽기의 결과는 세대 캐시가 담지 않는다.
async fn fresh_snapshot_with<F, Fut>(iam: &IamState, profile: &str, now: i64, fetch: F) -> Result<Arc<Snapshot>, AppError>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<Snapshot, AppError>>,
{
    let written = written_at(iam, profile);
    if written.is_some_and(|at| now - at < SETTLE_SECS) {
        return snapshot_with(iam, profile, true, &fetch).await;
    }
    let cached = snapshot_with(iam, profile, false, &fetch).await?;
    let unsettled = written.is_some_and(|at| parse_iso(&cached.fetched_at).is_none_or(|read| read - at < SETTLE_SECS));
    if is_stale(&cached.fetched_at, now) || unsettled {
        return snapshot_with(iam, profile, true, &fetch).await;
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
        // 일부만 적용되고 실패했을 수도 있으니 성공하지 않았어도 읽어 둔 것을 버린다
        invalidate(iam, &profile);
        mark_written(iam, &profile, now_secs());
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
    apply_with(&iam, req, s, facts, move |plan: Vec<ApiCall>| async move { write::apply(&client, &plan).await }).await
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
