//! drain 계획: 노드의 Pod를 옮길 것, 건너뛸 것, 경고할 것으로 나눈다. 클러스터 I/O 없이 입력 객체로만 계산한다.
//! 적용(cordon과 Eviction 흐름)은 `drain::run`과 `drain::apply`가 한다.
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::change::{fingerprint, ApiCall, Change, FieldDiff, Operation, Plan, Preview, INVALID_CHANGE, MISSING_VERSION};
use crate::error::AppError;

pub mod apply;
pub mod run;

pub const DRAIN_IMPACT: &str = "노드를 스케줄 중지하고 Pod를 하나씩 다른 노드로 옮깁니다";
pub const EMPTY_DIR_WARNING: &str = "emptyDir 데이터가 사라지는 Pod";
pub const UNMANAGED_WARNING: &str = "컨트롤러가 없어 다시 만들어지지 않는 Pod";
pub const BLOCKED_WARNING: &str = "PodDisruptionBudget이 막아 옮겨지지 않을 수 있는 Pod";
pub const BUDGETS_UNKNOWN_WARNING: &str = "PodDisruptionBudget을 읽지 못해 막히는 Pod를 알 수 없어요";
const MIRROR_ANNOTATION: &str = "kubernetes.io/config.mirror";
/// 경고 한 줄에 이름을 이만큼까지만 싣는다. 전체 목록은 `DrainPlan`에 있다.
const NAMES_SHOWN: usize = 5;
/// `terminationGracePeriodSeconds`가 없을 때 쿠버네티스의 기본값
const DEFAULT_GRACE_SECONDS: u64 = 30;

/// 옮길 Pod 하나
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainPod {
    pub namespace: String,
    pub name: String,
    pub uid: String,
    /// emptyDir 볼륨이 있어 옮기면 그 데이터가 사라진다
    pub empty_dir: bool,
    /// 컨트롤러가 없어 지우면 다시 만들어지지 않는다
    pub unmanaged: bool,
    /// 이 Pod를 고른 PodDisruptionBudget 가운데 허용량이 0인 것의 이름
    pub blocked_by: Option<String>,
    /// `terminationGracePeriodSeconds`. Eviction 뒤 Pod가 사라지기를 기다리는 한도의 바탕이다.
    pub grace_seconds: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    DaemonSet,
    Mirror,
    Terminating,
}

/// 건드리지 않는 Pod 하나
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedPod {
    pub namespace: String,
    pub name: String,
    pub reason: SkipReason,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainPlan {
    /// 미리보기 때 이미 스케줄이 중지된 노드면 cordon을 다시 하지 않고 기록하지도 않는다
    pub node_cordoned: bool,
    pub evict: Vec<DrainPod>,
    pub skipped: Vec<SkippedPod>,
    /// PodDisruptionBudget 목록을 읽지 못해 `blocked_by`를 알 수 없다
    pub budgets_unknown: bool,
}

/// 사용자가 본 계획과 지금 계획이 같은 Pod를 옮기는가. 허용량처럼 자주 바뀌는 값(`blocked_by`)과 건너뛸 Pod는 보지 않는다.
pub fn same_targets(seen: &DrainPlan, current: &DrainPlan) -> bool {
    let uids = |plan: &DrainPlan| plan.evict.iter().map(|pod| (pod.namespace.clone(), pod.name.clone(), pod.uid.clone())).collect::<Vec<_>>();
    seen.node_cordoned == current.node_cordoned && uids(seen) == uids(current)
}

fn text<'a>(object: &'a Value, pointer: &str) -> &'a str {
    object.pointer(pointer).and_then(Value::as_str).unwrap_or_default()
}

/// 컨트롤러(`controller: true`)인 소유자의 종류
fn controller_kind(pod: &Value) -> Option<&str> {
    pod.pointer("/metadata/ownerReferences")
        .and_then(Value::as_array)?
        .iter()
        .find(|owner| owner.get("controller").and_then(Value::as_bool) == Some(true))
        .and_then(|owner| owner.get("kind").and_then(Value::as_str))
}

fn has_empty_dir(pod: &Value) -> bool {
    pod.pointer("/spec/volumes")
        .and_then(Value::as_array)
        .is_some_and(|volumes| volumes.iter().any(|volume| volume.get("emptyDir").is_some()))
}

