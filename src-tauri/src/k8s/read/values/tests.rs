use serde_json::json;

use super::*;

fn kind(group: &str, kind: &str) -> KindRef {
    KindRef { group: group.into(), version: "v1".into(), kind: kind.into(), plural: format!("{}s", kind.to_lowercase()), namespaced: true }
}

fn obj(v: serde_json::Value) -> DynamicObject {
    let mut v = v;
    v["metadata"]["name"] = json!("x");
    v["metadata"]["uid"] = json!("u");
    serde_json::from_value(v).unwrap()
}

fn get<'a>(v: &'a Values, k: &str) -> Option<&'a str> {
    v.values.get(k).map(String::as_str)
}

fn pod(status: serde_json::Value) -> Values {
    let o = obj(json!({
        "apiVersion": "v1", "kind": "Pod", "metadata": {},
        "spec": { "nodeName": "ip-10-0-1-2", "containers": [{ "name": "app", "image": "a" }, { "name": "side", "image": "b" }] },
        "status": status
    }));
    values_of(&kind("", "Pod"), &o)
}

fn running(name: &str, ready: bool, restarts: i64) -> serde_json::Value {
    json!({ "name": name, "ready": ready, "restartCount": restarts, "state": { "running": {} } })
}

#[test]
fn running_ready_pod() {
    let v = pod(json!({ "phase": "Running", "podIP": "10.0.1.9", "containerStatuses": [running("app", true, 1), running("side", true, 2)] }));
    assert_eq!(get(&v, "ready"), Some("2/2"));
    assert_eq!(get(&v, "restarts"), Some("3"));
    assert_eq!(get(&v, "status"), Some("Running"));
    assert_eq!(get(&v, "node"), Some("ip-10-0-1-2"));
    assert_eq!(get(&v, "ip"), Some("10.0.1.9"));
    assert!(v.problems.is_empty());
}

#[test]
fn crash_looping_pod_is_flagged_and_not_ready() {
    let v = pod(json!({ "phase": "Running", "containerStatuses": [
        { "name": "app", "ready": false, "restartCount": 7, "state": { "waiting": { "reason": "CrashLoopBackOff" } }, "lastState": { "terminated": { "reason": "Error", "exitCode": 1 } } },
        running("side", true, 0)
    ] }));
    assert_eq!(get(&v, "status"), Some("CrashLoopBackOff"));
    assert_eq!(get(&v, "ready"), Some("1/2"));
    assert_eq!(v.problems, [Problem::CrashLoopBackOff, Problem::NotReady]);
}

#[test]
fn image_pull_failure_while_pending() {
    for reason in ["ImagePullBackOff", "ErrImagePull"] {
        let v = pod(json!({ "phase": "Pending", "containerStatuses": [{ "name": "app", "ready": false, "restartCount": 0, "state": { "waiting": { "reason": reason } } }] }));
        assert_eq!(get(&v, "status"), Some(reason));
        assert_eq!(v.problems, [Problem::ImagePullBackOff, Problem::Pending]);
    }
}

#[test]
fn oom_killed_in_the_last_state_is_flagged() {
    let v = pod(json!({ "phase": "Running", "containerStatuses": [
        { "name": "app", "ready": true, "restartCount": 1, "state": { "running": {} }, "lastState": { "terminated": { "reason": "OOMKilled", "exitCode": 137 } } },
        running("side", true, 0)
    ] }));
    assert_eq!(v.problems, [Problem::OomKilled]);
}

#[test]
fn init_container_reason_comes_first_with_a_prefix() {
    let v = pod(json!({ "phase": "Pending",
        "initContainerStatuses": [{ "name": "init", "ready": false, "restartCount": 3, "state": { "waiting": { "reason": "CrashLoopBackOff" } } }],
        "containerStatuses": [{ "name": "app", "ready": false, "restartCount": 0, "state": { "waiting": { "reason": "PodInitializing" } } }] }));
    assert_eq!(get(&v, "status"), Some("Init:CrashLoopBackOff"));
    assert_eq!(v.problems, [Problem::CrashLoopBackOff, Problem::Pending]);
}

#[test]
fn finished_init_containers_are_skipped() {
    let v = pod(json!({ "phase": "Running",
        "initContainerStatuses": [{ "name": "init", "ready": true, "restartCount": 0, "state": { "terminated": { "reason": "Completed", "exitCode": 0 } } }],
        "containerStatuses": [running("app", true, 0), running("side", true, 0)] }));
    assert_eq!(get(&v, "status"), Some("Running"));
}

#[test]
fn deleting_pod_is_terminating() {
    let mut o = obj(json!({ "apiVersion": "v1", "kind": "Pod", "metadata": { "deletionTimestamp": "2026-10-30T01:00:00Z" }, "spec": { "containers": [] }, "status": { "phase": "Running" } }));
    o.metadata.namespace = Some("web".into());
    assert_eq!(values_of(&kind("", "Pod"), &o).values.get("status").map(String::as_str), Some("Terminating"));
}

