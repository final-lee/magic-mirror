use std::sync::{Arc, Mutex};
use std::time::Duration;

use kube::{Client, Config};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;
use crate::k8s::change::ChangeObject;
use crate::k8s::rows::KindRef;
use crate::k8s::tls::install_crypto_provider;

/// 이름이 `blocked`로 시작하는 Pod만 막고 나머지는 옮기는 가짜
struct Fake {
    attempted: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl Evictor for Fake {
    async fn evict_pod(&self, pod: &DrainPod) -> Eviction {
        self.attempted.lock().unwrap().push(pod.name.clone());
        if pod.name.starts_with("blocked") {
            Eviction::Blocked
        } else {
            Eviction::Evicted
        }
    }

    async fn still_there(&self, _pod: &DrainPod) -> bool {
        false
    }
}

fn pod(name: &str) -> DrainPod {
    DrainPod { namespace: "app".into(), name: name.into(), uid: "u".into(), empty_dir: false, unmanaged: false, blocked_by: None, grace_seconds: 30 }
}

/// 이미 스케줄이 중지된 노드의 작업. cordon을 건너뛰므로 클라이언트는 요청을 보내지 않는다.
fn job(dir: &tempfile::TempDir, pods: Vec<DrainPod>) -> Job {
    install_crypto_provider();
    let client = Client::try_from(Config::new("http://127.0.0.1:9".parse().unwrap())).unwrap();
    Job {
        evict_client: client.clone(),
        client,
        endpoint: Endpoint { public: true, private: false },
        log_path: dir.path().join("k8s-changes.jsonl"),
        target: K8sTarget { profile: "p".into(), region: "r".into(), cluster: "c".into() },
        change: Change {
            target: ChangeObject {
                kind: KindRef { group: String::new(), version: "v1".into(), kind: "Node".into(), plural: "nodes".into(), namespaced: false },
                namespace: None,
                name: "worker".into(),
            },
            operation: Operation::Drain,
        },
        plan: DrainPlan { node_cordoned: true, evict: pods, skipped: Vec::new(), budgets_unknown: false },
        at: "2026-01-01T00:00:00Z".into(),
        limits: Limits { stall: Duration::from_secs(5), first_delay: Duration::from_secs(1), max_delay: Duration::from_secs(2), ..Limits::default() },
    }
}

async fn drive(job: Job, cancel: watch::Receiver<bool>) -> Vec<DrainMessage> {
    let fake = Fake { attempted: Mutex::new(Vec::new()) };
    let mut messages = Vec::new();
    apply_with(
        job,
        cancel,
        |m| {
            messages.push(m);
            true
        },
        &fake,
    )
    .await;
    messages
}

#[test]
fn summary_lists_only_the_counts_that_matter() {
    let all = Counts { total: 9, pending: 1, evicting: 1, evicted: 3, blocked: 1, terminating: 1, lingering: 1, failed: 1 };
    assert_eq!(summary(&all), "Pod 3개 옮김, 1개 종료 중, 1개 종료 지연, 1개 막힘, 1개 실패, 2개 남음");
    assert_eq!(summary(&Counts { total: 2, evicted: 2, ..Counts::default() }), "Pod 2개 옮김");
}

#[tokio::test(start_paused = true)]
async fn a_finished_drain_streams_in_order_and_records_one_entry_with_no_undo() {
    let dir = tempfile::tempdir().unwrap();
    let job = job(&dir, vec![pod("a"), pod("b")]);
    let log_path = job.log_path.clone();
    let (_keep, cancel) = watch::channel(false);
    let messages = drive(job, cancel).await;
    assert!(matches!(messages[0], DrainMessage::Started { .. }));
    assert_eq!(messages[1], DrainMessage::Cordoned);
    let DrainMessage::Finished { outcome, counts, error } = messages.last().unwrap() else { panic!("{messages:?}") };
    assert_eq!((*outcome, counts.evicted, error.is_none()), (Outcome::Completed, 2, true));
    // 이미 중지된 노드라서 cordon 기록은 없고 drain 요약만 남는다
    let entries = log::read_all(&log_path);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].change.operation, Operation::Drain);
    assert_eq!(entries[0].summary, "drain: Pod 2개 옮김");
    assert!(entries[0].ok && entries[0].error.is_none() && entries[0].inverse.is_none());
}

#[tokio::test(start_paused = true)]
async fn a_drain_stopped_by_a_budget_is_recorded_as_not_ok_with_the_reason() {
    let dir = tempfile::tempdir().unwrap();
    let job = job(&dir, vec![pod("a"), pod("blocked")]);
    let log_path = job.log_path.clone();
    let (_keep, cancel) = watch::channel(false);
    let messages = drive(job, cancel).await;
    let DrainMessage::Finished { outcome, counts, .. } = messages.last().unwrap() else { panic!("{messages:?}") };
    assert_eq!((*outcome, counts.evicted, counts.blocked), (Outcome::TimedOut, 1, 1));
    let entries = log::read_all(&log_path);
    assert_eq!(entries[0].summary, "drain: Pod 1개 옮김, 1개 막힘");
    assert!(!entries[0].ok);
    assert_eq!(entries[0].error.as_deref(), Some(TIMED_OUT));
}

#[tokio::test(start_paused = true)]
async fn a_cancelled_drain_is_recorded_as_stopped() {
    let dir = tempfile::tempdir().unwrap();
    let job = job(&dir, vec![pod("a")]);
    let log_path = job.log_path.clone();
    let (tx, cancel) = watch::channel(false);
    tx.send_replace(true);
    let messages = drive(job, cancel).await;
    assert!(matches!(messages.last(), Some(DrainMessage::Finished { outcome: Outcome::Stopped, .. })));
    assert_eq!(log::read_all(&log_path)[0].error.as_deref(), Some(STOPPED));
}

