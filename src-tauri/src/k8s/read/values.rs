//! 종류별 목록 값(`Row::values`)과 이상 표시(`Row::problems`). 값의 키는 프론트 `src/k8s/columns.ts`의 열 키와 같다.
//! Secret은 타입과 키 개수만 읽는다. 값은 어떤 경로로도 줄에 들어가지 않는다.
use std::collections::BTreeMap;

use k8s_openapi::jiff::Timestamp;
use kube::api::DynamicObject;
use serde::Serialize;
use serde_json::Value;

use crate::k8s::rows::{rfc3339_secs, KindRef};
mod extra;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Problem {
    CrashLoopBackOff,
    ImagePullBackOff,
    Pending,
    OomKilled,
    NotReady,
    ScalingBlocked,
    NoDisruptions,
    QuotaExceeded,
    NotEstablished,
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

pub const IRSA_ANNOTATION: &str = "eks.amazonaws.com/role-arn";
pub const INSTANCE_TYPE_LABEL: &str = "node.kubernetes.io/instance-type";
pub const ZONE_LABEL: &str = "topology.kubernetes.io/zone";
const DEFAULT_CLASS_ANNOTATION: &str = "storageclass.kubernetes.io/is-default-class";
const ENDPOINTS_SHOWN: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GroupKind {
    Managed,
    Fargate,
    Karpenter,
    #[serde(rename = "self")]
    SelfManaged,
}

impl GroupKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GroupKind::Managed => "managed",
            GroupKind::Fargate => "fargate",
            GroupKind::Karpenter => "karpenter",
            GroupKind::SelfManaged => "self",
        }
    }
}

/// 노드가 속한 묶음. Fargate → 관리형 노드그룹 → Karpenter(EKS Auto Mode 포함) → 자체 관리 순서로 레이블을 본다.
pub fn node_group(labels: &BTreeMap<String, String>) -> (GroupKind, Option<String>) {
    if labels.get("eks.amazonaws.com/compute-type").map(String::as_str) == Some("fargate") {
        return (GroupKind::Fargate, labels.get("eks.amazonaws.com/fargate-profile").cloned());
    }
    if let Some(n) = labels.get("eks.amazonaws.com/nodegroup") {
        return (GroupKind::Managed, Some(n.clone()));
    }
    if let Some(n) = labels.get("karpenter.sh/nodepool") {
        return (GroupKind::Karpenter, Some(n.clone()));
    }
    (GroupKind::SelfManaged, None)
}

pub fn labels_of(obj: &DynamicObject) -> BTreeMap<String, String> {
    obj.metadata.labels.clone().unwrap_or_default().into_iter().collect()
}

fn annotation<'a>(obj: &'a DynamicObject, key: &str) -> Option<&'a str> {
    obj.metadata.annotations.as_ref()?.get(key).map(String::as_str)
}

fn joined(items: impl Iterator<Item = String>) -> Option<String> {
    let all: Vec<String> = items.filter(|s| !s.is_empty()).collect();
    (!all.is_empty()).then(|| all.join(","))
}

fn strings(d: &Value, path: &str) -> Option<String> {
    joined(list(d, path).iter().filter_map(|v| v.as_str().map(str::to_string)))
}

fn object_keys(d: &Value, path: &str) -> usize {
    d.pointer(path).and_then(Value::as_object).map_or(0, |m| m.len())
}

/// 로드밸런서 주소(호스트 이름 또는 IP)
fn lb_addresses(d: &Value) -> Option<String> {
    joined(list(d, "/status/loadBalancer/ingress").iter().filter_map(|i| i["hostname"].as_str().or(i["ip"].as_str()).map(str::to_string)))
}

pub fn event_count(d: &Value) -> i64 {
    int(d, "/series/count").or_else(|| int(d, "/count")).unwrap_or(1)
}

/// 마지막으로 본 시각: series.lastObservedTime → lastTimestamp → eventTime → 만든 시각, 초 단위 RFC 3339
pub fn event_last_seen(obj: &DynamicObject) -> Option<String> {
    let d = &obj.data;
    ["/series/lastObservedTime", "/lastTimestamp", "/eventTime"]
        .iter()
        .find_map(|p| text(d, p).and_then(|s| s.parse::<Timestamp>().ok()))
        .map(|t| rfc3339_secs(&t))
        .or_else(|| obj.metadata.creation_timestamp.as_ref().map(|t| rfc3339_secs(&t.0)))
}

