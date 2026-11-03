use serde_json::json;

use super::*;
use crate::k8s::helm::release::decode;

fn file(name: &str, text: &str) -> Value {
    json!({"name": name, "data": STANDARD.encode(text)})
}

fn chart_json() -> Value {
    json!({
        "metadata": {"apiVersion": "v2", "name": "web", "version": "1.0.0", "appVersion": "9", "dependencies": [{"name": "redis", "version": "1.0.0", "repository": "https://r"}]},
        "values": {"replicas": 2, "image": {"tag": "1"}},
        "schema": STANDARD.encode("{\"type\":\"object\"}"),
        "templates": [file("templates/deploy.yaml", "kind: Deployment\n"), file("templates/_helpers.tpl", "{{/* h */}}")],
        "files": [file("crds/widget.yaml", "kind: CustomResourceDefinition\n"), file("config/app.conf", "a=b\n")],
        "dependencies": [{"metadata": {"name": "redis", "version": "1.0.0", "dependencies": [{"name": "x"}]}, "values": {"port": 6379}, "templates": [file("templates/svc.yaml", "kind: Service\n")]}],
    })
}

fn chart_of(value: Value) -> Chart {
    serde_json::from_value(value).unwrap()
}

#[test]
fn a_stored_chart_is_written_back_as_a_loadable_chart_folder() {
    let dir = tempfile::tempdir().unwrap();
    write(&chart_of(chart_json()), &dir.path().join("web")).unwrap();
    let root = dir.path().join("web");
    let read = |p: &str| std::fs::read_to_string(root.join(p)).unwrap();
    let meta: Value = serde_json::from_str(&read("Chart.yaml")).unwrap();
    assert_eq!((meta["name"].as_str(), meta["appVersion"].as_str(), meta["apiVersion"].as_str()), (Some("web"), Some("9"), Some("v2")));
    let values: Value = serde_saphyr::from_str(&read("values.yaml")).unwrap();
    assert_eq!(values, json!({"replicas": 2, "image": {"tag": "1"}}));
    assert_eq!(read("templates/deploy.yaml"), "kind: Deployment\n");
    assert_eq!(read("templates/_helpers.tpl"), "{{/* h */}}");
    assert_eq!(read("crds/widget.yaml"), "kind: CustomResourceDefinition\n");
    assert_eq!(read("config/app.conf"), "a=b\n");
    assert_eq!(read("values.schema.json"), "{\"type\":\"object\"}");
    assert_eq!(read("charts/redis/templates/svc.yaml"), "kind: Service\n");
    let sub: Value = serde_saphyr::from_str(&read("charts/redis/values.yaml")).unwrap();
    assert_eq!(sub, json!({"port": 6379}));
}

#[test]
fn dependencies_are_dropped_from_chart_yaml_because_stored_subcharts_are_already_resolved() {
    let dir = tempfile::tempdir().unwrap();
    write(&chart_of(chart_json()), dir.path()).unwrap();
    let top: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("Chart.yaml")).unwrap()).unwrap();
    let sub: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("charts/redis/Chart.yaml")).unwrap()).unwrap();
    assert!(top.get("dependencies").is_none() && sub.get("dependencies").is_none());
}

#[test]
fn a_chart_without_values_or_schema_gets_an_empty_values_file_and_no_schema() {
    let dir = tempfile::tempdir().unwrap();
    write(&chart_of(json!({"metadata": {"name": "bare", "version": "0.1.0"}})), dir.path()).unwrap();
    assert_eq!(std::fs::read_to_string(dir.path().join("values.yaml")).unwrap(), "{}\n");
    assert!(!dir.path().join("values.schema.json").exists());
}

#[test]
fn file_names_that_climb_out_of_the_folder_are_refused_and_nothing_is_written_outside() {
    for bad in ["../escape.txt", "/tmp/mm-escape.txt", "templates/../../escape.txt", ""] {
        let parent = tempfile::tempdir().unwrap();
        let target = parent.path().join("chart");
        let mut value = chart_json();
        value["files"] = json!([file(bad, "pwned")]);
        assert_eq!(write(&chart_of(value), &target).unwrap_err(), AppError::other(UNSAFE_PATH), "{bad:?}");
        assert!(!parent.path().join("escape.txt").exists());
    }
    let parent = tempfile::tempdir().unwrap();
    let mut value = chart_json();
    value["dependencies"][0]["metadata"]["name"] = json!("../../outside");
    assert_eq!(write(&chart_of(value), &parent.path().join("chart")).unwrap_err(), AppError::other(UNSAFE_PATH));
}

#[test]
fn a_captured_helm_release_round_trips_into_a_chart_with_the_same_templates() {
    let release = decode(include_str!("../release/demo-v2.b64").as_bytes()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    write(&release.chart, dir.path()).unwrap();
    let deployment = std::fs::read_to_string(dir.path().join("templates/deployment.yaml")).unwrap();
    assert!(deployment.contains("{{ .Release.Name }}-web"));
    assert_eq!(std::fs::read_to_string(dir.path().join("extra.txt")).unwrap(), "extra file\n");
    let values: Value = serde_saphyr::from_str(&std::fs::read_to_string(dir.path().join("values.yaml")).unwrap()).unwrap();
    assert_eq!(values, json!({"image": "registry.k8s.io/pause:3.10", "message": "hello", "replicaCount": 1}));
}
