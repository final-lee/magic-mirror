use kube::api::DynamicObject;
use serde_json::{json, Value};

use super::graph::{build, unresolved_cluster_refs, FAN_OUT_MAX, NODES_MAX};
use super::model::{Edge, Presence, Section, Xray, XrayNode};
use super::pool::{self, Item, Pool, Spec};
use super::refs::{refs_of, selects};
use crate::error::AppError;

fn obj(v: Value) -> DynamicObject {
    serde_json::from_value(v).unwrap()
}

fn item(spec: &Spec, v: Value) -> Item {
    Item::of(&spec.kind_ref(), &obj(v))
}

/// 본문 없이 메타데이터만 읽는 종류(ConfigMap·Secret·ServiceAccount)
fn plain(spec: &Spec, namespace: &str, name: &str) -> Item {
    item(spec, json!({ "apiVersion": "v1", "kind": spec.kind, "metadata": { "name": name, "namespace": namespace, "uid": format!("{}-{name}", spec.kind) } }))
}

/// 읽은 종류별 목록으로 더미를 만든다(목록에 없는 종류는 읽지 않은 것이다)
fn pool_of(lists: Vec<(&Spec, Vec<Item>)>) -> Pool {
    let mut pool = Pool::default();
    for (spec, items) in lists {
        pool.add_list(&spec.kind_ref(), Ok((items, false)));
    }
    pool
}

fn owner(kind: &str, name: &str, uid: &str) -> Value {
    json!([{ "apiVersion": if kind == "Deployment" || kind == "ReplicaSet" { "apps/v1" } else { "v1" }, "kind": kind, "name": name, "uid": uid, "controller": true }])
}

fn pod_template(labels: Value, spec: Value) -> Value {
    json!({ "metadata": { "labels": labels }, "spec": spec })
}

fn deployment(name: &str, labels: Value, spec: Value) -> Item {
    item(&pool::DEPLOYMENT, json!({
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": { "name": name, "namespace": "prod", "uid": format!("dep-{name}") },
        "spec": { "replicas": 2, "selector": { "matchLabels": labels }, "template": pod_template(labels, spec) },
        "status": { "readyReplicas": 2 }
    }))
}

fn replica_set(name: &str, deployment: &str) -> Item {
    item(&pool::REPLICA_SET, json!({
        "apiVersion": "apps/v1", "kind": "ReplicaSet",
        "metadata": { "name": name, "namespace": "prod", "uid": format!("rs-{name}"), "ownerReferences": owner("Deployment", deployment, &format!("dep-{deployment}")) },
        "spec": { "replicas": 2 }, "status": { "replicas": 2, "readyReplicas": 2 }
    }))
}

fn pod(name: &str, rs: &str, labels: Value, spec: Value, phase: &str) -> Item {
    item(&pool::POD, json!({
        "apiVersion": "v1", "kind": "Pod",
        "metadata": { "name": name, "namespace": "prod", "uid": format!("pod-{name}"), "labels": labels, "ownerReferences": owner("ReplicaSet", rs, &format!("rs-{rs}")) },
        "spec": spec, "status": { "phase": phase }
    }))
}

fn service(name: &str, selector: Value) -> Item {
    item(&pool::SERVICE, json!({
        "apiVersion": "v1", "kind": "Service",
        "metadata": { "name": name, "namespace": "prod", "uid": format!("svc-{name}") },
        "spec": { "selector": selector, "ports": [{ "port": 80 }] }
    }))
}

fn section(x: &Xray, edge: Edge) -> &Section {
    x.sections.iter().find(|s| s.edge == edge).unwrap_or_else(|| panic!("{edge:?} 묶음이 없다: {:?}", x.sections.iter().map(|s| s.edge).collect::<Vec<_>>()))
}

fn find<'a>(nodes: &'a [XrayNode], kind: &str, name: &str) -> Option<&'a XrayNode> {
    nodes.iter().find_map(|n| if n.kind == kind && n.name == name { Some(n) } else { find(&n.children, kind, name) })
}

fn names(nodes: &[XrayNode]) -> Vec<String> {
    nodes.iter().map(|n| format!("{}/{}", n.kind, n.name)).collect()
}

fn web_labels() -> Value {
    json!({ "app": "web" })
}

