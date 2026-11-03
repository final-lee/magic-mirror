//! 네트워크 화면의 AWS 쪽: EKS(VPC), EC2(인스턴스·서브넷), ELBv2(로드 밸런서·리스너·대상 그룹·대상 상태). Describe만 한다.
//! 모든 호출은 `REQUEST_TIMEOUT` 안에 끝나야 하고, 목록은 `PAGES_MAX` 쪽까지만 넘긴다. 실패는 호출한 쪽이 gap으로 담는다.
use std::collections::{BTreeMap, HashMap};
use std::fmt::Debug;
use std::future::Future;

use aws_sdk_ec2::types::Filter;
use aws_sdk_elasticloadbalancingv2::types::{Action, Rule, RuleCondition};
use aws_smithy_runtime_api::client::result::SdkError;
use aws_smithy_types::error::metadata::ProvideErrorMetadata;
use futures::future::join_all;

use super::lb::kind_of;
use super::model::{AwsLb, Gap, HealthCheck, ListenerView, LoadBalancerView, LbZone, NodeNet, PodNet, RuleView, Section, TargetGroupView, TargetView};
use crate::error::{from_sdk, AppError};
use crate::k8s::connect::REQUEST_TIMEOUT;
use super::lb::target_link as link_of;

pub use crate::k8s::read::eks::PAGES_MAX;

/// DescribeTags가 한 번에 받는 ARN 수 한도
const TAGS_CHUNK: usize = 20;
/// DescribeInstances의 필터 값 한 번에 보낼 수
const INSTANCE_CHUNK: usize = 100;

pub struct Clients {
    pub eks: aws_sdk_eks::Client,
    pub ec2: aws_sdk_ec2::Client,
    pub elb: aws_sdk_elasticloadbalancingv2::Client,
}

impl Clients {
    pub fn new(cfg: &aws_config::SdkConfig) -> Clients {
        Clients { eks: aws_sdk_eks::Client::new(cfg), ec2: aws_sdk_ec2::Client::new(cfg), elb: aws_sdk_elasticloadbalancingv2::Client::new(cfg) }
    }
}

fn timeout(action: &str) -> AppError {
    AppError::Network { message: format!("AWS API가 30초 안에 답하지 않았어요({action})") }
}

async fn call<T, E, R>(fut: impl Future<Output = Result<T, SdkError<E, R>>>, action: &str) -> Result<T, AppError>
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
    R: Debug + Send + Sync + 'static,
{
    match tokio::time::timeout(REQUEST_TIMEOUT, fut).await {
        Err(_) => Err(timeout(action)),
        Ok(r) => r.map_err(|e| from_sdk(e, action)),
    }
}

/// 쪽 넘기기 한 걸음: 다음 쪽(없으면 None)
async fn next_page<T, E, R>(fut: impl Future<Output = Option<Result<T, SdkError<E, R>>>>, action: &str) -> Result<Option<T>, AppError>
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
    R: Debug + Send + Sync + 'static,
{
    match tokio::time::timeout(REQUEST_TIMEOUT, fut).await {
        Err(_) => Err(timeout(action)),
        Ok(None) => Ok(None),
        Ok(Some(Err(e))) => Err(from_sdk(e, action)),
        Ok(Some(Ok(page))) => Ok(Some(page)),
    }
}

