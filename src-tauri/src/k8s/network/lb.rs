//! Service·Ingress와 ELBv2 로드 밸런서의 짝 찾기. 순수 함수만 둔다(AWS 호출은 `aws.rs`).
//! 짝은 status 호스트명과 DNS 이름이 같은 것을 먼저 보고, 없으면 AWS Load Balancer Controller 태그(클러스터 + stack)로 찾는다.
use std::collections::HashSet;

use kube::api::DynamicObject;
use serde_json::Value;

use super::model::{AwsLb, LbKind, LbSource, MatchedBy, NodeNet, ObjectLink, PodNet, SourceKind, UnclaimedLb};
use crate::k8s::read::values::{list, text};

pub const CLUSTER_TAG: &str = "elbv2.k8s.aws/cluster";
pub const SERVICE_STACK_TAG: &str = "service.k8s.aws/stack";
pub const INGRESS_STACK_TAG: &str = "ingress.k8s.aws/stack";
const GROUP_ANNOTATION: &str = "alb.ingress.kubernetes.io/group.name";
const LEGACY_INGRESS_CLASS: &str = "kubernetes.io/ingress.class";
const LEGACY_SERVICE_TYPE: &str = "service.beta.kubernetes.io/aws-load-balancer-type";

fn annotation<'a>(obj: &'a DynamicObject, key: &str) -> Option<&'a str> {
    obj.metadata.annotations.as_ref()?.get(key).map(String::as_str).filter(|v| !v.is_empty())
}

fn status_addresses(d: &Value, key: &str) -> Vec<String> {
    list(d, "/status/loadBalancer/ingress").iter().filter_map(|i| i.get(key).and_then(Value::as_str)).filter(|s| !s.is_empty()).map(str::to_string).collect()
}

/// type이 LoadBalancer인 Service. 이름 순이다.
pub fn service_sources(services: &[DynamicObject]) -> Vec<LbSource> {
    let mut out: Vec<LbSource> = services
        .iter()
        .filter(|s| text(&s.data, "/spec/type") == Some("LoadBalancer"))
        .map(|s| LbSource {
            kind: SourceKind::Service,
            namespace: s.metadata.namespace.clone().unwrap_or_default(),
            name: s.metadata.name.clone().unwrap_or_default(),
            class: text(&s.data, "/spec/loadBalancerClass").or_else(|| annotation(s, LEGACY_SERVICE_TYPE)).map(str::to_string),
            hostnames: status_addresses(&s.data, "hostname"),
            ips: status_addresses(&s.data, "ip"),
            ports: list(&s.data, "/spec/ports")
                .iter()
                .filter_map(|p| Some(format!("{}/{}", p["port"].as_i64()?, p["protocol"].as_str().unwrap_or("TCP"))))
                .collect(),
            group: None,
        })
        .collect();
    out.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
    out
}

fn backend_text(b: &Value) -> String {
    match b.get("service") {
        Some(svc) => {
            let port = svc.pointer("/port/number").and_then(Value::as_i64).map(|n| n.to_string()).or_else(|| text(svc, "/port/name").map(str::to_string));
            format!("{}:{}", text(svc, "/name").unwrap_or(""), port.unwrap_or_default())
        }
        None => format!("{}/{}", text(b, "/resource/kind").unwrap_or("resource"), text(b, "/resource/name").unwrap_or("")),
    }
}

/// Ingress의 `host/path → service:port` 규칙들. 기본 백엔드는 `(기본)`으로 적는다.
fn ingress_rules(d: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(b) = d.pointer("/spec/defaultBackend") {
        out.push(format!("(기본) → {}", backend_text(b)));
    }
    for rule in list(d, "/spec/rules") {
        let host = text(rule, "/host").unwrap_or("*");
        for path in list(rule, "/http/paths") {
            out.push(format!("{host}{} → {}", text(path, "/path").unwrap_or("/"), backend_text(&path["backend"])));
        }
    }
    out
}

/// 모든 Ingress. 이름 순이다.
pub fn ingress_sources(ingresses: &[DynamicObject]) -> Vec<LbSource> {
    let mut out: Vec<LbSource> = ingresses
        .iter()
        .map(|i| LbSource {
            kind: SourceKind::Ingress,
            namespace: i.metadata.namespace.clone().unwrap_or_default(),
            name: i.metadata.name.clone().unwrap_or_default(),
            class: text(&i.data, "/spec/ingressClassName").or_else(|| annotation(i, LEGACY_INGRESS_CLASS)).map(str::to_string),
            hostnames: status_addresses(&i.data, "hostname"),
            ips: status_addresses(&i.data, "ip"),
            ports: ingress_rules(&i.data),
            group: annotation(i, GROUP_ANNOTATION).map(str::to_string),
        })
        .collect();
    out.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
    out
}

