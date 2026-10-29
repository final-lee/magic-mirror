use std::fs;
use std::sync::Arc;
use std::thread;

use serde_json::json;

use super::*;

fn change() -> PgChange {
    PgChange::Membership { group: "app_read".into(), member: "carol".into(), add: true, admin: false }
}

fn entry(id: &str) -> PgLogEntry {
    PgLogEntry {
        id: id.into(),
        at: "2026-10-29T01:02:03Z".into(),
        profile: "prod".into(),
        target_arn: "arn:aws:rds:ap-northeast-2:111111111111:cluster:c".into(),
        database: "postgres".into(),
        login_user: "mm_admin".into(),
        change: change(),
        summary: "그룹에 넣기: carol → app_read".into(),
        sql: vec!["GRANT \"app_read\" TO \"carol\"".into()],
        ok: true,
        error: None,
        inverse: Some(vec![PgChange::Membership { group: "app_read".into(), member: "carol".into(), add: false, admin: false }]),
        undo_of: None,
        undone: false,
        batch_id: None,
    }
}

#[test]
fn entries_come_back_in_order_and_broken_lines_are_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db-changes.jsonl");
    append(&path, &entry("a")).unwrap();
    let mut text = fs::read_to_string(&path).unwrap();
    text.push_str("\n   \n{\"id\":\"half\"\nnot json\n");
    fs::write(&path, text).unwrap();
    append(&path, &entry("b")).unwrap();
    assert_eq!(read_all(&path), vec![entry("a"), entry("b")]);
}

#[test]
fn entries_serialize_with_the_contract_names_and_leave_out_a_missing_batch_id() {
    let value = serde_json::to_value(entry("a")).unwrap();
    let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec!["at", "change", "database", "error", "id", "inverse", "loginUser", "ok", "profile", "sql", "summary", "targetArn", "undoOf", "undone"]
    );
    assert_eq!(value["change"], json!({ "kind": "membership", "group": "app_read", "member": "carol", "add": true, "admin": false }));
    let mut batched = entry("b");
    batched.batch_id = Some("b1".into());
    assert_eq!(serde_json::to_value(&batched).unwrap()["batchId"], json!("b1"));
}

#[test]
fn marking_undone_changes_only_that_entry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("log.jsonl");
    for id in ["a", "b", "c"] {
        append(&path, &entry(id)).unwrap();
    }
    mark_undone(&path, "b").unwrap();
    let back = read_all(&path);
    assert_eq!(back.iter().map(|e| (e.id.as_str(), e.undone)).collect::<Vec<_>>(), vec![("a", false), ("b", true), ("c", false)]);
    assert_eq!(mark_undone(&path, "zzz").unwrap_err().kind(), std::io::ErrorKind::NotFound);
}

#[test]
fn writers_in_different_threads_never_mix_their_lines() {
    let dir = tempfile::tempdir().unwrap();
    let path = Arc::new(dir.path().join("log.jsonl"));
    let workers: Vec<_> = (0..8)
        .map(|w| {
            let path = path.clone();
            thread::spawn(move || {
                for i in 0..25 {
                    let mut e = entry(&format!("w{w}-{i}"));
                    e.summary = "긴 요약 ".repeat(200);
                    append(&path, &e).unwrap();
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(read_all(&path).len(), 200);
}
