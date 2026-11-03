use kube::api::DynamicObject;
use serde_json::{json, Value};

use super::mock_aws::*;
use super::model::{LbKind, MatchedBy, Unmatched};
use super::*;

const VPC: &str = "vpc-1";

fn object(value: Value) -> DynamicObject {
    serde_json::from_value(value).unwrap()
}

fn service(ns: &str, name: &str, ty: &str, hostname: Option<&str>) -> DynamicObject {
    let status = hostname.map_or(json!({}), |h| json!({ "loadBalancer": { "ingress": [{ "hostname": h }] } }));
    object(json!({ "apiVersion": "v1", "kind": "Service", "metadata": { "namespace": ns, "name": name }, "spec": { "type": ty, "ports": [{ "port": 80 }] }, "status": status }))
}

fn ingress(ns: &str, name: &str, group: Option<&str>) -> DynamicObject {
    let annotations = group.map_or(json!({}), |g| json!({ "alb.ingress.kubernetes.io/group.name": g }));
    object(json!({ "apiVersion": "networking.k8s.io/v1", "kind": "Ingress", "metadata": { "namespace": ns, "name": name, "annotations": annotations }, "spec": {} }))
}

fn node(name: &str, provider: &str, ip: &str, labels: Value) -> DynamicObject {
    object(json!({
        "apiVersion": "v1", "kind": "Node", "metadata": { "name": name, "labels": labels }, "spec": { "providerID": provider },
        "status": { "conditions": [{ "type": "Ready", "status": "True" }], "addresses": [{ "type": "InternalIP", "address": ip }] },
    }))
}

fn pod(ns: &str, name: &str, ip: Option<&str>, host_network: bool, labels: Value) -> DynamicObject {
    object(json!({
        "apiVersion": "v1", "kind": "Pod", "metadata": { "namespace": ns, "name": name, "labels": labels },
        "spec": { "nodeName": "ip-10-0-0-10", "hostNetwork": host_network }, "status": ip.map_or(json!({}), |ip| json!({ "podIP": ip })),
    }))
}

fn namespace(name: &str) -> DynamicObject {
    object(json!({ "apiVersion": "v1", "kind": "Namespace", "metadata": { "name": name } }))
}

fn policy(ns: &str, name: &str) -> DynamicObject {
    object(json!({ "apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": { "namespace": ns, "name": name }, "spec": { "podSelector": {} } }))
}

fn denied(action: &str) -> AppError {
    AppError::AccessDenied { action: action.into() }
}

/// 노드 셋(인스턴스 둘과 Fargate), Pod 여섯(IP가 없는 하나 포함, VPC CNI는 아직 없음), Service·Ingress, 정책 하나, 네임스페이스 셋
fn parts() -> cluster::Parts {
    cluster::Parts {
        services: Ok(vec![
            service("shop", "web", "LoadBalancer", Some("web-1.ap-northeast-2.elb.amazonaws.com")),
            service("shop", "api", "LoadBalancer", None),
            service("shop", "pending", "LoadBalancer", None),
            service("shop", "legacy", "LoadBalancer", Some("classic-1.ap-northeast-2.elb.amazonaws.com")),
            service("shop", "db", "ClusterIP", None),
        ]),
        ingresses: Ok(vec![ingress("shop", "site", Some("public")), ingress("blog", "posts", Some("public"))]),
        nodes: Ok(vec![
            node("ip-10-0-0-10", "aws:///ap-northeast-2a/i-0aaa", "10.0.0.10", json!({})),
            node("ip-10-0-1-10", "aws:///ap-northeast-2c/i-0bbb", "10.0.1.10", json!({})),
            node("fargate-x", "aws:///ap-northeast-2a/fargate-x", "10.0.0.99", json!({ "eks.amazonaws.com/compute-type": "fargate" })),
        ]),
        pods: Ok((
            vec![
                pod("shop", "web-1", Some("10.0.0.77"), false, json!({})),
                pod("shop", "web-2", Some("10.0.1.5"), false, json!({})),
                pod("shop", "custom", Some("100.64.0.9"), false, json!({})),
                pod("monitoring", "node-exporter", Some("10.0.0.10"), true, json!({})),
                pod("shop", "stray", Some("192.168.1.1"), false, json!({})),
                pod("shop", "pending", None, false, json!({})),
            ],
            false,
        )),
        policies: Ok(vec![policy("shop", "default-deny")]),
        namespaces: Ok(vec![namespace("shop"), namespace("blog"), namespace("kube-system")]),
    }
}

