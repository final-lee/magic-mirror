//! Argo Server의 NDJSON 로그를 줄 묶음으로 전달한다.
use super::client::{Server, State, ARGOWF_NETWORK};
use crate::error::AppError;
use serde::Serialize;
use serde_json::Value;
use tauri::{ipc::Channel, Manager};

#[derive(Serialize)]
pub struct LogLine {
    pub(crate) pod: String,
    pub(crate) text: String,
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Message {
    Lines { lines: Vec<LogLine> },
    Error { error: AppError },
    End,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub container: String,
    pub follow: bool,
    pub tail_lines: Option<i64>,
    pub previous: bool,
    pub since_seconds: Option<i64>,
    pub timestamps: bool,
}
struct Forget {
    app: tauri::AppHandle,
    id: u64,
}
impl Drop for Forget {
    fn drop(&mut self) {
        self.app.state::<State>().streams.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.id);
    }
}

#[allow(clippy::too_many_arguments)]
pub fn start(
    app: tauri::AppHandle,
    state: &State,
    server: Server,
    namespace: String,
    name: String,
    pod_name: Option<String>,
    options: Options,
    channel: Channel<Message>,
) -> u64 {
    let id = state.next_id();
    let (ready, wait) = tokio::sync::oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        if wait.await.is_err() {
            return;
        }
        let _forget = Forget { app: app.clone(), id };
        let state = app.state::<State>();
        let follow = options.follow.to_string();
        let previous = options.previous.to_string();
        let timestamps = options.timestamps.to_string();
        let tail = options.tail_lines.map(|n| n.to_string());
        let since = options.since_seconds.map(|n| n.to_string());
        let mut query = vec![
            ("logOptions.container", options.container.as_str()),
            ("logOptions.follow", follow.as_str()),
            ("logOptions.previous", previous.as_str()),
            ("logOptions.timestamps", timestamps.as_str()),
        ];
        if let Some(pod) = pod_name.as_deref() {
            query.push(("podName", pod));
        }
        if let Some(tail) = tail.as_deref() {
            query.push(("logOptions.tailLines", tail));
        }
        if let Some(since) = since.as_deref() {
            query.push(("logOptions.sinceSeconds", since));
        }
        let result = state
            .request(
                &server,
                reqwest::Method::GET,
                &["api", "v1", "workflows", &namespace, &name, "log"],
                &query,
                None,
                None,
                true,
            )
            .await;
        let mut response = match result {
            Ok(r) => r,
            Err(error) => {
                let _ = channel.send(Message::Error { error });
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
    id
}
pub fn stop(state: &State, id: u64) {
    if let Some(handle) = state.streams.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
        handle.abort();
    }
}
fn parse_line(bytes: &[u8]) -> Result<Option<LogLine>, AppError> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    let v: Value = serde_json::from_slice(bytes).map_err(|_| AppError::other("로그 응답을 읽지 못했어요"))?;
    if v.get("error").is_some() {
        return Err(AppError::other("Argo Server가 로그를 읽지 못했어요"));
    }
    let result = v.get("result").ok_or_else(|| AppError::other("로그 응답을 읽지 못했어요"))?;
    let text = result
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::other("로그 응답을 읽지 못했어요"))?;
    Ok(Some(LogLine {
        pod: result.get("podName").and_then(Value::as_str).unwrap_or_default().into(),
        text: text.trim_end_matches('\n').trim_end_matches('\r').into(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argowf_log_ndjson_and_stream_error() {
        let row = parse_line(br#"{"result":{"content":"hello\n","podName":"pod-a"}}"#).unwrap().unwrap();
        assert_eq!(row.pod, "pod-a");
        assert_eq!(row.text, "hello");
        assert!(parse_line(br#"{"error":{"message":"secret"}}"#).is_err());
        assert!(parse_line(b"  ").unwrap().is_none());
    }
}