/// Deployment web → ReplicaSet web-1 → Pod web-1-a·web-1-b, 그 템플릿이 쓰는 것들
fn web_world() -> (Item, Pool) {
    let spec = json!({
        "serviceAccountName": "web-sa",
        "containers": [{ "name": "app", "image": "nginx", "env": [{ "name": "MODE", "valueFrom": { "configMapKeyRef": { "name": "web-config", "key": "mode" } } }] }],
        "volumes": [{ "name": "cfg", "configMap": { "name": "web-config" } }],
    });
    let root = deployment("web", web_labels(), spec.clone());
    let pods = vec![pod("web-1-a", "web-1", web_labels(), spec.clone(), "Running"), pod("web-1-b", "web-1", web_labels(), spec, "Running")];
    let pool = pool_of(vec![
        (&pool::DEPLOYMENT, vec![root.clone()]),
        (&pool::REPLICA_SET, vec![replica_set("web-1", "web")]),
        (&pool::POD, pods),
        (&pool::SERVICE, vec![service("web", json!({ "app": "web" })), service("other", json!({ "app": "other" })), service("headless", json!({}))]),
        (&pool::CONFIG_MAP, vec![plain(&pool::CONFIG_MAP, "prod", "web-config")]),
        (&pool::SERVICE_ACCOUNT, vec![plain(&pool::SERVICE_ACCOUNT, "prod", "web-sa")]),
    ]);
    (root, pool)
}

#[test]
fn deployment_tree_has_children_references_and_the_service() {
    let (root, pool) = web_world();
    let x = build(&root, &pool);
    let owners = section(&x, Edge::Owner);
    assert_eq!(names(&owners.nodes), ["Deployment/web"]);
    let current = &owners.nodes[0];
    assert!(current.current);
    assert_eq!(names(&current.children), ["ReplicaSet/web-1"]);
    assert_eq!(names(&current.children[0].children), ["Pod/web-1-a", "Pod/web-1-b"]);
    assert!(current.children[0].children[0].children.is_empty());
    let refs = section(&x, Edge::Reference);
    assert_eq!(names(&refs.nodes), ["ServiceAccount/web-sa", "ConfigMap/web-config"]);
    assert_eq!(refs.nodes[1].roles, ["volume", "env"]);
    assert!(refs.nodes.iter().all(|n| n.presence == Presence::Found && n.edge == Edge::Reference));
    // 레이블이 맞는 Service만, 셀렉터가 빈 Service는 아무것도 고르지 않는다
    assert_eq!(names(&section(&x, Edge::Selector).nodes), ["Service/web"]);
    assert!(!x.truncated);
    assert_eq!(x.nodes, 1 + 1 + 2 + 2 + 1);
}

#[test]
fn pod_tree_walks_up_to_the_top_owner_and_shows_its_node() {
    let (_, mut pool) = web_world();
    let pod = pod("web-1-c", "web-1", web_labels(), json!({ "nodeName": "node-1", "containers": [] }), "Running");
    pool.add(pod.clone());
    let x = build(&pod, &pool);
    let top = &section(&x, Edge::Owner).nodes[0];
    assert_eq!((top.kind.as_str(), top.name.as_str()), ("Deployment", "web"));
    let rs = &top.children[0];
    assert_eq!(rs.name, "web-1");
    assert!(rs.children[0].current);
    let refs = names(&section(&x, Edge::Reference).nodes);
    assert!(refs.contains(&"Node/node-1".to_string()), "{refs:?}");
    // 읽지 못했거나 가져오지 않은 클러스터 객체는 없다고 하지 않는다
    assert_eq!(find(&section(&x, Edge::Reference).nodes, "Node", "node-1").unwrap().presence, Presence::Unknown);
}

#[test]
fn an_owner_that_is_gone_is_shown_as_missing_only_when_its_kind_was_read_completely() {
    let orphan = pod("web-1-a", "web-9", web_labels(), json!({ "containers": [] }), "Running");
    let read = pool_of(vec![(&pool::REPLICA_SET, vec![]), (&pool::POD, vec![orphan.clone()])]);
    let tree = build(&orphan, &read);
    let top = &section(&tree, Edge::Owner).nodes[0];
    assert_eq!((top.kind.as_str(), top.name.as_str(), top.presence), ("ReplicaSet", "web-9", Presence::Missing));
    let unread = pool_of(vec![(&pool::POD, vec![orphan.clone()])]);
    let tree = build(&orphan, &unread);
    let top = &section(&tree, Edge::Owner).nodes[0];
    assert_eq!(top.presence, Presence::Unknown);
}