fn arn(name: &str) -> String {
    format!("arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:loadbalancer/app/{name}/1")
}

fn tg_arn(lb: &str) -> String {
    format!("arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:targetgroup/{lb}-tg/1")
}

fn tags(name: &str) -> Vec<(&'static str, &'static str)> {
    match name {
        "api" => vec![("elbv2.k8s.aws/cluster", "prod"), ("service.k8s.aws/stack", "shop/api")],
        "public" => vec![("elbv2.k8s.aws/cluster", "prod"), ("ingress.k8s.aws/stack", "public")],
        "orphan" => vec![("elbv2.k8s.aws/cluster", "prod"), ("service.k8s.aws/stack", "gone/svc")],
        _ => vec![],
    }
}

/// 이 클러스터의 로드 밸런서 넷(web은 호스트명, api·public은 태그, orphan은 짝 없음)과 다른 VPC의 하나
fn aws_routes(sent: &Sent) -> (u16, String) {
    let names = ["web", "api", "public", "orphan"];
    match sent.action.as_str() {
        "DescribeInstances" => (
            200,
            ec2_ok(
                "DescribeInstances",
                &reservations(&format!("{}{}", instance_xml("i-0aaa", "running", "subnet-a", VPC, "ap-northeast-2a"), instance_xml("i-0bbb", "stopped", "subnet-c", VPC, "ap-northeast-2c"))),
            ),
        ),
        "DescribeSubnets" => (
            200,
            ec2_ok(
                "DescribeSubnets",
                &format!(
                    "<subnetSet>{}{}{}{}</subnetSet>",
                    subnet_xml("subnet-unused", VPC, "ap-northeast-2c", "10.0.9.0/24", 250, None),
                    subnet_xml("subnet-c", VPC, "ap-northeast-2c", "10.0.1.0/24", 30, Some("private-c")),
                    subnet_xml("subnet-pod", VPC, "ap-northeast-2a", "100.64.0.0/22", 1000, None),
                    subnet_xml("subnet-a", VPC, "ap-northeast-2a", "10.0.0.0/24", 100, Some("private-a")),
                ),
            ),
        ),
        "DescribeLoadBalancers" => {
            let mut members: String = names.iter().map(|n| lb_xml(&arn(n), n, &format!("{n}-1.ap-northeast-2.elb.amazonaws.com"), "application", VPC, &[("ap-northeast-2a", "subnet-a")])).collect();
            members.push_str(&lb_xml(&arn("foreign"), "foreign", "foreign-1.elb.amazonaws.com", "application", "vpc-other", &[]));
            (200, elb_ok("DescribeLoadBalancers", &format!("<LoadBalancers>{members}</LoadBalancers>")))
        }
        "DescribeTags" => {
            let members: String = names.iter().filter(|n| sent.params.values().any(|v| *v == arn(n))).map(|n| tags_xml(&arn(n), &tags(n))).collect();
            (200, elb_ok("DescribeTags", &format!("<TagDescriptions>{members}</TagDescriptions>")))
        }
        "DescribeListeners" => {
            let lb = sent.params["LoadBalancerArn"].rsplit('/').nth(1).unwrap().to_string();
            (200, elb_ok("DescribeListeners", &format!("<Listeners>{}</Listeners>", listener_xml("arn:listener/1", "HTTPS", 443, &forward_xml(&tg_arn(&lb))))))
        }
        "DescribeRules" => (200, elb_ok("DescribeRules", "<Rules/>")),
        "DescribeTargetGroups" => {
            let lb = sent.params["LoadBalancerArn"].rsplit('/').nth(1).unwrap().to_string();
            (200, elb_ok("DescribeTargetGroups", &format!("<TargetGroups>{}</TargetGroups>", tg_xml(&tg_arn(&lb), &format!("{lb}-tg"), "HTTP", 80, "instance", "/"))))
        }
        "DescribeTargetHealth" => (200, elb_ok("DescribeTargetHealth", &format!("<TargetHealthDescriptions>{}</TargetHealthDescriptions>", health_xml("i-0aaa", 30080, "healthy", None, None)))),
        other => panic!("unexpected {other}"),
    }
}

