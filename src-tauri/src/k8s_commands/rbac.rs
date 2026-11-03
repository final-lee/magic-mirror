//! 권한 변경(K8 D)의 명령: 일괄(장바구니) 미리보기와 적용. 변경 하나는 공통 `k8s_preview`·`k8s_apply`가 `k8s::rbac`으로 처리한다.
//! 일괄은 변경들을 앞 변경이 적용된 상태에서 차례로 계획해 미리보기(항목별 호출·차이와 전체의 "누가 무엇을 얻고 잃는지")를 만들고,
//! 적용할 때는 먼저 전체를 다시 계획해 미리보기와 같은지 확인한 다음(다르면 아무것도 적용하지 않는다) 하나씩 적용하다 첫 실패에서 멈춘다.
use serde::Serialize;
use tauri::State;

use super::*;
use crate::k8s::rbac::assess::Effect;
use crate::k8s::rbac::commit::{self as rbac_commit, Ctx, ItemOutcome};

pub const BATCH_MISMATCH: &str = "변경과 확인 입력의 수가 맞지 않아요";

/// 읽고 보내는 데 필요한 연결(쿠버네티스 세션과 이 대상의 EKS 클라이언트)
pub(super) async fn context(app: &AppState, session: &Session, target: &K8sTarget) -> Result<Ctx, AppError> {
    let cfg = app.ctx.config(&target.profile, &target.region).await?;
    Ok(Ctx { client: session.client.clone(), endpoint: session.endpoint, eks: aws_sdk_eks::Client::new(&cfg), cluster: target.cluster.clone() })
}

/// 일괄 미리보기의 항목 하나. 계획하지 못한 변경은 `error`에 이유가 있다.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItemPreview {
    pub preview: Option<Preview>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPreview {
    pub items: Vec<BatchItemPreview>,
    /// 모든 변경을 적용한 뒤의 영향(누가 무엇을 얻고 잃는지)
    pub total: Option<Effect>,
}