#[test]
fn a_referenced_object_is_missing_when_its_list_was_read_and_unknown_when_it_was_not() {
    let spec = json!({ "containers": [{ "name": "a", "image": "x", "envFrom": [{ "secretRef": { "name": "gone" } }] }], "imagePullSecrets": [{ "name": "pull" }] });
    let root = deployment("web", web_labels(), spec);
    let pool = pool_of(vec![(&pool::DEPLOYMENT, vec![root.clone()]), (&pool::SECRET, vec![plain(&pool::SECRET, "prod", "pull")])]);
    let x = build(&root, &pool);
    let refs = &section(&x, Edge::Reference).nodes;
    assert_eq!(find(refs, "Secret", "gone").unwrap().presence, Presence::Missing);
    assert_eq!(find(refs, "Secret", "pull").unwrap().presence, Presence::Found);
    assert_eq!(find(refs, "ServiceAccount", "default").unwrap().presence, Presence::Unknown);
}

#[test]
fn volume_chain_goes_from_claim_to_volume_to_storage_class() {
    let spec = json!({ "containers": [], "volumes": [{ "name": "d", "persistentVolumeClaim": { "claimName": "data" } }], "priorityClassName": "high" });
    let root = deployment("db", json!({ "app": "db" }), spec);
    let pvc = item(&pool::PVC, json!({ "apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": { "name": "data", "namespace": "prod", "uid": "pvc1" },
        "spec": { "volumeName": "pv-1" }, "status": { "phase": "Bound" } }));
    let pv = item(&pool::PV, json!({ "apiVersion": "v1", "kind": "PersistentVolume", "metadata": { "name": "pv-1", "uid": "pv1" },
        "spec": { "storageClassName": "gp3" }, "status": { "phase": "Bound" } }));
    let sc = item(&pool::STORAGE_CLASS, json!({ "apiVersion": "storage.k8s.io/v1", "kind": "StorageClass", "metadata": { "name": "gp3", "uid": "sc1" }, "provisioner": "ebs.csi.aws.com" }));
    let mut pool = pool_of(vec![(&pool::DEPLOYMENT, vec![root.clone()]), (&pool::PVC, vec![pvc])]);
    // 클러스터 범위 객체는 이름으로 읽어 온다: 읽을 것은 PV 하나, 읽고 나면 StorageClass와 PriorityClass가 이어진다
    let wanted = unresolved_cluster_refs(&root, &pool);
    assert_eq!(wanted.iter().map(|r| (r.kind.kind.as_str(), r.name.as_str())).collect::<Vec<_>>(), [("PersistentVolume", "pv-1"), ("PriorityClass", "high")]);
    pool.add_fetched(wanted[0].key(), &wanted[0].kind, Ok(Some(pv)));
    pool.add_fetched(wanted[1].key(), &wanted[1].kind, Ok(None));
    let wanted = unresolved_cluster_refs(&root, &pool);
    assert_eq!(wanted.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["gp3"]);
    pool.add_fetched(wanted[0].key(), &wanted[0].kind, Ok(Some(sc)));
    assert!(unresolved_cluster_refs(&root, &pool).is_empty());
    let x = build(&root, &pool);
    let refs = &section(&x, Edge::Reference).nodes;
    let claim = find(refs, "PersistentVolumeClaim", "data").unwrap();
    let volume = &claim.children[0];
    assert_eq!((volume.kind.as_str(), volume.name.as_str()), ("PersistentVolume", "pv-1"));
    // StorageClass는 가장 안쪽 한 곳에만 있다
    assert_eq!(names(&volume.children), ["StorageClass/gp3"]);
    assert_eq!(refs.iter().filter(|n| n.kind == "StorageClass").count(), 0);
    assert_eq!(find(refs, "PriorityClass", "high").unwrap().presence, Presence::Missing);
}

#[test]
fn a_denied_cluster_object_is_a_gap_and_is_not_asked_again() {
    let spec = json!({ "nodeName": "node-1", "containers": [] });
    let root = pod("p", "rs", web_labels(), spec, "Running");
    let mut pool = pool_of(vec![(&pool::POD, vec![root.clone()])]);
    let wanted = unresolved_cluster_refs(&root, &pool);
    assert_eq!(wanted.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["node-1"]);
    let denied = AppError::AccessDenied { action: "get nodes".into() };
    pool.add_fetched(wanted[0].key(), &wanted[0].kind, Err(denied.clone()));
    assert!(unresolved_cluster_refs(&root, &pool).is_empty());
    let x = build(&root, &pool);
    assert_eq!(x.gaps.iter().map(|g| (g.kind.as_str(), g.error.clone())).collect::<Vec<_>>(), [("Node", denied)]);
    assert_eq!(find(&section(&x, Edge::Reference).nodes, "Node", "node-1").unwrap().presence, Presence::Unknown);
}

