//! ArgoCD 변경 스트림을 채널로 전달한다.
use super::{app_row, appset_row, client::ArgocdState, events, list, text, tree_node};
use crate::error::AppError;
use serde_json::{json, Value};
use tauri::{ipc::Channel, Manager};

struct Forget {
    app: tauri::AppHandle,
    id: u64,
}
impl Drop for Forget {
    fn drop(&mut self) {
        self.app.state::<ArgocdState>().untrack_stream(self.id);
    }
}
#[derive(Clone)]
pub enum Watch {
    Apps,
    Tree { namespace: String, name: String },
    Appsets,
}
pub(super) fn parse(line: &[u8]) -> Result<Option<Value>, AppError> {
    let line = std::str::from_utf8(line).map_err(|_| AppError::other("감시 응답을 읽지 못했어요"))?.trim();
    if line.is_empty() || line.starts_with(':') || line.starts_with("event:") || line.starts_with("id:") {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(line.strip_prefix("data:").unwrap_or(line).trim()).map_err(|_| AppError::other("감시 응답을 읽지 못했어요"))?;
    let result = value.get("result").unwrap_or(&value);
    if value.get("error").is_some_and(|v| !v.is_null()) || result.get("error").is_some_and(|v| !v.is_null()) {
        return Err(AppError::other("ArgoCD 감시에 실패했어요"));
    }
    Ok(Some(result.clone()))
}
pub(super) fn messages(state: &ArgocdState, url: &str, watch: &Watch, result: &Value) -> Result<Vec<Value>, AppError> {
    if matches!(watch, Watch::Tree { .. }) {
        let nodes: Vec<_> = list(result, "/nodes").iter().chain(list(result, "/orphanedNodes")).map(tree_node).collect();
        return Ok(vec![json!({"type":"tree", "nodes":nodes})]);
    }
    let kind = text(result, "/type").unwrap_or("");
    if kind.is_empty() || kind == "BOOKMARK" {
        return Ok(vec![]);
    }
    let field = if matches!(watch, Watch::Apps) { "application" } else { "applicationSet" };
    let object = result.get(field).ok_or_else(|| AppError::other("감시 응답을 읽지 못했어요"))?;
    if kind == "DELETED" {
        return Ok(vec![
            json!({"type":"delete", "namespace":text(object, "/metadata/namespace").unwrap_or(""), "name":text(object, "/metadata/name").unwrap_or("")}),
        ]);
    }
    if !matches!(kind, "ADDED" | "MODIFIED") {
        return Err(AppError::other("감시 응답을 읽지 못했어요"));
    }
    if matches!(watch, Watch::Apps) {
        let mut out = vec![json!({"type":"upsert", "row":app_row(object)})];
        out.extend(events::record(state, url, object)?.into_iter().map(|event| json!({"type":"event", "event":event})));
        Ok(out)
    } else {
        Ok(vec![json!({"type":"upsert", "row":appset_row(object)})])
    }
}
pub fn start(app: tauri::AppHandle, state: &ArgocdState, url: String, watch: Watch, channel: Channel<Value>) -> u64 {
    let id = state.next_stream_id();
    let (ready, wait) = tokio::sync::oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        if wait.await.is_err() {
            return;
        }
        let _forget = Forget { app: app.clone(), id };
        let state = app.state::<ArgocdState>();
        let response = match &watch {
            Watch::Apps => state.open_stream(&url, &["api", "v1", "stream", "applications"], &[]).await,
            Watch::Appsets => state.open_stream(&url, &["api", "v1", "stream", "applicationsets"], &[]).await,
            Watch::Tree { namespace, name } => {
                state
                    .open_stream(&url, &["api", "v1", "stream", "applications", name, "resource-tree"], &[("appNamespace", namespace)])
                    .await
            }
        };
        let mut response = match response {
            Ok(r) => r,
            Err(error) => {
                let _ = channel.send(json!({"type":"error", "error":error}));
                return;
            }
        };
        let mut pending = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(bytes)) => {
                    pending.extend_from_slice(&bytes);
                    while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = pending.drain(..=end).collect();
                        let parsed = parse(&line).and_then(|value| match value {
                            Some(value) => messages(&state, &url, &watch, &value),
                            None => Ok(vec![]),
                        });
                        match parsed {
                            Ok(values) => {
                                for value in values {
                                    if channel.send(value).is_err() {
                                        return;
                                    }
                                }
                            }
                            Err(error) => {
                                let _ = channel.send(json!({"type":"error", "error":error}));
                                return;
                            }
                        }
                    }
                    if pending.len() > 10 * 1024 * 1024 {
                        let _ = channel.send(json!({"type":"error", "error":AppError::other("감시 응답이 너무 길어요")}));
                        return;
                    }
                }
                Ok(None) => {
                    let _ = channel.send(json!({"type":"end"}));
                    return;
                }
                Err(_) => {
                    let _ = channel.send(json!({"type":"error", "error":AppError::other("ArgoCD 감시 연결이 끊겼어요")}));
                    return;
                }
            }
        }
    });
    state.track_stream(id, task.inner().abort_handle());
    let _ = ready.send(());
    id
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sse_lines() {
        assert!(parse(b": heartbeat\n").unwrap().is_none());
        assert!(parse(b"event: message\n").unwrap().is_none());
        assert!(parse(b"id: 1\n").unwrap().is_none());
        assert_eq!(parse(b"data: {\"result\":{\"type\":\"ADDED\"}}\n").unwrap().unwrap()["type"], "ADDED");
        assert!(parse(b"{\"error\":{\"message\":\"bad\"}}\n").is_err());
    }
}