#[test]
fn evicted_pod_shows_the_status_reason() {
    let v = pod(json!({ "phase": "Failed", "reason": "Evicted" }));
    assert_eq!(get(&v, "status"), Some("Evicted"));
}

#[test]
fn deployment_ready_counts_and_not_ready() {
    let d = |spec: serde_json::Value, status: serde_json::Value| values_of(&kind("apps", "Deployment"), &obj(json!({ "apiVersion": "apps/v1", "kind": "Deployment", "metadata": {}, "spec": spec, "status": status })));
    let v = d(json!({ "replicas": 3 }), json!({ "readyReplicas": 2, "updatedReplicas": 3, "availableReplicas": 2 }));
    assert_eq!((get(&v, "ready"), get(&v, "upToDate"), get(&v, "available")), (Some("2/3"), Some("3"), Some("2")));
    assert_eq!(v.problems, [Problem::NotReady]);
    // replicas가 없으면 1, 0으로 줄인 것은 문제가 아니다
    assert_eq!(get(&d(json!({}), json!({ "readyReplicas": 1 })), "ready"), Some("1/1"));
    assert!(d(json!({ "replicas": 0 }), json!({})).problems.is_empty());
}

#[test]
fn statefulset_daemonset_replicaset() {
    let ss = values_of(&kind("apps", "StatefulSet"), &obj(json!({ "apiVersion": "apps/v1", "kind": "StatefulSet", "metadata": {}, "spec": { "replicas": 2 }, "status": { "readyReplicas": 2 } })));
    assert_eq!(get(&ss, "ready"), Some("2/2"));
    assert!(ss.problems.is_empty());
    let ds = values_of(&kind("apps", "DaemonSet"), &obj(json!({ "apiVersion": "apps/v1", "kind": "DaemonSet", "metadata": {}, "status": {
        "desiredNumberScheduled": 3, "currentNumberScheduled": 3, "numberReady": 2, "updatedNumberScheduled": 3, "numberAvailable": 2 } })));
    assert_eq!(
        ["desired", "current", "ready", "upToDate", "available"].map(|k| get(&ds, k)),
        [Some("3"), Some("3"), Some("2"), Some("3"), Some("2")]
    );
    assert_eq!(ds.problems, [Problem::NotReady]);
    let rs = values_of(&kind("apps", "ReplicaSet"), &obj(json!({ "apiVersion": "apps/v1", "kind": "ReplicaSet", "metadata": {}, "spec": { "replicas": 2 }, "status": { "replicas": 2, "readyReplicas": 2 } })));
    assert_eq!(["desired", "current", "ready"].map(|k| get(&rs, k)), [Some("2"), Some("2"), Some("2")]);
}

#[test]
fn job_status_from_conditions() {
    let job = |status: serde_json::Value| values_of(&kind("batch", "Job"), &obj(json!({ "apiVersion": "batch/v1", "kind": "Job", "metadata": {}, "spec": { "completions": 2 }, "status": status })));
    let done = job(json!({ "succeeded": 2, "conditions": [{ "type": "Complete", "status": "True" }] }));
    assert_eq!((get(&done, "completions"), get(&done, "status")), (Some("2/2"), Some("Complete")));
    assert_eq!(get(&job(json!({ "failed": 1, "conditions": [{ "type": "Failed", "status": "True" }] })), "status"), Some("Failed"));
    assert_eq!(get(&job(json!({ "active": 1 })), "status"), Some("Running"));
    assert_eq!(get(&job(json!({})), "completions"), Some("0/2"));
}

#[test]
fn cronjob_values() {
    let v = values_of(&kind("batch", "CronJob"), &obj(json!({ "apiVersion": "batch/v1", "kind": "CronJob", "metadata": {},
        "spec": { "schedule": "*/5 * * * *", "suspend": true }, "status": { "active": [{ "name": "a" }], "lastScheduleTime": "2026-10-30T01:00:00Z" } })));
    assert_eq!(
        ["schedule", "suspend", "active", "lastSchedule"].map(|k| get(&v, k)),
        [Some("*/5 * * * *"), Some("true"), Some("1"), Some("2026-10-30T01:00:00Z")]
    );
    let plain = values_of(&kind("batch", "CronJob"), &obj(json!({ "apiVersion": "batch/v1", "kind": "CronJob", "metadata": {}, "spec": { "schedule": "@daily" } })));
    assert_eq!((get(&plain, "suspend"), get(&plain, "active")), (Some("false"), Some("0")));
}

#[test]
fn namespace_status() {
    let v = values_of(&kind("", "Namespace"), &obj(json!({ "apiVersion": "v1", "kind": "Namespace", "metadata": {}, "status": { "phase": "Terminating" } })));
    assert_eq!(get(&v, "status"), Some("Terminating"));
}

#[test]
fn problems_serialize_in_camel_case() {
    let all = [Problem::CrashLoopBackOff, Problem::ImagePullBackOff, Problem::Pending, Problem::OomKilled, Problem::NotReady];
    assert_eq!(serde_json::to_value(all).unwrap(), json!(["crashLoopBackOff", "imagePullBackOff", "pending", "oomKilled", "notReady"]));
}
