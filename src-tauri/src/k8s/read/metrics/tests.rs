use kube::core::{ObjectMeta, Status};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference;
use serde_json::json;

use super::*;

fn obj(v: serde_json::Value) -> DynamicObject {
    serde_json::from_value(v).unwrap()
}

fn owner(kind: &str, name: &str) -> Owner {
    Owner { kind: kind.into(), name: name.into() }
}

fn meta_with(refs: &[(&str, &str, Option<bool>)]) -> ObjectMeta {
    ObjectMeta {
        owner_references: Some(refs.iter().map(|(kind, name, controller)| OwnerReference { kind: (*kind).into(), name: (*name).into(), controller: *controller, ..Default::default() }).collect()),
        ..Default::default()
    }
}

#[test]
fn pod_usage_sums_container_usage_and_rounds_up() {
    let m = obj(json!({ "apiVersion": "metrics.k8s.io/v1beta1", "kind": "PodMetrics", "metadata": { "name": "web-1", "namespace": "prod" },
        "containers": [
            { "name": "app", "usage": { "cpu": "1500000n", "memory": "128974848" } },
            { "name": "side", "usage": { "cpu": "10m", "memory": "64Ki" } },
        ] }));
    let u = pod_usage_of(&m);
    assert_eq!((u.namespace.as_str(), u.name.as_str()), ("prod", "web-1"));
    assert_eq!(u.containers, [
        ContainerUsage { name: "app".into(), cpu_milli: 2, memory_bytes: 128_974_848 },
        ContainerUsage { name: "side".into(), cpu_milli: 10, memory_bytes: 65_536 },
    ]);
    assert_eq!((u.cpu_milli, u.memory_bytes), (12, 128_974_848 + 65_536));
    assert!(u.owners.is_empty());
}

#[test]
fn pod_usage_tolerates_missing_usage() {
    let m = obj(json!({ "apiVersion": "metrics.k8s.io/v1beta1", "kind": "PodMetrics", "metadata": { "name": "p", "namespace": "n" }, "containers": [{ "name": "app" }] }));
    let u = pod_usage_of(&m);
    assert_eq!((u.cpu_milli, u.memory_bytes), (0, 0));
    let none = obj(json!({ "apiVersion": "metrics.k8s.io/v1beta1", "kind": "PodMetrics", "metadata": { "name": "p", "namespace": "n" } }));
    assert!(pod_usage_of(&none).containers.is_empty());
}

#[test]
fn bounds_sum_only_when_every_container_sets_them() {
    let pod = json!({ "spec": {
        "containers": [
            { "resources": { "requests": { "cpu": "100m", "memory": "64Mi" }, "limits": { "cpu": "500m", "memory": "128Mi" } } },
            { "resources": { "requests": { "cpu": "0.2", "memory": "1Gi" }, "limits": { "cpu": "1" } } },
        ],
        "initContainers": [{ "resources": { "requests": { "cpu": "4" } } }],
        "overhead": { "cpu": "50m" }
    } });
    assert_eq!(bounds_of_pod(&pod), Bounds { cpu_request: Some(300), cpu_limit: Some(1500), memory_request: Some(64 * 1024 * 1024 + 1024 * 1024 * 1024), memory_limit: None });
}

#[test]
fn bounds_are_unset_for_empty_zero_or_missing() {
    assert_eq!(bounds_of_pod(&json!({ "spec": { "containers": [] } })), Bounds::default());
    assert_eq!(bounds_of_pod(&json!({})), Bounds::default());
    let zero = json!({ "spec": { "containers": [{ "resources": { "requests": { "cpu": "0" }, "limits": { "memory": "0" } } }] } });
    assert_eq!(bounds_of_pod(&zero), Bounds::default());
    let one = bounds_of_container(&json!({ "resources": { "limits": { "memory": "256Mi" } } }));
    assert_eq!(one, Bounds { memory_limit: Some(256 * 1024 * 1024), ..Bounds::default() });
}

#[test]
fn percent_and_the_hot_threshold() {
    assert_eq!(percent_of(50, Some(200)), Some(25.0));
    assert_eq!(percent_of(50, None), None);
    assert_eq!(percent_of(50, Some(0)), None);
    assert!(!is_hot(percent_of(90, Some(100))), "90% itself is not over the line");
    assert!(is_hot(percent_of(91, Some(100))));
    assert!(is_hot(percent_of(300, Some(100))), "over the limit counts too");
    assert!(!is_hot(None));
}

