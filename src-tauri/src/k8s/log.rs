//! 쿠버네티스 변경 기록. Secret 값과 요청 본문은 기록하지 않는다.
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};
use super::change::Change;
use super::target::K8sTarget;
use crate::{error::AppError, jsonl};

pub const UNDO_UNAVAILABLE: &str = "이 변경은 되돌릴 수 없어요";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub at: String,
    pub target: K8sTarget,
    pub change: Change,
    pub summary: String,
    pub ok: bool,
    pub error: Option<String>,
    pub inverse: Option<Change>,
    pub undo_of: Option<String>,
    pub undone: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Undo {
    pub target: K8sTarget,
    pub change: Change,
}

pub fn append(path: &Path, entry: &Entry) -> io::Result<()> {
    jsonl::append(path, entry)
}

pub fn read_all(path: &Path) -> Vec<Entry> {
    jsonl::read_all(path)
}

pub fn mark_undone(path: &Path, id: &str) -> io::Result<()> {
    jsonl::update(path, |entry: &Entry| entry.id == id, |entry| entry.undone = true)
}

pub fn undo(entries: &[Entry], id: &str) -> Result<Undo, AppError> {
    let entry = entries.iter().find(|entry| entry.id == id && entry.ok && !entry.undone).ok_or_else(|| AppError::other(UNDO_UNAVAILABLE))?;
    Ok(Undo { target: entry.target.clone(), change: entry.inverse.clone().ok_or_else(|| AppError::other(UNDO_UNAVAILABLE))? })
}

#[cfg(test)]
mod tests;
