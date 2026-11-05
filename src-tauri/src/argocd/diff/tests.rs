use serde_json::json;

use super::*;

fn item(live: &Value, predicted: Option<&Value>, target: Option<&Value>) -> Value {
    let s = |v: Option<&Value>| v.map_or("null".to_owned(), |v| v.to_string());
    json!({"group": "apps", "kind": "Deployment", "namespace": "web", "name": "api", "normalizedLiveState": live.to_string(), "predictedLiveState": s(predicted), "targetState": s(target)})
}

fn deployment(replicas: i64) -> Value {
    json!({"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": "api", "namespace": "web"}, "spec": {"replicas": replicas}})
}

#[test]
fn managed_diff_prefers_predicted_state_and_falls_back_to_target() {
    let live = deployment(2);
    let d = managed_diff(&item(&live, Some(&deployment(3)), Some(&deployment(5)))).unwrap();
    assert!(d.changed);
    assert!(d.target.contains("replicas: 3"));

    let d = managed_diff(&item(&live, None, Some(&deployment(5)))).unwrap();
    assert!(d.target.contains("replicas: 5"));
    assert_eq!((d.diff.stats.changed, d.diff.stats.added, d.diff.stats.removed), (1, 0, 0));
}

#[test]
fn managed_diff_detects_unchanged_regardless_of_key_order() {
    let reordered: Value = serde_json::from_str(r#"{"spec":{"replicas":2},"metadata":{"namespace":"web","name":"api"},"kind":"Deployment","apiVersion":"apps/v1"}"#).unwrap();
    let d = managed_diff(&item(&deployment(2), Some(&reordered), None)).unwrap();
    assert!(!d.changed);
    assert_eq!(d.live, d.target);
}

#[test]
fn managed_diff_treats_missing_sides_as_empty() {
    let created = managed_diff(&item(&Value::Null, Some(&deployment(1)), None)).unwrap();
    assert!(created.changed && created.live.is_empty() && created.diff.stats.added > 0);
    let pruned = managed_diff(&item(&deployment(1), None, None)).unwrap();
    assert!(pruned.changed && pruned.target.is_empty() && pruned.diff.stats.removed > 0);
}

#[test]
fn secret_values_are_hidden_but_changes_stay_visible() {
    let secret = |a: &str, b: &str| json!({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "s", "managedFields": [{"x": 1}], "annotations": {LAST_APPLIED: "{\"data\":{\"a\":\"c2VjcmV0\"}}"}}, "data": {"a": a, "b": b}});
    let d = managed_diff(&item(&secret("c2VjcmV0", "same"), Some(&secret("bmV3", "same")), None)).unwrap();
    for text in [&d.live, &d.target] {
        assert!(!text.contains("c2VjcmV0") && !text.contains("bmV3") && !text.contains("managedFields") && !text.contains("last-applied"));
    }
    assert!(d.changed);
    let flat = |text: &str| text.replace(['\'', '"'], "");
    assert!(flat(&d.live).contains("b: ********") && flat(&d.target).contains("b: ********"));
    assert!(flat(&d.live).contains("a: ********") && flat(&d.target).contains("a: ++++++++"));
    assert!(!display_yaml(secret("c2VjcmV0", "x")).unwrap().contains("c2VjcmV0"));
}

#[test]
fn find_item_matches_cluster_scoped_and_namespaced_resources() {
    let body = json!({"items": [
        {"group": "", "kind": "Namespace", "namespace": "", "name": "web"},
        {"group": "apps", "kind": "Deployment", "namespace": "web", "name": "web"},
    ]});
    let res = |group: &str, kind: &str, namespace: Option<&str>| ResRef {
        group: group.into(),
        version: "v1".into(),
        kind: kind.into(),
        namespace: namespace.map(str::to_owned),
        name: "web".into(),
        uid: None,
    };
    assert_eq!(find_item(&body, &res("", "Namespace", None)).unwrap()["kind"], "Namespace");
    assert_eq!(find_item(&body, &res("apps", "Deployment", Some("web"))).unwrap()["kind"], "Deployment");
    assert!(find_item(&body, &res("apps", "Deployment", Some("other"))).is_none());
}

