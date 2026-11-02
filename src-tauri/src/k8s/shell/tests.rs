use std::sync::{Arc, Mutex};

use futures::channel::mpsc as fmpsc;
use futures::StreamExt;
use serde_json::json;
use tokio::io::{duplex, AsyncWriteExt};

use super::*;

fn pod(containers: serde_json::Value, statuses: serde_json::Value) -> Pod {
    serde_json::from_value(json!({
        "metadata": { "name": "web-1", "namespace": "dev" },
        "spec": { "containers": containers },
        "status": { "containerStatuses": statuses },
    }))
    .unwrap()
}

fn running(name: &str) -> serde_json::Value {
    json!({ "name": name, "image": "i", "imageID": "", "ready": true, "restartCount": 0, "state": { "running": {} } })
}

fn status(value: serde_json::Value) -> Status {
    serde_json::from_value(value).unwrap()
}

fn collect() -> (Arc<Mutex<Vec<ShellMessage>>>, impl FnMut(ShellMessage) -> bool + Send) {
    let got = Arc::new(Mutex::new(Vec::new()));
    let sink = got.clone();
    (got, move |m| {
        sink.lock().unwrap().push(m);
        true
    })
}

fn out(data: &str) -> ShellMessage {
    ShellMessage::Output { data: data.into() }
}

#[test]
fn only_kube_system_and_prod_namespaces_need_the_pod_name_typed() {
    assert!(needs_typed_name("kube-system"));
    assert!(needs_typed_name("shop-prod"));
    assert!(needs_typed_name("Prod-api"));
    assert!(!needs_typed_name("dev"));
    assert!(!needs_typed_name("kube-public"));
}

#[test]
fn a_dangerous_namespace_opens_only_with_the_exact_pod_name() {
    assert!(check_confirm("dev", "web-1", None).is_ok());
    assert_eq!(check_confirm("kube-system", "coredns", None), Err(AppError::other(CONFIRM_MISMATCH)));
    assert_eq!(check_confirm("kube-system", "coredns", Some("")), Err(AppError::other(CONFIRM_MISMATCH)));
    assert_eq!(check_confirm("prod", "web-1", Some("web")), Err(AppError::other(CONFIRM_MISMATCH)));
    assert!(check_confirm("prod", "web-1", Some("web-1")).is_ok());
}

#[test]
fn exec_always_takes_input_on_a_tty_without_a_separate_stderr() {
    let p = pod(json!([{ "name": "app", "image": "i" }]), json!([running("app")]));
    let plan = plan_of(ShellMode::Exec, &p, "app").unwrap();
    assert!(plan.input && plan.params.stdin && plan.params.tty && !plan.params.stderr);
    assert_eq!(plan.params.container.as_deref(), Some("app"));
}

#[test]
fn attach_takes_input_only_when_the_container_has_stdin_and_tty() {
    let both = pod(json!([{ "name": "app", "image": "i", "stdin": true, "tty": true }]), json!([running("app")]));
    let plan = plan_of(ShellMode::Attach, &both, "app").unwrap();
    assert!(plan.input && plan.params.stdin && plan.params.tty && !plan.params.stderr);

    let stdin_only = pod(json!([{ "name": "app", "image": "i", "stdin": true }]), json!([running("app")]));
    let plan = plan_of(ShellMode::Attach, &stdin_only, "app").unwrap();
    assert!(!plan.input && !plan.params.stdin && !plan.params.tty && plan.params.stderr);

    let tty_only = pod(json!([{ "name": "app", "image": "i", "tty": true }]), json!([running("app")]));
    let plan = plan_of(ShellMode::Attach, &tty_only, "app").unwrap();
    assert!(!plan.input && !plan.params.stdin && plan.params.tty && !plan.params.stderr);

    let plain = pod(json!([{ "name": "app", "image": "i" }]), json!([running("app")]));
    assert!(!plan_of(ShellMode::Attach, &plain, "app").unwrap().input);
}

