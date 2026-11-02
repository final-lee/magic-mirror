//! drain 적용: 노드를 cordon한 다음 Pod를 하나씩 옮기고, cordon과 drain 요약을 변경 기록에 남긴다.
//! 쓰기 요청은 `exec`만 보낸다. 이 파일은 순서와 기록을 맡는다.
use std::path::PathBuf;

use kube::Client;
use tokio::sync::watch;

use super::run::{run, Counts, DrainMessage, Evictor, Limits, Outcome, PodState, Report};
use super::{DrainPlan, DrainPod};
use crate::error::AppError;
use crate::iam::clock::{iso, now_secs};
use crate::iam::commit::new_log_id;
use crate::k8s::change::{Change, Operation};
use crate::k8s::exec::{self, Eviction};
use crate::k8s::failure::Endpoint;
use crate::k8s::log::{self, Entry};
use crate::k8s::target::K8sTarget;
use crate::k8s::commit;
use crate::k8s_commands::RECORD_FAILED;

pub const STOPPED: &str = "사용자가 중단했어요. 이미 옮긴 Pod는 그대로 둬요";
pub const TIMED_OUT: &str = "PodDisruptionBudget이 5분 넘게 막아 멈췄어요. 이미 옮긴 Pod는 그대로 둬요";
pub const NOT_ALL_MOVED: &str = "옮기지 못한 Pod가 있어요";

/// 한 번의 drain 적용에 필요한 것
pub struct Job {
    pub client: Client,
    pub endpoint: Endpoint,
    pub log_path: PathBuf,
    pub target: K8sTarget,
    /// `Operation::Drain` 변경
    pub change: Change,
    pub plan: DrainPlan,
    /// 미리보기를 만든 시각(cordon 계획에 쓴다)
    pub at: String,
    pub limits: Limits,
}

/// 클러스터에 Eviction을 보낸다
struct Cluster {
    client: Client,
    endpoint: Endpoint,
}

#[async_trait::async_trait]
impl Evictor for Cluster {
    async fn evict_pod(&self, pod: &DrainPod) -> Eviction {
        exec::evict(self.client.clone(), self.endpoint, &pod.namespace, &pod.name, &pod.uid).await
    }
}

/// 요약 한 줄: `Pod 3개 옮김, 1개 막힘`
pub fn summary(counts: &Counts) -> String {
    let mut parts = vec![format!("Pod {}개 옮김", counts.evicted)];
    for (count, label) in [(counts.blocked, "막힘"), (counts.failed, "실패"), (counts.pending + counts.evicting, "남음")] {
        if count > 0 {
            parts.push(format!("{count}개 {label}"));
        }
    }
    parts.join(", ")
}

fn entry(job: &Job, change: Change, summary: String, outcome: Result<(), String>, inverse: Option<Change>) -> Entry {
    let now = now_secs();
    Entry {
        id: new_log_id(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)),
        at: iso(now),
        target: job.target.clone(),
        change,
        summary,
        ok: outcome.is_ok(),
        error: outcome.err(),
        inverse,
        undo_of: None,
        undone: false,
    }
}

/// 노드를 스케줄 중지하고 변경 기록에 남긴다. 되돌리기(uncordon)는 이 기록에 달린다.
async fn cordon(job: &Job) -> Result<(), AppError> {
    let change = Change { target: job.change.target.clone(), operation: Operation::Cordon { unschedulable: true } };
    let seen = commit::make_plan(job.client.clone(), job.endpoint, &change, &job.at).await?;
    let (plan, outcome) = commit::apply_plan(job.client.clone(), job.endpoint, &change, &seen, &job.at, None).await?;
    let inverse = outcome.is_ok().then(|| plan.inverse.clone()).flatten();
    let recorded = entry(job, change, plan.preview.impact.join(", "), outcome.clone().map_err(|e| e.to_string()), inverse);
    log::append(&job.log_path, &recorded).map_err(|_| AppError::other(RECORD_FAILED))?;
    outcome
}

fn describe_outcome(report: &Report) -> Option<String> {
    match report.outcome {
        Outcome::Completed => None,
        Outcome::Stopped => Some(STOPPED.into()),
        Outcome::TimedOut => Some(TIMED_OUT.into()),
        Outcome::Failed => Some(report.error.as_ref().map_or_else(|| NOT_ALL_MOVED.into(), ToString::to_string)),
    }
}

/// cordon → Eviction을 하나씩 → 기록. 진행은 `send`로 알리고 `Finished`로 끝낸다.
/// `cancel`이 켜지면 지금 하는 Eviction만 마치고 멈춘다.
pub async fn apply<F>(job: Job, cancel: watch::Receiver<bool>, send: F)
where
    F: FnMut(DrainMessage) -> bool + Send,
{
    let cluster = Cluster { client: job.client.clone(), endpoint: job.endpoint };
    apply_with(job, cancel, send, &cluster).await;
}

/// `apply`에서 Eviction을 보내는 쪽만 바꿀 수 있게 한 것. 시험은 가짜를 넘긴다.
async fn apply_with<E, F>(job: Job, mut cancel: watch::Receiver<bool>, mut send: F, evictor: &E)
where
    E: Evictor,
    F: FnMut(DrainMessage) -> bool + Send,
{
    let pods = job.plan.evict.clone();
    let pending = Counts::of(&vec![PodState::Pending; pods.len()]);
    send(DrainMessage::Started { pods: pods.clone(), counts: pending });
    if !job.plan.node_cordoned {
        if let Err(error) = cordon(&job).await {
            send(DrainMessage::Finished { outcome: Outcome::Failed, counts: pending, error: Some(error) });
            return;
        }
    }
    send(DrainMessage::Cordoned);
    let report = run(&pods, job.limits, &mut cancel, evictor, &mut send).await;
    let detail = describe_outcome(&report);
    let recorded = entry(
        &job,
        job.change.clone(),
        format!("drain: {}", summary(&report.counts)),
        detail.clone().map_or(Ok(()), Err),
        None,
    );
    let mut error = report.error.clone();
    if log::append(&job.log_path, &recorded).is_err() {
        error = error.or_else(|| Some(AppError::other(RECORD_FAILED)));
    }
    send(DrainMessage::Finished { outcome: report.outcome, counts: report.counts, error });
}

#[cfg(test)]
mod tests;
