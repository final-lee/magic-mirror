//! 변경 적용의 마지막 관문(IAM의 `iam::commit`과 같은 길). 백엔드가 미리보기를 다시 계산해 사용자가 본 계획과 같은지, 막힘·확인 문구를 지났는지 본 뒤에만
//! 문장을 돌리고, 결과를 변경 기록(`db-changes.jsonl`)에 남긴다. 문장을 돌리는 일은 `exec`가 하고 여기서는 함수로 받는다(시험은 가짜를 넣는다).
//! 새 비밀번호는 여기서 만든다: 평문은 결과(`PgApplyResult`)에만 한 번 나가고, 문장에는 검증값만 들어가며, 기록에는 가린 글(`shown`)만 남는다.
//! 기록 파일은 비동기 실행기를 막지 않게 따로(`spawn_blocking`) 읽고 쓴다.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::change::digest::digest;
use super::change::model::{PgChange, PresetKind};
use super::change::preview::{evaluate, evaluate_batch, PreviewCtx};
use super::change::sql_text::{Part, Statement};
use super::exec::{ExecError, Step, LOST_BEFORE_COMMIT, UNKNOWN_OUTCOME};
use super::log::{self, PgLogEntry};
use super::model::{ClusterSnapshot, DbSnapshot};
use super::password::NewPassword;
use super::view::{PgApplyResult, PgBatchPreview, PgBatchResult, PgPreview, PgUndo, PgWarnLevel, PgWarning};
use crate::error::AppError;
use crate::iam::clock::iso;
use crate::pg::summary::RDS_SUPERUSER;

pub const STALE: &str = "미리보기 뒤에 바뀌었어요. 미리보기를 다시 받아 주세요";
pub const NOT_FOUND: &str = "변경 기록을 찾을 수 없어요";
pub const NOT_UNDOABLE: &str = "되돌릴 수 없는 변경이에요";
pub const ALREADY_UNDONE: &str = "이미 되돌린 변경이에요";
const UNDO_AFTER_MORE: &str = "만든 뒤에 객체나 권한이 생겨서 되돌릴 수 없어요";
const UNDO_MISMATCH: &str = "되돌리려는 변경이 기록과 달라요";
const RESET_PASSWORD: &str = " 비밀번호를 다시 재설정해 주세요";
const CONFIRMED_AFTER_LOSS: &str = "연결이 끊겼지만 적용된 것을 확인했어요";

/// 사용자가 미리보기에서 본 계획: 미리보기 전체. 적용할 때 다시 계산한 것과 `==`로 견준다(미리보기는 순수하고 크기가 제한돼 있다)
#[derive(Debug, Clone, PartialEq)]
pub enum PgPlan {
    One(PgPreview),
    Batch(PgBatchPreview),
}

#[derive(Debug, Clone, PartialEq)]
pub enum PgChanges {
    One(PgChange),
    Batch { database: String, changes: Vec<PgChange> },
}

impl PgChanges {
    fn list(&self) -> Vec<&PgChange> {
        match self {
            PgChanges::One(change) => vec![change],
            PgChanges::Batch { changes, .. } => changes.iter().collect(),
        }
    }
}

pub struct PgRequest {
    pub profile: String,
    pub target_arn: String,
    pub login_user: String,
    /// 적용 직전에 `force`로 다시 읽은 것
    pub cluster: Arc<ClusterSnapshot>,
    pub db: Arc<DbSnapshot>,
    pub own_pids: Vec<i32>,
    pub read_replica: bool,
    pub default_db: String,
    /// 유닉스 초
    pub now: i64,
    pub changes: PgChanges,
    pub confirm_text: Option<String>,
    /// 되돌리기면 되돌리는 기록의 id들
    pub undo_of: Vec<String>,
    /// 미리보기에서 본 계획(`PlanStore::take`로 꺼낸 것). 없으면 거부한다
    pub seen: Option<PgPlan>,
    pub log_path: PathBuf,
    /// 변경 하나면 기록 id, 묶음이면 묶음 id(기록 id는 `${묶음 id}-${차례}`)
    pub log_id: String,
}

pub enum PgCommitResult {
    One(PgApplyResult),
    Batch(PgBatchResult),
}

