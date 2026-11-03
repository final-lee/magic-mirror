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

fn node_shell(pod: &str, node: &str, image: &str) -> Change {
    Change { target: pod_object("default", pod), operation: Operation::NodeShell { node: node.into(), image: image.into() } }
}

#[test]
fn danger_covers_system_and_prod_namespaces_and_prod_names() {
    assert!(dangerous(Some("kube-system"), "coredns"));
    assert!(dangerous(Some("shop-prod"), "web"));
    assert!(dangerous(Some("dev"), "Prod-db-0"));
    assert!(!dangerous(Some("dev"), "web-1"));
    assert!(!dangerous(None, "node-1"));
    assert_eq!(confirm_name(Some("kube-system"), "coredns").as_deref(), Some("coredns"));
    assert_eq!(confirm_name(Some("dev"), "web-1"), None);
}

#[test]
fn node_shell_previews_a_privileged_pod_pinned_to_the_node_and_needs_the_node_name() {
    let c = node_shell("mm-node-shell-1", "ip-10-0-1-2", "busybox:1.36");
    // 만들 Pod는 아직 없다: 읽은 객체 없이 계획한다
    let p = plan(&c, None, None, "").unwrap();
    let call = &p.preview.calls[0];
    assert_eq!((call.verb.as_str(), call.path.as_str()), ("POST", "/api/v1/namespaces/default/pods"));
    assert_eq!(call.body["spec"]["nodeName"], "ip-10-0-1-2");
    assert_eq!(call.body["spec"]["containers"][0]["image"], "busybox:1.36");
    assert_eq!(call.body["spec"]["containers"][0]["securityContext"]["privileged"], true);
    assert!(["hostPID", "hostNetwork", "hostIPC"].iter().all(|k| call.body["spec"][k] == true));
    assert_eq!(call.body["spec"]["volumes"][0]["hostPath"]["path"], "/");
    assert_eq!(call.body["spec"]["containers"][0]["volumeMounts"][0]["mountPath"], "/host");
    // 앱이 지울 Pod를 알아보는 표시
    assert_eq!(call.body["metadata"]["labels"][NODE_SHELL_MANAGED_KEY], NODE_SHELL_MANAGED_VALUE);
    assert_eq!(call.body["metadata"]["labels"][NODE_SHELL_LABEL], "true");
    assert!(!p.preview.warnings.is_empty() && !p.preview.reversible && p.inverse.is_none());
    // 이름 입력은 늘 필요하고, 입력할 이름은 노드 이름이다
    assert_eq!(p.preview.confirm_name.as_deref(), Some("ip-10-0-1-2"));
    assert!(commit::check(Some(&p), &p, None).is_err());
    assert!(commit::check(Some(&p), &p, Some("mm-node-shell-1")).is_err());
    assert!(commit::check(Some(&p), &p, Some("ip-10-0-1-2")).is_ok());
}

#[test]
fn node_shell_image_is_editable_and_the_same_request_plans_the_same_way() {
    let a = plan(&node_shell("mm-node-shell-1", "n", "alpine:3.20"), None, None, "").unwrap();
    let b = plan(&node_shell("mm-node-shell-1", "n", "alpine:3.20"), None, None, "later").unwrap();
    assert_eq!(a.preview.calls[0].body["spec"]["containers"][0]["image"], "alpine:3.20");
    // 재확인이 미리보기와 같은 계획으로 통과해야 적용된다
    assert!(same_except_version(&a, &b));
}

#[test]
fn node_shell_rejects_bad_names_and_images() {
    for (pod, node, image) in [("", "n", "i"), ("Has-Upper", "n", "i"), ("-lead", "n", "i"), ("trail-", "n", "i"), ("ok", "", "i"), ("ok", "n", ""), ("ok", "n", "bad image"), ("ok", "n", "bad\nimage")] {
        assert!(plan(&node_shell(pod, node, image), None, None, "").is_err(), "{pod:?} {node:?} {image:?}");
    }
    assert!(plan(&node_shell(&"a".repeat(64), "n", "i"), None, None, "").is_err());
    assert!(plan(&node_shell(&"a".repeat(63), "n", "i"), None, None, "").is_ok());
}

#[test]
fn a_shell_record_is_not_a_plannable_change() {
    let c = Change { target: pod_object("default", "web-1"), operation: Operation::Shell { container: "app".into(), mode: ShellMode::Exec } };
    assert!(plan(&c, Some(&json!({"metadata":{"resourceVersion":"1"}})), None, "").is_err());
}