fn row<'a>(n: &'a Network, name: &str) -> &'a LbRow {
    n.load_balancers.as_ref().unwrap().iter().find(|r| r.source.name == name).unwrap()
}

#[tokio::test]
async fn aws_and_kubernetes_are_joined_into_one_view() {
    let rec = Recorder::new(aws_routes);
    let aws = Ok(rec.clients());
    let n = collect(&aws, "prod", parts(), Ok(Some(VPC.into()))).await;
    assert!(n.gaps.is_empty(), "{:?}", n.gaps);
    assert_eq!(n.vpc_id.as_deref(), Some(VPC));

    // 인스턴스는 노드의 providerID에서 나온 ID로 한 번에, 서브넷은 클러스터 VPC 전체를 읽는다
    let ids: Vec<String> = rec.sent_of("DescribeInstances")[0].params.iter().filter(|(k, _)| k.starts_with("Filter.1.Value.")).map(|(_, v)| v.clone()).collect();
    assert_eq!(ids, ["i-0aaa", "i-0bbb"]);
    assert_eq!(rec.sent_of("DescribeSubnets")[0].params["Filter.1.Value.1"], VPC);

    // 노드 → 인스턴스 → 서브넷·AZ
    let nodes = n.nodes.as_ref().unwrap();
    let by_name = |name: &str| nodes.iter().find(|x| x.name == name).unwrap();
    assert_eq!((by_name("ip-10-0-0-10").subnet_id.as_deref(), by_name("ip-10-0-0-10").instance_state.as_deref()), (Some("subnet-a"), Some("running")));
    assert_eq!((by_name("ip-10-0-1-10").subnet_id.as_deref(), by_name("ip-10-0-1-10").instance_state.as_deref()), (Some("subnet-c"), Some("stopped")));
    // Fargate 노드는 인스턴스가 없다
    assert_eq!((by_name("fargate-x").instance_id.as_deref(), by_name("fargate-x").subnet_id.as_deref()), (None, None));

    // 서브넷: 노드가 있는 것이 먼저(AZ·CIDR 순), 안 쓰는 것은 뒤. VPC CNI(aws-node)가 없어 Pod 수는 아직 세지 않는다.
    let subnets = n.subnets.as_ref().unwrap();
    assert_eq!(subnets.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["subnet-a", "subnet-c", "subnet-pod", "subnet-unused"]);
    assert_eq!(subnets[0].capacity, Some(251));
    assert_eq!((subnets[0].node_count, subnets[0].available_ips, subnets[0].name.as_deref()), (1, Some(100), Some("private-a")));
}

