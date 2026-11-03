use serde_json::json;

use super::*;
use crate::k8s::rows::KindRef;

fn target(group: &str, version: &str, kind: &str, namespace: Option<&str>) -> ChangeObject {
    ChangeObject {
        kind: KindRef { group: group.into(), version: version.into(), kind: kind.into(), plural: format!("{}s", kind.to_lowercase()), namespaced: namespace.is_some() },
        namespace: namespace.map(Into::into),
        name: "sample".into(),
    }
}

fn deployment() -> Value {
    json!({
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {"name": "sample", "namespace": "default", "resourceVersion": "12", "uid": "u", "generation": 3, "creationTimestamp": "2026-01-01T00:00:00Z", "managedFields": [{}]},
        "spec": {"replicas": 3, "template": {"spec": {"containers": [{"name": "app", "image": "app:1"}]}}},
        "status": {"readyReplicas": 3}
    })
}

fn secret(data: Value) -> Value {
    json!({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "sample", "namespace": "default", "resourceVersion": "5"}, "data": data})
}

#[test]
fn body_drops_server_fields_and_pins_the_current_version() {
    let deploy = target("apps", "v1", "Deployment", Some("default"));
    let body = body(&deploy, &deployment(), Some(&deployment()), Some("14")).unwrap();
    assert_eq!(body["metadata"]["resourceVersion"], "14");
    assert!(body.get("status").is_none());
    for key in ["uid", "generation", "creationTimestamp", "managedFields"] {
        assert!(body["metadata"].get(key).is_none(), "{key}");
    }
    let created = super::body(&deploy, &deployment(), None, None).unwrap();
    assert!(created["metadata"].get("resourceVersion").is_none());
}

#[test]
fn body_follows_the_target_for_namespace_and_identity() {
    let deploy = target("apps", "v1", "Deployment", Some("team"));
    let mut object = deployment();
    object["metadata"].as_object_mut().unwrap().remove("namespace");
    assert_eq!(body(&deploy, &object, None, None).unwrap()["metadata"]["namespace"], "team");
    object["metadata"]["namespace"] = json!("other");
    assert!(body(&deploy, &object, None, None).is_err());
    let mut renamed = deployment();
    renamed["metadata"]["name"] = json!("another");
    assert!(body(&target("apps", "v1", "Deployment", Some("default")), &renamed, None, None).is_err());
    assert!(body(&target("apps", "v1", "StatefulSet", Some("default")), &deployment(), None, None).is_err());
    let cluster = target("", "v1", "Namespace", None);
    let namespace = json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "sample"}});
    assert!(body(&cluster, &namespace, None, None).is_ok());
    let mut namespaced = namespace.clone();
    namespaced["metadata"]["namespace"] = json!("default");
    assert!(body(&cluster, &namespaced, None, None).is_err());
}

#[test]
fn masked_secret_values_come_back_from_the_current_object() {
    let target = target("", "v1", "Secret", Some("default"));
    let current = secret(json!({"keep": "a2VlcA==", "other": "b3RoZXI="}));
    let edited = json!({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "sample"}, "data": {"keep": MASK}, "stringData": {"new": "fresh"}});
    let body = body(&target, &edited, Some(&current), Some("5")).unwrap();
    assert_eq!(body["data"]["keep"], "a2VlcA==");
    assert_eq!(body["stringData"]["new"], "fresh");
    assert!(body["data"].get("other").is_none());
    let unknown = json!({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "sample"}, "data": {"gone": MASK}});
    assert_eq!(body_error(&target, &unknown, &current), AppError::other(MASKED_VALUE_UNKNOWN));
    let literal = json!({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "sample"}, "stringData": {"key": MASK}});
    assert_eq!(body_error(&target, &literal, &current), AppError::other(MASKED_VALUE_UNKNOWN));
}

fn body_error(target: &ChangeObject, object: &Value, current: &Value) -> AppError {
    body(target, object, Some(current), Some("5")).unwrap_err()
}

#[test]
fn masked_last_applied_annotation_is_restored_or_dropped() {
    let target = target("", "v1", "Secret", Some("default"));
    let mut edited = json!({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "sample", "annotations": {LAST_APPLIED: MASK, "keep": "x"}}});
    let mut current = secret(json!({}));
    current["metadata"]["annotations"] = json!({LAST_APPLIED: "{\"data\":\"c2VjcmV0\"}"});
    assert_eq!(body(&target, &edited, Some(&current), Some("5")).unwrap()["metadata"]["annotations"][LAST_APPLIED], "{\"data\":\"c2VjcmV0\"}");
    current["metadata"].as_object_mut().unwrap().remove("annotations");
    let dropped = body(&target, &edited, Some(&current), Some("5")).unwrap();
    assert!(dropped["metadata"]["annotations"].get(LAST_APPLIED).is_none());
    assert_eq!(dropped["metadata"]["annotations"]["keep"], "x");
    edited["metadata"]["annotations"][LAST_APPLIED] = json!("real");
    assert_eq!(body(&target, &edited, Some(&current), Some("5")).unwrap()["metadata"]["annotations"][LAST_APPLIED], "real");
}

