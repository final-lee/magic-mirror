use super::*;
use crate::k8s::change::ChangeObject;
use crate::k8s::rows::KindRef;

fn node(cordoned: bool) -> Value {
    json!({
        "apiVersion": "v1",
        "kind": "Node",
        "metadata": {"name": "worker", "resourceVersion": "9", "managedFields": [{}]},
        "spec": {"unschedulable": cordoned},
        "status": {"conditions": []},
    })
}

fn pod(namespace: &str, name: &str, extra: Value) -> Value {
    let mut base = json!({
        "metadata": {
            "namespace": namespace,
            "name": name,
            "uid": format!("uid-{name}"),
            "labels": {"app": name},
            "ownerReferences": [{"kind": "ReplicaSet", "name": "rs", "controller": true}],
        },
        "spec": {"nodeName": "worker", "containers": []},
        "status": {"phase": "Running"},
    });
    for (path, value) in extra.as_object().cloned().unwrap_or_default() {
        if let Some(slot) = base.pointer_mut(&path) {
            *slot = value;
            continue;
        }
        let (parent, key) = path.rsplit_once('/').unwrap();
        base.pointer_mut(parent).unwrap().as_object_mut().unwrap().insert(key.into(), value);
    }
    base
}

fn budget(namespace: &str, name: &str, selector: Value, allowed: i64) -> Value {
    json!({
        "metadata": {"namespace": namespace, "name": name},
        "spec": {"selector": selector},
        "status": {"disruptionsAllowed": allowed},
    })
}

fn drain_change() -> Change {
    Change {
        target: ChangeObject {
            kind: KindRef { group: String::new(), version: "v1".into(), kind: "Node".into(), plural: "nodes".into(), namespaced: false },
            namespace: None,
            name: "worker".into(),
        },
        operation: Operation::Drain,
    }
}

fn names(pods: &[DrainPod]) -> Vec<&str> {
    pods.iter().map(|pod| pod.name.as_str()).collect()
}

#[test]
fn ordinary_pods_are_evicted_in_name_order() {
    let pods = [pod("b", "z", json!({})), pod("a", "y", json!({})), pod("a", "x", json!({}))];
    let plan = plan_drain(&node(false), &pods, Some(&[]));
    assert_eq!(names(&plan.evict), ["x", "y", "z"]);
    assert!(plan.skipped.is_empty());
    assert!(plan.evict.iter().all(|p| !p.empty_dir && !p.unmanaged && p.blocked_by.is_none()));
    assert_eq!(plan.evict[0].uid, "uid-x");
    assert!(!plan.node_cordoned);
}

#[test]
fn daemonset_pods_are_skipped_not_evicted() {
    let owners = json!([{"kind": "DaemonSet", "name": "ds", "controller": true}]);
    let pods = [pod("kube-system", "proxy", json!({"/metadata/ownerReferences": owners})), pod("app", "web", json!({}))];
    let plan = plan_drain(&node(false), &pods, Some(&[]));
    assert_eq!(names(&plan.evict), ["web"]);
    assert_eq!(plan.skipped, vec![SkippedPod { namespace: "kube-system".into(), name: "proxy".into(), reason: SkipReason::DaemonSet }]);
}

#[test]
fn mirror_pods_are_skipped_even_without_an_owner() {
    let annotations = json!({"kubernetes.io/config.mirror": "abc"});
    let pods = [pod("kube-system", "etcd", json!({"/metadata/annotations": annotations, "/metadata/ownerReferences": []}))];
    let plan = plan_drain(&node(false), &pods, Some(&[]));
    assert!(plan.evict.is_empty());
    assert_eq!(plan.skipped[0].reason, SkipReason::Mirror);
}

#[test]
fn terminating_pods_are_skipped() {
    let pods = [pod("app", "old", json!({"/metadata/deletionTimestamp": "2026-01-01T00:00:00Z"}))];
    let plan = plan_drain(&node(false), &pods, Some(&[]));
    assert!(plan.evict.is_empty());
    assert_eq!(plan.skipped[0].reason, SkipReason::Terminating);
}

#[test]
fn empty_dir_volumes_are_flagged_and_warned() {
    let volumes = json!([{"name": "cache", "emptyDir": {}}, {"name": "cfg", "configMap": {"name": "c"}}]);
    let pods = [pod("app", "cache", json!({"/spec/volumes": volumes})), pod("app", "plain", json!({}))];
    let plan = plan_drain(&node(false), &pods, Some(&[]));
    assert!(plan.evict[0].empty_dir);
    assert!(!plan.evict[1].empty_dir);
    let preview = preview(&drain_change(), &node(false), plan).unwrap().preview;
    assert_eq!(preview.warnings, vec![format!("{EMPTY_DIR_WARNING} 1개: app/cache")]);
}

