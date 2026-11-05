//! 로컬 Application 상태 변화 기록.
use super::{client::ArgocdState, text};
use crate::error::AppError;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoEvent {
    pub at: String,
    pub server: String,
    pub namespace: String,
    pub app: String,
    pub kind: String,
    pub from: Option<String>,
    pub to: Option<String>,
    pub revision: Option<String>,
    pub phase: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub initiated_by: Option<String>,
    pub message: Option<String>,
}
#[derive(Default)]
struct Snapshot {
    sync: Option<String>,
    health: Option<String>,
    finished: HashSet<String>,
}
#[derive(Default)]
pub(super) struct Recorder {
    snapshots: HashMap<(String, String, String), Snapshot>,
    last_prune: Option<DateTime<Utc>>,
}
fn owned(v: &Value, path: &str) -> Option<String> {
    text(v, path).filter(|s| !s.is_empty()).map(str::to_owned)
}
fn normalized(url: &str) -> &str {
    url.trim().trim_end_matches('/')
}
fn recent(at: &str, cutoff: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(at).map_or(true, |d| d >= cutoff)
}
impl Recorder {
    fn transitions(&mut self, url: &str, app: &Value, now: DateTime<Utc>) -> Vec<ArgoEvent> {
        let server = normalized(url).to_owned();
        let namespace = owned(app, "/metadata/namespace").unwrap_or_default();
        let name = owned(app, "/metadata/name").unwrap_or_default();
        let sync = owned(app, "/status/sync/status");
        let health = owned(app, "/status/health/status");
        let phase = owned(app, "/status/operationState/phase");
        let started = owned(app, "/status/operationState/startedAt");
        let finished = owned(app, "/status/operationState/finishedAt");
        let finished_key = started.clone().or_else(|| finished.clone()).unwrap_or_default();
        let done = matches!(phase.as_deref(), Some("Succeeded" | "Failed" | "Error"));
        let key = (server.clone(), namespace.clone(), name.clone());
        let baseline = !self.snapshots.contains_key(&key);
        let snapshot = self.snapshots.entry(key).or_default();
        let mut events = Vec::new();
        let base = |kind: &str| ArgoEvent {
            at: now.to_rfc3339(),
            server: server.clone(),
            namespace: namespace.clone(),
            app: name.clone(),
            kind: kind.into(),
            from: None,
            to: None,
            revision: None,
            phase: None,
            started_at: None,
            finished_at: None,
            initiated_by: None,
            message: None,
        };
        if !baseline {
            for (kind, old, new) in [("sync", &snapshot.sync, &sync), ("health", &snapshot.health, &health)] {
                if old != new {
                    let mut event = base(kind);
                    event.from = old.clone();
                    event.to = new.clone();
                    events.push(event);
                }
            }
        }
        if done && snapshot.finished.insert(finished_key) && !baseline {
            let mut event = base("operation");
            event.phase = phase;
            event.started_at = started;
            event.finished_at = finished;
            event.revision = owned(app, "/status/operationState/syncResult/revision");
            event.initiated_by = owned(app, "/status/operationState/operation/initiatedBy/username").or_else(|| {
                app.pointer("/status/operationState/operation/initiatedBy/automated")
                    .and_then(Value::as_bool)
                    .filter(|v| *v)
                    .map(|_| "automated".into())
            });
            event.message = owned(app, "/status/operationState/message");
            events.push(event);
        }
        snapshot.sync = sync;
        snapshot.health = health;
        events
    }
}
pub fn record(state: &ArgocdState, url: &str, app: &Value) -> Result<Vec<ArgoEvent>, AppError> {
    let mut recorder = state.recorder().lock().unwrap_or_else(|e| e.into_inner());
    let now = Utc::now();
    if recorder.last_prune.is_none_or(|last| now - last >= Duration::days(1)) {
        crate::jsonl::retain::<ArgoEvent>(&state.events_path(), |event| recent(&event.at, now - Duration::days(90)))
            .map_err(|_| AppError::other("이벤트 기록을 정리하지 못했어요"))?;
        recorder.last_prune = Some(now);
    }
    let events = recorder.transitions(url, app, now);
    for event in &events {
        crate::jsonl::append(&state.events_path(), event).map_err(|_| AppError::other("이벤트를 기록하지 못했어요"))?;
    }
    Ok(events)
}
pub fn read(state: &ArgocdState, url: &str, since: Option<&str>) -> Vec<ArgoEvent> {
    let since = since.and_then(|s| DateTime::parse_from_rfc3339(s).ok());
    crate::jsonl::read_all::<ArgoEvent>(&state.events_path())
        .into_iter()
        .filter(|e| e.server == normalized(url) && since.is_none_or(|s| DateTime::parse_from_rfc3339(&e.at).is_ok_and(|at| at >= s)))
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn transitions_and_deduplication() {
        let mut r = Recorder::default();
        let now = Utc::now();
        let mut app = json!({"metadata":{"namespace":"n","name":"a"},"status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"}}});
        assert!(r.transitions("https://s/", &app, now).is_empty());
        app["status"]["sync"]["status"] = json!("OutOfSync");
        app["status"]["health"]["status"] = json!("Degraded");
        assert_eq!(r.transitions("https://s", &app, now).len(), 2);
        app["status"]["operationState"] = json!({"phase":"Succeeded","startedAt":"a","finishedAt":"b"});
        assert_eq!(r.transitions("https://s", &app, now).len(), 1);
        assert!(r.transitions("https://s", &app, now).is_empty());
    }
    #[test]
    fn retention_boundary() {
        let now = Utc::now();
        let cutoff = now - Duration::days(90);
        assert!(recent(&cutoff.to_rfc3339(), cutoff));
        assert!(!recent(&(cutoff - Duration::seconds(1)).to_rfc3339(), cutoff));
    }
}
