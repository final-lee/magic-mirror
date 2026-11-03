use super::*;
use crate::k8s::network::mock_aws::*;
use crate::k8s::network::model::{LbKind, ObjectLink};

const VPC: &str = "vpc-1";
const LB_ARN: &str = "arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:loadbalancer/app/web/1";
const TG_ARN: &str = "arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:targetgroup/web-tg/9";
const TG2_ARN: &str = "arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:targetgroup/api-tg/8";

fn denied(action: &str) -> AppError {
    AppError::AccessDenied { action: action.into() }
}

fn aws_lb(kind: Option<LbKind>) -> AwsLb {
    AwsLb {
        arn: LB_ARN.into(),
        name: "web".into(),
        dns_name: "web-1.ap-northeast-2.elb.amazonaws.com".into(),
        kind,
        scheme: Some("internet-facing".into()),
        state: Some("active".into()),
        vpc_id: Some(VPC.into()),
        zones: vec![],
        security_groups: vec![],
        tags: Default::default(),
    }
}

#[tokio::test]
async fn the_cluster_vpc_comes_from_describe_cluster() {
    let rec = Recorder::new(|_| (200, eks_cluster(VPC)));
    let eks = rec.clients().eks;
    assert_eq!(cluster_vpc(&eks, "prod").await, Ok(Some(VPC.to_string())));
    assert_eq!(rec.sent().iter().map(|s| s.action.as_str()).collect::<Vec<_>>(), ["REST /clusters/prod"]);
}

#[tokio::test]
async fn a_denied_describe_cluster_is_an_access_denied_error_not_a_panic() {
    let rec = Recorder::new(|_| (403, eks_error("AccessDeniedException", "no")));
    let eks = rec.clients().eks;
    assert_eq!(cluster_vpc(&eks, "prod").await, Err(denied("eks:DescribeCluster")));
}

#[tokio::test]
async fn instances_are_looked_up_by_filter_in_chunks_so_a_missing_one_does_not_fail_the_rest() {
    let ids: Vec<String> = (0..250).map(|i| format!("i-{i:04x}")).collect();
    let rec = Recorder::new(|sent| {
        let first = sent.params.get("Filter.1.Value.1").cloned().unwrap_or_default();
        // 각 쪽의 첫 ID만 있는 것처럼 답한다(나머지는 이미 사라진 인스턴스)
        (200, ec2_ok("DescribeInstances", &reservations(&instance_xml(&first, "running", "subnet-a", VPC, "ap-northeast-2a"))))
    });
    let out = instances(&rec.clients().ec2, &ids).await.unwrap();
    let sent = rec.sent_of("DescribeInstances");
    assert_eq!(sent.len(), 3);
    assert_eq!(sent[0].params["Filter.1.Name"], "instance-id");
    // 인스턴스 ID 목록(InstanceIds)이 아니라 필터로 보낸다
    assert!(sent.iter().all(|s| !s.params.keys().any(|k| k.starts_with("InstanceId."))));
    assert_eq!(sent[0].params.keys().filter(|k| k.starts_with("Filter.1.Value.")).count(), 100);
    assert_eq!(sent[2].params.keys().filter(|k| k.starts_with("Filter.1.Value.")).count(), 50);
    assert_eq!(out.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["i-0000", "i-0064", "i-00c8"]);
    assert_eq!(out[0], Instance { id: "i-0000".into(), state: Some("running".into()), subnet_id: Some("subnet-a".into()), vpc_id: Some(VPC.into()), zone: Some("ap-northeast-2a".into()) });
}

#[tokio::test]
async fn no_node_ids_means_no_request() {
    let rec = Recorder::new(|_| (500, String::new()));
    assert_eq!(instances(&rec.clients().ec2, &[]).await, Ok(vec![]));
    assert!(rec.sent().is_empty());
}

#[tokio::test]
async fn subnets_of_the_vpc_are_read_with_cidr_free_ips_and_name() {
    let rec = Recorder::new(|_| {
        let items = format!(
            "<subnetSet>{}{}</subnetSet>",
            subnet_xml("subnet-b", VPC, "ap-northeast-2c", "10.0.1.0/24", 200, None),
            subnet_xml("subnet-a", VPC, "ap-northeast-2a", "10.0.0.0/24", 13, Some("private-a")),
        );
        (200, ec2_ok("DescribeSubnets", &items))
    });
    let out = subnets(&rec.clients().ec2, Some(VPC), &["subnet-zzz".to_string()]).await.unwrap();
    let sent = rec.sent_of("DescribeSubnets");
    // VPC를 알면 VPC 전체를 읽는다(노드와 다른 서브넷을 쓰는 Pod를 잇기 위해)
    assert_eq!((sent[0].params["Filter.1.Name"].as_str(), sent[0].params["Filter.1.Value.1"].as_str()), ("vpc-id", VPC));
    assert_eq!(out[1], Subnet { id: "subnet-a".into(), name: Some("private-a".into()), zone: Some("ap-northeast-2a".into()), cidrs: vec!["10.0.0.0/24".into()], available_ips: Some(13) });
    assert_eq!(out[0].name, None);
}