#[test]
fn pods_without_a_controller_are_flagged_and_warned() {
    let pods = [pod("app", "bare", json!({"/metadata/ownerReferences": []})), pod("app", "owned", json!({}))];
    let plan = plan_drain(&node(false), &pods, Some(&[]));
    assert!(plan.evict[0].unmanaged);
    assert!(!plan.evict[1].unmanaged);
    let preview = preview(&drain_change(), &node(false), plan).unwrap().preview;
    assert_eq!(preview.warnings, vec![format!("{UNMANAGED_WARNING} 1개: app/bare")]);
}

#[test]
fn an_owner_that_is_not_the_controller_does_not_count() {
    let owners = json!([{"kind": "Deployment", "name": "d"}]);
    let pods = [pod("app", "loose", json!({"/metadata/ownerReferences": owners}))];
    assert!(plan_drain(&node(false), &pods, Some(&[])).evict[0].unmanaged);
}

#[test]
fn finished_pods_are_evicted_without_data_loss_warnings() {
    let volumes = json!([{"name": "cache", "emptyDir": {}}]);
    let pods = [pod("app", "done", json!({"/status/phase": "Succeeded", "/metadata/ownerReferences": [], "/spec/volumes": volumes}))];
    let plan = plan_drain(&node(false), &pods, Some(&[]));
    assert_eq!(names(&plan.evict), ["done"]);
    assert!(!plan.evict[0].empty_dir && !plan.evict[0].unmanaged);
}

#[test]
fn a_budget_with_no_disruptions_left_blocks_the_pods_it_selects() {
    let budgets = [
        budget("app", "web-pdb", json!({"matchLabels": {"app": "web"}}), 0),
        budget("app", "api-pdb", json!({"matchLabels": {"app": "api"}}), 1),
        budget("other", "web-pdb-other", json!({"matchLabels": {"app": "web"}}), 0),
    ];
    let pods = [pod("app", "web", json!({})), pod("app", "api", json!({})), pod("app", "free", json!({}))];
    let plan = plan_drain(&node(false), &pods, Some(&budgets));
    let blocked: Vec<(&str, Option<&str>)> = plan.evict.iter().map(|p| (p.name.as_str(), p.blocked_by.as_deref())).collect();
    assert_eq!(blocked, [("api", None), ("free", None), ("web", Some("web-pdb"))]);
    let preview = preview(&drain_change(), &node(false), plan).unwrap().preview;
    assert_eq!(preview.warnings, vec![format!("{BLOCKED_WARNING} 1개: app/web")]);
}

#[test]
fn budget_selectors_use_expressions_and_empty_selectors_select_everything() {
    let expression = json!({"matchExpressions": [{"key": "app", "operator": "In", "values": ["web", "x"]}, {"key": "tier", "operator": "DoesNotExist"}]});
    let budgets = [budget("app", "expr", expression, 0)];
    let pods = [pod("app", "web", json!({})), pod("app", "api", json!({}))];
    let plan = plan_drain(&node(false), &pods, Some(&budgets));
    assert_eq!(plan.evict.iter().filter(|p| p.blocked_by.is_some()).map(|p| p.name.as_str()).collect::<Vec<_>>(), ["web"]);

    let everything = [budget("app", "all", json!({}), 0)];
    assert!(plan_drain(&node(false), &pods, Some(&everything)).evict.iter().all(|p| p.blocked_by.as_deref() == Some("all")));

    let nothing = [json!({"metadata": {"namespace": "app", "name": "none"}, "spec": {}, "status": {"disruptionsAllowed": 0}})];
    assert!(plan_drain(&node(false), &pods, Some(&nothing)).evict.iter().all(|p| p.blocked_by.is_none()));
}

#[test]
fn unreadable_budgets_are_reported_instead_of_assumed_clear() {
    let plan = plan_drain(&node(false), &[pod("app", "web", json!({}))], None);
    assert!(plan.budgets_unknown);
    let preview = preview(&drain_change(), &node(false), plan).unwrap().preview;
    assert_eq!(preview.warnings, vec![BUDGETS_UNKNOWN_WARNING.to_string()]);
}

#[test]
fn long_name_lists_are_cut_in_warnings_but_kept_in_the_plan() {
    let pods: Vec<Value> = (0..7).map(|n| pod("app", &format!("p{n}"), json!({"/metadata/ownerReferences": []}))).collect();
    let plan = plan_drain(&node(false), &pods, Some(&[]));
    assert_eq!(plan.evict.len(), 7);
    let preview = preview(&drain_change(), &node(false), plan).unwrap().preview;
    assert_eq!(preview.warnings[0], format!("{UNMANAGED_WARNING} 7개: app/p0, app/p1, app/p2, app/p3, app/p4 외 2개"));
}