#[test]
fn a_missing_or_stopped_container_is_refused() {
    let waiting = json!([{ "name": "app", "image": "i", "imageID": "", "ready": false, "restartCount": 0, "state": { "waiting": { "reason": "CrashLoopBackOff" } } }]);
    let p = pod(json!([{ "name": "app", "image": "i" }]), waiting);
    assert_eq!(plan_of(ShellMode::Exec, &p, "app").unwrap_err(), AppError::other(NOT_RUNNING));
    assert_eq!(plan_of(ShellMode::Exec, &p, "other").unwrap_err(), AppError::other(NO_SUCH_CONTAINER));
    let no_status = pod(json!([{ "name": "app", "image": "i" }]), json!([]));
    assert_eq!(plan_of(ShellMode::Exec, &no_status, "app").unwrap_err(), AppError::other(NOT_RUNNING));
}

#[test]
fn decoding_keeps_a_character_split_across_chunks() {
    let mut carry = Vec::new();
    let euro = "€".as_bytes();
    assert_eq!(decode_chunk(&mut carry, &[b'a', euro[0], euro[1]]), "a");
    assert_eq!(decode_chunk(&mut carry, &[euro[2], b'b']), "€b");
    assert!(carry.is_empty());
}

#[test]
fn decoding_replaces_broken_bytes_and_goes_on() {
    let mut carry = Vec::new();
    assert_eq!(decode_chunk(&mut carry, &[b'a', 0xff, b'b', 0xfe, b'c']), "a\u{fffd}b\u{fffd}c");
    assert!(carry.is_empty());
}

#[test]
fn exit_codes_come_from_the_status() {
    assert_eq!(exit_of(Some(&status(json!({ "status": "Success" })))), (Some(0), None));
    let failed = json!({
        "status": "Failure", "reason": "NonZeroExitCode", "message": "command terminated with non-zero exit code: Error executing in Docker Container: 3",
        "details": { "causes": [{ "reason": "ExitCode", "message": "3" }] },
    });
    assert_eq!(exit_of(Some(&status(failed))), (Some(3), None));
    let unstarted = json!({ "status": "Failure", "message": "OCI runtime exec failed: \"/bin/zsh\": no such file\nmore", "reason": "InternalError" });
    assert_eq!(exit_of(Some(&status(unstarted))), (None, Some("OCI runtime exec failed: \"/bin/zsh\": no such file".into())));
    assert_eq!(exit_of(None), (None, None));
}

#[tokio::test]
async fn pump_streams_output_then_the_exit_code_after_the_output_drains() {
    let (mut remote, stdout) = duplex(64);
    let (got, send) = collect();
    // 상태가 출력보다 먼저 와도 남은 출력은 Exit 앞에 나간다
    let status = async { Some(status(json!({ "status": "Success" }))) };
    let feed = async move {
        remote.write_all(b"hello ").await.unwrap();
        remote.write_all("세계\n".as_bytes()).await.unwrap();
        drop(remote);
    };
    let (_, ()) = tokio::join!(pump(Some(stdout), None::<tokio::io::Empty>, status, send), feed);
    let got = got.lock().unwrap();
    let text: String = got.iter().filter_map(|m| if let ShellMessage::Output { data } = m { Some(data.as_str()) } else { None }).collect();
    assert_eq!(text, "hello 세계\n");
    assert_eq!(got.last(), Some(&ShellMessage::Exit { code: Some(0), reason: None }));
}

#[tokio::test]
async fn pump_merges_stderr_when_the_container_has_no_tty() {
    let (mut o, stdout) = duplex(64);
    let (mut e, stderr) = duplex(64);
    let (got, send) = collect();
    let status = async { Some(status(json!({ "status": "Failure", "details": { "causes": [{ "reason": "ExitCode", "message": "1" }] } }))) };
    let feed = async move {
        o.write_all(b"out").await.unwrap();
        e.write_all(b"err").await.unwrap();
    };
    let (_, ()) = tokio::join!(pump(Some(stdout), Some(stderr), status, send), feed);
    let got = got.lock().unwrap();
    assert!(got.contains(&out("out")) && got.contains(&out("err")));
    assert_eq!(got.last(), Some(&ShellMessage::Exit { code: Some(1), reason: None }));
}

