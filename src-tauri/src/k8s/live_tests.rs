//! 실제 kind 클러스터에 붙는 시험. 평소에는 건너뛰고 `scripts/k8s-live-test.sh`가 클러스터를 띄워 돌린다.
//! 환경: `K8S_LIVE_KUBECONFIG`(kind kubeconfig), `K8S_LIVE_BIN`(가짜 exec 플러그인 폴더), `K8S_LIVE_READER_TOKEN`, `K8S_LIVE_SLOW_ARM`.
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use kube::config::Kubeconfig;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::connect::{client_for, REQUEST_TIMEOUT};
use super::failure::{exec_missing, Endpoint, TLS_UNVERIFIED, UNAUTHORIZED, UNREACHABLE_PRIVATE};
use super::kubeconfig::{load, with_path};
use super::review::{identity, rules, IdentitySource};
use super::rows::KindRef;
use super::tls::install_crypto_provider;
use super::watch::{run, WatchMessage};
use crate::error::AppError;

const PRIVATE: Endpoint = Endpoint { public: false, private: true };

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name}이 필요해요. scripts/k8s-live-test.sh로 돌려 주세요"))
}

fn kubeconfig_path() -> PathBuf {
    PathBuf::from(env("K8S_LIVE_KUBECONFIG"))
}

fn bin() -> String {
    env("K8S_LIVE_BIN")
}

/// kind kubeconfig의 첫 context 이름과 JSON 꼴. 시험마다 사용자나 클러스터를 이 JSON에서 바꾼다.
fn base() -> (String, Value) {
    install_crypto_provider();
    let loaded = load(&[kubeconfig_path()]).expect("kind kubeconfig");
    let context = loaded.config.contexts[0].name.clone();
    (context, serde_json::to_value(&loaded.config).expect("kubeconfig to json"))
}

fn build(value: &Value) -> Kubeconfig {
    Kubeconfig::from_yaml(&value.to_string()).expect("kubeconfig from json")
}

fn set_user(value: &mut Value, user: Value) {
    value["users"][0]["user"] = user;
}

fn set_server(value: &mut Value, server: &str) {
    value["clusters"][0]["cluster"]["server"] = json!(server);
}

fn exec_user(command: &str) -> Value {
    json!({ "exec": { "command": command, "apiVersion": "client.authentication.k8s.io/v1beta1", "interactiveMode": "Never" } })
}

