use serde_json::json;

use super::*;
use crate::k8s::read::secret::{secrets_kind, MASK};

fn kind(group: &str, k: &str, plural: &str) -> KindRef {
    KindRef { group: group.into(), version: "v1".into(), kind: k.into(), plural: plural.into(), namespaced: true }
}

fn obj(v: serde_json::Value) -> DynamicObject {
    serde_json::from_value(v).unwrap()
}

fn pod() -> DynamicObject {
    obj(json!({
        "apiVersion": "v1", "kind": "Pod",
        "metadata": { "name": "web-1", "namespace": "prod", "uid": "p1", "resourceVersion": "9",
            "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "web-5d", "uid": "rs1", "controller": true }],
            "managedFields": [{ "manager": "kubelet" }] },
        "spec": {
            "initContainers": [{ "name": "init", "image": "busybox" }],
            "containers": [{ "name": "app", "image": "nginx:1.27" }, { "name": "side", "image": "envoy" }]
        },
        "status": {
            "phase": "Running",
            "conditions": [{ "type": "Ready", "status": "False", "reason": "ContainersNotReady", "message": "containers with unready status: [app]", "lastTransitionTime": "2026-10-30T01:00:00Z" }],
            "initContainerStatuses": [{ "name": "init", "ready": true, "restartCount": 0, "state": { "terminated": { "reason": "Completed", "exitCode": 0 } } }],
            "containerStatuses": [
                { "name": "app", "ready": false, "restartCount": 4, "state": { "waiting": { "reason": "CrashLoopBackOff", "message": "back-off 40s" } },
                  "lastState": { "terminated": { "reason": "OOMKilled", "exitCode": 137, "finishedAt": "2026-10-30T00:59:00Z" } } },
                { "name": "side", "ready": true, "restartCount": 0, "state": { "running": { "startedAt": "2026-10-30T00:00:00Z" } } }
            ]
        }
    }))
}

#[test]
fn api_versions_split_into_group_and_version() {
    assert_eq!(split_api_version("apps/v1"), ("apps".into(), "v1".into()));
    assert_eq!(split_api_version("v1"), ("".into(), "v1".into()));
}

#[test]
fn owners_come_from_owner_references() {
    assert_eq!(
        owners_of(&pod()),
        [Link { group: "apps".into(), version: "v1".into(), kind: "ReplicaSet".into(), name: "web-5d".into(), namespace: Some("prod".into()), uid: "rs1".into(), controller: true, problems: vec![] }]
    );
}

#[test]
fn pod_containers_carry_state_and_last_termination() {
    let c = containers_of(&kind("", "Pod", "pods"), &serde_json::to_value(pod()).unwrap());
    assert_eq!(c.iter().map(|c| (c.name.as_str(), c.init)).collect::<Vec<_>>(), [("init", true), ("app", false), ("side", false)]);
    assert_eq!((c[0].state, c[0].reason.as_deref()), (ContainerState::Terminated, Some("Completed")));
    assert_eq!((c[1].state, c[1].reason.as_deref(), c[1].message.as_deref(), c[1].restarts, c[1].ready), (ContainerState::Waiting, Some("CrashLoopBackOff"), Some("back-off 40s"), 4, false));
    assert_eq!(c[1].last_termination, Some(Termination { reason: Some("OOMKilled".into()), exit_code: 137, finished_at: Some("2026-10-30T00:59:00Z".into()) }));
    assert_eq!((c[2].state, c[2].ready, c[2].image.as_str()), (ContainerState::Running, true, "envoy"));
}

#[test]
fn workload_containers_come_from_the_template() {
    let d = json!({ "spec": { "template": { "spec": { "containers": [{ "name": "app", "image": "nginx" }] } } } });
    let c = containers_of(&kind("apps", "Deployment", "deployments"), &d);
    assert_eq!(c.len(), 1);
    assert_eq!((c[0].state, c[0].image.as_str()), (ContainerState::Template, "nginx"));
    let cj = json!({ "spec": { "jobTemplate": { "spec": { "template": { "spec": { "containers": [{ "name": "run", "image": "job" }] } } } } } });
    assert_eq!(containers_of(&kind("batch", "CronJob", "cronjobs"), &cj)[0].name, "run");
    assert!(containers_of(&kind("", "ConfigMap", "configmaps"), &json!({})).is_empty());
}

#[test]
fn conditions_are_listed() {
    let c = conditions_of(&serde_json::to_value(pod()).unwrap());
    assert_eq!(
        c,
        [Condition { type_: "Ready".into(), status: "False".into(), reason: Some("ContainersNotReady".into()), message: Some("containers with unready status: [app]".into()), last_transition: Some("2026-10-30T01:00:00Z".into()) }]
    );
}