#[tokio::test]
async fn pump_reports_a_dropped_connection_as_an_exit_without_a_code() {
    let (remote, stdout) = duplex(64);
    drop(remote);
    let (got, send) = collect();
    pump(Some(stdout), None::<tokio::io::Empty>, async { None }, send).await;
    assert_eq!(*got.lock().unwrap(), [ShellMessage::Exit { code: None, reason: None }]);
}

#[tokio::test(start_paused = true)]
async fn pump_does_not_wait_forever_for_output_after_the_process_ended() {
    // 원격 쪽을 열어 둔 채 상태만 온다
    let (_remote, stdout) = duplex(64);
    let (got, send) = collect();
    pump(Some(stdout), None::<tokio::io::Empty>, async { Some(status(json!({ "status": "Success" }))) }, send).await;
    assert_eq!(*got.lock().unwrap(), [ShellMessage::Exit { code: Some(0), reason: None }]);
}

#[tokio::test]
async fn pump_stops_when_the_screen_drops_the_channel() {
    let (mut remote, stdout) = duplex(64);
    remote.write_all(b"x").await.unwrap();
    let mut calls = 0;
    pump(Some(stdout), None::<tokio::io::Empty>, std::future::pending(), |_| {
        calls += 1;
        false
    })
    .await;
    assert_eq!(calls, 1);
}

#[tokio::test]
async fn input_is_written_in_order_and_resizes_reach_the_terminal() {
    let (stdin, mut remote) = duplex(64);
    let (size_tx, mut size_rx) = fmpsc::channel::<TerminalSize>(4);
    let (tx, rx) = mpsc::unbounded_channel();
    tx.send(Input::Data(b"ls\n".to_vec())).unwrap();
    tx.send(Input::Resize { cols: 100, rows: 30 }).unwrap();
    tx.send(Input::Resize { cols: 0, rows: 30 }).unwrap();
    tx.send(Input::Data("é".as_bytes().to_vec())).unwrap();
    drop(tx);
    write_input(rx, Some(stdin), Some(size_tx)).await;
    let mut written = Vec::new();
    tokio::io::AsyncReadExt::read_to_end(&mut remote, &mut written).await.unwrap();
    assert_eq!(written, "ls\né".as_bytes());
    let first = size_rx.next().await.unwrap();
    assert_eq!((first.width, first.height), (100, 30));
    // 0 크기는 보내지 않는다
    assert!(size_rx.next().await.is_none());
}

#[tokio::test]
async fn an_output_only_session_drops_keystrokes() {
    let (tx, rx) = mpsc::unbounded_channel();
    tx.send(Input::Data(b"rm -rf /\n".to_vec())).unwrap();
    drop(tx);
    // 쓸 곳이 없어도 끝까지 돌고 끝난다
    write_input(rx, None::<tokio::io::DuplexStream>, None::<fmpsc::Sender<TerminalSize>>).await;
}

fn info(namespace: &str) -> ShellTarget {
    let target = K8sTarget { profile: "p".into(), region: "r".into(), cluster: "c".into() };
    ShellTarget { target, namespace: namespace.into(), pod: "web-1".into(), container: "app".into(), mode: ShellMode::Exec }
}

fn temp_log(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mm-shell-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir.join(RECORD_FILE)
}

fn records(log: &Path) -> Vec<ShellRecord> {
    crate::jsonl::read_all(log)
}

