use kube::core::Status;

use super::*;

fn namespaces() -> KindRef {
    KindRef { group: "".into(), version: "v1".into(), kind: "Namespace".into(), plural: "namespaces".into(), namespaced: false }
}

fn ns(name: &str, uid: &str, phase: &str) -> DynamicObject {
    serde_json::from_value(serde_json::json!({
        "apiVersion": "v1", "kind": "Namespace",
        "metadata": { "name": name, "uid": uid, "resourceVersion": "7" },
        "status": { "phase": phase }
    }))
    .unwrap()
}

fn row(n: &str, u: &str) -> Row {
    row_of(&namespaces(), &ns(n, u, "Active"))
}

#[test]
fn batcher_buffers_init_then_streams_changes() {
    let mut b = Batcher::default();
    assert_eq!(b.on(Event::Init), None);
    assert_eq!(b.on(Event::InitApply(row("a", "1"))), None);
    assert_eq!(b.on(Event::InitApply(row("b", "2"))), None);
    let Some(WatchMessage::Reset { rows }) = b.on(Event::InitDone) else { panic!() };
    assert_eq!(rows.len(), 2);
    assert_eq!(b.take(), None);
    assert_eq!(b.on(Event::Apply(row("a", "1"))), None);
    assert_eq!(b.on(Event::Apply(row("a2", "1"))), None); // 같은 uid는 마지막 것
    assert_eq!(b.on(Event::Delete(row("b", "2"))), None);
    let Some(WatchMessage::Changes { upserts, deletes }) = b.take() else { panic!() };
    assert_eq!(upserts.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["a2"]);
    assert_eq!(deletes, ["2"]);
    // 올린 뒤 지우면 올림이 취소된다
    b.on(Event::Apply(row("c", "3")));
    b.on(Event::Delete(row("c", "3")));
    let Some(WatchMessage::Changes { upserts, deletes }) = b.take() else { panic!() };
    assert!(upserts.is_empty());
    assert_eq!(deletes, ["3"]);
    // 다시 목록을 받으면 쌓인 변경을 버린다
    b.on(Event::Apply(row("d", "4")));
    b.on(Event::Init);
    assert_eq!(b.take(), None);
}

#[test]
fn delete_then_apply_of_the_same_uid_keeps_only_the_upsert() {
    let mut b = Batcher::default();
    b.on(Event::Delete(row("a", "1")));
    b.on(Event::Apply(row("a", "1")));
    let Some(WatchMessage::Changes { upserts, deletes }) = b.take() else { panic!() };
    assert_eq!(upserts.len(), 1);
    assert!(deletes.is_empty());
}

#[test]
fn full_at_500_pending() {
    let mut b = Batcher::default();
    b.on(Event::Init);
    b.on(Event::InitDone);
    for i in 0..499 {
        b.on(Event::Apply(row(&format!("n{i}"), &i.to_string())));
    }
    assert!(!b.full());
    b.on(Event::Apply(row("last", "x")));
    assert!(b.full());
}

#[test]
fn messages_serialize_with_type_tag() {
    let v = serde_json::to_value(WatchMessage::Changes { upserts: vec![], deletes: vec!["u".into()] }).unwrap();
    assert_eq!(v, serde_json::json!({ "type": "changes", "upserts": [], "deletes": ["u"] }));
    let v = serde_json::to_value(WatchMessage::Error { error: AppError::other("x"), fatal: true }).unwrap();
    assert_eq!(v, serde_json::json!({ "type": "error", "error": { "kind": "other", "message": "x" }, "fatal": true }));
    let v = serde_json::to_value(WatchMessage::Reset { rows: vec![] }).unwrap();
    assert_eq!(v, serde_json::json!({ "type": "reset", "rows": [] }));
}

fn status(code: u16) -> Box<Status> {
    Box::new(Status::failure("x", "Forbidden").with_code(code))
}

#[test]
fn forbidden_in_watch_body_is_fatal_and_names_the_verb() {
    let k = namespaces();
    let f = watch_failure(&watcher::Error::WatchError(status(403)), &k);
    assert_eq!(f, Failure::Forbidden { verb: "watch".into(), resource: "namespaces".into() });
    assert!(is_fatal(&f));
    let f = watch_failure(&watcher::Error::InitialListFailed(kube::Error::Api(status(403))), &k);
    assert_eq!(f, Failure::Forbidden { verb: "list".into(), resource: "namespaces".into() });
}

#[test]
fn unauthorized_is_fatal_and_server_errors_are_not() {
    let k = namespaces();
    assert!(is_fatal(&watch_failure(&watcher::Error::WatchFailed(kube::Error::Api(status(401))), &k)));
    assert!(!is_fatal(&watch_failure(&watcher::Error::WatchFailed(kube::Error::Api(status(500))), &k)));
    assert!(!is_fatal(&watch_failure(&watcher::Error::NoResourceVersion, &k)));
}

#[test]
fn stall_fires_once_after_the_limit_and_progress_resets_it() {
    let t0 = Instant::now();
    let mut s = Stall::default();
    assert!(!s.expired(t0 + REQUEST_TIMEOUT)); // 켜기 전에는 울리지 않는다
    s.arm(t0);
    assert!(!s.expired(t0 + REQUEST_TIMEOUT - std::time::Duration::from_secs(1)));
    s.on_event(&Event::<Row>::InitApply(row("a", "1")), t0 + std::time::Duration::from_secs(20));
    assert!(!s.expired(t0 + REQUEST_TIMEOUT)); // 진행이 있어 다시 쟀다
    assert!(s.expired(t0 + std::time::Duration::from_secs(50)));
    assert!(!s.expired(t0 + std::time::Duration::from_secs(500))); // 한 번만
    s.on_event(&Event::<Row>::Init, t0 + std::time::Duration::from_secs(600));
    assert!(s.expired(t0 + std::time::Duration::from_secs(630)));
}

#[test]
fn stall_stops_at_init_done_and_ignores_plain_changes() {
    let t0 = Instant::now();
    let mut s = Stall::default();
    s.arm(t0);
    s.on_event(&Event::<Row>::InitDone, t0);
    assert!(!s.expired(t0 + std::time::Duration::from_secs(3600)));
    s.arm(t0);
    s.on_event(&Event::Apply(row("a", "1")), t0 + std::time::Duration::from_secs(29));
    assert!(s.expired(t0 + REQUEST_TIMEOUT)); // Apply는 시계를 건드리지 않는다
}
