use std::fs;
use std::io;

use serde::{Deserialize, Serialize};

use super::*;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Row {
    id: String,
    done: bool,
}

fn row(id: &str) -> Row {
    Row { id: id.into(), done: false }
}

fn ids(path: &Path) -> Vec<String> {
    read_all::<Row>(path).into_iter().map(|r| r.id).collect()
}

#[test]
fn rows_of_any_shape_round_trip_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested").join("log.jsonl");
    assert!(read_all::<Row>(&path).is_empty());
    for id in ["a", "b", "c"] {
        append(&path, &row(id)).unwrap();
    }
    assert_eq!(ids(&path), vec!["a", "b", "c"]);
    assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 3);
}

#[test]
fn unreadable_lines_are_skipped_and_kept_when_another_row_is_updated() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("log.jsonl");
    append(&path, &row("a")).unwrap();
    let mut text = fs::read_to_string(&path).unwrap();
    text.push_str("garbage\n{\"id\":\"cut-off");
    fs::write(&path, text).unwrap();
    append(&path, &row("b")).unwrap();
    assert_eq!(ids(&path), vec!["a", "b"]);

    update::<Row>(&path, |r| r.id == "b", |r| r.done = true).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.lines().any(|line| line == "garbage"), "{text}");
    let back = read_all::<Row>(&path);
    assert_eq!(back.iter().map(|r| (r.id.as_str(), r.done)).collect::<Vec<_>>(), vec![("a", false), ("b", true)]);
    assert!(!dir.path().join("log.jsonl.tmp").exists());
}

#[test]
fn updating_a_missing_row_fails_and_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("log.jsonl");
    append(&path, &row("a")).unwrap();
    let before = fs::read_to_string(&path).unwrap();
    assert_eq!(update::<Row>(&path, |r| r.id == "zzz", |r| r.done = true).unwrap_err().kind(), io::ErrorKind::NotFound);
    assert_eq!(fs::read_to_string(&path).unwrap(), before);
    assert_eq!(update::<Row>(&dir.path().join("none.jsonl"), |_| true, |_| {}).unwrap_err().kind(), io::ErrorKind::NotFound);
}
