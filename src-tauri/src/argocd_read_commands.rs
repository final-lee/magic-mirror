//! ArgoCD 읽기 명령: 리소스 상세·이벤트·링크, 앱 diff, 이력과 리비전 비교, sync window, 로그 스트림.
use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{ipc::Channel, Manager, State};

use crate::argocd::diff::{self, AppDiffRow, Wave};
use crate::argocd::history::{self, HistoryEntry};
use crate::argocd::logs::{self, LogOptions};
use crate::argocd::resource::{self, AppTarget, ContainerRef, LinkRow, ResRef, ResourceEvent};
use crate::argocd::window::{self, SyncWindows};
use crate::argocd::ArgocdState;
use crate::error::AppError;
use crate::explorer::diff::TextDiff;

const MANIFESTS_FAILED: &str = "리비전의 매니페스트를 읽지 못했어요";

/// 리소스 상세 한 화면 분량: live와 desired YAML, 둘의 diff, 로그를 고를 컨테이너.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceView {
    /// 클러스터에 없으면(삭제됐거나 아직 만들어지지 않음) None
    pub live: Option<String>,
    /// Application의 목표 상태에 없으면 None
    pub desired: Option<String>,
    /// 목표 상태가 있을 때만(정규화된 live와 적용 뒤 예상 상태의 비교)
    pub diff: Option<TextDiff>,
    pub containers: Vec<ContainerRef>,
}