#[test]
fn unreadable_kinds_become_gaps_and_the_rest_still_shows() {
    let (root, _) = web_world();
    let denied = AppError::AccessDenied { action: "list services".into() };
    let mut pool = Pool::default();
    pool.add_list(&pool::DEPLOYMENT.kind_ref(), Ok((vec![root.clone()], false)));
    pool.add_list(&pool::SERVICE.kind_ref(), Err(denied.clone()));
    pool.add_list(&pool::CONFIG_MAP.kind_ref(), Err(denied.clone()));
    let x = build(&root, &pool);
    assert_eq!(x.gaps.iter().map(|g| (g.kind.as_str(), g.error.clone())).collect::<Vec<_>>(), [("Service", denied.clone()), ("ConfigMap", denied)]);
    assert!(x.sections.iter().all(|s| s.edge != Edge::Selector));
    let cm = find(&section(&x, Edge::Reference).nodes, "ConfigMap", "web-config").unwrap();
    assert_eq!(cm.presence, Presence::Unknown);
}

#[test]
fn match_expressions_select_like_kubernetes() {
    let labels = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    let web: std::collections::BTreeMap<String, String> = labels(&[("app", "web"), ("tier", "front")]);
    let s = |v: Value| selects(&v, &web);
    assert!(s(json!({ "matchExpressions": [{ "key": "app", "operator": "In", "values": ["web", "api"] }] })));
    assert!(!s(json!({ "matchExpressions": [{ "key": "app", "operator": "In", "values": ["api"] }] })));
    assert!(s(json!({ "matchExpressions": [{ "key": "app", "operator": "NotIn", "values": ["api"] }] })));
    assert!(!s(json!({ "matchExpressions": [{ "key": "app", "operator": "NotIn", "values": ["web"] }] })));
    // 레이블이 없으면 NotIn은 맞고 In은 틀리다
    assert!(s(json!({ "matchExpressions": [{ "key": "zone", "operator": "NotIn", "values": ["a"] }] })));
    assert!(!s(json!({ "matchExpressions": [{ "key": "zone", "operator": "In", "values": ["a"] }] })));
    assert!(s(json!({ "matchExpressions": [{ "key": "tier", "operator": "Exists" }] })));
    assert!(s(json!({ "matchExpressions": [{ "key": "zone", "operator": "DoesNotExist" }] })));
    assert!(!s(json!({ "matchExpressions": [{ "key": "tier", "operator": "DoesNotExist" }] })));
    // matchLabels와 matchExpressions는 모두 맞아야 한다
    assert!(!s(json!({ "matchLabels": { "app": "web" }, "matchExpressions": [{ "key": "zone", "operator": "Exists" }] })));
    // 빈 선택기는 모두 고르고, 알 수 없는 연산자는 고르지 않는다
    assert!(s(json!({})));
    assert!(!s(json!({ "matchExpressions": [{ "key": "app", "operator": "Weird" }] })));
    assert!(!s(Value::Null));
}

#[test]
fn pdbs_and_network_policies_select_the_workload_by_its_template_labels() {
    let (root, mut pool) = web_world();
    let pdb = item(&pool::PDB, json!({ "apiVersion": "policy/v1", "kind": "PodDisruptionBudget", "metadata": { "name": "web-pdb", "namespace": "prod", "uid": "pdb1" },
        "spec": { "selector": { "matchExpressions": [{ "key": "app", "operator": "In", "values": ["web"] }] } }, "status": { "disruptionsAllowed": 0 } }));
    let other = item(&pool::PDB, json!({ "apiVersion": "policy/v1", "kind": "PodDisruptionBudget", "metadata": { "name": "other-pdb", "namespace": "prod", "uid": "pdb2" },
        "spec": { "selector": { "matchLabels": { "app": "other" } } } }));
    let np = item(&pool::NETWORK_POLICY, json!({ "apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": { "name": "deny-all", "namespace": "prod", "uid": "np1" }, "spec": { "podSelector": {} } }));
    let elsewhere = item(&pool::NETWORK_POLICY, json!({ "apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": { "name": "deny-all", "namespace": "stg", "uid": "np2" }, "spec": { "podSelector": {} } }));
    for i in [pdb, other, np, elsewhere] {
        pool.add(i);
    }
    let x = build(&root, &pool);
    let selecting = &section(&x, Edge::Selector).nodes;
    assert_eq!(names(selecting), ["Service/web", "NetworkPolicy/deny-all", "PodDisruptionBudget/web-pdb"]);
    // 다른 네임스페이스의 정책은 고르지 않는다
    assert!(selecting.iter().all(|n| n.namespace.as_deref() == Some("prod")));
    assert_eq!(selecting[2].problems.len(), 1, "허용 가능한 중단이 0인 PDB는 이상 표시가 붙는다");
}

