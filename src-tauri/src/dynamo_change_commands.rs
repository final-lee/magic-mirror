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
    id: String,
    at: String,
    profile: String,
    region: String,
    table: String,
    kind: String,
    summary: String,
    calls: Vec<String>,
    ok: bool,
    error: Option<String>,
    reversible: bool,
    undone: bool,
    undo_of: Option<String>,
    inverse: Option<DynamoChange>,
    #[serde(default)]
    restored_table: Option<String>,
}
fn new_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "{:x}-{:x}-{:x}",
        now_secs(),
        NEXT.fetch_add(1, Ordering::Relaxed),
        RandomState::new().build_hasher().finish(),
    )
}

async fn build_preview(
    cfg: &aws_config::SdkConfig,
    table: &str,
    change: &DynamoChange,
) -> Result<(DynamoPreview, String), AppError> {
    let info = read::read_table(cfg, table).await?;
    if let Some(error) = &info.error {
        return Err(AppError::other(error.clone()));
    }
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
            let page = s3.list_buckets().set_continuation_token(token).send().await
                .map_err(|error| from_sdk(error, "s3:ListAllMyBuckets"))?;
            found |= page.buckets().iter().any(|item| item.name() == Some(bucket.as_str()));
            token = page.continuation_token().map(str::to_owned);
            if found || token.is_none() {
                break;
            }
        }
        if !found {
            return Err(AppError::other("같은 계정의 S3 버킷을 선택해 주세요."));
        }
    }
    let mut consumers = Vec::new();
    let mut has_more = false;
    if matches!(change, DynamoChange::Stream { enabled: false, .. }) {
        if let Some(stream) = &info.stream {
            let output = aws_sdk_lambda::Client::new(cfg)
                .list_event_source_mappings()
                .event_source_arn(&stream.arn)
                .max_items(25)
                .send().await
                .map_err(|error| from_sdk(error, "lambda:ListEventSourceMappings"))?;
            consumers.extend(output.event_source_mappings().iter()
                .map(|mapping| mapping.function_arn().unwrap_or("Lambda").to_owned()));
            has_more = output.next_marker().is_some();
        }
    }
    let mut result = change::preview(&info, change, !consumers.is_empty() || has_more);
    if !consumers.is_empty() {
        let suffix = if has_more { " 외" } else { "" };
        result.impact.push(format!("연결된 Lambda 소비자: {}{}", consumers.join(", "), suffix));
    }
    Ok((result, info.arn))
}
#[tauri::command]
pub async fn dynamo_preview(
    state: State<'_, AppState>,
    profile: String,
    region: String,
    table: String,
    change: DynamoChange,
) -> Result<DynamoPreview, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    Ok(build_preview(&cfg, &table, &change).await?.0)
}
#[derive(Serialize)]
pub struct ApplyResult {
    message: String,
}
fn check_confirmation(
    preview: &DynamoPreview,
    confirm_name: Option<&str>,
) -> Result<(), AppError> {
    if let Some(reason) = &preview.blocked {
        return Err(AppError::other(reason));
    }
    if preview.confirm_name.as_deref().is_some_and(|name| confirm_name != Some(name)) {
        return Err(AppError::other("확인할 테이블 이름이 일치하지 않아요."));
    }
    Ok(())
}

fn append_change(
    path: &std::path::Path,
    entry: &ChangeLogEntry,
) -> Result<(), AppError> {
    jsonl::append(path, entry)
        .map_err(|error| AppError::other(format!("변경 기록을 저장하지 못했어요: {error}")))?;
    if entry.ok {
        if let Some(id) = &entry.undo_of {
            jsonl::update(path, |row: &ChangeLogEntry| row.id == *id, |row| row.undone = true)
                .map_err(|error| AppError::other(format!("되돌림 표시를 저장하지 못했어요: {error}")))?;
        }
    }
    Ok(())
}

