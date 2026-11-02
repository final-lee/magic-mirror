use super::*;
use crate::k8s::commit;

fn change(group: &str, kind: &str, operation: Operation) -> Change {
    Change {
        target: ChangeObject {
            kind: KindRef { group: group.into(), version: "v1".into(), kind: kind.into(), plural: format!("{}s", kind.to_lowercase()), namespaced: true },
            namespace: Some("default".into()),
            name: "sample".into(),
        },
        operation,
    }
}

fn object() -> Value {
    json!({"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"sample","namespace":"default","resourceVersion":"12","uid":"u","managedFields":[{}]},"spec":{"replicas":3,"template":{"spec":{"containers":[]}}},"status":{"readyReplicas":3}})
}

#[test]
fn scale_previews_version_diff_and_inverse() {
    let c = change("apps", "Deployment", Operation::Scale { replicas: 5 });
    let p = plan(&c, Some(&object()), None, "2026-01-01T00:00:00Z").unwrap();
    assert_eq!(p.preview.calls[0].body["metadata"]["resourceVersion"], "12");
    assert_eq!(p.preview.diff[0].before, 3);
    assert_eq!(p.preview.diff[0].after, 5);
    assert_eq!(p.inverse.unwrap().operation, Operation::Scale { replicas: 3 });
}

#[test]
fn dangerous_owned_deletion_requires_name_and_has_no_inverse() {
    let mut c = change("apps", "Deployment", Operation::Delete);
    let mut obj = object();
    obj["metadata"]["ownerReferences"] = json!([{"uid":"owner"}]);
    let p = plan(&c, Some(&obj), None, "").unwrap();
    assert_eq!(p.preview.confirm_name.as_deref(), Some("sample"));
    assert!(!p.preview.warnings.is_empty());
    assert!(p.inverse.is_none());
    c.target.name = "prod-app".into();
    let p = plan(&c, Some(&object()), None, "").unwrap();
    assert!(commit::check(Some(&p), &p, None).is_err());
    assert!(commit::check(Some(&p), &p, Some("prod-app")).is_ok());
}

#[test]
fn deletion_inverse_cleans_server_fields_and_never_keeps_secret() {
    let c = change("apps", "Deployment", Operation::Delete);
    let p = plan(&c, Some(&object()), None, "").unwrap();
    let Operation::Recreate { object } = p.inverse.unwrap().operation else { panic!("역변경이 아니에요") };
    assert!(object.get("status").is_none());
    assert!(object["metadata"].get("uid").is_none());
    assert!(object["metadata"].get("resourceVersion").is_none());
    let secret = change("", "Secret", Operation::Delete);
    assert!(plan(&secret, Some(&object), None, "").is_err());
    let mut secret_obj = object.clone();
    secret_obj["metadata"]["resourceVersion"] = json!("1");
    secret_obj["data"] = json!({"password":"c2VjcmV0"});
    secret_obj["apiVersion"] = json!("v1");
    secret_obj["kind"] = json!("Secret");
    let p = plan(&secret, Some(&secret_obj), None, "").unwrap();
    assert!(p.inverse.is_none());
    assert!(!serde_json::to_string(&p.preview).unwrap().contains("c2VjcmV0"));
    let forged = change("", "ConfigMap", Operation::Delete);
    assert!(plan(&forged, Some(&secret_obj), None, "").is_err());
}

#[test]
fn status_only_changes_are_safe_but_spec_changes_are_stale() {
    let c = change("apps", "Deployment", Operation::Scale { replicas: 5 });
    let first = plan(&c, Some(&object()), None, "").unwrap();
    let mut changed = object();
    changed["metadata"]["resourceVersion"] = json!("13");
    changed["status"]["readyReplicas"] = json!(2);
    let second = plan(&c, Some(&changed), None, "").unwrap();
    assert!(commit::check(Some(&first), &second, None).is_ok());
    changed["spec"]["replicas"] = json!(4);
    let third = plan(&c, Some(&changed), None, "").unwrap();
    assert!(commit::check(Some(&first), &third, None).is_err());
    changed["spec"]["replicas"] = json!(3);
    changed["metadata"]["uid"] = json!("replacement");
    let replacement = plan(&c, Some(&changed), None, "").unwrap();
    assert!(commit::check(Some(&first), &replacement, None).is_err());
}

#[test]
fn suspend_and_rerun_have_inverse_and_remove_job_selector() {
    let suspend = change("batch", "CronJob", Operation::Suspend { suspend: true });
    let p = plan(&suspend, Some(&object()), None, "").unwrap();
    assert_eq!(p.inverse.unwrap().operation, Operation::Suspend { suspend: false });
    let job = change("batch", "Job", Operation::Rerun { job_name: "next".into() });
    let mut obj = object();
    obj["spec"]["selector"] = json!({"matchLabels":{"controller-uid":"old"}});
    obj["spec"]["template"]["metadata"] = json!({"labels":{"controller-uid":"old","app":"demo"}});
    let p = plan(&job, Some(&obj), None, "").unwrap();
    assert_eq!(p.preview.calls[0].path, "/apis/batch/v1/namespaces/default/jobs");
    assert!(p.preview.calls[0].body["spec"].get("selector").is_none());
    assert!(p.preview.calls[0].body.pointer("/spec/template/metadata/labels/controller-uid").is_none());
    assert_eq!(p.inverse.unwrap().target.name, "next");
}

#[test]
fn restart_is_not_reversible_and_rollout_replaces_the_template() {
    let restart = change("apps", "Deployment", Operation::Restart);
    let p = plan(&restart, Some(&object()), None, "2026-01-01T00:00:00Z").unwrap();
    assert!(p.inverse.is_none());
    assert_eq!(p.preview.diff[0].after, "2026-01-01T00:00:00Z");
    let rollback = change("apps", "Deployment", Operation::RolloutUndo { revision: "1".into() });
    let template = json!({"metadata":{"labels":{"app":"old"}},"spec":{"containers":[{"name":"old","image":"old"}]}});
    let p = plan(&rollback, Some(&object()), Some(&template), "").unwrap();
    assert_eq!(p.preview.diff[0].after, template);
    assert_eq!(p.preview.calls[0].body.pointer("/spec/template/$patch"), Some(&json!("replace")));
}

#[test]
fn change_contract_round_trips_camel_case() {
    let input = json!({"type":"rerun","kind":{"group":"batch","version":"v1","kind":"CronJob","plural":"cronjobs","namespaced":true},"namespace":"default","name":"nightly","jobName":"nightly-now"});
    let parsed: Change = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), input);
}

