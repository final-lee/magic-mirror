//! 관계 트리(xray)를 kind에서 읽는다. 픽스처는 `scripts/k8s-live/xray.sh`(mm-xray 네임스페이스).
use super::{admin, PRIVATE};
use crate::k8s::rows::KindRef;
use crate::k8s::xray::model::{Edge, Presence, Section, Xray, XrayNode};
use crate::k8s::xray::xray;

fn kind(group: &str, version: &str, kind: &str, plural: &str, namespaced: bool) -> KindRef {
    KindRef { group: group.into(), version: version.into(), kind: kind.into(), plural: plural.into(), namespaced }
}

fn section(x: &Xray, edge: Edge) -> &Section {
    x.sections.iter().find(|s| s.edge == edge).unwrap_or_else(|| panic!("{edge:?} 묶음이 없다: {:?}", x.sections))
}

fn find<'a>(nodes: &'a [XrayNode], kind: &str, name: &str) -> Option<&'a XrayNode> {
    nodes.iter().find_map(|n| if n.kind == kind && n.name == name { Some(n) } else { find(&n.children, kind, name) })
}

#[tokio::test]
#[ignore]
async fn deployment_relations_include_replica_set_pods_service_config_map_and_service_account() {
    let client = admin().await;
    let deployment = kind("apps", "v1", "Deployment", "deployments", true);
    let x = xray(&client, &deployment, Some("mm-xray"), "web", PRIVATE).await.unwrap();
    assert!(x.gaps.is_empty(), "gaps: {:?}", x.gaps);
    assert!(!x.truncated);

    // 소유: Deployment → ReplicaSet → Pod 둘
    let owners = &section(&x, Edge::Owner).nodes;
    assert_eq!(owners.len(), 1);
    assert!(owners[0].current && owners[0].name == "web");
    assert_eq!(owners[0].children.len(), 1, "ReplicaSet 하나");
    let replica_set = &owners[0].children[0];
    assert_eq!(replica_set.kind, "ReplicaSet");
    assert_eq!(replica_set.children.len(), 2);
    assert!(replica_set.children.iter().all(|p| p.kind == "Pod" && p.name.starts_with(&replica_set.name)), "{:?}", replica_set.children);

    // 참조: ServiceAccount, 볼륨으로 쓰는 ConfigMap, 없는 선택적 Secret, Pod가 놓인 노드
    let refs = &section(&x, Edge::Reference).nodes;
    let sa = find(refs, "ServiceAccount", "web-sa").expect("ServiceAccount");
    assert_eq!(sa.presence, Presence::Found);
    let config = find(refs, "ConfigMap", "web-config").expect("ConfigMap");
    assert_eq!((config.presence, config.roles.as_slice()), (Presence::Found, ["volume".to_string()].as_slice()));
    assert_eq!(find(refs, "Secret", "absent-secret").expect("Secret").presence, Presence::Missing);
    let node = refs.iter().find(|n| n.kind == "Node").expect("Node");
    assert_eq!(node.presence, Presence::Found, "노드는 이름으로 읽어 온다");
    assert!(node.status.is_some());

    // 선택: 레이블이 맞는 Service, 그 아래 Service를 대상으로 하는 Ingress
    let selecting = &section(&x, Edge::Selector).nodes;
    let service = find(selecting, "Service", "web").expect("Service");
    assert_eq!(service.edge, Edge::Selector);
    assert!(find(&service.children, "Ingress", "web").is_some_and(|i| i.edge == Edge::Target));

    // 대상: 이 Deployment를 가리키는 HPA
    assert!(find(&section(&x, Edge::Target).nodes, "HorizontalPodAutoscaler", "web").is_some());
}

#[tokio::test]
#[ignore]
async fn pod_relations_walk_up_and_a_config_map_shows_who_uses_it() {
    let client = admin().await;
    let deployment = kind("apps", "v1", "Deployment", "deployments", true);
    let tree = xray(&client, &deployment, Some("mm-xray"), "web", PRIVATE).await.unwrap();
    let pod_name = section(&tree, Edge::Owner).nodes[0].children[0].children[0].name.clone();

    // Pod에서 위로: Deployment → ReplicaSet → 이 Pod
    let pod = kind("", "v1", "Pod", "pods", true);
    let x = xray(&client, &pod, Some("mm-xray"), &pod_name, PRIVATE).await.unwrap();
    let top = &section(&x, Edge::Owner).nodes[0];
    assert_eq!((top.kind.as_str(), top.name.as_str()), ("Deployment", "web"));
    assert!(top.children[0].children[0].current);
    assert!(find(&section(&x, Edge::Selector).nodes, "Service", "web").is_some());

    // ConfigMap에서 거꾸로: 가장 위 소유자인 Deployment 하나만 보인다
    let config_map = kind("", "v1", "ConfigMap", "configmaps", true);
    let x = xray(&client, &config_map, Some("mm-xray"), "web-config", PRIVATE).await.unwrap();
    let users = &section(&x, Edge::Reference).nodes;
    assert_eq!(users.iter().map(|n| format!("{}/{}", n.kind, n.name)).collect::<Vec<_>>(), ["Deployment/web"]);
    assert_eq!(users[0].roles.first().map(String::as_str), Some("usedBy"));
}
