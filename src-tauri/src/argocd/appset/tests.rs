use serde_json::json;

use super::*;

fn fleet() -> Value {
    json!({
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "ApplicationSet",
        "metadata": {
            "name": "fleet", "namespace": "argocd", "resourceVersion": "42", "uid": "u", "managedFields": [{"manager": "x"}],
            "labels": {"team": "core"},
            "annotations": {"kubectl.kubernetes.io/last-applied-configuration": "{}", "note": "keep"}
        },
        "spec": {
            "goTemplate": true,
            "generators": [
                {"matrix": {"generators": [{"git": {"repoURL": "https://git/x.git", "revision": "main", "directories": [{"path": "apps/*"}]}}, {"clusters": {"selector": {"matchLabels": {"env": "stg"}}}}]}},
                {"list": {"elements": [{"a": 1}, {"a": 2}]}}
            ],
            "strategy": {"type": "RollingSync", "rollingSync": {"steps": [
                {"matchExpressions": [{"key": "env", "operator": "In", "values": ["stg"]}], "maxUpdate": "25%"},
                {"matchExpressions": [], "maxUpdate": 2}
            ]}},
            "syncPolicy": {"preserveResourcesOnDeletion": true},
            "template": {
                "metadata": {"name": "{{path.basename}}"},
                "spec": {"project": "default", "source": {"repoURL": "https://git/x.git", "path": "{{path}}", "targetRevision": "HEAD"}, "destination": {"name": "in-cluster", "namespace": "web"}}
            }
        },
        "status": {
            "conditions": [{"type": "ErrorOccurred", "status": "False", "reason": "ApplicationSetUpToDate", "message": "ok", "lastTransitionTime": "2026-01-01T00:00:00Z"}],
            "applicationStatus": [{"application": "web", "status": "Waiting", "step": "1", "message": "waiting"}]
        }
    })
}

