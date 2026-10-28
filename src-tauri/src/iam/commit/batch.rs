//! 묶음 적용: 다시 계산한 묶음 미리보기를 사용자가 본 계획과 견주고 관문을 지난 뒤, 적용 순서대로 변경마다 쓰고 기록한다.
//! 실패하면 거기서 멈춘다: 이미 적용된 변경은 그대로 두고(자동 되돌리기 없음) 결과에 실패한 위치를 알린다.

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
    // 받은 순서의 되돌리기 짝을 적용 순서로 옮긴다
    let undo_of: Vec<Option<String>> = match &req.undo_of {
        Some(ids) => application_order(&req.changes).into_iter().map(|i| Some(ids[i].clone())).collect(),
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
        notes.extend(record(req.log_path.clone(), entry, if ok { undo_of[index].clone() } else { None }).await);
        match result {
            Ok(()) => log_ids.push(id),
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