#[tokio::test]
async fn pod_ips_map_to_subnets_only_with_the_vpc_cni() {
    let rec = Recorder::new(aws_routes);
    let aws = Ok(rec.clients());
    // VPC CNI가 아니면 Pod IP는 서브넷에 속하지 않는다: 이으려 하지 않고 개수도 비운다
    let plain = collect(&aws, "prod", parts(), Ok(Some(VPC.into()))).await;
    let pods = plain.pods.as_ref().unwrap();
    assert!(!pods.vpc_cni);
    assert!(pods.items.iter().all(|p| p.subnet_id.is_none()));
    assert!(plain.subnets.as_ref().unwrap().iter().all(|s| s.pod_count.is_none()));
    assert_eq!(pods.outside, 0);

    // aws-node가 있으면 서브넷별로 센다
    let mut k8s = parts();
    k8s.pods = Ok((
        k8s.pods.unwrap().0.into_iter().chain([pod("kube-system", "aws-node-y", Some("10.0.1.10"), true, json!({ "k8s-app": "aws-node" }))]).collect(),
        false,
    ));
    let cni = collect(&aws, "prod", k8s, Ok(Some(VPC.into()))).await;
    let pods = cni.pods.as_ref().unwrap();
    assert!(pods.vpc_cni);
    let subnet_of = |name: &str| pods.items.iter().find(|p| p.name == name).unwrap().subnet_id.as_deref();
    assert_eq!((subnet_of("web-1"), subnet_of("web-2"), subnet_of("custom"), subnet_of("stray")), (Some("subnet-a"), Some("subnet-c"), Some("subnet-pod"), None));
    // hostNetwork Pod의 IP는 노드 IP라 서브넷 Pod 수에 들어가지 않는다(subnet-a: web-1 하나)
    let counts: Vec<(&str, Option<usize>)> = cni.subnets.as_ref().unwrap().iter().map(|s| (s.id.as_str(), s.pod_count)).collect();
    assert_eq!(counts, [("subnet-a", Some(1)), ("subnet-pod", Some(1)), ("subnet-c", Some(1)), ("subnet-unused", Some(0))]);
    // 어느 서브넷에도 없는 IP는 따로 센다
    assert_eq!(pods.outside, 1);
}

#[tokio::test]
async fn services_and_ingresses_are_matched_and_unmatched_ones_say_why() {
    let rec = Recorder::new(aws_routes);
    let n = collect(&Ok(rec.clients()), "prod", parts(), Ok(Some(VPC.into()))).await;
    let rows = n.load_balancers.as_ref().unwrap();
    // ClusterIP Service는 빠지고 LoadBalancer Service 넷과 Ingress 둘
    assert_eq!(rows.len(), 6);
    assert_eq!((row(&n, "web").matched_by, row(&n, "web").load_balancer.as_ref().unwrap().name.as_str()), (Some(MatchedBy::Hostname), "web"));
    // 주소가 아직 없어도 컨트롤러 태그로 찾는다
    assert_eq!((row(&n, "api").matched_by, row(&n, "api").load_balancer.as_ref().unwrap().name.as_str()), (Some(MatchedBy::Tag), "api"));
    // 같은 그룹의 두 Ingress가 한 로드 밸런서를 가리킨다
    assert_eq!(row(&n, "site").load_balancer.as_ref().unwrap().arn, row(&n, "posts").load_balancer.as_ref().unwrap().arn);
    // 짝 없음: 주소가 아직 없다 / 주소가 있는데 ELBv2에는 없다
    assert_eq!((row(&n, "pending").unmatched, row(&n, "pending").load_balancer.is_none()), (Some(Unmatched::Pending), true));
    assert_eq!(row(&n, "legacy").unmatched, Some(Unmatched::NotFound));
    assert_eq!(row(&n, "web").unmatched, None);

    // 상세는 짝이 있는 로드 밸런서마다 한 번(web, api, public): 같은 그룹이 둘이어도 public은 한 번, orphan·다른 VPC는 읽지 않는다
    assert_eq!(rec.sent_of("DescribeListeners").len(), 3);
    assert_eq!(rec.sent_of("DescribeTargetGroups").len(), 3);
    let web = row(&n, "web").load_balancer.as_ref().unwrap();
    assert_eq!(web.kind, Some(LbKind::Application));
    assert_eq!(web.listeners[0].default_action, "forward: web-tg");
    // 대상 상태는 노드로 이어진다
    assert_eq!(web.target_groups[0].targets[0].link.as_ref().map(|l| l.name.as_str()), Some("ip-10-0-0-10"));
    // 다른 VPC의 로드 밸런서는 후보에도 없다
    assert!(!rec.sent_of("DescribeTags").iter().any(|s| s.params.values().any(|v| *v == arn("foreign"))));
}

