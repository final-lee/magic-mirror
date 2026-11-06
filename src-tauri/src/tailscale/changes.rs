//! 테일넷 변경 기록과 되돌림 표시.
use std::{io, path::Path};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub at: String,
    pub tailnet: String,
    pub action: String,
    pub target: Target,
    pub summary: String,
    pub before: Value,
    pub after: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undo_of: Option<String>,
    #[serde(default)]
    pub undone: bool,
}

pub fn record(path: &Path, entry: &Entry) -> io::Result<()> { crate::jsonl::append(path, entry) }
pub fn list(path: &Path) -> Vec<Entry> { crate::jsonl::read_all(path) }
pub fn mark_undone(path: &Path, id: &str) -> io::Result<()> {
    crate::jsonl::update(path, |entry: &Entry| entry.id == id, |entry| entry.undone = true)
}
