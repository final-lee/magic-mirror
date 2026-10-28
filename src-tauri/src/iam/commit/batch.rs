//! 묶음 적용: 다시 계산한 묶음 미리보기를 사용자가 본 계획과 견주고 관문을 지난 뒤, 적용 순서대로 변경마다 쓰고 기록한다.
//! 실패하면 거기서 멈춘다: 이미 적용된 변경은 그대로 두고(자동 되돌리기 없음) 결과에 실패한 위치를 알린다.
//! 변경 기록을 저장하지 못할 때도 멈춘다: 기록할 수 없는 쓰기는 더 하지 않는다(그 변경은 이미 적용됐으니 알림에 그 요약을 적어 알리고, 다음 변경을 멈춘 곳으로 알린다).

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;

use super::plan::{self, BatchPlan};
use super::{check_undo, gate_batch, iso, read_log, record};
use crate::error::AppError;
use crate::iam::change::{application_order, preview_batch, ApiCall, BatchPreview, Facts, IamChange};
use crate::iam::log::ChangeLogEntry;
use crate::iam::model::Snapshot;
use crate::iam::write::Applied;

/// 변경 기록을 저장하지 못해서 다음 변경을 적용하지 않고 멈출 때 그 변경의 실패 이유
pub const LOG_NOT_SAVED: &str = "변경 기록을 저장하지 못해서 멈췄어요";
/// 변경 기록을 저장하지 못했는데 그 변경은 이미 적용됐을 때 알림에서 그 변경의 요약 뒤에 오는 말(`<요약>: <이 문구>`)
pub const APPLIED_NOT_LOGGED: &str = "적용했지만 변경 기록에 남기지 못했어요";