#[test]
fn child_kinds_and_selector() {
    assert_eq!(child_kind(&kind("apps", "Deployment", "deployments")).map(|k| k.plural), Some("replicasets".into()));
    for (g, k, p) in [("apps", "ReplicaSet", "replicasets"), ("apps", "StatefulSet", "statefulsets"), ("apps", "DaemonSet", "daemonsets"), ("batch", "Job", "jobs")] {
        assert_eq!(child_kind(&kind(g, k, p)).map(|k| k.plural), Some("pods".into()), "{k}");
    }
    assert_eq!(child_kind(&kind("batch", "CronJob", "cronjobs")).map(|k| (k.group, k.plural)), Some(("batch".into(), "jobs".into())));
    assert_eq!(child_kind(&kind("", "Service", "services")), None);
    assert_eq!(selector_of(&json!({ "spec": { "selector": { "matchLabels": { "app": "web", "tier": "fe" } } } })), Some("app=web,tier=fe".into()));
    assert_eq!(selector_of(&json!({ "spec": { "selector": { "matchExpressions": [] } } })), None);
}

#[test]
fn children_are_filtered_by_owner_uid_and_carry_problems() {
    let child = |name: &str, owner: &str, phase: &str| {
        obj(json!({ "apiVersion": "v1", "kind": "Pod", "metadata": { "name": name, "namespace": "prod", "uid": format!("u-{name}"),
            "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "rs", "uid": owner }] },
            "spec": { "containers": [{ "name": "a", "image": "x" }] }, "status": { "phase": phase } }))
    };
    let pods = kind("", "Pod", "pods");
    let items = [child("b", "rs1", "Pending"), child("a", "rs1", "Running"), child("c", "other", "Running")];
    let links = children_of(&pods, "rs1", &items);
    assert_eq!(links.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    assert_eq!(links[1].problems, [Problem::Pending]);
    assert!(!links[0].controller);
}

#[test]
fn events_are_newest_first_and_capped() {
    let ev = |i: usize| {
        obj(json!({ "apiVersion": "v1", "kind": "Event", "metadata": { "name": format!("e{i}"), "namespace": "prod" },
            "type": if i.is_multiple_of(2) { "Normal" } else { "Warning" }, "reason": "R", "message": format!("m{i}"),
            "involvedObject": { "kind": "Pod", "name": "web-1" }, "source": { "component": "kubelet" },
            "lastTimestamp": format!("2026-10-30T{:02}:{:02}:00Z", i / 60, i % 60) }))
    };
    let items: Vec<DynamicObject> = (0..120).map(ev).collect();
    let got = events_of(&items);
    assert_eq!(got.len(), EVENTS_MAX);
    assert_eq!(got[0].message, "m119");
    assert_eq!((got[0].type_.as_str(), got[0].object.as_str(), got[0].source.as_deref(), got[0].count), ("Warning", "Pod/web-1", Some("kubelet"), 1));
}

#[test]
fn view_of_a_pod() {
    let v = view_of(&kind("", "Pod", "pods"), &pod()).unwrap();
    assert_eq!(v.row.name, "web-1");
    assert_eq!(v.owners.len(), 1);
    assert_eq!(v.containers.len(), 3);
    assert!(v.yaml.contains("web-1") && !v.yaml.contains("managedFields"));
    assert_eq!(v.secret_keys, None);
    assert!(v.children.is_empty() && v.events.is_empty());
}

#[test]
fn view_of_a_secret_masks_everything_but_counts_keys() {
    let s = obj(json!({ "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
        "metadata": { "name": "db", "namespace": "prod", "uid": "s1", "annotations": {
            "kubectl.kubernetes.io/last-applied-configuration": "{\"data\":{\"p\":\"aHVudGVyMg==\"}}", "team": "a" } },
        "data": { "p": "aHVudGVyMg==" } }));
    let v = view_of(&secrets_kind(), &s).unwrap();
    assert_eq!(v.secret_keys, Some(vec![SecretKey { key: "p".into(), size: 7 }]));
    assert_eq!(v.annotations.get(crate::k8s::read::secret::LAST_APPLIED).map(String::as_str), Some(MASK));
    assert_eq!(v.annotations.get("team").map(String::as_str), Some("a"));
    let all = serde_json::to_string(&v).unwrap();
    assert!(!all.contains("aHVudGVyMg==") && !all.contains("hunter2"), "{all}");
}

#[test]
fn object_view_json_keys_match_the_ts_contract() {
    let v = serde_json::to_value(view_of(&kind("", "Pod", "pods"), &pod()).unwrap()).unwrap();
    for key in ["kind", "row", "annotations", "owners", "children", "childrenTruncated", "childrenError", "containers", "conditions", "events", "eventsError", "yaml", "secretKeys"] {
        assert!(v.get(key).is_some(), "{key}");
    }
    assert_eq!(v["containers"][1]["lastTermination"]["exitCode"], json!(137));
    assert_eq!(v["containers"][1]["state"], json!("waiting"));
    assert_eq!(v["conditions"][0]["type"], json!("Ready"));
    assert_eq!(v["conditions"][0]["lastTransition"], json!("2026-10-30T01:00:00Z"));
}