fn apply_change(operation_object: Value, force: bool) -> Change {
    change("apps", "Deployment", Operation::Apply { object: operation_object, force })
}

#[test]
fn apply_plans_a_field_manager_call_and_re_applies_the_cleaned_object_as_inverse() {
    let mut edited = object();
    edited["spec"]["replicas"] = json!(5);
    let c = apply_change(edited, false);
    let p = plan(&c, Some(&object()), None, "").unwrap();
    let call = &p.preview.calls[0];
    assert_eq!(call.verb, "PATCH");
    assert_eq!(call.path, "/apis/apps/v1/namespaces/default/deployments/sample?fieldManager=magic-mirror");
    assert_eq!(call.body["metadata"]["resourceVersion"], "12");
    assert!(call.body.get("status").is_none());
    assert_eq!(p.preview.impact, ["Deployment sample: server-side apply로 객체를 바꿉니다"]);
    assert!(p.preview.confirm_name.is_none());
    let Operation::Apply { object: before, force } = p.inverse.unwrap().operation else { panic!("역변경이 apply가 아니에요") };
    assert!(!force);
    assert_eq!(before["spec"]["replicas"], 3);
    assert!(before.get("status").is_none());
    assert!(before["metadata"].get("uid").is_none());
    assert!(before["metadata"].get("resourceVersion").is_none());
}

#[test]
fn applying_a_missing_object_creates_it_and_undo_deletes_it() {
    let c = apply_change(object(), false);
    let p = plan(&c, None, None, "").unwrap();
    assert!(p.preview.calls[0].body["metadata"].get("resourceVersion").is_none());
    assert_eq!(p.preview.impact, ["Deployment sample: 새 객체를 만듭니다"]);
    assert_eq!(p.inverse.unwrap().operation, Operation::Delete);
    let mut versionless = object();
    versionless["metadata"].as_object_mut().unwrap().remove("resourceVersion");
    assert!(plan(&c, Some(&versionless), None, "").is_err());
}

#[test]
fn forcing_requires_the_exact_name_and_is_marked_in_the_call() {
    let forced = apply_change(object(), true);
    let p = plan(&forced, Some(&object()), None, "").unwrap();
    assert!(p.preview.calls[0].path.ends_with("?fieldManager=magic-mirror&force=true"));
    assert_eq!(p.preview.confirm_name.as_deref(), Some("sample"));
    assert!(p.preview.warnings.contains(&FORCE_WARNING.to_string()));
    assert!(commit::check(Some(&p), &p, None).is_err());
    assert!(commit::check(Some(&p), &p, Some("sample")).is_ok());
    let plain = plan(&apply_change(object(), false), Some(&object()), None, "").unwrap();
    assert!(plain.preview.confirm_name.is_none());
}

#[test]
fn a_preview_with_conflicts_cannot_be_applied_even_with_the_name() {
    let c = apply_change(object(), true);
    let mut p = plan(&c, Some(&object()), None, "").unwrap();
    p.preview.conflicts = vec![apply::FieldConflict { field: ".spec.replicas".into(), manager: "kubectl".into() }];
    assert_eq!(commit::check(Some(&p), &p, Some("sample")), Err(AppError::other(crate::k8s::exec::CONFLICT)));
}

#[test]
fn dangerous_apply_targets_need_the_name_without_force() {
    let mut c = apply_change(object(), false);
    c.target.namespace = Some("kube-system".into());
    let mut obj = object();
    obj["metadata"]["namespace"] = json!("kube-system");
    let mut edited = obj.clone();
    edited["spec"]["replicas"] = json!(1);
    c.operation = Operation::Apply { object: edited, force: false };
    let p = plan(&c, Some(&obj), None, "").unwrap();
    assert_eq!(p.preview.confirm_name.as_deref(), Some("sample"));
    c.target.name = "prod-api".into();
    c.target.namespace = Some("default".into());
    let mut named = object();
    named["metadata"]["name"] = json!("prod-api");
    c.operation = Operation::Apply { object: named.clone(), force: false };
    assert_eq!(plan(&c, Some(&named), None, "").unwrap().preview.confirm_name.as_deref(), Some("prod-api"));
}

#[test]
fn aws_auth_edits_warn_to_move_to_access_entries() {
    let mut c = change("", "ConfigMap", Operation::Apply { object: json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"aws-auth","namespace":"kube-system"},"data":{}}), force: false });
    c.target.name = "aws-auth".into();
    c.target.namespace = Some("kube-system".into());
    let current = json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"aws-auth","namespace":"kube-system","resourceVersion":"1"}});
    let p = plan(&c, Some(&current), None, "").unwrap();
    assert!(p.preview.warnings.contains(&AWS_AUTH_WARNING.to_string()));
}