/// EKS가 알려 주는 클러스터의 VPC ID
pub async fn cluster_vpc(eks: &aws_sdk_eks::Client, cluster: &str) -> Result<Option<String>, AppError> {
    let out = call(eks.describe_cluster().name(cluster).send(), "eks:DescribeCluster").await?;
    Ok(out.cluster().and_then(|c| c.resources_vpc_config()).and_then(|v| v.vpc_id()).map(str::to_string))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Instance {
    pub id: String,
    pub state: Option<String>,
    pub subnet_id: Option<String>,
    pub vpc_id: Option<String>,
    pub zone: Option<String>,
}

fn filter(name: &str, values: &[String]) -> Filter {
    Filter::builder().name(name).set_values(Some(values.to_vec())).build()
}

/// 인스턴스 ID로 읽는다. ID 목록(`InstanceIds`) 대신 필터를 써서, 이미 사라진 ID가 있어도 전체가 실패하지 않게 한다.
pub async fn instances(ec2: &aws_sdk_ec2::Client, ids: &[String]) -> Result<Vec<Instance>, AppError> {
    let mut out = Vec::new();
    for chunk in ids.chunks(INSTANCE_CHUNK) {
        let mut pages = ec2.describe_instances().filters(filter("instance-id", chunk)).into_paginator().send();
        for _ in 0..PAGES_MAX {
            let Some(page) = next_page(pages.next(), "ec2:DescribeInstances").await? else { break };
            for reservation in page.reservations() {
                for i in reservation.instances() {
                    out.push(Instance {
                        id: i.instance_id().unwrap_or("").to_string(),
                        state: i.state().and_then(|s| s.name()).map(|n| n.as_str().to_string()),
                        subnet_id: i.subnet_id().map(str::to_string),
                        vpc_id: i.vpc_id().map(str::to_string),
                        zone: i.placement().and_then(|p| p.availability_zone()).map(str::to_string),
                    });
                }
            }
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Subnet {
    pub id: String,
    pub name: Option<String>,
    pub zone: Option<String>,
    /// IPv4 CIDR 하나와 IPv6 CIDR들
    pub cidrs: Vec<String>,
    pub available_ips: Option<i32>,
}

/// VPC의 모든 서브넷(Pod가 노드와 다른 서브넷을 쓰는 사용자 지정 네트워킹도 이어 볼 수 있게). VPC를 모르면 주어진 서브넷 ID만.
pub async fn subnets(ec2: &aws_sdk_ec2::Client, vpc_id: Option<&str>, subnet_ids: &[String]) -> Result<Vec<Subnet>, AppError> {
    let filters = match vpc_id {
        Some(vpc) => vec![filter("vpc-id", &[vpc.to_string()])],
        None if subnet_ids.is_empty() => return Ok(vec![]),
        None => vec![filter("subnet-id", subnet_ids)],
    };
    let mut pages = ec2.describe_subnets().set_filters(Some(filters)).into_paginator().send();
    let mut out = Vec::new();
    for _ in 0..PAGES_MAX {
        let Some(page) = next_page(pages.next(), "ec2:DescribeSubnets").await? else { break };
        for s in page.subnets() {
            let mut cidrs: Vec<String> = s.cidr_block().into_iter().map(str::to_string).collect();
            cidrs.extend(s.ipv6_cidr_block_association_set().iter().filter_map(|a| a.ipv6_cidr_block()).map(str::to_string));
            out.push(Subnet {
                id: s.subnet_id().unwrap_or("").to_string(),
                name: s.tags().iter().find(|t| t.key() == Some("Name")).and_then(|t| t.value()).map(str::to_string),
                zone: s.availability_zone().map(str::to_string),
                cidrs,
                available_ips: s.available_ip_address_count(),
            });
        }
    }
    Ok(out)
}

/// 읽은 로드 밸런서들. 태그를 읽지 못하면 `tags_error`에 이유를 두고 태그 없이 돌려준다(호스트명 짝은 그대로 된다).
pub struct LbList {
    pub lbs: Vec<AwsLb>,
    pub tags_error: Option<AppError>,
}

pub async fn load_balancers(elb: &aws_sdk_elasticloadbalancingv2::Client, vpc_id: Option<&str>) -> Result<LbList, AppError> {
    let mut lbs: Vec<AwsLb> = Vec::new();
    let mut pages = elb.describe_load_balancers().into_paginator().send();
    for _ in 0..PAGES_MAX {
        let Some(page) = next_page(pages.next(), "elasticloadbalancing:DescribeLoadBalancers").await? else { break };
        for lb in page.load_balancers() {
            // 클러스터의 VPC를 알면 그 밖의 로드 밸런서는 이 클러스터의 것일 수 없다
            if vpc_id.is_some() && lb.vpc_id() != vpc_id {
                continue;
            }
            lbs.push(AwsLb {
                arn: lb.load_balancer_arn().unwrap_or("").to_string(),
                name: lb.load_balancer_name().unwrap_or("").to_string(),
                dns_name: lb.dns_name().unwrap_or("").to_string(),
                kind: lb.r#type().and_then(|t| kind_of(t.as_str())),
                scheme: lb.scheme().map(|s| s.as_str().to_string()),
                state: lb.state().and_then(|s| s.code()).map(|c| c.as_str().to_string()),
                vpc_id: lb.vpc_id().map(str::to_string),
                zones: lb.availability_zones().iter().map(|z| LbZone { zone: z.zone_name().unwrap_or("").to_string(), subnet_id: z.subnet_id().map(str::to_string) }).collect(),
                security_groups: lb.security_groups().to_vec(),
                tags: BTreeMap::new(),
            });
        }
    }
    lbs.sort_by(|a, b| a.name.cmp(&b.name));
    let arns: Vec<String> = lbs.iter().map(|l| l.arn.clone()).collect();
    let results = join_all(arns.chunks(TAGS_CHUNK).map(|chunk| async move {
        call(elb.describe_tags().set_resource_arns(Some(chunk.to_vec())).send(), "elasticloadbalancing:DescribeTags").await
    }))
    .await;
    let mut tags_error = None;
    let mut by_arn: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    for r in results {
        match r {
            Ok(out) => {
                for d in out.tag_descriptions() {
                    let tags = d.tags().iter().filter_map(|t| Some((t.key()?.to_string(), t.value().unwrap_or("").to_string()))).collect();
                    by_arn.insert(d.resource_arn().unwrap_or("").to_string(), tags);
                }
            }
            Err(e) => tags_error = Some(e),
        }
    }
    for lb in &mut lbs {
        lb.tags = by_arn.remove(&lb.arn).unwrap_or_default();
    }
    Ok(LbList { lbs, tags_error })
}

/// 대상 그룹 ARN의 마지막 둘째 토막이 이름이다(`…:targetgroup/<name>/<id>`)
fn name_in_arn(arn: &str) -> &str {
    let mut parts = arn.rsplit('/');
    let _id = parts.next();
    parts.next().unwrap_or(arn)
}

/// 동작 한 줄: `forward: a (70), b (30)`, `redirect: HTTPS:443 (HTTP_301)`, `fixed-response: 404`
pub fn action_text(action: &Action, target_groups: &HashMap<String, String>) -> String {
    let kind = action.r#type().map(|t| t.as_str()).unwrap_or("");
    let name = |arn: &str| target_groups.get(arn).cloned().unwrap_or_else(|| name_in_arn(arn).to_string());
    match kind {
        "forward" => {
            let tuples = action.forward_config().map(|f| f.target_groups()).unwrap_or(&[]);
            let targets: Vec<String> = if tuples.len() > 1 {
                tuples.iter().map(|t| format!("{} ({})", name(t.target_group_arn().unwrap_or("")), t.weight().unwrap_or(1))).collect()
            } else {
                tuples.first().and_then(|t| t.target_group_arn()).or(action.target_group_arn()).map(|arn| vec![name(arn)]).unwrap_or_default()
            };
            format!("forward: {}", targets.join(", "))
        }
        "redirect" => {
            let r = action.redirect_config();
            let proto = r.and_then(|r| r.protocol()).unwrap_or("#{protocol}");
            let port = r.and_then(|r| r.port()).unwrap_or("#{port}");
            let host = r.and_then(|r| r.host()).filter(|h| *h != "#{host}").map(|h| format!(" {h}")).unwrap_or_default();
            let path = r.and_then(|r| r.path()).filter(|p| *p != "/#{path}").map(|p| format!(" {p}")).unwrap_or_default();
            let status = r.and_then(|r| r.status_code()).map(|s| s.as_str()).unwrap_or("");
            format!("redirect: {proto}:{port}{host}{path} ({status})")
        }
        "fixed-response" => format!("fixed-response: {}", action.fixed_response_config().and_then(|f| f.status_code()).unwrap_or("")),
        other => other.to_string(),
    }
}

fn actions_text(actions: &[Action], target_groups: &HashMap<String, String>) -> String {
    let mut sorted: Vec<&Action> = actions.iter().collect();
    sorted.sort_by_key(|a| a.order().unwrap_or(0));
    sorted.iter().map(|a| action_text(a, target_groups)).collect::<Vec<_>>().join(" → ")
}

/// 규칙 조건 한 줄: `host-header: a.com, b.com`, `path-pattern: /api/*`, `http-header X-Env: prod`
pub fn condition_text(c: &RuleCondition) -> String {
    let field = c.field().unwrap_or("");
    let configured: Option<Vec<String>> = match field {
        "host-header" => c.host_header_config().map(|h| h.values().to_vec()),
        "path-pattern" => c.path_pattern_config().map(|p| p.values().to_vec()),
        "http-request-method" => c.http_request_method_config().map(|m| m.values().to_vec()),
        "source-ip" => c.source_ip_config().map(|s| s.values().to_vec()),
        "query-string" => c.query_string_config().map(|q| q.values().iter().map(|kv| format!("{}={}", kv.key().unwrap_or(""), kv.value().unwrap_or(""))).collect()),
        "http-header" => c.http_header_config().map(|h| h.values().to_vec()),
        _ => None,
    };
    let values = configured.filter(|v| !v.is_empty()).unwrap_or_else(|| c.values().to_vec());
    let header = if field == "http-header" { c.http_header_config().and_then(|h| h.http_header_name()).map(|n| format!(" {n}")).unwrap_or_default() } else { String::new() };
    format!("{field}{header}: {}", values.join(", "))
}

fn rule_view(r: &Rule, target_groups: &HashMap<String, String>) -> RuleView {
    RuleView {
        priority: r.priority().unwrap_or("").to_string(),
        conditions: r.conditions().iter().map(condition_text).collect::<Vec<_>>().join(" & "),
        action: actions_text(r.actions(), target_groups),
    }
}

fn target_group_basics(tg: &aws_sdk_elasticloadbalancingv2::types::TargetGroup) -> TargetGroupView {
    let enabled = tg.health_check_enabled() != Some(false);
    TargetGroupView {
        arn: tg.target_group_arn().unwrap_or("").to_string(),
        name: tg.target_group_name().unwrap_or("").to_string(),
        protocol: tg.protocol().map(|p| p.as_str().to_string()),
        port: tg.port(),
        target_type: tg.target_type().map(|t| t.as_str().to_string()),
        health_check: enabled.then(|| HealthCheck {
            protocol: tg.health_check_protocol().map(|p| p.as_str().to_string()),
            port: tg.health_check_port().map(str::to_string),
            path: tg.health_check_path().map(str::to_string),
        }),
        targets: vec![],
    }
}

async fn target_groups(elb: &aws_sdk_elasticloadbalancingv2::Client, lb_arn: &str) -> Result<Vec<TargetGroupView>, AppError> {
    let mut pages = elb.describe_target_groups().load_balancer_arn(lb_arn).into_paginator().send();
    let mut out = Vec::new();
    for _ in 0..PAGES_MAX {
        let Some(page) = next_page(pages.next(), "elasticloadbalancing:DescribeTargetGroups").await? else { break };
        out.extend(page.target_groups().iter().map(target_group_basics));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

async fn targets(elb: &aws_sdk_elasticloadbalancingv2::Client, tg_arn: &str) -> Result<Vec<TargetView>, AppError> {
    let out = call(elb.describe_target_health().target_group_arn(tg_arn).send(), "elasticloadbalancing:DescribeTargetHealth").await?;
    let mut views: Vec<TargetView> = out
        .target_health_descriptions()
        .iter()
        .map(|d| TargetView {
            id: d.target().and_then(|t| t.id()).unwrap_or("").to_string(),
            port: d.target().and_then(|t| t.port()),
            zone: d.target().and_then(|t| t.availability_zone()).map(str::to_string),
            state: d.target_health().and_then(|h| h.state()).map(|s| s.as_str().to_string()).unwrap_or_default(),
            reason: d.target_health().and_then(|h| h.reason()).map(|r| r.as_str().to_string()),
            description: d.target_health().and_then(|h| h.description()).map(str::to_string),
            link: None,
        })
        .collect();
    // 문제 있는 것이 먼저, 그다음 ID 순
    views.sort_by(|a, b| (a.state == "healthy", &a.id, a.port).cmp(&(b.state == "healthy", &b.id, b.port)));
    Ok(views)
}

async fn listeners(elb: &aws_sdk_elasticloadbalancingv2::Client, lb: &AwsLb, groups: &HashMap<String, String>, gaps: &mut Vec<Gap>) -> Result<Vec<ListenerView>, AppError> {
    let mut pages = elb.describe_listeners().load_balancer_arn(&lb.arn).into_paginator().send();
    let mut raw = Vec::new();
    for _ in 0..PAGES_MAX {
        let Some(page) = next_page(pages.next(), "elasticloadbalancing:DescribeListeners").await? else { break };
        raw.extend(page.listeners().to_vec());
    }
    let application = lb.kind == Some(super::model::LbKind::Application);
    let mut out = Vec::new();
    for l in raw {
        let arn = l.listener_arn().unwrap_or("").to_string();
        let protocol = l.protocol().map(|p| p.as_str().to_string()).unwrap_or_default();
        let port = l.port().unwrap_or(0);
        let rules = if application {
            match listener_rules(elb, &arn, groups).await {
                Ok(rules) => rules,
                Err(error) => {
                    gaps.push(Gap { section: Section::Listeners, subject: Some(format!("{} {protocol}:{port}", lb.name)), error });
                    vec![]
                }
            }
        } else {
            vec![]
        };
        out.push(ListenerView {
            arn,
            protocol,
            port,
            ssl_policy: l.ssl_policy().map(str::to_string),
            default_action: actions_text(l.default_actions(), groups),
            rules,
        });
    }
    out.sort_by_key(|l| l.port);
    Ok(out)
}

/// 기본 규칙을 뺀 규칙을 우선순위 순으로
async fn listener_rules(elb: &aws_sdk_elasticloadbalancingv2::Client, listener_arn: &str, groups: &HashMap<String, String>) -> Result<Vec<RuleView>, AppError> {
    let mut pages = elb.describe_rules().listener_arn(listener_arn).into_paginator().send();
    let mut rules: Vec<RuleView> = Vec::new();
    for _ in 0..PAGES_MAX {
        let Some(page) = next_page(pages.next(), "elasticloadbalancing:DescribeRules").await? else { break };
        rules.extend(page.rules().iter().filter(|r| r.is_default() != Some(true)).map(|r| rule_view(r, groups)));
    }
    rules.sort_by_key(|r| r.priority.parse::<i64>().unwrap_or(i64::MAX));
    Ok(rules)
}

fn gap(section: Section, subject: String, error: AppError) -> Gap {
    Gap { section, subject: Some(subject), error }
}

/// 짝이 있는 로드 밸런서 하나의 리스너, 대상 그룹, 대상 상태. 읽지 못한 부분은 `gaps`에 이유를 담고 나머지는 그대로 돌려준다.
pub async fn details(elb: &aws_sdk_elasticloadbalancingv2::Client, lb: &AwsLb, nodes: &[NodeNet], pods: &[PodNet]) -> LoadBalancerView {
    let mut gaps = Vec::new();
    let mut groups = match target_groups(elb, &lb.arn).await {
        Ok(groups) => groups,
        Err(error) => {
            gaps.push(gap(Section::TargetGroups, lb.name.clone(), error));
            vec![]
        }
    };
    let names: HashMap<String, String> = groups.iter().map(|g| (g.arn.clone(), g.name.clone())).collect();
    let health = join_all(groups.iter().map(|g| targets(elb, &g.arn))).await;
    for (group, result) in groups.iter_mut().zip(health) {
        match result {
            Ok(mut views) => {
                for v in &mut views {
                    v.link = link_of(&v.id, nodes, pods);
                }
                group.targets = views;
            }
            Err(error) => gaps.push(gap(Section::TargetHealth, format!("{} / {}", lb.name, group.name), error)),
        }
    }
    let listeners = match listeners(elb, lb, &names, &mut gaps).await {
        Ok(listeners) => listeners,
        Err(error) => {
            gaps.push(gap(Section::Listeners, lb.name.clone(), error));
            vec![]
        }
    };
    LoadBalancerView {
        arn: lb.arn.clone(),
        name: lb.name.clone(),
        dns_name: lb.dns_name.clone(),
        kind: lb.kind,
        scheme: lb.scheme.clone(),
        state: lb.state.clone(),
        vpc_id: lb.vpc_id.clone(),
        zones: lb.zones.clone(),
        security_groups: lb.security_groups.clone(),
        listeners,
        target_groups: groups,
        gaps,
    }
}

#[cfg(test)]
mod tests;
