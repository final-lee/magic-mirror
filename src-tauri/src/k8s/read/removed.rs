//! 다음 마이너 버전에서 제거되는 API를 쓰는 리소스. 고정 표에서 그 버전에 해당하는 것만 본다.
//! 객체 목록은 서버가 어느 버전으로든 같은 객체를 돌려주므로, 옛 API로 썼는지는 managedFields와 last-applied의 apiVersion으로 가린다.
//! 표는 쿠버네티스가 새 제거를 알리면 더한다. PodSecurityPolicy(1.25)는 옮겨 갈 종류가 없고 EKS 1.24는 지원이 끝나 넣지 않았다.
use kube::api::DynamicObject;
use serde::Serialize;
use serde_json::Value;

use super::secret::LAST_APPLIED;
use super::values::list;

#[derive(Debug, PartialEq)]
pub struct Removed {
    pub removed_in: &'static str,
    pub api_version: &'static str,
    pub kind: &'static str,
    /// 목록을 읽을 그룹·버전(제거 한 버전 전의 클러스터가 내주는 것)
    pub list_group: &'static str,
    pub list_version: &'static str,
    pub plural: &'static str,
    pub namespaced: bool,
    pub replacement: &'static str,
}

#[allow(clippy::too_many_arguments)]
const fn r(
    removed_in: &'static str,
    api_version: &'static str,
    kind: &'static str,
    list_group: &'static str,
    list_version: &'static str,
    plural: &'static str,
    namespaced: bool,
    replacement: &'static str,
) -> Removed {
    Removed { removed_in, api_version, kind, list_group, list_version, plural, namespaced, replacement }
}

const FC: &str = "flowcontrol.apiserver.k8s.io";

pub const REMOVED: &[Removed] = &[
    r("1.25", "batch/v1beta1", "CronJob", "batch", "v1", "cronjobs", true, "batch/v1"),
    r("1.25", "discovery.k8s.io/v1beta1", "EndpointSlice", "discovery.k8s.io", "v1", "endpointslices", true, "discovery.k8s.io/v1"),
    r("1.25", "autoscaling/v2beta1", "HorizontalPodAutoscaler", "autoscaling", "v2", "horizontalpodautoscalers", true, "autoscaling/v2"),
    r("1.25", "policy/v1beta1", "PodDisruptionBudget", "policy", "v1", "poddisruptionbudgets", true, "policy/v1"),
    r("1.25", "node.k8s.io/v1beta1", "RuntimeClass", "node.k8s.io", "v1", "runtimeclasses", false, "node.k8s.io/v1"),
    r("1.26", "autoscaling/v2beta2", "HorizontalPodAutoscaler", "autoscaling", "v2", "horizontalpodautoscalers", true, "autoscaling/v2"),
    r("1.26", "flowcontrol.apiserver.k8s.io/v1beta1", "FlowSchema", FC, "v1beta2", "flowschemas", false, "flowcontrol.apiserver.k8s.io/v1beta3"),
    r("1.26", "flowcontrol.apiserver.k8s.io/v1beta1", "PriorityLevelConfiguration", FC, "v1beta2", "prioritylevelconfigurations", false, "flowcontrol.apiserver.k8s.io/v1beta3"),
    r("1.27", "storage.k8s.io/v1beta1", "CSIStorageCapacity", "storage.k8s.io", "v1", "csistoragecapacities", true, "storage.k8s.io/v1"),
    r("1.29", "flowcontrol.apiserver.k8s.io/v1beta2", "FlowSchema", FC, "v1beta3", "flowschemas", false, "flowcontrol.apiserver.k8s.io/v1"),
    r("1.29", "flowcontrol.apiserver.k8s.io/v1beta2", "PriorityLevelConfiguration", FC, "v1beta3", "prioritylevelconfigurations", false, "flowcontrol.apiserver.k8s.io/v1"),
    r("1.32", "flowcontrol.apiserver.k8s.io/v1beta3", "FlowSchema", FC, "v1", "flowschemas", false, "flowcontrol.apiserver.k8s.io/v1"),
    r("1.32", "flowcontrol.apiserver.k8s.io/v1beta3", "PriorityLevelConfiguration", FC, "v1", "prioritylevelconfigurations", false, "flowcontrol.apiserver.k8s.io/v1"),
];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedUse {
    pub kind: String,
    pub api_version: String,
    pub replacement: String,
    pub removed_in: String,
    pub namespace: Option<String>,
    pub name: String,
}

pub fn next_minor(version: &str) -> Option<String> {
    let mut parts = version.trim_start_matches('v').split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
    Some(format!("{major}.{}", minor + 1))
}

pub fn due(cluster_version: &str) -> Vec<&'static Removed> {
    let Some(next) = next_minor(cluster_version) else { return vec![] };
    REMOVED.iter().filter(|r| r.removed_in == next).collect()
}

pub fn uses(obj: &Value, api_version: &str) -> bool {
    let managed = list(obj, "/metadata/managedFields").iter().any(|f| f["apiVersion"] == api_version);
    let applied = || {
        obj.pointer("/metadata/annotations")
            .and_then(|a| a.get(LAST_APPLIED))
            .and_then(Value::as_str)
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .is_some_and(|a| a["apiVersion"] == api_version)
    };
    managed || applied()
}

pub fn uses_of(r: &Removed, items: &[DynamicObject]) -> Vec<RemovedUse> {
    items
        .iter()
        .filter(|o| serde_json::to_value(o).is_ok_and(|v| uses(&v, r.api_version)))
        .map(|o| RemovedUse {
            kind: r.kind.into(),
            api_version: r.api_version.into(),
            replacement: r.replacement.into(),
            removed_in: r.removed_in.into(),
            namespace: o.metadata.namespace.clone(),
            name: o.metadata.name.clone().unwrap_or_default(),
        })
        .collect()
}

#[cfg(test)]
mod tests;