#[test]
fn a_service_shows_its_pods_ingresses_and_endpoint_slices() {
    let (_, mut pool) = web_world();
    let ingress = item(&pool::INGRESS, json!({ "apiVersion": "networking.k8s.io/v1", "kind": "Ingress", "metadata": { "name": "web", "namespace": "prod", "uid": "ing1" },
        "spec": { "tls": [{ "secretName": "web-tls" }], "rules": [{ "host": "a", "http": { "paths": [{ "backend": { "service": { "name": "web" } } }] } }] } }));
    let slice = item(&pool::ENDPOINT_SLICE, json!({ "apiVersion": "discovery.k8s.io/v1", "kind": "EndpointSlice",
        "metadata": { "name": "web-abc", "namespace": "prod", "uid": "es1", "labels": { "kubernetes.io/service-name": "web" } },
        "endpoints": [{ "targetRef": { "kind": "Pod", "name": "web-1-a" } }, { "targetRef": { "kind": "Pod", "name": "web-1-b" } }] }));
    pool.add(ingress);
    pool.add(slice);
    let svc = pool.get(&super::pool::Key::new("", "Service", Some("prod"), "web")).unwrap().clone();
    let x = build(&svc, &pool);
    assert_eq!(names(&section(&x, Edge::Selector).nodes), ["Pod/web-1-a", "Pod/web-1-b"]);
    assert_eq!(names(&section(&x, Edge::Target).nodes), ["EndpointSlice/web-abc", "Ingress/web"]);
    // Pod 쪽에서 보면 Service 아래에 같은 Ingress·EndpointSlice가 이어진다
    let deploy = pool.get(&super::pool::Key::new("apps", "Deployment", Some("prod"), "web")).unwrap().clone();
    let x = build(&deploy, &pool);
    let service = &section(&x, Edge::Selector).nodes[0];
    assert_eq!(names(&service.children), ["EndpointSlice/web-abc", "Ingress/web"]);
    assert!(service.children.iter().all(|n| n.edge == Edge::Target));
}

#[test]
fn ingress_leads_to_its_services_and_their_pods_and_tls_secret() {
    let (_, mut pool) = web_world();
    let ingress = item(&pool::INGRESS, json!({ "apiVersion": "networking.k8s.io/v1", "kind": "Ingress", "metadata": { "name": "web", "namespace": "prod", "uid": "ing1" },
        "spec": { "defaultBackend": { "service": { "name": "ghost" } }, "tls": [{ "secretName": "web-tls" }],
                  "rules": [{ "http": { "paths": [{ "backend": { "service": { "name": "web" } } }, { "backend": { "service": { "name": "web" } } }] } }] } }));
    pool.add(ingress.clone());
    let x = build(&ingress, &pool);
    let targets = &section(&x, Edge::Target).nodes;
    assert_eq!(names(targets), ["Service/ghost", "Service/web"]);
    assert_eq!(targets[0].presence, Presence::Missing);
    assert_eq!(names(&targets[1].children), ["Pod/web-1-a", "Pod/web-1-b"]);
    assert!(targets[1].children.iter().all(|n| n.edge == Edge::Selector));
    assert_eq!(names(&section(&x, Edge::Reference).nodes), ["Secret/web-tls"]);
}

#[test]
fn hpa_targets_a_workload_and_is_found_from_it() {
    let (root, mut pool) = web_world();
    let hpa = item(&pool::HPA, json!({ "apiVersion": "autoscaling/v2", "kind": "HorizontalPodAutoscaler", "metadata": { "name": "web", "namespace": "prod", "uid": "hpa1" },
        "spec": { "scaleTargetRef": { "apiVersion": "apps/v1", "kind": "Deployment", "name": "web" } } }));
    let lost = item(&pool::HPA, json!({ "apiVersion": "autoscaling/v2", "kind": "HorizontalPodAutoscaler", "metadata": { "name": "lost", "namespace": "prod", "uid": "hpa2" },
        "spec": { "scaleTargetRef": { "apiVersion": "apps/v1", "kind": "Deployment", "name": "gone" } } }));
    pool.add(hpa.clone());
    pool.add(lost.clone());
    assert_eq!(names(&section(&build(&root, &pool), Edge::Target).nodes), ["HorizontalPodAutoscaler/web"]);
    let up = build(&hpa, &pool);
    let target = &section(&up, Edge::Target).nodes[0];
    assert_eq!((target.kind.as_str(), target.name.as_str(), target.presence), ("Deployment", "web", Presence::Found));
    assert_eq!(section(&build(&lost, &pool), Edge::Target).nodes[0].presence, Presence::Missing);
}

