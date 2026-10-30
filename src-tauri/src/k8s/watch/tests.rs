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

fn secs(n: u64) -> std::time::Duration {
    std::time::Duration::from_secs(n)
}

#[test]
fn stall_fires_once_after_the_limit_and_progress_resets_it() {
    let t0 = Instant::now();
    let mut s = Stall::default();
    assert!(!s.expired(t0 + REQUEST_TIMEOUT)); // 켜기 전에는 울리지 않는다
    s.start(t0);
    assert!(!s.expired(t0 + secs(29)));
    s.on_event(&Event::<Row>::InitApply(row("a", "1")), t0 + secs(20));
    assert!(!s.expired(t0 + REQUEST_TIMEOUT)); // 진행이 있어 다시 쟀다
    assert!(s.expired(t0 + secs(50)));
    assert!(!s.expired(t0 + secs(500))); // 한 번만
    s.on_event(&Event::<Row>::Init, t0 + secs(600));
    assert!(s.expired(t0 + secs(630)));
}

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use futures::StreamExt;

#[test]
fn retry_doubles_to_the_cap_and_resets() {
    let mut r = Retry::default();
    let got: Vec<u64> = (0..7).map(|_| r.next_delay().as_secs()).collect();
    assert_eq!(got, [1, 2, 4, 8, 16, 30, 30]);
    r.reset();
    assert_eq!(r.next_delay(), RETRY_FIRST);
}

type Item = Result<Event<DynamicObject>, watcher::Error>;

/// 부를 때마다 다음 스트림을 내준다. 각 스트림은 주어진 항목 뒤에 열린 채로 멈춘다(조용한 watch).
fn opener(streams: Vec<Vec<Item>>) -> (impl FnMut() -> Events + Send, Arc<Mutex<usize>>) {
    let queue = Arc::new(Mutex::new(streams.into_iter().collect::<VecDeque<_>>()));
    let opened = Arc::new(Mutex::new(0));
    let count = opened.clone();
    let open = move || {
        *count.lock().unwrap() += 1;
        let items = queue.lock().unwrap().pop_front().unwrap_or_default();
        futures::stream::iter(items).chain(futures::stream::pending()).boxed()
    };
    (open, opened)
}

fn obj(name: &str, uid: &str) -> DynamicObject {
    ns(name, uid, "Active")
}

async fn collect(open: impl FnMut() -> Events + Send + 'static, wait: std::time::Duration) -> Vec<WatchMessage> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(run_with(open, namespaces(), Endpoint { public: true, private: false }, move |m| tx.send(m).is_ok()));
    tokio::time::sleep(wait).await;
    task.abort();
    let mut out = Vec::new();
    while let Ok(m) = rx.try_recv() {
        out.push(m);
    }
    out
}

#[tokio::test(start_paused = true)]
async fn a_non_fatal_error_after_the_list_restarts_with_a_fresh_list() {
    let (open, opened) = opener(vec![
        vec![Ok(Event::Init), Ok(Event::InitApply(obj("a", "1"))), Ok(Event::InitDone), Err(watcher::Error::NoResourceVersion)],
        vec![Ok(Event::Init), Ok(Event::InitApply(obj("a", "1"))), Ok(Event::InitApply(obj("b", "2"))), Ok(Event::InitDone)],
    ]);
    let got = collect(open, secs(5)).await;
    assert_eq!(*opened.lock().unwrap(), 2);
    let kinds: Vec<&str> = got
        .iter()
        .map(|m| match m {
            WatchMessage::Reset { .. } => "reset",
            WatchMessage::Changes { .. } => "changes",
            WatchMessage::Error { fatal: false, .. } => "error",
            WatchMessage::Error { fatal: true, .. } => "fatal",
        })
        .collect();
    assert_eq!(kinds, ["reset", "error", "reset"]);
    let Some(WatchMessage::Reset { rows }) = got.last() else { panic!() };
    assert_eq!(rows.len(), 2);
}

#[tokio::test(start_paused = true)]
async fn pending_changes_are_sent_before_the_error() {
    let (open, _) = opener(vec![vec![Ok(Event::Init), Ok(Event::InitDone), Ok(Event::Apply(obj("a", "1"))), Err(watcher::Error::NoResourceVersion)]]);
    let got = collect(open, secs(1)).await;
    assert!(matches!(got[1], WatchMessage::Changes { ref upserts, .. } if upserts.len() == 1), "{got:?}");
    assert!(matches!(got[2], WatchMessage::Error { fatal: false, .. }));
}

#[tokio::test(start_paused = true)]
async fn a_fatal_error_stops_without_reopening() {
    let (open, opened) = opener(vec![vec![Err(watcher::Error::WatchError(status(403)))]]);
    let got = collect(open, secs(120)).await;
    assert_eq!(*opened.lock().unwrap(), 1);
    assert_eq!(got.len(), 1);
    assert!(matches!(got[0], WatchMessage::Error { fatal: true, .. }));
}

#[tokio::test(start_paused = true)]
async fn repeated_errors_back_off_and_a_full_list_resets_the_wait() {
    let err = || vec![Err(watcher::Error::NoResourceVersion)];
    // 1초, 2초, 4초 기다린 뒤 네 번째 스트림이 목록을 끝낸다. 그 뒤 오류는 다시 1초만 기다린다.
    let (open, opened) = opener(vec![err(), err(), err(), vec![Ok(Event::Init), Ok(Event::InitDone), Err(watcher::Error::NoResourceVersion)], vec![]]);
    // 받는 쪽을 끝까지 쥐고 있어야 보내기가 실패하지 않는다
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(run_with(open, namespaces(), Endpoint { public: true, private: false }, move |m| tx.send(m).is_ok()));
    tokio::time::sleep(std::time::Duration::from_millis(6_500)).await; // 0 + 1 + 2 + 4 = 7초 전
    assert_eq!(*opened.lock().unwrap(), 3);
    tokio::time::sleep(secs(1)).await; // 7초: 네 번째가 열리고 목록 → 오류
    assert_eq!(*opened.lock().unwrap(), 4);
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await; // 1초 뒤 다섯 번째
    assert_eq!(*opened.lock().unwrap(), 5);
    task.abort();
}
