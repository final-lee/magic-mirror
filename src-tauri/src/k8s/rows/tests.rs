use kube::api::DynamicObject;

use super::*;

fn ns(name: &str, uid: &str, phase: &str) -> DynamicObject {
    serde_json::from_value(serde_json::json!({
        "apiVersion": "v1", "kind": "Namespace",
        "metadata": { "name": name, "uid": uid, "resourceVersion": "7", "creationTimestamp": "2026-10-30T01:02:03Z", "labels": { "team": "a" } },
        "status": { "phase": phase }
    }))
    .unwrap()
}

fn namespaces() -> KindRef {
    KindRef { group: "".into(), version: "v1".into(), kind: "Namespace".into(), plural: "namespaces".into(), namespaced: false }
}

#[test]
fn namespace_row() {
    let r = row_of(&namespaces(), &ns("ops", "u1", "Active"));
    assert_eq!((r.uid.as_str(), r.name.as_str(), r.namespace.as_deref()), ("u1", "ops", None));
    assert_eq!(r.resource_version, "7");
    assert_eq!(r.created_at.as_deref(), Some("2026-10-30T01:02:03Z"));
    assert_eq!(r.labels.get("team").map(String::as_str), Some("a"));
    assert_eq!(r.values.get("status").map(String::as_str), Some("Active"));
}

#[test]
fn fractional_seconds_are_dropped() {
    let mut o = ns("ops", "u1", "Active");
    o.metadata.creation_timestamp = Some(k8s_openapi::apimachinery::pkg::apis::meta::v1::Time("2026-10-30T01:02:03.987Z".parse().unwrap()));
    assert_eq!(row_of(&namespaces(), &o).created_at.as_deref(), Some("2026-10-30T01:02:03Z"));
}

#[test]
fn row_json_keys_match_the_ts_contract() {
    let v = serde_json::to_value(row_of(&namespaces(), &ns("ops", "u1", "Active"))).unwrap();
    assert_eq!(
        v,
        serde_json::json!({
            "uid": "u1", "name": "ops", "namespace": null, "resourceVersion": "7",
            "createdAt": "2026-10-30T01:02:03Z", "labels": { "team": "a" }, "values": { "status": "Active" }, "problems": []
        })
    );
}

#[test]
fn kind_ref_reads_camel_case() {
    let k: KindRef = serde_json::from_value(serde_json::json!({ "group": "apps", "version": "v1", "kind": "Deployment", "plural": "deployments", "namespaced": true })).unwrap();
    assert!(k.namespaced && k.plural == "deployments");
}

#[test]
fn row_carries_problems_from_values() {
    let pod: DynamicObject = serde_json::from_value(serde_json::json!({
        "apiVersion": "v1", "kind": "Pod", "metadata": { "name": "p", "uid": "u", "resourceVersion": "1" },
        "spec": { "containers": [{ "name": "a", "image": "x" }] }, "status": { "phase": "Pending" }
    }))
    .unwrap();
    let kind = KindRef { group: "".into(), version: "v1".into(), kind: "Pod".into(), plural: "pods".into(), namespaced: true };
    assert_eq!(row_of(&kind, &pod).problems, [crate::k8s::read::values::Problem::Pending]);
}
