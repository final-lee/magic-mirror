use serde_json::json;

use super::*;

fn object(value: serde_json::Value) -> DynamicObject {
    serde_json::from_value(value).unwrap()
}

fn node(name: &str, provider_id: Option<&str>, labels: serde_json::Value, ready: &str) -> DynamicObject {
    object(json!({
        "apiVersion": "v1", "kind": "Node", "metadata": { "name": name, "labels": labels },
        "spec": provider_id.map_or(json!({}), |p| json!({ "providerID": p })),
        "status": {
            "conditions": [{ "type": "Ready", "status": ready }],
            "addresses": [{ "type": "Hostname", "address": name }, { "type": "InternalIP", "address": "10.0.1.5" }],
        },
    }))
}

#[test]
fn the_provider_id_gives_zone_and_instance_id() {
    assert_eq!(parse_provider_id("aws:///ap-northeast-2a/i-0123456789abcdef0"), (Some("ap-northeast-2a".into()), Some("i-0123456789abcdef0".into())));
    // 인스턴스 ID가 아닌 것(Fargate 등)은 zone만 남긴다
    assert_eq!(parse_provider_id("aws:///ap-northeast-2a/fargate-ip-10-0-1-5"), (Some("ap-northeast-2a".into()), None));
    assert_eq!(parse_provider_id("aws:///ap-northeast-2a/i-"), (Some("ap-northeast-2a".into()), None));
    assert_eq!(parse_provider_id("kind://docker/mm-live/mm-live-worker"), (None, None));
    assert_eq!(parse_provider_id("aws:///"), (None, None));
}

#[test]
fn nodes_carry_instance_zone_ip_and_readiness() {
    let nodes = [
        node("b-node", Some("aws:///ap-northeast-2c/i-0bbb"), json!({ "node.kubernetes.io/instance-type": "m6i.large", "topology.kubernetes.io/zone": "ap-northeast-2c" }), "True"),
        node("a-fargate", Some("aws:///ap-northeast-2a/fargate-x"), json!({ "eks.amazonaws.com/compute-type": "fargate" }), "False"),
        node("c-kind", None, json!({}), "True"),
    ];
    let out = node_nets(&nodes);
    assert_eq!(out.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(), ["a-fargate", "b-node", "c-kind"]);
    let b = &out[1];
    assert_eq!((b.instance_id.as_deref(), b.zone.as_deref(), b.instance_type.as_deref(), b.internal_ip.as_deref(), b.ready), (Some("i-0bbb"), Some("ap-northeast-2c"), Some("m6i.large"), Some("10.0.1.5"), true));
    let a = &out[0];
    // Fargate 노드는 인스턴스가 없고 zone은 providerID에서 온다
    assert_eq!((a.fargate, a.instance_id.as_deref(), a.zone.as_deref(), a.ready), (true, None, Some("ap-northeast-2a"), false));
    assert_eq!((out[2].provider_id.as_deref(), out[2].zone.as_deref()), (None, None));
}

fn pod(ns: &str, name: &str, ip: Option<&str>, host_network: bool, labels: serde_json::Value) -> DynamicObject {
    object(json!({
        "apiVersion": "v1", "kind": "Pod", "metadata": { "namespace": ns, "name": name, "labels": labels },
        "spec": { "nodeName": "ip-1", "hostNetwork": host_network },
        "status": ip.map_or(json!({ "phase": "Pending" }), |ip| json!({ "podIP": ip })),
    }))
}

#[test]
fn pods_without_an_ip_are_left_out_and_host_network_is_flagged() {
    let pods = [
        pod("shop", "web", Some("10.0.1.77"), false, json!({})),
        pod("shop", "pending", None, false, json!({})),
        pod("kube-system", "aws-node-x", Some("10.0.1.5"), true, json!({ "k8s-app": "aws-node" })),
    ];
    let (out, cni) = pod_nets(&pods);
    assert!(cni);
    assert_eq!(out.iter().map(|p| (p.name.as_str(), p.ip.as_str(), p.host_network)).collect::<Vec<_>>(), [("aws-node-x", "10.0.1.5", true), ("web", "10.0.1.77", false)]);
    assert_eq!(out[1].node.as_deref(), Some("ip-1"));
}

#[test]
fn vpc_cni_means_an_aws_node_pod_in_kube_system_not_just_the_label_anywhere() {
    // 다른 네임스페이스의 같은 레이블은 VPC CNI로 보지 않는다
    let (_, cni) = pod_nets(&[pod("shop", "aws-node", Some("10.0.0.1"), false, json!({ "k8s-app": "aws-node" }))]);
    assert!(!cni);
    let (_, cni) = pod_nets(&[pod("kube-system", "kindnet-x", Some("10.0.0.1"), true, json!({ "app": "kindnet" }))]);
    assert!(!cni);
    assert!(!pod_nets(&[]).1);
}
