//! 시험용 RBAC 조립 도구와, 쿠버네티스 기본 ClusterRole(view·edit·admin·cluster-admin)을 본뜬 집합.
use std::collections::BTreeMap;

use super::rbac::{Binding, Rbac, Requirement, Role, RoleKind, RoleRef, Rule, Selector, Subject};

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

pub fn urls(verbs: &[&str], urls: &[&str]) -> Rule {
    Rule { verbs: strings(verbs), non_resource_urls: strings(urls), ..Rule::default() }
}

pub fn cluster_role(name: &str, rules: Vec<Rule>) -> Role {
    Role { namespace: None, name: name.to_string(), rules, labels: BTreeMap::new(), aggregation: None }
}

pub fn labeled(mut role: Role, key: &str, value: &str) -> Role {
    role.labels.insert(key.to_string(), value.to_string());
    role
}

/// `matchLabels` 선택자 하나로 합치는 ClusterRole
pub fn aggregate(name: &str, key: &str, value: &str) -> Role {
    let selector = Selector { match_labels: BTreeMap::from([(key.to_string(), value.to_string())]), match_expressions: vec![] };
    Role { namespace: None, name: name.to_string(), rules: vec![], labels: BTreeMap::new(), aggregation: Some(vec![selector]) }
}

pub fn expression(key: &str, operator: &str, values: &[&str]) -> Selector {
    Selector { match_labels: BTreeMap::new(), match_expressions: vec![Requirement { key: key.to_string(), operator: operator.to_string(), values: strings(values) }] }
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

pub fn rolebinding(namespace: &str, name: &str, role_ref: RoleRef, subjects: Vec<Subject>) -> Binding {
    Binding { namespace: Some(namespace.to_string()), name: name.to_string(), role_ref, subjects }
}

pub fn clusterbinding(name: &str, role: &str, subjects: Vec<Subject>) -> Binding {
    Binding { namespace: None, name: name.to_string(), role_ref: cluster_ref(role), subjects }
}

/// 쿠버네티스의 기본 집합과 같은 모양: `view`·`edit`·`admin`은 `aggregate-to-*` 라벨로 합친 것이고, `cluster-admin`은 `*`다.
/// 규칙은 시험에 필요한 만큼으로 줄였다(Secret은 `view`에 없고 `edit`·`admin`에 있다, `pods/exec`는 `edit`부터).
pub fn builtin_roles() -> Vec<Role> {
    let aggregated = |name: &str| aggregate(name, &format!("rbac.authorization.k8s.io/aggregate-to-{name}"), "true");
    let to = |name: &str, role: &str, rules: Vec<Rule>| labeled(cluster_role(role, rules), &format!("rbac.authorization.k8s.io/aggregate-to-{name}"), "true");
    // 실제 기본 집합처럼 view는 edit에, edit는 admin에 다시 합쳐진다(여러 단계 aggregation)
    let view = labeled(labeled(aggregated("view"), "rbac.authorization.k8s.io/aggregate-to-edit", "true"), "rbac.authorization.k8s.io/aggregate-to-admin", "true");
    let edit = labeled(aggregated("edit"), "rbac.authorization.k8s.io/aggregate-to-admin", "true");
    let admin = aggregated("admin");
    vec![
        cluster_role("cluster-admin", vec![rule(&["*"], &["*"], &["*"]), urls(&["*"], &["*"])]),
        view,
        edit,
        admin,
        to("view", "system:aggregate-to-view", vec![rule(&["get", "list", "watch"], &[""], &["pods", "services", "configmaps", "persistentvolumeclaims", "endpoints", "pods/log"]), rule(&["get", "list", "watch"], &["apps"], &["deployments", "statefulsets", "daemonsets", "replicasets"]), rule(&["get", "list", "watch"], &["batch"], &["jobs", "cronjobs"]), rule(&["get", "list", "watch"], &["networking.k8s.io"], &["ingresses"])]),
        to(
            "edit",
            "system:aggregate-to-edit",
            vec![
                rule(&["create", "update", "patch", "delete", "deletecollection"], &[""], &["pods", "services", "configmaps", "persistentvolumeclaims", "secrets"]),
                rule(&["get", "list", "watch"], &[""], &["secrets"]),
                rule(&["create"], &[""], &["pods/exec", "pods/attach", "pods/portforward"]),
                rule(&["create", "update", "patch", "delete", "deletecollection"], &["apps"], &["deployments", "statefulsets", "daemonsets"]),
                rule(&["create", "update", "patch", "delete", "deletecollection"], &["batch"], &["jobs", "cronjobs"]),
                rule(&["create", "update", "patch", "delete", "deletecollection"], &["networking.k8s.io"], &["ingresses"]),
            ],
        ),
        to("admin", "system:aggregate-to-admin", vec![rule(&["create", "update", "patch", "delete"], &["rbac.authorization.k8s.io"], &["roles", "rolebindings"])]),
    ]
}

pub fn rbac_with(extra_roles: Vec<Role>, roles: Vec<Role>, bindings: Vec<Binding>, cluster_bindings: Vec<Binding>) -> Rbac {
    let mut cluster_roles = builtin_roles();
    cluster_roles.extend(extra_roles);
    Rbac { roles, cluster_roles, bindings, cluster_bindings }
}