#[tokio::test]
async fn without_a_vpc_only_the_given_subnets_are_read_and_with_none_nothing_is() {
    let rec = Recorder::new(|_| (200, ec2_ok("DescribeSubnets", "<subnetSet/>")));
    subnets(&rec.clients().ec2, None, &["subnet-a".to_string(), "subnet-b".to_string()]).await.unwrap();
    let sent = rec.sent_of("DescribeSubnets");
    assert_eq!((sent[0].params["Filter.1.Name"].as_str(), sent[0].params["Filter.1.Value.2"].as_str()), ("subnet-id", "subnet-b"));
    let rec = Recorder::new(|_| (500, String::new()));
    assert_eq!(subnets(&rec.clients().ec2, None, &[]).await, Ok(vec![]));
    assert!(rec.sent().is_empty());
}

#[tokio::test]
async fn a_denied_describe_subnets_is_an_access_denied_error() {
    let rec = Recorder::new(|_| (403, ec2_error("UnauthorizedOperation", "no")));
    assert_eq!(subnets(&rec.clients().ec2, Some(VPC), &[]).await, Err(denied("ec2:DescribeSubnets")));
}

fn lb_arn(i: usize) -> String {
    format!("arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:loadbalancer/app/lb-{i:02}/{i}")
}

#[tokio::test]
async fn load_balancers_of_other_vpcs_are_dropped_and_tags_are_read_in_chunks_of_twenty() {
    let rec = Recorder::new(|sent| match sent.action.as_str() {
        "DescribeLoadBalancers" => {
            let members: String = (0..45).map(|i| lb_xml(&lb_arn(i), &format!("lb-{i:02}"), &format!("lb-{i:02}.elb.amazonaws.com"), "application", if i == 44 { "vpc-other" } else { VPC }, &[])).collect();
            (200, elb_ok("DescribeLoadBalancers", &format!("<LoadBalancers>{members}</LoadBalancers>")))
        }
        "DescribeTags" => {
            let members: String = sent
                .params
                .iter()
                .filter(|(k, _)| k.starts_with("ResourceArns.member."))
                .map(|(_, arn)| tags_xml(arn, &[("elbv2.k8s.aws/cluster", "prod"), ("service.k8s.aws/stack", "shop/web")]))
                .collect();
            (200, elb_ok("DescribeTags", &format!("<TagDescriptions>{members}</TagDescriptions>")))
        }
        other => panic!("unexpected {other}"),
    });
    let list = load_balancers(&rec.clients().elb, Some(VPC)).await.unwrap();
    assert_eq!(list.lbs.len(), 44);
    assert!(list.tags_error.is_none());
    // 44개를 20개씩: 20 + 20 + 4
    let tag_calls: Vec<usize> = rec.sent_of("DescribeTags").iter().map(|s| s.params.keys().filter(|k| k.starts_with("ResourceArns.member.")).count()).collect();
    assert_eq!(tag_calls, [20, 20, 4]);
    assert_eq!(list.lbs[3].tags["service.k8s.aws/stack"], "shop/web");
    assert_eq!(list.lbs[0].kind, Some(LbKind::Application));
}

#[tokio::test]
async fn without_a_known_vpc_every_load_balancer_is_kept() {
    let rec = Recorder::new(|sent| match sent.action.as_str() {
        "DescribeLoadBalancers" => (200, elb_ok("DescribeLoadBalancers", &format!("<LoadBalancers>{}</LoadBalancers>", lb_xml(&lb_arn(1), "a", "a.elb.amazonaws.com", "network", "vpc-other", &[("ap-northeast-2a", "subnet-a")])))),
        _ => (200, elb_ok("DescribeTags", "<TagDescriptions/>")),
    });
    let list = load_balancers(&rec.clients().elb, None).await.unwrap();
    assert_eq!(list.lbs.len(), 1);
    assert_eq!(list.lbs[0].kind, Some(LbKind::Network));
    assert_eq!(list.lbs[0].zones[0].subnet_id.as_deref(), Some("subnet-a"));
}

