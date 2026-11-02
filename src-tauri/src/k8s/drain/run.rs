//! drain 진행: Pod를 하나씩 Eviction하고, 받아들여진 Pod가 정말 사라질 때까지 기다리며 진행을 알린다.
//! 429(PodDisruptionBudget이 막음)는 늦춰 가며 다시 시도하고, 어떤 Pod도 옮기지 못한 채 `Limits::stall`이 지나면 멈춘다. 이미 옮긴 Pod는 되돌리지 않는다.
//! Eviction이 받아들여져도 Pod는 종료 유예 동안 남아 있다. 그 Pod(UID)가 사라져야 옮긴 것으로 세고, 같은 이름으로 다시 생긴 Pod는 사라진 것으로 본다.
//! 유예(`terminationGracePeriodSeconds`)에 여유를 더한 시간이 지나도 남아 있으면 "종료 지연"으로 두고 다음으로 넘어간다.
//! 취소는 지금 하는 Eviction이 끝난 뒤(기다리는 중이면 바로) 멈춘다.
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
/// 받아들여진 Pod가 사라졌는지 보는 간격
pub const POLL: Duration = Duration::from_secs(1);
/// Pod의 종료 유예에 더하는 여유(노드가 Pod를 내리는 데 걸리는 시간)
pub const TERMINATE_SLACK: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub stall: Duration,
    pub first_delay: Duration,
    pub max_delay: Duration,
    pub poll: Duration,
    pub terminate_slack: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            stall: STALL_LIMIT,
            first_delay: FIRST_DELAY,
            max_delay: MAX_DELAY,
            poll: POLL,
            terminate_slack: TERMINATE_SLACK,
        }
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
    /// Eviction은 받아들여졌고 Pod가 사라지기를 기다리는 중
    Terminating,
    /// Eviction은 받아들여졌지만 유예와 여유가 지나도 Pod가 남아 있다
    Lingering,
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
    pub terminating: usize,
    pub lingering: usize,
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
            terminating: count(PodState::Terminating),
            lingering: count(PodState::Lingering),
            failed: count(PodState::Failed),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// 모두 옮겼다(Pod가 사라졌다)
    Completed,
    /// 사용자가 멈췄다(또는 화면이 채널을 닫았다)
    Stopped,
    /// 429가 `stall` 동안 이어져 멈췄다
    TimedOut,
    /// 옮기지 못한 Pod가 있거나 계속할 수 없는 오류가 났다
    Failed,
    /// Eviction은 모두 받아들여졌지만 종료가 늦은 Pod가 남아 있다
    Lingering,
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

    /// 이 UID의 Pod가 아직 있는가. 읽지 못하면 아직 있는 것으로 본다(기다림 한도가 끝을 정한다).
    async fn still_there(&self, pod: &DrainPod) -> bool;
}

/// 보낸 쪽이 사라졌어도(`has_changed` 오류) 더 옮기지 않는다
fn cancelled(cancel: &watch::Receiver<bool>) -> bool {
    *cancel.borrow() || cancel.has_changed().is_err()
}

/// 한 번에 끝나는 보고
fn stopped(states: &[PodState]) -> Report {
    Report { outcome: Outcome::Stopped, counts: Counts::of(states), error: None }
}