/// `ran`이 true면 문장을 돌려 봤으므로(실패해도 알 수 없는 경우가 있다) 읽어 둔 스냅숏을 새로 읽어야 한다
pub struct PgCommitted {
    pub result: Result<PgCommitResult, AppError>,
    pub ran: bool,
}

fn refused(error: AppError) -> PgCommitted {
    PgCommitted { result: Err(error), ran: false }
}

async fn read_log(path: &Path) -> Result<Vec<PgLogEntry>, AppError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || log::read_all(&path)).await.map_err(|e| AppError::other(format!("변경 기록을 읽지 못했어요: {e}")))
}

// ───────────────────────── 되돌리기 ─────────────────────────

fn undoable(entry: &PgLogEntry) -> bool {
    entry.ok && entry.inverse.as_ref().is_some_and(|inverse| !inverse.is_empty())
}

/// 기록 하나의 되돌리기. 기록이 없거나 되돌릴 수 없거나(`inverse`가 없거나 비었거나 실패한 변경) 이미 되돌렸으면 이유를 오류로 돌려준다
pub fn undo_of(entries: &[PgLogEntry], id: &str) -> Result<PgUndo, AppError> {
    let entry = entries.iter().find(|e| e.id == id).ok_or_else(|| AppError::other(NOT_FOUND))?;
    if !undoable(entry) {
        return Err(AppError::other(NOT_UNDOABLE));
    }
    if entry.undone {
        return Err(AppError::other(ALREADY_UNDONE));
    }
    Ok(PgUndo { database: entry.database.clone(), changes: entry.inverse.clone().unwrap_or_default(), undo_of: vec![id.to_string()] })
}

/// 묶음의 되돌리기: 그 묶음에서 성공했고 아직 되돌리지 않았고 되돌릴 수 있는 기록들. `entries`는 새것이 먼저다(`pg_change_log`의 순서).
/// 변경들은 그 기록들의 되돌림을 이은 것이다. 실제로 도는 차례는 미리보기가 다시 정한다
pub fn undo_batch_of(entries: &[PgLogEntry], batch_id: &str) -> Result<PgUndo, AppError> {
    let mine: Vec<&PgLogEntry> = entries.iter().filter(|e| e.batch_id.as_deref() == Some(batch_id)).collect();
    let first = mine.first().ok_or_else(|| AppError::other(NOT_FOUND))?;
    let usable: Vec<&&PgLogEntry> = mine.iter().filter(|e| undoable(e) && !e.undone).collect();
    if usable.is_empty() {
        return Err(AppError::other(NOT_UNDOABLE));
    }
    Ok(PgUndo {
        database: first.database.clone(),
        changes: usable.iter().flat_map(|e| e.inverse.clone().unwrap_or_default()).collect(),
        undo_of: usable.iter().map(|e| e.id.clone()).collect(),
    })
}

/// 되돌리기로 들어온 요청이 기록과 맞는지: 기록마다 있고, 되돌릴 수 있고, 아직 안 되돌렸고, 같은 대상이고,
/// 기록들의 되돌림을 `undo_of` 순서로 이은 것이 받은 변경과 같다(묶음 순서를 바꾸기 전의 것)
fn check_undo(entries: &[PgLogEntry], ids: &[String], changes: &[&PgChange], target_arn: &str) -> Result<(), AppError> {
    let mut expected: Vec<&PgChange> = Vec::new();
    for id in ids {
        let entry = entries.iter().find(|e| &e.id == id).ok_or_else(|| AppError::other(NOT_FOUND))?;
        if !undoable(entry) {
            return Err(AppError::other(NOT_UNDOABLE));
        }
        if entry.undone {
            return Err(AppError::other(ALREADY_UNDONE));
        }
        if entry.target_arn != target_arn {
            return Err(AppError::other(format!("다른 대상의 변경이에요: {}", entry.target_arn)));
        }
        expected.extend(entry.inverse.iter().flatten());
    }
    if expected != changes {
        return Err(AppError::other(UNDO_MISMATCH));
    }
    Ok(())
}

