use serde_json::json;

use super::*;
use crate::k8s::rbac::tests::{binding, change, group, sa, user};

fn subjects_op(add: Vec<SubjectSpec>, remove: Vec<SubjectSpec>) -> Operation {
    Operation::BindingSubjects { add, remove }
}

fn minimal(namespace: Option<&str>, name: &str, role_kind: &str, role: &str, subjects: &[SubjectSpec]) -> Value {
    clean_object(binding(namespace, name, role_kind, role, subjects))
}

#[test]
fn creating_a_role_binding_posts_to_its_namespace_collection_and_undoes_by_deleting_it() {
    let object = minimal(Some("dev"), "devs-view", "ClusterRole", "view", &[group("devs")]);
    let c = change(Some("dev"), "devs-view", Operation::BindingCreate { object: object.clone() });
    let (plan, next) = plan_binding(&c, None).unwrap();
    let call = &plan.preview.calls[0];
    assert_eq!((call.verb.as_str(), call.path.as_str()), ("POST", "/apis/rbac.authorization.k8s.io/v1/namespaces/dev/rolebindings"));
    assert_eq!(call.body, object);
    assert_eq!(plan.inverse, Some(change(Some("dev"), "devs-view", Operation::Delete)));
    assert!(plan.preview.reversible);
    // 이어지는 변경이 볼 수 있게 만든 뒤의 객체에는 가짜 버전이 달려 있다(요청 본문에는 없다)
    assert_eq!(next.clone().map(clean_object), Some(object));
    assert_eq!(next.unwrap()["metadata"]["resourceVersion"], "0");
    assert!(plan.preview.calls[0].body["metadata"].get("resourceVersion").is_none());
    assert_eq!(plan.version, None);
}

#[test]
fn a_cluster_role_binding_goes_to_the_cluster_collection() {
    let object = minimal(None, "ops-admin", "ClusterRole", "admin", &[user("alice")]);
    let (plan, _) = plan_binding(&change(None, "ops-admin", Operation::BindingCreate { object }), None).unwrap();
    assert_eq!(plan.preview.calls[0].path, "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings");
}

#[test]
fn a_missing_namespace_in_the_object_is_filled_from_the_target() {
    let mut object = minimal(Some("dev"), "b", "ClusterRole", "view", &[user("alice")]);
    object["metadata"].as_object_mut().unwrap().remove("namespace");
    let (plan, _) = plan_binding(&change(Some("dev"), "b", Operation::BindingCreate { object }), None).unwrap();
    assert_eq!(plan.preview.calls[0].body["metadata"]["namespace"], "dev");
}

#[test]
fn creating_over_an_existing_binding_or_with_a_bad_object_is_refused() {
    let object = minimal(Some("dev"), "b", "ClusterRole", "view", &[user("alice")]);
    let existing = binding(Some("dev"), "b", "ClusterRole", "view", &[]);
    let c = change(Some("dev"), "b", Operation::BindingCreate { object: object.clone() });
    assert_eq!(plan_binding(&c, Some(&existing)).unwrap_err(), AppError::other(BINDING_EXISTS));
    let renamed = change(Some("dev"), "other", Operation::BindingCreate { object: object.clone() });
    assert_eq!(plan_binding(&renamed, None).unwrap_err(), AppError::other(INVALID_BINDING));
    // 다른 네임스페이스의 객체
    let elsewhere = change(Some("prod"), "b", Operation::BindingCreate { object });
    assert_eq!(plan_binding(&elsewhere, None).unwrap_err(), AppError::other(INVALID_BINDING));
}

#[test]
fn role_refs_and_subjects_are_validated_before_anything_is_sent() {
    let bad_role = |kind: &str, name: &str, namespace: Option<&str>| {
        let object = minimal(namespace, "b", kind, name, &[user("alice")]);
        plan_binding(&change(namespace, "b", Operation::BindingCreate { object }), None)
    };
    // ClusterRoleBinding은 ClusterRole만 가리킬 수 있다
    assert!(bad_role("Role", "r", None).is_err());
    assert!(bad_role("Role", "r", Some("dev")).is_ok());
    assert!(bad_role("ClusterRole", "", Some("dev")).is_err());
    assert!(bad_role("Secret", "r", Some("dev")).is_err());
    let mut no_namespace = minimal(Some("dev"), "b", "ClusterRole", "view", &[]);
    no_namespace["subjects"] = json!([{"kind": "ServiceAccount", "name": "web"}]);
    assert!(plan_binding(&change(Some("dev"), "b", Operation::BindingCreate { object: no_namespace }), None).is_err());
}

#[test]
fn a_binding_without_subjects_warns_that_it_applies_to_nobody() {
    let object = minimal(Some("dev"), "b", "ClusterRole", "view", &[]);
    let (plan, _) = plan_binding(&change(Some("dev"), "b", Operation::BindingCreate { object }), None).unwrap();
    assert_eq!(plan.preview.warnings, vec![EMPTY_SUBJECTS_WARNING.to_string()]);
}

