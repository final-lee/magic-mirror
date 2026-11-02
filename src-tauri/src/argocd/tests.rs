use serde_json::json;

use super::*;

#[test]
fn argocd_application_row_values() {
    let row = app_row(&json!({
        "metadata": {"name":"app", "namespace":"argo", "resourceVersion":"7", "ownerReferences":[{"kind":"ApplicationSet","name":"fleet"}]},
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
