//! 변경 적용의 마지막 관문. 백엔드가 미리보기를 다시 계산해, 사용자가 미리보기에서 본 계획과 같은지(`plan`)와 막힘·확인 문구를 확인한 뒤에만
//! 쓰기 호출을 하고, 결과를 변경 기록에 남긴다. IAM 쓰기 호출은 `write`에 있고 여기서는 함수로 받는다(테스트는 가짜 쓰기를 넣는다).
//! 변경 기록 파일은 비동기 실행기를 막지 않게 따로(`spawn_blocking`) 읽고 쓴다.
//! 장바구니의 묶음은 `batch`가 같은 관문을 지나 적용 순서대로 변경마다 쓰고 기록한다(`gate_batch`, `BatchPlan`).

pub mod batch;
pub mod plan;

use std::collections::hash_map::RandomState;
use std::future::Future;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;

pub use self::plan::{Plan, PlanStore};
use super::change::{inverse, preview, ApiCall, BatchPreview, ChangePreview, Facts, IamChange, PolicyCheck, WarnLevel, Warning};
use super::clock::{iso, parse_iso};
use super::log::{self, ChangeLogEntry};
use super::model::Snapshot;
use super::write::Applied;
use crate::error::AppError;

/// 스냅숏이 이보다 오래됐으면 적용 전에 새로 읽는다(초).
pub const FRESH_SECS: i64 = 60;

/// 계약의 `ApplyResult`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub log_id: String,
    pub summary: String,
    /// IAM은 바꿨지만 그 뒤에 하지 못한 일(변경 기록을 저장하지 못함, 되돌린 기록에 표시하지 못함). 화면은 닫을 때까지 보여 준다.
    /// 비면 보내지 않는다(계약에 더한 선택 필드)
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

/// 적용 요청. 스냅숏은 적용 직전에 읽은(또는 60초 안에 읽은) 것이어야 한다.
pub struct Request {
    pub profile: String,
    pub snapshot: Arc<Snapshot>,
    /// 스냅숏 밖의 재료. 미리보기 때와 같은 방법으로 방금 읽은 것이다
    pub facts: Facts,
    pub change: IamChange,
    pub confirm_text: Option<String>,
    /// 되돌리기면 되돌리는 기록의 id
    pub undo_of: Option<String>,
    /// 미리보기에서 사용자가 본 계획(`PlanStore::take`로 꺼낸 것). 없으면 거부한다
    pub seen: Option<Plan>,
    pub log_path: PathBuf,
    /// 유닉스 초
    pub now: i64,
    pub log_id: String,
}

/// 적용 결과. `wrote`가 true면 쓰기 호출을 했으므로 읽어 둔 스냅숏을 버려야 한다(실패해도 일부가 적용됐을 수 있다).
pub struct Committed {
    pub result: Result<ApplyResult, AppError>,
    pub wrote: bool,
}

/// 읽어 둔 스냅숏이 적용하기에 낡았는가. 시각을 읽지 못해도 낡은 것으로 본다.
pub fn is_stale(fetched_at: &str, now: i64) -> bool {
    parse_iso(fetched_at).is_none_or(|read| now - read > FRESH_SECS)
}

/// 변경 기록의 새 id. 시각(밀리초)·이 프로세스 안의 순번·무작위 값으로 만든다.
pub fn new_log_id(now_millis: u128) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let random = RandomState::new().build_hasher().finish();
    format!("{now_millis:x}-{:x}-{:08x}", NEXT.fetch_add(1, Ordering::Relaxed), random as u32)
}

/// 경고들과 확인 문구로 본 관문. 막힘이 있으면 거부하고, 확인 문구가 필요하면 한 글자도 다르지 않게 입력해야 한다.
fn gate_of<'a>(mut warnings: impl Iterator<Item = &'a Warning> + Clone, confirm_text: Option<&str>, typed: Option<&str>) -> Result<(), AppError> {
    let blocks: Vec<&str> = warnings.clone().filter(|w| w.level == WarnLevel::Block).map(|w| w.message.as_str()).collect();
    if !blocks.is_empty() {
        return Err(AppError::other(format!("막혀 있어서 적용할 수 없어요: {}", blocks.join(" / "))));
    }
    match confirm_text {
        Some(expected) if typed != Some(expected) => Err(AppError::other(format!("확인 문구가 달라요. 입력해야 할 이름: {expected}"))),
        Some(_) => Ok(()),
        // 확인이 필요한데 입력할 이름을 알 수 없으면 확인할 방법이 없다
        None if warnings.any(|w| w.level == WarnLevel::Confirm) => Err(AppError::other("확인할 이름을 알 수 없어서 적용할 수 없어요")),
        None => Ok(()),
    }
}

