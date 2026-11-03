//! 네트워크 화면의 쿠버네티스 쪽: Service, Ingress, 노드, Pod, NetworkPolicy, 네임스페이스를 읽고(GET·LIST만) 화면용 값으로 줄인다.
use kube::api::{DynamicObject, ListParams};
use kube::Client;

use super::model::{NodeNet, PodNet};
use crate::error::AppError;
use crate::k8s::failure::Endpoint;
use crate::k8s::read::overview::{LIST_PAGES_MAX, RUNNING_PODS};
use crate::k8s::read::values::{condition, labels_of, list, text, ZONE_LABEL, INSTANCE_TYPE_LABEL};
use crate::k8s::read::{api_for, list_all};
use crate::k8s::rows::KindRef;

fn kind(group: &str, version: &str, kind: &str, plural: &str, namespaced: bool) -> KindRef {
    KindRef { group: group.into(), version: version.into(), kind: kind.into(), plural: plural.into(), namespaced }
}

/// 한 번에 읽은 쿠버네티스 쪽 원본. 종류마다 실패를 따로 담는다.
pub struct Parts {
    pub services: Result<Vec<DynamicObject>, AppError>,
    pub ingresses: Result<Vec<DynamicObject>, AppError>,
    pub nodes: Result<Vec<DynamicObject>, AppError>,
    /// 끝나지 않은 Pod와, 목록이 쪽 수 한도에서 잘렸는지
    pub pods: Result<(Vec<DynamicObject>, bool), AppError>,
    pub policies: Result<Vec<DynamicObject>, AppError>,
    pub namespaces: Result<Vec<DynamicObject>, AppError>,
}

pub async fn read(client: &Client, endpoint: Endpoint) -> Parts {
    let all = |k: KindRef| api_for(client.clone(), &k, None);
    let services = all(kind("", "v1", "Service", "services", true));
    let ingresses = all(kind("networking.k8s.io", "v1", "Ingress", "ingresses", true));
    let nodes = all(kind("", "v1", "Node", "nodes", false));
    let pods = all(kind("", "v1", "Pod", "pods", true));
    let policies = all(kind("networking.k8s.io", "v1", "NetworkPolicy", "networkpolicies", true));
    let namespaces = all(kind("", "v1", "Namespace", "namespaces", false));
    let lp = ListParams::default();
    let pod_lp = ListParams::default().fields(RUNNING_PODS);
    let (services, ingresses, nodes, pods, policies, namespaces) = tokio::join!(
        list_all(&services, &lp, LIST_PAGES_MAX, "services", endpoint),
        list_all(&ingresses, &lp, LIST_PAGES_MAX, "ingresses", endpoint),
        list_all(&nodes, &lp, LIST_PAGES_MAX, "nodes", endpoint),
        list_all(&pods, &pod_lp, LIST_PAGES_MAX, "pods", endpoint),
        list_all(&policies, &lp, LIST_PAGES_MAX, "networkpolicies", endpoint),
        list_all(&namespaces, &lp, LIST_PAGES_MAX, "namespaces", endpoint),
    );
    Parts {
        services: services.map(|(items, _)| items),
        ingresses: ingresses.map(|(items, _)| items),
        nodes: nodes.map(|(items, _)| items),
        pods,
        policies: policies.map(|(items, _)| items),
        namespaces: namespaces.map(|(items, _)| items),
    }
}

/// 인스턴스 ID 모양(`i-` + 16진수)인지. Fargate와 kind 노드의 providerID는 이 모양이 아니다.
fn is_instance_id(id: &str) -> bool {
    id.strip_prefix("i-").is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_hexdigit()))
}

/// `aws:///ap-northeast-2a/i-0123456789abcdef0` → (zone, 인스턴스 ID). 인스턴스 ID가 아니면 ID는 None.
pub fn parse_provider_id(provider_id: &str) -> (Option<String>, Option<String>) {
    let Some(rest) = provider_id.strip_prefix("aws:///") else { return (None, None) };
    let mut parts = rest.splitn(2, '/');
    let zone = parts.next().filter(|z| !z.is_empty()).map(str::to_string);
    let id = parts.next().filter(|id| is_instance_id(id)).map(str::to_string);
    (zone, id)
}

pub fn node_nets(nodes: &[DynamicObject]) -> Vec<NodeNet> {
    let mut out: Vec<NodeNet> = nodes
        .iter()
        .map(|n| {
            let labels = labels_of(n);
            let provider_id = text(&n.data, "/spec/providerID").filter(|p| !p.is_empty()).map(str::to_string);
            let (provider_zone, instance_id) = provider_id.as_deref().map(parse_provider_id).unwrap_or((None, None));
            NodeNet {
                name: n.metadata.name.clone().unwrap_or_default(),
                ready: condition(&n.data, "Ready") == Some("True"),
                fargate: labels.get("eks.amazonaws.com/compute-type").map(String::as_str) == Some("fargate"),
                instance_type: labels.get(INSTANCE_TYPE_LABEL).cloned(),
                internal_ip: list(&n.data, "/status/addresses").iter().find(|a| a["type"] == "InternalIP").and_then(|a| a["address"].as_str()).map(str::to_string),
                zone: labels.get(ZONE_LABEL).cloned().or(provider_zone),
                provider_id,
                instance_id,
                instance_state: None,
                subnet_id: None,
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Pod 중 IP가 있는 것. 둘째 값은 VPC CNI(kube-system의 `k8s-app=aws-node` Pod)가 있는지.
pub fn pod_nets(pods: &[DynamicObject]) -> (Vec<PodNet>, bool) {
    let vpc_cni = pods.iter().any(|p| p.metadata.namespace.as_deref() == Some("kube-system") && labels_of(p).get("k8s-app").map(String::as_str) == Some("aws-node"));
    let mut out: Vec<PodNet> = pods
        .iter()
        .filter_map(|p| {
            let ip = text(&p.data, "/status/podIP").filter(|ip| !ip.is_empty())?;
            Some(PodNet {
                namespace: p.metadata.namespace.clone().unwrap_or_default(),
                name: p.metadata.name.clone().unwrap_or_default(),
                ip: ip.to_string(),
                node: text(&p.data, "/spec/nodeName").map(str::to_string),
                host_network: p.data.pointer("/spec/hostNetwork") == Some(&serde_json::Value::Bool(true)),
                subnet_id: None,
            })
        })
        .collect();
    out.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
    (out, vpc_cni)
}

#[cfg(test)]
mod tests;
