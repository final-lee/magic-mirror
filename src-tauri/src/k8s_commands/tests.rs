use kube::{Client, Config};

use super::*;
use crate::k8s::tls::install_crypto_provider;

fn target(profile: &str) -> K8sTarget {
    K8sTarget { profile: profile.into(), region: "ap-northeast-2".into(), cluster: "prod".into() }
}

/// 쓰이지 않는 로컬 주소를 가리키는 클라이언트. 요청은 한 번도 보내지 않는다.
fn session(context: &str) -> Session {
    install_crypto_provider();
    let client = Client::try_from(Config::new("http://127.0.0.1:9".parse().unwrap())).unwrap();
    Session { client, endpoint: Endpoint { public: true, private: false }, context: context.into() }
}

#[tokio::test]
async fn keep_after_close_with_the_old_epoch_is_refused() {
    let state = K8sState::default();
    let t = target("a");
    let started = state.epoch(&t);
    state.close(&t);
    assert!(!state.keep(&t, started, session("ctx")));
    assert_eq!(state.session(&t).err(), Some(AppError::other(NOT_OPENED)));
}

#[tokio::test]
async fn keep_with_the_current_epoch_stores_and_close_removes() {
    let state = K8sState::default();
    let t = target("a");
    assert!(state.keep(&t, state.epoch(&t), session("ctx")));
    assert_eq!(state.session(&t).unwrap().context, "ctx");
    state.close(&t);
    assert_eq!(state.session(&t).err(), Some(AppError::other(NOT_OPENED)));
    assert_eq!(state.epoch(&t), 1);
}

#[tokio::test]
async fn targets_differing_only_by_profile_are_independent() {
    let state = K8sState::default();
    let (a, b) = (target("a"), target("b"));
    assert!(state.keep(&a, 0, session("ctx-a")));
    assert!(state.keep(&b, 0, session("ctx-b")));
    state.close(&a);
    assert!(state.session(&a).is_err());
    assert_eq!(state.session(&b).unwrap().context, "ctx-b");
    assert_eq!(state.epoch(&b), 0);
}

#[test]
fn context_info_json_keys_match_the_ts_contract() {
    let info = K8sContextInfo {
        arn: "a".into(),
        endpoint: "e".into(),
        version: "1.33".into(),
        endpoint_public: true,
        endpoint_private: false,
        public_cidrs: vec!["0.0.0.0/0".into()],
        kubeconfig_paths: vec!["/h/.kube/config".into()],
        kubeconfig_missing: false,
        candidates: vec![Candidate { name: "n".into(), cluster: "c".into(), user: "u".into(), namespace: None, exec_profile: Some("p".into()) }],
        chosen: Some("n".into()),
        saved_missing: None,
        update_command: "cmd".into(),
    };
    let v = serde_json::to_value(info).unwrap();
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["arn", "candidates", "chosen", "endpoint", "endpointPrivate", "endpointPublic", "kubeconfigMissing", "kubeconfigPaths", "publicCidrs", "savedMissing", "updateCommand", "version"]
    );
    assert_eq!(v["candidates"][0]["execProfile"], "p");
    assert_eq!(v["candidates"][0]["namespace"], serde_json::Value::Null);
}

#[test]
fn session_json_keys_match_the_ts_contract() {
    let s = K8sSession {
        context: "ctx".into(),
        exec_profile: None,
        identity: Identity { username: "u".into(), groups: vec![], arn: None, source: review::IdentitySource::Kubeconfig },
        server_version: "v1.33.1".into(),
    };
    let v = serde_json::to_value(s).unwrap();
    assert_eq!(v, serde_json::json!({ "context": "ctx", "execProfile": null, "identity": { "username": "u", "groups": [], "arn": null, "source": "kubeconfig" }, "serverVersion": "v1.33.1" }));
}

#[test]
fn missing_only_when_no_path_is_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let absent = dir.path().join("none");
    let present = dir.path().join("config");
    std::fs::write(&present, "").unwrap();
    assert!(none_exists(std::slice::from_ref(&absent)));
    assert!(none_exists(&[]));
    assert!(!none_exists(&[absent, present]));
}