/// 미리보기대로 적용해도 되는지. 막힘이 있으면 거부하고, 확인 문구가 필요하면 한 글자도 다르지 않게 입력해야 한다.
pub fn gate(preview: &ChangePreview, typed: Option<&str>) -> Result<(), AppError> {
    gate_of(preview.warnings.iter(), preview.confirm_text.as_deref(), typed)
}

/// 묶음 미리보기대로 적용해도 되는지. 묶음 전체의 경고와 변경마다의 경고를 모두 본다.
pub fn gate_batch(p: &BatchPreview, typed: Option<&str>) -> Result<(), AppError> {
    gate_of(p.warnings.iter().chain(p.changes.iter().flat_map(|i| i.warnings.iter())), p.confirm_text.as_deref(), typed)
}

/// 변경 기록에서 `id`의 역변경. 기록이 없거나 되돌릴 수 없거나 이미 되돌렸으면 이유(한국어)를 오류로 돌려준다.
pub fn undo_change_of(entries: &[ChangeLogEntry], id: &str) -> Result<IamChange, AppError> {
    let entry = entries.iter().find(|e| e.id == id).ok_or_else(|| AppError::other("변경 기록을 찾을 수 없어요"))?;
    let inverse = entry.inverse.clone().ok_or_else(|| AppError::other("되돌릴 수 없는 변경이에요"))?;
    if entry.undone {
        return Err(AppError::other("이미 되돌린 변경이에요"));
    }
    Ok(inverse)
}

/// 되돌리기로 들어온 요청이 기록과 맞는지: 기록이 있고, 되돌릴 수 있고, 아직 안 되돌렸고, 같은 계정이고, 적용하려는 변경이 기록된 역변경과 같다.
pub fn check_undo(entries: &[ChangeLogEntry], id: &str, change: &IamChange, account_id: &str) -> Result<(), AppError> {
    let recorded = undo_change_of(entries, id)?;
    if let Some(entry) = entries.iter().find(|e| e.id == id).filter(|e| e.account_id != account_id) {
        return Err(AppError::other(format!("다른 계정({})에서 한 변경이라 이 계정에서는 되돌릴 수 없어요", entry.account_id)));
    }
    if &recorded != change {
        return Err(AppError::other("되돌리려는 변경이 기록과 달라요"));
    }
    Ok(())
}

/// 변경 기록 전체(덧붙인 순서).
async fn read_log(path: &Path) -> Result<Vec<ChangeLogEntry>, AppError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || log::read_all(&path)).await.map_err(|e| AppError::other(format!("변경 기록을 읽지 못했어요: {e}")))
}

/// 되돌리기 점검, 문서 검사 결과, 미리보기 재계산, 본 계획과의 비교, 관문까지 통과해야 쓰기로 넘어간다. (미리보기, 되돌리는 변경)을 돌려준다.
async fn prepare(req: &Request) -> Result<(ChangePreview, Option<IamChange>), AppError> {
    if let Some(id) = req.undo_of.as_deref() {
        check_undo(&read_log(&req.log_path).await?, id, &req.change, &req.snapshot.account_id)?;
    }
    // 버전을 지운 뒤 새 버전 만들기가 실패하면 지운 버전은 돌아오지 않는다. 검사기가 오류를 낸 문서로는 시작하지 않는다
    if let PolicyCheck::Errors(errors) = &req.facts.policy_check {
        return Err(AppError::other(format!("정책 문서에 오류가 있어 적용하지 않았어요: {}", errors.join(" / "))));
    }
    // 권한 계산은 CPU를 쓰는 일이라 비동기 실행기를 막지 않게 따로 돌린다
    let (snapshot, change, facts) = (req.snapshot.clone(), req.change.clone(), req.facts.clone());
    let (checked, undo) = tokio::task::spawn_blocking(move || (preview(&snapshot, &change, &facts), inverse(&snapshot, &change, &facts)))
        .await
        .map_err(|e| AppError::other(format!("미리보기를 계산하지 못했어요: {e}")))?;
    plan::check(req.seen.as_ref(), &Plan::of(&req.snapshot.account_id, &checked))?;
    gate(&checked, req.confirm_text.as_deref())?;
    Ok((checked, undo))
}

/// 성공한 호출 가운데 정책 버전을 지운 것이 있으면 그 버전 ID.
fn deleted_version(done: &[ApiCall]) -> Option<String> {
    done.iter().find(|call| call.api == "iam:DeletePolicyVersion").and_then(|call| call.params.get("VersionId")).cloned()
}