#[test]
fn appset_detail_summarises_generators_template_and_steps() {
    let d = appset_detail(&fleet()).unwrap();
    assert_eq!((d.name.as_str(), d.namespace.as_str(), d.resource_version.as_str()), ("fleet", "argocd", "42"));
    assert_eq!(d.generators.len(), 2);
    assert_eq!(
        d.generators[0],
        GeneratorInfo {
            kind: "matrix".into(),
            detail: Some("git × clusters".into())
        }
    );
    assert_eq!(
        d.generators[1],
        GeneratorInfo {
            kind: "list".into(),
            detail: Some("요소 2개".into())
        }
    );
    assert_eq!(d.template.project.as_deref(), Some("default"));
    assert_eq!(d.template.sources, ["https://git/x.git {{path}} @ HEAD"]);
    assert_eq!(d.template.destination.as_deref(), Some("in-cluster/web"));
    let strategy = d.strategy.unwrap();
    assert_eq!(strategy.kind, "RollingSync");
    assert_eq!(
        strategy.steps[0],
        StepInfo {
            matches: vec!["env In stg".into()],
            max_update: Some("25%".into())
        }
    );
    assert_eq!(strategy.steps[1].max_update.as_deref(), Some("2"));
    assert!(d.preserve_resources_on_deletion && d.go_template);
    assert_eq!(d.conditions[0].r#type, "ErrorOccurred");
    assert_eq!(
        d.application_status[0],
        AppSetAppStatus {
            application: "web".into(),
            status: "Waiting".into(),
            step: Some("1".into()),
            message: Some("waiting".into()),
            last_transition_time: None
        }
    );
}

#[test]
fn appset_manifest_drops_server_fields_and_status() {
    let d = appset_detail(&fleet()).unwrap();
    let saved: Value = serde_saphyr::from_str(&d.yaml).unwrap();
    assert_eq!(saved["kind"], "ApplicationSet");
    assert_eq!(saved["metadata"]["name"], "fleet");
    assert_eq!(saved["metadata"]["labels"]["team"], "core");
    assert_eq!(saved["metadata"]["annotations"], json!({"note": "keep"}));
    assert!(saved["metadata"].get("managedFields").is_none() && saved["metadata"].get("resourceVersion").is_none() && saved["metadata"].get("uid").is_none());
    assert!(saved.get("status").is_none());
    assert_eq!(saved["spec"]["goTemplate"], true);
}

#[test]
fn appset_detail_of_a_bare_set_has_empty_parts() {
    let d = appset_detail(&json!({"metadata": {"name": "x", "namespace": "argocd"}})).unwrap();
    assert!(d.generators.is_empty() && d.conditions.is_empty() && d.application_status.is_empty());
    assert!(d.strategy.is_none() && !d.preserve_resources_on_deletion && !d.go_template);
    assert!(d.template.sources.is_empty() && d.template.destination.is_none());
}

#[test]
fn owned_apps_keep_only_this_sets_apps_in_its_namespace() {
    let owner = |name: &str| json!([{"kind": "ApplicationSet", "name": name}]);
    let body = json!({"items": [
        {"metadata": {"name": "b", "namespace": "argocd", "ownerReferences": owner("fleet")}, "spec": {"project": "p", "extra": null}},
        {"metadata": {"name": "a", "namespace": "argocd", "ownerReferences": owner("fleet")}, "spec": {"project": "p"}},
        {"metadata": {"name": "c", "namespace": "argocd", "ownerReferences": owner("other")}, "spec": {}},
        {"metadata": {"name": "d", "namespace": "elsewhere", "ownerReferences": owner("fleet")}, "spec": {}},
        {"metadata": {"name": "e", "namespace": "argocd"}, "spec": {}}
    ]});
    let apps = owned_apps(&body, "argocd", "fleet").unwrap();
    assert_eq!(apps.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    assert_eq!(apps[0].yaml, apps[1].yaml, "null 값은 비교에서 빠진다");
}

#[test]
fn generate_request_wraps_the_set_and_rejects_unreadable_input() {
    let body = generate_request("apiVersion: argoproj.io/v1alpha1\nkind: ApplicationSet\nmetadata:\n  name: fleet\nspec:\n  generators: []\n").unwrap();
    assert_eq!(body["applicationSet"]["metadata"]["name"], "fleet");
    assert!(generate_request("metadata:\n  name: x\n").is_err(), "spec이 없다");
    assert!(generate_request("- a\n- b\n").is_err(), "객체가 아니다");
    assert!(generate_request("spec: [").is_err(), "YAML 오류");
}

#[test]
fn generated_apps_are_summarised_and_comparable_to_owned_apps() {
    let spec = json!({"project": "default", "sources": [{"repoURL": "https://git/x.git", "chart": "web", "targetRevision": "1.0"}], "destination": {"server": "https://k8s", "namespace": "web"}});
    let generated = generated_apps(&json!({"applications": [
        {"metadata": {"name": "web-b", "namespace": "argocd", "labels": {"x": "y"}}, "spec": spec},
        {"metadata": {"name": "web-a", "namespace": "argocd"}, "spec": spec}
    ]}))
    .unwrap();
    assert_eq!(generated.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["web-a", "web-b"]);
    assert_eq!(generated[0].project.as_deref(), Some("default"));
    assert_eq!(generated[0].destination.as_deref(), Some("https://k8s/web"));
    assert_eq!(generated[0].sources, ["https://git/x.git web @ 1.0"]);
    let live = owned_apps(
        &json!({"items": [{"metadata": {"name": "web-a", "namespace": "argocd", "ownerReferences": [{"kind": "ApplicationSet", "name": "fleet"}]}, "spec": spec}]}),
        "argocd",
        "fleet",
    )
    .unwrap();
    assert_eq!(generated[0].yaml, live[0].yaml, "같은 spec이면 비교 글이 같다");
    assert!(generated_apps(&json!({})).unwrap().is_empty());
}
