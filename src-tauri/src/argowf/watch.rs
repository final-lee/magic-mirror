//! Workflow 변경을 채널로 전달한다.
use super::{
    client::{Server, State, ARGOWF_NETWORK},
    logs, rows,
};
use crate::error::AppError;
use serde_json::{json, Value};
use tauri::{ipc::Channel, Manager};

struct Forget {
    app: tauri::AppHandle,
    id: u64,
}
impl Drop for Forget {
    fn drop(&mut self) {
        self.app.state::<State>().streams.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.id);
    }
}

fn event(line: &[u8], detail: bool) -> Result<Option<Value>, AppError> {
    let text = std::str::from_utf8(line).map_err(|_| AppError::other("감시 응답을 읽지 못했어요"))?.trim();
    if text.is_empty() || text.starts_with(':') || text.starts_with("event:") || text.starts_with("id:") {
        return Ok(None);
    }
    let data = text.strip_prefix("data:").unwrap_or(text).trim();
    let value: Value = serde_json::from_str(data).map_err(|_| AppError::other("감시 응답을 읽지 못했어요"))?;
    let result = value.get("result").unwrap_or(&value);
    if result.get("error").is_some() || value.get("error").is_some() {
        return Err(AppError::other("Workflow 감시에 실패했어요"));
    }
    let kind = result.get("type").and_then(Value::as_str).unwrap_or_default();
    if kind.is_empty() || kind == "BOOKMARK" {
        return Ok(None);
    }
    let object = result.get("object").ok_or_else(|| AppError::other("감시 응답을 읽지 못했어요"))?;
    if kind == "DELETED" {
        if detail {
            return Ok(Some(json!({"type":"deleted"})));
        }
        return Ok(Some(
            json!({"type":"delete", "uid":object.pointer("/metadata/uid").and_then(Value::as_str).unwrap_or_default(), "namespace":object.pointer("/metadata/namespace").and_then(Value::as_str).unwrap_or_default(), "name":object.pointer("/metadata/name").and_then(Value::as_str).unwrap_or_default()}),
        ));
    }
    if !matches!(kind, "ADDED" | "MODIFIED") {
        return Err(AppError::other("감시 응답을 읽지 못했어요"));
    }
    if detail {
        Ok(Some(json!({"type":"detail", "detail":rows::wf_detail(object, false)?})))
    } else {
        Ok(Some(json!({"type":"upsert", "row":rows::wf_row(object, false)})))
    }
}

#[allow(clippy::too_many_arguments)]
pub fn start(
    app: tauri::AppHandle,
    state: &State,
    server: Server,
    namespace: Option<String>,
    label_selector: Option<String>,
    resource_version: Option<String>,
    name: Option<String>,
    channel: Channel<Value>,
) -> u64 {
    let id = state.next_id();
    let (ready, wait) = tokio::sync::oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        if wait.await.is_err() {
            return;
        }
        let _forget = Forget { app: app.clone(), id };
        let state = app.state::<State>();
        let selector = name.as_ref().map(|n| format!("metadata.name={n}"));
        let fields = "result.object.metadata,result.object.spec.suspend,result.object.spec.activeDeadlineSeconds,result.object.status.phase,result.object.status.message,result.object.status.startedAt,result.object.status.finishedAt,result.object.status.progress,result.object.status.estimatedDuration";
        let mut query = Vec::new();
        if let Some(s) = label_selector.as_deref() {
            query.push(("listOptions.labelSelector", s));
        }
        if let Some(s) = resource_version.as_deref() {
            query.push(("listOptions.resourceVersion", s));
        }
        if let Some(s) = selector.as_deref() {
            query.push(("listOptions.fieldSelector", s));
        } else {
            query.push(("fields", fields));
        }
        let response = state
            .request(
                &server,
                reqwest::Method::GET,
                &["api", "v1", "workflow-events", namespace.as_deref().unwrap_or("")],
                &query,
                None,
                None,
                true,
            )
            .await;
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
                        match event(&line, name.is_some()) {
                            Ok(Some(value)) => {
                                if channel.send(value).is_err() {
                                    return;
                                }
                            }
                            Ok(None) => {}
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
                    let _ = channel.send(json!({"type":"error", "error":AppError::Network { message: ARGOWF_NETWORK.into() }}));
                    return;
                }
            }
        }
    });
    state.streams.lock().unwrap_or_else(|e| e.into_inner()).insert(id, task.inner().abort_handle());
    let _ = ready.send(());
    id
}
pub fn stop(state: &State, id: u64) {
    logs::stop(state, id);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn argowf_sse_events() {
        assert!(event(b": heartbeat", false).unwrap().is_none());
        assert_eq!(
            event(
                br#"data: {"result":{"type":"ADDED","object":{"metadata":{"uid":"u","name":"n","namespace":"x"}}}}"#,
                false
            )
            .unwrap()
            .unwrap()["type"],
            "upsert"
        );
        assert_eq!(
            event(br#"data: {"result":{"type":"DELETED","object":{"metadata":{"uid":"u"}}}}"#, false)
                .unwrap()
                .unwrap()["uid"],
            "u"
        );
        assert!(event(b"data: broken", false).is_err());
    }
}
