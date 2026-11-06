//! 앱 로그 스트림(`applications/{name}/logs`): 요청 질의와 줄 해석.
use serde::Deserialize;
use serde_json::{json, Value};

use super::resource::AppTarget;
use super::text;
use crate::error::AppError;

pub const LOG_UNREADABLE: &str = "로그 응답을 읽지 못했어요";
pub const LOG_TOO_LONG: &str = "로그 응답이 너무 길어요";
pub const LOG_CONNECTION_LOST: &str = "로그 연결이 끊겼어요";
/// 줄바꿈 없이 이만큼 쌓이면 응답이 잘못된 것으로 본다.
pub const MAX_PENDING: usize = 10 * 1024 * 1024;

/// 로그를 어디서 어떻게 받을지. Pod 하나(`pod_name`)이거나 워크로드(`kind`·`group`·`resource_name`)다.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogOptions {
    #[serde(default)]
    pub pod_name: Option<String>,
    #[serde(default)]
    pub container: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub resource_name: Option<String>,
    /// 대상 리소스의 네임스페이스
    pub namespace: String,
    pub follow: bool,
    pub previous: bool,
    #[serde(default)]
    pub tail_lines: Option<u64>,
    #[serde(default)]
    pub since_seconds: Option<u64>,
}

/// `logs` 요청 질의.
pub fn query(target: &AppTarget, o: &LogOptions) -> Vec<(&'static str, String)> {
    let mut query = vec![("namespace", o.namespace.clone())];
    for (key, value) in [
        ("podName", &o.pod_name),
        ("container", &o.container),
        ("kind", &o.kind),
        ("group", &o.group),
        ("resourceName", &o.resource_name),
    ] {
        if let Some(value) = value.as_ref().filter(|v| !v.is_empty()) {
            query.push((key, value.clone()));
        }
    }
    query.push(("follow", o.follow.to_string()));
    query.push(("previous", o.previous.to_string()));
    if let Some(n) = o.tail_lines {
        query.push(("tailLines", n.to_string()));
    }
    if let Some(n) = o.since_seconds {
        query.push(("sinceSeconds", n.to_string()));
    }
    query.extend(target.scope().into_iter().map(|(k, v)| (k, v.to_owned())));
    query
}

/// 로그 한 줄. `last`는 그 Pod의 로그가 끝났다는 표시다(내용은 비어 있다).
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub pod: String,
    pub ts: Option<String>,
    pub text: String,
    pub last: bool,
}

/// 스트림의 한 줄(JSON)을 읽는다. 빈 줄은 None. 서버가 보낸 오류는 `Err`로 돌려준다.
pub fn parse_line(raw: &str) -> Result<Option<Entry>, AppError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| AppError::other(LOG_UNREADABLE))?;
    if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
        let message = text(error, "/message").filter(|m| !m.is_empty()).unwrap_or(LOG_UNREADABLE);
        return Err(AppError::other(message));
    }
    let result = value.get("result").ok_or_else(|| AppError::other(LOG_UNREADABLE))?;
    Ok(Some(Entry {
        pod: text(result, "/podName").unwrap_or_default().to_owned(),
        ts: text(result, "/timeStampStr")
            .or_else(|| text(result, "/timeStamp"))
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        text: text(result, "/content").unwrap_or_default().to_owned(),
        last: result.pointer("/last").and_then(Value::as_bool).unwrap_or(false),
    }))
}

/// 받은 바이트에서 줄바꿈으로 끝난 줄을 꺼낸다(남은 조각은 다음 바이트와 이어 읽는다). `finished`면 줄바꿈 없이 끝난 마지막 조각도 한 줄로 꺼낸다.
pub fn take_lines(pending: &mut Vec<u8>, finished: bool) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(end) = pending.iter().position(|b| *b == b'\n') {
        let line: Vec<u8> = pending.drain(..=end).collect();
        lines.push(String::from_utf8_lossy(&line).into_owned());
    }
    if finished && !pending.is_empty() {
        lines.push(String::from_utf8_lossy(pending).into_owned());
        pending.clear();
    }
    lines
}

/// 줄들을 채널 메시지로 묶는다: 같은 Pod의 이어진 줄은 `lines` 하나로, `last`는 그 뒤에 `source ended`로.
/// `container`는 요청한 컨테이너 이름이다(서버 응답에는 컨테이너가 없다).
pub fn messages(entries: Vec<Entry>, container: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut open: Option<(String, Vec<Value>)> = None;
    let flush = |open: &mut Option<(String, Vec<Value>)>, out: &mut Vec<Value>| {
        if let Some((pod, lines)) = open.take() {
            out.push(json!({"type": "lines", "pod": pod, "container": container, "lines": lines}));
        }
    };
    for e in entries {
        if !e.last || !e.text.is_empty() {
            if open.as_ref().is_some_and(|(pod, _)| *pod != e.pod) {
                flush(&mut open, &mut out);
            }
            open.get_or_insert_with(|| (e.pod.clone(), Vec::new())).1.push(json!({"ts": e.ts, "text": e.text}));
        }
        if e.last {
            flush(&mut open, &mut out);
            out.push(json!({"type": "source", "pod": e.pod, "container": container, "state": "ended"}));
        }
    }
    flush(&mut open, &mut out);
    out
}

#[cfg(test)]
mod tests;
