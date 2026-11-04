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
use super::logs::{self, LogMessage, LogOptions};
use super::review::{identity, rules, IdentitySource};
use super::rows::KindRef;
use super::read::api_for;
use super::read::detail::{get, ContainerState};
use super::read::kinds::{discover, kinds_of};
use super::read::metrics::{metrics, Unavailable};
use super::read::overview::k8s_parts;
use super::read::secret::{key_missing, secret_value, secrets_kind, Encoding, SecretKey, SecretValue, MASK};
use super::read::values::Problem;
use super::tls::install_crypto_provider;
use super::watch::{run, WatchMessage};
use crate::error::AppError;

mod access;
mod helm;

const PRIVATE: Endpoint = Endpoint { public: false, private: true };

mod network;
mod rbac;
mod security;
mod terminal;

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

fn kind_ref(group: &str, version: &str, kind: &str, plural: &str) -> KindRef {
    KindRef { group: group.into(), version: version.into(), kind: kind.into(), plural: plural.into(), namespaced: true }
}

async fn admin() -> kube::Client {
    let (context, value) = base();
    client_for(&build(&value), &context, PRIVATE).await.unwrap()
}

#[tokio::test]
#[ignore]
async fn discovery_lists_builtin_and_custom_kinds() {
    let client = admin().await;
    let kinds = kinds_of(&discover(&client, PRIVATE).await.unwrap());
    let find = |g: &str, k: &str| kinds.iter().find(|x| x.kind.group == g && x.kind.kind == k).cloned();
    let deploy = find("apps", "Deployment").expect("Deployment");
    assert!(!deploy.custom && deploy.kind.namespaced && deploy.kind.plural == "deployments");
    assert!(find("mm.example.com", "Widget").expect("Widget").custom);
    assert!(find("", "Pod").is_some() && find("", "Node").is_some_and(|n| !n.kind.namespaced));
}

#[tokio::test]
#[ignore]
async fn discovery_kinds_can_be_listed_in_the_watch() {
    let client = admin().await;
    let kinds = kinds_of(&discover(&client, PRIVATE).await.unwrap());
    for (group, name) in [("coordination.k8s.io", "Lease"), ("rbac.authorization.k8s.io", "ClusterRole"), ("discovery.k8s.io", "EndpointSlice")] {
        let kind = kinds.iter().find(|k| k.kind.group == group && k.kind.kind == name).expect("served kind").kind.clone();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(client.clone(), kind, None, PRIVATE, move |m| tx.send(m).is_ok()));
        assert!(matches!(recv(&mut rx, Duration::from_secs(15)).await, Some(WatchMessage::Reset { .. })), "{name} list");
        task.abort();
    }
}

#[tokio::test]
#[ignore]
async fn deployment_owns_a_replicaset_that_owns_a_pod() {
    let client = admin().await;
    let d = get(&client, &kind_ref("apps", "v1", "Deployment", "deployments"), Some("mm-k2"), "web", PRIVATE).await.unwrap();
    assert_eq!(d.containers[0].state, ContainerState::Template);
    assert!(d.children_error.is_none() && d.events_error.is_none());
    let rs = d.children.first().expect("a ReplicaSet child").clone();
    assert_eq!(rs.kind, "ReplicaSet");
    let rs_view = get(&client, &kind_ref("apps", "v1", "ReplicaSet", "replicasets"), Some("mm-k2"), &rs.name, PRIVATE).await.unwrap();
    assert!(rs_view.owners.iter().any(|o| o.kind == "Deployment" && o.name == "web" && o.controller));
    let pod = rs_view.children.first().expect("a Pod child").clone();
    let pod_view = get(&client, &kind_ref("", "v1", "Pod", "pods"), Some("mm-k2"), &pod.name, PRIVATE).await.unwrap();
    assert!(pod_view.owners.iter().any(|o| o.uid == rs_view.row.uid));
    assert!(!pod_view.yaml.contains("managedFields"));
}

#[tokio::test]
#[ignore]
async fn secret_is_masked_in_detail_and_readable_by_key() {
    let client = admin().await;
    let v = get(&client, &secrets_kind(), Some("mm-k2"), "db", PRIVATE).await.unwrap();
    let all = serde_json::to_string(&v).unwrap();
    assert!(!all.contains("hunter2") && !all.contains("aHVudGVyMg=="), "{all}");
    assert!(v.yaml.contains(MASK));
    assert_eq!(v.secret_keys, Some(vec![SecretKey { key: "password".into(), size: 7 }]));
    assert_eq!(secret_value(&client, "mm-k2", "db", "password", PRIVATE).await.unwrap(), SecretValue { text: "hunter2".into(), encoding: Encoding::Utf8 });
    assert_eq!(secret_value(&client, "mm-k2", "db", "nope", PRIVATE).await.unwrap_err(), AppError::other(key_missing("nope")));
}

#[tokio::test]
#[ignore]
async fn a_reader_without_secret_access_is_denied() {
    let (context, value) = reader_config();
    let client = client_for(&build(&value), &context, PRIVATE).await.unwrap();
    assert_eq!(secret_value(&client, "mm-live", "any", "k", PRIVATE).await.unwrap_err(), AppError::AccessDenied { action: "get secrets".into() });
}

#[tokio::test]
#[ignore]
async fn broken_pod_is_flagged_in_the_watch_and_has_warning_events() {
    let client = admin().await;
    let pods = kind_ref("", "v1", "Pod", "pods");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(run(client.clone(), pods.clone(), Some("mm-k2".into()), PRIVATE, move |m| tx.send(m).is_ok()));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match recv(&mut rx, left).await {
            Some(WatchMessage::Reset { rows }) | Some(WatchMessage::Changes { upserts: rows, .. })
                if rows.iter().any(|r| r.name == "broken" && r.problems.contains(&Problem::ImagePullBackOff)) =>
            {
                break
            }
            Some(_) => {}
            None => panic!("broken never showed imagePullBackOff within 120 s"),
        }
    }
    task.abort();
    // 상태가 보인 뒤에 Event가 목록에 나타나기까지는 따로 걸릴 수 있으니 제한 시간 안에서 기다린다
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let v = get(&client, &pods, Some("mm-k2"), "broken", PRIVATE).await.unwrap();
        if v.events.iter().any(|e| e.type_ == "Warning") {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "no Warning event for broken within 60 s: {:?}", v.events);
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[tokio::test]
#[ignore]
async fn overview_kubernetes_part_reads_nodes_and_requests() {
    let client = admin().await;
    let parts = k8s_parts(&client, Some("1.33"), PRIVATE).await;
    assert!(!parts.nodes.unwrap().is_empty());
    let (allocated, partial) = parts.allocated.unwrap();
    assert!(!partial);
    // coredns가 CPU를 요청한다
    assert!(allocated.values().any(|a| a.requested.cpu_milli > 0 && a.requested.pods > 0), "{allocated:?}");
    // kind에는 metrics-server와 Karpenter가 없다
    assert_eq!(parts.usage.unwrap(), None);
    assert_eq!(parts.node_pools.unwrap(), None);
    assert_eq!(parts.removed.unwrap(), Some(vec![]));
}

/// coredns Pod 하나의 이름(kind에는 늘 있고 로그를 남긴다)
async fn coredns_pod(client: &kube::Client) -> String {
    use k8s_openapi::api::core::v1::Pod;
    let pods: kube::Api<Pod> = kube::Api::namespaced(client.clone(), "kube-system");
    let list = pods.list(&kube::api::ListParams::default().labels("k8s-app=kube-dns")).await.unwrap();
    list.items.first().and_then(|p| p.metadata.name.clone()).expect("a coredns pod")
}

async fn recv_log(rx: &mut mpsc::UnboundedReceiver<LogMessage>, limit: Duration) -> Option<LogMessage> {
    tokio::time::timeout(limit, rx.recv()).await.ok().flatten()
}

#[tokio::test]
#[ignore]
async fn logs_read_the_last_lines_then_end() {
    let client = admin().await;
    let pod = coredns_pod(&client).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let opts = LogOptions { tail_lines: Some(3), ..Default::default() };
    logs::run(client, "kube-system".into(), pod, opts, PRIVATE, move |m| tx.send(m).is_ok()).await;
    let mut count = 0;
    while let Some(message) = recv_log(&mut rx, Duration::from_secs(5)).await {
        match message {
            LogMessage::Lines { lines, .. } => { count += lines.len(); assert!(lines.iter().all(|l| l.ts.is_some())); }
            LogMessage::End => break,
            LogMessage::Error { error, .. } => panic!("{error:?}"),
            _ => {}
        }
    }
    assert!((1..=3).contains(&count));
}

#[tokio::test]
#[ignore]
async fn following_logs_stays_open() {
    let client = admin().await;
    let pod = coredns_pod(&client).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let opts = LogOptions { tail_lines: Some(2), follow: true, ..Default::default() };
    let task = tokio::spawn(logs::run(client, "kube-system".into(), pod, opts, PRIVATE, move |m| tx.send(m).is_ok()));
    loop {
        match recv_log(&mut rx, Duration::from_secs(5)).await {
            Some(LogMessage::Lines { .. }) => break,
            Some(LogMessage::Error { error, .. }) => panic!("{error:?}"),
            None => panic!("no lines"),
            _ => {}
        }
    }
    // 따라가는 동안은 끝나지 않는다
    assert_eq!(recv_log(&mut rx, Duration::from_secs(3)).await, None);
    assert!(!task.is_finished());
    task.abort();
}