fn pending() -> tokio::task::JoinHandle<()> {
    tokio::spawn(std::future::pending::<()>())
}

#[tokio::test]
async fn close_aborts_only_that_targets_watches() {
    let state = K8sState::default();
    let (a, b) = (target("a"), target("b"));
    let (ha, hb) = (pending(), pending());
    let (ca, cb) = (ha.abort_handle(), hb.abort_handle());
    let ia = state.register_watch(&a, 0, |_| ca).unwrap();
    let ib = state.register_watch(&b, 0, |_| cb).unwrap();
    assert_ne!(ia, ib);
    state.close(&a);
    assert!(ha.await.unwrap_err().is_cancelled());
    tokio::task::yield_now().await;
    assert!(!hb.is_finished());
    state.unwatch(ib);
    assert!(hb.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn keep_over_an_existing_session_aborts_only_that_targets_watches() {
    install_crypto_provider();
    let state = K8sState::default();
    let (a, b) = (target("a"), target("b"));
    assert!(state.keep(&a, 0, session("one")));
    let (ha, hb) = (pending(), pending());
    let (ca, cb) = (ha.abort_handle(), hb.abort_handle());
    let ia = state.register_watch(&a, 0, |_| ca).unwrap();
    let ib = state.register_watch(&b, 0, |_| cb).unwrap();
    assert!(state.keep(&a, 0, session("two")));
    assert!(ha.await.unwrap_err().is_cancelled());
    assert_eq!(state.session(&a).unwrap().context, "two");
    tokio::task::yield_now().await;
    assert!(!hb.is_finished());
    // 잊혔으니 다시 멈추는 것은 아무 일도 아니다
    state.unwatch(ia);
    state.unwatch(ib);
    assert!(hb.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn register_after_close_with_the_old_epoch_is_refused() {
    let state = K8sState::default();
    let t = target("a");
    let started = state.epoch(&t);
    state.close(&t);
    assert_eq!(state.register_watch(&t, started, |_| unreachable!("must not spawn")), None);
}

#[tokio::test]
async fn unwatch_of_an_unknown_id_is_a_no_op_and_forget_does_not_abort() {
    let state = K8sState::default();
    state.unwatch(99);
    let t = target("a");
    let h = pending();
    let c = h.abort_handle();
    let id = state.register_watch(&t, 0, |_| c).unwrap();
    state.forget_watch(id);
    state.unwatch(id);
    tokio::task::yield_now().await;
    assert!(!h.is_finished());
    h.abort();
}

fn running_terminal(dir: &std::path::Path) -> (Terminal, std::path::PathBuf) {
    let (path, _) = lnav::log_file(dir).unwrap();
    let s = lnav::spawn(std::path::Path::new("/bin/sleep"), &[std::path::Path::new("600")], 80, 24, "/usr/bin:/bin").unwrap();
    // 출력은 읽지 않아도 된다(sleep은 아무것도 쓰지 않는다)
    drop(s.reader);
    (Terminal { input: lnav::input_worker(s.writer), master: s.master, cleanup: Cleanup::new(s.child, path.clone()) }, path)
}

#[test]
fn shutdown_ends_every_lnav_and_removes_its_log_file_before_returning() {
    let dir = tempfile::tempdir().unwrap();
    let k8s = K8sState::default();
    let (a, pa) = running_terminal(dir.path());
    let (b, pb) = running_terminal(dir.path());
    k8s.put_terminal(1, a);
    k8s.put_terminal(2, b);
    k8s.shutdown();
    assert!(!pa.exists() && !pb.exists());
    assert!(locked(&k8s.terminals).is_empty());
    // 끝난 흐름의 입력·크기 조절은 조용히 버린다
    k8s.terminal_input(1, b"q");
    k8s.terminal_resize(2, 100, 30);
}

#[test]
fn forgetting_a_terminal_ends_its_lnav_and_removes_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let k8s = K8sState::default();
    let (t, path) = running_terminal(dir.path());
    k8s.put_terminal(7, t);
    k8s.forget_terminal(7);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while path.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(!path.exists());
}
