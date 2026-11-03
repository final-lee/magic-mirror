use serde_json::json;

use super::*;
use crate::k8s::helm::release::decode;

fn release(value: Value) -> Release {
    serde_json::from_value(value).unwrap()
}

fn sample() -> Value {
    json!({
        "name": "web", "namespace": "apps", "version": 4,
        "info": {"status": "failed", "description": "Upgrade failed", "notes": "NOTES", "first_deployed": "2026-01-01T00:00:00Z", "last_deployed": "2026-01-02T00:00:00Z"},
        "chart": {
            "metadata": {"name": "web", "version": "1.0.0", "appVersion": "9", "description": "A web", "home": "https://h", "kubeVersion": ">=1.25", "deprecated": true,
                "dependencies": [{"name": "redis", "version": "17.x", "repository": "https://charts.example"}]},
            "values": {"replicas": 1, "image": {"tag": "1"}},
        },
        "config": {"replicas": 2},
        "manifest": "---\n# Source: web/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: db\ndata:\n  password: aHVudGVyMg==\n---\n# Source: web/templates/deploy.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: apps\n",
        "hooks": [{"name": "migrate", "kind": "Job", "events": ["pre-upgrade"]}],
    })
}

#[test]
fn a_detail_carries_summary_values_resources_hooks_and_the_history() {
    let history = vec![Revision { revision: 4, status: "failed".into(), updated: None, chart: "web-1.0.0".into(), chart_name: "web".into(), chart_version: "1.0.0".into(), app_version: "9".into(), description: "x".into(), unreadable: false }];
    let detail = build(&release(sample()), Driver::Secret, 5, history.clone()).unwrap();
    assert_eq!((detail.revision, detail.latest, detail.status.as_str(), detail.problem), (4, 5, "failed", true));
    assert_eq!((detail.description.as_str(), detail.notes.as_str()), ("Upgrade failed", "NOTES"));
    assert_eq!(detail.chart.dependencies, vec![Dependency { name: "redis".into(), version: "17.x".into(), repository: "https://charts.example".into() }]);
    assert!(detail.chart.deprecated && detail.chart.kube_version == ">=1.25" && detail.chart.app_version == "9");
    assert_eq!(serde_saphyr::from_str::<Value>(&detail.user_values).unwrap(), json!({"replicas": 2}));
    assert_eq!(serde_saphyr::from_str::<Value>(&detail.computed_values).unwrap(), json!({"replicas": 2, "image": {"tag": "1"}}));
    assert_eq!(detail.resources.iter().map(|r| (r.kind.as_str(), r.name.as_str(), r.namespace.as_deref())).collect::<Vec<_>>(), [("Secret", "db", None), ("Deployment", "web", Some("apps"))]);
    assert_eq!(detail.hooks, vec![HookInfo { name: "migrate".into(), kind: "Job".into(), events: vec!["pre-upgrade".into()] }]);
    assert_eq!(detail.history, history);
    assert_eq!(detail.driver, Driver::Secret);
}

#[test]
fn the_manifest_shown_never_contains_a_secret_value_but_user_values_are_shown_as_given() {
    let mut value = sample();
    value["config"] = json!({"db": {"password": "hunter2"}});
    let detail = build(&release(value), Driver::Secret, 4, vec![]).unwrap();
    assert!(!detail.manifest.contains("aHVudGVyMg=="), "{}", detail.manifest);
    assert!(detail.manifest.contains("# Source: web/templates/deploy.yaml"));
    assert!(detail.user_values.contains("hunter2"), "사용자가 준 값은 그대로 보여요");
}

#[test]
fn empty_user_values_are_an_empty_editor_and_come_back_as_an_empty_map() {
    for config in [json!({}), Value::Null] {
        let mut value = sample();
        value["config"] = config;
        let detail = build(&release(value), Driver::Secret, 4, vec![]).unwrap();
        assert_eq!(detail.user_values, "");
        assert_eq!(serde_saphyr::from_str::<Value>(&detail.computed_values).unwrap()["replicas"], 1);
    }
    assert_eq!(values_yaml(&json!({})).unwrap(), "");
    assert_eq!(values_yaml(&Value::Null).unwrap(), "");
}

#[test]
fn a_healthy_historic_revision_is_not_a_problem_and_a_pending_one_is() {
    for (status, problem) in [("superseded", false), ("deployed", false), ("uninstalled", false), ("pending-upgrade", true)] {
        let mut value = sample();
        value["info"]["status"] = json!(status);
        assert_eq!(build(&release(value), Driver::Secret, 4, vec![]).unwrap().problem, problem, "{status}");
    }
}

#[test]
fn the_captured_release_builds_a_detail_with_its_templated_resources() {
    let release = decode(include_str!("../release/demo-v2.b64").as_bytes()).unwrap();
    let detail = build(&release, Driver::Secret, 2, vec![]).unwrap();
    assert_eq!(detail.resources.iter().map(|r| format!("{}/{}", r.kind, r.name)).collect::<Vec<_>>(), ["ConfigMap/demo-config", "Deployment/demo-web"]);
    assert_eq!(detail.notes, "Installed demo\n");
}