#[tokio::test(start_paused = true)]
async fn an_unwritable_record_is_reported_in_the_last_message() {
    let dir = tempfile::tempdir().unwrap();
    let mut job = job(&dir, vec![pod("a")]);
    // 폴더를 파일로 열 수 없다
    job.log_path = dir.path().to_path_buf();
    let (_keep, cancel) = watch::channel(false);
    let messages = drive(job, cancel).await;
    let DrainMessage::Finished { error, .. } = messages.last().unwrap() else { panic!("{messages:?}") };
    assert_eq!(*error, Some(AppError::other(RECORD_FAILED)));
}

/// 경로별로 정해 둔 JSON을 돌려주는 가짜 API 서버. 경로는 `메서드 경로`(쿼리 제외)이고, 받은 요청줄을 모아 둔다.
async fn api_server(routes: Vec<(&'static str, u16, &'static str)>) -> (Client, Arc<Mutex<Vec<String>>>) {
    install_crypto_provider();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (routes, log) = (routes.clone(), log.clone());
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    request.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&request).to_string();
                    let Some((head, rest)) = text.split_once("\r\n\r\n") else {
                        continue;
                    };
                    let length = head
                        .lines()
                        .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if rest.len() < length {
                        continue;
                    }
                    let first = head.lines().next().unwrap_or_default();
                    let mut words = first.split(' ');
                    let key = format!("{} {}", words.next().unwrap_or_default(), words.next().unwrap_or_default().split('?').next().unwrap_or_default());
                    log.lock().unwrap().push(first.to_string());
                    let (code, body) = routes.iter().find(|(route, _, _)| *route == key).map_or((404, r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}"#), |(_, code, body)| (*code, *body));
                    let response = format!("HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = socket.write_all(response.as_bytes()).await;
                    return;
                }
            });
        }
    });
    let client = Client::try_from(Config::new(format!("http://127.0.0.1:{port}").parse().unwrap())).unwrap();
    (client, seen)
}

const NODE: &str = r#"{"apiVersion":"v1","kind":"Node","metadata":{"name":"prod-1","resourceVersion":"5"},"spec":{}}"#;

/// 이름에 prod가 든 노드는 cordon에도 이름 확인을 요구한다. drain을 받을 때 이미 입력한 이름을 넘겨 주므로 cordon이 거절되지 않는다.
#[tokio::test]
async fn a_prod_node_is_cordoned_with_the_name_already_confirmed() {
    let (client, requests) = api_server(vec![("GET /api/v1/nodes/prod-1", 200, NODE), ("PATCH /api/v1/nodes/prod-1", 200, NODE)]).await;
    let dir = tempfile::tempdir().unwrap();
    let mut job = job(&dir, Vec::new());
    job.client = client.clone();
    job.evict_client = client;
    job.plan.node_cordoned = false;
    job.change.target.name = "prod-1".into();
    let log_path = job.log_path.clone();
    let (_keep, cancel) = watch::channel(false);
    let messages = drive(job, cancel).await;
    let DrainMessage::Finished { outcome, error, .. } = messages.last().unwrap() else { panic!("{messages:?}") };
    assert_eq!((*outcome, error.is_none()), (Outcome::Completed, true), "{messages:?}");
    assert!(messages.contains(&DrainMessage::Cordoned));
    // dry-run과 실제 PATCH가 모두 나갔다
    let patches = requests.lock().unwrap().iter().filter(|line| line.starts_with("PATCH /api/v1/nodes/prod-1")).count();
    assert_eq!(patches, 2, "{:?}", requests.lock().unwrap());
    let entries = log::read_all(&log_path);
    assert_eq!(entries[0].change.operation, Operation::Cordon { unschedulable: true });
    assert!(entries[0].ok, "{:?}", entries[0]);
    assert_eq!(entries[0].inverse.as_ref().map(|c| c.operation.clone()), Some(Operation::Cordon { unschedulable: false }));
}

fn cluster(client: Client) -> Cluster {
    Cluster { evict_client: client.clone(), client, endpoint: Endpoint { public: true, private: false } }
}

#[tokio::test]
async fn a_pod_is_still_there_only_while_the_same_uid_exists() {
    const POD: &str = r#"{"apiVersion":"v1","kind":"Pod","metadata":{"name":"web","namespace":"app","uid":"u-new"}}"#;
    let route = "GET /api/v1/namespaces/app/pods/web";
    let mut web = pod("web");
    web.uid = "u-old".into();
    // 같은 이름으로 다시 생긴 Pod는 사라진 것으로 본다
    let (client, _) = api_server(vec![(route, 200, POD)]).await;
    assert!(!cluster(client).still_there(&web).await);
    web.uid = "u-new".into();
    let (client, _) = api_server(vec![(route, 200, POD)]).await;
    assert!(cluster(client).still_there(&web).await);
    // 없으면 사라진 것
    let (client, _) = api_server(vec![]).await;
    assert!(!cluster(client).still_there(&web).await);
    // 읽지 못하면 아직 있는 것으로 보고 기다림 한도가 끝을 정한다
    let (client, _) = api_server(vec![(route, 500, r#"{"kind":"Status","apiVersion":"v1","status":"Failure","code":500}"#)]).await;
    assert!(cluster(client).still_there(&web).await);
}