#[tokio::test]
async fn paging_follows_the_marker() {
    let rec = Recorder::new(|sent| match sent.action.as_str() {
        "DescribeLoadBalancers" if !sent.params.contains_key("Marker") => {
            (200, elb_ok("DescribeLoadBalancers", &format!("<LoadBalancers>{}</LoadBalancers><NextMarker>m1</NextMarker>", lb_xml(&lb_arn(1), "a", "a.elb.amazonaws.com", "application", VPC, &[]))))
        }
        "DescribeLoadBalancers" => (200, elb_ok("DescribeLoadBalancers", &format!("<LoadBalancers>{}</LoadBalancers>", lb_xml(&lb_arn(2), "b", "b.elb.amazonaws.com", "application", VPC, &[])))),
        _ => (200, elb_ok("DescribeTags", "<TagDescriptions/>")),
    });
    let list = load_balancers(&rec.clients().elb, Some(VPC)).await.unwrap();
    assert_eq!(list.lbs.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    assert_eq!(rec.sent_of("DescribeLoadBalancers")[1].params["Marker"], "m1");
}

#[tokio::test]
async fn failing_tags_keep_the_load_balancers_and_report_the_reason() {
    let rec = Recorder::new(|sent| match sent.action.as_str() {
        "DescribeLoadBalancers" => (200, elb_ok("DescribeLoadBalancers", &format!("<LoadBalancers>{}</LoadBalancers>", lb_xml(&lb_arn(1), "a", "a.elb.amazonaws.com", "application", VPC, &[])))),
        _ => (403, elb_error("AccessDenied", "no tags")),
    });
    let list = load_balancers(&rec.clients().elb, Some(VPC)).await.unwrap();
    assert_eq!(list.lbs.len(), 1);
    assert!(list.lbs[0].tags.is_empty());
    assert_eq!(list.tags_error, Some(denied("elasticloadbalancing:DescribeTags")));
}

#[tokio::test]
async fn a_denied_describe_load_balancers_is_an_error() {
    let rec = Recorder::new(|_| (403, elb_error("AccessDenied", "no")));
    assert!(matches!(load_balancers(&rec.clients().elb, Some(VPC)).await, Err(AppError::AccessDenied { .. })));
}

fn node(name: &str, instance: &str, ip: &str) -> NodeNet {
    NodeNet {
        name: name.into(), ready: true, provider_id: None, instance_id: Some(instance.into()), fargate: false, instance_type: None,
        internal_ip: Some(ip.into()), zone: None, instance_state: None, subnet_id: None,
    }
}

fn pod(ns: &str, name: &str, ip: &str) -> PodNet {
    PodNet { namespace: ns.into(), name: name.into(), ip: ip.into(), node: None, host_network: false, subnet_id: None }
}

/// 리스너 둘(HTTPS 443은 규칙 둘, HTTP 80은 리다이렉트), 대상 그룹 둘을 가진 ALB
fn alb_routes(sent: &Sent) -> (u16, String) {
    match sent.action.as_str() {
        "DescribeTargetGroups" => (
            200,
            elb_ok(
                "DescribeTargetGroups",
                &format!("<TargetGroups>{}{}</TargetGroups>", tg_xml(TG_ARN, "web-tg", "HTTP", 8080, "ip", "/healthz"), tg_xml(TG2_ARN, "api-tg", "HTTP", 9090, "instance", "/")),
            ),
        ),
        "DescribeTargetHealth" => {
            let members = if sent.params["TargetGroupArn"] == TG_ARN {
                format!(
                    "{}{}{}",
                    health_xml("10.0.1.77", 8080, "healthy", None, None),
                    health_xml("10.0.1.78", 8080, "unhealthy", Some("Target.FailedHealthChecks"), Some("Health checks failed")),
                    health_xml("10.0.9.9", 8080, "draining", Some("Target.DeregistrationInProgress"), None),
                )
            } else {
                health_xml("i-0abc", 30080, "healthy", None, None)
            };
            (200, elb_ok("DescribeTargetHealth", &format!("<TargetHealthDescriptions>{members}</TargetHealthDescriptions>")))
        }
        "DescribeListeners" => {
            let https = listener_xml("arn:listener/https", "HTTPS", 443, &forward_xml(TG_ARN));
            let http = listener_xml("arn:listener/http", "HTTP", 80, "<member><Type>redirect</Type><RedirectConfig><Protocol>HTTPS</Protocol><Port>443</Port><StatusCode>HTTP_301</StatusCode></RedirectConfig></member>");
            (200, elb_ok("DescribeListeners", &format!("<Listeners>{http}{https}</Listeners>")))
        }
        "DescribeRules" => {
            let rules = if sent.params["ListenerArn"] == "arn:listener/https" {
                format!(
                    "{}{}{}",
                    rule_xml("default", true, "", &forward_xml(TG_ARN)),
                    rule_xml("20", false, "<member><Field>path-pattern</Field><PathPatternConfig><Values><member>/api/*</member></Values></PathPatternConfig></member>", &forward_xml(TG2_ARN)),
                    rule_xml(
                        "10",
                        false,
                        "<member><Field>host-header</Field><HostHeaderConfig><Values><member>shop.example.com</member><member>www.example.com</member></Values></HostHeaderConfig></member>\
                         <member><Field>http-header</Field><HttpHeaderConfig><HttpHeaderName>X-Env</HttpHeaderName><Values><member>prod</member></Values></HttpHeaderConfig></member>",
                        "<member><Type>fixed-response</Type><FixedResponseConfig><StatusCode>503</StatusCode></FixedResponseConfig></member>",
                    ),
                )
            } else {
                rule_xml("default", true, "", "")
            };
            (200, elb_ok("DescribeRules", &format!("<Rules>{rules}</Rules>")))
        }
        other => panic!("unexpected {other}"),
    }
}

#[tokio::test]
async fn an_application_load_balancer_gets_listeners_rules_target_groups_and_target_health() {
    let rec = Recorder::new(alb_routes);
    let nodes = [node("ip-10-0-2-4", "i-0abc", "10.0.2.4")];
    let pods = [pod("shop", "web-1", "10.0.1.77")];
    let view = details(&rec.clients().elb, &aws_lb(Some(LbKind::Application)), &nodes, &pods).await;
    assert!(view.gaps.is_empty(), "{:?}", view.gaps);

    // 리스너는 포트 순이고 기본 동작은 대상 그룹 이름으로 푼다
    let listeners: Vec<(&str, i32, &str)> = view.listeners.iter().map(|l| (l.protocol.as_str(), l.port, l.default_action.as_str())).collect();
    assert_eq!(listeners, [("HTTP", 80, "redirect: HTTPS:443 (HTTP_301)"), ("HTTPS", 443, "forward: web-tg")]);
    // 기본 규칙은 빠지고 우선순위 숫자 순(10이 20보다 앞)이다. 조건은 `&`로 잇고 값은 쉼표로 잇는다.
    let rules = &view.listeners[1].rules;
    assert_eq!(rules.iter().map(|r| r.priority.as_str()).collect::<Vec<_>>(), ["10", "20"]);
    assert_eq!(rules[0].conditions, "host-header: shop.example.com, www.example.com & http-header X-Env: prod");
    assert_eq!(rules[0].action, "fixed-response: 503");
    assert_eq!((rules[1].conditions.as_str(), rules[1].action.as_str()), ("path-pattern: /api/*", "forward: api-tg"));
    assert!(view.listeners[0].rules.is_empty());

    // 대상 그룹은 이름 순, 대상은 문제 있는 것이 먼저
    let groups: Vec<&str> = view.target_groups.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(groups, ["api-tg", "web-tg"]);
    let web = &view.target_groups[1];
    assert_eq!(web.target_type.as_deref(), Some("ip"));
    assert_eq!(web.health_check, Some(HealthCheck { protocol: Some("HTTP".into()), port: Some("traffic-port".into()), path: Some("/healthz".into()) }));
    let states: Vec<(&str, &str)> = web.targets.iter().map(|t| (t.id.as_str(), t.state.as_str())).collect();
    assert_eq!(states, [("10.0.1.78", "unhealthy"), ("10.0.9.9", "draining"), ("10.0.1.77", "healthy")]);
    assert_eq!(web.targets[0].reason.as_deref(), Some("Target.FailedHealthChecks"));
    assert_eq!(web.targets[0].description.as_deref(), Some("Health checks failed"));
    // IP는 Pod로, 인스턴스 ID는 노드로 이어진다. 아는 객체가 없으면 링크가 없다.
    assert_eq!(web.targets[2].link, Some(ObjectLink { kind: "Pod".into(), namespace: Some("shop".into()), name: "web-1".into() }));
    assert_eq!(web.targets[0].link, None);
    assert_eq!(view.target_groups[0].targets[0].link, Some(ObjectLink { kind: "Node".into(), namespace: None, name: "ip-10-0-2-4".into() }));
}

#[tokio::test]
async fn a_network_load_balancer_does_not_ask_for_rules() {
    let rec = Recorder::new(alb_routes);
    let view = details(&rec.clients().elb, &aws_lb(Some(LbKind::Network)), &[], &[]).await;
    assert!(rec.sent_of("DescribeRules").is_empty());
    assert!(view.listeners.iter().all(|l| l.rules.is_empty()));
}

#[tokio::test]
async fn an_unreadable_target_group_health_is_a_gap_and_the_rest_still_shows() {
    let rec = Recorder::new(|sent| {
        if sent.action == "DescribeTargetHealth" && sent.params["TargetGroupArn"] == TG2_ARN {
            return (403, elb_error("AccessDenied", "no health"));
        }
        alb_routes(sent)
    });
    let view = details(&rec.clients().elb, &aws_lb(Some(LbKind::Application)), &[], &[]).await;
    assert_eq!(view.gaps.len(), 1);
    assert_eq!(view.gaps[0].section, Section::TargetHealth);
    assert_eq!(view.gaps[0].subject.as_deref(), Some("web / api-tg"));
    assert_eq!(view.gaps[0].error, denied("elasticloadbalancing:DescribeTargetHealth"));
    // 대상 그룹 자체와 다른 그룹의 상태는 그대로다
    let api = view.target_groups.iter().find(|g| g.name == "api-tg").unwrap();
    assert!(api.targets.is_empty());
    assert_eq!(view.target_groups.iter().find(|g| g.name == "web-tg").unwrap().targets.len(), 3);
    assert_eq!(view.listeners.len(), 2);
}

#[tokio::test]
async fn unreadable_listeners_and_rules_are_gaps_with_the_reason() {
    let rec = Recorder::new(|sent| {
        if sent.action == "DescribeRules" {
            return (403, elb_error("AccessDenied", "no rules"));
        }
        alb_routes(sent)
    });
    let view = details(&rec.clients().elb, &aws_lb(Some(LbKind::Application)), &[], &[]).await;
    // 규칙을 읽지 못한 리스너 둘은 규칙 없이 남고, 이유가 리스너마다 남는다
    assert_eq!(view.listeners.len(), 2);
    let subjects: Vec<&str> = view.gaps.iter().filter_map(|g| g.subject.as_deref()).collect();
    assert_eq!(subjects, ["web HTTP:80", "web HTTPS:443"]);
    assert!(view.gaps.iter().all(|g| g.section == Section::Listeners));

    let rec = Recorder::new(|sent| if sent.action == "DescribeListeners" { (403, elb_error("AccessDenied", "no listeners")) } else { alb_routes(sent) });
    let view = details(&rec.clients().elb, &aws_lb(Some(LbKind::Application)), &[], &[]).await;
    assert!(view.listeners.is_empty());
    assert_eq!(view.gaps.iter().map(|g| (g.section, g.subject.as_deref())).collect::<Vec<_>>(), [(Section::Listeners, Some("web"))]);
    assert_eq!(view.target_groups.len(), 2);
}

#[tokio::test]
async fn unreadable_target_groups_leave_no_health_calls() {
    let rec = Recorder::new(|sent| if sent.action == "DescribeTargetGroups" { (403, elb_error("AccessDenied", "no tgs")) } else { alb_routes(sent) });
    let view = details(&rec.clients().elb, &aws_lb(Some(LbKind::Application)), &[], &[]).await;
    assert!(view.target_groups.is_empty());
    assert!(rec.sent_of("DescribeTargetHealth").is_empty());
    assert_eq!(view.gaps[0].section, Section::TargetGroups);
    // 대상 그룹 이름을 모르니 기본 동작은 ARN의 이름 토막으로 보인다
    assert_eq!(view.listeners[1].default_action, "forward: web-tg");
}

#[tokio::test]
async fn a_weighted_forward_lists_every_group_with_its_weight() {
    let rec = Recorder::new(|sent| {
        if sent.action == "DescribeListeners" {
            let action = format!(
                "<member><Type>forward</Type><ForwardConfig><TargetGroups><member><TargetGroupArn>{TG_ARN}</TargetGroupArn><Weight>70</Weight></member>\
                 <member><TargetGroupArn>{TG2_ARN}</TargetGroupArn><Weight>30</Weight></member></TargetGroups></ForwardConfig></member>"
            );
            return (200, elb_ok("DescribeListeners", &format!("<Listeners>{}</Listeners>", listener_xml("arn:listener/https", "HTTPS", 443, &action))));
        }
        alb_routes(sent)
    });
    let view = details(&rec.clients().elb, &aws_lb(Some(LbKind::Network)), &[], &[]).await;
    assert_eq!(view.listeners[0].default_action, "forward: web-tg (70), api-tg (30)");
}

#[test]
fn a_target_group_name_is_the_second_to_last_arn_segment() {
    assert_eq!(name_in_arn(TG_ARN), "web-tg");
    assert_eq!(name_in_arn("weird"), "weird");
}
