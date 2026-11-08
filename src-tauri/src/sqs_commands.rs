//! SQS 탭의 명령. 읽기 명령은 AWS를 읽기만 하고, 쓰기(`sqs_apply`)는 `sqs::change`가 미리 보기를 다시 계산해 거른 뒤 보낸다.
//! 엿보기는 `ReceiveMessage`라 부작용이 있어서 변경(`receive`)으로 다룬다. 메시지 본문은 메모리의 엿보기 세션에만 있다.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands::AppState;
use crate::error::AppError;
use crate::iam::clock::{iso, now_secs};
use crate::iam::commit::new_log_id;
use crate::iam_commands::{self, IamState};
use crate::sqs::change::{self, now_ms};
use crate::sqs::health::health;
use crate::sqs::peek::{self, PeekStore};
use crate::sqs::read;
use crate::sqs::{activity, flow, log};
use crate::sqs::{SqsActivity, SqsApplyResult, SqsChange, SqsChangeRecord, SqsFlow, SqsMoveTask, SqsOverview, SqsPeekable, SqsPreview, SqsQueue, SqsRegionFlow};

/// 활동(CloudWatch)을 다시 읽지 않고 쓰는 시간(ms)
const ACTIVITY_TTL_MS: i64 = 5 * 60 * 1000;
/// 저장 파일의 크기 한도
const MAX_SAVE_BYTES: usize = 256 * 1024 * 1024;

type Key = (String, String);
/// 큐 이름 → 활동
type ActivityByName = HashMap<String, SqsActivity>;

pub struct SqsState {
    log_path: PathBuf,
    /// (프로필, 리전) → (읽은 시각 ms, 큐 이름 → 활동)
    activity: Mutex<HashMap<Key, (i64, ActivityByName)>>,
    /// (프로필, 리전) → 마지막 목록(`sqs_queue`·흐름의 이웃 진단용)
    queues: Mutex<HashMap<Key, Vec<SqsQueue>>>,
    peeks: PeekStore,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl SqsState {
    pub fn new(log_path: PathBuf) -> SqsState {
        SqsState { log_path, activity: Mutex::default(), queues: Mutex::default(), peeks: PeekStore::default() }
    }

    fn peers(&self, key: &Key) -> Vec<SqsQueue> {
        locked(&self.queues).get(key).cloned().unwrap_or_default()
    }

    fn cached_activity(&self, key: &Key, queue_name: &str) -> Option<SqsActivity> {
        locked(&self.activity).get(key).and_then(|(_, m)| m.get(queue_name).copied())
    }
}

fn key(profile: &str, region: &str) -> Key {
    (profile.to_string(), region.to_string())
}

/// 캐시가 5분 안이고 모든 큐를 담고 있으면 그것을 쓴다(force가 아닐 때)
fn fresh_activity(state: &SqsState, key: &Key, names: &[&str], force: bool, now: i64) -> Option<(i64, ActivityByName)> {
    if force {
        return None;
    }
    let cache = locked(&state.activity);
    let (at, map) = cache.get(key)?;
    (now - at < ACTIVITY_TTL_MS && names.iter().all(|n| map.contains_key(*n))).then(|| (*at, map.clone()))
}

#[tauri::command]
pub async fn sqs_overview(state: State<'_, AppState>, sqs: State<'_, SqsState>, profile: String, region: String, force: bool) -> Result<SqsOverview, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    let list = read::list_queues(&cfg).await?;
    let truncated = list.truncated;
    let mut queues: Vec<SqsQueue> = list.items.into_iter().map(|r| r.queue).collect();
    read::link_sources(&mut queues);
    if truncated {
        read::supplement_sources(&cfg, &mut queues).await;
    }

    let k = key(&profile, &region);
    let now = now_ms();
    let names: Vec<String> = queues.iter().filter(|q| q.error.is_none()).map(|q| q.name.clone()).collect();
    let name_refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let (activity_at, activity_error, by_name) = match fresh_activity(&sqs, &k, &name_refs, force, now) {
        Some((at, map)) => (Some(at), None, map),
        None => match activity::read(&cfg, &names, now / 1000).await {
            Ok(map) => {
                locked(&sqs.activity).insert(k.clone(), (now, map.clone()));
                (Some(now), None, map)
            }
            Err(e) => (None, Some(e.to_string()), HashMap::new()),
        },
    };
    for q in &mut queues {
        q.activity = by_name.get(&q.name).copied();
    }
    let findings: Vec<_> = queues.iter().map(|q| health(q, &queues)).collect();
    for (q, f) in queues.iter_mut().zip(findings) {
        q.findings = f;
    }
    locked(&sqs.queues).insert(k, queues.clone());
    Ok(SqsOverview { queues, truncated, activity_at, activity_error })
}

#[tauri::command]
pub async fn sqs_queue(state: State<'_, AppState>, sqs: State<'_, SqsState>, profile: String, region: String, url: String) -> Result<SqsQueue, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    let mut q = read::read_queue(&cfg, &url, true).await?;
    let k = key(&profile, &region);
    q.activity = sqs.cached_activity(&k, &q.name);
    q.findings = health(&q, &sqs.peers(&k));
    Ok(q)
}