#[test]
fn app_diff_joins_status_and_sorts_by_kind_namespace_name() {
    let config_map = json!({"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "a"}});
    let managed = json!({"items": [
        {"group": "apps", "kind": "Deployment", "namespace": "web", "name": "b", "normalizedLiveState": deployment(1).to_string(), "predictedLiveState": deployment(2).to_string(), "targetState": "null"},
        {"group": "", "kind": "ConfigMap", "namespace": "web", "name": "a", "normalizedLiveState": "null", "predictedLiveState": "null", "targetState": config_map.to_string()},
    ]});
    let app = json!({"status": {"resources": [
        {"group": "apps", "version": "v1", "kind": "Deployment", "namespace": "web", "name": "b", "status": "OutOfSync", "health": {"status": "Healthy"}},
    ]}});
    let rows = app_diff(&managed, &app).unwrap();
    assert_eq!(rows.iter().map(|r| r.res.kind.as_str()).collect::<Vec<_>>(), ["ConfigMap", "Deployment"]);
    assert_eq!(rows[0].res.version, "v1");
    assert_eq!(rows[0].sync_status, None);
    assert!(rows[0].changed);
    assert_eq!(
        (rows[1].sync_status.as_deref(), rows[1].health.as_deref(), rows[1].res.version.as_str()),
        (Some("OutOfSync"), Some("Healthy"), "v1")
    );
}

#[test]
fn manifests_are_sorted_and_joined_for_comparison() {
    let manifest = |kind: &str, name: &str, value: i64| json!({"apiVersion": "v1", "kind": kind, "metadata": {"name": name}, "data": {"n": value}}).to_string();
    let from = json!({"manifests": [manifest("Service", "a", 1), manifest("ConfigMap", "z", 1), manifest("ConfigMap", "b", 1)]});
    let text = manifests_text(&from).unwrap();
    let order: Vec<_> = text
        .split("---\n")
        .map(|doc| (doc.contains("ConfigMap"), doc.contains("name: z"), doc.contains("name: b")))
        .collect();
    assert_eq!(order, [(true, false, true), (true, true, false), (false, false, false)]);

    let to = json!({"manifests": [manifest("ConfigMap", "b", 1), manifest("ConfigMap", "z", 2), manifest("Service", "a", 1)]});
    let d = manifests_diff(&from, &to).unwrap();
    assert_eq!((d.stats.changed, d.stats.added, d.stats.removed), (1, 0, 0));
    assert!(manifests_text(&json!({"manifests": ["not json"]})).is_err());
}

#[test]
fn waves_read_annotation_with_default_zero_and_hook_kind() {
    let manifest =
        |name: &str, annotations: Value| json!({"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": name, "namespace": "web", "annotations": annotations}}).to_string();
    let waves = waves_of(&json!({"manifests": [
        manifest("migrate", json!({"argocd.argoproj.io/sync-wave": "-1", "argocd.argoproj.io/hook": "PreSync"})),
        manifest("plain", json!({})),
        manifest("bad", json!({"argocd.argoproj.io/sync-wave": "soon"})),
    ]}));
    assert_eq!(
        waves.iter().map(|w| (w.name.as_str(), w.wave, w.hook.as_deref())).collect::<Vec<_>>(),
        [("migrate", -1, Some("PreSync")), ("plain", 0, None), ("bad", 0, None)]
    );
    assert_eq!(waves[0].group, "batch");
}

#[test]
fn historical_secrets_hide_annotations_and_detect_value_changes() {
    let secret = |value: &str| json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"credentials","namespace":"demo","annotations":{"kubectl.kubernetes.io/last-applied-configuration":format!("embedded-{value}")}},"data":{"a/b":value}});
    let from = json!({"manifests":[secret("old-private").to_string()]});
    let to = json!({"manifests":[secret("new-private").to_string()]});
    let text = manifests_text(&from).unwrap();
    assert!(!text.contains("old-private"));
    assert!(!text.contains("last-applied"));
    let diff = manifests_diff(&from, &to).unwrap();
    let rendered = serde_json::to_string(&diff).unwrap();
    assert!(!rendered.contains("old-private"));
    assert!(!rendered.contains("new-private"));
    assert!(diff.stats.changed + diff.stats.added + diff.stats.removed > 0);
}
