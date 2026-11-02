use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use super::*;

/// 이름별로 정해 둔 답을 차례로 돌려주는 가짜. 답이 떨어지면 마지막 답을 되풀이한다.
struct Script {
    answers: Mutex<HashMap<String, VecDeque<Eviction>>>,
    calls: Mutex<Vec<(String, Duration)>>,
    started: Instant,
    /// 이 Pod를 옮기는 도중에 취소를 켠다
    cancel_during: Option<(String, watch::Sender<bool>)>,
}

impl Script {
    fn new(answers: &[(&str, Vec<Eviction>)]) -> Self {
        Self {
            answers: Mutex::new(answers.iter().map(|(name, list)| (name.to_string(), list.iter().cloned().collect())).collect()),
            calls: Mutex::new(Vec::new()),
            started: Instant::now(),
            cancel_during: None,
        }
    }

    fn calls(&self) -> Vec<(String, u64)> {
        self.calls.lock().unwrap().iter().map(|(name, at)| (name.clone(), at.as_secs())).collect()
    }

    fn attempts(&self, name: &str) -> usize {
        self.calls.lock().unwrap().iter().filter(|(n, _)| n == name).count()
    }
}

#[async_trait::async_trait]
impl Evictor for Script {
    async fn evict_pod(&self, pod: &DrainPod) -> Eviction {
        self.calls.lock().unwrap().push((pod.name.clone(), self.started.elapsed()));
        if let Some((name, cancel)) = &self.cancel_during {
            if *name == pod.name {
                cancel.send_replace(true);
            }
        }
        let mut answers = self.answers.lock().unwrap();
        let list = answers.get_mut(&pod.name).expect("script for pod");
        if list.len() > 1 {
            list.pop_front().unwrap()
        } else {
            list.front().cloned().expect("an answer")
        }
    }
}

fn pod(name: &str) -> DrainPod {
    DrainPod { namespace: "app".into(), name: name.into(), uid: format!("uid-{name}"), empty_dir: false, unmanaged: false, blocked_by: None }
}

fn pods(names: &[&str]) -> Vec<DrainPod> {
    names.iter().map(|name| pod(name)).collect()
}

struct Driven {
    report: Report,
    messages: Vec<DrainMessage>,
}

async fn drive(names: &[&str], script: &Script, cancel: &mut watch::Receiver<bool>) -> Driven {
    let mut messages = Vec::new();
    let report = run(&pods(names), Limits::default(), cancel, script, &mut |m| {
        messages.push(m);
        true
    })
    .await;
    Driven { report, messages }
}

fn idle() -> (watch::Sender<bool>, watch::Receiver<bool>) {
    watch::channel(false)
}