#[test]
fn secret_apply_is_irreversible_and_never_shows_values() {
    let object = json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"sample","namespace":"default"},"data":{"keep":"••••"},"stringData":{"fresh":"hunter2"}});
    let c = change("", "Secret", Operation::Apply { object, force: false });
    let current = json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"sample","namespace":"default","resourceVersion":"3"},"data":{"keep":"a2VlcA=="}});
    let p = plan(&c, Some(&current), None, "").unwrap();
    assert!(p.inverse.is_none());
    assert!(!p.preview.reversible);
    assert!(p.preview.warnings.contains(&SECRET_APPLY_WARNING.to_string()));
    // 서버로 가는 본문에는 실제 값이 있고, 화면으로 가는 사본에는 없다
    assert_eq!(p.preview.calls[0].body["data"]["keep"], "a2VlcA==");
    let shown = serde_json::to_string(&p.preview.displayed()).unwrap();
    assert!(!shown.contains("a2VlcA==") && !shown.contains("hunter2"));
}

#[test]
fn apply_contract_round_trips_camel_case() {
    let input = json!({"type":"apply","kind":{"group":"apps","version":"v1","kind":"Deployment","plural":"deployments","namespaced":true},"namespace":"default","name":"web","object":{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web"}},"force":true});
    let parsed: Change = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), input);
    let without_force: Change = serde_json::from_value(json!({"type":"apply","kind":{"group":"","version":"v1","kind":"ConfigMap","plural":"configmaps","namespaced":true},"namespace":"d","name":"c","object":{}})).unwrap();
    assert!(matches!(without_force.operation, Operation::Apply { force: false, .. }));
}

#[test]
fn status_only_changes_keep_an_apply_preview_valid() {
    let c = apply_change(object(), false);
    let first = plan(&c, Some(&object()), None, "").unwrap();
    let mut changed = object();
    changed["metadata"]["resourceVersion"] = json!("13");
    changed["status"]["readyReplicas"] = json!(1);
    let second = plan(&c, Some(&changed), None, "").unwrap();
    assert!(commit::check(Some(&first), &second, None).is_ok());
    changed["spec"]["replicas"] = json!(9);
    let third = plan(&c, Some(&changed), None, "").unwrap();
    assert!(commit::check(Some(&first), &third, None).is_err());
}

fn job_object() -> Value {
    json!({"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"sample","namespace":"default","resourceVersion":"3","uid":"u",
        "labels":{"controller-uid":"u","batch.kubernetes.io/controller-uid":"u","job-name":"sample","batch.kubernetes.io/job-name":"sample","app":"x"}},
        "spec":{"completions":1,"selector":{"matchLabels":{"batch.kubernetes.io/controller-uid":"u"}},
            "template":{"metadata":{"labels":{"controller-uid":"u","batch.kubernetes.io/controller-uid":"u","job-name":"sample","batch.kubernetes.io/job-name":"sample","app":"x"}},"spec":{"restartPolicy":"Never","containers":[]}}},
        "status":{"succeeded":1}})
}

#[test]
fn deleting_an_unowned_job_records_an_object_without_generated_selector_and_labels() {
    let c = change("batch", "Job", Operation::Delete);
    let p = plan(&c, Some(&job_object()), None, "").unwrap();
    let Operation::Recreate { object } = p.inverse.unwrap().operation else { panic!("역변경이 아니에요") };
    assert!(object["spec"].get("selector").is_none());
    assert!(object["spec"].get("manualSelector").is_none());
    assert_eq!(object["spec"]["template"]["metadata"]["labels"], json!({"app":"x"}));
    assert_eq!(object["metadata"]["labels"], json!({"app":"x"}));
    assert!(object.get("status").is_none());
    assert_eq!(object["spec"]["completions"], 1);
}

#[test]
fn a_job_with_a_manual_selector_keeps_it_when_recreated() {
    let mut job = job_object();
    job["spec"]["manualSelector"] = json!(true);
    job["spec"]["selector"] = json!({"matchLabels":{"app":"x"}});
    let p = plan(&change("batch", "Job", Operation::Delete), Some(&job), None, "").unwrap();
    let Operation::Recreate { object } = p.inverse.unwrap().operation else { panic!("역변경이 아니에요") };
    assert_eq!(object["spec"]["selector"], json!({"matchLabels":{"app":"x"}}));
    assert_eq!(object["spec"]["manualSelector"], true);
    assert_eq!(object["spec"]["template"]["metadata"]["labels"]["controller-uid"], "u");
}

