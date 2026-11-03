//! 네트워크 화면(K6)의 쿠버네티스 쪽을 kind에서 읽는다. 픽스처는 `scripts/k8s-live/network.sh`(mm-net, mm-net-open 네임스페이스).
//! AWS에는 닿지 않는 것으로 두고(클라이언트를 만들지 못한 것과 같은 모양), 읽지 못한 AWS 부분이 gap으로 남는지도 본다.
use super::{admin, build, reader_config, PRIVATE};
use crate::error::AppError;
use crate::k8s::connect::client_for;
use crate::k8s::network::model::{Network, Section, SourceKind, Unmatched};
use crate::k8s::network::{cluster, collect};

const NO_AWS: &str = "AWS를 쓰지 않는 시험이에요";

async fn read_with(client: &kube::Client) -> Network {
    let parts = cluster::read(client, PRIVATE).await;
    collect(&Err(AppError::other(NO_AWS)), "mm-live", parts, Err(AppError::other(NO_AWS))).await
}

#[tokio::test]
#[ignore]
async fn services_ingresses_and_policies_are_read_and_aws_parts_are_gaps() {
    let n = read_with(&admin().await).await;

    // AWS를 읽지 못한 부분은 같은 이유의 gap이고, 쿠버네티스 쪽은 그대로다
    let sections: Vec<Section> = n.gaps.iter().map(|g| g.section).collect();
    assert_eq!(sections, [Section::Cluster, Section::Instances, Section::Subnets, Section::LoadBalancers], "gaps: {:?}", n.gaps);
    assert!(n.gaps.iter().all(|g| g.error == AppError::other(NO_AWS)));
    assert_eq!(n.vpc_id, None);

    // LoadBalancer Service와 Ingress만 행이 된다(ClusterIP인 internal은 아니다)
    let rows = n.load_balancers.as_ref().expect("load balancer rows");
    let names: Vec<String> = rows.iter().filter(|r| r.source.namespace == "mm-net").map(|r| format!("{:?}/{}", r.source.kind, r.source.name)).collect();
    assert_eq!(names, ["Service/lb-web", "Ingress/site"]);
    let svc = rows.iter().find(|r| r.source.name == "lb-web").unwrap();
    assert_eq!(svc.source.kind, SourceKind::Service);
    assert_eq!(svc.source.ports, ["80/TCP", "443/TCP"]);
    // kind에는 클라우드 컨트롤러가 없어 주소가 영영 없다
    assert!(svc.source.hostnames.is_empty() && svc.source.ips.is_empty());
    assert_eq!(svc.unmatched, Some(Unmatched::Pending));
    assert!(svc.load_balancer.is_none());
    let ing = rows.iter().find(|r| r.source.name == "site").unwrap();
    assert_eq!(ing.source.class.as_deref(), Some("alb"));
    assert_eq!(ing.source.group.as_deref(), Some("mm-group"));
    assert_eq!(ing.source.ports, ["app.example.com/ → lb-web:80"]);

    // NetworkPolicy: 목록과 규칙 요약
    let policies: Vec<(&str, &str)> = n.policies.as_ref().unwrap().iter().filter(|p| p.namespace == "mm-net").map(|p| (p.name.as_str(), p.pod_selector.as_str())).collect();
    assert_eq!(policies, [("allow-web", "app=web"), ("default-deny", "")]);
    let allow = n.policies.as_ref().unwrap().iter().find(|p| p.name == "allow-web").unwrap();
    // policyTypes를 비웠으니 Ingress만(egress 규칙이 없다)
    assert_eq!(allow.types, ["Ingress"]);
    assert_eq!(allow.ingress.len(), 1);
    let rule = &allow.ingress[0];
    assert_eq!(rule.peers[0].pod_selector.as_deref(), Some("app=client"));
    assert_eq!(rule.peers[1].ip_block.as_ref().map(|b| (b.cidr.as_str(), b.except.clone())), Some(("10.0.0.0/8", vec!["10.9.0.0/16".to_string()])));
    assert_eq!((rule.ports[0].protocol.as_str(), rule.ports[0].port.as_deref()), ("TCP", Some("80")));
    let deny = n.policies.as_ref().unwrap().iter().find(|p| p.name == "default-deny").unwrap();
    assert_eq!(deny.types, ["Ingress", "Egress"]);
    assert!(deny.ingress.is_empty() && deny.egress.is_empty());

    // 정책이 없는 네임스페이스에 표시가 붙는다(mm-net-open은 없고, mm-net은 둘)
    let ns = n.namespaces.as_ref().unwrap();
    let of = |name: &str| ns.iter().find(|x| x.name == name).map(|x| (x.policies, x.system));
    assert_eq!(of("mm-net"), Some((2, false)));
    assert_eq!(of("mm-net-open"), Some((0, false)));
    assert_eq!(of("kube-system"), Some((0, true)));
}

#[tokio::test]
#[ignore]
async fn kind_nodes_have_no_instance_and_pods_have_ips_without_the_vpc_cni() {
    let n = read_with(&admin().await).await;
    let nodes = n.nodes.as_ref().unwrap();
    assert!(nodes.len() >= 2, "nodes: {nodes:?}");
    // kind 노드의 providerID는 `kind://…`라 EC2 인스턴스가 아니다
    assert!(nodes.iter().all(|x| x.instance_id.is_none() && !x.fargate && x.internal_ip.is_some()), "nodes: {nodes:?}");
    assert!(nodes.iter().all(|x| x.ready));
    assert!(n.highlight.is_empty());

    let pods = n.pods.as_ref().unwrap();
    // aws-node가 없으니 VPC CNI가 아니고, Pod IP는 서브넷에 이어지지 않는다
    assert!(!pods.vpc_cni);
    assert!(pods.items.iter().all(|p| p.subnet_id.is_none()));
    let web = pods.items.iter().find(|p| p.namespace == "mm-net" && p.name.starts_with("web-")).expect("web pod with an ip");
    assert!(web.ip.parse::<std::net::IpAddr>().is_ok(), "ip: {}", web.ip);
    assert!(!web.host_network && web.node.is_some());
    assert_eq!(n.subnets, None);
}

#[tokio::test]
#[ignore]
async fn a_reader_without_cluster_wide_access_gets_gaps_not_a_failure() {
    let (context, value) = reader_config();
    let client = client_for(&build(&value), &context, PRIVATE).await.unwrap();
    let n = read_with(&client).await;
    // 쿠버네티스의 여섯 목록이 모두 권한 오류 gap이다. 화면 전체는 실패하지 않는다.
    let k8s: Vec<(Section, &AppError)> = n.gaps.iter().filter(|g| !matches!(g.section, Section::Cluster | Section::Instances | Section::Subnets | Section::LoadBalancers)).map(|g| (g.section, &g.error)).collect();
    let sections: Vec<Section> = k8s.iter().map(|(s, _)| *s).collect();
    assert_eq!(sections, [Section::Services, Section::Ingresses, Section::Nodes, Section::Pods, Section::Policies, Section::Namespaces]);
    for (section, error) in &k8s {
        assert!(matches!(error, AppError::AccessDenied { .. }), "{section:?}: {error:?}");
    }
    assert!(n.load_balancers.is_none() && n.nodes.is_none() && n.pods.is_none() && n.policies.is_none() && n.namespaces.is_none());
}
