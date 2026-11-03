use std::collections::BTreeMap;

use serde_json::json;

use super::*;

fn object(value: Value) -> DynamicObject {
    serde_json::from_value(value).unwrap()
}

fn service(ns: &str, name: &str, spec: Value, hostname: Option<&str>) -> DynamicObject {
    let status = hostname.map_or(json!({}), |h| json!({ "loadBalancer": { "ingress": [{ "hostname": h }] } }));
    object(json!({ "apiVersion": "v1", "kind": "Service", "metadata": { "namespace": ns, "name": name }, "spec": spec, "status": status }))
}

fn lb(name: &str, dns: &str, tags: &[(&str, &str)]) -> AwsLb {
    AwsLb {
        arn: format!("arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:loadbalancer/app/{name}/1"),
        name: name.into(),
        dns_name: dns.into(),
        kind: Some(LbKind::Application),
        scheme: Some("internet-facing".into()),
        state: Some("active".into()),
        vpc_id: Some("vpc-1".into()),
        zones: vec![],
        security_groups: vec![],
        tags: tags.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>(),
    }
}

fn source(kind: SourceKind, ns: &str, name: &str, hostnames: &[&str], group: Option<&str>) -> LbSource {
    LbSource {
        kind,
        namespace: ns.into(),
        name: name.into(),
        class: None,
        hostnames: hostnames.iter().map(|h| h.to_string()).collect(),
        ips: vec![],
        ports: vec![],
        group: group.map(str::to_string),
    }
}

#[test]
fn only_load_balancer_services_become_sources_with_their_ports_and_address() {
    let items = [
        service("shop", "web", json!({ "type": "LoadBalancer", "loadBalancerClass": "service.k8s.aws/nlb", "ports": [{ "port": 80, "protocol": "TCP" }, { "port": 53, "protocol": "UDP" }, { "port": 443 }] }), Some("k8s-shop-web-abc.elb.ap-northeast-2.amazonaws.com")),
        service("shop", "db", json!({ "type": "ClusterIP" }), None),
        service("shop", "node", json!({ "type": "NodePort" }), None),
        service("alpha", "pending", json!({ "type": "LoadBalancer" }), None),
    ];
    let out = service_sources(&items);
    // 이름 순이고 ClusterIP·NodePort는 빠진다
    assert_eq!(out.iter().map(|s| format!("{}/{}", s.namespace, s.name)).collect::<Vec<_>>(), ["alpha/pending", "shop/web"]);
    let web = &out[1];
    assert_eq!(web.class.as_deref(), Some("service.k8s.aws/nlb"));
    assert_eq!(web.ports, ["80/TCP", "53/UDP", "443/TCP"]);
    assert_eq!(web.hostnames, ["k8s-shop-web-abc.elb.ap-northeast-2.amazonaws.com"]);
    // 아직 주소가 없다
    assert!(out[0].hostnames.is_empty());
}

#[test]
fn legacy_in_tree_services_keep_their_type_annotation_as_the_class() {
    let svc = object(json!({
        "apiVersion": "v1", "kind": "Service",
        "metadata": { "namespace": "a", "name": "s", "annotations": { "service.beta.kubernetes.io/aws-load-balancer-type": "nlb" } },
        "spec": { "type": "LoadBalancer" },
    }));
    assert_eq!(service_sources(&[svc])[0].class.as_deref(), Some("nlb"));
}

#[test]
fn ingresses_carry_class_group_and_a_readable_rule_list() {
    let ing = object(json!({
        "apiVersion": "networking.k8s.io/v1", "kind": "Ingress",
        "metadata": { "namespace": "shop", "name": "web", "annotations": { "alb.ingress.kubernetes.io/group.name": "public", "kubernetes.io/ingress.class": "alb" } },
        "spec": {
            "defaultBackend": { "service": { "name": "fallback", "port": { "number": 80 } } },
            "rules": [
                { "host": "shop.example.com", "http": { "paths": [
                    { "path": "/api", "backend": { "service": { "name": "api", "port": { "number": 8080 } } } },
                    { "path": "/", "backend": { "service": { "name": "web", "port": { "name": "http" } } } },
                ] } },
                { "http": { "paths": [{ "backend": { "resource": { "kind": "Bucket", "name": "assets" } } }] } },
            ],
        },
        "status": { "loadBalancer": { "ingress": [{ "hostname": "k8s-public-1.ap-northeast-2.elb.amazonaws.com" }] } },
    }));
    let s = &ingress_sources(&[ing])[0];
    assert_eq!(s.kind, SourceKind::Ingress);
    assert_eq!(s.class.as_deref(), Some("alb"));
    assert_eq!(s.group.as_deref(), Some("public"));
    assert_eq!(s.ports, ["(기본) → fallback:80", "shop.example.com/api → api:8080", "shop.example.com/ → web:http", "*/ → Bucket/assets"]);
    assert_eq!(s.hostnames, ["k8s-public-1.ap-northeast-2.elb.amazonaws.com"]);
}

