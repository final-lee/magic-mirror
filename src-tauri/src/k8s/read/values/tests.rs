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

fn of(group: &str, k: &str, body: serde_json::Value) -> Values {
    let mut body = body;
    body["kind"] = json!(k);
    body["apiVersion"] = json!(if group.is_empty() { "v1".to_string() } else { format!("{group}/v1") });
    if body.get("metadata").is_none() {
        body["metadata"] = json!({});
    }
    values_of(&kind(group, k), &obj(body))
}

#[test]
fn service_values() {
    let v = of("", "Service", json!({
        "spec": { "type": "LoadBalancer", "clusterIP": "172.20.0.10", "ports": [{ "port": 80, "protocol": "TCP", "nodePort": 30080 }, { "port": 443, "protocol": "TCP" }] },
        "status": { "loadBalancer": { "ingress": [{ "hostname": "k8s-web.elb.amazonaws.com" }] } }
    }));
    assert_eq!(
        ["type", "clusterIp", "externalIp", "ports"].map(|k| get(&v, k)),
        [Some("LoadBalancer"), Some("172.20.0.10"), Some("k8s-web.elb.amazonaws.com"), Some("80:30080/TCP,443/TCP")]
    );
}

#[test]
fn ingress_and_network_policy_values() {
    let ing = of("networking.k8s.io", "Ingress", json!({
        "spec": { "ingressClassName": "alb", "rules": [{ "host": "a.example.com" }, { "host": "b.example.com" }] },
        "status": { "loadBalancer": { "ingress": [{ "hostname": "alb.example" }] } }
    }));
    assert_eq!(["class", "hosts", "address"].map(|k| get(&ing, k)), [Some("alb"), Some("a.example.com,b.example.com"), Some("alb.example")]);
    let np = of("networking.k8s.io", "NetworkPolicy", json!({ "spec": { "podSelector": { "matchLabels": { "app": "web" } }, "policyTypes": ["Ingress", "Egress"] } }));
    assert_eq!((get(&np, "podSelector"), get(&np, "policyTypes")), (Some("app=web"), Some("Ingress,Egress")));
    let all = of("networking.k8s.io", "NetworkPolicy", json!({ "spec": { "podSelector": {} } }));
    assert_eq!(get(&all, "podSelector"), None);
}

#[test]
fn endpoints_show_three_then_a_count() {
    let addresses: Vec<_> = (1..=5).map(|i| json!({ "ip": format!("10.0.0.{i}") })).collect();
    let v = of("", "Endpoints", json!({ "subsets": [{ "addresses": addresses, "ports": [{ "port": 80 }] }] }));
    assert_eq!(get(&v, "endpoints"), Some("10.0.0.1:80, 10.0.0.2:80, 10.0.0.3:80 +2"));
}

#[test]
fn config_map_counts_keys() {
    let v = of("", "ConfigMap", json!({ "data": { "a": "1", "b": "2" }, "binaryData": { "c": "AA==" } }));
    assert_eq!(get(&v, "keys"), Some("3"));
}

#[test]
fn secret_row_has_type_and_key_count_and_no_value() {
    let o = obj(json!({ "apiVersion": "v1", "kind": "Secret", "metadata": {}, "type": "Opaque",
        "data": { "password": "aHVudGVyMg==" }, "stringData": { "token": "plain-secret" } }));
    let k = kind("", "Secret");
    let v = values_of(&k, &o);
    assert_eq!((get(&v, "type"), get(&v, "keys")), (Some("Opaque"), Some("2")));
    let row = serde_json::to_string(&crate::k8s::rows::row_of(&k, &o)).unwrap();
    for secret in ["aHVudGVyMg==", "hunter2", "plain-secret"] {
        assert!(!row.contains(secret), "row leaks {secret}: {row}");
    }
}

#[test]
fn service_account_role_arn() {
    let v = of("", "ServiceAccount", json!({ "metadata": { "annotations": { "eks.amazonaws.com/role-arn": "arn:aws:iam::1:role/web" } } }));
    assert_eq!(get(&v, "roleArn"), Some("arn:aws:iam::1:role/web"));
}

