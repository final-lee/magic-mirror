//! Application의 sync window.
use serde::Serialize;
use serde_json::Value;

use super::{list, text};

/// sync window 하나: `allow`는 이 시간에만 동기화를 허용하고 `deny`는 이 시간에 막는다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncWindow {
    pub kind: String,
    pub schedule: String,
    pub duration: String,
    /// 막힌 동안에도 사람이 직접 하는 동기화는 허용한다
    pub manual_sync: bool,
}

/// 앱에 걸린 sync window와 지금 동기화할 수 있는지.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncWindows {
    pub can_sync: bool,
    /// 지금 켜져 있는 window
    pub active: Vec<SyncWindow>,
    /// 앱에 걸린 모든 window
    pub assigned: Vec<SyncWindow>,
}

fn windows(body: &Value, path: &str) -> Vec<SyncWindow> {
    list(body, path)
        .iter()
        .map(|w| SyncWindow {
            kind: text(w, "/kind").unwrap_or_default().to_owned(),
            schedule: text(w, "/schedule").unwrap_or_default().to_owned(),
            duration: text(w, "/duration").unwrap_or_default().to_owned(),
            manual_sync: w.pointer("/manualSync").and_then(Value::as_bool).unwrap_or(false),
        })
        .collect()
}

/// `syncwindows` 응답을 읽는다. `canSync`가 없으면(서버가 false를 생략) 동기화할 수 없는 것으로 본다.
pub fn sync_windows_of(body: &Value) -> SyncWindows {
    SyncWindows {
        can_sync: body.pointer("/canSync").and_then(Value::as_bool).unwrap_or(false),
        active: windows(body, "/activeWindows"),
        assigned: windows(body, "/assignedWindows"),
    }
}
