use std::sync::Mutex;
use std::time::Duration;

use kube::{Client, Config};

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
}

fn pod(name: &str) -> DrainPod {
    DrainPod { namespace: "app".into(), name: name.into(), uid: "u".into(), empty_dir: false, unmanaged: false, blocked_by: None }
}

/// 이미 스케줄이 중지된 노드의 작업. cordon을 건너뛰므로 클라이언트는 요청을 보내지 않는다.
fn job(dir: &tempfile::TempDir, pods: Vec<DrainPod>) -> Job {
    install_crypto_provider();
    Job {
        client: Client::try_from(Config::new("http://127.0.0.1:9".parse().unwrap())).unwrap(),
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
        limits: Limits { stall: Duration::from_secs(5), first_delay: Duration::from_secs(1), max_delay: Duration::from_secs(2) },
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
    let all = Counts { total: 7, pending: 1, evicting: 1, evicted: 3, blocked: 1, failed: 1 };
    assert_eq!(summary(&all), "Pod 3개 옮김, 1개 막힘, 1개 실패, 2개 남음");
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