/// 역할 삭제는 역할 만들기를 되돌릴 때만 쓴다: 되돌리는 기록이 모두 역할 만들기이고, 지우는 역할은 그 변경이 만든 이름이나 그룹이어야 하며,
/// 만든 뒤에 그 역할에 구성원이나 그룹이 더 생기지 않았어야 한다
fn check_drop_roles(req: &PgRequest, entries: &[PgLogEntry]) -> Result<(), AppError> {
    let drops: Vec<&str> = req.changes.list().into_iter().filter_map(|c| if let PgChange::DropRole { role } = c { Some(role.as_str()) } else { None }).collect();
    if drops.is_empty() {
        return Ok(());
    }
    if req.undo_of.is_empty() {
        return Err(AppError::other(NOT_UNDOABLE));
    }
    let mut creates: Vec<&PgChange> = Vec::new();
    for id in &req.undo_of {
        let entry = entries.iter().find(|e| &e.id == id).ok_or_else(|| AppError::other(NOT_FOUND))?;
        if !matches!(entry.change, PgChange::CreateRole { .. }) {
            return Err(AppError::other(NOT_UNDOABLE));
        }
        creates.push(&entry.change);
    }
    // 만든 변경이 들여놓은 구성원 관계: 새 역할은 `groups`와 새로 만든 그룹에 들어가고, 새 그룹의 구성원은 새 역할이다
    fn created_group(change: &PgChange) -> Option<&str> {
        match change {
            PgChange::CreateRole { preset: Some(preset), .. } if preset.create_group => preset.group.as_deref(),
            _ => None,
        }
    }
    for role in drops {
        let made_by: Vec<&&PgChange> = creates.iter().filter(|c| matches!(c, PgChange::CreateRole { name, .. } if name == role) || created_group(c) == Some(role)).collect();
        if made_by.is_empty() {
            return Err(AppError::other(NOT_UNDOABLE));
        }
        let allowed_groups: Vec<&str> = creates
            .iter()
            .flat_map(|c| match c {
                // `resolve`가 새 역할을 넣는 곳: `groups`, 프리셋의 그룹(새로 만들었든 이미 있든), 관리자 프리셋의 `rds_superuser`
                PgChange::CreateRole { name, groups, preset, .. } if name == role => {
                    let preset_groups = preset.iter().flat_map(|p| p.group.as_deref().into_iter().chain((p.preset == PresetKind::Admin).then_some(RDS_SUPERUSER)));
                    groups.iter().map(String::as_str).chain(preset_groups).collect::<Vec<_>>()
                }
                _ => Vec::new(),
            })
            .collect();
        let allowed_members: Vec<&str> = creates
            .iter()
            .filter(|c| created_group(c) == Some(role))
            .filter_map(|c| if let PgChange::CreateRole { name, .. } = c { Some(name.as_str()) } else { None })
            // 160000부터 역할을 만든 로그인한 역할은 그 역할의 ADMIN 구성원으로 남는다
            .chain([req.cluster.login_user.as_str()])
            .collect();
        let extra = req.cluster.members.iter().any(|m| (m.member == role && !allowed_groups.contains(&m.group.as_str())) || (m.group == role && !allowed_members.contains(&m.member.as_str())));
        if extra {
            return Err(AppError::other(UNDO_AFTER_MORE));
        }
    }
    Ok(())
}

// ───────────────────────── 관문 ─────────────────────────

/// 경고들과 확인 문구로 본 관문(IAM과 같은 문구)
pub(super) fn gate_of<'a>(mut warnings: impl Iterator<Item = &'a PgWarning> + Clone, confirm_text: Option<&str>, typed: Option<&str>) -> Result<(), AppError> {
    let blocks: Vec<&str> = warnings.clone().filter(|w| w.level == PgWarnLevel::Block).map(|w| w.message.as_str()).collect();
    if !blocks.is_empty() {
        return Err(AppError::other(format!("막혀 있어서 적용할 수 없어요: {}", blocks.join(" / "))));
    }
    match confirm_text {
        Some(expected) if typed != Some(expected) => Err(AppError::other(format!("확인 문구가 달라요. 입력해야 할 이름: {expected}"))),
        Some(_) => Ok(()),
        None if warnings.any(|w| w.level == PgWarnLevel::Confirm) => Err(AppError::other("확인할 이름을 알 수 없어서 적용할 수 없어요")),
        None => Ok(()),
    }
}