fn kubectl(args: &[&str]) {
    let out = Command::new("kubectl").arg("--kubeconfig").arg(kubeconfig_path()).args(args).output().expect("kubectl");
    assert!(out.status.success(), "kubectl {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// 연결해서 신원까지 물어본다. 연결 단계와 요청 단계 어느 쪽 오류든 그대로 돌려준다.
async fn open(value: &Value, context: &str, endpoint: Endpoint) -> Result<super::review::Identity, AppError> {
    let client = client_for(&build(value), context, endpoint).await?;
    identity(&client, "kind-user", endpoint).await
}

#[tokio::test]
#[ignore]
async fn connects_with_the_kind_context_and_reads_identity() {
    let (context, value) = base();
    let who = open(&value, &context, PRIVATE).await.unwrap();
    assert_eq!(who.source, IdentitySource::SelfSubjectReview);
    assert!(who.groups.iter().any(|g| g == "system:masters" || g == "kubeadm:cluster-admins"), "groups: {:?}", who.groups);
}

#[tokio::test]
#[ignore]
async fn exec_plugin_with_path_injection() {
    let (context, mut value) = base();
    set_user(&mut value, exec_user("fake-get-token"));
    let path = format!("{}:/usr/bin:/bin", bin());
    let config = with_path(&build(&value), &context, &path);
    let client = client_for(&config, &context, PRIVATE).await.unwrap();
    let who = identity(&client, "kind-user", PRIVATE).await.unwrap();
    assert_eq!(who.source, IdentitySource::SelfSubjectReview);

    // PATH를 넣지 않으면 플러그인을 찾지 못한다
    let err = client_for(&build(&value), &context, PRIVATE).await.err().expect("connect without PATH must fail");
    let AppError::Other { message } = err else { panic!("unexpected error: {err:?}") };
    assert_eq!(message, exec_missing("fake-get-token"));
}

#[tokio::test]
#[ignore]
async fn expired_sso_in_exec_output_is_sso_expired() {
    let (context, mut value) = base();
    set_user(&mut value, exec_user("expired-get-token"));
    let path = format!("{}:/usr/bin:/bin", bin());
    let config = with_path(&build(&value), &context, &path);
    let err = client_for(&config, &context, PRIVATE).await.err().expect("expired sso must fail");
    assert_eq!(err, AppError::SsoExpired);
}

#[tokio::test]
#[ignore]
async fn unreachable_endpoint_message() {
    let (context, mut value) = base();
    set_server(&mut value, "https://127.0.0.1:1");
    let started = std::time::Instant::now();
    let err = open(&value, &context, PRIVATE).await.unwrap_err();
    assert_eq!(err, AppError::Network { message: UNREACHABLE_PRIVATE.into() });
    assert!(started.elapsed() < Duration::from_secs(15), "took {:?}", started.elapsed());
}

#[tokio::test]
#[ignore]
async fn dns_failure_is_unreachable() {
    let (context, mut value) = base();
    set_server(&mut value, "https://no-such-host.invalid:6443");
    let err = open(&value, &context, PRIVATE).await.unwrap_err();
    assert_eq!(err, AppError::Network { message: UNREACHABLE_PRIVATE.into() });
}

#[tokio::test]
#[ignore]
async fn blackholed_endpoint_times_out_as_unreachable() {
    let (context, mut value) = base();
    // 아무도 답하지 않는 주소: 연결 제한(10초)에 걸리거나 경로가 없다는 오류가 곧바로 온다. 어느 쪽이든 Unreachable이어야 한다
    set_server(&mut value, "https://192.0.2.1:6443");
    let started = std::time::Instant::now();
    let err = open(&value, &context, PRIVATE).await.unwrap_err();
    assert_eq!(err, AppError::Network { message: UNREACHABLE_PRIVATE.into() });
    assert!(started.elapsed() < Duration::from_secs(20), "took {:?}", started.elapsed());
}

#[tokio::test]
#[ignore]
async fn wrong_ca_is_tls() {
    let (context, mut value) = base();
    let key = rcgen::KeyPair::generate().unwrap();
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    let ca = params.self_signed(&key).unwrap();
    // rcgen을 pem 기능 없이 쓰니 DER을 직접 PEM으로 감싼다
    let body = aws_smithy_types::base64::encode(ca.der().as_ref());
    let wrapped: Vec<&str> = body.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap()).collect();
    let pem = aws_smithy_types::base64::encode(format!("-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n", wrapped.join("\n")));
    value["clusters"][0]["cluster"]["certificate-authority-data"] = json!(pem);
    value["clusters"][0]["cluster"].as_object_mut().unwrap().remove("certificate-authority");
    let err = open(&value, &context, PRIVATE).await.unwrap_err();
    assert_eq!(err, AppError::other(TLS_UNVERIFIED));
}

#[tokio::test]
#[ignore]
async fn unknown_identity_is_unauthorized() {
    let (context, mut value) = base();
    set_user(&mut value, json!({ "token": "nope" }));
    let err = open(&value, &context, PRIVATE).await.unwrap_err();
    assert_eq!(err, AppError::other(UNAUTHORIZED));
}

fn reader_config() -> (String, Value) {
    let (context, mut value) = base();
    set_user(&mut value, json!({ "token": env("K8S_LIVE_READER_TOKEN") }));
    (context, value)
}

#[tokio::test]
#[ignore]
async fn rules_for_a_limited_service_account() {
    let (context, value) = reader_config();
    let client = client_for(&build(&value), &context, PRIVATE).await.unwrap();
    let got = rules(&client, "mm-live", PRIVATE).await.unwrap();
    let pods = got.resource_rules.iter().find(|r| r.resources.iter().any(|x| x == "pods")).expect("a rule for pods");
    assert!(pods.verbs.iter().any(|v| v == "list"), "verbs: {:?}", pods.verbs);
    assert!(!pods.verbs.iter().any(|v| v == "delete" || v == "*"), "verbs: {:?}", pods.verbs);
}

fn namespaces() -> KindRef {
    KindRef { group: String::new(), version: "v1".into(), kind: "Namespace".into(), plural: "namespaces".into(), namespaced: false }
}

async fn recv(rx: &mut mpsc::UnboundedReceiver<WatchMessage>, limit: Duration) -> Option<WatchMessage> {
    tokio::time::timeout(limit, rx.recv()).await.ok().flatten()
}

#[tokio::test]
#[ignore]
async fn watch_streams_reset_then_changes() {
    let (context, value) = base();
    let client = client_for(&build(&value), &context, PRIVATE).await.unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(run(client, namespaces(), None, PRIVATE, move |m| tx.send(m).is_ok()));

    let Some(WatchMessage::Reset { rows }) = recv(&mut rx, Duration::from_secs(10)).await else { panic!("expected a reset first") };
    assert!(rows.iter().any(|r| r.name == "kube-system"));

    kubectl(&["create", "namespace", "mm-live-watch"]);
    let mut uid = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while uid.is_none() {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match recv(&mut rx, left).await {
            Some(WatchMessage::Changes { upserts, .. }) => uid = upserts.iter().find(|r| r.name == "mm-live-watch").map(|r| r.uid.clone()),
            Some(_) => {}
            None => panic!("no change for mm-live-watch within 10 s"),
        }
    }
    let uid = uid.unwrap();

    kubectl(&["delete", "namespace", "mm-live-watch", "--wait=false"]);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match recv(&mut rx, left).await {
            Some(WatchMessage::Changes { deletes, .. }) if deletes.contains(&uid) => break,
            Some(_) => {}
            None => panic!("no delete for {uid} within 90 s"),
        }
    }
    task.abort();
}