#[test]
fn other_kinds_keep_such_labels_when_deleted_and_recreated() {
    let mut deploy = object();
    deploy["spec"]["selector"] = json!({"matchLabels":{"job-name":"keep"}});
    let p = plan(&change("apps", "Deployment", Operation::Delete), Some(&deploy), None, "").unwrap();
    let Operation::Recreate { object } = p.inverse.unwrap().operation else { panic!("역변경이 아니에요") };
    assert_eq!(object["spec"]["selector"]["matchLabels"]["job-name"], "keep");
}

fn binding(kind: &str, role: &str, role_kind: &str) -> Value {
    json!({"apiVersion":"rbac.authorization.k8s.io/v1","kind":kind,"metadata":{"name":"sample","namespace":"default"},
        "roleRef":{"apiGroup":"rbac.authorization.k8s.io","kind":role_kind,"name":role},"subjects":[{"kind":"User","name":"u"}]})
}

fn binding_change(kind: &str, object: Value) -> Change {
    let mut c = change("rbac.authorization.k8s.io", kind, Operation::Apply { object, force: false });
    c.target.kind.namespaced = kind == "RoleBinding";
    c.target.namespace = (kind == "RoleBinding").then(|| "default".to_string());
    if kind == "ClusterRoleBinding" {
        if let Operation::Apply { object, .. } = &mut c.operation {
            object["metadata"].as_object_mut().unwrap().remove("namespace");
        }
    }
    c
}

#[test]
fn applying_a_cluster_admin_binding_needs_the_name() {
    for kind in ["RoleBinding", "ClusterRoleBinding"] {
        let granted = binding_change(kind, binding(kind, "cluster-admin", "ClusterRole"));
        let p = plan(&granted, None, None, "").unwrap();
        assert_eq!(p.preview.confirm_name.as_deref(), Some("sample"), "{kind}");
        assert!(commit::check(Some(&p), &p, None).is_err());
        assert!(commit::check(Some(&p), &p, Some("sample")).is_ok());
        let ordinary = binding_change(kind, binding(kind, "view", "ClusterRole"));
        assert!(plan(&ordinary, None, None, "").unwrap().preview.confirm_name.is_none(), "{kind}");
        // 같은 이름의 Role(ClusterRole이 아님)은 cluster-admin이 아니다
        let role = binding_change(kind, binding(kind, "cluster-admin", "Role"));
        assert!(plan(&role, None, None, "").unwrap().preview.confirm_name.is_none(), "{kind}");
    }
}

#[test]
fn changing_subjects_of_an_existing_cluster_admin_binding_needs_the_name() {
    let mut current = binding("ClusterRoleBinding", "cluster-admin", "ClusterRole");
    current["metadata"]["resourceVersion"] = json!("7");
    current["metadata"].as_object_mut().unwrap().remove("namespace");
    // 고친 문서가 roleRef를 바꿔도(서버가 거절하겠지만) 현재 객체가 cluster-admin이면 이름을 입력받는다
    let mut edited = binding("ClusterRoleBinding", "view", "ClusterRole");
    edited["subjects"] = json!([{"kind":"User","name":"other"}]);
    let c = binding_change("ClusterRoleBinding", edited);
    assert_eq!(plan(&c, Some(&current), None, "").unwrap().preview.confirm_name.as_deref(), Some("sample"));
}

#[test]
fn recreating_a_cluster_admin_binding_needs_the_name() {
    let mut c = binding_change("RoleBinding", binding("RoleBinding", "cluster-admin", "ClusterRole"));
    if let Operation::Apply { object, .. } = c.operation.clone() {
        c.operation = Operation::Recreate { object };
    }
    let p = plan(&c, None, None, "").unwrap();
    assert_eq!(p.preview.confirm_name.as_deref(), Some("sample"));
}

#[test]
fn rerun_still_drops_the_generated_selector_and_labels() {
    let job = change("batch", "Job", Operation::Rerun { job_name: "next".into() });
    let p = plan(&job, Some(&job_object()), None, "").unwrap();
    let spec = &p.preview.calls[0].body["spec"];
    assert!(spec.get("selector").is_none());
    assert_eq!(spec["template"]["metadata"]["labels"], json!({"app":"x"}));
}
