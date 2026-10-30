//! 개요의 노드: 상태, 묶음, 할당 가능량 대비 요청량, metrics-server 사용량, 컨트롤 플레인과의 버전 차이.
use std::collections::HashMap;

use kube::api::DynamicObject;
use serde::Serialize;
use serde_json::Value;

use super::quantity::{bytes, cpu_milli};
use super::values::{condition, labels_of, list, node_group, text, GroupKind, INSTANCE_TYPE_LABEL, ZONE_LABEL};

pub const PRESSURES: [&str; 4] = ["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"];

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resources {
    pub cpu_milli: i64,
    pub memory_bytes: i64,
    pub pods: i64,
}

impl Resources {
    fn add(&mut self, o: Resources) {
        self.cpu_milli += o.cpu_milli;
        self.memory_bytes += o.memory_bytes;
        self.pods += o.pods;
    }

    fn max(self, o: Resources) -> Resources {
        Resources { cpu_milli: self.cpu_milli.max(o.cpu_milli), memory_bytes: self.memory_bytes.max(o.memory_bytes), pods: self.pods.max(o.pods) }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub cpu_milli: i64,
    pub memory_bytes: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeView {
    pub name: String,
    pub ready: bool,
    pub unschedulable: bool,
    pub pressures: Vec<String>,
    pub instance_type: Option<String>,
    pub zone: Option<String>,
    pub group_kind: GroupKind,
    pub group: Option<String>,
    pub kubelet_version: String,
    pub allocatable: Resources,
    pub requested: Resources,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skew {
    pub node: String,
    pub kubelet_version: String,
    pub minors_behind: u32,
}

fn resources_at(d: &Value, path: &str) -> Resources {
    let at = |k: &str| d.pointer(&format!("{path}/{k}")).and_then(Value::as_str);
    Resources {
        cpu_milli: at("cpu").and_then(cpu_milli).unwrap_or(0),
        memory_bytes: at("memory").and_then(bytes).unwrap_or(0),
        pods: at("pods").and_then(|p| p.parse().ok()).unwrap_or(0),
    }
}

/// kubectl describe node와 같은 셈: max(컨테이너 합, 가장 큰 init 컨테이너) + overhead
pub fn pod_requests(pod: &Value) -> Resources {
    let mut sum = Resources::default();
    for c in list(pod, "/spec/containers") {
        sum.add(resources_at(c, "/resources/requests"));
    }
    let init = list(pod, "/spec/initContainers").iter().map(|c| resources_at(c, "/resources/requests")).fold(Resources::default(), Resources::max);
    let mut total = sum.max(init);
    total.add(resources_at(pod, "/spec/overhead"));
    total.pods = 1;
    total
}

pub fn requests_by_node(pods: &[DynamicObject]) -> HashMap<String, Resources> {
    let mut out: HashMap<String, Resources> = HashMap::new();
    for p in pods {
        let d = &p.data;
        if matches!(text(d, "/status/phase"), Some("Succeeded" | "Failed")) {
            continue;
        }
        let Some(node) = text(d, "/spec/nodeName") else { continue };
        out.entry(node.to_string()).or_default().add(pod_requests(d));
    }
    out
}

pub fn usage_of(metrics: &DynamicObject) -> (String, Usage) {
    let d = &metrics.data;
    let usage = Usage { cpu_milli: text(d, "/usage/cpu").and_then(cpu_milli).unwrap_or(0), memory_bytes: text(d, "/usage/memory").and_then(bytes).unwrap_or(0) };
    (metrics.metadata.name.clone().unwrap_or_default(), usage)
}

pub fn node_view(node: &DynamicObject, requested: Resources, usage: Option<Usage>) -> NodeView {
    let d = &node.data;
    let labels = labels_of(node);
    let (group_kind, group) = node_group(&labels);
    NodeView {
        name: node.metadata.name.clone().unwrap_or_default(),
        ready: condition(d, "Ready") == Some("True"),
        unschedulable: d.pointer("/spec/unschedulable") == Some(&Value::Bool(true)),
        pressures: PRESSURES.iter().filter(|p| condition(d, p) == Some("True")).map(|p| p.to_string()).collect(),
        instance_type: labels.get(INSTANCE_TYPE_LABEL).cloned(),
        zone: labels.get(ZONE_LABEL).cloned(),
        group_kind,
        group,
        kubelet_version: text(d, "/status/nodeInfo/kubeletVersion").unwrap_or("").to_string(),
        allocatable: resources_at(d, "/status/allocatable"),
        requested,
        usage,
    }
}

pub fn minor(version: &str) -> Option<u32> {
    version.trim_start_matches('v').split('.').nth(1)?.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

pub fn skew(control_plane: &str, nodes: &[NodeView]) -> Vec<Skew> {
    let Some(cp) = minor(control_plane) else { return vec![] };
    nodes
        .iter()
        .filter_map(|n| {
            let m = minor(&n.kubelet_version)?;
            (m < cp).then(|| Skew { node: n.name.clone(), kubelet_version: n.kubelet_version.clone(), minors_behind: cp - m })
        })
        .collect()
}

#[cfg(test)]
mod tests;
