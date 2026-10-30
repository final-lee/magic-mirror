use serde_json::json;

use super::*;
use crate::k8s::read::secret::{secrets_kind, MASK};

fn deployments() -> KindRef {
    KindRef { group: "apps".into(), version: "v1".into(), kind: "Deployment".into(), plural: "deployments".into(), namespaced: true }
}

fn deployment() -> Value {
    json!({
        "status": { "readyReplicas": 1 },
        "spec": { "replicas": 1, "template": { "spec": { "containers": [{ "name": "app", "image": "nginx:1.27", "args": ["--port", "8080"] }] } } },
        "metadata": { "name": "web", "namespace": "prod", "managedFields": [{ "manager": "kubectl", "apiVersion": "apps/v1" }],
            "annotations": { "note": "line one\nline two: with colon" } },
        "kind": "Deployment",
        "apiVersion": "apps/v1"
    })
}

#[test]
fn drops_managed_fields_keeps_status_and_uses_kubectl_order() {
    let y = view_yaml(&deployments(), &deployment()).unwrap();
    assert!(!y.contains("managedFields"));
    let at = |k: &str| y.find(&format!("\n{k}:")).or_else(|| y.starts_with(&format!("{k}:")).then_some(0)).unwrap_or_else(|| panic!("{k} missing in\n{y}"));
    assert!(at("apiVersion") < at("kind") && at("kind") < at("metadata") && at("metadata") < at("spec") && at("spec") < at("status"), "{y}");
}

#[test]
fn round_trips_to_the_same_value() {
    let y = view_yaml(&deployments(), &deployment()).unwrap();
    let back: Value = serde_saphyr::from_str(&y).unwrap();
    let mut expected = deployment();
    expected["metadata"].as_object_mut().unwrap().remove("managedFields");
    assert_eq!(back, expected);
}

#[test]
fn secret_yaml_is_masked() {
    let s = json!({ "apiVersion": "v1", "kind": "Secret", "metadata": { "name": "db", "annotations": {
        "kubectl.kubernetes.io/last-applied-configuration": "{\"data\":{\"p\":\"aHVudGVyMg==\"}}" } },
        "data": { "p": "aHVudGVyMg==" } });
    let y = view_yaml(&secrets_kind(), &s).unwrap();
    assert!(y.contains(MASK));
    assert!(!y.contains("aHVudGVyMg==") && !y.contains("hunter2"), "{y}");
}

#[test]
fn other_kinds_are_not_masked() {
    let cm = KindRef { group: "".into(), version: "v1".into(), kind: "ConfigMap".into(), plural: "configmaps".into(), namespaced: true };
    let y = view_yaml(&cm, &json!({ "apiVersion": "v1", "kind": "ConfigMap", "metadata": { "name": "c" }, "data": { "k": "visible" } })).unwrap();
    assert!(y.contains("visible"));
}