/// Pod를 처음부터 끝까지 한 번씩 돌며 옮긴다. 막힌 Pod는 한 바퀴가 끝난 뒤 늦춰 가며 다시 하고,
/// 받아들여진 Pod는 사라질 때까지 기다린다(기다림은 다음 Pod의 Eviction을 막지 않는다).
/// `send`가 false를 돌려주면(화면이 채널을 닫음) 취소와 같다.
pub async fn run<E, F>(pods: &[DrainPod], limits: Limits, cancel: &mut watch::Receiver<bool>, evictor: &E, send: &mut F) -> Report
where
    E: Evictor,
    F: FnMut(DrainMessage) -> bool + Send,
{
    let mut states = vec![PodState::Pending; pods.len()];
    // Eviction이 받아들여진 시각
    let mut accepted: Vec<Option<Instant>> = vec![None; pods.len()];
    let mut delay = limits.first_delay;
    let mut stalled_since: Option<Instant> = None;
    let mut carried = false;
    loop {
        if cancelled(cancel) {
            return stopped(&states);
        }
        let pass_start = Instant::now();
        let mut progressed = std::mem::take(&mut carried);
        for (index, pod) in pods.iter().enumerate() {
            if !matches!(states[index], PodState::Pending | PodState::Blocked) {
                continue;
            }
            if cancelled(cancel) {
                return stopped(&states);
            }
            states[index] = PodState::Evicting;
            if !notify(send, pod, &states, index, None) {
                return stopped(&states);
            }
            let mut fatal = None;
            let mut detail = None;
            match evictor.evict_pod(pod).await {
                Eviction::Evicted => {
                    states[index] = PodState::Terminating;
                    accepted[index] = Some(Instant::now());
                    progressed = true;
                }
                Eviction::Gone => {
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
                return stopped(&states);
            }
        }
        match reap(pods, &limits, &mut states, &accepted, evictor, send).await {
            Reaped::Closed => return stopped(&states),
            Reaped::Progress(true) => progressed = true,
            Reaped::Progress(false) => {}
        }
        let blocked = states.contains(&PodState::Blocked);
        let terminating = states.contains(&PodState::Terminating);
        if !blocked && !terminating {
            let outcome = if states.contains(&PodState::Failed) {
                Outcome::Failed
            } else if states.contains(&PodState::Lingering) {
                Outcome::Lingering
            } else {
                Outcome::Completed
            };
            return Report { outcome, counts: Counts::of(&states), error: None };
        }
        let mut pause = limits.poll;
        if blocked {
            if progressed {
                stalled_since = None;
                delay = limits.first_delay;
            }
            let since = *stalled_since.get_or_insert(pass_start);
            let waited = since.elapsed();
            if waited >= limits.stall {
                return Report { outcome: Outcome::TimedOut, counts: Counts::of(&states), error: None };
            }
            pause = delay.min(limits.stall - waited);
            delay = (delay * 2).min(limits.max_delay);
        }
        // 기다리는 동안에도 사라진 Pod를 알아본다. 그때 풀린 몫은 다음 바퀴의 진전으로 센다.
        let until = Instant::now() + pause;
        while Instant::now() < until {
            let watching = states.contains(&PodState::Terminating);
            let remaining = until.saturating_duration_since(Instant::now());
            let step = if watching { limits.poll.min(remaining) } else { remaining };
            tokio::select! {
                _ = tokio::time::sleep(step) => {}
                _ = cancel.changed() => break,
            }
            if cancelled(cancel) {
                break;
            }
            if watching {
                match reap(pods, &limits, &mut states, &accepted, evictor, send).await {
                    Reaped::Closed => return stopped(&states),
                    Reaped::Progress(true) => carried = true,
                    Reaped::Progress(false) => {}
                }
                if !blocked && !states.contains(&PodState::Terminating) {
                    break;
                }
            }
        }
    }
}

enum Reaped {
    /// 사라진 Pod가 있었는가
    Progress(bool),
    /// 화면이 채널을 닫았다
    Closed,
}

/// 받아들여진 Pod를 한 번씩 살핀다. 사라졌으면 옮긴 것으로, 한도가 지났으면 종료 지연으로 둔다.
async fn reap<E, F>(pods: &[DrainPod], limits: &Limits, states: &mut [PodState], accepted: &[Option<Instant>], evictor: &E, send: &mut F) -> Reaped
where
    E: Evictor,
    F: FnMut(DrainMessage) -> bool + Send,
{
    let mut progress = false;
    for (index, pod) in pods.iter().enumerate() {
        if states[index] != PodState::Terminating {
            continue;
        }
        let Some(since) = accepted[index] else {
            continue;
        };
        let limit = Duration::from_secs(pod.grace_seconds) + limits.terminate_slack;
        let (state, detail) = if !evictor.still_there(pod).await {
            progress = true;
            (PodState::Evicted, None)
        } else if since.elapsed() >= limit {
            (PodState::Lingering, Some(format!("종료 지연: {}초 넘게 남아 있어요", limit.as_secs())))
        } else {
            continue;
        };
        states[index] = state;
        if !notify(send, pod, states, index, detail) {
            return Reaped::Closed;
        }
    }
    Reaped::Progress(progress)
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