#[test]
fn endpoint_slice_leads_to_its_service_and_pods() {
    let (_, mut pool) = web_world();
    let slice = item(&pool::ENDPOINT_SLICE, json!({ "apiVersion": "discovery.k8s.io/v1", "kind": "EndpointSlice",
        "metadata": { "name": "web-abc", "namespace": "prod", "uid": "es1", "labels": { "kubernetes.io/service-name": "web" } },
        "endpoints": [{ "targetRef": { "kind": "Pod", "name": "web-1-b" } }, { "targetRef": { "kind": "Node", "name": "n" } }, { "targetRef": { "kind": "Pod", "name": "web-1-a" } }] }));
    pool.add(slice.clone());
    let x = build(&slice, &pool);
    assert_eq!(names(&section(&x, Edge::Target).nodes), ["Service/web", "Pod/web-1-a", "Pod/web-1-b"]);
}

#[test]
fn a_config_map_shows_the_top_workload_that_uses_it_once() {
    let (_, pool) = web_world();
    let cm = pool.get(&super::pool::Key::new("", "ConfigMap", Some("prod"), "web-config")).unwrap().clone();
    let x = build(&cm, &pool);
    let refs = &section(&x, Edge::Reference).nodes;
    // Pod와 ReplicaSet은 같은 ConfigMap을 쓰지만 가장 위 소유자 Deployment 하나만 보인다
    assert_eq!(names(refs), ["Deployment/web"]);
    assert_eq!(refs[0].roles, ["usedBy", "volume", "env"]);
    assert!(x.sections.iter().all(|s| s.edge == Edge::Reference));
}

#[test]
fn a_node_shows_the_pods_on_it_and_a_volume_shows_claims_and_their_users() {
    let on_node = pod("p1", "rs", web_labels(), json!({ "nodeName": "node-1", "containers": [], "volumes": [{ "name": "d", "persistentVolumeClaim": { "claimName": "data" } }] }), "Running");
    let node = item(&pool::NODE, json!({ "apiVersion": "v1", "kind": "Node", "metadata": { "name": "node-1", "uid": "n1" }, "status": { "conditions": [{ "type": "Ready", "status": "False" }] } }));
    let pvc = item(&pool::PVC, json!({ "apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": { "name": "data", "namespace": "prod", "uid": "pvc1" }, "spec": { "volumeName": "pv-1", "storageClassName": "gp3" } }));
    let pv = item(&pool::PV, json!({ "apiVersion": "v1", "kind": "PersistentVolume", "metadata": { "name": "pv-1", "uid": "pv1" }, "spec": { "storageClassName": "gp3" } }));
    let sc = item(&pool::STORAGE_CLASS, json!({ "apiVersion": "storage.k8s.io/v1", "kind": "StorageClass", "metadata": { "name": "gp3", "uid": "sc1" } }));
    let pool = pool_of(vec![(&pool::POD, vec![on_node]), (&pool::PVC, vec![pvc]), (&pool::PV, vec![pv.clone()])]);
    let x = build(&node, &pool);
    assert_eq!(names(&section(&x, Edge::Reference).nodes), ["Pod/p1"]);
    assert_eq!(section(&x, Edge::Reference).nodes[0].roles, ["usedBy", "node"]);
    // PV는 자기가 가리키는 StorageClass가 먼저, 그다음 이 PV를 쓰는 PVC와 그 PVC를 쓰는 Pod
    let x = build(&pv, &pool);
    let refs = &section(&x, Edge::Reference).nodes;
    assert_eq!(names(refs), ["StorageClass/gp3", "PersistentVolumeClaim/data"]);
    assert_eq!(refs[1].roles, ["usedBy", "volume"]);
    assert_eq!(names(&refs[1].children), ["Pod/p1"]);
    // StorageClass 아래에서는 PVC가 한 번만 나온다(PV 아래 중복 없이)
    let x = build(&sc, &pool);
    let refs = &section(&x, Edge::Reference).nodes;
    assert_eq!(names(refs), ["PersistentVolumeClaim/data", "PersistentVolume/pv-1"]);
    assert_eq!(names(&refs[0].children), ["Pod/p1"]);
    assert!(refs[1].children.is_empty());
}