#[tokio::test]
#[ignore]
async fn logs_of_a_container_that_never_started_are_an_error() {
    let client = admin().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    logs::run(client, "mm-k2".into(), "broken".into(), LogOptions::default(), PRIVATE, move |m| tx.send(m).is_ok()).await;
    let Some(LogMessage::Error { error, .. }) = recv_log(&mut rx, Duration::from_secs(5)).await else { panic!("no error") };
    // 서버가 400과 함께 "is waiting to start"류의 설명을 준다. 연결 문제로 잘못 가르지 않는다.
    assert!(!matches!(error, AppError::Network { .. }), "{error:?}");
}

#[tokio::test]
#[ignore]
async fn workload_follows_new_pods_and_all_containers_with_since() {
    use std::collections::HashSet;
    use std::io::Write;
    use std::process::Stdio;
    let manifest = r#"apiVersion: apps/v1
kind: Deployment
metadata: { name: log-streams, namespace: mm-k2 }
spec:
  replicas: 2
  selector: { matchLabels: { app: log-streams } }
  template:
    metadata: { labels: { app: log-streams } }
    spec:
      containers:
      - { name: first, image: busybox:1.36, command: [sh, -c, 'while true; do echo first; sleep 1; done'] }
      - { name: second, image: busybox:1.36, command: [sh, -c, 'while true; do echo second; sleep 1; done'] }
"#;
    let mut apply = Command::new("kubectl").arg("--kubeconfig").arg(kubeconfig_path()).args(["apply", "-f", "-"]).stdin(Stdio::piped()).spawn().unwrap();
    apply.stdin.take().unwrap().write_all(manifest.as_bytes()).unwrap();
    assert!(apply.wait().unwrap().success());
    kubectl(&["-n", "mm-k2", "rollout", "status", "deployment/log-streams", "--timeout=120s"]);
    let client = admin().await;
    let pods: kube::Api<k8s_openapi::api::core::v1::Pod> = kube::Api::namespaced(client.clone(), "mm-k2");
    let pod = pods.list(&kube::api::ListParams::default().labels("app=log-streams")).await.unwrap().items[0].metadata.name.clone().unwrap();
    tokio::time::sleep(Duration::from_secs(4)).await;
    let earliest = k8s_openapi::jiff::Timestamp::now().as_second() - 3;
    let (tx, mut rx) = mpsc::unbounded_channel();
    logs::run(client.clone(), "mm-k2".into(), pod, LogOptions { since_seconds: Some(1), ..Default::default() }, PRIVATE, move |m| tx.send(m).is_ok()).await;
    let mut names = HashSet::new();
    while let Some(m) = rx.recv().await {
        match m {
            LogMessage::Lines { container, lines, .. } => {
                assert!(lines.iter().all(|l| l.ts.as_ref().and_then(|ts| ts.parse::<k8s_openapi::jiff::Timestamp>().ok()).is_some_and(|ts| ts.as_second() >= earliest)));
                names.insert(container);
            }
            LogMessage::End => break,
            LogMessage::Error { error, .. } => panic!("{error:?}"),
            _ => {}
        }
    }
    assert_eq!(names.len(), 2);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let kind = KindRef { group: "apps".into(), version: "v1".into(), kind: "Deployment".into(), plural: "deployments".into(), namespaced: true };
    let task = tokio::spawn(logs::workload(client, kind, "mm-k2".into(), "log-streams".into(), LogOptions { follow: true, since_seconds: Some(60), ..Default::default() }, PRIVATE, move |m| tx.send(m).is_ok()));
    let mut sources = HashSet::new();
    while sources.len() < 4 {
        match recv_log(&mut rx, Duration::from_secs(30)).await {
            Some(LogMessage::Lines { pod, container, .. }) => { sources.insert((pod, container)); }
            Some(LogMessage::Error { error, .. }) => panic!("{error:?}"),
            None => panic!("초기 Pod 로그가 없어요: {sources:?}"),
            _ => {}
        }
    }
    kubectl(&["-n", "mm-k2", "scale", "deployment/log-streams", "--replicas=3"]);
    while sources.len() < 6 {
        match recv_log(&mut rx, Duration::from_secs(60)).await {
            Some(LogMessage::Lines { pod, container, .. }) => { sources.insert((pod, container)); }
            Some(LogMessage::Error { error, .. }) => panic!("{error:?}"),
            None => panic!("새 Pod 로그가 없어요: {sources:?}"),
            _ => {}
        }
    }
    task.abort();
    kubectl(&["-n", "mm-k2", "delete", "deployment/log-streams"]);
}


/// 셸·attach·port-forward(K9). 클러스터에 `mm-k9` 네임스페이스와 busybox Pod·Deployment·Service를 만들고 그 위에서 돈다.
mod streams {
    use std::io::Write;
    use std::process::Stdio;
    use std::sync::Arc;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    use super::*;
    use crate::k8s::forward::{self, ForwardKind, ForwardRequest, Forwards};
    use crate::k8s::shell::{self, ShellMessage, ShellMode, ShellTarget, Shells};
    use crate::k8s::target::K8sTarget;

    const NS: &str = "mm-k9";
    const FIXTURE: &str = r#"
apiVersion: v1
kind: Namespace
metadata: { name: mm-k9 }
---
apiVersion: v1
kind: Pod
metadata: { name: plain, namespace: mm-k9 }
spec:
  containers:
    - name: main
      image: busybox:1.36
      command: ["sh", "-c", "while true; do echo tick; sleep 1; done"]
---
apiVersion: v1
kind: Pod
metadata: { name: tty, namespace: mm-k9 }
spec:
  containers:
    - name: main
      image: busybox:1.36
      command: ["sh"]
      stdin: true
      tty: true
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: echo, namespace: mm-k9 }
spec:
  replicas: 2
  selector: { matchLabels: { app: echo } }
  template:
    metadata: { labels: { app: echo } }
    spec:
      containers:
        - name: web
          image: busybox:1.36
          command: ["sh", "-c", "mkdir -p /www && echo mm-forward-ok > /www/index.html && exec httpd -f -p 8080 -h /www"]
          ports: [{ name: http, containerPort: 8080 }]
          readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 1 }
---
apiVersion: v1
kind: Service
metadata: { name: echo, namespace: mm-k9 }
spec:
  selector: { app: echo }
  ports: [{ port: 80, targetPort: http }]