#[test]
fn system_namespace_and_cluster_scoped_deletion_require_exact_name() {
    let mut c = change("apps", "Deployment", Operation::Scale { replicas: 2 });
    c.target.namespace = Some("kube-system".into());
    let p = plan(&c, Some(&object()), None, "").unwrap();
    assert_eq!(p.preview.confirm_name.as_deref(), Some("sample"));
    assert!(commit::check(Some(&p), &p, Some("Sample")).is_err());
    let mut node = change("", "Node", Operation::Delete);
    node.target.kind.namespaced = false;
    node.target.namespace = None;
    node.target.kind.plural = "nodes".into();
    let obj = json!({"apiVersion":"v1","kind":"Node","metadata":{"name":"sample","resourceVersion":"1"}});
    let p = plan(&node, Some(&obj), None, "").unwrap();
    assert_eq!(p.preview.confirm_name.as_deref(), Some("sample"));
    assert_eq!(p.preview.calls[0].path, "/api/v1/nodes/sample");
}

#[test]
fn cordon_and_uncordon_preview_inverse_and_resource_version() {
    let mut node = change("", "Node", Operation::Cordon { unschedulable: true });
    node.target.kind.namespaced = false;
    node.target.kind.plural = "nodes".into();
    node.target.namespace = None;
    let obj = json!({"apiVersion":"v1","kind":"Node","metadata":{"name":"sample","resourceVersion":"7"},"spec":{}});
    let plan = plan(&node, Some(&obj), None, "").unwrap();
    assert_eq!(plan.preview.calls[0].body["metadata"]["resourceVersion"], "7");
    assert_eq!(plan.preview.diff[0].before, false);
    assert_eq!(plan.preview.diff[0].after, true);
    assert_eq!(plan.inverse.unwrap().operation, Operation::Cordon { unschedulable: false });
}