/// DNS 이름 비교용: 소문자, 끝의 점과 `dualstack.` 접두를 뗀다(Route 53 별칭 이름으로 적힌 주소도 같은 로드 밸런서다).
fn host_key(host: &str) -> String {
    let lower = host.trim().trim_end_matches('.').to_ascii_lowercase();
    lower.strip_prefix("dualstack.").map(str::to_string).unwrap_or(lower)
}

/// 이 로드 밸런서를 이 클러스터의 컨트롤러가 만들었는지(태그)
fn of_cluster(lb: &AwsLb, cluster: &str) -> bool {
    lb.tags.get(CLUSTER_TAG).map(String::as_str) == Some(cluster)
}

/// 이 객체가 컨트롤러 태그에 어떤 stack 값으로 나타나는지: Service는 `네임스페이스/이름`, Ingress는 그룹 이름 또는 `네임스페이스/이름`
fn stack_of(source: &LbSource) -> (&'static str, String) {
    match source.kind {
        SourceKind::Service => (SERVICE_STACK_TAG, format!("{}/{}", source.namespace, source.name)),
        SourceKind::Ingress => (INGRESS_STACK_TAG, source.group.clone().unwrap_or_else(|| format!("{}/{}", source.namespace, source.name))),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Found {
    pub index: usize,
    pub by: MatchedBy,
}

/// `lbs`에서 이 객체의 로드 밸런서를 찾는다. 호스트명이 가리키는 것이 우선이고(주소는 유일하다),
/// 호스트명이 없거나 어느 것과도 맞지 않을 때만 태그로 찾는다. 태그로는 같은 클러스터 이름이 붙은 것만 인정한다.
pub fn find(source: &LbSource, cluster: &str, lbs: &[AwsLb]) -> Option<Found> {
    let by_host = source.hostnames.iter().map(|h| host_key(h)).find_map(|h| lbs.iter().position(|lb| host_key(&lb.dns_name) == h));
    let (key, stack) = stack_of(source);
    // 같은 stack이 둘이면 이름이 앞선 것으로 정한다(결과가 입력 순서에 흔들리지 않게)
    let by_tag = lbs
        .iter()
        .enumerate()
        .filter(|(_, lb)| of_cluster(lb, cluster) && lb.tags.get(key) == Some(&stack))
        .min_by(|(_, a), (_, b)| a.name.cmp(&b.name))
        .map(|(i, _)| i);
    match (by_host, by_tag) {
        (Some(h), Some(t)) if h == t => Some(Found { index: h, by: MatchedBy::Both }),
        (Some(h), _) => Some(Found { index: h, by: MatchedBy::Hostname }),
        (None, Some(t)) => Some(Found { index: t, by: MatchedBy::Tag }),
        (None, None) => None,
    }
}

/// 이 클러스터 태그가 붙었지만 어떤 객체도 고르지 않은 로드 밸런서. 이름 순.
pub fn unclaimed(lbs: &[AwsLb], cluster: &str, claimed: &HashSet<String>) -> Vec<UnclaimedLb> {
    let mut out: Vec<UnclaimedLb> = lbs
        .iter()
        .filter(|lb| of_cluster(lb, cluster) && !claimed.contains(&lb.arn))
        .map(|lb| UnclaimedLb {
            arn: lb.arn.clone(),
            name: lb.name.clone(),
            dns_name: lb.dns_name.clone(),
            kind: lb.kind,
            scheme: lb.scheme.clone(),
            state: lb.state.clone(),
            stack: lb.tags.get(SERVICE_STACK_TAG).or_else(|| lb.tags.get(INGRESS_STACK_TAG)).cloned(),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn kind_of(text: &str) -> Option<LbKind> {
    match text {
        "application" => Some(LbKind::Application),
        "network" => Some(LbKind::Network),
        "gateway" => Some(LbKind::Gateway),
        _ => None,
    }
}

/// 대상 그룹의 대상(인스턴스 ID나 IP)을 쿠버네티스 객체로 잇는다. Pod IP를 먼저 보고(hostNetwork Pod는 노드 IP라 제외),
/// 그다음 노드의 인스턴스 ID와 내부 IP를 본다.
pub fn target_link(id: &str, nodes: &[NodeNet], pods: &[PodNet]) -> Option<ObjectLink> {
    if let Some(p) = pods.iter().find(|p| !p.host_network && p.ip == id) {
        return Some(ObjectLink { kind: "Pod".into(), namespace: Some(p.namespace.clone()), name: p.name.clone() });
    }
    nodes
        .iter()
        .find(|n| n.instance_id.as_deref() == Some(id) || n.internal_ip.as_deref() == Some(id))
        .map(|n| ObjectLink { kind: "Node".into(), namespace: None, name: n.name.clone() })
}

#[cfg(test)]
mod tests;