/// 풀린 변경 하나(묶음이면 도는 차례의 하나)
struct Item {
    /// 받은 변경 목록에서의 자리
    index: usize,
    change: PgChange,
    summary: String,
    statements: Vec<Statement>,
    inverse: Option<Vec<PgChange>>,
}

struct Prepared {
    items: Vec<Item>,
    /// 항목마다(도는 차례) 그 변경이 되돌리는 기록의 id. 되돌리기가 아니면 모두 None
    sources: Vec<Option<String>>,
    plan: PgPlan,
    after: (ClusterSnapshot, DbSnapshot),
}

/// 미리보기를 다시 계산한다(권한 계산은 CPU를 쓰니 따로 돌린다)
async fn recompute(req: &PgRequest) -> Result<Prepared, AppError> {
    let (cluster, db, own_pids, default_db) = (req.cluster.clone(), req.db.clone(), req.own_pids.clone(), req.default_db.clone());
    let (read_replica, now, changes) = (req.read_replica, req.now, req.changes.clone());
    tokio::task::spawn_blocking(move || {
        let ctx = PreviewCtx { cluster: &cluster, db: &db, own_pids: &own_pids, read_replica, default_db: &default_db, now };
        match changes {
            PgChanges::One(change) => {
                let evaluated = evaluate(&ctx, &change);
                let summary = evaluated.preview.summary.clone();
                let inverse = evaluated.inverse.filter(|inverse| !inverse.is_empty());
                Prepared { sources: Vec::new(), items: vec![Item { index: 0, change, summary, statements: evaluated.statements, inverse }], plan: PgPlan::One(evaluated.preview), after: evaluated.after }
            }
            PgChanges::Batch { database, changes } => {
                let evaluated = evaluate_batch(&ctx, &database, &changes);
                let summaries: Vec<String> = evaluated.preview.items.iter().map(|item| item.summary.clone()).collect();
                let items = evaluated
                    .items
                    .into_iter()
                    .zip(summaries)
                    .map(|(item, summary)| Item { index: item.index, change: item.change, summary, statements: item.statements, inverse: item.inverse.filter(|inverse| !inverse.is_empty()) })
                    .collect();
                Prepared { sources: Vec::new(), items, plan: PgPlan::Batch(evaluated.preview), after: evaluated.after }
            }
        }
    })
    .await
    .map_err(|e| AppError::other(format!("미리보기를 계산하지 못했어요: {e}")))
}

fn gate(plan: &PgPlan, typed: Option<&str>) -> Result<(), AppError> {
    match plan {
        PgPlan::One(p) => gate_of(p.warnings.iter(), p.confirm_text.as_deref(), typed),
        PgPlan::Batch(p) => gate_of(p.warnings.iter().chain(p.items.iter().flat_map(|i| i.warnings.iter())), p.confirm_text.as_deref(), typed),
    }
}

/// 되돌리기 점검, 미리보기 재계산, 본 계획과의 비교, 관문까지 통과해야 문장으로 넘어간다
async fn prepare(req: &PgRequest) -> Result<Prepared, AppError> {
    let entries = if req.undo_of.is_empty() { Vec::new() } else { read_log(&req.log_path).await? };
    check_drop_roles(req, &entries)?;
    if !req.undo_of.is_empty() {
        check_undo(&entries, &req.undo_of, &req.changes.list(), &req.target_arn)?;
    }
    let mut prepared = recompute(req).await?;
    if req.seen.as_ref() != Some(&prepared.plan) {
        return Err(AppError::other(STALE));
    }
    gate(&prepared.plan, req.confirm_text.as_deref())?;
    // `check_undo`가 받은 변경이 기록들의 되돌림을 `undo_of` 순서로 이은 것임을 확인했다: 받은 자리 i의 변경은 이은 목록의 i번째 되돌림이다
    let source_of: Vec<&String> = req.undo_of.iter().flat_map(|id| entries.iter().find(|e| &e.id == id).into_iter().flat_map(move |e| e.inverse.iter().flatten().map(move |_| id))).collect();
    prepared.sources = prepared.items.iter().map(|item| source_of.get(item.index).map(|id| (*id).clone())).collect();
    Ok(prepared)
}

// ───────────────────────── 기록 ─────────────────────────

fn noted(text: String, notes: &[String]) -> String {
    if notes.is_empty() {
        text
    } else {
        format!("{text} ({})", notes.join(", "))
    }
}