#[test]
fn controller_prefers_the_controller_flag_then_the_first_owner() {
    assert_eq!(controller_of(&meta_with(&[("ConfigMap", "cm", None), ("ReplicaSet", "web-5d", Some(true))])), Some(owner("ReplicaSet", "web-5d")));
    assert_eq!(controller_of(&meta_with(&[("Job", "a", None), ("Job", "b", Some(false))])), Some(owner("Job", "a")));
    assert_eq!(controller_of(&ObjectMeta::default()), None);
}

#[test]
fn chain_climbs_replicaset_to_deployment_and_job_to_cronjob() {
    let mut parents = Parents::new();
    parents.insert(("prod".into(), "ReplicaSet".into(), "web-5d".into()), owner("Deployment", "web"));
    parents.insert(("prod".into(), "Job".into(), "nightly-123".into()), owner("CronJob", "nightly"));
    assert_eq!(owner_chain("prod", Some(owner("ReplicaSet", "web-5d")), &parents), [owner("ReplicaSet", "web-5d"), owner("Deployment", "web")]);
    assert_eq!(owner_chain("prod", Some(owner("Job", "nightly-123")), &parents), [owner("Job", "nightly-123"), owner("CronJob", "nightly")]);
    // 같은 이름이라도 다른 네임스페이스의 ReplicaSet은 따라가지 않는다
    assert_eq!(owner_chain("dev", Some(owner("ReplicaSet", "web-5d")), &parents), [owner("ReplicaSet", "web-5d")]);
}

#[test]
fn chain_of_standalone_owners_is_just_the_owner() {
    let parents = Parents::new();
    assert_eq!(owner_chain("prod", Some(owner("StatefulSet", "db")), &parents), [owner("StatefulSet", "db")]);
    assert_eq!(owner_chain("prod", Some(owner("DaemonSet", "agent")), &parents), [owner("DaemonSet", "agent")]);
    // ReplicaSet을 읽지 못했거나 Deployment 없이 만든 ReplicaSet이면 ReplicaSet까지
    assert_eq!(owner_chain("prod", Some(owner("ReplicaSet", "lone")), &parents), [owner("ReplicaSet", "lone")]);
    assert_eq!(owner_chain("prod", None, &parents), []);
    // 노드가 소유한 정적 Pod
    assert_eq!(owner_chain("kube-system", Some(owner("Node", "ip-10-0-1-2")), &parents), []);
}

#[test]
fn chain_stops_on_a_cycle() {
    let mut parents = Parents::new();
    parents.insert(("n".into(), "Job".into(), "a".into()), owner("Job", "b"));
    parents.insert(("n".into(), "Job".into(), "b".into()), owner("Job", "a"));
    assert_eq!(owner_chain("n", Some(owner("Job", "a")), &parents).len(), CHAIN_MAX);
}

#[test]
fn unavailable_reasons_come_from_the_status_code() {
    let api = |code: u16| kube::Error::Api(Box::new(Status::failure("x", "Reason").with_code(code)));
    assert_eq!(unavailable_of(&api(404)), Some(Unavailable::NotInstalled));
    assert_eq!(unavailable_of(&api(403)), Some(Unavailable::Forbidden));
    assert_eq!(unavailable_of(&api(503)), Some(Unavailable::NotReady));
    assert_eq!(unavailable_of(&api(500)), None);
    assert_eq!(unavailable_of(&api(401)), None);
}

const PUBLIC: Endpoint = Endpoint { public: true, private: false };

#[tokio::test]
async fn read_turns_a_missing_or_forbidden_server_into_a_reason_and_keeps_other_errors() {
    let api = |code: u16| async move { Err::<(), _>(kube::Error::Api(Box::new(Status::failure("x", "Reason").with_code(code)))) };
    assert_eq!(read(api(404), "pods.metrics.k8s.io", PUBLIC).await, Ok(Err(Unavailable::NotInstalled)));
    assert_eq!(read(api(403), "pods.metrics.k8s.io", PUBLIC).await, Ok(Err(Unavailable::Forbidden)));
    assert_eq!(read(api(401), "pods.metrics.k8s.io", PUBLIC).await, Err(describe(&Failure::Unauthorized, PUBLIC)));
    assert_eq!(read(async { Ok::<_, kube::Error>(3) }, "pods.metrics.k8s.io", PUBLIC).await, Ok(Ok(3)));
}

#[test]
fn metrics_serialize_with_camel_case_reasons() {
    let m = Metrics { pods_unavailable: Some(Unavailable::NotInstalled), nodes_unavailable: Some(Unavailable::Forbidden), pods: vec![], nodes: vec![] };
    assert_eq!(serde_json::to_value(&m).unwrap(), json!({ "podsUnavailable": "notInstalled", "nodesUnavailable": "forbidden", "pods": [], "nodes": [] }));
}