fn log_entry(
    profile: String,
    region: String,
    table: String,
    change: &DynamoChange,
    preview: DynamoPreview,
    result: &Result<Option<DynamoChange>, AppError>,
    undo_of: Option<String>,
) -> ChangeLogEntry {
    let inverse = result.as_ref().ok()
        .and_then(|extra| extra.clone().or_else(|| preview.inverse.clone()));
    let kind = serde_json::to_value(change).ok()
        .and_then(|value| value.get("kind").and_then(|kind| kind.as_str()).map(str::to_owned))
        .unwrap_or_default();
    let restored_table = match change {
        DynamoChange::RestoreBackup { target, .. } | DynamoChange::RestorePitr { target, .. } => {
            Some(target.clone())
        }
        _ => None,
    };
    ChangeLogEntry {
        id: new_id(),
        at: iso(now_secs()),
        profile,
        region,
        table,
        kind,
        summary: preview.title,
        calls: preview.calls.into_iter().map(|call| call.api).collect(),
        ok: result.is_ok(),
        error: result.as_ref().err().map(ToString::to_string),
        reversible: inverse.is_some(),
        undone: false,
        undo_of,
        inverse,
        restored_table,
    }
}

#[tauri::command]
pub async fn dynamo_apply(
    state: State<'_, AppState>,
    dynamo: State<'_, DynamoState>,
    profile: String,
    region: String,
    table: String,
    change: DynamoChange,
    confirm_name: Option<String>,
    undo_of: Option<String>,
) -> Result<ApplyResult, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    let _guard = dynamo.change_lock.lock().await;
    let (preview, arn) = build_preview(&cfg, &table, &change).await?;
    check_confirmation(&preview, confirm_name.as_deref())?;
    if let Some(id) = &undo_of {
        let found = jsonl::read_all::<ChangeLogEntry>(&dynamo.log_path)
            .into_iter()
            .find(|entry| &entry.id == id && entry.profile == profile
                && entry.region == region && entry.table == table && entry.ok && !entry.undone);
        if !found.is_some_and(|entry| entry.inverse.as_ref() == Some(&change)) {
            return Err(AppError::other("되돌릴 수 없는 기록이거나 변경이 일치하지 않아요."));
        }
    }
    let result = ops::apply(&cfg, &table, &arn, &change).await;
    let entry = log_entry(profile, region, table, &change, preview, &result, undo_of);
    append_change(&dynamo.log_path, &entry)?;
    result?;
    Ok(ApplyResult { message: "변경을 요청했어요.".into() })
}
#[tauri::command]
pub fn dynamo_changes(
    dynamo: State<'_, DynamoState>,
    profile: String,
    region: String,
    table: String,
) -> Vec<ChangeLogEntry> {
    let mut rows: Vec<_> = jsonl::read_all::<ChangeLogEntry>(&dynamo.log_path)
        .into_iter()
        .filter(|entry| entry.profile == profile && entry.region == region && entry.table == table)
        .collect();
    rows.reverse();
    rows
}
#[tauri::command]
pub async fn dynamo_undo_preview(
    state: State<'_, AppState>,
    dynamo: State<'_, DynamoState>,
    profile: String,
    region: String,
    table: String,
    id: String,
) -> Result<(DynamoChange, DynamoPreview), AppError> {
    let entry = jsonl::read_all::<ChangeLogEntry>(&dynamo.log_path)
        .into_iter()
        .find(|entry| entry.id == id && entry.profile == profile && entry.region == region
            && entry.table == table && entry.ok && !entry.undone)
        .ok_or_else(|| AppError::other("되돌릴 수 있는 기록이 없어요."))?;
    let change = entry.inverse.ok_or_else(|| AppError::other("되돌릴 값이 남아 있지 않아요."))?;
    let cfg = state.ctx.config(&profile, &region).await?;
    let preview = build_preview(&cfg, &table, &change).await?.0;
    Ok((change, preview))
}

#[cfg(test)]
#[path = "dynamo/change/command_tests.rs"]
mod tests;