/// 변경들을 차례로 미리보기한다. 모든 항목을 계획했으면 적용을 위해 그 계획을 기억한다.
#[tauri::command]
pub async fn k8s_preview_batch(app: State<'_, AppState>, k8s: State<'_, K8sState>, target: K8sTarget, changes: Vec<Change>) -> Result<BatchPreview, AppError> {
    let session = k8s.session(&target)?;
    let epoch = k8s.epoch(&target);
    let now = now_secs();
    let batch = rbac_commit::plan_batch(&context(&app, &session, &target).await?, &changes).await?;
    if k8s.epoch(&target) != epoch || !Arc::ptr_eq(&session, &k8s.session(&target)?) {
        return Err(AppError::other(NOT_OPENED));
    }
    let mut items = Vec::new();
    let mut plans = Vec::new();
    for item in batch.items {
        match item.plan {
            Ok(plan) => {
                items.push(BatchItemPreview { preview: Some(plan.preview.displayed()), error: None });
                plans.push(plan);
            }
            Err(error) => items.push(BatchItemPreview { preview: None, error: Some(error.to_string()) }),
        }
    }
    if plans.len() == changes.len() {
        locked(&k8s.batches).remember(&target.profile, &(&target, &changes), StoredBatch { plans, epoch, session }, now);
    }
    Ok(BatchPreview { items, total: batch.total })
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    Applied,
    Failed,
    Skipped,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchApplied {
    pub status: ItemStatus,
    pub log_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub items: Vec<BatchApplied>,
}

/// 변경 결과를 변경 기록에 한 줄 남기고 번호를 돌려준다. 되돌리기가 성공했으면 원래 기록에 되돌렸다고 적는다.
fn record(k8s: &K8sState, target: &K8sTarget, change: &Change, plan: &Plan, outcome: &Result<(), AppError>, undo_of: Option<&str>) -> Result<String, AppError> {
    let now = now_secs();
    let id = new_log_id(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let entry = log::Entry {
        id: id.clone(),
        at: iso(now),
        target: target.clone(),
        change: change.clone(),
        summary: plan.preview.impact.join(", "),
        ok: outcome.is_ok(),
        error: outcome.as_ref().err().map(ToString::to_string),
        inverse: if outcome.is_ok() { plan.inverse.clone() } else { None },
        undo_of: undo_of.map(str::to_string),
        undone: false,
        closed_at: None,
    };
    log::append(&k8s.log_path, &entry).map_err(|_| AppError::other(RECORD_FAILED))?;
    if let (true, Some(original)) = (outcome.is_ok(), undo_of) {
        log::mark_undone(&k8s.log_path, original).map_err(|_| AppError::other(UNDO_RECORD_FAILED))?;
    }
    Ok(id)
}

/// 되돌리기 항목이면 그 기록의 되돌릴 변경과 같은 변경인지 확인한다.
fn check_undo(k8s: &K8sState, target: &K8sTarget, change: &Change, undo_of: Option<&str>) -> Result<(), AppError> {
    let Some(id) = undo_of else { return Ok(()) };
    let undo = log::undo(&log::read_all(&k8s.log_path), id)?;
    if undo.target != *target || undo.change != *change {
        return Err(AppError::other(log::UNDO_UNAVAILABLE));
    }
    Ok(())
}

/// 미리보기한 변경들을 하나씩 적용한다. 첫 실패에서 멈추고 나머지는 건너뛴다(이미 적용한 것은 그대로 두고 기록에서 되돌릴 수 있다).
/// `confirm_texts`·`undo_of`는 변경과 같은 순서다(이름 입력이 필요 없거나 되돌리기가 아니면 None).
#[tauri::command]
pub async fn k8s_apply_batch(
    app: State<'_, AppState>,
    k8s: State<'_, K8sState>,
    target: K8sTarget,
    changes: Vec<Change>,
    confirm_texts: Vec<Option<String>>,
    undo_of: Vec<Option<String>>,
) -> Result<BatchResult, AppError> {
    if confirm_texts.len() != changes.len() || undo_of.len() != changes.len() {
        return Err(AppError::other(BATCH_MISMATCH));
    }
    let session = k8s.session(&target)?;
    let seen = locked(&k8s.batches).take(&target.profile, &(&target, &changes), now_secs()).ok_or_else(|| AppError::other(exec::STALE))?;
    if k8s.epoch(&target) != seen.epoch || !Arc::ptr_eq(&session, &seen.session) || seen.plans.len() != changes.len() {
        return Err(AppError::other(exec::STALE));
    }
    // 하나라도 확인이 모자라면 아무것도 적용하지 않는다
    for (i, change) in changes.iter().enumerate() {
        if seen.plans[i].preview.confirm_name.as_deref().is_some_and(|name| Some(name) != confirm_texts[i].as_deref()) {
            return Err(AppError::other(commit::CONFIRM_REQUIRED));
        }
        check_undo(&k8s, &target, change, undo_of[i].as_deref())?;
    }
    let ctx = context(&app, &session, &target).await?;
    rbac_commit::recheck_batch(&ctx, &changes, &seen.plans).await?;
    // 기록을 쓰지 못하면(적용은 됐는데 되돌릴 수 없다) 그 항목에서 멈추고 이유를 알린다
    let mut log_ids: Vec<Option<String>> = vec![None; changes.len()];
    let mut record_errors: Vec<Option<String>> = vec![None; changes.len()];
    let outcomes = rbac_commit::apply_items(&ctx, &changes, &seen.plans, |i, plan, outcome| match record(&k8s, &target, &changes[i], plan, outcome, undo_of[i].as_deref()) {
        Ok(id) => {
            log_ids[i] = Some(id);
            true
        }
        Err(error) => {
            record_errors[i] = Some(error.to_string());
            false
        }
    })
    .await;
    let items = outcomes
        .into_iter()
        .enumerate()
        .map(|(i, outcome)| {
            let (status, error) = match outcome {
                ItemOutcome::Applied => (ItemStatus::Applied, record_errors[i].take()),
                ItemOutcome::Failed(error) => (ItemStatus::Failed, Some(error.to_string())),
                ItemOutcome::Skipped => (ItemStatus::Skipped, None),
            };
            BatchApplied { status, log_id: log_ids[i].take(), error }
        })
        .collect();
    Ok(BatchResult { items })
}