#[test]
fn a_target_that_does_not_match_its_kind_is_invalid() {
    let object = minimal(None, "b", "ClusterRole", "view", &[user("alice")]);
    // ClusterRoleBinding인데 네임스페이스를 달았다
    let mut c = change(None, "b", Operation::BindingCreate { object });
    c.target.namespace = Some("dev".into());
    assert_eq!(plan_binding(&c, None).unwrap_err(), AppError::other(INVALID_CHANGE));
    let mut unnamed = change(Some("dev"), "", Operation::Delete);
    unnamed.target.name.clear();
    assert!(plan_binding(&unnamed, None).is_err());
}

#[test]
fn removing_a_binding_logs_the_whole_original_object_so_undo_recreates_it() {
    let original = binding(Some("dev"), "devs-view", "ClusterRole", "view", &[group("devs"), sa("dev", "web")]);
    let c = change(Some("dev"), "devs-view", Operation::Delete);
    let (plan, next) = plan_binding(&c, Some(&original)).unwrap();
    let call = &plan.preview.calls[0];
    assert_eq!((call.verb.as_str(), call.path.as_str()), ("DELETE", "/apis/rbac.authorization.k8s.io/v1/namespaces/dev/rolebindings/devs-view"));
    assert_eq!(call.body, json!({"preconditions": {"resourceVersion": "7"}}));
    assert_eq!(next, None);
    assert_eq!(plan.version.as_deref(), Some("7"));
    // 되돌리기는 서버가 채운 필드만 뺀 원본 전체(라벨·roleRef·모든 주체)를 다시 만든다
    let inverse = plan.inverse.unwrap();
    assert_eq!(inverse.operation, Operation::BindingCreate { object: clean_object(original.clone()) });
    let Operation::BindingCreate { object } = inverse.operation else { unreachable!() };
    assert_eq!(object["metadata"]["labels"], json!({"team": "dev"}));
    assert!(object["metadata"].get("uid").is_none() && object["metadata"].get("resourceVersion").is_none());
    assert_eq!(object["subjects"].as_array().unwrap().len(), 2);
    // 그 되돌리기는 다시 계획할 수 있고 그것을 되돌리면 다시 지우기다
    let (again, _) = plan_binding(&inverse_change(&c, &original), None).unwrap();
    assert_eq!(again.inverse, Some(change(Some("dev"), "devs-view", Operation::Delete)));
}

fn inverse_change(c: &Change, original: &Value) -> Change {
    Change { target: c.target.clone(), operation: Operation::BindingCreate { object: clean_object(original.clone()) } }
}

#[test]
fn removing_a_binding_that_is_gone_or_a_different_kind_is_refused() {
    let c = change(Some("dev"), "b", Operation::Delete);
    assert_eq!(plan_binding(&c, None).unwrap_err(), AppError::other(BINDING_MISSING));
    let mut other_name = binding(Some("dev"), "x", "ClusterRole", "view", &[]);
    assert_eq!(plan_binding(&c, Some(&other_name)).unwrap_err(), AppError::other(INVALID_CHANGE));
    other_name["metadata"].as_object_mut().unwrap().remove("resourceVersion");
    assert_eq!(plan_binding(&c, Some(&other_name)).unwrap_err(), AppError::other(MISSING_VERSION));
}

#[test]
fn a_binding_with_an_owner_is_not_recreated_by_undo() {
    let mut original = binding(Some("dev"), "b", "ClusterRole", "view", &[user("alice")]);
    original["metadata"]["ownerReferences"] = json!([{"apiVersion": "v1", "kind": "ConfigMap", "name": "owner", "uid": "u"}]);
    let (plan, _) = plan_binding(&change(Some("dev"), "b", Operation::Delete), Some(&original)).unwrap();
    assert_eq!(plan.inverse, None);
    assert!(!plan.preview.reversible);
    assert!(plan.preview.warnings.contains(&OWNER_WARNING.to_string()));
}

#[test]
fn a_system_default_binding_warns_that_the_api_server_may_recreate_it() {
    let original = binding(None, "system:basic-user", "ClusterRole", "system:basic-user", &[group("system:authenticated")]);
    let (plan, _) = plan_binding(&change(None, "system:basic-user", Operation::Delete), Some(&original)).unwrap();
    assert!(plan.preview.warnings.contains(&SYSTEM_BINDING_WARNING.to_string()));
}