#[test]
fn diff_lists_only_changed_leaves_without_server_noise() {
    let deploy = target("apps", "v1", "Deployment", Some("default"));
    let mut result = deployment();
    result["spec"]["replicas"] = json!(5);
    result["spec"]["template"]["spec"]["containers"][0]["image"] = json!("app:2");
    result["metadata"]["resourceVersion"] = json!("13");
    result["metadata"]["generation"] = json!(4);
    result["metadata"]["labels"] = json!({"team": "a"});
    result["status"]["readyReplicas"] = json!(0);
    let diffs = diff(&deploy, Some(&deployment()), &result);
    let paths: Vec<&str> = diffs.iter().map(|d| d.path.as_str()).collect();
    assert_eq!(paths, ["metadata.labels", "spec.replicas", "spec.template.spec.containers[0].image"]);
    assert_eq!(diffs[1].before, 3);
    assert_eq!(diffs[1].after, 5);
    assert_eq!(diffs[0].before, Value::Null);
    assert!(diff(&deploy, Some(&deployment()), &deployment()).is_empty());
}

#[test]
fn arrays_of_different_length_are_compared_whole() {
    let deploy = target("apps", "v1", "Deployment", Some("default"));
    let mut result = deployment();
    result["spec"]["template"]["spec"]["containers"].as_array_mut().unwrap().push(json!({"name": "side", "image": "side:1"}));
    let diffs = diff(&deploy, Some(&deployment()), &result);
    assert_eq!(diffs.len(), 1);
    assert_eq!(diffs[0].path, "spec.template.spec.containers");
    assert_eq!(diffs[0].after.as_array().unwrap().len(), 2);
}

#[test]
fn creating_shows_the_whole_object_as_one_entry() {
    let deploy = target("apps", "v1", "Deployment", Some("default"));
    let diffs = diff(&deploy, None, &deployment());
    assert_eq!(diffs.len(), 1);
    assert_eq!(diffs[0].before, Value::Null);
    assert!(diffs[0].after.get("status").is_none());
}

#[test]
fn secret_diff_marks_changed_keys_without_any_value() {
    let target = target("", "v1", "Secret", Some("default"));
    let before = secret(json!({"same": "c2FtZQ==", "edit": "b2xk", "gone": "Z29uZQ=="}));
    let after = secret(json!({"same": "c2FtZQ==", "edit": "bmV3", "added": "YWRkZWQ="}));
    let diffs = diff(&target, Some(&before), &after);
    let text = serde_json::to_string(&diffs).unwrap();
    for leaked in ["c2FtZQ==", "b2xk", "bmV3", "Z29uZQ==", "YWRkZWQ="] {
        assert!(!text.contains(leaked), "{leaked}");
    }
    let by_path = |path: &str| diffs.iter().find(|d| d.path == path).unwrap_or_else(|| panic!("{path} 없음"));
    assert_eq!(by_path("data.edit").before, MASK);
    assert_eq!(by_path("data.edit").after, MASK_CHANGED);
    assert_eq!(by_path("data.gone").after, Value::Null);
    assert_eq!(by_path("data.added").before, Value::Null);
    assert_eq!(by_path("data.added").after, MASK);
    assert!(diffs.iter().all(|d| d.path != "data.same"));
    let created = serde_json::to_string(&diff(&target, None, &after)).unwrap();
    assert!(!created.contains("bmV3"));
}

fn conflict_status() -> Status {
    serde_json::from_value(json!({
        "kind": "Status",
        "status": "Failure",
        "message": "Apply failed with 2 conflicts",
        "reason": "Conflict",
        "code": 409,
        "details": {"causes": [
            {"reason": "FieldManagerConflict", "message": "conflict with \"kubectl-client-side-apply\" using apps/v1", "field": ".spec.replicas"},
            {"reason": "FieldManagerConflict", "message": "conflict with \"hpa\"", "field": ".spec.paused"},
            {"reason": "Other", "message": "무관", "field": ".spec.x"}
        ]}
    }))
    .unwrap()
}

#[test]
fn conflicts_name_the_field_and_its_owning_manager() {
    let conflicts = conflicts_of(&conflict_status());
    assert_eq!(
        conflicts,
        [
            FieldConflict { field: ".spec.replicas".into(), manager: "kubectl-client-side-apply".into() },
            FieldConflict { field: ".spec.paused".into(), manager: "hpa".into() },
        ]
    );
}

#[test]
fn optimistic_lock_conflicts_are_not_field_conflicts() {
    let stale: Status = serde_json::from_value(json!({"kind": "Status", "status": "Failure", "message": "the object has been modified", "reason": "Conflict", "code": 409, "details": {"name": "sample", "kind": "deployments"}})).unwrap();
    assert!(conflicts_of(&stale).is_empty());
}

#[test]
fn redacting_a_secret_change_keeps_no_value() {
    let target = target("", "v1", "Secret", Some("default"));
    let object = json!({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "sample"}, "data": {"a": "c2VjcmV0"}, "stringData": {"b": "plain-secret"}});
    let change = Change { target, operation: Operation::Apply { object, force: false } };
    let logged = serde_json::to_string(&redact(&change)).unwrap();
    assert!(!logged.contains("c2VjcmV0") && !logged.contains("plain-secret"));
    assert!(logged.contains("\"a\""));
    let plain = Change { target: target_of(&change), operation: Operation::Apply { object: deployment(), force: false } };
    assert_eq!(redact(&plain), plain);
}

fn target_of(change: &Change) -> ChangeObject {
    ChangeObject { kind: KindRef { group: "apps".into(), version: "v1".into(), kind: "Deployment".into(), plural: "deployments".into(), namespaced: true }, ..change.target.clone() }
}
