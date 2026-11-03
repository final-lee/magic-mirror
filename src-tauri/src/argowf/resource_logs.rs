//! EventSource·Sensor의 SSE 로그를 기존 로그 채널로 보낸다.
use super::{
    client::{Server, State, ARGOWF_NETWORK},
    events::ARGO_EVENTS_MISSING,
    logs::{LogLine, Message},
};
use crate::error::AppError;
use serde_json::Value;
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

/// 공용 로그 중지 명령과 같은 흐름 번호를 쓴다.
pub fn start(
    app: tauri::AppHandle,
    state: &State,
    server: Server,
    kind: String,
    namespace: String,
    name: String,
    channel: Channel<Message>,
) -> Result<u64, AppError> {
    let resource = match kind.as_str() {
        "EventSource" => "event-sources",
        "Sensor" => "sensors",
        _ => return Err(AppError::other("알 수 없는 Argo Events 리소스예요")),
    };
    let id = state.next_id();
    let (ready, wait) = tokio::sync::oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        if wait.await.is_err() {
            return;
        }
        let _forget = Forget { app: app.clone(), id };
        let state = app.state::<State>();
        let query = [("name", name.as_str()), ("podLogOptions.follow", "true"), ("podLogOptions.container", "main")];
        let response = state
            .request(
                &server,
                reqwest::Method::GET,
                &["api", "v1", "stream", resource, &namespace, "logs"],
                &query,
                None,
                None,
                true,
            )
            .await;
        let mut response = match response {
            Ok(r) => r,
            Err(error) => {
                let _ = channel.send(Message::Error {
                    error: super::events::events_error(error),
                });
                return;
            }
        };
        let mut pending = Vec::new();
        let mut batch = Vec::new();
        let mut flush = tokio::time::interval(std::time::Duration::from_millis(100));
        loop {
            tokio::select! {
                chunk = response.chunk() => match chunk {
                    Ok(Some(bytes)) => {
                        pending.extend_from_slice(&bytes);
                        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                            let line: Vec<u8> = pending.drain(..=end).collect();
                            match parse_line(&line) {
                                Ok(Some(row)) => batch.push(row),
                                Ok(None) => {}
                                Err(error) => {
                                    if !batch.is_empty() && channel.send(Message::Lines { lines: batch }).is_err() { return; }
                                    let _ = channel.send(Message::Error { error }); return;
                                }
                            }
                            if batch.len() >= 500 && channel.send(Message::Lines { lines: std::mem::take(&mut batch) }).is_err() { return; }
                        }
                        if pending.len() > 1024 * 1024 { let _ = channel.send(Message::Error { error: AppError::other("로그 응답이 너무 길어요") }); return; }
                    }
                    Ok(None) => {
                        match parse_line(&pending) {
                            Ok(Some(row)) => batch.push(row),
                            Ok(None) => {}
                            Err(error) => {
                                if !batch.is_empty() && channel.send(Message::Lines { lines: batch }).is_err() { return; }
                                let _ = channel.send(Message::Error { error }); return;
                            }
                        }
                        if !batch.is_empty() && channel.send(Message::Lines { lines: batch }).is_err() { return; }
                        let _ = channel.send(Message::End); return;
                    }
                    Err(_) => { let _ = channel.send(Message::Error { error: AppError::Network { message: ARGOWF_NETWORK.into() } }); return; }
                },
                _ = flush.tick() => if !batch.is_empty() && channel.send(Message::Lines { lines: std::mem::take(&mut batch) }).is_err() { return; },
            }
        }
    });
    state.streams.lock().unwrap_or_else(|e| e.into_inner()).insert(id, task.inner().abort_handle());
    let _ = ready.send(());
    Ok(id)
}

/// Argo UI는 EventSource로 `data: {"result": …}`를 받는다.
fn parse_line(bytes: &[u8]) -> Result<Option<LogLine>, AppError> {
    let line = std::str::from_utf8(bytes).map_err(|_| AppError::other("로그 응답을 읽지 못했어요"))?.trim();
    if line.is_empty() || line.starts_with(':') || line.starts_with("event:") || line.starts_with("id:") || line.starts_with("retry:") {
        return Ok(None);
    }
    let data = line.strip_prefix("data:").map_or(line, str::trim_start);
    if data.is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(data).map_err(|_| AppError::other("로그 응답을 읽지 못했어요"))?;
    if let Some(error) = value.get("error") {
        let code = error.get("code").and_then(Value::as_i64);
        return Err(AppError::other(if matches!(code, Some(5 | 404)) {
            ARGO_EVENTS_MISSING
        } else {
            "Argo Server가 로그를 읽지 못했어요"
        }));
    }
    let result = value.get("result").ok_or_else(|| AppError::other("로그 응답을 읽지 못했어요"))?;
    let message = result
        .get("msg")
        .or_else(|| result.get("content"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::other("로그 응답을 읽지 못했어요"))?;
    let prefix = ["time", "level"]
        .into_iter()
        .filter_map(|key| result.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()))
        .collect::<Vec<_>>()
        .join(" ");
    let text = if prefix.is_empty() {
        message.trim_end_matches(['\r', '\n']).to_owned()
    } else {
        format!("{prefix} {}", message.trim_end_matches(['\r', '\n']))
    };
    let pod = ["podName", "eventSourceName", "sensorName"]
        .into_iter()
        .find_map(|key| result.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()))
        .unwrap_or_default()
        .to_owned();
    Ok(Some(LogLine { pod, text }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn argowf_resource_logs_sse_and_errors() {
        let entry = parse_line(b"data: {\"result\":{\"eventSourceName\":\"source\",\"time\":\"2026-01-01T00:00:00Z\",\"level\":\"info\",\"msg\":\"hello\"}}\n")
            .unwrap()
            .unwrap();
        assert_eq!(entry.pod, "source");
        assert_eq!(entry.text, "2026-01-01T00:00:00Z info hello");
        let sensor = parse_line(br#"{"result":{"sensorName":"sensor","msg":"ready"}}"#).unwrap().unwrap();
        assert_eq!((sensor.pod.as_str(), sensor.text.as_str()), ("sensor", "ready"));
        assert!(parse_line(b": heartbeat\n").unwrap().is_none());
        assert_eq!(parse_line(br#"{"error":{"code":5}}"#).err(), Some(AppError::other(ARGO_EVENTS_MISSING)));
        assert!(parse_line(b"invalid").is_err());
    }
}