#[tokio::test]
async fn load_balancers_tagged_for_the_cluster_but_unclaimed_are_listed_and_highlighted() {
    let rec = Recorder::new(aws_routes);
    let n = collect(&Ok(rec.clients()), "prod", parts(), Ok(Some(VPC.into()))).await;
    assert_eq!(n.unclaimed.iter().map(|u| (u.name.as_str(), u.stack.as_deref())).collect::<Vec<_>>(), [("orphan", Some("gone/svc"))]);
    // 강조: 노드의 인스턴스 ID(Fargate는 없음)와 이 클러스터의 로드 밸런서(짝 있는 것과 없는 것), 중복 없이 정렬
    let mut expected = vec!["i-0aaa".to_string(), "i-0bbb".to_string(), arn("web"), arn("api"), arn("public"), arn("orphan")];
    expected.sort();
    assert_eq!(n.highlight, expected);
}

#[tokio::test]
async fn everything_aws_fails_with_one_reason_and_kubernetes_still_shows() {
    let aws: Result<Clients, AppError> = Err(AppError::other("자격 증명을 읽지 못했어요"));
    let n = collect(&aws, "prod", parts(), Err(AppError::other("자격 증명을 읽지 못했어요"))).await;
    let sections: Vec<Section> = n.gaps.iter().map(|g| g.section).collect();
    assert_eq!(sections, [Section::Cluster, Section::Instances, Section::Subnets, Section::LoadBalancers]);
    assert!(n.gaps.iter().all(|g| g.error == AppError::other("자격 증명을 읽지 못했어요")));
    // 쿠버네티스 쪽은 그대로
    assert_eq!(n.nodes.as_ref().unwrap().len(), 3);
    assert_eq!(n.pods.as_ref().unwrap().items.len(), 5);
    assert_eq!(n.policies.as_ref().unwrap().len(), 1);
    assert_eq!(n.subnets, None);
    assert_eq!(n.vpc_id, None);
    // 짝을 못 찾은 이유: 주소가 있는데 AWS를 못 읽었다 / 주소가 아직 없다
    assert_eq!(row(&n, "web").unmatched, Some(Unmatched::AwsUnavailable));
    assert_eq!(row(&n, "pending").unmatched, Some(Unmatched::Pending));
    // 인스턴스 ID는 providerID에서 오므로 강조할 수 있다
    assert_eq!(n.highlight, ["i-0aaa", "i-0bbb"]);
}

#[tokio::test]
async fn a_failing_instance_lookup_keeps_nodes_without_subnets_and_other_aws_parts() {
    let rec = Recorder::new(|sent| if sent.action == "DescribeInstances" { (403, ec2_error("UnauthorizedOperation", "no")) } else { aws_routes(sent) });
    let n = collect(&Ok(rec.clients()), "prod", parts(), Ok(Some(VPC.into()))).await;
    assert_eq!(n.gaps.iter().map(|g| (g.section, g.error.clone())).collect::<Vec<_>>(), [(Section::Instances, denied("ec2:DescribeInstances"))]);
    let nodes = n.nodes.as_ref().unwrap();
    let a = nodes.iter().find(|x| x.name == "ip-10-0-0-10").unwrap();
    // 서브넷은 모르지만 노드가 알려 준 zone은 남는다
    assert_eq!((a.subnet_id.as_deref(), a.instance_state.as_deref(), a.zone.as_deref()), (None, None, Some("ap-northeast-2a")));
    // 서브넷 표와 로드 밸런서는 그대로(VPC는 EKS가 알려 줬다)
    assert_eq!(n.subnets.as_ref().unwrap().len(), 4);
    assert!(row(&n, "web").load_balancer.is_some());
}

#[tokio::test]
async fn the_vpc_falls_back_to_the_instances_when_eks_is_unreadable() {
    let rec = Recorder::new(aws_routes);
    let n = collect(&Ok(rec.clients()), "prod", parts(), Err(denied("eks:DescribeCluster"))).await;
    assert_eq!(n.vpc_id.as_deref(), Some(VPC));
    // 클러스터 VPC로 서브넷을 읽는다
    assert_eq!(rec.sent_of("DescribeSubnets")[0].params["Filter.1.Name"], "vpc-id");
    assert_eq!(n.gaps.iter().map(|g| g.section).collect::<Vec<_>>(), [Section::Cluster]);
}