"#;

    fn kubectl_apply(yaml: &str) {
        let mut child = Command::new("kubectl")
            .arg("--kubeconfig")
            .arg(kubeconfig_path())
            .args(["apply", "-f", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("kubectl");
        child.stdin.take().unwrap().write_all(yaml.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "kubectl apply: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// 픽스처를 만들고 Pod가 준비될 때까지 기다린다(이미 있으면 그대로)
    fn fixture() {
        kubectl_apply(FIXTURE);
        kubectl(&["-n", NS, "wait", "--for=condition=Ready", "pod/plain", "pod/tty", "--timeout=180s"]);
        kubectl(&["-n", NS, "rollout", "status", "deployment/echo", "--timeout=180s"]);
    }

    fn target() -> K8sTarget {
        K8sTarget { profile: "live".into(), region: "r".into(), cluster: "kind".into() }
    }

    fn log_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mm-live-shell-{name}-{}", std::process::id())).join("k8s-changes.jsonl")
    }

    fn info(pod: &str, mode: ShellMode) -> ShellTarget {
        ShellTarget { target: target(), namespace: NS.into(), pod: pod.into(), container: if pod == "echo" { "web".into() } else { "main".into() }, mode }
    }

    /// 열린 세션의 출력을 받는 쪽
    struct Screen {
        rx: mpsc::UnboundedReceiver<ShellMessage>,
        seen: String,
    }

    impl Screen {
        /// `needle`이 나올 때까지(또는 `limit`) 출력을 모은다. 나오면 true.
        async fn until(&mut self, needle: &str, limit: Duration) -> bool {
            let deadline = tokio::time::Instant::now() + limit;
            while !self.seen.contains(needle) {
                let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                match tokio::time::timeout(left, self.rx.recv()).await {
                    Ok(Some(ShellMessage::Output { data })) => self.seen.push_str(&data),
                    Ok(Some(ShellMessage::Exit { .. })) | Ok(None) | Err(_) => return self.seen.contains(needle),
                }
            }
            true
        }

        /// 끝날 때까지 읽어 끝 코드를 돌려준다
        async fn exit(&mut self, limit: Duration) -> Option<Option<i32>> {
            let deadline = tokio::time::Instant::now() + limit;
            loop {
                let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                match tokio::time::timeout(left, self.rx.recv()).await {
                    Ok(Some(ShellMessage::Output { data })) => self.seen.push_str(&data),
                    Ok(Some(ShellMessage::Exit { code, .. })) => return Some(code),
                    Ok(None) | Err(_) => return None,
                }
            }
        }
    }

    async fn open(client: kube::Client, shells: &Arc<Shells>, log: &std::path::Path, pod: &str, mode: ShellMode) -> (shell::ShellOpened, Screen) {
        let i = info(pod, mode);
        let connected = shell::connect(client, mode, NS, pod, &i.container, &shell::SHELL_COMMAND, PRIVATE).await.unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        let opened = shells.start(log, i, connected, None, move |m| tx.send(m).is_ok()).unwrap();
        (opened, Screen { rx, seen: String::new() })
    }

    #[tokio::test]
    #[ignore]
    async fn exec_echoes_resizes_and_reports_the_exit_code() {
        fixture();
        let client = admin().await;
        let shells = Arc::new(Shells::default());
        let log = log_path("exec");
        let (opened, mut screen) = open(client, &shells, &log, "plain", ShellMode::Exec).await;
        assert!(opened.input);
        shells.input(opened.id, "echo mm-$((20+22))\n".into());
        assert!(screen.until("mm-42", Duration::from_secs(20)).await, "output: {}", screen.seen);
        shells.resize(opened.id, 120, 40);
        // 크기 변경이 서버에 닿을 시간을 주고 터미널 크기를 묻는다
        tokio::time::sleep(Duration::from_millis(500)).await;
        shells.input(opened.id, "stty size\n".into());
        assert!(screen.until("40 120", Duration::from_secs(20)).await, "output: {}", screen.seen);
        shells.input(opened.id, "exit 3\n".into());
        assert_eq!(screen.exit(Duration::from_secs(20)).await, Some(Some(3)), "output: {}", screen.seen);
        // 끝난 세션은 정리되고 기록에 닫은 시각이 남는다. 입력·출력은 기록에 없다
        for _ in 0..50 {
            if crate::k8s::log::read_all(&log).iter().all(|r| r.closed_at.is_some()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let records = crate::k8s::log::read_all(&log);
        assert_eq!(records.len(), 1);
        assert!(records[0].closed_at.is_some());
        let text = std::fs::read_to_string(&log).unwrap();
        assert!(!text.contains("mm-42") && !text.contains("stty"), "{text}");
        let _ = std::fs::remove_dir_all(log.parent().unwrap());
    }

    #[tokio::test]
    #[ignore]
    async fn closing_an_exec_session_ends_the_remote_shell() {
        fixture();
        let client = admin().await;
        let shells = Arc::new(Shells::default());
        let log = log_path("close");
        let (opened, mut screen) = open(client, &shells, &log, "plain", ShellMode::Exec).await;
        shells.input(opened.id, "echo alive\n".into());
        assert!(screen.until("alive", Duration::from_secs(20)).await);
        shells.close(opened.id);
        // 닫은 뒤의 입력은 어디에도 가지 않는다
        shells.input(opened.id, "echo after-close\n".into());
        assert_eq!(screen.exit(Duration::from_secs(3)).await, None);
        assert!(!screen.seen.contains("after-close"));
        assert!(crate::k8s::log::read_all(&log)[0].closed_at.is_some());
        let _ = std::fs::remove_dir_all(log.parent().unwrap());
    }

    #[tokio::test]
    #[ignore]
    async fn attach_to_a_tty_container_takes_input() {
        fixture();
        let client = admin().await;
        let shells = Arc::new(Shells::default());
        let log = log_path("attach");
        let (opened, mut screen) = open(client, &shells, &log, "tty", ShellMode::Attach).await;
        assert!(opened.input);
        // 주 프로세스(sh)에 바로 들어간다
        shells.input(opened.id, "echo attached-$((1+1))\n".into());
        assert!(screen.until("attached-2", Duration::from_secs(20)).await, "output: {}", screen.seen);
        shells.close_all();
        let _ = std::fs::remove_dir_all(log.parent().unwrap());
    }

    #[tokio::test]
    #[ignore]
    async fn attach_to_a_container_without_stdin_is_output_only() {
        fixture();
        let client = admin().await;
        let shells = Arc::new(Shells::default());
        let log = log_path("attach-ro");
        let (opened, mut screen) = open(client, &shells, &log, "plain", ShellMode::Attach).await;
        assert!(!opened.input);
        shells.input(opened.id, "echo typed\n".into());
        assert!(screen.until("tick", Duration::from_secs(20)).await, "output: {}", screen.seen);
        assert!(!screen.seen.contains("typed"));
        shells.close_all();
        let _ = std::fs::remove_dir_all(log.parent().unwrap());
    }

    #[tokio::test]
    #[ignore]
    async fn a_stopped_or_unknown_container_is_refused_before_connecting() {
        fixture();
        let client = admin().await;
        let unknown = shell::connect(client.clone(), ShellMode::Exec, NS, "plain", "nope", &shell::SHELL_COMMAND, PRIVATE).await;
        assert_eq!(unknown.err(), Some(AppError::other(shell::NO_SUCH_CONTAINER)));
        let missing = shell::connect(client, ShellMode::Exec, NS, "no-such-pod", "main", &shell::SHELL_COMMAND, PRIVATE).await;
        assert!(missing.is_err());
    }

    /// 로컬 포트로 HTTP GET을 보내 응답 전체를 돌려준다
    async fn http_get(port: u16) -> std::io::Result<String> {
        let mut tcp = TcpStream::connect((forward::LOCAL_ADDR, port)).await?;
        tcp.write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n").await?;
        let mut body = String::new();
        tcp.read_to_string(&mut body).await?;
        Ok(body)
    }

    async fn start_forward(client: &kube::Client, forwards: &Arc<Forwards>, kind: ForwardKind, name: &str, remote: u16) -> forward::Forward {
        let req = ForwardRequest { namespace: NS.into(), kind, name: name.into(), remote_port: remote, local_port: None };
        let prepared = forward::prepare(client.clone(), &req, PRIVATE).await.unwrap();
        let listener = forward::bind_local(None, remote).await.unwrap();
        forwards.start(target(), &req, prepared, listener, client.clone(), PRIVATE).unwrap()
    }

    async fn echo_pods(client: &kube::Client) -> Vec<String> {
        use k8s_openapi::api::core::v1::Pod;
        let pods: kube::Api<Pod> = kube::Api::namespaced(client.clone(), NS);
        let list = pods.list(&kube::api::ListParams::default().labels("app=echo")).await.unwrap();
        list.items.into_iter().filter(|p| p.metadata.deletion_timestamp.is_none()).filter_map(|p| p.metadata.name).collect()
    }

    #[tokio::test]
    #[ignore]
    async fn port_forward_to_a_pod_serves_http_and_stops_when_closed() {
        fixture();
        let client = admin().await;
        let forwards = Arc::new(Forwards::default());
        let pod = echo_pods(&client).await.remove(0);
        let f = start_forward(&client, &forwards, ForwardKind::Pod, &pod, 8080).await;
        let reply = http_get(f.local_port).await.unwrap();
        assert!(reply.contains(" 200 OK") && reply.contains("mm-forward-ok"), "{reply}");
        assert_eq!(forwards.list()[0].pod.as_deref(), Some(pod.as_str()));
        forwards.close(f.id);
        assert!(forwards.list().is_empty());
        // 닫은 뒤에는 로컬 포트가 닫힌다(작업이 멈추는 데 잠깐 걸릴 수 있다)
        let mut closed = false;
        for _ in 0..50 {
            if TcpStream::connect((forward::LOCAL_ADDR, f.local_port)).await.is_err() {
                closed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(closed, "local port {} still open", f.local_port);
    }

    #[tokio::test]
    #[ignore]
    async fn port_forward_to_a_closed_pod_port_reports_the_failure() {
        fixture();
        let client = admin().await;
        let forwards = Arc::new(Forwards::default());
        let pod = echo_pods(&client).await.remove(0);
        let f = start_forward(&client, &forwards, ForwardKind::Pod, &pod, 9999).await;
        // 아무도 듣지 않는 포트: 연결은 열렸다가 바로 닫힌다
        let reply = http_get(f.local_port).await.unwrap_or_default();
        assert!(!reply.contains("200"), "{reply}");
        let mut reported = None;
        for _ in 0..50 {
            reported = forwards.list()[0].error.clone();
            if reported.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(reported.is_some(), "no error reported");
        forwards.close_all();
    }

    #[tokio::test]
    #[ignore]
    async fn port_forward_to_a_service_resolves_the_named_port_and_reattaches_after_the_pod_is_deleted() {
        fixture();
        let client = admin().await;
        let forwards = Arc::new(Forwards::default());
        // Service 포트 80은 이름 있는 targetPort(http → 8080)로 간다
        let f = start_forward(&client, &forwards, ForwardKind::Service, "echo", 80).await;
        let reply = http_get(f.local_port).await.unwrap();
        assert!(reply.contains(" 200 OK") && reply.contains("mm-forward-ok"), "{reply}");
        let first = forwards.list()[0].pod.clone().expect("a pod");
        // 붙어 있던 Pod를 지우면 다른 준비된 Pod로 옮겨 간다
        kubectl(&["-n", NS, "delete", "pod", &first, "--wait=false"]);
        let mut moved = None;
        for _ in 0..300 {
            let now = forwards.list()[0].pod.clone();
            if now.is_some() && now.as_deref() != Some(first.as_str()) {
                moved = now;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let moved = moved.unwrap_or_else(|| panic!("never left {first}"));
        assert!(echo_pods(&client).await.contains(&moved));
        let reply = http_get(f.local_port).await.unwrap();
        assert!(reply.contains("mm-forward-ok"), "{reply}");
        forwards.close_all();
        kubectl(&["-n", NS, "rollout", "status", "deployment/echo", "--timeout=180s"]);
    }

    #[tokio::test]
    #[ignore]
    async fn a_service_port_that_does_not_exist_is_refused() {
        fixture();
        let client = admin().await;
        let req = ForwardRequest { namespace: NS.into(), kind: ForwardKind::Service, name: "echo".into(), remote_port: 81, local_port: None };
        // Service에 없는 포트
        assert_eq!(forward::prepare(client, &req, PRIVATE).await.err(), Some(AppError::other(forward::NO_SERVICE_PORT)));
    }

    /// 노드 셸: 변경 틀로 디버그 Pod를 만들고(미리보기·확인), 노드 안으로 들어가 `hostname`이 노드 이름인지 보고, 닫으면 Pod가 지워진다.
    #[tokio::test]
    #[ignore]
    async fn node_shell_enters_the_node_and_the_debug_pod_goes_away_when_it_is_closed() {
        use crate::k8s::change::{self, Change, Operation};
        use crate::k8s::{commit, log, node_shell};
        fixture();
        let client = admin().await;
        let nodes: kube::Api<k8s_openapi::api::core::v1::Node> = kube::Api::all(client.clone());
        let node = nodes.list(&kube::api::ListParams::default()).await.unwrap().items.remove(0).metadata.name.unwrap();
        let pod = "mm-node-shell-live";
        let change = Change {
            target: change::pod_object(NS, pod),
            operation: Operation::NodeShell { node: node.clone(), image: "busybox:1.36".into() },
        };
        let seen = commit::dry_plan(client.clone(), PRIVATE, &change, "").await.unwrap();
        assert_eq!(seen.preview.confirm_name.as_deref(), Some(node.as_str()));
        // 노드 이름을 입력하지 않으면 만들지 않는다
        assert!(commit::apply_plan(client.clone(), PRIVATE, &change, &seen, "", Some("wrong")).await.is_err());
        let (_, created) = commit::apply_plan(client.clone(), PRIVATE, &change, &seen, "", Some(&node)).await.unwrap();
        created.unwrap();

        let log_file = log_path("node-shell");
        let shells = Arc::new(Shells::default());
        // 만든 Pod의 UID를 기억해 두고, 터미널은 그 Pod만 연다
        let registry = node_shell::NodeShells::default();
        let uid = node_shell::read_uid(client.clone(), PRIVATE, NS, pod).await.expect("created pod uid");
        let remove = node_shell::remover(client.clone(), PRIVATE, target(), NS.into(), pod.into(), Some(uid.clone()), log_file.clone());
        registry.track(target(), NS, pod, uid.clone(), remove);
        let claimed = registry.claim(&target(), NS, pod).unwrap();
        assert_eq!(claimed.uid, uid);
        node_shell::wait_ready(client.clone(), NS, pod, &claimed.uid, PRIVATE).await.unwrap();
        let mut command = change::NODE_SHELL_COMMAND.to_vec();
        command.push("sh");
        let connected = shell::connect(client.clone(), ShellMode::Exec, NS, pod, change::NODE_SHELL_CONTAINER, &command, PRIVATE).await.unwrap();
        let info = ShellTarget { target: target(), namespace: NS.into(), pod: pod.into(), container: change::NODE_SHELL_CONTAINER.into(), mode: ShellMode::Exec };
        let cleanup: shell::Cleanup = {
            let remove = claimed.remove.clone();
            Box::new(move || Box::pin(async move { (*remove)().await }))
        };
        let (tx, rx) = mpsc::unbounded_channel();
        let opened = shells.start(&log_file, info, connected, Some(cleanup), move |m| tx.send(m).is_ok()).unwrap();
        let mut screen = Screen { rx, seen: String::new() };
        shells.input(opened.id, "echo host=$(hostname)\n".into());
        let expected = format!("host={node}");
        assert!(screen.until(&expected, Duration::from_secs(30)).await, "output: {}", screen.seen);

        shells.close(opened.id);
        shells.settle(Duration::from_secs(60)).await;
        let pods: kube::Api<k8s_openapi::api::core::v1::Pod> = kube::Api::namespaced(client.clone(), NS);
        let mut gone = false;
        for _ in 0..300 {
            if pods.get_opt(pod).await.unwrap().is_none() {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(gone, "debug pod still there");
        // 세션을 열고 닫은 기록과 Pod를 지운 기록이 남는다
        let entries = log::read_all(&log_file);
        assert!(entries.iter().any(|e| matches!(e.change.operation, Operation::Shell { .. }) && e.closed_at.is_some()), "{entries:?}");
        assert!(entries.iter().any(|e| e.summary == node_shell::SUMMARY_DELETE && e.ok && e.change.operation == Operation::Delete), "{entries:?}");
        let _ = std::fs::remove_dir_all(log_file.parent().unwrap());
    }

    /// 같은 표시를 단 다른 Pod(YAML 적용 따위)는 노드 셸로 열 수 없고, 열기 전에 탭이 닫히면 등록된 Pod는 지워진다.
    #[tokio::test]
    #[ignore]
    async fn node_shell_refuses_a_look_alike_pod_and_removes_an_unopened_one_when_the_tab_closes() {
        use crate::k8s::change::{self, Change, Operation};
        use crate::k8s::{commit, node_shell};
        fixture();
        let client = admin().await;
        let registry = node_shell::NodeShells::default();
        // 표시만 같은 Pod: 변경 틀을 거치지 않았으니 등록돼 있지 않다
        let forged = change::node_shell_pod("mm-forged-shell", NS, "any-node", "busybox:1.36");
        let mut value = forged.clone();
        value["spec"] = serde_json::json!({ "containers": [{ "name": "shell", "image": "busybox:1.36", "command": ["sleep", "600"] }] });
        kubectl_apply(&value.to_string());
        kubectl(&["-n", NS, "wait", "--for=condition=Ready", "pod/mm-forged-shell", "--timeout=120s"]);
        assert_eq!(registry.claim(&target(), NS, "mm-forged-shell").err(), Some(AppError::other(node_shell::NOT_NODE_SHELL)));
        let uid = node_shell::read_uid(client.clone(), PRIVATE, NS, "mm-forged-shell").await.unwrap();
        let wrong = node_shell::wait_ready(client.clone(), NS, "mm-forged-shell", "some-other-uid", PRIVATE).await;
        assert_eq!(wrong.err(), Some(AppError::other(node_shell::NOT_NODE_SHELL)));
        assert!(!uid.is_empty());
        kubectl(&["-n", NS, "delete", "pod", "mm-forged-shell", "--wait=false"]);

        // 확인해 만든 Pod를 등록만 하고 터미널을 열지 않은 채 탭을 닫는다
        let node = kube::Api::<k8s_openapi::api::core::v1::Node>::all(client.clone()).list(&kube::api::ListParams::default()).await.unwrap().items.remove(0).metadata.name.unwrap();
        let pod = "mm-node-shell-unopened";
        let change = Change { target: change::pod_object(NS, pod), operation: Operation::NodeShell { node: node.clone(), image: "busybox:1.36".into() } };
        let seen = commit::dry_plan(client.clone(), PRIVATE, &change, "").await.unwrap();
        commit::apply_plan(client.clone(), PRIVATE, &change, &seen, "", Some(&node)).await.unwrap().1.unwrap();
        let log_file = log_path("node-shell-unopened");
        let uid = node_shell::read_uid(client.clone(), PRIVATE, NS, pod).await.unwrap();
        registry.track(target(), NS, pod, uid.clone(), node_shell::remover(client.clone(), PRIVATE, target(), NS.into(), pod.into(), Some(uid), log_file.clone()));
        registry.close_target(&target());
        registry.settle(Duration::from_secs(60)).await;
        let pods: kube::Api<k8s_openapi::api::core::v1::Pod> = kube::Api::namespaced(client.clone(), NS);
        let mut gone = false;
        for _ in 0..300 {
            if pods.get_opt(pod).await.unwrap().is_none() {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(gone, "unopened debug pod still there");
        let _ = std::fs::remove_dir_all(log_file.parent().unwrap());
    }
}

/// 이 시험은 스크립트가 만든 kind 클러스터에서만 쓰기 요청을 보낸다.
#[tokio::test]
#[ignore]
async fn workload_changes_dry_run_apply_undo_and_conflict() {
    use super::change::{Change, ChangeObject, Operation};
    use super::{commit, exec, read};
    use kube::api::{DynamicObject, Patch, PatchParams, PostParams};

    let client = admin().await;
    let target = |group: &str, kind: &str, plural: &str, name: &str| ChangeObject {
        kind: KindRef { group: group.into(), version: "v1".into(), kind: kind.into(), plural: plural.into(), namespaced: true },
        namespace: Some("mm-k2".into()),
        name: name.into(),
    };
    let deployment = target("apps", "Deployment", "deployments", "mm-k7-web");
    let cron = target("batch", "CronJob", "cronjobs", "mm-k7-cron");
    let config = target("", "ConfigMap", "configmaps", "mm-k7-config");
    let fixtures = [
        (&deployment, json!({"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"mm-k7-web","namespace":"mm-k2"},"spec":{"replicas":0,"selector":{"matchLabels":{"app":"mm-k7"}},"template":{"metadata":{"labels":{"app":"mm-k7"}},"spec":{"containers":[{"name":"app","image":"registry.k8s.io/pause:3.10"}]}}}})),
        (&cron, json!({"apiVersion":"batch/v1","kind":"CronJob","metadata":{"name":"mm-k7-cron","namespace":"mm-k2"},"spec":{"schedule":"0 0 1 1 *","jobTemplate":{"spec":{"template":{"spec":{"restartPolicy":"Never","containers":[{"name":"app","image":"registry.k8s.io/pause:3.10"}]}}}}}})),
        (&config, json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"mm-k7-config","namespace":"mm-k2"},"data":{"key":"value"}})),
    ];
    for (target, fixture) in fixtures {
        let api = read::api_for(client.clone(), &target.kind, target.namespace.as_deref());
        let object: DynamicObject = serde_json::from_value(fixture).unwrap();
        api.create(&PostParams::default(), &object).await.unwrap();
    }
    kubectl(&["-n", "mm-k2", "rollout", "status", "deployment/mm-k7-web", "--timeout=120s"]);

    let scale = Change { target: deployment.clone(), operation: Operation::Scale { replicas: 1 } };
    let scale_plan = commit::dry_plan(client.clone(), PRIVATE, &scale, "2026-01-01T00:00:00Z").await.unwrap();
    let api = read::api_for(client.clone(), &deployment.kind, deployment.namespace.as_deref());
    api.patch_status(&deployment.name, &PatchParams::default(), &Patch::Merge(json!({"status":{"observedGeneration":0}}))).await.unwrap();
    assert_eq!(exec::run(client.clone(), PRIVATE, &scale, &scale_plan, true).await.unwrap_err(), AppError::other(exec::STALE));
    let (_, result) = commit::apply_plan(client.clone(), PRIVATE, &scale, &scale_plan, "2026-01-01T00:00:00Z", None).await.unwrap();
    result.unwrap();
    assert_eq!(exec::run(client.clone(), PRIVATE, &scale, &scale_plan, false).await.unwrap_err(), AppError::other(exec::STALE));
    kubectl(&["-n", "mm-k2", "rollout", "status", "deployment/mm-k7-web", "--timeout=120s"]);
    let next_scale = Change { target: deployment.clone(), operation: Operation::Scale { replicas: 2 } };
    let seen = commit::dry_plan(client.clone(), PRIVATE, &next_scale, "").await.unwrap();
    let inverse = scale_plan.inverse.unwrap();
    let inverse_plan = commit::dry_plan(client.clone(), PRIVATE, &inverse, "").await.unwrap();
    let (_, result) = commit::apply_plan(client.clone(), PRIVATE, &inverse, &inverse_plan, "", None).await.unwrap();
    result.unwrap();
    assert!(commit::apply_plan(client.clone(), PRIVATE, &next_scale, &seen, "", None).await.is_err());
    kubectl(&["-n", "mm-k2", "rollout", "status", "deployment/mm-k7-web", "--timeout=120s"]);

    let suspend = Change { target: cron.clone(), operation: Operation::Suspend { suspend: true } };
    let plan = commit::make_plan(client.clone(), PRIVATE, &suspend, "").await.unwrap();
    exec::run(client.clone(), PRIVATE, &suspend, &plan, true).await.unwrap();
    exec::run(client.clone(), PRIVATE, &suspend, &plan, false).await.unwrap();
    let rerun = Change { target: cron, operation: Operation::Rerun { job_name: "mm-k7-job".into() } };
    let plan = commit::make_plan(client.clone(), PRIVATE, &rerun, "").await.unwrap();
    exec::run(client.clone(), PRIVATE, &rerun, &plan, true).await.unwrap();
    exec::run(client.clone(), PRIVATE, &rerun, &plan, false).await.unwrap();

    let delete = Change { target: config, operation: Operation::Delete };
    let plan = commit::make_plan(client.clone(), PRIVATE, &delete, "").await.unwrap();
    exec::run(client.clone(), PRIVATE, &delete, &plan, true).await.unwrap();
    exec::run(client.clone(), PRIVATE, &delete, &plan, false).await.unwrap();
    let recreate = plan.inverse.unwrap();
    let plan = commit::make_plan(client.clone(), PRIVATE, &recreate, "").await.unwrap();
    exec::run(client.clone(), PRIVATE, &recreate, &plan, true).await.unwrap();
    exec::run(client.clone(), PRIVATE, &recreate, &plan, false).await.unwrap();

    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if !commit::revisions(client.clone(), PRIVATE, &deployment).await.unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }).await.expect("첫 롤아웃 리비전이 만들어지지 않았어요");
    let restart = Change { target: deployment.clone(), operation: Operation::Restart };
    let plan = commit::make_plan(client.clone(), PRIVATE, &restart, "2026-01-01T00:00:00Z").await.unwrap();
    exec::run(client.clone(), PRIVATE, &restart, &plan, true).await.unwrap();
    exec::run(client.clone(), PRIVATE, &restart, &plan, false).await.unwrap();
    let revisions = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let revisions = commit::revisions(client.clone(), PRIVATE, &deployment).await.unwrap();
            if revisions.len() >= 2 {
                break revisions;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }).await.expect("롤아웃 리비전이 만들어지지 않았어요");
    let undo = Change { target: deployment, operation: Operation::RolloutUndo { revision: revisions.last().unwrap().revision.clone() } };
    let plan = commit::dry_plan(client.clone(), PRIVATE, &undo, "").await.unwrap();
    assert!(plan.inverse.is_some(), "현재 리비전의 역변경이 필요해요");
    let (_, result) = commit::apply_plan(client, PRIVATE, &undo, &plan, "", None).await.unwrap();
    result.unwrap();
}

/// 워커 노드를 drain한다: PodDisruptionBudget이 막는 Pod와 보통 Pod, 컨트롤러 없는 emptyDir Pod를 두고
/// 미리보기 → cordon → Eviction → 막힘으로 멈춤 → 막힘을 풀고 다시 → uncordon 되돌리기까지 이어서 본다.
/// 스크립트가 kind 클러스터에 워커 노드를 함께 만든다. 컨트롤 플레인만 있으면 이 시험은 멈춘다(그 노드를 drain하지 않는다).
#[tokio::test]
#[ignore]
async fn drain_moves_pods_off_a_worker_around_a_budget_then_uncordons() {
    use super::change::{Change, ChangeObject, Operation};
    use super::drain::apply::{apply, Job};
    use super::drain::run::{DrainMessage, Limits, Outcome, PodState};
    use super::{commit, log, read};
    use k8s_openapi::api::core::v1::{Node, Pod};
    use kube::api::{DynamicObject, ListParams, PostParams};

    let client = admin().await;
    let nodes: kube::Api<Node> = kube::Api::all(client.clone());
    let worker = nodes
        .list(&ListParams::default())
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|node| !node.metadata.labels.as_ref().is_some_and(|labels| labels.contains_key("node-role.kubernetes.io/control-plane")))
        .and_then(|node| node.metadata.name)
        .expect("워커 노드가 필요해요. scripts/k8s-live-test.sh가 만든 클러스터로 돌려 주세요");

    /// 시험이 중간에 멈춰도 뒤의 시험이 막히지 않게 노드를 되돌리고 네임스페이스를 지운다
    struct Cleanup(String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            for args in [vec!["uncordon", self.0.as_str()], vec!["delete", "namespace", "mm-drain", "--wait=false", "--ignore-not-found"]] {
                let _ = Command::new("kubectl").arg("--kubeconfig").arg(kubeconfig_path()).args(args).output();
            }
        }
    }
    let _cleanup = Cleanup(worker.clone());

    let create = |kind: KindRef, object: Value| {
        let client = client.clone();
        async move {
            let api = read::api_for(client, &kind, Some("mm-drain"));
            let object: DynamicObject = serde_json::from_value(object).unwrap();
            api.create(&PostParams::default(), &object).await.unwrap();
        }
    };
    kubectl(&["create", "namespace", "mm-drain"]);
    let pin = json!({"nodeSelector": {"kubernetes.io/hostname": worker}});
    let deployment = |name: &str| {
        json!({"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":name,"namespace":"mm-drain"},"spec":{"replicas":1,"selector":{"matchLabels":{"app":name}},
            "template":{"metadata":{"labels":{"app":name}},"spec":{"nodeSelector":pin["nodeSelector"],"containers":[{"name":"app","image":"registry.k8s.io/pause:3.10"}]}}}})
    };
    create(kind_ref("apps", "v1", "Deployment", "deployments"), deployment("free")).await;
    create(kind_ref("apps", "v1", "Deployment", "deployments"), deployment("held")).await;
    create(
        kind_ref("policy", "v1", "PodDisruptionBudget", "poddisruptionbudgets"),
        json!({"apiVersion":"policy/v1","kind":"PodDisruptionBudget","metadata":{"name":"held","namespace":"mm-drain"},"spec":{"minAvailable":1,"selector":{"matchLabels":{"app":"held"}}}}),
    )
    .await;
    create(
        kind_ref("", "v1", "Pod", "pods"),
        json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"bare","namespace":"mm-drain"},"spec":{"nodeSelector":pin["nodeSelector"],
            "volumes":[{"name":"scratch","emptyDir":{}}],"containers":[{"name":"app","image":"registry.k8s.io/pause:3.10"}]}}),
    )
    .await;
    kubectl(&["-n", "mm-drain", "wait", "--for=condition=Ready", "pod", "--all", "--timeout=120s"]);
    kubectl(&["-n", "mm-drain", "wait", "pdb/held", "--for=jsonpath={.status.currentHealthy}=1", "--timeout=60s"]);

    let change = Change {
        target: ChangeObject {
            kind: KindRef { group: String::new(), version: "v1".into(), kind: "Node".into(), plural: "nodes".into(), namespaced: false },
            namespace: None,
            name: worker.clone(),
        },
        operation: Operation::Drain,
    };
    // 미리보기: 서버 dry-run을 거쳐, 옮길 Pod와 경고를 알린다
    let seen = commit::dry_plan(client.clone(), PRIVATE, &change, "2026-01-01T00:00:00Z").await.unwrap();
    let drain = seen.preview.drain.clone().unwrap();
    assert!(!drain.budgets_unknown && !drain.node_cordoned);
    assert_eq!(seen.preview.confirm_name.as_deref(), Some(worker.as_str()));
    let mine: Vec<_> = drain.evict.iter().filter(|pod| pod.namespace == "mm-drain").collect();
    assert_eq!(mine.iter().map(|pod| pod.name.starts_with("free-") || pod.name.starts_with("held-") || pod.name == "bare").collect::<Vec<_>>(), [true, true, true]);
    let bare = mine.iter().find(|pod| pod.name == "bare").unwrap();
    assert!(bare.empty_dir && bare.unmanaged, "{bare:?}");
    let held = mine.iter().find(|pod| pod.name.starts_with("held-")).unwrap();
    assert_eq!(held.blocked_by.as_deref(), Some("held"));
    let free = mine.iter().find(|pod| pod.name.starts_with("free-")).unwrap();
    assert!(free.blocked_by.is_none() && !free.unmanaged);
    assert!(drain.skipped.iter().any(|pod| pod.reason == super::drain::SkipReason::DaemonSet), "kindnet 같은 DaemonSet Pod는 건너뛰어요: {:?}", drain.skipped);
    assert!(seen.preview.warnings.iter().any(|w| w.starts_with(super::drain::EMPTY_DIR_WARNING)));
    assert!(seen.preview.warnings.iter().any(|w| w.starts_with(super::drain::BLOCKED_WARNING)));
    let current = commit::make_plan(client.clone(), PRIVATE, &change, "").await.unwrap();
    commit::check_drain(Some(&seen), &current, Some(&worker)).unwrap();

    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("k8s-changes.jsonl");
    let target = super::target::K8sTarget { profile: "live".into(), region: "local".into(), cluster: "kind".into() };
    // Eviction은 재시도 없는 클라이언트로 보낸다(운영과 같다): 있는 그대로의 429를 받아야 5분 한도가 맞는다
    let (context, value) = base();
    let evict_client = super::connect::eviction_client(&build(&value), &context, PRIVATE).await.unwrap();
    let job = |plan| Job {
        client: client.clone(),
        evict_client: evict_client.clone(),
        endpoint: PRIVATE,
        log_path: log_path.clone(),
        target: target.clone(),
        change: change.clone(),
        plan,
        at: "2026-01-01T00:00:00Z".into(),
        // 막힌 Pod는 8초만 기다린다
        limits: Limits { stall: Duration::from_secs(8), first_delay: Duration::from_secs(1), max_delay: Duration::from_secs(2), ..Limits::default() },
    };
    let run = |plan| {
        let job = job(plan);
        async move {
            let (_keep, cancel) = tokio::sync::watch::channel(false);
            let mut messages = Vec::new();
            apply(job, cancel, |m| {
                messages.push(m);
                true
            })
            .await;
            messages
        }
    };
    let pods: kube::Api<Pod> = kube::Api::namespaced(client.clone(), "mm-drain");
    let alive = |pods: Vec<Pod>, app: &str| {
        pods.into_iter()
            .filter(|pod| pod.metadata.labels.as_ref().and_then(|l| l.get("app")).is_some_and(|a| a == app) || pod.metadata.name.as_deref() == Some(app))
            .filter(|pod| pod.metadata.deletion_timestamp.is_none())
            .filter(|pod| pod.spec.as_ref().and_then(|s| s.node_name.as_deref()) == Some(worker.as_str()))
            .count()
    };

    // 첫 번째: PDB가 막은 Pod 때문에 5분 대신 짧은 한도에서 멈춘다. 나머지는 옮겨진다.
    let messages = run(drain.clone()).await;
    let Some(DrainMessage::Finished { outcome, counts, .. }) = messages.last() else { panic!("{messages:?}") };
    assert_eq!(*outcome, Outcome::TimedOut, "{messages:?}");
    assert_eq!(counts.blocked, 1);
    assert!(messages.iter().any(|m| matches!(m, DrainMessage::Cordoned)));
    assert!(messages.iter().any(|m| matches!(m, DrainMessage::Pod { name, state: PodState::Blocked, .. } if name.starts_with("held-"))));
    assert!(messages.iter().any(|m| matches!(m, DrainMessage::Pod { name, state: PodState::Evicted, .. } if name == "bare")));
    let node = nodes.get(&worker).await.unwrap();
    assert_eq!(node.spec.and_then(|s| s.unschedulable), Some(true));
    let listed = pods.list(&ListParams::default()).await.unwrap().items;
    // Evicted로 센 Pod는 종료까지 기다린 뒤라 원래 Pod(UID)가 목록에 아예 없다
    for original in [&free.uid, &bare.uid] {
        assert!(!listed.iter().any(|pod| pod.metadata.uid.as_deref() == Some(original.as_str())), "{original}가 아직 남아 있어요");
    }
    assert!(messages.iter().any(|m| matches!(m, DrainMessage::Pod { name, state: PodState::Terminating, .. } if name == "bare")));
    assert_eq!(alive(listed.clone(), "free"), 0, "free는 옮겨졌어요");
    assert_eq!(alive(listed.clone(), "bare"), 0, "컨트롤러 없는 Pod는 지워졌어요");
    assert_eq!(alive(listed, "held"), 1, "막힌 Pod는 그대로예요");
    let entries = log::read_all(&log_path);
    assert_eq!(entries.len(), 2, "{entries:?}");
    assert_eq!(entries[0].change.operation, Operation::Cordon { unschedulable: true });
    assert!(entries[0].ok);
    assert_eq!(entries[0].inverse.as_ref().map(|c| c.operation.clone()), Some(Operation::Cordon { unschedulable: false }));
    assert_eq!(entries[1].change.operation, Operation::Drain);
    assert!(!entries[1].ok && entries[1].summary.contains("1개 막힘"), "{:?}", entries[1]);

    // 막힘을 풀고(PDB 삭제) 다시: 이미 중지된 노드라 cordon 없이 남은 Pod만 옮긴다
    kubectl(&["-n", "mm-drain", "delete", "pdb", "held"]);
    let again = commit::make_plan(client.clone(), PRIVATE, &change, "").await.unwrap();
    let again_plan = again.preview.drain.clone().unwrap();
    assert!(again_plan.node_cordoned && !again.preview.reversible);
    assert!(again_plan.evict.iter().any(|pod| pod.name.starts_with("held-")));
    let messages = run(again_plan).await;
    let Some(DrainMessage::Finished { outcome, .. }) = messages.last() else { panic!("{messages:?}") };
    assert_eq!(*outcome, Outcome::Completed, "{messages:?}");
    assert_eq!(alive(pods.list(&ListParams::default()).await.unwrap().items, "held"), 0);
    assert_eq!(log::read_all(&log_path).len(), 3);

    // 되돌리기는 uncordon만: 기록된 역변경을 미리보기하고 적용한다
    let undo = entries[0].inverse.clone().unwrap();
    let plan = commit::dry_plan(client.clone(), PRIVATE, &undo, "").await.unwrap();
    let (_, result) = commit::apply_plan(client.clone(), PRIVATE, &undo, &plan, "", None).await.unwrap();
    result.unwrap();
    let node = nodes.get(&worker).await.unwrap();
    assert!(node.spec.and_then(|s| s.unschedulable) != Some(true));
}

/// 이 시험은 스크립트가 만든 kind 클러스터에서만 쓰기 요청을 보낸다.
#[tokio::test]
#[ignore]
async fn yaml_apply_diff_conflict_force_create_and_undo() {
    use super::change::{Change, ChangeObject, Operation};
    use super::{commit, read};
    use kube::api::{Patch, PatchParams};

    let client = admin().await;
    let object_ref = |group: &str, version: &str, kind: &str, plural: &str, name: &str| ChangeObject {
        kind: KindRef { group: group.into(), version: version.into(), kind: kind.into(), plural: plural.into(), namespaced: true },
        namespace: Some("mm-k2".into()),
        name: name.into(),
    };
    let config = object_ref("", "v1", "ConfigMap", "configmaps", "mm-e-config");
    let apply = |target: &ChangeObject, object: Value, force: bool| Change { target: target.clone(), operation: Operation::Apply { object, force } };
    let config_doc = |value: &str| json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"mm-e-config"},"data":{"key":value,"other":"x"}});
    let get = |target: ChangeObject| {
        let client = client.clone();
        async move { commit::current(client, PRIVATE, &target).await.unwrap() }
    };
    let apply_all = |client: kube::Client, change: Change, plan: super::change::Plan, typed: Option<&'static str>| async move {
        commit::apply_plan(client, PRIVATE, &change, &plan, "", typed).await
    };

    // 새로 만들기: 객체 전체가 한 항목이고, 되돌리기는 삭제다. 문서에 네임스페이스가 없어도 대상의 것을 쓴다
    let create = apply(&config, config_doc("one"), false);
    let plan = commit::dry_plan(client.clone(), PRIVATE, &create, "").await.unwrap();
    assert!(get(config.clone()).await.is_none(), "dry-run은 만들지 않아요");
    assert_eq!(plan.preview.diff.len(), 1);
    assert_eq!(plan.preview.diff[0].before, Value::Null);
    assert_eq!(plan.preview.diff[0].after["data"]["key"], "one");
    assert_eq!(plan.inverse.as_ref().unwrap().operation, Operation::Delete);
    let (_, result) = apply_all(client.clone(), create.clone(), plan, None).await.unwrap();
    result.unwrap();
    let created = get(config.clone()).await.unwrap();
    assert_eq!(created["data"]["key"], "one");
    let managers: Vec<&str> = created["metadata"]["managedFields"].as_array().unwrap().iter().filter_map(|m| m["manager"].as_str()).collect();
    assert!(managers.contains(&"magic-mirror"), "{managers:?}");

    // 고치기: 바뀐 필드만 diff에 나오고, 역변경은 정리한 이전 객체의 apply다
    let edit = apply(&config, config_doc("two"), false);
    let plan = commit::dry_plan(client.clone(), PRIVATE, &edit, "").await.unwrap();
    assert_eq!(plan.preview.diff.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), ["data.key"]);
    assert_eq!((&plan.preview.diff[0].before, &plan.preview.diff[0].after), (&json!("one"), &json!("two")));
    assert!(plan.preview.conflicts.is_empty());
    assert_eq!(get(config.clone()).await.unwrap()["data"]["key"], "one");
    let inverse = plan.inverse.clone().unwrap();
    let (_, result) = apply_all(client.clone(), edit.clone(), plan, None).await.unwrap();
    result.unwrap();
    assert_eq!(get(config.clone()).await.unwrap()["data"]["key"], "two");
    let undo_plan = commit::dry_plan(client.clone(), PRIVATE, &inverse, "").await.unwrap();
    assert_eq!(undo_plan.preview.diff.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), ["data.key"]);
    let (_, result) = apply_all(client.clone(), inverse, undo_plan, None).await.unwrap();
    result.unwrap();
    assert_eq!(get(config.clone()).await.unwrap()["data"]["key"], "one");

    // 같은 내용이면 바뀌는 것이 없다는 경고
    let same = commit::dry_plan(client.clone(), PRIVATE, &apply(&config, config_doc("one"), false), "").await.unwrap();
    assert!(same.preview.diff.is_empty());
    assert!(same.preview.warnings.contains(&super::change::NOOP_WARNING.to_string()));

    // 다른 manager가 가진 필드: 충돌은 필드와 소유 manager로 나오고 적용은 막힌다. 강제 적용은 이름을 입력받는다
    let other = json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"mm-e-config","namespace":"mm-k2"},"data":{"key":"theirs"}});
    let api = read::api_for(client.clone(), &config.kind, config.namespace.as_deref());
    api.patch("mm-e-config", &PatchParams::apply("other-mgr").force(), &Patch::Apply(&other)).await.unwrap();
    let mine = apply(&config, config_doc("mine"), false);
    let conflicted = commit::dry_plan(client.clone(), PRIVATE, &mine, "").await.unwrap();
    assert_eq!(conflicted.preview.conflicts.len(), 1, "{:?}", conflicted.preview.conflicts);
    assert_eq!(conflicted.preview.conflicts[0].field, ".data.key");
    assert_eq!(conflicted.preview.conflicts[0].manager, "other-mgr");
    assert!(commit::check(Some(&conflicted), &conflicted, None).is_err());
    assert!(commit::apply_plan(client.clone(), PRIVATE, &mine, &conflicted, "", None).await.is_err());
    assert_eq!(get(config.clone()).await.unwrap()["data"]["key"], "theirs");
    let forced = apply(&config, config_doc("mine"), true);
    let plan = commit::dry_plan(client.clone(), PRIVATE, &forced, "").await.unwrap();
    assert!(plan.preview.conflicts.is_empty());
    assert_eq!(plan.preview.confirm_name.as_deref(), Some("mm-e-config"));
    assert!(plan.preview.calls[0].path.ends_with("&force=true"));
    assert!(commit::apply_plan(client.clone(), PRIVATE, &forced, &plan, "", None).await.is_err(), "이름 없이는 강제 적용하지 않아요");
    assert_eq!(get(config.clone()).await.unwrap()["data"]["key"], "theirs");
    let (_, result) = apply_all(client.clone(), forced, plan, Some("mm-e-config")).await.unwrap();
    result.unwrap();
    assert_eq!(get(config.clone()).await.unwrap()["data"]["key"], "mine");

    // 미리보기 뒤에 내용이 바뀌면 낡은 미리보기다
    let stale = apply(&config, config_doc("mine2"), false);
    let seen = commit::dry_plan(client.clone(), PRIVATE, &stale, "").await.unwrap();
    kubectl(&["-n", "mm-k2", "patch", "configmap", "mm-e-config", "--type=merge", "-p", r#"{"data":{"other":"changed"}}"#]);
    assert_eq!(commit::apply_plan(client.clone(), PRIVATE, &stale, &seen, "", None).await.unwrap_err(), AppError::other(super::exec::STALE));
    assert_eq!(get(config.clone()).await.unwrap()["data"]["key"], "mine");

    // 서버가 받지 않는 객체는 서버의 이유가 나온다
    let deployment = object_ref("apps", "v1", "Deployment", "deployments", "mm-e-bad");
    let bad = apply(&deployment, json!({"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"mm-e-bad"},"spec":{"replicas":-1,"selector":{"matchLabels":{"a":"b"}},"template":{"metadata":{"labels":{"a":"b"}},"spec":{"containers":[{"name":"c","image":"registry.k8s.io/pause:3.10"}]}}}}), false);
    let AppError::Other { message } = commit::dry_plan(client.clone(), PRIVATE, &bad, "").await.unwrap_err() else { panic!("다른 오류예요") };
    assert!(message.starts_with(super::exec::REJECTED), "{message}");
    assert!(message.contains("replicas"), "{message}");

    // 여러 문서를 순서대로 만들고(ConfigMap, Deployment), 만든 순서의 반대로 삭제해 되돌린다
    let web = object_ref("apps", "v1", "Deployment", "deployments", "mm-e-web");
    let second = apply(&web, json!({"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"mm-e-web"},"spec":{"replicas":0,"selector":{"matchLabels":{"app":"mm-e"}},"template":{"metadata":{"labels":{"app":"mm-e"}},"spec":{"containers":[{"name":"app","image":"registry.k8s.io/pause:3.10"}]}}}}), false);
    let extra = object_ref("", "v1", "ConfigMap", "configmaps", "mm-e-extra");
    let first = apply(&extra, json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"mm-e-extra"},"data":{"a":"1"}}), false);
    let mut undo = Vec::new();
    for change in [first, second] {
        let plan = commit::dry_plan(client.clone(), PRIVATE, &change, "").await.unwrap();
        undo.push(plan.inverse.clone().unwrap());
        let (_, result) = apply_all(client.clone(), change, plan, None).await.unwrap();
        result.unwrap();
    }
    assert!(get(extra.clone()).await.is_some() && get(web.clone()).await.is_some());
    for change in undo.into_iter().rev() {
        assert_eq!(change.operation, Operation::Delete);
        // 만든 직후에는 컨트롤러가 객체에 어노테이션을 더할 수 있어, 낡았다고 하면 사용자처럼 미리보기를 다시 받는다
        let mut attempts = 0;
        loop {
            attempts += 1;
            let plan = commit::dry_plan(client.clone(), PRIVATE, &change, "").await.unwrap();
            match apply_all(client.clone(), change.clone(), plan, None).await {
                Ok((_, result)) => break result.unwrap(),
                Err(error) if error == AppError::other(super::exec::STALE) && attempts < 5 => tokio::time::sleep(Duration::from_secs(1)).await,
                Err(error) => panic!("{error:?}"),
            }
        }
    }
    assert!(get(extra).await.is_none() && get(web).await.is_none());

    // Secret: 가린 값은 현재 값으로 남고 새 값만 stringData로 들어간다. 미리보기와 diff에는 값이 없고, 되돌릴 수 없다
    let secret = object_ref("", "v1", "Secret", "secrets", "mm-e-secret");
    let first = apply(&secret, json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"mm-e-secret"},"stringData":{"keep":"keep-value","change":"before-value"}}), false);
    let plan = commit::dry_plan(client.clone(), PRIVATE, &first, "").await.unwrap();
    let (_, result) = apply_all(client.clone(), first, plan, None).await.unwrap();
    result.unwrap();
    let edited = apply(&secret, json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"mm-e-secret"},"data":{"keep":"••••"},"stringData":{"change":"after-value","added":"added-value"}}), false);
    let plan = commit::dry_plan(client.clone(), PRIVATE, &edited, "").await.unwrap();
    let shown = serde_json::to_string(&plan.preview.displayed()).unwrap();
    for value in ["keep-value", "before-value", "after-value", "added-value", "a2VlcC12YWx1ZQ==", "YWZ0ZXItdmFsdWU="] {
        assert!(!shown.contains(value), "{value} 가 미리보기에 있어요");
    }
    let mut paths: Vec<&str> = plan.preview.diff.iter().map(|d| d.path.as_str()).collect();
    paths.sort();
    assert_eq!(paths, ["data.added", "data.change"]);
    assert!(plan.inverse.is_none() && !plan.preview.reversible);
    let (_, result) = apply_all(client.clone(), edited, plan, None).await.unwrap();
    result.unwrap();
    let stored = get(secret.clone()).await.unwrap();
    let decode = |key: &str| String::from_utf8(base64::Engine::decode(&base64::engine::general_purpose::STANDARD, stored["data"][key].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!((decode("keep"), decode("change"), decode("added")), ("keep-value".into(), "after-value".into(), "added-value".into()));

    kubectl(&["-n", "mm-k2", "delete", "configmap/mm-e-config", "secret/mm-e-secret", "--ignore-not-found"]);
}

/// 이 시험은 스크립트가 만든 kind 클러스터에서만 쓰기 요청을 보낸다.
#[tokio::test]
#[ignore]
async fn unowned_job_delete_recreates_and_cluster_admin_binding_needs_the_name() {
    use super::change::{Change, ChangeObject, Operation};
    use super::{commit, read};
    use kube::api::{DynamicObject, PostParams};

    let client = admin().await;
    let get = |target: ChangeObject| {
        let client = client.clone();
        async move { commit::current(client, PRIVATE, &target).await.unwrap() }
    };

    // 소유자 없는 Job: 서버가 만든 selector와 controller-uid 라벨이 있어도 지운 뒤 되돌리면 다시 만들어진다
    let job = ChangeObject {
        kind: KindRef { group: "batch".into(), version: "v1".into(), kind: "Job".into(), plural: "jobs".into(), namespaced: true },
        namespace: Some("mm-k2".into()),
        name: "mm-e-job".into(),
    };
    let api = read::api_for(client.clone(), &job.kind, job.namespace.as_deref());
    let fixture: DynamicObject = serde_json::from_value(json!({"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"mm-e-job","namespace":"mm-k2"},
        "spec":{"template":{"spec":{"restartPolicy":"Never","containers":[{"name":"app","image":"registry.k8s.io/pause:3.10"}]}}}})).unwrap();
    api.create(&PostParams::default(), &fixture).await.unwrap();
    let created = get(job.clone()).await.unwrap();
    assert!(created["spec"].get("selector").is_some() && created["spec"]["template"]["metadata"]["labels"].as_object().is_some_and(|l| l.contains_key("batch.kubernetes.io/controller-uid") || l.contains_key("controller-uid")));
    let delete = Change { target: job.clone(), operation: Operation::Delete };
    let plan = commit::dry_plan(client.clone(), PRIVATE, &delete, "").await.unwrap();
    let recreate = plan.inverse.clone().expect("소유자 없는 Job은 되돌릴 수 있어요");
    let (_, result) = commit::apply_plan(client.clone(), PRIVATE, &delete, &plan, "", None).await.unwrap();
    result.unwrap();
    tokio::time::timeout(Duration::from_secs(60), async {
        while get(job.clone()).await.is_some() {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }).await.expect("Job이 지워지지 않았어요");
    let plan = commit::dry_plan(client.clone(), PRIVATE, &recreate, "").await.expect("정리한 Job은 dry-run에서 받아들여져야 해요");
    let (_, result) = commit::apply_plan(client.clone(), PRIVATE, &recreate, &plan, "", None).await.unwrap();
    result.unwrap();
    let again = get(job.clone()).await.expect("다시 만들어진 Job");
    assert_ne!(again["metadata"]["uid"], created["metadata"]["uid"]);
    kubectl(&["-n", "mm-k2", "delete", "job/mm-e-job", "--ignore-not-found", "--wait=false"]);

    // cluster-admin을 주는 바인딩을 YAML로 만들면 이름을 입력해야 한다
    let binding = ChangeObject {
        kind: KindRef { group: "rbac.authorization.k8s.io".into(), version: "v1".into(), kind: "ClusterRoleBinding".into(), plural: "clusterrolebindings".into(), namespaced: false },
        namespace: None,
        name: "mm-e-admin".into(),
    };
    let object = |role: &str| json!({"apiVersion":"rbac.authorization.k8s.io/v1","kind":"ClusterRoleBinding","metadata":{"name":"mm-e-admin"},
        "roleRef":{"apiGroup":"rbac.authorization.k8s.io","kind":"ClusterRole","name":role},"subjects":[{"kind":"User","name":"mm-e-nobody","apiGroup":"rbac.authorization.k8s.io"}]});
    let grant = Change { target: binding.clone(), operation: Operation::Apply { object: object("cluster-admin"), force: false } };
    let plan = commit::dry_plan(client.clone(), PRIVATE, &grant, "").await.unwrap();
    assert_eq!(plan.preview.confirm_name.as_deref(), Some("mm-e-admin"));
    assert_eq!(commit::apply_plan(client.clone(), PRIVATE, &grant, &plan, "", None).await.unwrap_err(), AppError::other(commit::CONFIRM_REQUIRED));
    assert!(get(binding.clone()).await.is_none());
    let (_, result) = commit::apply_plan(client.clone(), PRIVATE, &grant, &plan, "", Some("mm-e-admin")).await.unwrap();
    result.unwrap();
    // 이미 있는 cluster-admin 바인딩의 subjects를 바꿀 때도 같다
    let mut edited = object("cluster-admin");
    edited["subjects"] = json!([{"kind":"User","name":"mm-e-other","apiGroup":"rbac.authorization.k8s.io"}]);
    let edit = Change { target: binding.clone(), operation: Operation::Apply { object: edited, force: false } };
    assert_eq!(commit::dry_plan(client.clone(), PRIVATE, &edit, "").await.unwrap().preview.confirm_name.as_deref(), Some("mm-e-admin"));
    let ordinary = Change { target: ChangeObject { name: "mm-e-view".into(), ..binding.clone() }, operation: Operation::Apply { object: json!({"apiVersion":"rbac.authorization.k8s.io/v1","kind":"ClusterRoleBinding","metadata":{"name":"mm-e-view"},
        "roleRef":{"apiGroup":"rbac.authorization.k8s.io","kind":"ClusterRole","name":"view"},"subjects":[{"kind":"User","name":"mm-e-nobody","apiGroup":"rbac.authorization.k8s.io"}]}), force: false } };
    assert!(commit::dry_plan(client.clone(), PRIVATE, &ordinary, "").await.unwrap().preview.confirm_name.is_none());
    kubectl(&["delete", "clusterrolebinding/mm-e-admin", "--ignore-not-found"]);
}

// ---- 사용량(metrics-server) ----
// kind에는 metrics-server가 없다. 스크립트가 첫 판을 끝낸 뒤 설치하고 `K8S_LIVE_METRICS=1`로 `metrics_with_server`만 다시 돌린다.

fn has_metrics_server() -> bool {
    std::env::var("K8S_LIVE_METRICS").is_ok()
}

#[tokio::test]
#[ignore]
async fn metrics_without_server_are_unavailable_not_an_error() {
    if has_metrics_server() {
        return;
    }
    let client = admin().await;
    for namespace in [None, Some("kube-system")] {
        let m = metrics(&client, namespace, PRIVATE).await.unwrap();
        assert_eq!((m.pods_unavailable, m.nodes_unavailable), (Some(Unavailable::NotInstalled), Some(Unavailable::NotInstalled)));
        assert!(m.pods.is_empty() && m.nodes.is_empty());
    }
}

#[tokio::test]
#[ignore]
async fn metrics_for_a_reader_without_access_are_forbidden() {
    let (context, value) = reader_config();
    let client = client_for(&build(&value), &context, PRIVATE).await.unwrap();
    let m = metrics(&client, Some("mm-live"), PRIVATE).await.unwrap();
    assert_eq!((m.pods_unavailable, m.nodes_unavailable), (Some(Unavailable::Forbidden), Some(Unavailable::Forbidden)));
}

#[tokio::test]
#[ignore]
async fn metrics_with_server_read_pods_nodes_and_controller_chains() {
    if !has_metrics_server() {
        eprintln!("K8S_LIVE_METRICS가 없어 건너뛰어요");
        return;
    }
    let client = admin().await;
    // metrics-server가 첫 수집을 끝낼 때까지 기다린다: web Pod의 사용량이 보일 때까지
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    let all = loop {
        let m = metrics(&client, None, PRIVATE).await.unwrap();
        if m.pods_unavailable.is_none() && m.pods.iter().any(|p| p.namespace == "mm-k2" && p.name.starts_with("web-")) && !m.nodes.is_empty() {
            break m;
        }
        assert!(tokio::time::Instant::now() < deadline, "metrics never covered mm-k2/web: {m:?}");
        tokio::time::sleep(Duration::from_secs(5)).await;
    };
    assert_eq!((all.pods_unavailable, all.nodes_unavailable), (None, None));
    assert!(all.nodes.iter().all(|n| n.cpu_milli > 0 && n.memory_bytes > 0), "{:?}", all.nodes);
    let web = all.pods.iter().find(|p| p.namespace == "mm-k2" && p.name.starts_with("web-")).unwrap();
    assert!(web.memory_bytes > 0 && web.containers.len() == 1 && web.containers[0].name == "app");
    assert_eq!(web.memory_bytes, web.containers[0].memory_bytes);
    // Pod → ReplicaSet → Deployment
    let names: Vec<(&str, &str)> = web.owners.iter().map(|o| (o.kind.as_str(), o.name.as_str())).collect();
    assert!(matches!(names.as_slice(), [("ReplicaSet", rs), ("Deployment", "web")] if rs.starts_with("web-")), "{names:?}");
    // coredns도 Deployment까지 올라간다
    let dns = all.pods.iter().find(|p| p.namespace == "kube-system" && p.name.starts_with("coredns-")).expect("coredns metrics");
    assert_eq!(dns.owners.last().map(|o| (o.kind.as_str(), o.name.as_str())), Some(("Deployment", "coredns")));
    // 네임스페이스 하나로 좁히면 그 네임스페이스 Pod만 온다
    let one = metrics(&client, Some("mm-k2"), PRIVATE).await.unwrap();
    assert!(!one.pods.is_empty() && one.pods.iter().all(|p| p.namespace == "mm-k2"));
    assert!(one.pods.iter().any(|p| p.name == web.name));
}

#[tokio::test]
#[ignore]
async fn pod_and_node_rows_carry_bounds_and_allocatable() {
    use super::rows::row_of;
    let client = admin().await;
    let pods = api_for(client.clone(), &kind_ref("", "v1", "Pod", "pods"), Some("kube-system"));
    let dns = pods.list(&kube::api::ListParams::default().labels("k8s-app=kube-dns")).await.unwrap();
    let row = row_of(&kind_ref("", "v1", "Pod", "pods"), dns.items.first().expect("a coredns pod"));
    // coredns는 CPU·메모리 요청과 메모리 제한을 두고 CPU 제한은 두지 않는다
    assert_eq!(row.values.get("cpuRequest").map(String::as_str), Some("100"));
    assert!(row.values.contains_key("memoryRequest") && row.values.contains_key("memoryLimit"), "{:?}", row.values);
    assert!(!row.values.contains_key("cpuLimit"));
    let node_kind = KindRef { group: String::new(), version: "v1".into(), kind: "Node".into(), plural: "nodes".into(), namespaced: false };
    let list = api_for(client, &node_kind, None).list(&kube::api::ListParams::default()).await.unwrap();
    for n in &list.items {
        let row = row_of(&node_kind, n);
        assert!(row.values["cpuAllocatable"].parse::<i64>().unwrap() > 0 && row.values["memoryAllocatable"].parse::<i64>().unwrap() > 0, "{:?}", row.values);
    }
}