#[tauri::command]
pub async fn sqs_flow(state: State<'_, AppState>, iam: State<'_, IamState>, sqs: State<'_, SqsState>, profile: String, region: String, url: String, with_iam: bool) -> Result<SqsFlow, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    let q = read::read_queue(&cfg, &url, false).await?;
    let peers = sqs.peers(&key(&profile, &region));
    let snapshot = if with_iam { Some(iam_commands::snapshot(&state, &iam, &profile, false).await) } else { None };
    Ok(flow::read_flow(&cfg, &q, &peers, snapshot).await)
}

#[tauri::command]
pub async fn sqs_region_flow(state: State<'_, AppState>, sqs: State<'_, SqsState>, profile: String, region: String) -> Result<SqsRegionFlow, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    let mut queues = sqs.peers(&key(&profile, &region));
    if queues.is_empty() {
        queues = read::list_queues(&cfg).await?.items.into_iter().map(|r| r.queue).collect();
        read::link_sources(&mut queues);
    }
    Ok(flow::region_flow(&cfg, &region, &queues).await)
}

#[tauri::command]
pub async fn sqs_peekable(state: State<'_, AppState>, profile: String, region: String, url: String) -> Result<SqsPeekable, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    let q = read::read_queue(&cfg, &url, false).await?;
    Ok(match peek::gate(&cfg, &q, now_secs()).await {
        Ok(()) => SqsPeekable { allowed: true, reason: None },
        Err(reason) => SqsPeekable { allowed: false, reason: Some(reason) },
    })
}

#[tauri::command]
pub async fn sqs_preview(state: State<'_, AppState>, sqs: State<'_, SqsState>, profile: String, region: String, url: String, change: SqsChange) -> Result<SqsPreview, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    change::preview_change(&cfg, &sqs.peeks, &profile, &region, &url, &change).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sqs_apply(
    state: State<'_, AppState>,
    sqs: State<'_, SqsState>,
    profile: String,
    region: String,
    url: String,
    change: SqsChange,
    expected_version: Option<String>,
    confirm_name: Option<String>,
) -> Result<SqsApplyResult, AppError> {
    // 지금 쓰는 변경 가운데 미리 본 뒤의 큐 변화를 따지는 것은 없다(속성·정책을 바꾸는 변경이 생기면 여기서 `expected_version`을 비교한다)
    let _ = expected_version;
    let cfg = state.ctx.config(&profile, &region).await?;
    let applied = change::apply(&cfg, &sqs.peeks, &profile, &region, &url, &change, confirm_name.as_deref()).await?;
    let now = now_ms();
    let (ok, error, count) = match &applied.outcome {
        Ok(d) => (true, None, d.count),
        Err(e) => (false, Some(e.to_string()), None),
    };
    let record = SqsChangeRecord {
        id: new_log_id(now as u128),
        at: iso(now / 1000),
        profile,
        region,
        queue_url: url,
        queue_name: applied.queue.name.clone(),
        kind: change.kind().to_string(),
        summary: applied.preview.title.clone(),
        calls: applied.preview.calls.clone(),
        ok,
        error,
        count,
    };
    // 기록을 못 남겨도 이미 보낸 변경의 결과는 알려야 한다
    let _ = log::append(&sqs.log_path, &record);
    applied.outcome.map(|d| d.result)
}

#[tauri::command]
pub async fn sqs_release(state: State<'_, AppState>, sqs: State<'_, SqsState>, profile: String, peek_id: String) -> Result<(), AppError> {
    sqs.peeks.sweep(now_ms());
    let Some(session) = sqs.peeks.take(&peek_id, &profile) else { return Ok(()) };
    if session.expires_at <= now_ms() || session.held.is_empty() {
        return Ok(());
    }
    let cfg = state.ctx.config(&profile, &session.region).await?;
    let receipts: Vec<String> = session.held.values().map(|h| h.receipt.clone()).collect();
    peek::release_receipts(&aws_sdk_sqs::Client::new(&cfg), &session.url, &receipts).await
}

#[tauri::command]
pub async fn sqs_move_tasks(state: State<'_, AppState>, profile: String, region: String, url: String) -> Result<Vec<SqsMoveTask>, AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    change::move_tasks(&cfg, &read::arn_from_url(&url, &region)).await
}

#[tauri::command]
pub fn sqs_changes(sqs: State<'_, SqsState>, profile: String, region: String) -> Vec<SqsChangeRecord> {
    log::read(&sqs.log_path, &profile, &region)
}

fn with_jsonl_extension(mut name: String) -> String {
    if !name.to_ascii_lowercase().ends_with(".jsonl") {
        name.push_str(".jsonl");
    }
    name
}

/// 네이티브 저장 대화상자를 Rust에서 띄우고, 사용자가 고른 경로에만 쓴다. 저장한 경로를 돌려주고 취소하면 None.
#[tauri::command]
pub async fn sqs_save_jsonl(app: AppHandle, file_name: String, text: String) -> Result<Option<String>, AppError> {
    if text.len() > MAX_SAVE_BYTES {
        return Err(AppError::other("파일이 너무 커요"));
    }
    let picked = tokio::task::spawn_blocking(move || app.dialog().file().set_file_name(file_name).add_filter("JSON Lines", &["jsonl"]).blocking_save_file())
        .await
        .map_err(|e| AppError::other(e.to_string()))?;
    let Some(picked) = picked else { return Ok(None) };
    let mut path = picked.into_path().map_err(|e| AppError::other(e.to_string()))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    path.set_file_name(with_jsonl_extension(name));
    tokio::fs::write(&path, text.as_bytes()).await.map_err(|e| AppError::other(format!("파일을 저장하지 못했어요: {e}")))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests;