pub struct BatchRequest {
    pub profile: String,
    pub snapshot: Arc<Snapshot>,
    /// `changes`와 같은 순서로 변경마다 하나
    pub facts: Vec<Facts>,
    /// 받은 순서(장바구니 순서)
    pub changes: Vec<IamChange>,
    pub confirm_text: Option<String>,
    /// 되돌리기 묶음이면 `changes`와 같은 길이, i번째 변경이 되돌리는 기록 id
    pub undo_of: Option<Vec<String>>,
    pub seen: Option<BatchPlan>,
    pub log_path: PathBuf,
    pub now: i64,
    /// 기록 id는 `{batch_id}-{적용 순서, 1부터}`
    pub batch_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFailure {
    /// 적용 순서 기준, 0부터
    pub index: usize,
    pub summary: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub batch_id: String,
    /// 변경 기록 파일에 남은 변경의 기록 id, 적용 순서. 적용했어도 기록을 남기지 못한 변경은 없다(`notes`로 알린다)
    pub log_ids: Vec<String>,
    pub failed: Option<BatchFailure>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

pub struct BatchCommitted {
    pub result: Result<BatchResult, AppError>,
    /// 쓰기를 한 번이라도 불렀는지(부른 쪽이 스냅숏을 버려야 하는지)
    pub wrote: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoBatch {
    pub changes: Vec<IamChange>,
    pub undo_of: Vec<String>,
}

/// 묶음의 되돌리기: 그 묶음에서 성공했고 아직 되돌리지 않은 기록의 역변경을 적용의 반대 순서로. `entries`는 `change_log_of`처럼 새것이 먼저라서 그 순서가 곧 되돌릴 순서다.
pub fn undo_batch_of(entries: &[ChangeLogEntry], batch_id: &str) -> Result<UndoBatch, AppError> {
    let mine: Vec<&ChangeLogEntry> = entries.iter().filter(|e| e.batch_id.as_deref() == Some(batch_id)).collect();
    if mine.is_empty() {
        return Err(AppError::other("변경 기록을 찾지 못했어요"));
    }
    let (changes, undo_of): (Vec<IamChange>, Vec<String>) =
        mine.iter().filter(|e| e.ok && !e.undone).filter_map(|e| e.inverse.clone().map(|inv| (inv, e.id.clone()))).unzip();
    if changes.is_empty() {
        return Err(AppError::other("되돌릴 변경이 없어요"));
    }
    Ok(UndoBatch { changes, undo_of })
}

async fn prepare(req: &BatchRequest) -> Result<BatchPreview, AppError> {
    if let Some(ids) = &req.undo_of {
        if ids.len() != req.changes.len() {
            return Err(AppError::other("되돌릴 기록과 변경의 수가 맞지 않아요"));
        }
        let entries = read_log(&req.log_path).await?;
        for (id, change) in ids.iter().zip(&req.changes) {
            check_undo(&entries, id, change, &req.snapshot.account_id)?;
        }
    }
    let (s, changes, facts) = (req.snapshot.clone(), req.changes.clone(), req.facts.clone());
    let checked = tokio::task::spawn_blocking(move || preview_batch(&s, &changes, &facts))
        .await
        .map_err(|e| AppError::other(format!("미리보기를 계산하지 못했어요: {e}")))?;
    plan::check(req.seen.as_ref(), &BatchPlan::of(&req.snapshot.account_id, &checked))?;
    gate_batch(&checked, req.confirm_text.as_deref())?;
    Ok(checked)
}

pub async fn commit_batch<W, Fut>(req: BatchRequest, mut write: W) -> BatchCommitted
where
    W: FnMut(Vec<ApiCall>) -> Fut,
    Fut: Future<Output = Applied>,
{
    let checked = match prepare(&req).await {
        Err(refused) => return BatchCommitted { result: Err(refused), wrote: false },
        Ok(checked) => checked,
    };
    // 미리보기는 같은 `application_order`로 변경마다 항목 하나를 만든다: k번째 항목은 받은 순서의 `order[k]`번째 변경이다(되돌리기 짝을 옮기는 근거)
    let order = application_order(&req.changes);
    for (k, item) in checked.changes.iter().enumerate() {
        debug_assert_eq!(item.change, req.changes[order[k]]);
    }
    // 받은 순서의 되돌리기 짝을 적용 순서로 옮긴다
    let undo_of: Vec<Option<String>> = match &req.undo_of {
        Some(ids) => order.iter().map(|&i| Some(ids[i].clone())).collect(),
        None => vec![None; checked.changes.len()],
    };
    let (mut log_ids, mut notes, mut failed) = (Vec::new(), Vec::new(), None);
    for (index, item) in checked.changes.iter().enumerate() {
        let Applied { done, result } = write(item.calls.clone()).await;
        let id = format!("{}-{}", req.batch_id, index + 1);
        let ok = result.is_ok();
        let entry = ChangeLogEntry {
            id: id.clone(),
            at: iso(req.now),
            profile: req.profile.clone(),
            account_id: req.snapshot.account_id.clone(),
            caller_arn: req.snapshot.caller_arn.clone(),
            change: item.change.clone(),
            summary: item.summary.clone(),
            calls: done.iter().map(|call| call.api.clone()).collect(),
            ok,
            error: result.as_ref().err().map(|e| e.to_string()),
            inverse: if ok { item.inverse.clone() } else { None },
            undo_of: undo_of[index].clone(),
            undone: false,
            batch_id: Some(req.batch_id.clone()),
        };
        let recorded = record(req.log_path.clone(), entry, if ok { undo_of[index].clone() } else { None }).await;
        notes.extend(recorded.notes);
        match result {
            Ok(()) if recorded.appended => log_ids.push(id),
            Ok(()) => {
                // IAM은 바꿨는데 기록이 파일에 없다(그 id는 알리지 않는다). 어느 변경인지는 알림에 남긴다. 기록할 수 없는 쓰기는 더 하지 않는다:
                // 적용하지 않은 다음 변경을 멈춘 곳으로 알리고, 마지막 변경이었으면 알림(notes)만 남는다
                notes.push(format!("{}: {APPLIED_NOT_LOGGED}", item.summary));
                failed = checked.changes.get(index + 1).map(|next| BatchFailure { index: index + 1, summary: next.summary.clone(), message: LOG_NOT_SAVED.to_string() });
                break;
            }
            Err(e) => {
                failed = Some(BatchFailure { index, summary: item.summary.clone(), message: e.to_string() });
                break;
            }
        }
    }
    BatchCommitted { result: Ok(BatchResult { batch_id: req.batch_id, log_ids, failed, notes }), wrote: true }
}

#[cfg(test)]
mod tests;