#[tokio::test]
#[ignore]
async fn watch_forbidden_is_fatal() {
    let (context, value) = reader_config();
    let client = client_for(&build(&value), &context, PRIVATE).await.unwrap();
    let secrets = KindRef { group: String::new(), version: "v1".into(), kind: "Secret".into(), plural: "secrets".into(), namespaced: true };
    let (tx, mut rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(run(client, secrets, None, PRIVATE, move |m| tx.send(m).is_ok()));
    let first = recv(&mut rx, Duration::from_secs(20)).await;
    assert_eq!(first, Some(WatchMessage::Error { error: AppError::AccessDenied { action: "list secrets".into() }, fatal: true }));
    tokio::time::timeout(Duration::from_secs(5), task).await.expect("run returns after a fatal error").unwrap();
}

/// 토큰이 이미 만료된 것으로 돌려주는 exec 플러그인은 요청마다 다시 돈다. 연결 뒤에는 40초 멈추니,
/// 목록 요청이 걸려 있는 동안 watch가 `REQUEST_TIMEOUT` 안에 멈춘 목록을 한 번 알려야 한다.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn watch_reports_a_list_that_stalls() {
    let (context, mut value) = base();
    set_user(&mut value, exec_user("slow-get-token"));
    let path = format!("{}:/usr/bin:/bin", bin());
    let config = with_path(&build(&value), &context, &path);
    let arm = env("K8S_LIVE_SLOW_ARM");
    let _ = std::fs::remove_file(&arm);
    let client = client_for(&config, &context, PRIVATE).await.unwrap();
    // 연결이 끝난 뒤부터 플러그인이 멈춘다
    std::fs::write(&arm, "").unwrap();
    // 이 플러그인의 신원은 reader라서 mm-live의 pods만 읽을 수 있다
    let pods = KindRef { group: String::new(), version: "v1".into(), kind: "Pod".into(), plural: "pods".into(), namespaced: true };
    let (tx, mut rx) = mpsc::unbounded_channel();
    let started = tokio::time::Instant::now();
    let task = tokio::spawn(run(client, pods, Some("mm-live".into()), PRIVATE, move |m| tx.send(m).is_ok()));
    let first = recv(&mut rx, REQUEST_TIMEOUT + Duration::from_secs(5)).await;
    assert_eq!(first, Some(WatchMessage::Error { error: AppError::Network { message: UNREACHABLE_PRIVATE.into() }, fatal: false }));
    assert!(started.elapsed() >= REQUEST_TIMEOUT - Duration::from_secs(1), "reported after {:?}", started.elapsed());
    assert!(!task.is_finished(), "the run keeps going after a non-fatal error");
    // 이미 멈춘 한 번이 깨어나면(40초) 목록이 이어져 Reset이 온다. 그 뒤 요청은 다시 멈추지 않게 푼다
    std::fs::remove_file(&arm).unwrap();
    loop {
        match recv(&mut rx, Duration::from_secs(30)).await {
            Some(WatchMessage::Reset { .. }) => break,
            Some(other) => eprintln!("while waiting for reset: {other:?}"),
            None => panic!("no reset after the plugin woke up"),
        }
    }
    task.abort();
}
