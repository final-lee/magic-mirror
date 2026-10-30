use serde_json::json;

use super::*;
use crate::k8s::read::values::GroupKind;

fn obj(v: serde_json::Value) -> DynamicObject {
    serde_json::from_value(v).unwrap()
}

#[test]
fn pod_requests_take_the_larger_of_containers_and_init_plus_overhead() {
    let pod = json!({ "spec": {
        "containers": [{ "resources": { "requests": { "cpu": "100m", "memory": "64Mi" } } }, { "resources": { "requests": { "cpu": "200m" } } }],
        "initContainers": [{ "resources": { "requests": { "cpu": "500m", "memory": "32Mi" } } }],
        "overhead": { "cpu": "10m", "memory": "1Mi" }
    } });
    assert_eq!(pod_requests(&pod), Resources { cpu_milli: 510, memory_bytes: 65 * 1024 * 1024, pods: 1 });
    assert_eq!(pod_requests(&json!({ "spec": { "containers": [{}] } })), Resources { cpu_milli: 0, memory_bytes: 0, pods: 1 });
    let nano = json!({ "spec": { "containers": [{ "resources": { "requests": { "memory": "1n" } } }] } });
    assert_eq!(pod_requests(&nano).memory_bytes, 1);
}

#[test]
fn requests_are_summed_per_node_for_running_pods_only() {
    let pod = |node: Option<&str>, phase: &str| {
        let mut spec = json!({ "containers": [{ "resources": { "requests": { "cpu": "100m" } } }] });
        if let Some(n) = node {
            spec["nodeName"] = json!(n);
        }
        obj(json!({ "apiVersion": "v1", "kind": "Pod", "metadata": { "name": "p" }, "spec": spec, "status": { "phase": phase } }))
    };
    let pods = [pod(Some("a"), "Running"), pod(Some("a"), "Pending"), pod(Some("a"), "Succeeded"), pod(Some("b"), "Failed"), pod(None, "Pending")];
    let by = requests_by_node(&pods);
    assert_eq!(by.get("a"), Some(&Resources { cpu_milli: 200, memory_bytes: 0, pods: 2 }));
    assert_eq!(by.get("b"), None);
}

#[test]
fn node_view_reads_status_labels_and_allocatable() {
    let n = obj(json!({ "apiVersion": "v1", "kind": "Node",
        "metadata": { "name": "ip-1", "labels": { "node.kubernetes.io/instance-type": "m6i.large", "topology.kubernetes.io/zone": "ap-northeast-2a", "karpenter.sh/nodepool": "default" } },
        "spec": { "unschedulable": true },
        "status": {
            "conditions": [{ "type": "Ready", "status": "True" }, { "type": "MemoryPressure", "status": "True" }, { "type": "DiskPressure", "status": "False" }],
            "allocatable": { "cpu": "1930m", "memory": "7Gi", "pods": "29" },
            "nodeInfo": { "kubeletVersion": "v1.31.4-eks-1" }
        } }));
    let req = Resources { cpu_milli: 300, memory_bytes: 1, pods: 4 };
    let v = node_view(&n, req, Some(Usage { cpu_milli: 50, memory_bytes: 2 }));
    assert_eq!(v.name, "ip-1");
    assert!(v.ready && v.unschedulable);
    assert_eq!(v.pressures, ["MemoryPressure"]);
    assert_eq!((v.instance_type.as_deref(), v.zone.as_deref()), (Some("m6i.large"), Some("ap-northeast-2a")));
    assert_eq!((v.group_kind, v.group.as_deref()), (GroupKind::Karpenter, Some("default")));
    assert_eq!(v.allocatable, Resources { cpu_milli: 1930, memory_bytes: 7 * 1024 * 1024 * 1024, pods: 29 });
    assert_eq!(v.requested, req);
    assert_eq!(v.kubelet_version, "v1.31.4-eks-1");
}

#[test]
fn usage_from_node_metrics() {
    let m = obj(json!({ "apiVersion": "metrics.k8s.io/v1beta1", "kind": "NodeMetrics", "metadata": { "name": "ip-1" }, "usage": { "cpu": "250000000n", "memory": "1024Ki" } }));
    assert_eq!(usage_of(&m), ("ip-1".into(), Usage { cpu_milli: 250, memory_bytes: 1_048_576 }));
}

#[test]
fn minor_versions_and_skew() {
    assert_eq!(minor("1.33"), Some(33));
    assert_eq!(minor("v1.31.4-eks-1"), Some(31));
    assert_eq!(minor("x"), None);
    let node = |name: &str, v: &str| NodeView {
        name: name.into(), ready: true, unschedulable: false, pressures: vec![], instance_type: None, zone: None,
        group_kind: GroupKind::SelfManaged, group: None, kubelet_version: v.into(),
        allocatable: Resources::default(), requested: Resources::default(), usage: None,
    };
    let s = skew("1.33", &[node("a", "v1.33.1"), node("b", "v1.31.4-eks-1"), node("c", "bogus")]);
    assert_eq!(s, [Skew { node: "b".into(), kubelet_version: "v1.31.4-eks-1".into(), minors_behind: 2 }]);
}

#[test]
fn node_view_json_keys() {
    let n = obj(json!({ "apiVersion": "v1", "kind": "Node", "metadata": { "name": "n" }, "status": {} }));
    let v = serde_json::to_value(node_view(&n, Resources::default(), None)).unwrap();
    assert_eq!(v["groupKind"], json!("self"));
    assert_eq!(v["allocatable"], json!({ "cpuMilli": 0, "memoryBytes": 0, "pods": 0 }));
    assert_eq!(v["usage"], json!(null));
    assert_eq!(v["kubeletVersion"], json!(""));
}
