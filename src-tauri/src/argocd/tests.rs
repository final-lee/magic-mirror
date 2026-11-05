use serde_json::json;

use super::*;

#[test]
fn argocd_application_row_values() {
    let row = app_row(&json!({
        "metadata": {"name":"app", "namespace":"argo", "resourceVersion":"7", "ownerReferences":[{"kind":"ApplicationSet","name":"fleet"}], "labels":{"environment":"prd","type":"api"}},
        "spec": {"sources":[{"targetRevision":"main"},{"targetRevision":"v2"}],"syncPolicy":{"automated":{}}},
        "status": {"sync":{"revisions":["0123456789012345678901234567890123456789","v2"]},"conditions":[{"type":"ComparisonError"},{"type":"RepeatedResourceWarning"}]}
    }));
    assert_eq!(row.name, "app");
    assert_eq!(row.resource_version, "7");
    assert_eq!(row.values["revision"], "0123456, v2");
    assert_eq!(row.values["targetRevision"], "main, v2");
    assert_eq!(row.values["appSet"], "fleet");
    assert_eq!(row.values["autoSync"], "true");
    assert_eq!(row.values["errors"], "1");
    assert_eq!(row.values["warnings"], "1");
    assert_eq!(row.labels.len(), 2);
    assert_eq!(row.labels["environment"], "prd");
    assert!(app_row(&json!({"metadata":{"name":"bare"}})).labels.is_empty());
}

#[test]
fn argocd_application_row_policy_flags_and_images() {
    let row = app_row(&json!({
        "metadata": {"name": "app"},
        "spec": {"syncPolicy": {"automated": {"selfHeal": true}}},
        "status": {"summary": {"images": ["repo/web:1", "repo/api:2"]}}
    }));
    // 자동 sync는 켜져 있고 selfHeal만 켜졌다: prune은 빠졌으면 꺼진 것
    assert_eq!((row.values["autoSync"].as_str(), row.values["selfHeal"].as_str(), row.values["autoPrune"].as_str()), ("true", "true", "false"));
    assert_eq!(row.images, ["repo/web:1", "repo/api:2"]);
    let manual = app_row(&json!({"metadata": {"name": "manual"}, "spec": {"syncPolicy": {}}}));
    assert_eq!((manual.values["autoSync"].as_str(), manual.values["selfHeal"].as_str(), manual.values["autoPrune"].as_str()), ("false", "false", "false"));
    assert!(manual.images.is_empty());
    let wire = serde_json::to_value(&manual).unwrap();
    assert!(wire.get("images").is_none());
    assert_eq!(serde_json::to_value(&row).unwrap()["images"][1], "repo/api:2");
}

#[test]
fn argocd_application_row_resource_summary() {
    let row = app_row(&json!({
        "metadata": {"name": "app"},
        "status": {"resources": [
            {"group":"apps","version":"v1","kind":"Deployment","namespace":"web","name":"api","status":"OutOfSync","health":{"status":"Healthy"},"requiresPruning":true},
            {"version":"v1","kind":"Namespace","name":"web"},
            {"group":"batch","version":"v1","kind":"Job","namespace":"web","name":"migrate","hook":true,"health":{}},
            {"kind":"Broken"}
        ]}
    }));
    assert_eq!(row.resources.len(), 3);
    let deploy = &row.resources[0];
    assert_eq!((deploy.group.as_str(), deploy.kind.as_str(), deploy.name.as_str()), ("apps", "Deployment", "api"));
    assert_eq!(deploy.namespace.as_deref(), Some("web"));
    assert_eq!(deploy.status.as_deref(), Some("OutOfSync"));
    assert_eq!(deploy.health.as_deref(), Some("Healthy"));
    assert!(deploy.requires_pruning && !deploy.hook);
    let namespace = &row.resources[1];
    assert_eq!(namespace.group, "");
    assert!(namespace.namespace.is_none() && namespace.status.is_none() && namespace.health.is_none());
    assert!(row.resources[2].hook && row.resources[2].health.is_none());

    let wire = serde_json::to_value(&row).unwrap();
    assert_eq!(wire["resources"][1], json!({"group":"","version":"v1","kind":"Namespace","name":"web"}));
    assert!(serde_json::to_value(app_row(&json!({"metadata":{"name":"bare"}}))).unwrap().get("resources").is_none());
}

