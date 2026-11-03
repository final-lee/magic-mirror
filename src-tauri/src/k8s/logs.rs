//! Pod와 워크로드 로그를 소스별로 묶어 전달한다.
use std::{collections::{HashMap, HashSet}, io, path::PathBuf};
use futures::io::{AsyncBufRead, AsyncBufReadExt};
use futures::stream::{self, BoxStream, StreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::{api::{Api, LogParams}, runtime::watcher::{self, Event}, ResourceExt};
use serde::{Deserialize, Serialize};
use tokio::{sync::mpsc, task::{AbortHandle, JoinSet}};
use super::failure::{describe, Endpoint, Failure};
use super::read::{api_for, bounded};
use super::rows::KindRef;
use super::watch::{self, FLUSH_EVERY, FLUSH_ROWS};
use crate::error::AppError;

pub const KEEP_LINES: i64 = 50_000;
pub const MAX_LINE: usize = 16 * 1024;
const MAX_STREAMS: usize = 40;

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LogOptions {
    pub container: Option<String>,
    pub follow: bool,
    pub tail_lines: Option<i64>,
    pub since_seconds: Option<i64>,
    pub previous: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LogLine { pub ts: Option<String>, pub text: String }

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogMessage {
    Lines { pod: String, container: String, lines: Vec<LogLine> },
    Source { pod: String, container: String, state: &'static str },
    Notice { message: String },
    Error { error: AppError, pod: Option<String>, container: Option<String> },
    End,
}

pub fn params(opts: &LogOptions) -> LogParams {
    LogParams { container: opts.container.clone(), follow: opts.follow, tail_lines: Some(opts.tail_lines.unwrap_or(KEEP_LINES).clamp(1, KEEP_LINES)), since_seconds: opts.since_seconds.filter(|s| *s > 0), previous: opts.previous, timestamps: true, ..Default::default() }
}

fn split_line(line: String) -> LogLine {
    if let Some((prefix, text)) = line.split_once(' ') {
        if prefix.parse::<k8s_openapi::jiff::Timestamp>().is_ok() {
            return LogLine { ts: Some(prefix.to_owned()), text: text.to_owned() };
        }
    }
    LogLine { ts: None, text: line }
}

pub fn line_of(mut bytes: Vec<u8>, clipped: bool) -> String {
    if !clipped && bytes.last() == Some(&b'\r') { bytes.pop(); }
    let mut s = String::from_utf8_lossy(&bytes).into_owned();
    if clipped { s.push('…'); }
    s
}

pub fn lines_of<R: AsyncBufRead + Unpin + Send + 'static>(reader: R) -> BoxStream<'static, io::Result<String>> {
    stream::unfold(reader, |mut r| async move {
        let mut line = Vec::new();
        let mut clipped = false;
        loop {
            let (used, done) = match r.fill_buf().await {
                Err(e) => return Some((Err(e), r)),
                Ok([]) => return (!line.is_empty() || clipped).then(|| (Ok(line_of(line, clipped)), r)),
                Ok(chunk) => {
                    let newline = chunk.iter().position(|b| *b == b'\n');
                    let content = &chunk[..newline.unwrap_or(chunk.len())];
                    let room = MAX_LINE - line.len();
                    if content.len() > room { clipped = true; }
                    line.extend_from_slice(&content[..content.len().min(room)]);
                    (newline.map_or(chunk.len(), |i| i + 1), newline.is_some())
                }
            };
            r.consume_unpin(used);
            if done { return Some((Ok(line_of(line, clipped)), r)); }
        }
    }).boxed()
}

async fn source(api: Api<Pod>, pod: String, container: String, lp: LogParams, endpoint: Endpoint, tx: mpsc::Sender<LogMessage>) {
    let reader = match bounded(api.log_stream(&pod, &lp), "get", "pods/log", endpoint).await {
        Ok(reader) => reader,
        Err(error) => { let _ = tx.send(LogMessage::Error { error, pod: Some(pod), container: Some(container) }).await; return; }
    };
    if tx.send(LogMessage::Source { pod: pod.clone(), container: container.clone(), state: "attached" }).await.is_err() { return; }
    let mut lines = lines_of(Box::pin(reader));
    let mut batch = Vec::new();
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + FLUSH_EVERY, FLUSH_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let mut done = false;
        let mut flush = false;
        let mut error = None;
        tokio::select! {
            next = lines.next() => match next {
                Some(Ok(line)) => batch.push(split_line(line)),
                Some(Err(_)) => { error = Some(describe(&Failure::Unreachable, endpoint)); done = true; },
                None => done = true,
            },
            _ = tick.tick() => { flush = true; }
        }
        if !batch.is_empty() && (done || batch.len() >= FLUSH_ROWS || flush)
            && tx.send(LogMessage::Lines { pod: pod.clone(), container: container.clone(), lines: std::mem::take(&mut batch) }).await.is_err() {
            return;
        }
        if done {
            if let Some(error) = error { let _ = tx.send(LogMessage::Error { error, pod: Some(pod.clone()), container: Some(container.clone()) }).await; }
            let _ = tx.send(LogMessage::Source { pod, container, state: "ended" }).await;
            return;
        }
    }
}

fn containers(pod: &Pod, chosen: &Option<String>) -> Vec<String> {
    let Some(spec) = &pod.spec else { return Vec::new(); };
    match chosen {
        Some(name) => spec.containers.iter().chain(spec.init_containers.iter().flatten())
            .filter(|c| &c.name == name).map(|c| c.name.clone()).collect(),
        None => spec.containers.iter().map(|c| c.name.clone()).collect(),
    }
}

pub async fn run<F>(client: kube::Client, namespace: String, pod: String, opts: LogOptions, endpoint: Endpoint, mut send: F)
where F: FnMut(LogMessage) -> bool + Send {
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let object = match bounded(api.get(&pod), "get", "pods", endpoint).await {
        Ok(p) => p,
        Err(error) => { send(LogMessage::Error { error, pod: None, container: None }); return; }
    };
    let names = containers(&object, &opts.container);
    if names.is_empty() { send(LogMessage::Error { error: AppError::other("선택한 컨테이너를 찾을 수 없어요"), pod: None, container: None }); return; }
    let (tx, mut rx) = mpsc::channel(100);
    let mut tasks = JoinSet::new();
    for container in names {
        let mut lp = params(&opts); lp.container = Some(container.clone());
        tasks.spawn(source(api.clone(), pod.clone(), container, lp, endpoint, tx.clone()));
    }
    drop(tx);
    while let Some(m) = rx.recv().await { if !send(m) { return; } }
    send(LogMessage::End);
}

fn selector(value: &serde_json::Value, service: bool) -> Result<String, AppError> {
    let invalid = || AppError::other("Pod 선택자를 읽을 수 없어요");
    let labels = if service { value.as_object() } else { value.get("matchLabels").and_then(|v| v.as_object()) };
    let mut parts = Vec::new();
    if let Some(labels) = labels {
        for (key, val) in labels { parts.push(format!("{}={}", key, val.as_str().ok_or_else(invalid)?)); }
    }
    if !service {
        if let Some(exprs) = value.get("matchExpressions") {
            for expr in exprs.as_array().ok_or_else(invalid)? {
                let key = expr.get("key").and_then(|v| v.as_str()).ok_or_else(invalid)?;
                let op = expr.get("operator").and_then(|v| v.as_str()).ok_or_else(invalid)?;
                let vals: Vec<&str> = expr.get("values").and_then(|v| v.as_array()).map(|v| v.iter().map(|x| x.as_str().ok_or_else(invalid)).collect()).transpose()?.unwrap_or_default();
                parts.push(match op {
                    "In" if !vals.is_empty() => format!("{} in ({})", key, vals.join(",")),
                    "NotIn" if !vals.is_empty() => format!("{} notin ({})", key, vals.join(",")),
                    "Exists" if vals.is_empty() => key.to_owned(),
                    "DoesNotExist" if vals.is_empty() => format!("!{key}"),
                    _ => return Err(invalid()),
                });
            }
        }
    }
    if parts.is_empty() { return Err(invalid()); }
    Ok(parts.join(","))
}

fn supported(kind: &KindRef) -> bool {
    matches!((kind.group.as_str(), kind.kind.as_str()), ("apps", "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet") | ("batch", "Job") | ("", "Service")) && kind.namespaced
}

pub async fn workload<F>(client: kube::Client, kind: KindRef, namespace: String, name: String, opts: LogOptions, endpoint: Endpoint, mut send: F)
where F: FnMut(LogMessage) -> bool + Send {
    if !supported(&kind) { send(LogMessage::Error { error: AppError::other("이 리소스의 워크로드 로그는 지원하지 않아요"), pod: None, container: None }); return; }
    let object = match bounded(api_for(client.clone(), &kind, Some(&namespace)).get(&name), "get", &kind.plural, endpoint).await {
        Ok(o) => o,
        Err(error) => { send(LogMessage::Error { error, pod: None, container: None }); return; }
    };
    let selection = match object.data.pointer("/spec/selector").ok_or_else(|| AppError::other("Pod 선택자가 없어요")).and_then(|v| selector(v, kind.kind == "Service")) {
        Ok(s) => s,
        Err(error) => { send(LogMessage::Error { error, pod: None, container: None }); return; }
    };
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let mut events = watcher::watcher(api.clone(), watcher::Config::default().labels(&selection)).boxed();
    let (tx, mut rx) = mpsc::channel(100);
    let mut tasks = JoinSet::new();
    let mut active: HashMap<(String, String), (AbortHandle, String)> = HashMap::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut initial = true;
    let mut listed = HashSet::new();
    let mut capped = false;
    loop {
        tokio::select! {
            Some(m) = rx.recv() => { if !send(m) { return; } },
            Some(result) = tasks.join_next(), if !tasks.is_empty() => {
                if let Ok(key) = result { active.remove(&key); }
                if !opts.follow && !initial && tasks.is_empty() { break; }
            },
            event = events.next(), if opts.follow || initial => {
                match event {
                    Some(Ok(Event::Init)) => listed.clear(),
                    Some(Ok(Event::InitDone)) => {
                        initial = false;
                        let removed: Vec<_> = active.keys().filter(|(uid, _)| !listed.contains(uid)).cloned().collect();
                        for key in removed {
                            if let Some((h, pod)) = active.remove(&key) {
                                h.abort();
                                if !send(LogMessage::Source { pod, container: key.1, state: "ended" }) { return; }
                            }
                        }
                        if !opts.follow && tasks.is_empty() { break; }
                    },
                    Some(Ok(Event::Delete(p))) => {
                        let uid = p.metadata.uid.clone().unwrap_or_else(|| p.name_any());
                        let removed: Vec<_> = active.keys().filter(|(u, _)| *u == uid).cloned().collect();
                        for key in removed {
                            if let Some((h, pod)) = active.remove(&key) {
                                h.abort();
                                if !send(LogMessage::Source { pod, container: key.1, state: "ended" }) { return; }
                            }
                        }
                    },
                    Some(Ok(Event::InitApply(p) | Event::Apply(p))) => {
                        let uid = p.metadata.uid.clone().unwrap_or_else(|| p.name_any());
                        if initial { listed.insert(uid.clone()); }
                        let ready = p.status.as_ref().and_then(|s| s.phase.as_deref()).is_some_and(|s| matches!(s, "Running" | "Succeeded" | "Failed"));
                        if !ready { continue; }
                        for container in containers(&p, &opts.container) {
                            let key = (uid.clone(), container.clone());
                            if seen.contains(&key) { continue; }
                            if active.len() >= MAX_STREAMS {
                                if !capped { capped = true; if !send(LogMessage::Notice { message: format!("동시에 최대 {MAX_STREAMS}개 로그만 볼 수 있어요") }) { return; } }
                                continue;
                            }
                            seen.insert(key.clone());
                            let mut lp = params(&opts); lp.container = Some(container.clone());
                            if !initial && opts.follow {
                                if let Some(start) = p.status.as_ref().and_then(|s| s.start_time.as_ref()) {
                                    lp.since_time = Some(start.0); lp.since_seconds = None; lp.tail_lines = None;
                                }
                            }
                            let a = api.clone(); let t = tx.clone(); let pod = p.name_any(); let source_pod = pod.clone(); let k = key.clone();
                            let h = tasks.spawn(async move { source(a, source_pod, container, lp, endpoint, t).await; k });
                            active.insert(key, (h, pod));
                        }
                    },
                    Some(Err(e)) => { let error = describe(&watch::watch_failure(&e, &kind), endpoint); send(LogMessage::Error { error, pod: None, container: None }); return; },
                    None => break,
                }
            }
        }
    }
    while let Ok(m) = rx.try_recv() { if !send(m) { return; } }
    send(LogMessage::End);
}

fn safe_filename(name: &str) -> String {
    let name: String = name.chars().map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':') { '_' } else { c }).collect();
    let name = name.trim().trim_matches('.');
    if name.is_empty() { "logs.log".into() } else { name.to_owned() }
}

pub async fn save(file_name: String, text: String) -> Result<String, AppError> {
    use tokio::io::AsyncWriteExt;
    let home = std::env::var_os("HOME").ok_or_else(|| AppError::other("홈 폴더를 찾을 수 없어요"))?;
    let dir = PathBuf::from(home).join("Downloads");
    let name = safe_filename(&file_name);
    let path = std::path::Path::new(&name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("logs");
    let ext = path.extension().and_then(|s| s.to_str());
    for n in 0u64.. {
        let candidate = if n == 0 { name.clone() } else if let Some(ext) = ext { format!("{stem}-{n}.{ext}") } else { format!("{stem}-{n}") };
        let path = dir.join(candidate);
        match tokio::fs::OpenOptions::new().write(true).create_new(true).open(&path).await {
            Ok(mut file) => { file.write_all(text.as_bytes()).await.map_err(|e| AppError::other(format!("로그를 저장하지 못했어요: {e}")))?; return Ok(path.to_string_lossy().into_owned()); },
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(AppError::other(format!("로그를 저장하지 못했어요: {e}"))),
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests;