#[test]
fn editing_subjects_patches_the_whole_list_under_the_current_version_and_shows_each_change() {
    let original = binding(Some("dev"), "b", "ClusterRole", "view", &[user("alice"), group("devs")]);
    let c = change(Some("dev"), "b", subjects_op(vec![sa("dev", "web")], vec![user("alice")]));
    let (plan, next) = plan_binding(&c, Some(&original)).unwrap();
    let call = &plan.preview.calls[0];
    assert_eq!((call.verb.as_str(), call.path.as_str()), ("PATCH", "/apis/rbac.authorization.k8s.io/v1/namespaces/dev/rolebindings/b"));
    assert_eq!(call.body, json!({"metadata": {"resourceVersion": "7"}, "subjects": [group("devs").to_value(), sa("dev", "web").to_value()]}));
    let paths: Vec<(&str, bool)> = plan.preview.diff.iter().map(|d| (d.path.as_str(), d.after.is_null())).collect();
    assert_eq!(paths, vec![("subjects[-]", true), ("subjects[+]", false)]);
    assert_eq!(next.unwrap()["subjects"], json!([group("devs").to_value(), sa("dev", "web").to_value()]));
}

#[test]
fn undoing_a_subject_edit_swaps_what_was_actually_added_and_removed() {
    let original = binding(Some("dev"), "b", "ClusterRole", "view", &[user("alice")]);
    // devs는 이미 없고 alice는 이미 있다: 실제로 바뀐 것만 되돌린다
    let c = change(Some("dev"), "b", subjects_op(vec![group("devs"), user("alice")], vec![group("ghost")]));
    let (plan, _) = plan_binding(&c, Some(&original)).unwrap();
    assert_eq!(plan.inverse, Some(change(Some("dev"), "b", subjects_op(vec![], vec![group("devs")]))));
    // 빼는 쪽: 있던 주체만 되돌릴 때 다시 더한다
    let c = change(Some("dev"), "b", subjects_op(vec![], vec![user("alice"), user("nobody")]));
    let (plan, _) = plan_binding(&c, Some(&original)).unwrap();
    assert_eq!(plan.inverse, Some(change(Some("dev"), "b", subjects_op(vec![user("alice")], vec![]))));
}

#[test]
fn an_edit_that_changes_nothing_warns_and_has_nothing_to_undo() {
    let original = binding(Some("dev"), "b", "ClusterRole", "view", &[user("alice")]);
    let c = change(Some("dev"), "b", subjects_op(vec![user("alice")], vec![user("ghost")]));
    let (plan, _) = plan_binding(&c, Some(&original)).unwrap();
    assert!(plan.preview.diff.is_empty());
    assert_eq!(plan.preview.warnings, vec![NOOP_WARNING.to_string()]);
    assert_eq!(plan.inverse, None);
    assert!(!plan.preview.reversible);
}

#[test]
fn removing_and_adding_the_same_subject_in_one_edit_changes_nothing() {
    let original = binding(Some("dev"), "b", "ClusterRole", "view", &[user("alice")]);
    let (plan, _) = plan_binding(&change(Some("dev"), "b", subjects_op(vec![user("alice")], vec![user("alice")])), Some(&original)).unwrap();
    assert!(plan.preview.diff.is_empty());
}

#[test]
fn removing_the_last_subject_warns_and_unknown_subject_kinds_are_left_alone() {
    let mut original = binding(Some("dev"), "b", "ClusterRole", "view", &[user("alice")]);
    original["subjects"].as_array_mut().unwrap().push(json!({"kind": "Robot", "name": "r2"}));
    let (plan, next) = plan_binding(&change(Some("dev"), "b", subjects_op(vec![], vec![user("alice")])), Some(&original)).unwrap();
    // Robot은 알 수 없는 종류라 그대로 남는다
    assert_eq!(next.unwrap()["subjects"], json!([{"kind": "Robot", "name": "r2"}]));
    assert!(!plan.preview.warnings.contains(&EMPTY_SUBJECTS_WARNING.to_string()));
    let only = binding(Some("dev"), "b", "ClusterRole", "view", &[user("alice")]);
    let (plan, _) = plan_binding(&change(Some("dev"), "b", subjects_op(vec![], vec![user("alice")])), Some(&only)).unwrap();
    assert!(plan.preview.warnings.contains(&EMPTY_SUBJECTS_WARNING.to_string()));
}

#[test]
fn a_subject_edit_is_refused_for_bad_subjects_or_a_missing_binding() {
    let original = binding(Some("dev"), "b", "ClusterRole", "view", &[]);
    let bad = change(Some("dev"), "b", subjects_op(vec![SubjectSpec { namespace: None, ..sa("dev", "web") }], vec![]));
    assert_eq!(plan_binding(&bad, Some(&original)).unwrap_err(), AppError::other(crate::k8s::rbac::INVALID_SUBJECT));
    let c = change(Some("dev"), "b", subjects_op(vec![user("a")], vec![]));
    assert_eq!(plan_binding(&c, None).unwrap_err(), AppError::other(BINDING_MISSING));
}
