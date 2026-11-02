//! drain 진행: Pod를 하나씩 Eviction하며 진행을 알린다. 429(PodDisruptionBudget이 막음)는 늦춰 가며 다시 시도하고,
//! 어떤 Pod도 옮기지 못한 채 `Limits::stall`이 지나면 멈춘다. 이미 옮긴 Pod는 되돌리지 않는다. 취소는 지금 하는 Eviction이 끝난 뒤에 멈춘다.
use std::time::Duration;

use serde::Serialize;
use tokio::sync::watch;
use tokio::time::Instant;

use super::DrainPod;
use crate::error::AppError;
use crate::k8s::exec::Eviction;

/// 429만 이어지는 시간이 이만큼 되면 멈춘다
pub const STALL_LIMIT: Duration = Duration::from_secs(5 * 60);
pub const FIRST_DELAY: Duration = Duration::from_secs(1);
pub const MAX_DELAY: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub stall: Duration,
    pub first_delay: Duration,
    pub max_delay: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self { stall: STALL_LIMIT, first_delay: FIRST_DELAY, max_delay: MAX_DELAY }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PodState {
    Pending,
    Evicting,
    Evicted,
    /// PodDisruptionBudget이 막아 다시 시도하는 중
    Blocked,
    Failed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub total: usize,
    pub pending: usize,
    pub evicting: usize,
    pub evicted: usize,
    pub blocked: usize,
    pub failed: usize,
}

impl Counts {
    pub fn of(states: &[PodState]) -> Self {
        let count = |wanted: PodState| states.iter().filter(|state| **state == wanted).count();
        Self {
            total: states.len(),
            pending: count(PodState::Pending),
            evicting: count(PodState::Evicting),
            evicted: count(PodState::Evicted),
            blocked: count(PodState::Blocked),
            failed: count(PodState::Failed),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// 모두 옮겼다
    Completed,
    /// 사용자가 멈췄다(또는 화면이 채널을 닫았다)
    Stopped,
    /// 429가 `stall` 동안 이어져 멈췄다
    TimedOut,
    /// 옮기지 못한 Pod가 있거나 계속할 수 없는 오류가 났다
    Failed,
}

/// 채널로 흘리는 진행. `Finished`가 마지막이다.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DrainMessage {
    Started { pods: Vec<DrainPod>, counts: Counts },
    Cordoned,
    Pod { namespace: String, name: String, state: PodState, error: Option<String>, counts: Counts },
    Finished { outcome: Outcome, counts: Counts, error: Option<AppError> },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub outcome: Outcome,
    pub counts: Counts,
    /// 계속할 수 없던 오류(권한, 연결)
    pub error: Option<AppError>,
}

/// Eviction 하나를 보낸다. 시험은 가짜로 바꾼다.
#[async_trait::async_trait]
pub trait Evictor: Send + Sync {
    async fn evict_pod(&self, pod: &DrainPod) -> Eviction;
}

/// 보낸 쪽이 사라졌어도(`has_changed` 오류) 더 옮기지 않는다
fn cancelled(cancel: &watch::Receiver<bool>) -> bool {
    *cancel.borrow() || cancel.has_changed().is_err()
}

/// Pod를 처음부터 끝까지 한 번씩 돌며 옮긴다. 막힌 Pod는 한 바퀴가 끝난 뒤 늦춰 가며 다시 한다.
/// `send`가 false를 돌려주면(화면이 채널을 닫음) 취소와 같다.
pub async fn run<E, F>(pods: &[DrainPod], limits: Limits, cancel: &mut watch::Receiver<bool>, evictor: &E, send: &mut F) -> Report
where
    E: Evictor,
    F: FnMut(DrainMessage) -> bool + Send,
{
    let mut states = vec![PodState::Pending; pods.len()];
    let mut delay = limits.first_delay;
    let mut stalled_since: Option<Instant> = None;
    loop {
        let pass_start = Instant::now();
        let mut progressed = false;
        for (index, pod) in pods.iter().enumerate() {
            if !matches!(states[index], PodState::Pending | PodState::Blocked) {
                continue;
            }
            if cancelled(cancel) {
                return Report { outcome: Outcome::Stopped, counts: Counts::of(&states), error: None };
            }
            states[index] = PodState::Evicting;
            if !notify(send, pod, &states, index, None) {
                return Report { outcome: Outcome::Stopped, counts: Counts::of(&states), error: None };
            }
            let mut fatal = None;
            let mut detail = None;
            match evictor.evict_pod(pod).await {
                Eviction::Evicted | Eviction::Gone => {
                    states[index] = PodState::Evicted;
                    progressed = true;
                }
                Eviction::Blocked => states[index] = PodState::Blocked,
                Eviction::Failed(error) => {
                    states[index] = PodState::Failed;
                    detail = Some(error.to_string());
                }
                Eviction::Fatal(error) => {
                    states[index] = PodState::Failed;
                    detail = Some(error.to_string());
                    fatal = Some(error);
                }
            }
            let sent = notify(send, pod, &states, index, detail);
            if fatal.is_some() {
                return Report { outcome: Outcome::Failed, counts: Counts::of(&states), error: fatal };
            }
            if !sent {
                return Report { outcome: Outcome::Stopped, counts: Counts::of(&states), error: None };
            }
        }
        if !states.contains(&PodState::Blocked) {
            let outcome = if states.contains(&PodState::Failed) { Outcome::Failed } else { Outcome::Completed };
            return Report { outcome, counts: Counts::of(&states), error: None };
        }
        if progressed {
            stalled_since = None;
            delay = limits.first_delay;
        }
        let since = *stalled_since.get_or_insert(pass_start);
        let waited = since.elapsed();
        if waited >= limits.stall {
            return Report { outcome: Outcome::TimedOut, counts: Counts::of(&states), error: None };
        }
        let pause = delay.min(limits.stall - waited);
        delay = (delay * 2).min(limits.max_delay);
        tokio::select! {
            _ = tokio::time::sleep(pause) => {}
            _ = cancel.changed() => {}
        }
    }
}

fn notify<F>(send: &mut F, pod: &DrainPod, states: &[PodState], index: usize, error: Option<String>) -> bool
where
    F: FnMut(DrainMessage) -> bool + Send,
{
    send(DrainMessage::Pod {
        namespace: pod.namespace.clone(),
        name: pod.name.clone(),
        state: states[index],
        error,
        counts: Counts::of(states),
    })
}

#[cfg(test)]
mod tests;
