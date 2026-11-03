//! 시험용 조립 도구: RBAC 객체, 워크로드, 클러스터 값. 점검마다 시험이 같은 모양을 쓰게 한다.
use std::collections::BTreeMap;

use serde_json::Value;

use super::{CheckId, ClusterFacts, Finding, Workload, WorkloadKind};
use crate::k8s::access::engine::{evaluate, Evaluation, Principal};
use crate::k8s::access::rbac::{Binding, Rbac, Role, RoleKind, RoleRef, Rule, Subject};

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

pub fn rule(verbs: &[&str], groups: &[&str], resources: &[&str]) -> Rule {
    Rule { verbs: strings(verbs), api_groups: strings(groups), resources: strings(resources), resource_names: vec![], non_resource_urls: vec![] }
}

pub fn named(mut rule: Rule, names: &[&str]) -> Rule {
    rule.resource_names = strings(names);
    rule
}

pub fn cluster_role(name: &str, rules: Vec<Rule>) -> Role {
    Role { namespace: None, name: name.to_string(), rules, labels: BTreeMap::new(), aggregation: None }
}

pub fn role(namespace: &str, name: &str, rules: Vec<Rule>) -> Role {
    Role { namespace: Some(namespace.to_string()), name: name.to_string(), rules, labels: BTreeMap::new(), aggregation: None }
}

pub fn cluster_ref(name: &str) -> RoleRef {
    RoleRef { kind: RoleKind::ClusterRole, name: name.to_string() }
}

pub fn role_ref(name: &str) -> RoleRef {
    RoleRef { kind: RoleKind::Role, name: name.to_string() }
}

pub fn clusterbinding(name: &str, role: &str, subjects: Vec<Subject>) -> Binding {
    Binding { namespace: None, name: name.to_string(), role_ref: cluster_ref(role), subjects }
}

pub fn rolebinding(namespace: &str, name: &str, role_ref: RoleRef, subjects: Vec<Subject>) -> Binding {
    Binding { namespace: Some(namespace.to_string()), name: name.to_string(), role_ref, subjects }
}

/// 쿠버네티스 기본 ClusterRole을 줄여 본뜬 집합: `cluster-admin`은 `*`, `edit`은 Pod·Deployment 만들기와 Secret 읽기, `view`는 읽기
pub fn builtin_roles() -> Vec<Role> {
    vec![
        cluster_role("cluster-admin", vec![rule(&["*"], &["*"], &["*"])]),
        cluster_role(
            "edit",
            vec![
                rule(&["create", "update", "delete"], &[""], &["pods", "configmaps"]),
                rule(&["get", "list", "watch"], &[""], &["secrets", "pods"]),
                rule(&["create"], &["apps"], &["deployments"]),
            ],
        ),
        cluster_role("view", vec![rule(&["get", "list", "watch"], &[""], &["pods", "configmaps"])]),
    ]
}

/// 기본 ClusterRole에 `extra` ClusterRole을 더한 RBAC으로 계산한다
pub fn eval(extra: Vec<Role>, roles: Vec<Role>, bindings: Vec<Binding>, cluster_bindings: Vec<Binding>) -> Evaluation {
    eval_with(extra, roles, bindings, cluster_bindings, vec![])
}

pub fn eval_with(extra: Vec<Role>, roles: Vec<Role>, bindings: Vec<Binding>, cluster_bindings: Vec<Binding>, principals: Vec<Principal>) -> Evaluation {
    let mut cluster_roles = builtin_roles();
    cluster_roles.extend(extra);
    evaluate(Rbac { roles, cluster_roles, bindings, cluster_bindings }, principals)
}

pub fn user(name: &str) -> Subject {
    Subject::user(name)
}

pub fn sa(namespace: &str, name: &str) -> Subject {
    Subject::service_account(namespace, name)
}

/// 이 점검의 문제만
pub fn of(findings: &[Finding], check: CheckId) -> Vec<&Finding> {
    findings.iter().filter(|f| f.check == check).collect()
}

/// Pod 스펙(JSON)으로 워크로드를 만든다
pub fn workload(kind: WorkloadKind, namespace: &str, name: &str, spec: Value) -> Workload {
    Workload { kind, namespace: namespace.into(), name: name.into(), labels: BTreeMap::new(), annotations: BTreeMap::new(), spec: serde_json::from_value(spec).expect("Pod 스펙") }
}

pub fn deployment(namespace: &str, name: &str, spec: Value) -> Workload {
    workload(WorkloadKind::Deployment, namespace, name, spec)
}

/// 점검에 걸리는 것이 없는 클러스터
pub fn cluster() -> ClusterFacts {
    ClusterFacts {
        name: "prod".into(),
        version: "1.35".into(),
        endpoint_public: false,
        endpoint_private: true,
        public_cidrs: vec![],
        logging_enabled: ["api", "audit", "authenticator", "controllerManager", "scheduler"].iter().map(|s| s.to_string()).collect(),
        secrets_encrypted: true,
        created_at: Some(1_700_000_000),
    }
}