#[test]
fn storage_kinds() {
    let pvc = of("", "PersistentVolumeClaim", json!({
        "spec": { "volumeName": "pv-1", "accessModes": ["ReadWriteOnce"], "storageClassName": "gp3" },
        "status": { "phase": "Pending", "capacity": { "storage": "10Gi" } }
    }));
    assert_eq!(
        ["status", "volume", "capacity", "accessModes", "storageClass"].map(|k| get(&pvc, k)),
        [Some("Pending"), Some("pv-1"), Some("10Gi"), Some("ReadWriteOnce"), Some("gp3")]
    );
    assert_eq!(pvc.problems, [Problem::Pending]);
    let pv = of("", "PersistentVolume", json!({
        "spec": { "capacity": { "storage": "10Gi" }, "accessModes": ["ReadWriteOnce"], "persistentVolumeReclaimPolicy": "Delete",
            "claimRef": { "namespace": "web", "name": "data" }, "storageClassName": "gp3" },
        "status": { "phase": "Bound" }
    }));
    assert_eq!(
        ["capacity", "accessModes", "reclaimPolicy", "status", "claim", "storageClass"].map(|k| get(&pv, k)),
        [Some("10Gi"), Some("ReadWriteOnce"), Some("Delete"), Some("Bound"), Some("web/data"), Some("gp3")]
    );
    let sc = of("storage.k8s.io", "StorageClass", json!({
        "metadata": { "annotations": { "storageclass.kubernetes.io/is-default-class": "true" } },
        "provisioner": "ebs.csi.aws.com", "reclaimPolicy": "Delete", "volumeBindingMode": "WaitForFirstConsumer"
    }));
    assert_eq!(
        ["provisioner", "reclaimPolicy", "volumeBindingMode", "default"].map(|k| get(&sc, k)),
        [Some("ebs.csi.aws.com"), Some("Delete"), Some("WaitForFirstConsumer"), Some("true")]
    );
    let plain = of("storage.k8s.io", "StorageClass", json!({ "provisioner": "x" }));
    assert_eq!(get(&plain, "default"), None);
}

fn node(labels: serde_json::Value, unschedulable: bool, ready: &str) -> Values {
    of("", "Node", json!({
        "metadata": { "labels": labels },
        "spec": { "unschedulable": unschedulable },
        "status": { "conditions": [{ "type": "Ready", "status": ready }], "nodeInfo": { "kubeletVersion": "v1.33.4-eks-1" } }
    }))
}

#[test]
fn node_values_and_groups() {
    let v = node(json!({ "node.kubernetes.io/instance-type": "m6i.large", "topology.kubernetes.io/zone": "ap-northeast-2a", "eks.amazonaws.com/nodegroup": "ng-1" }), false, "True");
    assert_eq!(
        ["status", "version", "instanceType", "zone", "groupKind", "group"].map(|k| get(&v, k)),
        [Some("Ready"), Some("v1.33.4-eks-1"), Some("m6i.large"), Some("ap-northeast-2a"), Some("managed"), Some("ng-1")]
    );
    assert!(v.problems.is_empty());
    let cordoned = node(json!({}), true, "False");
    assert_eq!((get(&cordoned, "status"), get(&cordoned, "groupKind"), get(&cordoned, "group")), (Some("NotReady,SchedulingDisabled"), Some("self"), None));
    assert_eq!(cordoned.problems, [Problem::NotReady]);
    assert_eq!(get(&node(json!({}), false, "Unknown"), "status"), Some("Unknown"));
}

#[test]
fn node_group_kinds() {
    let l = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>();
    assert_eq!(node_group(&l(&[("eks.amazonaws.com/compute-type", "fargate"), ("eks.amazonaws.com/fargate-profile", "fp")])), (GroupKind::Fargate, Some("fp".into())));
    assert_eq!(node_group(&l(&[("eks.amazonaws.com/nodegroup", "ng")])), (GroupKind::Managed, Some("ng".into())));
    assert_eq!(node_group(&l(&[("karpenter.sh/nodepool", "default")])), (GroupKind::Karpenter, Some("default".into())));
    assert_eq!(node_group(&l(&[])), (GroupKind::SelfManaged, None));
    assert_eq!(serde_json::to_value(GroupKind::SelfManaged).unwrap(), json!("self"));
    assert_eq!(GroupKind::SelfManaged.as_str(), "self");
}

#[test]
fn event_values_prefer_the_series_time() {
    let v = of("", "Event", json!({
        "metadata": { "creationTimestamp": "2026-10-30T00:00:00Z" },
        "type": "Warning", "reason": "BackOff", "message": "Back-off restarting failed container",
        "involvedObject": { "kind": "Pod", "name": "web-1" }, "count": 4,
        "lastTimestamp": "2026-10-30T01:00:00Z", "series": { "count": 9, "lastObservedTime": "2026-10-30T02:00:00.123456Z" }
    }));
    assert_eq!(
        ["type", "reason", "object", "message", "count", "lastSeen"].map(|k| get(&v, k)),
        [Some("Warning"), Some("BackOff"), Some("Pod/web-1"), Some("Back-off restarting failed container"), Some("9"), Some("2026-10-30T02:00:00Z")]
    );
    let old = of("", "Event", json!({ "metadata": { "creationTimestamp": "2026-10-30T00:00:00Z" }, "involvedObject": { "kind": "Node", "name": "n" } }));
    assert_eq!((get(&old, "count"), get(&old, "lastSeen")), (Some("1"), Some("2026-10-30T00:00:00Z")));
}

#[test]
fn custom_kinds_use_the_ready_condition() {
    let v = of("mm.example.com", "Widget", json!({ "status": { "conditions": [{ "type": "Ready", "status": "False" }] } }));
    assert_eq!(get(&v, "ready"), Some("False"));
    assert_eq!(v.problems, [Problem::NotReady]);
    assert!(of("mm.example.com", "Widget", json!({})).values.is_empty());
}