#[test]
fn the_hostname_finds_the_load_balancer_ignoring_case_trailing_dot_and_dualstack() {
    let lbs = [lb("other", "other-1.ap-northeast-2.elb.amazonaws.com", &[]), lb("web", "k8s-shop-web-1.ap-northeast-2.elb.amazonaws.com", &[])];
    for host in ["k8s-shop-web-1.ap-northeast-2.elb.amazonaws.com", "K8S-SHOP-WEB-1.ap-northeast-2.ELB.amazonaws.com.", "dualstack.k8s-shop-web-1.ap-northeast-2.elb.amazonaws.com"] {
        let s = source(SourceKind::Service, "shop", "web", &[host], None);
        assert_eq!(find(&s, "prod", &lbs), Some(Found { index: 1, by: MatchedBy::Hostname }), "{host}");
    }
}

#[test]
fn without_a_hostname_the_controller_tags_find_it_but_only_for_this_cluster() {
    let tags = [(CLUSTER_TAG, "prod"), (SERVICE_STACK_TAG, "shop/web")];
    let lbs = [lb("web", "web-1.elb.amazonaws.com", &tags)];
    let s = source(SourceKind::Service, "shop", "web", &[], None);
    assert_eq!(find(&s, "prod", &lbs), Some(Found { index: 0, by: MatchedBy::Tag }));
    // 같은 네임스페이스/이름이라도 다른 클러스터의 로드 밸런서는 가져오지 않는다
    assert_eq!(find(&s, "staging", &lbs), None);
    // 클러스터 태그가 없는 것도 마찬가지
    let untagged = [lb("web", "web-1.elb.amazonaws.com", &[(SERVICE_STACK_TAG, "shop/web")])];
    assert_eq!(find(&s, "prod", &untagged), None);
}

#[test]
fn a_service_is_not_matched_by_an_ingress_stack_tag_and_vice_versa() {
    let lbs = [lb("x", "x-1.elb.amazonaws.com", &[(CLUSTER_TAG, "prod"), (INGRESS_STACK_TAG, "shop/web")])];
    assert_eq!(find(&source(SourceKind::Service, "shop", "web", &[], None), "prod", &lbs), None);
    assert_eq!(find(&source(SourceKind::Ingress, "shop", "web", &[], None), "prod", &lbs), Some(Found { index: 0, by: MatchedBy::Tag }));
}

#[test]
fn an_ingress_group_matches_the_group_name_not_the_ingress_name() {
    let lbs = [lb("public", "p-1.elb.amazonaws.com", &[(CLUSTER_TAG, "prod"), (INGRESS_STACK_TAG, "public")])];
    let grouped = source(SourceKind::Ingress, "shop", "web", &[], Some("public"));
    let other = source(SourceKind::Ingress, "shop", "api", &[], Some("public"));
    let ungrouped = source(SourceKind::Ingress, "shop", "public", &[], None);
    // 같은 그룹의 Ingress는 모두 같은 로드 밸런서를 가리킨다
    assert_eq!(find(&grouped, "prod", &lbs).map(|f| f.index), Some(0));
    assert_eq!(find(&other, "prod", &lbs).map(|f| f.index), Some(0));
    // 그룹이 없으면 `네임스페이스/이름`이 stack이라 이 로드 밸런서와 맞지 않는다
    assert_eq!(find(&ungrouped, "prod", &lbs), None);
}

#[test]
fn hostname_and_tag_agreeing_is_reported_as_both() {
    let lbs = [lb("web", "web-1.elb.amazonaws.com", &[(CLUSTER_TAG, "prod"), (SERVICE_STACK_TAG, "shop/web")])];
    let s = source(SourceKind::Service, "shop", "web", &["web-1.elb.amazonaws.com"], None);
    assert_eq!(find(&s, "prod", &lbs), Some(Found { index: 0, by: MatchedBy::Both }));
}

#[test]
fn a_hostname_beats_a_tag_that_points_elsewhere() {
    // 지우고 다시 만든 Service: status의 주소가 가리키는 쪽이 지금 쓰는 로드 밸런서다
    let lbs = [
        lb("old", "old-1.elb.amazonaws.com", &[(CLUSTER_TAG, "prod"), (SERVICE_STACK_TAG, "shop/web")]),
        lb("new", "new-1.elb.amazonaws.com", &[]),
    ];
    let s = source(SourceKind::Service, "shop", "web", &["new-1.elb.amazonaws.com"], None);
    assert_eq!(find(&s, "prod", &lbs), Some(Found { index: 1, by: MatchedBy::Hostname }));
}

