use serde_json::json;

use super::*;
use crate::k8s::read::values::GroupKind;

fn cluster(version: &str) -> ClusterView {
    ClusterView {
        version: version.into(), platform_version: None, status: None, endpoint_public: true, endpoint_private: false,
        public_cidrs: vec![], logging: vec![], secrets_encrypted: false, oidc_issuer: None, authentication_mode: None,
    }
}

fn node(name: &str, kubelet: &str) -> DynamicObject {
    serde_json::from_value(json!({ "apiVersion": "v1", "kind": "Node", "metadata": { "name": name },
        "status": { "conditions": [{ "type": "Ready", "status": "True" }], "nodeInfo": { "kubeletVersion": kubelet }, "allocatable": { "cpu": "2", "memory": "4Gi", "pods": "29" } } }))
    .unwrap()
}

fn eks_ok() -> EksParts {
    EksParts { cluster: Ok(cluster("1.31")), nodegroups: Ok(vec![]), fargate: Ok(vec![]), addons: Ok(vec![]), insights: Ok(vec![]) }
}

fn k8s_ok() -> K8sParts {
    let mut req = HashMap::new();
    req.insert("b".to_string(), Resources { cpu_milli: 500, memory_bytes: 1, pods: 3 });
    let mut usage = HashMap::new();
    usage.insert("b".to_string(), Usage { cpu_milli: 100, memory_bytes: 2 });
    K8sParts {
        nodes: Ok(vec![node("b", "v1.31.1"), node("a", "v1.29.9")]),
        requests: Ok((req, false)),
        usage: Ok(Some(usage)),
        node_pools: Ok(None),
        removed: Ok(Some(vec![])),
    }
}

fn denied(action: &str) -> AppError {
    AppError::AccessDenied { action: action.into() }
}

#[test]
fn everything_loads() {
    let o = assemble(eks_ok(), k8s_ok());
    assert!(o.gaps.is_empty());
    let nodes = o.nodes.unwrap();
    assert_eq!(nodes.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    assert_eq!(nodes[1].requested, Resources { cpu_milli: 500, memory_bytes: 1, pods: 3 });
    assert_eq!(nodes[1].usage, Some(Usage { cpu_milli: 100, memory_bytes: 2 }));
    assert_eq!(nodes[0].requested, Resources::default());
    assert_eq!(nodes[0].group_kind, GroupKind::SelfManaged);
    assert!(o.metrics);
    assert_eq!(o.next_version.as_deref(), Some("1.32"));
    assert_eq!(o.skew, [Skew { node: "a".into(), kubelet_version: "v1.29.9".into(), minors_behind: 2 }]);
    assert_eq!(o.node_pools, None);
    assert_eq!(o.removed_apis, Some(vec![]));
}

#[test]
fn failed_parts_become_gaps_and_the_rest_stays() {
    let eks = EksParts { cluster: Err(denied("eks:DescribeCluster")), addons: Err(denied("eks:ListAddons")), ..eks_ok() };
    let k8s = K8sParts { requests: Err(denied("list pods")), usage: Err(denied("list nodes.metrics.k8s.io")), ..k8s_ok() };
    let o = assemble(eks, k8s);
    let sections: Vec<Section> = o.gaps.iter().map(|g| g.section).collect();
    assert_eq!(sections, [Section::Cluster, Section::Addons, Section::Nodes, Section::Metrics]);
    assert_eq!(o.gaps[2].error, denied("list pods"));
    assert!(o.cluster.is_none() && o.addons.is_none());
    // 노드는 보이고 요청량은 0, 사용량은 없다
    let nodes = o.nodes.unwrap();
    assert!(nodes.iter().all(|n| n.requested == Resources::default() && n.usage.is_none()));
    assert!(!o.metrics);
    // 클러스터 버전을 모르면 다음 버전과 버전 차이도 없다
    assert_eq!(o.next_version, None);
    assert!(o.skew.is_empty());
    assert_eq!(o.nodegroups, Some(vec![]));
}

#[test]
fn no_metrics_server_is_not_a_gap() {
    let o = assemble(eks_ok(), K8sParts { usage: Ok(None), ..k8s_ok() });
    assert!(o.gaps.is_empty() && !o.metrics);
}

#[test]
fn overview_json_keys_match_the_ts_contract() {
    let v = serde_json::to_value(assemble(eks_ok(), K8sParts { requests: Ok((HashMap::new(), true)), ..k8s_ok() })).unwrap();
    for key in ["cluster", "nodes", "requestsPartial", "metrics", "nodegroups", "fargateProfiles", "nodePools", "addons", "insights", "removedApis", "nextVersion", "skew", "gaps"] {
        assert!(v.get(key).is_some(), "{key}");
    }
    assert_eq!(v["requestsPartial"], json!(true));
    let gap = serde_json::to_value(Gap { section: Section::RemovedApis, error: denied("x") }).unwrap();
    assert_eq!(gap, json!({ "section": "removedApis", "error": { "kind": "accessDenied", "action": "x" } }));
    assert_eq!(serde_json::to_value(Section::NodePools).unwrap(), json!("nodePools"));
}