#[tokio::test]
async fn failing_load_balancer_listing_marks_addressed_rows_unavailable_but_keeps_subnets() {
    let rec = Recorder::new(|sent| if sent.action == "DescribeLoadBalancers" { (403, elb_error("AccessDenied", "no")) } else { aws_routes(sent) });
    let n = collect(&Ok(rec.clients()), "prod", parts(), Ok(Some(VPC.into()))).await;
    assert_eq!(n.gaps.iter().map(|g| g.section).collect::<Vec<_>>(), [Section::LoadBalancers]);
    assert_eq!(row(&n, "legacy").unmatched, Some(Unmatched::AwsUnavailable));
    assert!(n.unclaimed.is_empty());
    assert_eq!(n.subnets.as_ref().unwrap().len(), 4);
}

#[tokio::test]
async fn unreadable_tags_are_reported_but_hostname_matches_still_work() {
    let rec = Recorder::new(|sent| if sent.action == "DescribeTags" { (403, elb_error("AccessDenied", "no")) } else { aws_routes(sent) });
    let n = collect(&Ok(rec.clients()), "prod", parts(), Ok(Some(VPC.into()))).await;
    assert_eq!(n.gaps.iter().map(|g| (g.section, g.subject.as_deref())).collect::<Vec<_>>(), [(Section::LoadBalancers, Some("tags"))]);
    assert_eq!(row(&n, "web").matched_by, Some(MatchedBy::Hostname));
    // 태그가 없으면 호스트명 없는 api는 짝이 없다
    assert_eq!(row(&n, "api").unmatched, Some(Unmatched::Pending));
}

#[tokio::test]
async fn each_kubernetes_list_fails_independently() {
    let rec = Recorder::new(aws_routes);
    let mut k8s = parts();
    k8s.services = Err(denied("list services"));
    k8s.policies = Err(denied("list networkpolicies"));
    let n = collect(&Ok(rec.clients()), "prod", k8s, Ok(Some(VPC.into()))).await;
    assert_eq!(n.gaps.iter().map(|g| g.section).collect::<Vec<_>>(), [Section::Services, Section::Policies]);
    // Ingress는 그대로, Service 행은 없다
    assert_eq!(n.load_balancers.as_ref().unwrap().len(), 2);
    assert_eq!(n.policies, None);
    // 정책을 못 읽으면 "정책 없는 네임스페이스"를 단정할 수 없다
    assert_eq!(n.namespaces, None);

    let mut k8s = parts();
    k8s.services = Err(denied("list services"));
    k8s.ingresses = Err(denied("list ingresses"));
    assert_eq!(collect(&Ok(Recorder::new(aws_routes).clients()), "prod", k8s, Ok(Some(VPC.into()))).await.load_balancers, None);
}

#[tokio::test]
async fn namespaces_without_a_policy_are_reported() {
    let rec = Recorder::new(aws_routes);
    let n = collect(&Ok(rec.clients()), "prod", parts(), Ok(Some(VPC.into()))).await;
    let ns: Vec<(&str, usize, bool)> = n.namespaces.as_ref().unwrap().iter().map(|x| (x.name.as_str(), x.policies, x.system)).collect();
    assert_eq!(ns, [("blog", 0, false), ("kube-system", 0, true), ("shop", 1, false)]);
}

#[tokio::test]
async fn a_cluster_without_instances_asks_ec2_nothing_about_them() {
    let rec = Recorder::new(aws_routes);
    let mut k8s = parts();
    k8s.nodes = Ok(vec![node("fargate-x", "aws:///ap-northeast-2a/fargate-x", "10.0.0.99", json!({ "eks.amazonaws.com/compute-type": "fargate" }))]);
    let n = collect(&Ok(rec.clients()), "prod", k8s, Ok(Some(VPC.into()))).await;
    assert!(rec.sent_of("DescribeInstances").is_empty());
    assert!(n.gaps.is_empty());
}