pub fn event_object(d: &Value) -> String {
    format!("{}/{}", text(d, "/involvedObject/kind").unwrap_or(""), text(d, "/involvedObject/name").unwrap_or(""))
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
        ("", "Service") => {
            v.put_some("type", text(d, "/spec/type"));
            v.put_some("clusterIp", text(d, "/spec/clusterIP"));
            let external = lb_addresses(d).or_else(|| strings(d, "/spec/externalIPs"));
            v.put_some("externalIp", external.as_deref());
            let ports = joined(list(d, "/spec/ports").iter().map(|p| {
                let proto = p["protocol"].as_str().unwrap_or("TCP");
                match p["nodePort"].as_i64() {
                    Some(n) => format!("{}:{n}/{proto}", p["port"]),
                    None => format!("{}/{proto}", p["port"]),
                }
            }));
            v.put_some("ports", ports.as_deref());
        }
        ("networking.k8s.io", "Ingress") => {
            v.put_some("class", text(d, "/spec/ingressClassName"));
            let hosts = joined(list(d, "/spec/rules").iter().filter_map(|r| r["host"].as_str().map(str::to_string)));
            v.put_some("hosts", hosts.as_deref());
            v.put_some("address", lb_addresses(d).as_deref());
        }
        ("networking.k8s.io", "NetworkPolicy") => {
            let selector = d
                .pointer("/spec/podSelector/matchLabels")
                .and_then(Value::as_object)
                .and_then(|m| joined(m.iter().map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or("")))));
            v.put_some("podSelector", selector.as_deref());
            v.put_some("policyTypes", strings(d, "/spec/policyTypes").as_deref());
        }
        ("", "Endpoints") => {
            let all: Vec<String> = list(d, "/subsets")
                .iter()
                .flat_map(|s| {
                    let ports: Vec<i64> = s["ports"].as_array().map_or(vec![], |p| p.iter().filter_map(|p| p["port"].as_i64()).collect());
                    let ips: Vec<String> = s["addresses"].as_array().map_or(vec![], |a| a.iter().filter_map(|a| a["ip"].as_str().map(str::to_string)).collect());
                    ips.into_iter().flat_map(move |ip| ports.clone().into_iter().map(move |p| format!("{ip}:{p}")))
                })
                .collect();
            if !all.is_empty() {
                let mut shown = all.iter().take(ENDPOINTS_SHOWN).cloned().collect::<Vec<_>>().join(", ");
                if all.len() > ENDPOINTS_SHOWN {
                    shown.push_str(&format!(" +{}", all.len() - ENDPOINTS_SHOWN));
                }
                v.put("endpoints", shown);
            }
        }
        ("", "ConfigMap") => v.put("keys", (object_keys(d, "/data") + object_keys(d, "/binaryData")).to_string()),
        // 값은 읽지 않는다: 타입과 키 개수만
        ("", "Secret") => {
            v.put_some("type", text(d, "/type"));
            v.put("keys", (object_keys(d, "/data") + object_keys(d, "/stringData")).to_string());
        }
        ("", "ServiceAccount") => v.put_some("roleArn", annotation(obj, IRSA_ANNOTATION)),
        ("", "PersistentVolumeClaim") => {
            let phase = text(d, "/status/phase");
            v.put_some("status", phase);
            v.put_some("volume", text(d, "/spec/volumeName"));
            v.put_some("capacity", text(d, "/status/capacity/storage"));
            v.put_some("accessModes", strings(d, "/spec/accessModes").as_deref());
            v.put_some("storageClass", text(d, "/spec/storageClassName"));
            if phase == Some("Pending") {
                v.flag(Problem::Pending);
            }
        }
        ("", "PersistentVolume") => {
            v.put_some("capacity", text(d, "/spec/capacity/storage"));
            v.put_some("accessModes", strings(d, "/spec/accessModes").as_deref());
            v.put_some("reclaimPolicy", text(d, "/spec/persistentVolumeReclaimPolicy"));
            v.put_some("status", text(d, "/status/phase"));
            if let (Some(ns), Some(name)) = (text(d, "/spec/claimRef/namespace"), text(d, "/spec/claimRef/name")) {
                v.put("claim", format!("{ns}/{name}"));
            }
            v.put_some("storageClass", text(d, "/spec/storageClassName"));
        }
        ("storage.k8s.io", "StorageClass") => {
            v.put_some("provisioner", text(d, "/provisioner"));
            v.put_some("reclaimPolicy", text(d, "/reclaimPolicy"));
            v.put_some("volumeBindingMode", text(d, "/volumeBindingMode"));
            if annotation(obj, DEFAULT_CLASS_ANNOTATION) == Some("true") {
                v.put("default", "true");
            }
        }
        ("", "Node") => {
            let ready = condition(d, "Ready");
            let mut status = match ready {
                Some("True") => "Ready",
                Some("False") => "NotReady",
                _ => "Unknown",
            }
            .to_string();
            if d.pointer("/spec/unschedulable") == Some(&Value::Bool(true)) {
                status.push_str(",SchedulingDisabled");
            }
            if ready != Some("True") {
                v.flag(Problem::NotReady);
            }
            v.put("status", status);
            v.put_some("version", text(d, "/status/nodeInfo/kubeletVersion"));
            let labels = labels_of(obj);
            v.put_some("instanceType", labels.get(INSTANCE_TYPE_LABEL).map(String::as_str));
            v.put_some("zone", labels.get(ZONE_LABEL).map(String::as_str));
            let (kind, group) = node_group(&labels);
            v.put("groupKind", kind.as_str());
            v.put_some("group", group.as_deref());
        }
        ("", "Event") => {
            v.put_some("type", text(d, "/type"));
            v.put_some("reason", text(d, "/reason"));
            v.put("object", event_object(d));
            v.put_some("message", text(d, "/message"));
            v.put("count", event_count(d).to_string());
            if let Some(t) = event_last_seen(obj) {
                v.put("lastSeen", t);
            }
        }
        ("", "Namespace") => v.put_some("status", text(d, "/status/phase")),
        (group, kind) if extra::builtin(group, kind, obj, &mut v) => {}
        // 그 밖의 종류(CRD 포함): Ready 조건이 있으면 보여 준다
        _ => {
            if let Some(s) = condition(d, "Ready") {
                v.put("ready", s);
                if s == "False" {
                    v.flag(Problem::NotReady);
                }
            }
        }
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
