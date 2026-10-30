use serde_json::json;

use super::*;

#[test]
fn next_minor_and_due_entries() {
    assert_eq!(next_minor("1.31"), Some("1.32".into()));
    assert_eq!(next_minor("v1.28.3-eks-1"), Some("1.29".into()));
    assert_eq!(next_minor("x"), None);
    let due31: Vec<&str> = due("1.31").iter().map(|r| r.kind).collect();
    assert_eq!(due31, ["FlowSchema", "PriorityLevelConfiguration"]);
    assert!(due("1.33").is_empty());
    assert_eq!(due("1.24").len(), 5);
}

#[test]
fn table_lists_through_a_newer_version_and_is_ordered() {
    for r in REMOVED {
        assert_ne!(format!("{}/{}", r.list_group, r.list_version), r.api_version, "{} {}", r.kind, r.removed_in);
    }
    assert!(REMOVED.windows(2).all(|w| minor(w[0].removed_in) <= minor(w[1].removed_in)));
}

fn minor(v: &str) -> u32 {
    v.split('.').nth(1).unwrap().parse().unwrap()
}

#[test]
fn uses_reads_managed_fields_and_last_applied() {
    let written_old = json!({ "metadata": { "managedFields": [{ "manager": "helm", "apiVersion": "flowcontrol.apiserver.k8s.io/v1beta3" }] } });
    assert!(uses(&written_old, "flowcontrol.apiserver.k8s.io/v1beta3"));
    let applied_old = json!({ "metadata": { "annotations": { "kubectl.kubernetes.io/last-applied-configuration": "{\"apiVersion\":\"batch/v1beta1\",\"kind\":\"CronJob\"}" } } });
    assert!(uses(&applied_old, "batch/v1beta1"));
    let new = json!({ "metadata": { "managedFields": [{ "apiVersion": "batch/v1" }], "annotations": { "kubectl.kubernetes.io/last-applied-configuration": "not json" } } });
    assert!(!uses(&new, "batch/v1beta1"));
}

#[test]
fn uses_of_builds_rows() {
    let r = &REMOVED[0];
    let o = |name: &str, api: &str| -> DynamicObject {
        serde_json::from_value(json!({ "apiVersion": "batch/v1", "kind": "CronJob", "metadata": { "name": name, "namespace": "ops", "managedFields": [{ "apiVersion": api }] } })).unwrap()
    };
    let got = uses_of(r, &[o("old", "batch/v1beta1"), o("new", "batch/v1")]);
    assert_eq!(
        got,
        [RemovedUse { kind: "CronJob".into(), api_version: "batch/v1beta1".into(), replacement: "batch/v1".into(), removed_in: "1.25".into(), namespace: Some("ops".into()), name: "old".into() }]
    );
}