#[test]
fn a_parent_with_many_children_is_cut_to_the_fan_out_limit_and_says_so() {
    let root = deployment("web", web_labels(), json!({ "containers": [] }));
    let pods: Vec<Item> = (0..FAN_OUT_MAX + 10).map(|i| pod(&format!("web-1-{i:03}"), "web-1", web_labels(), json!({ "containers": [] }), "Running")).collect();
    let pool = pool_of(vec![(&pool::DEPLOYMENT, vec![root.clone()]), (&pool::REPLICA_SET, vec![replica_set("web-1", "web")]), (&pool::POD, pods)]);
    let x = build(&root, &pool);
    assert!(x.truncated);
    assert_eq!(section(&x, Edge::Owner).nodes[0].children[0].children.len(), FAN_OUT_MAX);
}

#[test]
fn the_whole_tree_is_cut_to_the_node_limit_and_says_so() {
    let root = deployment("web", web_labels(), json!({ "containers": [] }));
    let sets: Vec<Item> = (0..8).map(|i| replica_set(&format!("web-{i}"), "web")).collect();
    let pods: Vec<Item> = (0..8).flat_map(|i| (0..FAN_OUT_MAX).map(move |j| pod(&format!("web-{i}-{j:02}"), &format!("web-{i}"), web_labels(), json!({ "containers": [] }), "Running"))).collect();
    let pool = pool_of(vec![(&pool::DEPLOYMENT, vec![root.clone()]), (&pool::REPLICA_SET, sets), (&pool::POD, pods)]);
    let x = build(&root, &pool);
    assert!(x.truncated);
    assert_eq!(x.nodes, NODES_MAX);
}

#[test]
fn a_kind_read_only_partly_is_reported_and_never_called_missing() {
    let spec = json!({ "containers": [], "volumes": [{ "name": "c", "configMap": { "name": "maybe" } }] });
    let root = deployment("web", web_labels(), spec);
    let mut pool = Pool::default();
    pool.add_list(&pool::DEPLOYMENT.kind_ref(), Ok((vec![root.clone()], false)));
    pool.add_list(&pool::CONFIG_MAP.kind_ref(), Ok((vec![], true)));
    let x = build(&root, &pool);
    assert_eq!(x.partial, ["ConfigMap"]);
    assert_eq!(find(&section(&x, Edge::Reference).nodes, "ConfigMap", "maybe").unwrap().presence, Presence::Unknown);
}

#[test]
fn references_merge_roles_and_skip_empty_names() {
    let spec = json!({
        "containers": [{ "name": "a", "image": "x", "env": [{ "name": "A", "valueFrom": { "secretKeyRef": { "name": "s" } } }], "envFrom": [{ "configMapRef": { "name": "c" } }] }],
        "initContainers": [{ "name": "i", "image": "x", "envFrom": [{ "secretRef": { "name": "s" } }] }],
        "volumes": [
            { "name": "p", "projected": { "sources": [{ "configMap": { "name": "c" } }, { "secret": { "name": "s2" } }] } },
            { "name": "e", "emptyDir": {} }
        ],
        "serviceAccount": "legacy",
        "imagePullSecrets": [{ "name": "" }]
    });
    let refs = refs_of(&deployment("web", web_labels(), spec));
    let shown: Vec<(String, Vec<String>)> = refs.iter().map(|r| (format!("{}/{}", r.kind.kind, r.name), r.roles.clone())).collect();
    assert_eq!(shown, [
        ("ServiceAccount/legacy".to_string(), vec!["serviceAccount".to_string()]),
        ("ConfigMap/c".to_string(), vec!["volume".to_string(), "env".to_string()]),
        ("Secret/s2".to_string(), vec!["volume".to_string()]),
        ("Secret/s".to_string(), vec!["env".to_string()]),
    ]);
}

#[test]
fn a_secret_root_keeps_no_data() {
    let secret = Item::meta(&pool::SECRET.kind_ref(), &obj(json!({ "metadata": { "name": "pw", "namespace": "prod", "uid": "s1" }, "data": { "k": "c2VjcmV0" } })).metadata);
    assert_eq!(secret.data, Value::Null);
    let (_, pool) = web_world();
    let x = build(&secret, &pool);
    assert!(x.sections.is_empty());
}

#[test]
fn replaced_owner_uid_is_not_resolved_by_name() {
    let child = pod("p", "old", json!({}), json!({"containers": []}), "Running");
    let mut replacement = replica_set("old", "web");
    replacement.uid = "replacement".into();
    let pool = pool_of(vec![(&pool::POD, vec![child.clone()]), (&pool::REPLICA_SET, vec![replacement])]);
    let tree = build(&child, &pool);
    let node = &section(&tree, Edge::Owner).nodes[0];
    assert_eq!(node.name, "old");
    assert_eq!(node.presence, Presence::Missing);
}

