//! 종류별 목록 값(`Row::values`)과 이상 표시(`Row::problems`). 값의 키는 프론트 `src/k8s/columns.ts`의 열 키와 같다.
//! Secret은 타입과 키 개수만 읽는다. 값은 어떤 경로로도 줄에 들어가지 않는다.
use std::collections::BTreeMap;

use kube::api::DynamicObject;
use serde::Serialize;
use serde_json::Value;

use crate::k8s::rows::KindRef;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Problem {
    CrashLoopBackOff,
    ImagePullBackOff,
    Pending,
    OomKilled,
    NotReady,
}

#[derive(Debug, Default, PartialEq)]
pub struct Values {
    pub values: BTreeMap<String, String>,
    pub problems: Vec<Problem>,
}

impl Values {
    fn put(&mut self, key: &str, value: impl Into<String>) {
        self.values.insert(key.into(), value.into());
    }

    fn put_some(&mut self, key: &str, value: Option<&str>) {
        if let Some(v) = value.filter(|v| !v.is_empty()) {
            self.put(key, v);
        }
    }

    fn flag(&mut self, p: Problem) {
        if !self.problems.contains(&p) {
            self.problems.push(p);
        }
    }
}

pub fn text<'a>(d: &'a Value, path: &str) -> Option<&'a str> {
    d.pointer(path).and_then(Value::as_str)
}

pub fn int(d: &Value, path: &str) -> Option<i64> {
    d.pointer(path).and_then(Value::as_i64)
}

pub fn list<'a>(d: &'a Value, path: &str) -> &'a [Value] {
    d.pointer(path).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// `status.conditions`에서 `type`이 같은 조건의 `status`("True", "False", "Unknown")
pub fn condition<'a>(d: &'a Value, ty: &str) -> Option<&'a str> {
    list(d, "/status/conditions").iter().find(|c| c["type"] == ty).and_then(|c| c["status"].as_str())
}

pub fn values_of(kind: &KindRef, obj: &DynamicObject) -> Values {
    let d = &obj.data;
    let mut v = Values::default();
    match (kind.group.as_str(), kind.kind.as_str()) {
        ("", "Pod") => pod(obj, &mut v),
        ("apps", "Deployment") => {
            let desired = int(d, "/spec/replicas").unwrap_or(1);
            ready_of(d, desired, "/status/readyReplicas", &mut v);
            v.put("upToDate", int(d, "/status/updatedReplicas").unwrap_or(0).to_string());
            v.put("available", int(d, "/status/availableReplicas").unwrap_or(0).to_string());
        }
        ("apps", "StatefulSet") => ready_of(d, int(d, "/spec/replicas").unwrap_or(1), "/status/readyReplicas", &mut v),
        ("apps", "ReplicaSet") => {
            let desired = int(d, "/spec/replicas").unwrap_or(1);
            let ready = int(d, "/status/readyReplicas").unwrap_or(0);
            v.put("desired", desired.to_string());
            v.put("current", int(d, "/status/replicas").unwrap_or(0).to_string());
            v.put("ready", ready.to_string());
            if ready < desired {
                v.flag(Problem::NotReady);
            }
        }
        ("apps", "DaemonSet") => {
            let desired = int(d, "/status/desiredNumberScheduled").unwrap_or(0);
            let ready = int(d, "/status/numberReady").unwrap_or(0);
            v.put("desired", desired.to_string());
            v.put("current", int(d, "/status/currentNumberScheduled").unwrap_or(0).to_string());
            v.put("ready", ready.to_string());
            v.put("upToDate", int(d, "/status/updatedNumberScheduled").unwrap_or(0).to_string());
            v.put("available", int(d, "/status/numberAvailable").unwrap_or(0).to_string());
            if ready < desired {
                v.flag(Problem::NotReady);
            }
        }
        ("batch", "Job") => {
            let wanted = int(d, "/spec/completions").unwrap_or(1);
            v.put("completions", format!("{}/{wanted}", int(d, "/status/succeeded").unwrap_or(0)));
            let status = if condition(d, "Complete") == Some("True") {
                "Complete"
            } else if condition(d, "Failed") == Some("True") {
                "Failed"
            } else {
                "Running"
            };
            v.put("status", status);
        }
        ("batch", "CronJob") => {
            v.put_some("schedule", text(d, "/spec/schedule"));
            v.put("suspend", (d.pointer("/spec/suspend") == Some(&Value::Bool(true))).to_string());
            v.put("active", list(d, "/status/active").len().to_string());
            v.put_some("lastSchedule", text(d, "/status/lastScheduleTime"));
        }
        ("", "Namespace") => v.put_some("status", text(d, "/status/phase")),
        _ => {}
    }
    v.problems.sort();
    v
}

