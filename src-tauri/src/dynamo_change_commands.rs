//! DynamoDB 변경 미리 보기, 실행과 기록.
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::commands::AppState;
use crate::dynamo::{change::{self, DynamoChange, DynamoPreview}, ops, read};
use crate::dynamo_commands::DynamoState;
use crate::error::{from_sdk, AppError};
use crate::iam::clock::{iso, now_secs};
use crate::jsonl;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeLogEntry {
    id: String, at: String, profile: String, region: String, table: String, kind: String, summary: String,
    calls: Vec<String>, ok: bool, error: Option<String>, reversible: bool, undone: bool, undo_of: Option<String>, inverse: Option<DynamoChange>,
    #[serde(default)]
    restored_table: Option<String>,
}
fn new_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!("{:x}-{:x}-{:x}", now_secs(), NEXT.fetch_add(1, Ordering::Relaxed), RandomState::new().build_hasher().finish())
}
async fn build_preview(cfg: &aws_config::SdkConfig, table: &str, change: &DynamoChange) -> Result<(DynamoPreview, String), AppError> {
    let info = read::read_table(cfg, table).await?;
    if let Some(error) = &info.error { return Err(AppError::other(error.clone())); }
    if let DynamoChange::DeleteBackup { arn } | DynamoChange::RestoreBackup { arn, .. } = change {
        if !arn.starts_with(&format!("{}/backup/", info.arn)) {
            return Err(AppError::other("이 테이블에 속한 백업만 사용할 수 있어요."));
        }
    }
    if let DynamoChange::ExportS3 { bucket, .. } = change {
        let s3 = aws_sdk_s3::Client::new(cfg);
        let mut token = None;
        let mut found = false;
        loop {
            let page = s3.list_buckets().set_continuation_token(token).send().await.map_err(|e| from_sdk(e, "s3:ListAllMyBuckets"))?;
            found |= page.buckets().iter().any(|b| b.name() == Some(bucket.as_str()));
            token = page.continuation_token().map(str::to_owned);
            if found || token.is_none() { break; }
        }
        if !found { return Err(AppError::other("같은 계정의 S3 버킷을 선택해 주세요.")); }
    }
    let mut consumers = Vec::new();
    let mut has_more = false;
    if matches!(change, DynamoChange::Stream { enabled:false, .. }) {
        if let Some(stream) = &info.stream {
            let out = aws_sdk_lambda::Client::new(cfg).list_event_source_mappings().event_source_arn(&stream.arn).max_items(25).send().await.map_err(|e| from_sdk(e,"lambda:ListEventSourceMappings"))?;
            consumers.extend(out.event_source_mappings().iter().map(|m| m.function_arn().unwrap_or("Lambda").to_owned()));
            has_more = out.next_marker().is_some();
        }
    }
    let mut result = change::preview(&info, change, !consumers.is_empty() || has_more);
    if !consumers.is_empty() { result.impact.push(format!("연결된 Lambda 소비자: {}{}", consumers.join(", "), if has_more { " 외" } else { "" })); }
    Ok((result, info.arn))
}
#[tauri::command]
pub async fn dynamo_preview(state: State<'_, AppState>, profile: String, region: String, table: String, change: DynamoChange) -> Result<DynamoPreview, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    Ok(build_preview(&cfg, &table, &change).await?.0)
}
#[derive(Serialize)]
pub struct ApplyResult { message: String }
#[tauri::command]
pub async fn dynamo_apply(state: State<'_, AppState>, dynamo: State<'_, DynamoState>, profile: String, region: String, table: String, change: DynamoChange, confirm_name: Option<String>, undo_of: Option<String>) -> Result<ApplyResult, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    let _guard = dynamo.change_lock.lock().await;
    let (p, arn) = build_preview(&cfg, &table, &change).await?;
    if let Some(reason) = &p.blocked { return Err(AppError::other(reason)); }
    if p.confirm_name.as_deref().is_some_and(|name| confirm_name.as_deref() != Some(name)) { return Err(AppError::other("확인할 테이블 이름이 일치하지 않아요.")); }
    if let Some(id) = &undo_of {
        let found = jsonl::read_all::<ChangeLogEntry>(&dynamo.log_path).into_iter().find(|e| &e.id == id && e.profile == profile && e.region == region && e.table == table && e.ok && !e.undone);
        if !found.is_some_and(|e| e.inverse.as_ref() == Some(&change)) { return Err(AppError::other("되돌릴 수 없는 기록이거나 변경이 일치하지 않아요.")); }
    }
    let result = ops::apply(&cfg, &table, &arn, &change).await;
    let inverse = result.as_ref().ok().and_then(|extra| extra.clone().or_else(|| p.inverse.clone()));
    let kind = serde_json::to_value(&change).ok().and_then(|v| v.get("kind").and_then(|s| s.as_str()).map(str::to_owned)).unwrap_or_default();
    let restored_table = match &change { DynamoChange::RestoreBackup { target, .. } | DynamoChange::RestorePitr { target, .. } => Some(target.clone()), _ => None };
    let entry = ChangeLogEntry { id:new_id(), at:iso(now_secs()), profile, region, table, kind, summary:p.title, calls:p.calls.into_iter().map(|c| c.api).collect(), ok:result.is_ok(), error:result.as_ref().err().map(ToString::to_string), reversible:inverse.is_some(), undone:false, undo_of:undo_of.clone(), inverse, restored_table };
    jsonl::append(&dynamo.log_path, &entry).map_err(|e| AppError::other(format!("변경 기록을 저장하지 못했어요: {e}")))?;
    if result.is_ok() { if let Some(id) = undo_of { jsonl::update(&dynamo.log_path, |e: &ChangeLogEntry| e.id == id, |e| e.undone = true).map_err(|e| AppError::other(format!("되돌림 표시를 저장하지 못했어요: {e}")))?; } }
    result?;
    Ok(ApplyResult { message:"변경을 요청했어요.".into() })
}
#[tauri::command]
pub fn dynamo_changes(dynamo: State<'_, DynamoState>, profile: String, region: String, table: String) -> Vec<ChangeLogEntry> {
    let mut rows: Vec<_> = jsonl::read_all::<ChangeLogEntry>(&dynamo.log_path).into_iter().filter(|e| e.profile == profile && e.region == region && e.table == table).collect();
    rows.reverse(); rows
}
#[tauri::command]
pub async fn dynamo_undo_preview(state: State<'_, AppState>, dynamo: State<'_, DynamoState>, profile: String, region: String, table: String, id: String) -> Result<(DynamoChange, DynamoPreview), AppError> {
    let entry = jsonl::read_all::<ChangeLogEntry>(&dynamo.log_path).into_iter().find(|e| e.id == id && e.profile == profile && e.region == region && e.table == table && e.ok && !e.undone).ok_or_else(|| AppError::other("되돌릴 수 있는 기록이 없어요."))?;
    let change = entry.inverse.ok_or_else(|| AppError::other("되돌릴 값이 남아 있지 않아요."))?;
    let cfg = state.ctx.config(&profile, &region).await?;
    let preview = build_preview(&cfg, &table, &change).await?.0;
    Ok((change, preview))
}
