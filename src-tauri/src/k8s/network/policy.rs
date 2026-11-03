//! NetworkPolicy 목록·상세용 값. 실제로 막히는 트래픽은 계산하지 않고(설계의 범위 밖) 선택자와 규칙을 읽기 좋게 풀어 둔다.
use std::collections::HashMap;

use kube::api::DynamicObject;
use serde_json::Value;

use super::model::{IpBlock, NamespacePolicies, Peer, PolicyRule, PolicyView, PortRule};
use crate::k8s::read::values::{list, text};
use crate::k8s::rows::rfc3339_secs;

const INGRESS: &str = "Ingress";
const EGRESS: &str = "Egress";

/// 시스템 네임스페이스: 보안 점검의 기본 제외 대상과 같다(`kube-system`, `kube-public`, `kube-node-lease`, `amazon-*`)
pub fn is_system_namespace(name: &str) -> bool {
    matches!(name, "kube-system" | "kube-public" | "kube-node-lease") || name.starts_with("amazon-")
}

/// 레이블 셀렉터를 `app=web, tier in (a,b), !canary`꼴 글로 푼다. 아무것도 고르지 않는(모두 고르는) 셀렉터는 빈 문자열이다.
pub fn selector_text(selector: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(labels) = selector.get("matchLabels").and_then(Value::as_object) {
        let mut pairs: Vec<(&String, &str)> = labels.iter().map(|(k, v)| (k, v.as_str().unwrap_or(""))).collect();
        pairs.sort();
        parts.extend(pairs.into_iter().map(|(k, v)| format!("{k}={v}")));
    }
    for e in list(selector, "/matchExpressions") {
        let key = text(e, "/key").unwrap_or("");
        let values = list(e, "/values").iter().filter_map(Value::as_str).collect::<Vec<_>>().join(",");
        match text(e, "/operator").unwrap_or("") {
            "In" => parts.push(format!("{key} in ({values})")),
            "NotIn" => parts.push(format!("{key} notin ({values})")),
            "Exists" => parts.push(key.to_string()),
            "DoesNotExist" => parts.push(format!("!{key}")),
            other => parts.push(format!("{key} {other} ({values})")),
        }
    }
    parts.join(", ")
}

fn port_rule(p: &Value) -> PortRule {
    let port = match p.get("port") {
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    };
    PortRule { protocol: text(p, "/protocol").unwrap_or("TCP").to_string(), port, end_port: p.get("endPort").and_then(Value::as_i64) }
}

fn peer(p: &Value) -> Peer {
    let ip_block = p.get("ipBlock").map(|b| IpBlock {
        cidr: text(b, "/cidr").unwrap_or("").to_string(),
        except: list(b, "/except").iter().filter_map(Value::as_str).map(str::to_string).collect(),
    });
    Peer { pod_selector: p.get("podSelector").map(selector_text), namespace_selector: p.get("namespaceSelector").map(selector_text), ip_block }
}

/// `spec.ingress`/`spec.egress`. 대상 목록의 키는 ingress가 `from`, egress가 `to`다.
fn rules(spec_rules: &[Value], peers_key: &str) -> Vec<PolicyRule> {
    spec_rules
        .iter()
        .map(|r| PolicyRule {
            peers: list(r, &format!("/{peers_key}")).iter().map(peer).collect(),
            ports: list(r, "/ports").iter().map(port_rule).collect(),
        })
        .collect()
}

/// 정책이 다루는 방향. 비워 두면 쿠버네티스 기본값대로 Ingress는 늘, Egress는 egress 규칙이 하나라도 있을 때만 넣는다.
fn effective_types(d: &Value) -> Vec<String> {
    let given: Vec<String> = list(d, "/spec/policyTypes").iter().filter_map(Value::as_str).map(str::to_string).collect();
    if !given.is_empty() {
        return given;
    }
    let mut types = vec![INGRESS.to_string()];
    if !list(d, "/spec/egress").is_empty() {
        types.push(EGRESS.to_string());
    }
    types
}

pub fn policy_view(obj: &DynamicObject) -> PolicyView {
    let d = &obj.data;
    PolicyView {
        namespace: obj.metadata.namespace.clone().unwrap_or_default(),
        name: obj.metadata.name.clone().unwrap_or_default(),
        pod_selector: d.pointer("/spec/podSelector").map(selector_text).unwrap_or_default(),
        types: effective_types(d),
        ingress: rules(list(d, "/spec/ingress"), "from"),
        egress: rules(list(d, "/spec/egress"), "to"),
        created_at: obj.metadata.creation_timestamp.as_ref().map(|t| rfc3339_secs(&t.0)),
    }
}

/// 네임스페이스마다 NetworkPolicy가 몇 개인지. 목록에 없는 네임스페이스의 정책은 세지 않는다. 이름 순.
pub fn namespace_policies(namespaces: &[String], policies: &[PolicyView]) -> Vec<NamespacePolicies> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for p in policies {
        *counts.entry(p.namespace.as_str()).or_default() += 1;
    }
    let mut out: Vec<NamespacePolicies> = namespaces
        .iter()
        .map(|n| NamespacePolicies { name: n.clone(), policies: counts.get(n.as_str()).copied().unwrap_or(0), system: is_system_namespace(n) })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[cfg(test)]
mod tests;
