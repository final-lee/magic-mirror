//! 권한 변경 시험의 공통 도구와 모듈 앞단(주체 검증, 어떤 변경을 받는지) 시험.
use serde_json::{json, Value};

use super::*;
// 아래 `fixtures`가 `super::rbac`로 읽는 RBAC 모델
use crate::k8s::access::rbac;

#[path = "../access/fixtures.rs"]
#[allow(clippy::duplicate_mod, dead_code)]
pub mod fixtures;

pub fn user(name: &str) -> SubjectSpec {
    SubjectSpec { kind: "User".into(), name: name.into(), namespace: None }
}

pub fn group(name: &str) -> SubjectSpec {
    SubjectSpec { kind: "Group".into(), name: name.into(), namespace: None }
}

pub fn sa(namespace: &str, name: &str) -> SubjectSpec {
    SubjectSpec { kind: "ServiceAccount".into(), name: name.into(), namespace: Some(namespace.into()) }
}

/// 서버에서 읽은 모양의 바인딩(서버 필드 포함). `namespace`가 None이면 ClusterRoleBinding.
pub fn binding(namespace: Option<&str>, name: &str, role_kind: &str, role: &str, subjects: &[SubjectSpec]) -> Value {
    let mut object = json!({
        "apiVersion": RBAC_API_VERSION,
        "kind": if namespace.is_some() { "RoleBinding" } else { "ClusterRoleBinding" },
        "metadata": {"name": name, "resourceVersion": "7", "uid": "uid-1", "creationTimestamp": "2024-01-01T00:00:00Z", "labels": {"team": "dev"}},
        "roleRef": {"apiGroup": RBAC_GROUP, "kind": role_kind, "name": role},
        "subjects": subjects.iter().map(SubjectSpec::to_value).collect::<Vec<_>>(),
    });
    if let Some(ns) = namespace {
        object["metadata"]["namespace"] = json!(ns);
    }
    object
}

pub fn target(namespace: Option<&str>, name: &str) -> ChangeObject {
    ChangeObject { kind: binding_kind(namespace.is_none()), namespace: namespace.map(str::to_string), name: name.into() }
}

pub fn change(namespace: Option<&str>, name: &str, operation: Operation) -> Change {
    Change { target: target(namespace, name), operation }
}

pub const ARN: &str = "arn:aws:iam::111122223333:role/dev";

pub fn entry_change(arn: &str, operation: Operation) -> Change {
    Change { target: ChangeObject { kind: access_entry_kind(), namespace: None, name: arn.into() }, operation }
}

#[test]
fn a_service_account_subject_needs_a_namespace_and_every_subject_a_known_kind_and_a_clean_name() {
    assert!(sa("dev", "web").validate().is_ok());
    assert!(user("alice").validate().is_ok());
    assert!(group("devs").validate().is_ok());
    assert!(SubjectSpec { namespace: None, ..sa("dev", "web") }.validate().is_err());
    assert!(SubjectSpec { namespace: Some(" ".into()), ..sa("dev", "web") }.validate().is_err());
    assert!(SubjectSpec { kind: "Robot".into(), ..user("alice") }.validate().is_err());
    assert!(user("").validate().is_err());
    assert!(user(" alice").validate().is_err());
}

#[test]
fn subjects_compare_by_kind_and_name_and_only_service_accounts_by_namespace() {
    assert_eq!(user("a").key(), SubjectSpec { namespace: Some("ignored".into()), ..user("a") }.key());
    assert_ne!(user("a").key(), group("a").key());
    assert_ne!(sa("dev", "a").key(), sa("prod", "a").key());
}

#[test]
fn user_and_group_subjects_are_written_with_an_api_group_and_service_accounts_with_a_namespace() {
    assert_eq!(user("alice").to_value(), json!({"apiGroup": RBAC_GROUP, "kind": "User", "name": "alice"}));
    assert_eq!(sa("dev", "web").to_value(), json!({"kind": "ServiceAccount", "name": "web", "namespace": "dev"}));
    assert_eq!(SubjectSpec::from_value(&sa("dev", "web").to_value()), Some(sa("dev", "web")));
    assert_eq!(SubjectSpec::from_value(&json!({"kind": "Robot", "name": "x"})), None);
}

#[test]
fn namespace_scopes_need_at_least_one_namespace() {
    assert!(ScopeSpec::Cluster.validate().is_ok());
    assert!(ScopeSpec::Namespaces { namespaces: vec!["dev".into()] }.validate().is_ok());
    assert!(ScopeSpec::Namespaces { namespaces: vec![] }.validate().is_err());
    assert!(ScopeSpec::Namespaces { namespaces: vec!["".into()] }.validate().is_err());
}

#[test]
fn the_module_plans_binding_changes_and_access_entry_changes_and_leaves_workload_changes_alone() {
    assert!(handles(&change(Some("dev"), "b", Operation::BindingSubjects { add: vec![], remove: vec![] })));
    assert!(handles(&change(None, "b", Operation::BindingCreate { object: json!({}) })));
    assert!(handles(&entry_change(ARN, Operation::AccessEntryDelete)));
    // 바인딩을 지우는 공통 삭제도 여기서 계획한다(영향 계산과 위험 판단이 필요하다)
    assert!(handles(&change(Some("dev"), "b", Operation::Delete)));
    assert!(!handles(&change(Some("dev"), "b", Operation::Restart)));
    let deployment = ChangeObject { kind: KindRef { group: "apps".into(), version: "v1".into(), kind: "Deployment".into(), plural: "deployments".into(), namespaced: true }, namespace: Some("dev".into()), name: "web".into() };
    assert!(!handles(&Change { target: deployment, operation: Operation::Delete }));
}

#[test]
fn only_access_entry_changes_go_to_eks() {
    assert!(is_eks(&entry_change(ARN, Operation::AccessEntryDelete)));
    assert!(!is_eks(&change(None, "b", Operation::Delete)));
}

#[test]
fn changes_survive_the_wire_format_the_frontend_sends() {
    let wire = json!({
        "kind": {"group": RBAC_GROUP, "version": "v1", "kind": "RoleBinding", "plural": "rolebindings", "namespaced": true},
        "namespace": "dev", "name": "b", "type": "bindingSubjects",
        "add": [{"kind": "ServiceAccount", "name": "web", "namespace": "dev"}], "remove": [{"kind": "User", "name": "alice"}],
    });
    let parsed: Change = serde_json::from_value(wire).unwrap();
    assert_eq!(parsed.operation, Operation::BindingSubjects { add: vec![sa("dev", "web")], remove: vec![user("alice")] });
    let entry = json!({
        "kind": {"group": "eks.amazonaws.com", "version": "v1", "kind": "AccessEntry", "plural": "accessentries", "namespaced": false},
        "namespace": null, "name": ARN, "type": "accessEntryCreate", "groups": ["devs"],
        "policies": [{"policyArn": "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy", "scope": {"kind": "namespaces", "namespaces": ["dev"]}}],
    });
    let parsed: Change = serde_json::from_value(entry).unwrap();
    assert!(matches!(&parsed.operation, Operation::AccessEntryCreate { username: None, entry_type: None, policies, .. } if policies.len() == 1));
    let back = serde_json::to_value(&parsed).unwrap();
    assert_eq!(back["type"], "accessEntryCreate");
    assert_eq!(back["policies"][0]["scope"], json!({"kind": "namespaces", "namespaces": ["dev"]}));
}