#[test]
fn endpoint_targets_keep_namespaces_and_reverse_links() {
    let root = pod("p", "rs", json!({}), json!({"containers": []}), "Running");
    let slice = item(&pool::ENDPOINT_SLICE, json!({
        "apiVersion": "discovery.k8s.io/v1", "kind": "EndpointSlice",
        "metadata": {"name": "slice", "namespace": "prod", "uid": "slice", "labels": {"kubernetes.io/service-name": "svc"}},
        "endpoints": [
            {"targetRef": {"kind": "Pod", "name": "p", "namespace": "prod"}},
            {"targetRef": {"kind": "Pod", "name": "p", "namespace": "other"}},
            {"targetRef": {"kind": "Pod", "name": "p", "namespace": "other"}}
        ]
    }));
    let pool = pool_of(vec![(&pool::POD, vec![root.clone()]), (&pool::ENDPOINT_SLICE, vec![slice.clone()]), (&pool::SERVICE, vec![service("svc", json!({}))])]);
    let tree = build(&slice, &pool);
    let pods: Vec<_> = section(&tree, Edge::Target).nodes.iter().filter(|n| n.kind == "Pod").collect();
    assert_eq!(pods.len(), 2);
    assert_eq!(pods.iter().find(|n| n.namespace.as_deref() == Some("prod")).unwrap().presence, Presence::Found);
    assert_eq!(pods.iter().find(|n| n.namespace.as_deref() == Some("other")).unwrap().presence, Presence::Unknown);
    let reverse = build(&root, &pool);
    let slice_node = find(&section(&reverse, Edge::Target).nodes, "EndpointSlice", "slice").unwrap();
    assert!(find(&slice_node.children, "Service", "svc").is_some());
}

#[test]
fn ingress_deduplicates_before_capping_targets() {
    let paths: Vec<_> = (0..60).map(|i| json!({"backend": {"service": {"name": format!("svc-{i}")}}})).collect();
    let ingress = item(&pool::INGRESS, json!({"apiVersion":"networking.k8s.io/v1", "kind":"Ingress", "metadata":{"name":"in","namespace":"prod","uid":"in"}, "spec":{"rules":[{"http":{"paths":paths}}]}}));
    let tree = build(&ingress, &Pool::default());
    assert_eq!(section(&tree, Edge::Target).nodes.len(), FAN_OUT_MAX);
    assert!(tree.truncated);
}

#[test]
fn owner_cycles_and_depth_limits_are_reported_correctly() {
    let make = |n: usize, parent: Option<usize>| item(&pool::POD, json!({
        "apiVersion":"v1", "kind":"Pod", "metadata":{"name":format!("p{n}"),"namespace":"prod","uid":format!("u{n}"),
        "ownerReferences": parent.map(|p| owner("Pod", &format!("p{p}"), &format!("u{p}"))).unwrap_or(json!([]))},
        "spec":{"containers":[]}
    }));
    let a = make(0, Some(1));
    let b = make(1, Some(0));
    let tree = build(&a, &pool_of(vec![(&pool::POD, vec![a.clone(), b])]));
    let top = &section(&tree, Edge::Owner).nodes[0];
    assert_eq!(top.name, "p1");
    assert!(top.children[0].current);
    assert!(top.children[0].children.is_empty());
    let chain: Vec<_> = (0..11).map(|i| make(i, (i > 0).then_some(i.saturating_sub(1)))).collect();
    let pool = pool_of(vec![(&pool::POD, chain.clone())]);
    assert!(build(&chain[0], &pool).truncated);
    assert!(build(&chain[10], &pool).truncated);
}

#[test]
fn reverse_endpoint_slices_are_capped() {
    let root = pod("p", "rs", json!({}), json!({"containers": []}), "Running");
    let slices: Vec<_> = (0..60).map(|i| item(&pool::ENDPOINT_SLICE, json!({
        "apiVersion":"discovery.k8s.io/v1", "kind":"EndpointSlice",
        "metadata":{"name":format!("s{i}"),"namespace":"prod","uid":format!("s{i}")},
        "endpoints":[{"targetRef":{"kind":"Pod","namespace":"prod","name":"p"}}]
    }))).collect();
    let pool = pool_of(vec![(&pool::POD, vec![root.clone()]), (&pool::ENDPOINT_SLICE, slices)]);
    let tree = build(&root, &pool);
    assert_eq!(section(&tree, Edge::Target).nodes.len(), FAN_OUT_MAX);
    assert!(tree.truncated);
}
