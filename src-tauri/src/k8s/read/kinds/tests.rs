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
    let d = kind_of(&ar("apps", "v1", "Deployment", "deployments"), &caps(Scope::Namespaced, &["get", "list", "watch", "create"])).unwrap();
    assert_eq!(d.kind, KindRef { group: "apps".into(), version: "v1".into(), kind: "Deployment".into(), plural: "deployments".into(), namespaced: true });
    assert!(!d.custom);
    assert_eq!(d.verbs, ["get", "list", "watch", "create"]);
    let w = kind_of(&ar("mm.example.com", "v1", "Widget", "widgets"), &caps(Scope::Cluster, &["list", "watch"])).unwrap();
    assert!(w.custom && !w.kind.namespaced);
    let core = kind_of(&ar("", "v1", "Pod", "pods"), &caps(Scope::Namespaced, &["list", "watch"])).unwrap();
    assert!(!core.custom);
}

#[test]
fn kinds_without_list_and_watch_are_left_out() {
    // metrics.k8s.io는 get, list만 된다
    assert_eq!(kind_of(&ar("metrics.k8s.io", "v1beta1", "PodMetrics", "pods"), &caps(Scope::Namespaced, &["get", "list"])), None);
    assert_eq!(kind_of(&ar("authorization.k8s.io", "v1", "SelfSubjectReview", "selfsubjectreviews"), &caps(Scope::Cluster, &["create"])), None);
}

#[test]
fn kind_json_is_flat() {
    let k = kind_of(&ar("apps", "v1", "Deployment", "deployments"), &caps(Scope::Namespaced, &["list", "watch"])).unwrap();
    assert_eq!(
        serde_json::to_value(k).unwrap(),
        serde_json::json!({ "group": "apps", "version": "v1", "kind": "Deployment", "plural": "deployments", "namespaced": true, "verbs": ["list", "watch"], "custom": false })
    );
}

#[test]
fn only_other_failures_fall_back_to_per_group_discovery() {
    assert!(falls_back(&Failure::Other("the server could not find the requested resource".into())));
    for f in [Failure::Unreachable, Failure::Tls, Failure::Unauthorized, Failure::SsoExpired, Failure::Forbidden { verb: "get".into(), resource: "api".into() }] {
        assert!(!falls_back(&f), "{f:?}");
    }
}