/// 라벨 선택기(`matchLabels`, `matchExpressions`)가 라벨 집합과 맞는가. 선택기가 없으면 아무것도 고르지 않고, 빈 선택기는 모두 고른다.
fn selects(selector: Option<&Value>, labels: &Map<String, Value>) -> bool {
    let Some(selector) = selector.filter(|value| value.is_object()) else {
        return false;
    };
    if let Some(wanted) = selector.get("matchLabels").and_then(Value::as_object) {
        if wanted.iter().any(|(key, value)| labels.get(key) != Some(value)) {
            return false;
        }
    }
    let Some(expressions) = selector.get("matchExpressions").and_then(Value::as_array) else {
        return true;
    };
    expressions.iter().all(|expression| {
        let key = text(expression, "/key");
        let values: Vec<&str> = expression
            .get("values")
            .and_then(Value::as_array)
            .map(|values| values.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let actual = labels.get(key).and_then(Value::as_str);
        match text(expression, "/operator") {
            "In" => actual.is_some_and(|value| values.contains(&value)),
            "NotIn" => actual.is_none_or(|value| !values.contains(&value)),
            "Exists" => labels.contains_key(key),
            "DoesNotExist" => !labels.contains_key(key),
            _ => false,
        }
    })
}

/// 같은 네임스페이스에서 이 Pod를 고르고 허용량이 0인 PodDisruptionBudget의 이름
fn blocking_budget(pod: &Value, budgets: &[Value]) -> Option<String> {
    let namespace = text(pod, "/metadata/namespace");
    let empty = Map::new();
    let labels = pod.pointer("/metadata/labels").and_then(Value::as_object).unwrap_or(&empty);
    budgets
        .iter()
        .filter(|budget| text(budget, "/metadata/namespace") == namespace)
        .filter(|budget| budget.pointer("/status/disruptionsAllowed").and_then(Value::as_i64) == Some(0))
        .find(|budget| selects(budget.pointer("/spec/selector"), labels))
        .map(|budget| text(budget, "/metadata/name").to_owned())
}

/// 노드에 있는 Pod를 나눈다. kubectl drain과 같게 DaemonSet·미러 Pod와 이미 종료 중인 Pod는 건너뛴다.
/// `budgets`가 None이면 PodDisruptionBudget을 읽지 못한 것이다.
pub fn plan_drain(node: &Value, pods: &[Value], budgets: Option<&[Value]>) -> DrainPlan {
    let mut evict = Vec::new();
    let mut skipped = Vec::new();
    for pod in pods {
        let namespace = text(pod, "/metadata/namespace").to_owned();
        let name = text(pod, "/metadata/name").to_owned();
        let skip = if pod.pointer("/metadata/annotations").and_then(|a| a.get(MIRROR_ANNOTATION)).is_some() {
            Some(SkipReason::Mirror)
        } else if controller_kind(pod) == Some("DaemonSet") {
            Some(SkipReason::DaemonSet)
        } else if pod.pointer("/metadata/deletionTimestamp").is_some() {
            Some(SkipReason::Terminating)
        } else {
            None
        };
        if let Some(reason) = skip {
            skipped.push(SkippedPod { namespace, name, reason });
            continue;
        }
        // 끝난 Pod(Succeeded, Failed)는 잃을 것이 없어 경고하지 않는다
        let finished = matches!(text(pod, "/status/phase"), "Succeeded" | "Failed");
        evict.push(DrainPod {
            namespace,
            name,
            uid: text(pod, "/metadata/uid").to_owned(),
            empty_dir: !finished && has_empty_dir(pod),
            unmanaged: !finished && controller_kind(pod).is_none(),
            blocked_by: budgets.and_then(|budgets| blocking_budget(pod, budgets)),
            grace_seconds: pod.pointer("/spec/terminationGracePeriodSeconds").and_then(Value::as_u64).unwrap_or(DEFAULT_GRACE_SECONDS),
        });
    }
    evict.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
    skipped.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
    DrainPlan {
        node_cordoned: node.pointer("/spec/unschedulable").and_then(Value::as_bool).unwrap_or(false),
        evict,
        skipped,
        budgets_unknown: budgets.is_none(),
    }
}

/// `네임스페이스/이름` 목록. 많으면 앞의 몇 개만 싣는다.
fn names<'a>(pods: impl Iterator<Item = &'a DrainPod>) -> String {
    let all: Vec<String> = pods.map(|pod| format!("{}/{}", pod.namespace, pod.name)).collect();
    let shown = all.iter().take(NAMES_SHOWN).cloned().collect::<Vec<_>>().join(", ");
    if all.len() > NAMES_SHOWN {
        format!("{shown} 외 {}개", all.len() - NAMES_SHOWN)
    } else {
        shown
    }
}