/// 기록 파일에 쓴 결과: 파일에 남은 기록의 id들과, 하지 못한 일을 알리는 문구
struct Recorded {
    ids: Vec<String>,
    notes: Vec<String>,
}

/// 변경마다 기록 하나를 덧붙이고, 성공했으면 되돌린 기록에 표시한다
async fn record(req: &PgRequest, items: &[Item], sources: &[Option<String>], outcome: &Outcome) -> Recorded {
    let batch = matches!(req.changes, PgChanges::Batch { .. });
    let entries: Vec<PgLogEntry> = items
        .iter()
        .enumerate()
        .map(|(index, item)| PgLogEntry {
            id: if batch { format!("{}-{}", req.log_id, index + 1) } else { req.log_id.clone() },
            at: iso(req.now),
            profile: req.profile.clone(),
            target_arn: req.target_arn.clone(),
            database: req.db.database.clone(),
            login_user: req.login_user.clone(),
            change: item.change.clone(),
            summary: item.summary.clone(),
            sql: item.statements.iter().map(Statement::shown).collect(),
            ok: outcome.ok,
            error: outcome.error.clone(),
            inverse: if outcome.ok { item.inverse.clone() } else { None },
            undo_of: sources.get(index).cloned().flatten(),
            undone: false,
            batch_id: batch.then(|| req.log_id.clone()),
        })
        .collect();
    let (path, undone) = (req.log_path.clone(), if outcome.ok { req.undo_of.clone() } else { Vec::new() });
    let saved = tokio::task::spawn_blocking(move || {
        let (mut ids, mut notes) = (Vec::new(), Vec::new());
        for entry in &entries {
            match log::append(&path, entry) {
                Ok(()) => ids.push(entry.id.clone()),
                Err(e) => notes.push(format!("변경 기록을 저장하지 못했어요: {e}")),
            }
        }
        for original in &undone {
            if let Err(e) = log::mark_undone(&path, original) {
                notes.push(format!("이전 기록에 '되돌림' 표시를 하지 못했어요: {e}"));
            }
        }
        Recorded { ids, notes }
    })
    .await;
    saved.unwrap_or_else(|e| Recorded { ids: Vec::new(), notes: vec![format!("변경 기록을 저장하지 못했어요: {e}")] })
}

/// 문장을 돌린 결과를 기록에 적을 꼴로
struct Outcome {
    ok: bool,
    error: Option<String>,
    /// 연결이 끊겼지만 적용된 것을 확인했다
    confirmed_after_loss: bool,
}

fn error_text(error: &AppError) -> String {
    match error {
        AppError::Other { message } | AppError::Network { message } => message.clone(),
        other => other.to_string(),
    }
}

// ───────────────────────── 적용 ─────────────────────────

