use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use aws_sdk_s3::Client;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Semaphore;

use crate::adapters::util::map_concurrent;
use crate::aws::context::GLOBAL_REGION;
use crate::commands::AppState;
use crate::error::AppError;
use crate::explorer::diff::{assemble, DiffResult};
use crate::explorer::textfile::Content;
use crate::explorer::transfer::{self, ProgressSink};
use crate::explorer::{
    external, keys, local, s3ops, textfile, Direction, FileRef, LocalEntry, TransferEvent, TransferRequest,
    TransferStatus,
};

pub const TRANSFER_CONCURRENCY: usize = 3;
pub const PROGRESS_EVENT: &str = "transfer-progress";

pub struct ExplorerState {
    pub slots: Arc<Semaphore>,
}

impl Default for ExplorerState {
    fn default() -> Self {
        Self { slots: Arc::new(Semaphore::new(TRANSFER_CONCURRENCY)) }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RenameResult {
    Done,
    Conflict { target: String },
}

struct AppSink(AppHandle);

impl ProgressSink for AppSink {
    fn emit(&self, ev: TransferEvent) {
        let _ = self.0.emit(PROGRESS_EVENT, ev);
    }
}

fn region_or_default(region: &str) -> &str {
    if region.is_empty() { GLOBAL_REGION } else { region }
}

async fn s3_client(state: &AppState, profile: &str, region: &str) -> Result<Client, AppError> {
    let cfg = state.ctx.config(profile, region_or_default(region)).await?;
    Ok(Client::new(&cfg))
}

#[tauri::command]
pub fn local_home() -> String {
    local::home_dir()
}

#[tauri::command]
pub fn local_list(path: String) -> Result<Vec<LocalEntry>, AppError> {
    local::list_dir(Path::new(&path))
}

#[tauri::command]
pub fn plan_upload(
    local_paths: Vec<String>,
    bucket: String,
    region: String,
    prefix: String,
) -> Result<Vec<TransferRequest>, AppError> {
    let mut out = Vec::new();
    for selected in &local_paths {
        let selected = Path::new(selected);
        let base = selected.parent().unwrap_or(Path::new("/"));
        for file in local::expand_files(selected)? {
            out.push(TransferRequest {
                id: keys::new_transfer_id(out.len()),
                direction: Direction::Upload,
                local_path: file.to_string_lossy().into_owned(),
                bucket: bucket.clone(),
                region: region.clone(),
                key: keys::upload_key(&prefix, base, &file),
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn plan_download(
    state: State<'_, AppState>,
    profile: String,
    bucket: String,
    region: String,
    keys: Vec<String>,
    local_dir: String,
) -> Result<Vec<TransferRequest>, AppError> {
    let client = s3_client(&state, &profile, &region).await?;
    let dir = PathBuf::from(&local_dir);
    let mut out = Vec::new();
    for selected in &keys {
        let base = crate::explorer::keys::parent_prefix(selected).to_string();
        for (key, _) in s3ops::expand_keys(&client, &bucket, std::slice::from_ref(selected)).await? {
            if key.ends_with('/') {
                continue; // 폴더 표시 객체는 파일로 받지 않는다
            }
            let Some(path) = crate::explorer::keys::download_path(&dir, &base, &key) else { continue };
            out.push(TransferRequest {
                id: crate::explorer::keys::new_transfer_id(out.len()),
                direction: Direction::Download,
                local_path: path.to_string_lossy().into_owned(),
                bucket: bucket.clone(),
                region: region.clone(),
                key,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn find_conflicts(
    state: State<'_, AppState>,
    profile: String,
    requests: Vec<TransferRequest>,
) -> Result<Vec<String>, AppError> {
    let mut conflicts = Vec::new();
    let mut uploads = Vec::new();
    for r in requests {
        match r.direction {
            Direction::Download => {
                if Path::new(&r.local_path).exists() {
                    conflicts.push(r.id);
                }
            }
            Direction::Upload => uploads.push(r),
        }
    }
    if !uploads.is_empty() {
        // 요청마다 리전이 다를 수 있으니 리전별로 클라이언트를 하나씩 만든다.
        let mut clients: HashMap<String, Client> = HashMap::new();
        for r in &uploads {
            if !clients.contains_key(&r.region) {
                let client = s3_client(&state, &profile, &r.region).await?;
                clients.insert(r.region.clone(), client);
            }
        }
        let results = map_concurrent(uploads, |r| {
            let client = clients[&r.region].clone();
            async move { s3ops::exists(&client, &r.bucket, &r.key).await.map(|e| (r.id, e)) }
        })
        .await;
        for res in results {
            let (id, exists) = res?;
            if exists {
                conflicts.push(id);
            }
        }
    }
    Ok(conflicts)
}

#[tauri::command]
pub async fn start_transfers(app: AppHandle, profile: String, requests: Vec<TransferRequest>) -> Result<(), AppError> {
    let sink: Arc<dyn ProgressSink> = Arc::new(AppSink(app.clone()));
    for req in &requests {
        sink.emit(TransferEvent::new(&req.id, TransferStatus::Queued, 0, None));
    }
    for req in requests {
        let app = app.clone();
        let sink = sink.clone();
        let profile = profile.clone();
        tauri::async_runtime::spawn(async move {
            let slots = app.state::<ExplorerState>().slots.clone();
            let Ok(_permit) = slots.acquire_owned().await else { return };
            let cfg = match app.state::<AppState>().ctx.config(&profile, region_or_default(&req.region)).await {
                Ok(cfg) => cfg,
                Err(e) => {
                    sink.emit(TransferEvent::failed(&req.id, e));
                    return;
                }
            };
            transfer::run(cfg, req, sink).await;
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn s3_create_folder(
    state: State<'_, AppState>,
    profile: String,
    bucket: String,
    region: String,
    prefix: String,
    name: String,
) -> Result<(), AppError> {
    keys::validate_name(&name)?;
    let client = s3_client(&state, &profile, &region).await?;
    s3ops::create_folder(&client, &bucket, &keys::folder_key(&prefix, name.trim())).await
}

#[tauri::command]
pub async fn s3_rename(
    state: State<'_, AppState>,
    profile: String,
    bucket: String,
    region: String,
    from_key: String,
    new_name: String,
    overwrite: bool,
) -> Result<RenameResult, AppError> {
    keys::validate_name(&new_name)?;
    let target = keys::rename_target(&from_key, new_name.trim());
    if target == from_key {
        return Ok(RenameResult::Done);
    }
    let client = s3_client(&state, &profile, &region).await?;
    let taken = if target.ends_with('/') {
        s3ops::prefix_has_objects(&client, &bucket, &target).await?
    } else {
        s3ops::exists(&client, &bucket, &target).await?
    };
    if taken && !overwrite {
        return Ok(RenameResult::Conflict { target });
    }
    s3ops::rename(&client, &bucket, &from_key, &target).await?;
    Ok(RenameResult::Done)
}

#[tauri::command]
pub async fn s3_count_under(
    state: State<'_, AppState>,
    profile: String,
    bucket: String,
    region: String,
    keys: Vec<String>,
) -> Result<usize, AppError> {
    let client = s3_client(&state, &profile, &region).await?;
    Ok(s3ops::expand_keys(&client, &bucket, &keys).await?.len())
}

#[tauri::command]
pub async fn s3_delete(
    state: State<'_, AppState>,
    profile: String,
    bucket: String,
    region: String,
    keys: Vec<String>,
) -> Result<usize, AppError> {
    let client = s3_client(&state, &profile, &region).await?;
    let all = s3ops::expand_keys(&client, &bucket, &keys).await?;
    s3ops::delete_keys(&client, &bucket, all.into_iter().map(|(k, _)| k).collect()).await
}

async fn read_ref(state: &AppState, profile: &str, r: &FileRef) -> Result<(textfile::SideMeta, Content), AppError> {
    match r {
        FileRef::Local { path } => {
            let path = PathBuf::from(path);
            tauri::async_runtime::spawn_blocking(move || {
                let (mut meta, content) = textfile::read_local(&path)?;
                if !matches!(content, Content::Text(_)) {
                    meta.md5 = local::md5_file(&path).ok();
                }
                Ok((meta, content))
            })
            .await
            .map_err(|e| AppError::other(e.to_string()))?
        }
        FileRef::S3 { bucket, region, key } => {
            let client = s3_client(state, profile, region).await?;
            s3ops::read_side(&client, bucket, key).await
        }
    }
}

#[tauri::command]
pub async fn diff_files(
    state: State<'_, AppState>,
    profile: String,
    left: FileRef,
    right: FileRef,
) -> Result<DiffResult, AppError> {
    let (mut lm, lc) = read_ref(&state, &profile, &left).await?;
    let (mut rm, rc) = read_ref(&state, &profile, &right).await?;
    // 한쪽만 텍스트로 판정돼 md5가 비어 있으면 메타 비교를 위해 채운다.
    if !matches!(lc, Content::Text(_)) || !matches!(rc, Content::Text(_)) {
        for (meta, r) in [(&mut lm, &left), (&mut rm, &right)] {
            if meta.md5.is_none() {
                if let FileRef::Local { path } = r {
                    let p = PathBuf::from(path);
                    meta.md5 = tauri::async_runtime::spawn_blocking(move || local::md5_file(&p).ok())
                        .await
                        .map_err(|e| AppError::other(e.to_string()))?;
                }
            }
        }
    }
    Ok(assemble(lm, lc, rm, rc))
}

async fn materialize(state: &AppState, profile: &str, r: &FileRef) -> Result<String, AppError> {
    match r {
        FileRef::Local { path } => Ok(path.clone()),
        FileRef::S3 { bucket, region, key } => {
            let name = key.rsplit('/').next().filter(|n| !n.is_empty()).unwrap_or("object");
            let dest = external::temp_path(name);
            let client = s3_client(state, profile, region).await?;
            s3ops::download_to(&client, bucket, key, &dest).await?;
            Ok(dest.to_string_lossy().into_owned())
        }
    }
}

#[tauri::command]
pub async fn open_external_diff(
    state: State<'_, AppState>,
    profile: String,
    left: FileRef,
    right: FileRef,
    tool: String,
    command: Option<String>,
) -> Result<(), AppError> {
    external::sweep_stale();
    let l = materialize(&state, &profile, &left).await?;
    let r = match materialize(&state, &profile, &right).await {
        Ok(r) => r,
        Err(e) => {
            if matches!(left, FileRef::S3 { .. }) {
                external::remove_temp_copy(&l);
            }
            return Err(e);
        }
    };
    let (program, args) = external::command_for(&tool, command.as_deref(), &l, &r)?;
    external::spawn(&program, &args, &tool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_upload_expands_folders_with_relative_keys() {
        let dir = tempfile::tempdir().unwrap();
        let site = dir.path().join("site");
        std::fs::create_dir_all(site.join("css")).unwrap();
        std::fs::write(site.join("index.html"), "x").unwrap();
        std::fs::write(site.join("css/app.css"), "y").unwrap();
        let single = dir.path().join("note.txt");
        std::fs::write(&single, "z").unwrap();

        let reqs = plan_upload(
            vec![site.to_string_lossy().into_owned(), single.to_string_lossy().into_owned()],
            "b".into(),
            "r".into(),
            "web/".into(),
        )
        .unwrap();
        let keys: Vec<_> = reqs.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys, vec!["web/site/css/app.css", "web/site/index.html", "web/note.txt"]);
        assert!(reqs.iter().all(|r| r.direction == Direction::Upload && r.bucket == "b"));
        let ids: std::collections::HashSet<_> = reqs.iter().map(|r| r.id.clone()).collect();
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn rename_result_json_shape() {
        assert_eq!(serde_json::to_value(RenameResult::Done).unwrap(), serde_json::json!({ "kind": "done" }));
        assert_eq!(
            serde_json::to_value(RenameResult::Conflict { target: "a/b".into() }).unwrap(),
            serde_json::json!({ "kind": "conflict", "target": "a/b" })
        );
    }
}