/// 글 뒤에 괄호로 덧붙인다(덧붙일 것이 없으면 그대로).
fn noted(text: String, notes: &[String]) -> String {
    if notes.is_empty() {
        text
    } else {
        format!("{text} ({})", notes.join(", "))
    }
}

/// 기록을 덧붙이고, 되돌리기에 성공했으면(`undone` = 되돌린 기록의 id) 그 기록에 표시한다. 하지 못한 일을 문구로 돌려준다.
async fn record(path: PathBuf, entry: ChangeLogEntry, undone: Option<String>) -> Vec<String> {
    let saved = tokio::task::spawn_blocking(move || {
        let mut notes = Vec::new();
        match log::append(&path, &entry) {
            Err(e) => notes.push(format!("변경 기록을 저장하지 못했어요: {e}")),
            Ok(()) => {
                if let Some(original) = undone {
                    if let Err(e) = log::mark_undone(&path, &original) {
                        notes.push(format!("이전 기록에 '되돌림' 표시를 하지 못했어요: {e}"));
                    }
                }
            }
        }
        notes
    })
    .await;
    saved.unwrap_or_else(|e| vec![format!("변경 기록을 저장하지 못했어요: {e}")])
}

/// 쓰기 결과를 기록에 남기고 호출자에게 돌려줄 값을 만든다. 기록의 `calls`는 실제로 성공한 호출이다.
/// 정책 버전을 지웠으면 그 버전 ID를 요약(성공)이나 오류 문구(실패)에 적는다: 실패해도 지운 버전은 돌아오지 않는다.
async fn finish(req: Request, checked: ChangePreview, undo: Option<IamChange>, applied: Applied) -> Committed {
    let Applied { done, result } = applied;
    let deleted = deleted_version(&done);
    let outcome = result.map_err(|e| {
        let text = match &deleted {
            Some(version) => format!("{e} (이미 삭제한 버전: {version})"),
            None => e.to_string(),
        };
        (e, text)
    });
    let summary = match (&outcome, &deleted) {
        (Ok(()), Some(version)) => format!("{} (삭제한 버전: {version})", checked.summary),
        _ => checked.summary,
    };
    let ok = outcome.is_ok();
    let entry = ChangeLogEntry {
        id: req.log_id.clone(),
        at: iso(req.now),
        profile: req.profile,
        account_id: req.snapshot.account_id.clone(),
        caller_arn: req.snapshot.caller_arn.clone(),
        change: req.change,
        summary: summary.clone(),
        calls: done.iter().map(|call| call.api.clone()).collect(),
        ok,
        error: outcome.as_ref().err().map(|(_, text)| text.clone()),
        // 적용되지 않은 변경은 되돌릴 것이 없다
        inverse: if ok { undo } else { None },
        undo_of: req.undo_of.clone(),
        undone: false,
        batch_id: None,
    };
    let notes = record(req.log_path, entry, if ok { req.undo_of } else { None }).await;
    let result = match outcome {
        Ok(()) => Ok(ApplyResult { log_id: req.log_id, summary, notes }),
        Err((e, _)) if deleted.is_none() && notes.is_empty() => Err(e),
        // 지운 버전이나 기록하지 못한 일도 알려야 해서 한 문구로 모은다
        Err((_, text)) => Err(AppError::other(noted(text, &notes))),
    };
    Committed { result, wrote: true }
}

/// 미리보기를 다시 계산해 거를 것을 거르고, `write`에 확인한 호출 목록을 넘겨 적용하고, 결과를 기록에 남긴다.
/// 거부되면 `write`를 부르지 않고 기록도 남기지 않는다. 적용에 실패하면 실패한 기록(`ok=false`)을 남기고 그 오류를 돌려준다.
/// 기록을 저장하지 못한 것은 이미 적용된 변경을 가리지 않도록 오류가 아니라 결과의 `notes`로 알린다(적용도 실패했으면 오류 문구에 함께 적는다).
pub async fn commit<W, Fut>(req: Request, write: W) -> Committed
where
    W: FnOnce(Vec<ApiCall>) -> Fut,
    Fut: Future<Output = Applied>,
{
    match prepare(&req).await {
        Err(refused) => Committed { result: Err(refused), wrote: false },
        Ok((checked, undo)) => {
            let applied = write(checked.calls.clone()).await;
            finish(req, checked, undo, applied).await
        }
    }
}

#[cfg(test)]
mod tests;