fn warning(label: &str, pods: &[&DrainPod]) -> Option<String> {
    (!pods.is_empty()).then(|| format!("{label} {}개: {}", pods.len(), names(pods.iter().copied())))
}

/// drain 미리보기. 첫 호출이 cordon(서버 dry-run 대상)이고 이어서 Pod마다 Eviction 호출이 온다. 이름 입력은 늘 요구한다.
pub fn preview(change: &Change, node: &Value, drain: DrainPlan) -> Result<Plan, AppError> {
    let target = &change.target;
    let valid = matches!(change.operation, Operation::Drain)
        && target.kind.group.is_empty()
        && target.kind.kind == "Node"
        && !target.kind.namespaced
        && target.namespace.is_none()
        && !target.name.is_empty();
    if !valid {
        return Err(AppError::other(INVALID_CHANGE));
    }
    let version = node.pointer("/metadata/resourceVersion").and_then(Value::as_str).map(str::to_owned);
    let Some(resource_version) = version.clone() else {
        return Err(AppError::other(MISSING_VERSION));
    };
    let mut calls = vec![ApiCall {
        verb: "PATCH".into(),
        path: format!("/api/v1/nodes/{}", target.name),
        body: json!({"metadata":{"resourceVersion":resource_version},"spec":{"unschedulable":true}}),
    }];
    for pod in &drain.evict {
        calls.push(ApiCall {
            verb: "POST".into(),
            path: format!("/api/v1/namespaces/{}/pods/{}/eviction", pod.namespace, pod.name),
            body: json!({
                "apiVersion": "policy/v1",
                "kind": "Eviction",
                "metadata": {"name": pod.name, "namespace": pod.namespace},
                "deleteOptions": {"preconditions": {"uid": pod.uid}},
            }),
        });
    }
    let diff = vec![FieldDiff {
        path: "spec.unschedulable".into(),
        before: json!(drain.node_cordoned),
        after: json!(true),
    }];
    let mut impact = vec![DRAIN_IMPACT.to_owned(), format!("옮길 Pod {}개", drain.evict.len())];
    if !drain.skipped.is_empty() {
        impact.push(format!("건너뛰는 Pod {}개 (DaemonSet, 미러, 종료 중)", drain.skipped.len()));
    }
    let empty_dir: Vec<&DrainPod> = drain.evict.iter().filter(|pod| pod.empty_dir).collect();
    let unmanaged: Vec<&DrainPod> = drain.evict.iter().filter(|pod| pod.unmanaged).collect();
    let blocked: Vec<&DrainPod> = drain.evict.iter().filter(|pod| pod.blocked_by.is_some()).collect();
    let mut warnings: Vec<String> = [
        warning(EMPTY_DIR_WARNING, &empty_dir),
        warning(UNMANAGED_WARNING, &unmanaged),
        warning(BLOCKED_WARNING, &blocked),
    ]
    .into_iter()
    .flatten()
    .collect();
    if drain.budgets_unknown {
        warnings.push(BUDGETS_UNKNOWN_WARNING.into());
    }
    // 되돌리기는 cordon만 푼다. 이미 중지돼 있던 노드는 바꾼 것이 없으니 되돌릴 것도 없다.
    let inverse = (!drain.node_cordoned).then(|| Change {
        target: target.clone(),
        operation: Operation::Cordon { unschedulable: false },
    });
    Ok(Plan {
        preview: Preview {
            calls,
            diff,
            impact,
            warnings,
            confirm_name: Some(target.name.clone()),
            reversible: inverse.is_some(),
            drain: Some(drain),
            conflicts: Vec::new(),
            effect: None,
        },
        inverse,
        version,
        fingerprint: Some(fingerprint(node)),
    })
}

#[cfg(test)]
mod tests;