/// 미리보기를 다시 계산해 거를 것을 거르고, `exec`에 확인한 문장들을 넘겨 한 트랜잭션으로 적용하고, 결과를 기록에 남긴다.
/// 거부되면 `exec`를 부르지 않고 기록도 남기지 않는다. 적용에 실패하면 실패한 기록(`ok=false`)을 남기고 그 오류를 돌려준다.
/// `COMMIT`의 답을 못 받았으면 `reread`로 다시 읽어 예측한 모습과 견준다.
pub async fn commit<X, XF, R, RF>(req: PgRequest, exec: X, reread: R) -> PgCommitted
where
    X: FnOnce(Vec<Step>) -> XF,
    XF: Future<Output = Result<(), ExecError>>,
    R: FnOnce() -> RF,
    RF: Future<Output = Result<(Arc<ClusterSnapshot>, Arc<DbSnapshot>), AppError>>,
{
    let prepared = match prepare(&req).await {
        Ok(prepared) => prepared,
        Err(error) => return refused(error),
    };
    let Prepared { items, after, sources, .. } = prepared;
    // 비밀번호는 문장을 돌릴 때 만든다. 평문은 결과에만 나가고 문장에는 검증값만 들어간다
    let password = items.iter().flat_map(|item| &item.statements).any(|s| s.parts.contains(&Part::Password)).then(NewPassword::generate);
    let hash = password.as_ref().map(NewPassword::scram);
    let steps: Vec<Step> = items.iter().flat_map(|item| &item.statements).map(|s| Step { run: s.run(hash.as_ref()), expect: s.expect }).collect();
    drop(hash);

    let (outcome, failure) = match exec(steps).await {
        Ok(()) => (Outcome { ok: true, error: None, confirmed_after_loss: false }, None),
        Err(ExecError::Failed(error)) => (Outcome { ok: false, error: Some(error_text(&error)), confirmed_after_loss: false }, Some(error)),
        Err(ExecError::CommitUnknown) => settle_unknown(&req, &items, &after, reread).await,
    };
    let recorded = record(&req, &items, &sources, &outcome).await;
    let result = if outcome.ok {
        let mut notes = recorded.notes;
        if outcome.confirmed_after_loss {
            notes.insert(0, CONFIRMED_AFTER_LOSS.to_string());
        }
        Ok(match &req.changes {
            PgChanges::One(_) => PgCommitResult::One(PgApplyResult {
                log_id: req.log_id.clone(),
                summary: items.first().map(|item| item.summary.clone()).unwrap_or_default(),
                password: password.map(|password| password.expose()),
                notes,
            }),
            PgChanges::Batch { .. } => PgCommitResult::Batch(PgBatchResult { batch_id: req.log_id.clone(), log_ids: recorded.ids, summary: format!("변경 {}개", items.len()), notes }),
        })
    } else {
        let text = outcome.error.unwrap_or_default();
        Err(match failure {
            Some(error) if recorded.notes.is_empty() => error,
            // 기록을 저장하지 못한 것도 알리되 오류의 종류는 그대로 둔다
            Some(AppError::Network { message }) => AppError::Network { message: noted(message, &recorded.notes) },
            Some(AppError::Other { message }) => AppError::Other { message: noted(message, &recorded.notes) },
            // 문구 칸이 없는 오류(`SsoExpired`, `AccessDenied`, `Throttled`)는 글로 풀어 `Other`로 낸다: 기록을 저장하지 못했다는 말이 사라지지 않게 한다.
            // 이때만 오류의 종류가 바뀐다(기록 저장이 실패한 드문 경우)
            Some(error) => AppError::other(noted(error.to_string(), &recorded.notes)),
            None => AppError::other(noted(text, &recorded.notes)),
        })
    };
    PgCommitted { result, ran: true }
}

/// `COMMIT`의 답을 못 받았다: 다시 읽어 적용됐는지 가린다. 비밀번호나 세션처럼 스냅숏에 모습이 없는 변경은 가릴 수 없다
async fn settle_unknown<R, RF>(req: &PgRequest, items: &[Item], after: &(ClusterSnapshot, DbSnapshot), reread: R) -> (Outcome, Option<AppError>)
where
    R: FnOnce() -> RF,
    RF: Future<Output = Result<(Arc<ClusterSnapshot>, Arc<DbSnapshot>), AppError>>,
{
    let unknown = |password: bool| {
        let text = if password { format!("{UNKNOWN_OUTCOME}{RESET_PASSWORD}") } else { UNKNOWN_OUTCOME.to_string() };
        (Outcome { ok: false, error: Some(text.clone()), confirmed_after_loss: false }, Some(AppError::other(text)))
    };
    let has_password = items.iter().any(|item| matches!(item.change, PgChange::Password { .. }));
    // 비밀번호를 정한 변경(`password`, 비밀번호가 있는 `createRole`): 알 수 없을 때 누구도 비밀번호를 모를 수 있다
    let sets_password = items.iter().flat_map(|item| &item.statements).any(|s| s.parts.contains(&Part::Password));
    let before = digest(&req.cluster, &req.db);
    let predicted = digest(&after.0, &after.1);
    if has_password || before == predicted {
        return unknown(sets_password);
    }
    let Ok((cluster, db)) = reread().await else { return unknown(sets_password) };
    let now = digest(&cluster, &db);
    if now == predicted {
        (Outcome { ok: true, error: None, confirmed_after_loss: true }, None)
    } else if now == before {
        (Outcome { ok: false, error: Some(LOST_BEFORE_COMMIT.to_string()), confirmed_after_loss: false }, Some(AppError::other(LOST_BEFORE_COMMIT)))
    } else {
        unknown(sets_password)
    }
}

#[cfg(test)]
mod tests;
