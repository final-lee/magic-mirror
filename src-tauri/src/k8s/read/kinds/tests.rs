use kube::discovery::{ApiCapabilities, ApiResource, Scope};

use super::*;

fn ar(group: &str, version: &str, kind: &str, plural: &str) -> ApiResource {
    let api_version = if group.is_empty() { version.to_string() } else { format!("{group}/{version}") };
    ApiResource { group: group.into(), version: version.into(), api_version, kind: kind.into(), plural: plural.into() }
}

fn caps(scope: Scope, ops: &[&str]) -> ApiCapabilities {
    ApiCapabilities { scope, subresources: vec![], operations: ops.iter().map(|s| s.to_string()).collect() }
}

#[test]
fn listable_builtin_and_custom_kinds() {
    let d = kind_of(&ar("apps", "v1", "Deployment", "deployments"), &caps(Scope::Namespaced, &["get", "list", "watch", "create"]), &NameTable::new()).unwrap();
    assert_eq!(d.kind, KindRef { group: "apps".into(), version: "v1".into(), kind: "Deployment".into(), plural: "deployments".into(), namespaced: true });
    assert!(!d.custom);
    assert_eq!(d.verbs, ["get", "list", "watch", "create"]);
    let w = kind_of(&ar("mm.example.com", "v1", "Widget", "widgets"), &caps(Scope::Cluster, &["list", "watch"]), &NameTable::new()).unwrap();
    assert!(w.custom && !w.kind.namespaced);
    let core = kind_of(&ar("", "v1", "Pod", "pods"), &caps(Scope::Namespaced, &["list", "watch"]), &NameTable::new()).unwrap();
    assert!(!core.custom);
}

#[test]
fn kinds_without_list_and_watch_are_left_out() {
    // metrics.k8s.io는 get, list만 된다
    assert_eq!(kind_of(&ar("metrics.k8s.io", "v1beta1", "PodMetrics", "pods"), &caps(Scope::Namespaced, &["get", "list"]), &NameTable::new()), None);
    assert_eq!(kind_of(&ar("authorization.k8s.io", "v1", "SelfSubjectReview", "selfsubjectreviews"), &caps(Scope::Cluster, &["create"]), &NameTable::new()), None);
}

#[test]
fn kind_json_is_flat() {
    let k = kind_of(&ar("apps", "v1", "Deployment", "deployments"), &caps(Scope::Namespaced, &["list", "watch"]), &NameTable::new()).unwrap();
    assert_eq!(
        serde_json::to_value(k).unwrap(),
        serde_json::json!({ "group": "apps", "version": "v1", "kind": "Deployment", "plural": "deployments", "namespaced": true, "verbs": ["list", "watch"], "custom": false, "shortNames": [], "singularName": "" })
    );
}

#[test]
fn only_other_failures_fall_back_to_per_group_discovery() {
    assert!(falls_back(&Failure::Other("the server could not find the requested resource".into())));
    for f in [Failure::Unreachable, Failure::Tls, Failure::Unauthorized, Failure::SsoExpired, Failure::Forbidden { verb: "get".into(), resource: "api".into() }] {
        assert!(!falls_back(&f), "{f:?}");
    }
}

/// 집계 discovery(/api, /apis)가 내주는 모양 그대로
fn discovery_list(json: serde_json::Value) -> APIGroupDiscoveryList {
    serde_json::from_value(json).unwrap()
}

fn sample_lists() -> Vec<APIGroupDiscoveryList> {
    vec![
        // 코어 그룹은 metadata.name이 없다
        discovery_list(serde_json::json!({ "items": [{ "versions": [{ "version": "v1", "resources": [
            { "resource": "pods", "scope": "Namespaced", "singularResource": "pod", "verbs": ["list", "watch"], "shortNames": ["po"] },
            { "resource": "namespaces", "scope": "Cluster", "singularResource": "namespace", "verbs": ["list", "watch"], "shortNames": ["ns"] },
            { "resource": "bindings", "scope": "Namespaced", "singularResource": "binding", "verbs": ["create"] }
        ] }] }] })),
        discovery_list(serde_json::json!({ "items": [
            { "metadata": { "name": "apps" }, "versions": [{ "version": "v1", "resources": [
                { "resource": "deployments", "scope": "Namespaced", "singularResource": "deployment", "verbs": ["list", "watch"], "shortNames": ["deploy"] }
            ] }] },
            { "metadata": { "name": "autoscaling" }, "versions": [
                { "version": "v2", "resources": [{ "resource": "horizontalpodautoscalers", "singularResource": "horizontalpodautoscaler", "shortNames": ["hpa"] }] },
                { "version": "v1", "resources": [{ "resource": "horizontalpodautoscalers", "singularResource": "horizontalpodautoscaler", "shortNames": ["old-hpa"] }] }
            ] },
            { "metadata": { "name": "empty.example.com" }, "versions": [] }
        ] })),
    ]
}

#[test]
fn names_come_from_the_aggregated_lists_keyed_by_group_and_plural() {
    let table = names_of(&sample_lists());
    assert_eq!(table[&("".to_string(), "pods".to_string())], Names { short_names: vec!["po".into()], singular: "pod".into() });
    assert_eq!(table[&("apps".to_string(), "deployments".to_string())].short_names, ["deploy"]);
    // 이름이 없는 종류는 빈 별칭
    assert_eq!(table[&("".to_string(), "bindings".to_string())], Names { short_names: vec![], singular: "binding".into() });
    assert!(!table.keys().any(|(g, _)| g == "empty.example.com"));
}

#[test]
fn names_of_a_group_follow_its_recommended_first_version() {
    let table = names_of(&sample_lists());
    assert_eq!(table[&("autoscaling".to_string(), "horizontalpodautoscalers".to_string())].short_names, ["hpa"]);
}

#[test]
fn kinds_carry_the_names_and_fall_back_to_empty() {
    let table = names_of(&sample_lists());
    let pod = kind_of(&ar("", "v1", "Pod", "pods"), &caps(Scope::Namespaced, &["list", "watch"]), &table).unwrap();
    assert_eq!((pod.short_names.as_slice(), pod.singular_name.as_str()), (["po".to_string()].as_slice(), "pod"));
    let widget = kind_of(&ar("mm.example.com", "v1", "Widget", "widgets"), &caps(Scope::Cluster, &["list", "watch"]), &table).unwrap();
    assert!(widget.short_names.is_empty() && widget.singular_name.is_empty());
    let json = serde_json::to_value(pod).unwrap();
    assert_eq!(json["shortNames"], serde_json::json!(["po"]));
    assert_eq!(json["singularName"], "pod");
}