#[test]
fn argocd_appset_row_and_tree() {
    let row = appset_row(&json!({"metadata":{"name":"fleet"},"spec":{"generators":[{"git":{}}]},"status":{"conditions":[{"type":"ErrorOccurred","status":"True","message":"bad"}]}}));
    assert_eq!(row.status.as_deref(), Some("Error"));
    assert_eq!(row.message.as_deref(), Some("bad"));
    assert_eq!(row.generators, ["git"]);
    let current = appset_row(&json!({
        "status":{"conditions":[{"type":"ResourcesUpToDate","status":"True"}]}
    }));
    assert_eq!(current.status.as_deref(), Some("UpToDate"));
    let node = tree_node(&json!({"uid":"one","parentRefs":[{"uid":"parent"}],"health":{"status":"Healthy","message":"ok"},"info":[{"name":"k","value":"v"}],"images":["image"]}));
    assert_eq!(node.parents, ["parent"]);
    assert_eq!(node.health.as_deref(), Some("Healthy"));
    assert_eq!(node.health_message.as_deref(), Some("ok"));
    assert_eq!(node.info, ["k: v"]);
    assert_eq!(node.images, ["image"]);
}

#[test]
fn argocd_tree_networking_info_shape() {
    let node = tree_node(&json!({"networkingInfo":{
        "targetLabels":{"app":"web"},"labels":{"tier":"edge"},
        "targetRefs":[{"kind":"Service","name":"web","namespace":"default"}],
        "ingress":[{"hostname":"example.test"},{"ip":"192.0.2.1"}],
        "externalURLs":["https://example.test"]
    }}));
    let wire = serde_json::to_value(node).unwrap();
    assert_eq!(wire["networkingInfo"]["targetLabels"]["app"], "web");
    assert_eq!(wire["networkingInfo"]["labels"]["tier"], "edge");
    assert_eq!(wire["networkingInfo"]["targetRefs"][0]["name"], "web");
    assert_eq!(wire["networkingInfo"]["ingress"][1]["ip"], "192.0.2.1");
    assert_eq!(wire["networkingInfo"]["externalURLs"][0], "https://example.test");
    assert!(serde_json::to_value(tree_node(&json!({}))).unwrap()["networkingInfo"].is_null());
}

#[test]
fn argocd_app_detail_parses_operation_and_sources() {
    let app = argo_app_of(&json!({"metadata":{"name":"app","ownerReferences":[{"kind":"ApplicationSet","name":"fleet"}]},"spec":{"sources":[{"repoURL":"repo","targetRevision":"main"}]},"status":{"operationState":{"phase":"Running"},"sync":{"revisions":["abc"]}}}));
    assert_eq!(app.name, "app");
    assert_eq!(app.sources[0].repo_url, "repo");
    assert_eq!(app.sync_revisions, ["abc"]);
    assert_eq!(app.app_set.as_deref(), Some("fleet"));
    assert!(app.operation_in_progress);
    assert!(!argo_app_of(&json!({"operation":{}})).operation_in_progress);
}

#[test]
fn argocd_detail_history_results_and_raw() {
    let history: Vec<_> = (0..25).map(|id| json!({"id":id,"revision":"abc"})).collect();
    let raw = json!({
        "metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}},
        "spec":{
            "destination":{"server":"https://kubernetes.default.svc"},
            "source":{"repoURL":"single"},
            "sources":[{"repoURL":"multi"}]
        },
        "status":{
            "history":history,
            "operationState":{
                "phase":"Running",
                "operation":{"initiatedBy":{"username":"admin"}},
                "syncResult":{"resources":[
                    {"name":"ok","status":"Synced"},
                    {"name":"bad","status":"SyncFailed"}
                ]}
            }
        }
    });
    let app = argo_app_of(&raw);
    assert_eq!(app.raw, raw);
    assert!(app.destination.in_cluster);
    assert_eq!(app.sources.len(), 2);
    assert_eq!(app.history.len(), 20);
    assert_eq!(app.history[0].id, 24);
    assert_eq!(app.history[19].id, 5);
    assert_eq!(app.refresh_requested.as_deref(), Some("hard"));
    let operation = app.operation.unwrap();
    assert_eq!(operation.initiated_by.as_deref(), Some("admin"));
    assert_eq!(operation.failed_results.len(), 1);
    assert_eq!(operation.failed_results[0].name, "bad");
    assert!(argo_app_of(&json!({"spec":{"destination":{"name":"in-cluster"}}})).destination.in_cluster);
}