#[test]
fn a_stale_hostname_falls_back_to_the_tag() {
    let lbs = [lb("web", "web-2.elb.amazonaws.com", &[(CLUSTER_TAG, "prod"), (SERVICE_STACK_TAG, "shop/web")])];
    let s = source(SourceKind::Service, "shop", "web", &["gone-1.elb.amazonaws.com"], None);
    assert_eq!(find(&s, "prod", &lbs), Some(Found { index: 0, by: MatchedBy::Tag }));
}

#[test]
fn two_load_balancers_with_the_same_stack_resolve_by_name_not_by_order() {
    let tags = [(CLUSTER_TAG, "prod"), (SERVICE_STACK_TAG, "shop/web")];
    let a = lb("a-first", "a-1.elb.amazonaws.com", &tags);
    let z = lb("z-last", "z-1.elb.amazonaws.com", &tags);
    let s = source(SourceKind::Service, "shop", "web", &[], None);
    assert_eq!(find(&s, "prod", &[z.clone(), a.clone()]).map(|f| f.index), Some(1));
    assert_eq!(find(&s, "prod", &[a, z]).map(|f| f.index), Some(0));
}

#[test]
fn no_candidates_means_no_match() {
    let s = source(SourceKind::Service, "shop", "web", &["x.elb.amazonaws.com"], None);
    assert_eq!(find(&s, "prod", &[]), None);
}

#[test]
fn unclaimed_lists_only_this_clusters_load_balancers_nobody_points_at() {
    let tagged = |name: &str, cluster: &str, stack: (&str, &str)| lb(name, &format!("{name}.elb.amazonaws.com"), &[(CLUSTER_TAG, cluster), stack]);
    let lbs = [
        tagged("claimed", "prod", (SERVICE_STACK_TAG, "shop/web")),
        tagged("orphan-b", "prod", (INGRESS_STACK_TAG, "public")),
        tagged("orphan-a", "prod", (SERVICE_STACK_TAG, "old/gone")),
        tagged("elsewhere", "staging", (SERVICE_STACK_TAG, "shop/web")),
        lb("manual", "manual.elb.amazonaws.com", &[]),
    ];
    let claimed: HashSet<String> = [lbs[0].arn.clone()].into_iter().collect();
    let out = unclaimed(&lbs, "prod", &claimed);
    assert_eq!(out.iter().map(|u| (u.name.as_str(), u.stack.as_deref())).collect::<Vec<_>>(), [("orphan-a", Some("old/gone")), ("orphan-b", Some("public"))]);
}

fn node(name: &str, instance: Option<&str>, ip: &str) -> NodeNet {
    NodeNet {
        name: name.into(), ready: true, provider_id: None, instance_id: instance.map(str::to_string), fargate: false, instance_type: None,
        internal_ip: Some(ip.into()), zone: None, instance_state: None, subnet_id: None,
    }
}

fn pod(ns: &str, name: &str, ip: &str, host_network: bool) -> PodNet {
    PodNet { namespace: ns.into(), name: name.into(), ip: ip.into(), node: None, host_network, subnet_id: None }
}

#[test]
fn targets_resolve_to_pods_by_ip_and_nodes_by_instance_id() {
    let nodes = [node("ip-10-0-1-5", Some("i-0abc"), "10.0.1.5")];
    let pods = [pod("shop", "web-1", "10.0.1.77", false)];
    assert_eq!(target_link("10.0.1.77", &nodes, &pods), Some(ObjectLink { kind: "Pod".into(), namespace: Some("shop".into()), name: "web-1".into() }));
    assert_eq!(target_link("i-0abc", &nodes, &pods), Some(ObjectLink { kind: "Node".into(), namespace: None, name: "ip-10-0-1-5".into() }));
    assert_eq!(target_link("i-0zzz", &nodes, &pods), None);
}

#[test]
fn a_host_network_pod_ip_resolves_to_its_node_not_the_pod() {
    // hostNetwork Pod의 IP는 노드 IP다. 어느 Pod인지 알 수 없으니 노드로 잇는다
    let nodes = [node("ip-10-0-1-5", Some("i-0abc"), "10.0.1.5")];
    let pods = [pod("kube-system", "aws-node-x", "10.0.1.5", true)];
    assert_eq!(target_link("10.0.1.5", &nodes, &pods).map(|l| l.kind), Some("Node".to_string()));
}