fn app_path<'a>(name: &'a str, tail: &[&'a str]) -> Vec<&'a str> {
    let mut path = vec!["api", "v1", "applications", name];
    path.extend_from_slice(tail);
    path
}

fn as_refs<'a>(pairs: &'a [(&'a str, String)]) -> Vec<(&'a str, &'a str)> {
    pairs.iter().map(|(k, v)| (*k, v.as_str())).collect()
}

fn manifest_of(body: &Value) -> Result<Value, AppError> {
    let raw = body.pointer("/manifest").and_then(Value::as_str).ok_or_else(|| AppError::other(diff::YAML_UNREADABLE))?;
    serde_json::from_str(raw).map_err(|_| AppError::other(diff::YAML_UNREADABLE))
}

#[tauri::command]
/// 리소스의 live·desired YAML과 diff.
pub async fn argocd_resource(state: State<'_, ArgocdState>, url: String, target: AppTarget, res: ResRef) -> Result<ResourceView, AppError> {
    let live_query = resource::resource_query(&target, &res, "resourceName");
    let mut managed_query = resource::resource_query(&target, &res, "name");
    managed_query.retain(|(key, _)| *key != "version");
    let (live_path, managed_path) = (app_path(&target.name, &["resource"]), app_path(&target.name, &["managed-resources"]));
    let (live, managed) = tokio::join!(
        state.api_optional(&url, Method::GET, &live_path, &live_query, None),
        state.api(&url, Method::GET, &managed_path, &managed_query, None),
    );
    let managed = managed?;
    let item = diff::find_item(&managed, &res);
    let desired = item.map(diff::desired_yaml).transpose()?.flatten();
    let compared = item.filter(|_| desired.is_some()).map(diff::managed_diff).transpose()?;
    let live = live?.as_ref().map(manifest_of).transpose()?;
    let containers = live.as_ref().map(resource::containers_of).unwrap_or_default();
    Ok(ResourceView {
        live: live.map(diff::display_yaml).transpose()?,
        desired,
        diff: compared.map(|d| d.diff),
        containers,
    })
}

#[tauri::command]
/// 리소스의 Kubernetes 이벤트(최근 것부터).
pub async fn argocd_resource_events(state: State<'_, ArgocdState>, url: String, target: AppTarget, res: ResRef) -> Result<Vec<ResourceEvent>, AppError> {
    let mut query = vec![("resourceNamespace", res.namespace.as_deref().unwrap_or_default()), ("resourceName", res.name.as_str())];
    if let Some(uid) = res.uid.as_deref().filter(|u| !u.is_empty()) {
        query.push(("resourceUID", uid));
    }
    query.extend(target.scope());
    let body = state.api(&url, Method::GET, &app_path(&target.name, &["events"]), &query, None).await?;
    Ok(resource::event_rows(&body))
}

#[tauri::command]
/// 서버가 설정한 리소스 링크.
pub async fn argocd_resource_links(state: State<'_, ArgocdState>, url: String, target: AppTarget, res: ResRef) -> Result<Vec<LinkRow>, AppError> {
    let query = resource::resource_query(&target, &res, "resourceName");
    let body = state.api(&url, Method::GET, &app_path(&target.name, &["resource", "links"]), &query, None).await?;
    Ok(resource::link_rows(&body))
}

#[tauri::command]
/// 서버가 설정한 앱 링크.
pub async fn argocd_app_links(state: State<'_, ArgocdState>, url: String, namespace: String, name: String) -> Result<Vec<LinkRow>, AppError> {
    let body = state.api(&url, Method::GET, &app_path(&name, &["links"]), &[("namespace", &namespace)], None).await?;
    Ok(resource::link_rows(&body))
}

#[tauri::command]
/// 앱이 관리하는 모든 리소스의 live와 목표 비교.
pub async fn argocd_app_diff(state: State<'_, ArgocdState>, url: String, namespace: String, name: String) -> Result<Vec<AppDiffRow>, AppError> {
    let scope = [("appNamespace", namespace.as_str())];
    let (managed_path, app_only) = (app_path(&name, &["managed-resources"]), app_path(&name, &[]));
    let (managed, app) = tokio::join!(
        state.api(&url, Method::GET, &managed_path, &scope, None),
        state.api(&url, Method::GET, &app_only, &scope, None),
    );
    let (managed, app) = (managed?, app?);
    // 리소스가 많으면 YAML 변환과 줄 비교가 오래 걸려 비동기 작업을 막지 않게 따로 돌린다
    tokio::task::spawn_blocking(move || diff::app_diff(&managed, &app))
        .await
        .map_err(|_| AppError::other(diff::YAML_UNREADABLE))?
}

#[tauri::command]
/// 배포 이력 전체와 리비전별 메타데이터(커밋·차트·OCI). 메타데이터를 받지 못한 리비전은 비워 둔다.
pub async fn argocd_history(state: State<'_, ArgocdState>, url: String, namespace: String, name: String) -> Result<Vec<HistoryEntry>, AppError> {
    let state: &ArgocdState = &state;
    let app = state
        .api(&url, Method::GET, &["api", "v1", "applications", &name], &[("appNamespace", &namespace)], None)
        .await?;
    let mut entries = history::entries_of(&app);
    history::attach(&mut entries, |job| {
        let (url, namespace, name) = (&url, &namespace, &name);
        async move {
            let (index, version) = (job.source_index.to_string(), job.version_id.to_string());
            let query = [("appNamespace", namespace.as_str()), ("sourceIndex", index.as_str()), ("versionId", version.as_str())];
            state
                .api(
                    url,
                    Method::GET,
                    &["api", "v1", "applications", name, "revisions", &job.revision_id, job.kind.segment()],
                    &query,
                    None,
                )
                .await
        }
    })
    .await;
    Ok(entries)
}

/// 리비전(여러 소스면 소스마다 하나씩)의 렌더 결과. 비어 있으면 앱이 지금 가리키는 리비전.
async fn manifests(state: &ArgocdState, url: &str, namespace: &str, name: &str, revisions: &[String]) -> Result<Value, AppError> {
    let mut query = vec![("appNamespace", namespace.to_owned())];
    match revisions {
        [] => {}
        [one] => query.push(("revision", one.clone())),
        many => {
            for (i, revision) in many.iter().enumerate() {
                query.push(("revisions", revision.clone()));
                query.push(("sourcePositions", (i + 1).to_string()));
            }
        }
    }
    state.api(url, Method::GET, &app_path(name, &["manifests"]), &as_refs(&query), None).await
}

#[tauri::command]
/// 두 리비전의 렌더 결과를 비교한다. 소스가 여럿이면 `from_revisions`·`to_revisions`에 소스 순서대로 모두 넣는다.
pub async fn argocd_manifests_diff(
    state: State<'_, ArgocdState>,
    url: String,
    namespace: String,
    name: String,
    from_revisions: Vec<String>,
    to_revisions: Vec<String>,
) -> Result<TextDiff, AppError> {
    let (from, to) = tokio::join!(
        manifests(&state, &url, &namespace, &name, &from_revisions),
        manifests(&state, &url, &namespace, &name, &to_revisions)
    );
    let (from, to) = (from?, to?);
    tokio::task::spawn_blocking(move || diff::manifests_diff(&from, &to))
        .await
        .map_err(|_| AppError::other(MANIFESTS_FAILED))?
}

#[tauri::command]
/// 동기화 작업이 쓴 리비전의 리소스별 sync wave와 hook 종류.
pub async fn argocd_operation_waves(state: State<'_, ArgocdState>, url: String, namespace: String, name: String, revisions: Vec<String>) -> Result<Vec<Wave>, AppError> {
    let body = manifests(&state, &url, &namespace, &name, &revisions).await?;
    Ok(diff::waves_of(&body))
}

#[tauri::command]
/// 앱에 걸린 sync window와 지금 동기화할 수 있는지.
pub async fn argocd_sync_windows(state: State<'_, ArgocdState>, url: String, namespace: String, name: String) -> Result<SyncWindows, AppError> {
    let body = state
        .api(&url, Method::GET, &app_path(&name, &["syncwindows"]), &[("appNamespace", &namespace)], None)
        .await?;
    Ok(window::sync_windows_of(&body))
}

/// 스트림 작업이 끝나면(정상·오류·취소) 목록에서 뺀다.
struct Forget {
    app: tauri::AppHandle,
    id: u64,
}

impl Drop for Forget {
    fn drop(&mut self) {
        self.app.state::<ArgocdState>().untrack_stream(self.id);
    }
}

fn send(channel: &Channel<Value>, messages: Vec<Value>) -> bool {
    messages.into_iter().all(|m| channel.send(m).is_ok())
}

fn error_message(error: AppError) -> Value {
    json!({"type": "error", "error": error, "pod": null, "container": null})
}

/// 응답을 끝까지 읽어 줄 단위로 채널에 보낸다.
async fn pump(mut response: reqwest::Response, container: String, channel: Channel<Value>) {
    let mut pending = Vec::new();
    loop {
        let chunk = response.chunk().await;
        let finished = matches!(chunk, Ok(None));
        match chunk {
            Ok(Some(bytes)) => pending.extend_from_slice(&bytes),
            Ok(None) => {}
            Err(_) => {
                let _ = channel.send(error_message(AppError::Network {
                    message: logs::LOG_CONNECTION_LOST.into(),
                }));
                return;
            }
        }
        let mut entries = Vec::new();
        let mut failure = None;
        for line in logs::take_lines(&mut pending, finished) {
            match logs::parse_line(&line) {
                Ok(Some(entry)) => entries.push(entry),
                Ok(None) => {}
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        if !send(&channel, logs::messages(entries, &container)) {
            return;
        }
        if let Some(error) = failure {
            let _ = channel.send(error_message(error));
            return;
        }
        if finished {
            let _ = channel.send(json!({"type": "end"}));
            return;
        }
        if pending.len() > logs::MAX_PENDING {
            let _ = channel.send(error_message(AppError::other(logs::LOG_TOO_LONG)));
            return;
        }
    }
}

#[tauri::command]
/// 앱 로그를 채널로 흘려 보낸다(메시지는 EKS 로그와 같은 모양). 반환값은 `argocd_logs_stop`에 넘기는 번호.
pub async fn argocd_logs(
    app: tauri::AppHandle,
    state: State<'_, ArgocdState>,
    url: String,
    target: AppTarget,
    options: LogOptions,
    on_event: Channel<Value>,
) -> Result<u64, AppError> {
    let query = logs::query(&target, &options);
    let response = state.open_stream(&url, &app_path(&target.name, &["logs"]), &as_refs(&query)).await?;
    let id = state.next_stream_id();
    let container = options.container.clone().unwrap_or_default();
    let (ready, wait) = tokio::sync::oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        if wait.await.is_err() {
            return;
        }
        let _forget = Forget { app, id };
        pump(response, container, on_event).await;
    });
    state.track_stream(id, task.inner().abort_handle());
    let _ = ready.send(());
    Ok(id)
}

#[tauri::command]
/// 로그 스트림을 멈춘다.
pub fn argocd_logs_stop(state: State<'_, ArgocdState>, id: u64) {
    state.stop_stream(id);
}
