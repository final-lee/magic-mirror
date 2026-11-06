//! DynamoDB 변경 미리 보기, 실행과 기록.
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::commands::AppState;
use crate::dynamo::{change::{self, DynamoChange, DynamoPreview}, item_apply, item_change, ops, read};
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    undo_available: Option<bool>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    results: Option<Vec<item_apply::ItemResult>>,
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

fn item_call_summary(call: change::Call) -> String {
    fn collect(value: &serde_json::Value, names: &mut std::collections::BTreeSet<String>) {
        if let Some(object) = value.as_object() {
            for (key, value) in object {
                if matches!(key.as_str(), "item" | "key") {
                    if let Some(attributes) = value.as_object() {
                        names.extend(attributes.keys().cloned());
                    }
                } else if key == "expressionAttributeNames" {
                    if let Some(attributes) = value.as_object() {
                        names.extend(attributes.values().filter_map(|value| value.as_str().map(str::to_owned)));
                    }
                } else if key != "expressionAttributeValues" {
                    collect(value, names);
                }
            }
        } else if let Some(items) = value.as_array() {
            for item in items {
                collect(item, names);
            }
        }
    }
    let mut names = std::collections::BTreeSet::new();
    collect(&call.params, &mut names);
    if names.is_empty() {
        call.api
    } else {
        format!("{} ({})", call.api, names.into_iter().collect::<Vec<_>>().join(", "))
    }
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
        calls: preview.calls.into_iter().map(|call| {
            if item_change::is_item(change) { item_call_summary(call) } else { call.api }
        }).collect(),
        ok: result.is_ok(),
        error: result.as_ref().err().map(ToString::to_string),
        reversible: inverse.is_some(),
        undone: false,
        undo_of,
        undo_available: None,
        inverse,
        restored_table,
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
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
    apply_change(&cfg, &dynamo, profile, region, table, change, confirm_name, undo_of).await
}

#[allow(clippy::too_many_arguments)]
async fn apply_change(
    cfg: &aws_config::SdkConfig,
    dynamo: &DynamoState,
    profile: String,
    region: String,
    table: String,
    change: DynamoChange,
    confirm_name: Option<String>,
    undo_of: Option<String>,
) -> Result<ApplyResult, AppError> {
    let _guard = dynamo.change_lock.lock().await;
    let (preview, arn) = build_preview(cfg, &table, &change).await?;
    check_confirmation(&preview, confirm_name.as_deref())?;
    if let Some(id) = &undo_of {
        let found = jsonl::read_all::<ChangeLogEntry>(&dynamo.log_path)
            .into_iter()
            .find(|entry| &entry.id == id && entry.profile == profile
                && entry.region == region && entry.table == table && entry.ok && !entry.undone);
        if !found.is_some_and(|entry| {
            let inverse = if item_change::is_item(&change) {
                dynamo.undo_images.lock().ok().and_then(|images| images.get(&entry.id).cloned())
                    .and_then(|value| serde_json::from_value(value).ok())
            } else {
                entry.inverse
            };
            inverse.as_ref() == Some(&change)
        }) {
            return Err(AppError::other("되돌릴 수 없는 기록이거나 변경이 일치하지 않아요."));
        }
    }
    if item_change::is_item(&change) {
        let info = read::read_table(cfg, &table).await?;
        let results = item_apply::apply(cfg, &info, &change).await;
        let inverse = item_apply::inverse(&change, &results, preview.inverse.clone());
        let status = if results.iter().any(|result| result.ok) { Ok(inverse.clone()) }
            else { Err(AppError::other("아이템 변경에 실패했어요.")) };
        let partial = results.iter().any(|result| !result.ok);
        if partial {
            if let Some(id) = &undo_of {
                let failed: Vec<_> = results.iter().filter(|result| !result.ok).map(|result| result.item.clone()).collect();
                let remaining = match &change {
                    DynamoChange::DeleteItems { .. } => Some(DynamoChange::DeleteItems { items: failed }),
                    DynamoChange::RestoreItems { .. } => Some(DynamoChange::RestoreItems { items: failed }),
                    _ => None,
                };
                if let Some(remaining) = remaining {
                    let value = serde_json::to_value(remaining).map_err(|error| AppError::other(error.to_string()))?;
                    dynamo.undo_images.lock().map_err(|_| AppError::other("되돌리기 메모리를 사용할 수 없어요."))?.insert(id.clone(), value);
                }
            }
        }
        let mut entry = log_entry(profile, region, table, &change, preview, &status, if partial { None } else { undo_of });
        entry.inverse = None;
        entry.reversible = inverse.is_some();
        append_change(&dynamo.log_path, &entry)?;
        if let Some(inverse) = inverse {
            let image = serde_json::to_value(inverse).map_err(|error| AppError::other(error.to_string()))?;
            dynamo.undo_images.lock().map_err(|_| AppError::other("되돌리기 메모리를 사용할 수 없어요."))?.insert(entry.id, image);
        }
        return Ok(ApplyResult { message: "아이템 변경을 처리했어요.".into(), results: Some(results) });
    }
    let result = ops::apply(cfg, &table, &arn, &change).await;
    let entry = log_entry(profile, region, table, &change, preview, &result, undo_of);
    append_change(&dynamo.log_path, &entry)?;
    result?;
    Ok(ApplyResult { message: "변경을 요청했어요.".into(), results: None })
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
    if let Ok(images) = dynamo.undo_images.lock() {
        for row in &mut rows {
            if matches!(row.kind.as_str(), "putItem" | "updateItem" | "moveItem" | "deleteItems" | "restoreItems") {
                row.undo_available = Some(images.contains_key(&row.id));
            }
        }
    }
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
    let change = if entry.inverse.is_some() {
        entry.inverse
    } else {
        dynamo.undo_images.lock().ok().and_then(|images| images.get(&entry.id).cloned())
            .and_then(|value| serde_json::from_value(value).ok())
    }.ok_or_else(|| AppError::other("되돌릴 수 없음(이전 값이 남아 있지 않음)"))?;
    let cfg = state.ctx.config(&profile, &region).await?;
    let preview = build_preview(&cfg, &table, &change).await?.0;
    Ok((change, preview))
}

#[cfg(test)]
#[path = "dynamo/change/command_tests.rs"]
mod tests;