#[test]
fn preview_always_requires_the_node_name_and_lists_cordon_then_evictions() {
    let plan = plan_drain(&node(false), &[pod("app", "web", json!({}))], Some(&[]));
    let result = preview(&drain_change(), &node(false), plan).unwrap();
    assert_eq!(result.preview.confirm_name.as_deref(), Some("worker"));
    assert_eq!(result.preview.calls[0].verb, "PATCH");
    assert_eq!(result.preview.calls[0].path, "/api/v1/nodes/worker");
    assert_eq!(result.preview.calls[0].body["metadata"]["resourceVersion"], "9");
    assert_eq!(result.preview.calls[0].body["spec"]["unschedulable"], true);
    assert_eq!(result.preview.calls[1].verb, "POST");
    assert_eq!(result.preview.calls[1].path, "/api/v1/namespaces/app/pods/web/eviction");
    assert_eq!(result.preview.calls[1].body["deleteOptions"]["preconditions"]["uid"], "uid-web");
    assert_eq!(result.preview.diff[0].path, "spec.unschedulable");
    assert!(result.preview.drain.is_some());
    assert_eq!(result.version.as_deref(), Some("9"));
}

#[test]
fn undo_is_uncordon_only_and_only_when_the_drain_cordoned_the_node() {
    let fresh = preview(&drain_change(), &node(false), plan_drain(&node(false), &[], Some(&[]))).unwrap();
    assert!(fresh.preview.reversible);
    assert_eq!(fresh.inverse.unwrap().operation, Operation::Cordon { unschedulable: false });

    let already = preview(&drain_change(), &node(true), plan_drain(&node(true), &[], Some(&[]))).unwrap();
    assert!(!already.preview.reversible);
    assert!(already.inverse.is_none());
    assert_eq!(already.preview.diff[0].before, true);
}

#[test]
fn preview_rejects_other_targets_and_missing_versions() {
    let drain = plan_drain(&node(false), &[], Some(&[]));
    let mut pod_target = drain_change();
    pod_target.target.kind.kind = "Pod".into();
    assert_eq!(preview(&pod_target, &node(false), drain.clone()).unwrap_err(), AppError::other(INVALID_CHANGE));
    let mut unversioned = node(false);
    unversioned["metadata"].as_object_mut().unwrap().remove("resourceVersion");
    assert_eq!(preview(&drain_change(), &unversioned, drain).unwrap_err(), AppError::other(MISSING_VERSION));
}

#[test]
fn same_targets_ignores_budget_changes_but_not_new_pods() {
    let pods = [pod("app", "web", json!({}))];
    let seen = plan_drain(&node(false), &pods, Some(&[]));
    let blocked = plan_drain(&node(false), &pods, Some(&[budget("app", "b", json!({}), 0)]));
    assert!(same_targets(&seen, &blocked));
    let more = [pod("app", "web", json!({})), pod("app", "new", json!({}))];
    assert!(!same_targets(&seen, &plan_drain(&node(false), &more, Some(&[]))));
    let replaced = [pod("app", "web", json!({"/metadata/uid": "other"}))];
    assert!(!same_targets(&seen, &plan_drain(&node(false), &replaced, Some(&[]))));
}

#[test]
fn the_drain_change_is_a_bare_type_tag_on_the_wire() {
    let json = serde_json::to_value(drain_change()).unwrap();
    assert_eq!(json["type"], "drain");
    assert_eq!(json["name"], "worker");
    assert_eq!(serde_json::from_value::<Change>(json).unwrap(), drain_change());
}

#[test]
fn applying_needs_the_same_targets_and_the_typed_node_name() {
    use crate::k8s::commit::{check_drain, CONFIRM_REQUIRED};
    use crate::k8s::exec::STALE;
    let pods = [pod("app", "web", json!({}))];
    let make = |pods: &[Value], node: &Value| preview(&drain_change(), node, plan_drain(node, pods, Some(&[]))).unwrap();
    let seen = make(&pods, &node(false));
    assert_eq!(check_drain(Some(&seen), &seen, Some("worker")), Ok(()));
    assert_eq!(check_drain(Some(&seen), &seen, None), Err(AppError::other(CONFIRM_REQUIRED)));
    assert_eq!(check_drain(Some(&seen), &seen, Some("Worker")), Err(AppError::other(CONFIRM_REQUIRED)));
    assert_eq!(check_drain(None, &seen, Some("worker")), Err(AppError::other(STALE)));
    // 새 resourceVersion과 status 변화만으로는 멈추지 않는다
    let mut refreshed = node(false);
    refreshed["metadata"]["resourceVersion"] = json!("10");
    refreshed["status"] = json!({"conditions": [{"type": "Ready"}]});
    assert_eq!(check_drain(Some(&seen), &make(&pods, &refreshed), Some("worker")), Ok(()));
    // 옮길 Pod가 늘었거나 노드 spec이 바뀌면 멈춘다
    let more = [pod("app", "web", json!({})), pod("app", "new", json!({}))];
    assert_eq!(check_drain(Some(&seen), &make(&more, &node(false)), Some("worker")), Err(AppError::other(STALE)));
    assert_eq!(check_drain(Some(&seen), &make(&pods, &node(true)), Some("worker")), Err(AppError::other(STALE)));
}