#[tokio::test]
async fn closing_a_session_records_when_it_opened_and_closed_and_nothing_else() {
    let shells = Arc::new(Shells::default());
    let log = temp_log("close");
    let opened = shells.register(&log, info("dev"), true, |mut rx| async move { while rx.recv().await.is_some() {} }).unwrap();
    assert!(opened.input);
    let rows = records(&log);
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].namespace.as_str(), rows[0].pod.as_str(), rows[0].container.as_str(), rows[0].mode), ("dev", "web-1", "app", ShellMode::Exec));
    assert!(rows[0].closed_at.is_none());
    shells.close(opened.id);
    let rows = records(&log);
    assert!(rows[0].closed_at.is_some());
    // 닫은 뒤 입력과 두 번째 닫기는 아무 일도 없다
    shells.input(opened.id, "x".into());
    shells.close(opened.id);
    assert_eq!(records(&log).len(), 1);
    let _ = std::fs::remove_dir_all(log.parent().unwrap());
}

#[tokio::test]
async fn a_session_that_ends_by_itself_is_forgotten_and_recorded_as_closed() {
    let shells = Arc::new(Shells::default());
    let log = temp_log("ends");
    shells.register(&log, info("dev"), false, |_rx| async {}).unwrap();
    for _ in 0..100 {
        if locked(&shells.entries).is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(locked(&shells.entries).is_empty());
    assert!(records(&log)[0].closed_at.is_some());
    let _ = std::fs::remove_dir_all(log.parent().unwrap());
}

#[tokio::test]
async fn input_and_resize_reach_the_session_that_owns_the_id() {
    let shells = Arc::new(Shells::default());
    let log = temp_log("route");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let a = shells
        .register(&log, info("dev"), true, move |mut rx| async move {
            while let Some(i) = rx.recv().await {
                sink.lock().unwrap().push(i);
            }
        })
        .unwrap();
    let b = shells.register(&log, info("dev"), true, |mut rx| async move { while rx.recv().await.is_some() {} }).unwrap();
    assert_ne!(a.id, b.id);
    shells.input(a.id, "ls\n".into());
    shells.resize(a.id, 80, 24);
    for _ in 0..100 {
        if seen.lock().unwrap().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(*seen.lock().unwrap(), [Input::Data(b"ls\n".to_vec()), Input::Resize { cols: 80, rows: 24 }]);
    shells.close_all();
    let _ = std::fs::remove_dir_all(log.parent().unwrap());
}

#[tokio::test]
async fn closing_a_target_closes_only_its_sessions() {
    let shells = Arc::new(Shells::default());
    let log = temp_log("target");
    let mine = info("dev");
    let mut other = info("dev");
    other.target.cluster = "other".into();
    shells.register(&log, mine.clone(), true, |mut rx| async move { while rx.recv().await.is_some() {} }).unwrap();
    shells.register(&log, other.clone(), true, |mut rx| async move { while rx.recv().await.is_some() {} }).unwrap();
    shells.close_target(&mine.target);
    assert_eq!(locked(&shells.entries).len(), 1);
    assert!(locked(&shells.entries).values().all(|e| e.target == other.target));
    shells.close_all();
    assert!(locked(&shells.entries).is_empty());
    assert!(records(&log).iter().all(|r| r.closed_at.is_some()));
    let _ = std::fs::remove_dir_all(log.parent().unwrap());
}

#[tokio::test]
async fn a_session_is_not_opened_when_its_record_cannot_be_written() {
    let shells = Arc::new(Shells::default());
    // 폴더 자리에 파일이 있어 기록 파일을 만들 수 없다
    let blocker = std::env::temp_dir().join(format!("mm-shell-blocker-{}", std::process::id()));
    std::fs::write(&blocker, b"x").unwrap();
    let res = shells.register(&blocker.join(RECORD_FILE), info("dev"), true, |_rx| async {});
    assert_eq!(res.unwrap_err(), AppError::other(RECORD_FAILED));
    assert!(locked(&shells.entries).is_empty());
    let _ = std::fs::remove_file(blocker);
}