/// (Pod 이름, 상태)만 모은 진행
fn states(messages: &[DrainMessage]) -> Vec<(String, PodState)> {
    messages
        .iter()
        .filter_map(|m| match m {
            DrainMessage::Pod { name, state, .. } => Some((name.clone(), *state)),
            _ => None,
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn pods_are_evicted_one_at_a_time_in_order_with_a_state_per_step() {
    let script = Script::new(&[("a", vec![Eviction::Evicted]), ("b", vec![Eviction::Evicted])]);
    let (_keep, mut cancel) = idle();
    let result = drive(&["a", "b"], &script, &mut cancel).await;
    assert_eq!(result.report.outcome, Outcome::Completed);
    assert_eq!(result.report.counts, Counts { total: 2, evicted: 2, ..Counts::default() });
    assert_eq!(
        states(&result.messages),
        [
            ("a".to_string(), PodState::Evicting),
            ("a".to_string(), PodState::Evicted),
            ("b".to_string(), PodState::Evicting),
            ("b".to_string(), PodState::Evicted),
        ]
    );
    // 한 바퀴에 끝나면 기다리지 않는다
    assert_eq!(script.calls(), [("a".to_string(), 0), ("b".to_string(), 0)]);
}

#[tokio::test(start_paused = true)]
async fn each_message_carries_the_running_counts() {
    let script = Script::new(&[("a", vec![Eviction::Evicted]), ("b", vec![Eviction::Evicted])]);
    let (_keep, mut cancel) = idle();
    let result = drive(&["a", "b"], &script, &mut cancel).await;
    let DrainMessage::Pod { counts, .. } = &result.messages[1] else { panic!("{:?}", result.messages) };
    assert_eq!(*counts, Counts { total: 2, pending: 1, evicted: 1, ..Counts::default() });
}

#[tokio::test(start_paused = true)]
async fn a_gone_pod_counts_as_evicted() {
    let script = Script::new(&[("a", vec![Eviction::Gone])]);
    let (_keep, mut cancel) = idle();
    let result = drive(&["a"], &script, &mut cancel).await;
    assert_eq!(result.report.outcome, Outcome::Completed);
    assert_eq!(result.report.counts.evicted, 1);
}

#[tokio::test(start_paused = true)]
async fn a_blocked_pod_is_retried_with_a_growing_delay_while_others_go_ahead() {
    let script = Script::new(&[
        ("pdb", vec![Eviction::Blocked, Eviction::Blocked, Eviction::Blocked, Eviction::Evicted]),
        ("free", vec![Eviction::Evicted]),
    ]);
    let (_keep, mut cancel) = idle();
    let result = drive(&["pdb", "free"], &script, &mut cancel).await;
    assert_eq!(result.report.outcome, Outcome::Completed);
    // 막힌 Pod를 기다리지 않고 다음 Pod를 먼저 옮기고, 막힌 것은 1초, 2초, 4초 뒤에 다시 한다
    assert_eq!(
        script.calls(),
        [("pdb".to_string(), 0), ("free".to_string(), 0), ("pdb".to_string(), 1), ("pdb".to_string(), 3), ("pdb".to_string(), 7)]
    );
    let seen = states(&result.messages);
    assert!(seen.contains(&("pdb".to_string(), PodState::Blocked)));
    assert_eq!(seen.last(), Some(&("pdb".to_string(), PodState::Evicted)));
}

#[tokio::test(start_paused = true)]
async fn the_delay_stops_growing_at_the_maximum() {
    let script = Script::new(&[("pdb", vec![Eviction::Blocked])]);
    let (_keep, mut cancel) = idle();
    drive(&["pdb"], &script, &mut cancel).await;
    let times: Vec<u64> = script.calls().into_iter().map(|(_, at)| at).collect();
    let gaps: Vec<u64> = times.windows(2).map(|w| w[1] - w[0]).collect();
    assert_eq!(&gaps[..6], [1, 2, 4, 8, 16, 30]);
    assert!(gaps[5..gaps.len() - 1].iter().all(|gap| *gap == 30), "{gaps:?}");
}

#[tokio::test(start_paused = true)]
async fn continuous_429_stops_after_five_minutes_and_leaves_evicted_pods_alone() {
    let script = Script::new(&[("done", vec![Eviction::Evicted]), ("pdb", vec![Eviction::Blocked])]);
    let (_keep, mut cancel) = idle();
    let started = Instant::now();
    let result = drive(&["done", "pdb"], &script, &mut cancel).await;
    assert_eq!(result.report.outcome, Outcome::TimedOut);
    assert_eq!(started.elapsed(), STALL_LIMIT);
    assert_eq!(result.report.counts, Counts { total: 2, evicted: 1, blocked: 1, ..Counts::default() });
    // 이미 옮긴 Pod는 다시 건드리지 않는다
    assert_eq!(script.attempts("done"), 1);
    assert_eq!(states(&result.messages).last(), Some(&("pdb".to_string(), PodState::Blocked)));
}

#[tokio::test(start_paused = true)]
async fn progress_restarts_the_five_minute_clock() {
    // pdb는 늘 막히고, other는 200초 넘게 막혔다가 풀린다. other가 풀린 뒤부터 다시 5분을 센다
    let mut other = vec![Eviction::Blocked; 9];
    other.push(Eviction::Evicted);
    let script = Script::new(&[("pdb", vec![Eviction::Blocked]), ("other", other)]);
    let (_keep, mut cancel) = idle();
    let started = Instant::now();
    let result = drive(&["pdb", "other"], &script, &mut cancel).await;
    assert_eq!(result.report.outcome, Outcome::TimedOut);
    let freed = script.calls().into_iter().rfind(|(name, _)| name == "other").unwrap().1;
    assert!(freed > 60, "other는 한참 뒤에 풀려야 해요: {freed}");
    assert!(started.elapsed() >= STALL_LIMIT + Duration::from_secs(freed), "{:?}", started.elapsed());
    assert_eq!(result.report.counts.evicted, 1);
}

#[tokio::test(start_paused = true)]
async fn cancel_stops_after_the_current_eviction() {
    let (tx, mut cancel) = idle();
    let mut script = Script::new(&[("a", vec![Eviction::Evicted]), ("b", vec![Eviction::Evicted])]);
    script.cancel_during = Some(("a".into(), tx));
    let result = drive(&["a", "b"], &script, &mut cancel).await;
    assert_eq!(result.report.outcome, Outcome::Stopped);
    // 하던 Eviction은 마치고(a는 옮겨졌다) 다음 것은 시작하지 않는다
    assert_eq!(result.report.counts, Counts { total: 2, evicted: 1, pending: 1, ..Counts::default() });
    assert_eq!(script.attempts("b"), 0);
}

#[tokio::test(start_paused = true)]
async fn cancel_during_the_backoff_wait_stops_at_once() {
    let script = Script::new(&[("pdb", vec![Eviction::Blocked])]);
    let (tx, mut cancel) = idle();
    let started = Instant::now();
    let stopper = async {
        tokio::time::sleep(Duration::from_secs(10)).await;
        tx.send_replace(true);
    };
    let (result, ()) = tokio::join!(drive(&["pdb"], &script, &mut cancel), stopper);
    assert_eq!(result.report.outcome, Outcome::Stopped);
    assert_eq!(started.elapsed(), Duration::from_secs(10));
    assert_eq!(result.report.counts.blocked, 1);
}

#[tokio::test(start_paused = true)]
async fn a_dropped_cancel_sender_stops_the_drain() {
    let script = Script::new(&[("a", vec![Eviction::Evicted])]);
    let (tx, mut cancel) = idle();
    drop(tx);
    let result = drive(&["a"], &script, &mut cancel).await;
    assert_eq!(result.report.outcome, Outcome::Stopped);
    assert_eq!(script.attempts("a"), 0);
}

#[tokio::test(start_paused = true)]
async fn a_closed_channel_stops_the_drain() {
    let script = Script::new(&[("a", vec![Eviction::Evicted]), ("b", vec![Eviction::Evicted])]);
    let (_keep, mut cancel) = idle();
    let mut sent = 0;
    let report = run(&pods(&["a", "b"]), Limits::default(), &mut cancel, &script, &mut |_| {
        sent += 1;
        sent < 2
    })
    .await;
    assert_eq!(report.outcome, Outcome::Stopped);
    assert_eq!(script.attempts("b"), 0);
}

#[tokio::test(start_paused = true)]
async fn one_failed_pod_does_not_stop_the_others_and_is_not_retried() {
    let script = Script::new(&[("bad", vec![Eviction::Failed(AppError::other("nope"))]), ("good", vec![Eviction::Evicted])]);
    let (_keep, mut cancel) = idle();
    let result = drive(&["bad", "good"], &script, &mut cancel).await;
    assert_eq!(result.report.outcome, Outcome::Failed);
    assert_eq!(result.report.counts, Counts { total: 2, evicted: 1, failed: 1, ..Counts::default() });
    assert_eq!(script.attempts("bad"), 1);
    let DrainMessage::Pod { error, .. } = result.messages.iter().find(|m| matches!(m, DrainMessage::Pod { state: PodState::Failed, .. })).unwrap() else { unreachable!() };
    assert_eq!(error.as_deref(), Some("nope"));
}

#[tokio::test(start_paused = true)]
async fn a_fatal_error_stops_before_the_remaining_pods() {
    let denied = AppError::AccessDenied { action: "create pods/eviction".into() };
    let script = Script::new(&[("a", vec![Eviction::Fatal(denied.clone())]), ("b", vec![Eviction::Evicted])]);
    let (_keep, mut cancel) = idle();
    let result = drive(&["a", "b"], &script, &mut cancel).await;
    assert_eq!(result.report.outcome, Outcome::Failed);
    assert_eq!(result.report.error, Some(denied));
    assert_eq!(script.attempts("b"), 0);
    assert_eq!(result.report.counts, Counts { total: 2, failed: 1, pending: 1, ..Counts::default() });
}

#[test]
fn messages_serialize_with_the_keys_the_screen_reads() {
    let message = DrainMessage::Pod {
        namespace: "app".into(),
        name: "web".into(),
        state: PodState::Blocked,
        error: None,
        counts: Counts { total: 2, blocked: 1, ..Counts::default() },
    };
    assert_eq!(
        serde_json::to_value(message).unwrap(),
        serde_json::json!({
            "type": "pod", "namespace": "app", "name": "web", "state": "blocked", "error": null,
            "counts": {"total": 2, "pending": 0, "evicting": 0, "evicted": 0, "blocked": 1, "failed": 0},
        })
    );
    let finished = DrainMessage::Finished { outcome: Outcome::TimedOut, counts: Counts::default(), error: None };
    assert_eq!(serde_json::to_value(finished).unwrap()["outcome"], "timedOut");
}
