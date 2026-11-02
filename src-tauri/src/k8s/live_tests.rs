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
use super::read::detail::{get, ContainerState};
use super::read::kinds::{discover, kinds_of};
use super::read::overview::k8s_parts;
use super::read::secret::{key_missing, secret_value, secrets_kind, Encoding, SecretKey, SecretValue, MASK};
use super::read::values::Problem;
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
    let (requests, partial) = parts.requests.unwrap();
    assert!(!partial);
    // coredns가 CPU를 요청한다
    assert!(requests.values().any(|r| r.cpu_milli > 0 && r.pods > 0), "{requests:?}");
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
    let Some(LogMessage::Lines { lines }) = recv_log(&mut rx, Duration::from_secs(5)).await else { panic!("no lines") };
    assert!(!lines.is_empty() && lines.len() <= 3, "{lines:?}");
    assert_eq!(recv_log(&mut rx, Duration::from_secs(5)).await, Some(LogMessage::End));
}

#[tokio::test]
#[ignore]
async fn following_logs_stays_open() {
    let client = admin().await;
    let pod = coredns_pod(&client).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let opts = LogOptions { tail_lines: Some(2), follow: true, ..Default::default() };
    let task = tokio::spawn(logs::run(client, "kube-system".into(), pod, opts, PRIVATE, move |m| tx.send(m).is_ok()));
    assert!(matches!(recv_log(&mut rx, Duration::from_secs(5)).await, Some(LogMessage::Lines { .. })));
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
    let Some(LogMessage::Error { error }) = recv_log(&mut rx, Duration::from_secs(5)).await else { panic!("no error") };
    // 서버가 400과 함께 "is waiting to start"류의 설명을 준다. 연결 문제로 잘못 가르지 않는다.
    assert!(!matches!(error, AppError::Network { .. }), "{error:?}");
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
    use crate::k8s::shell::{self, ShellMessage, ShellMode, ShellRecord, ShellTarget, Shells};
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
        std::env::temp_dir().join(format!("mm-live-shell-{name}-{}", std::process::id())).join(shell::RECORD_FILE)
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
        let connected = shell::connect(client, mode, NS, pod, &i.container, PRIVATE).await.unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        let opened = shells.start(log, i, connected, move |m| tx.send(m).is_ok()).unwrap();
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
            if crate::jsonl::read_all::<ShellRecord>(&log).iter().all(|r| r.closed_at.is_some()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let records: Vec<ShellRecord> = crate::jsonl::read_all(&log);
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
        assert!(crate::jsonl::read_all::<ShellRecord>(&log)[0].closed_at.is_some());
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
        let unknown = shell::connect(client.clone(), ShellMode::Exec, NS, "plain", "nope", PRIVATE).await;
        assert_eq!(unknown.err(), Some(AppError::other(shell::NO_SUCH_CONTAINER)));
        let missing = shell::connect(client, ShellMode::Exec, NS, "no-such-pod", "main", PRIVATE).await;
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
}