/// `ready`를 "준비/원하는 수"로 넣고 모자라면 표시한다
fn ready_of(d: &Value, desired: i64, path: &str, v: &mut Values) {
    let ready = int(d, path).unwrap_or(0);
    v.put("ready", format!("{ready}/{desired}"));
    if ready < desired {
        v.flag(Problem::NotReady);
    }
}

fn pod(obj: &DynamicObject, v: &mut Values) {
    let d = &obj.data;
    let statuses = list(d, "/status/containerStatuses");
    let inits = list(d, "/status/initContainerStatuses");
    let total = list(d, "/spec/containers").len();
    let ready = statuses.iter().filter(|s| s["ready"].as_bool() == Some(true)).count();
    let restarts: i64 = statuses.iter().filter_map(|s| s["restartCount"].as_i64()).sum();
    let phase = text(d, "/status/phase").unwrap_or("");
    v.put("ready", format!("{ready}/{total}"));
    v.put("restarts", restarts.to_string());
    v.put_some("node", text(d, "/spec/nodeName"));
    v.put_some("ip", text(d, "/status/podIP"));
    v.put("status", pod_status(obj, statuses, inits, phase));
    for s in statuses.iter().chain(inits) {
        match s.pointer("/state/waiting/reason").and_then(Value::as_str) {
            Some("CrashLoopBackOff") => v.flag(Problem::CrashLoopBackOff),
            Some("ImagePullBackOff" | "ErrImagePull") => v.flag(Problem::ImagePullBackOff),
            _ => {}
        }
        let oom = |p: &str| s.pointer(p).and_then(Value::as_str) == Some("OOMKilled");
        if oom("/state/terminated/reason") || oom("/lastState/terminated/reason") {
            v.flag(Problem::OomKilled);
        }
    }
    if phase == "Pending" {
        v.flag(Problem::Pending);
    }
    if phase == "Running" && ready < total {
        v.flag(Problem::NotReady);
    }
}

/// kubectl get pods의 STATUS를 줄인 규칙: 지우는 중 → 끝나지 않은 init 컨테이너의 이유(`Init:` 접두) → 컨테이너가 기다리거나 끝난 이유 → status.reason → phase
fn pod_status(obj: &DynamicObject, statuses: &[Value], inits: &[Value], phase: &str) -> String {
    if obj.metadata.deletion_timestamp.is_some() {
        return "Terminating".into();
    }
    // 클로저로 쓰면 돌려주는 참조의 수명을 추론하지 못해 함수로 둔다
    fn reason_of(s: &Value) -> Option<&str> {
        s.pointer("/state/waiting/reason").or_else(|| s.pointer("/state/terminated/reason")).and_then(Value::as_str).filter(|r| !r.is_empty())
    }
    fn unfinished(s: &&Value) -> bool {
        s.pointer("/state/terminated/exitCode").and_then(Value::as_i64) != Some(0)
    }
    if let Some(r) = inits.iter().filter(unfinished).find_map(reason_of) {
        return format!("Init:{r}");
    }
    if let Some(r) = statuses.iter().find_map(reason_of) {
        return r.into();
    }
    text(&obj.data, "/status/reason").filter(|r| !r.is_empty()).unwrap_or(phase).to_string()
}

#[cfg(test)]
mod tests;
