//! 큐의 흐름: 생산자(SNS 구독·EventBridge 규칙·Pipes·S3 알림·IAM 주체) → 큐 → 소비자(Lambda ESM·Pipes·IAM 주체 → EKS 서비스 어카운트), 그리고 DLQ.
//! 읽기만 한다. 읽기 하나가 실패해도 나머지는 그리고, 실패한 절은 `gaps`에 적는다. 다른 계정의 ARN은 노드만 만들고 읽지 않는다.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use aws_config::SdkConfig;
use futures::join;
use serde_json::Value;

use super::health::{flow_findings, FlowParts, KmsAccess, LambdaConsumer, ProducerKind, ProducerLink};
use super::peek::{esm_active, pipe_active};
use super::policy;
use super::read::{name_of_arn, url_from_arn};
use super::{FlowDetail, FlowEdge, FlowEdgeKind, FlowNode, FlowNodeKind, SqsFlow, SqsGap, SqsJump, SqsQueue, SqsRegionFlow};
use crate::adapters::util::{last_segment, map_concurrent};
use crate::error::{from_sdk, AppError};
use crate::iam::eval::who_can;
use crate::iam::model::Snapshot;
use crate::iam::view::{PrincipalKind, Status, WhoCanResult};

const POLICY_ONLY: &str = "허용만 됨";
const SNS_SERVICE: &str = "sns.amazonaws.com";
const EVENTS_SERVICE: &str = "events.amazonaws.com";
const S3_SERVICE: &str = "s3.amazonaws.com";
/// IAM으로 계산한 주체 노드는 쪽마다 이만큼만 보인다(관리자 권한 주체가 많으면 흐름이 묻힌다)
const MAX_PRINCIPALS: usize = 50;
const AWS_MANAGED_KEY: &str = "alias/aws/sqs";

fn gap(section: &str, error: String) -> SqsGap {
    SqsGap { section: section.into(), error }
}

fn detail(label: &str, value: impl Into<String>) -> FlowDetail {
    FlowDetail { label: label.into(), value: value.into() }
}

pub fn account_of(arn: &str) -> &str {
    arn.split(':').nth(4).unwrap_or_default()
}

fn region_of_arn(arn: &str) -> &str {
    arn.split(':').nth(3).unwrap_or_default()
}

/// 이벤트 패턴 같은 긴 JSON을 한 줄로 줄인다
fn compact(text: &str, max: usize) -> String {
    let one = serde_json::from_str::<Value>(text).map(|v| v.to_string()).unwrap_or_else(|_| text.trim().to_string());
    if one.chars().count() > max {
        format!("{}…", one.chars().take(max).collect::<String>())
    } else {
        one
    }
}

#[derive(Debug, Clone)]
pub struct Esm {
    pub uuid: String,
    /// 이벤트 소스(SQS 큐) ARN
    pub source_arn: String,
    pub function_arn: String,
    pub state: String,
    pub batch_size: Option<i32>,
    pub window: Option<i32>,
    pub max_concurrency: Option<i32>,
    pub report_failures: bool,
}

#[derive(Debug, Clone)]
pub struct PipeInfo {
    pub name: String,
    pub arn: String,
    pub state: String,
    pub source: String,
    pub target: String,
}

/// 이벤트 소스 매핑. `source_arn`이 None이면 리전의 모든 매핑이다
async fn esms_in(client: &aws_sdk_lambda::Client, source_arn: Option<&str>) -> Result<Vec<Esm>, AppError> {
    let mut out = Vec::new();
    let mut pages = client.list_event_source_mappings().set_event_source_arn(source_arn.map(str::to_string)).into_paginator().send();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "lambda:ListEventSourceMappings"))?;
        for m in page.event_source_mappings() {
            out.push(Esm {
                uuid: m.uuid().unwrap_or_default().to_string(),
                source_arn: m.event_source_arn().unwrap_or_default().to_string(),
                function_arn: m.function_arn().unwrap_or_default().to_string(),
                state: m.state().unwrap_or_default().to_string(),
                batch_size: m.batch_size(),
                window: m.maximum_batching_window_in_seconds(),
                max_concurrency: m.scaling_config().and_then(|s| s.maximum_concurrency()),
                report_failures: m.function_response_types().iter().any(|t| t.as_str() == "ReportBatchItemFailures"),
            });
        }
    }
    Ok(out)
}

/// 이 큐를 원본으로 하는 이벤트 소스 매핑
pub async fn esms(cfg: &SdkConfig, source_arn: &str) -> Result<Vec<Esm>, AppError> {
    esms_in(&aws_sdk_lambda::Client::new(cfg), Some(source_arn)).await
}

async fn pipes_in(client: &aws_sdk_pipes::Client, source: Option<&str>, target: Option<&str>) -> Result<Vec<PipeInfo>, AppError> {
    let mut out = Vec::new();
    let mut pages = client
        .list_pipes()
        .set_source_prefix(source.map(str::to_string))
        .set_target_prefix(target.map(str::to_string))
        .into_paginator()
        .send();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "pipes:ListPipes"))?;
        for p in page.pipes() {
            out.push(PipeInfo {
                name: p.name().unwrap_or_default().to_string(),
                arn: p.arn().unwrap_or_default().to_string(),
                state: p.current_state().map(|s| s.as_str().to_string()).unwrap_or_default(),
                source: p.source().unwrap_or_default().to_string(),
                target: p.target().unwrap_or_default().to_string(),
            });
        }
    }
    Ok(out)
}

/// 이 큐를 원본으로 하는 Pipe(접두사로 찾은 것 가운데 정확히 이 ARN인 것만)
pub async fn pipes_from(cfg: &SdkConfig, arn: &str) -> Result<Vec<PipeInfo>, AppError> {
    let mut pipes = pipes_in(&aws_sdk_pipes::Client::new(cfg), Some(arn), None).await?;
    pipes.retain(|p| p.source == arn);
    Ok(pipes)
}

async fn pipes_to(cfg: &SdkConfig, arn: &str) -> Result<Vec<PipeInfo>, AppError> {
    let mut pipes = pipes_in(&aws_sdk_pipes::Client::new(cfg), None, Some(arn)).await?;
    pipes.retain(|p| p.target == arn);
    Ok(pipes)
}

/// 한 절의 읽기 결과: 만든 노드와, 실패했다면 그 이유
struct Section {
    nodes: Vec<FlowNode>,
    error: Option<String>,
}

impl Section {
    fn ok(nodes: Vec<FlowNode>) -> Section {
        Section { nodes, error: None }
    }
    fn partial(nodes: Vec<FlowNode>, error: Option<AppError>) -> Section {
        Section { nodes, error: error.map(|e| e.to_string()) }
    }
}

fn verdict(q: &SqsQueue, source_arn: &str, service: &str) -> Option<bool> {
    policy::allows_send(q.policy.as_deref(), source_arn, service, account_of(&q.arn))
}

// ---------- SNS ----------

struct Subscription {
    topic_arn: String,
    subscription_arn: String,
    attrs: Option<HashMap<String, String>>,
}

fn sns_node(q: &SqsQueue, sub: &Subscription) -> FlowNode {
    let topic = &sub.topic_arn;
    let cross = account_of(topic) != account_of(&q.arn);
    let pending = sub.subscription_arn == "PendingConfirmation";
    let mut details = vec![detail("토픽", topic.clone())];
    if let Some(attrs) = &sub.attrs {
        if let Some(f) = attrs.get("FilterPolicy").filter(|v| !v.is_empty()) {
            details.push(detail("필터 정책", compact(f, 300)));
        }
        if let Some(r) = attrs.get("RawMessageDelivery") {
            details.push(detail("원본 그대로 전달", if r == "true" { "예" } else { "아니요(SNS 봉투에 싸서 전달)" }));
        }
        if let Some(d) = attrs.get("RedrivePolicy").filter(|v| !v.is_empty()) {
            details.push(detail("구독 DLQ", compact(d, 200)));
        }
    }
    if cross {
        details.push(detail("계정", format!("{} (다른 계정이라 읽지 않아요)", account_of(topic))));
    }
    FlowNode {
        kind: FlowNodeKind::Sns,
        id: topic.clone(),
        label: name_of_arn(topic),
        state: Some(if pending { "PendingConfirmation" } else { "Confirmed" }.into()),
        allowed_by_policy: verdict(q, topic, SNS_SERVICE),
        cross_account: cross,
        detail: details,
        jump: (!cross).then(|| SqsJump::Resource { service: "sns".into(), type_id: "topics".into(), id: topic.clone() }),
    }
}

async fn sns_section(cfg: &SdkConfig, q: &SqsQueue) -> Section {
    let client = aws_sdk_sns::Client::new(cfg);
    let mut subs: Vec<Subscription> = Vec::new();
    let mut pages = client.list_subscriptions().into_paginator().send();
    let mut error = None;
    while let Some(page) = pages.next().await {
        match page {
            Ok(page) => {
                for s in page.subscriptions() {
                    if s.protocol() == Some("sqs") && s.endpoint() == Some(q.arn.as_str()) {
                        subs.push(Subscription { topic_arn: s.topic_arn().unwrap_or_default().to_string(), subscription_arn: s.subscription_arn().unwrap_or_default().to_string(), attrs: None });
                    }
                }
            }
            Err(e) => {
                error = Some(from_sdk(e, "sns:ListSubscriptions"));
                break;
            }
        }
    }
    // 같은 계정 토픽의 구독만 속성을 읽는다
    let account = account_of(&q.arn).to_string();
    let attrs = map_concurrent(subs.iter().map(|s| (s.topic_arn.clone(), s.subscription_arn.clone())).collect(), |(topic, arn)| {
        let client = client.clone();
        let account = account.clone();
        async move {
            if account_of(&topic) != account || arn == "PendingConfirmation" {
                return None;
            }
            client.get_subscription_attributes().subscription_arn(arn).send().await.ok().and_then(|r| r.attributes().cloned())
        }
    })
    .await;
    for (sub, attrs) in subs.iter_mut().zip(attrs) {
        sub.attrs = attrs;
    }
    let mut nodes: Vec<FlowNode> = subs.iter().map(|s| sns_node(q, s)).collect();
    nodes.sort_by(|a, b| a.label.cmp(&b.label));
    Section::partial(nodes, error)
}

// ---------- EventBridge ----------

struct Rule {
    arn: String,
    name: String,
    bus: String,
    state: String,
    pattern: Option<String>,
    schedule: Option<String>,
}

fn rule_node(q: &SqsQueue, rule: &Rule) -> FlowNode {
    let cross = account_of(&rule.arn) != account_of(&q.arn);
    let mut details = vec![detail("이벤트 버스", rule.bus.clone())];
    if let Some(p) = &rule.pattern {
        details.push(detail("이벤트 패턴", compact(p, 300)));
    }
    if let Some(s) = &rule.schedule {
        details.push(detail("스케줄", s.clone()));
    }
    let label = if rule.bus == "default" { rule.name.clone() } else { format!("{} ({})", rule.name, rule.bus) };
    FlowNode {
        kind: FlowNodeKind::Rule,
        id: rule.arn.clone(),
        label,
        state: Some(rule.state.clone()),
        allowed_by_policy: verdict(q, &rule.arn, EVENTS_SERVICE),
        cross_account: cross,
        detail: details,
        jump: None,
    }
}

async fn rules_section(cfg: &SdkConfig, q: &SqsQueue) -> Section {
    let client = aws_sdk_eventbridge::Client::new(cfg);
    let mut buses: Vec<String> = Vec::new();
    let mut token: Option<String> = None;
    loop {
        match client.list_event_buses().set_next_token(token.take()).send().await {
            Ok(page) => {
                buses.extend(page.event_buses().iter().filter_map(|b| b.name().map(str::to_string)));
                token = page.next_token().map(str::to_string);
                if token.is_none() {
                    break;
                }
            }
            Err(e) => return Section::partial(vec![], Some(from_sdk(e, "events:ListEventBuses"))),
        }
    }
    let mut rules: Vec<Rule> = Vec::new();
    let mut error = None;
    'buses: for bus in &buses {
        let mut names: Vec<String> = Vec::new();
        let mut token: Option<String> = None;
        loop {
            match client.list_rule_names_by_target().target_arn(&q.arn).event_bus_name(bus).set_next_token(token.take()).send().await {
                Ok(page) => {
                    names.extend(page.rule_names().iter().cloned());
                    token = page.next_token().map(str::to_string);
                    if token.is_none() {
                        break;
                    }
                }
                Err(e) => {
                    error = Some(from_sdk(e, "events:ListRuleNamesByTarget"));
                    break 'buses;
                }
            }
        }
        for name in names {
            match client.describe_rule().name(&name).event_bus_name(bus).send().await {
                Ok(d) => rules.push(Rule {
                    arn: d.arn().unwrap_or_default().to_string(),
                    name,
                    bus: bus.clone(),
                    state: d.state().map(|s| s.as_str().to_string()).unwrap_or_default(),
                    pattern: d.event_pattern().filter(|p| !p.is_empty()).map(str::to_string),
                    schedule: d.schedule_expression().filter(|p| !p.is_empty()).map(str::to_string),
                }),
                Err(e) => {
                    error = Some(from_sdk(e, "events:DescribeRule"));
                    break 'buses;
                }
            }
        }
    }
    let mut nodes: Vec<FlowNode> = rules.iter().map(|r| rule_node(q, r)).collect();
    nodes.sort_by(|a, b| a.label.cmp(&b.label));
    Section::partial(nodes, error)
}

// ---------- Pipes ----------

fn pipe_node(p: &PipeInfo, detail_rows: Vec<FlowDetail>) -> FlowNode {
    FlowNode {
        kind: FlowNodeKind::Pipe,
        id: p.arn.clone(),
        label: p.name.clone(),
        state: Some(p.state.clone()),
        allowed_by_policy: None,
        cross_account: false,
        detail: detail_rows,
        jump: None,
    }
}

// ---------- Lambda ----------

struct LambdaRead {
    esm: Esm,
    timeout: Option<i64>,
    error: Option<AppError>,
}

fn lambda_node(q: &SqsQueue, l: &LambdaRead) -> FlowNode {
    let function_arn = &l.esm.function_arn;
    let name = last_segment(function_arn, ':');
    let cross = account_of(function_arn) != account_of(&q.arn);
    let mut details = vec![detail("매핑 UUID", l.esm.uuid.clone())];
    if let Some(n) = l.esm.batch_size {
        details.push(detail("배치 크기", n.to_string()));
    }
    if let Some(n) = l.esm.window {
        details.push(detail("배치 대기(초)", n.to_string()));
    }
    if let Some(n) = l.esm.max_concurrency {
        details.push(detail("최대 동시성", n.to_string()));
    }
    details.push(detail("부분 실패 보고", if l.esm.report_failures { "ReportBatchItemFailures" } else { "꺼짐" }));
    if let Some(t) = l.timeout {
        details.push(detail("함수 제한 시간(초)", t.to_string()));
    }
    FlowNode {
        kind: FlowNodeKind::Lambda,
        id: function_arn.clone(),
        label: name.clone(),
        state: Some(l.esm.state.clone()),
        allowed_by_policy: None,
        cross_account: cross,
        detail: details,
        jump: (!cross).then(|| SqsJump::Resource { service: "lambda".into(), type_id: "functions".into(), id: name }),
    }
}

async fn lambda_reads(cfg: &SdkConfig, q: &SqsQueue) -> Result<Vec<LambdaRead>, AppError> {
    let client = aws_sdk_lambda::Client::new(cfg);
    let mappings = esms_in(&client, Some(&q.arn)).await?;
    let account = account_of(&q.arn).to_string();
    Ok(map_concurrent(mappings, |esm| {
        let client = client.clone();
        let account = account.clone();
        async move {
            if account_of(&esm.function_arn) != account {
                return LambdaRead { esm, timeout: None, error: None };
            }
            let name = last_segment(&esm.function_arn, ':');
            match client.get_function_configuration().function_name(&name).send().await {
                Ok(c) => LambdaRead { timeout: c.timeout().map(i64::from), esm, error: None },
                Err(e) => LambdaRead { esm, timeout: None, error: Some(from_sdk(e, "lambda:GetFunctionConfiguration")) },
            }
        }
    })
    .await)
}

// ---------- S3 ----------

async fn s3_section(cfg: &SdkConfig, q: &SqsQueue) -> Section {
    let Some(policy) = q.policy.as_deref() else { return Section::ok(vec![]) };
    let buckets = policy::s3_buckets(policy);
    if buckets.is_empty() {
        return Section::ok(vec![]);
    }
    let client = aws_sdk_s3::Client::new(cfg);
    let mut nodes = Vec::new();
    let mut error = None;
    for bucket in buckets {
        let arn = format!("arn:aws:s3:::{bucket}");
        let allowed = verdict(q, &arn, S3_SERVICE);
        let mut node = FlowNode {
            kind: FlowNodeKind::S3,
            id: arn.clone(),
            label: bucket.clone(),
            state: None,
            allowed_by_policy: allowed,
            cross_account: false,
            detail: vec![],
            jump: Some(SqsJump::Resource { service: "s3".into(), type_id: "buckets".into(), id: bucket.clone() }),
        };
        match client.get_bucket_notification_configuration().bucket(&bucket).send().await {
            Ok(conf) => {
                let configs: Vec<_> = conf.queue_configurations().iter().filter(|c| c.queue_arn() == q.arn).collect();
                if configs.is_empty() {
                    node.state = Some(POLICY_ONLY.into());
                } else {
                    for c in configs {
                        let events: Vec<&str> = c.events().iter().map(|e| e.as_str()).collect();
                        node.detail.push(detail("이벤트", events.join(", ")));
                        if let Some(id) = c.id() {
                            node.detail.push(detail("알림 ID", id));
                        }
                    }
                }
            }
            Err(e) => {
                node.state = Some("확인 못 함".into());
                error = Some(from_sdk(e, "s3:GetBucketNotification"));
            }
        }
        nodes.push(node);
    }
    Section::partial(nodes, error)
}

/// 정책만 허용하고 연결은 없는 SNS 토픽·EventBridge 규칙 노드(흐리게 보인다)
fn policy_only_nodes(q: &SqsQueue, connected: &HashSet<String>) -> Vec<FlowNode> {
    let Some(policy) = q.policy.as_deref() else { return vec![] };
    policy::allowed_source_arns(policy)
        .into_iter()
        .filter(|arn| !connected.contains(arn))
        .filter_map(|arn| {
            let cross = account_of(&arn) != account_of(&q.arn);
            let (kind, service, jump) = if arn.starts_with("arn:aws:sns:") {
                (FlowNodeKind::Sns, SNS_SERVICE, (!cross).then(|| SqsJump::Resource { service: "sns".into(), type_id: "topics".into(), id: arn.clone() }))
            } else if arn.starts_with("arn:aws:events:") && arn.contains(":rule/") {
                (FlowNodeKind::Rule, EVENTS_SERVICE, None)
            } else {
                return None;
            };
            Some(FlowNode {
                kind,
                id: arn.clone(),
                label: name_of_arn(&arn).rsplit('/').next().unwrap_or_default().to_string(),
                state: Some(POLICY_ONLY.into()),
                allowed_by_policy: verdict(q, &arn, service),
                cross_account: cross,
                detail: vec![detail("연결", "큐 정책이 허용만 하고 구독·규칙 대상은 찾지 못했어요")],
                jump,
            })
        })
        .collect()
}

// ---------- KMS ----------

fn producer_service(kind: ProducerKind) -> &'static str {
    match kind {
        ProducerKind::Sns => SNS_SERVICE,
        ProducerKind::Rule => EVENTS_SERVICE,
    }
}

/// 서비스 생산자가 있을 때 큐의 암호화 키가 그들에게 열려 있는지 본다
async fn kms_access(cfg: &SdkConfig, q: &SqsQueue, links: &[ProducerLink]) -> (KmsAccess, Option<String>) {
    let Some(key) = q.kms_key.as_deref() else { return (KmsAccess::NotApplicable, None) };
    if links.is_empty() {
        return (KmsAccess::NotApplicable, None);
    }
    if key == AWS_MANAGED_KEY {
        return (KmsAccess::AwsManaged, None);
    }
    if key.starts_with("arn:") && account_of(key) != account_of(&q.arn) {
        let reason = "다른 계정의 키라 읽지 않아요".to_string();
        return (KmsAccess::Unreadable(reason.clone()), Some(reason));
    }
    let client = aws_sdk_kms::Client::new(cfg);
    // GetKeyPolicy는 별칭을 받지 않는다: 별칭이면 키 ID로 바꾼다
    let key_id = if key.starts_with("alias/") || key.contains(":alias/") {
        match client.describe_key().key_id(key).send().await {
            Ok(d) => d.key_metadata().map(|m| m.key_id().to_string()).unwrap_or_else(|| key.to_string()),
            Err(e) => {
                let reason = from_sdk(e, "kms:DescribeKey").to_string();
                return (KmsAccess::Unreadable(reason.clone()), Some(reason));
            }
        }
    } else {
        key.to_string()
    };
    match client.get_key_policy().key_id(&key_id).policy_name("default").send().await {
        Ok(r) => {
            let text = r.policy().unwrap_or_default();
            let mut kinds: Vec<ProducerKind> = Vec::new();
            for l in links {
                if !kinds.contains(&l.kind) {
                    kinds.push(l.kind);
                }
            }
            let verdicts = kinds.into_iter().map(|k| (k, policy::key_allows_service(text, producer_service(k)))).collect();
            (KmsAccess::Customer(verdicts), None)
        }
        Err(e) => {
            let reason = from_sdk(e, "kms:GetKeyPolicy").to_string();
            (KmsAccess::Unreadable(reason.clone()), Some(reason))
        }
    }
}

// ---------- IAM ----------

/// 신뢰 정책에서 뽑은 서비스 어카운트(`system:serviceaccount:<ns>:<sa>`)
#[derive(Debug, Clone, PartialEq)]
pub struct ServiceAccountRef {
    /// 신뢰 정책 Federated 주체의 OIDC 공급자 경로(`oidc.eks.<리전>.amazonaws.com/id/<ID>`)
    pub provider: String,
    pub namespace: String,
    pub name: String,
}

/// 역할의 신뢰 정책의 OIDC `sub` 조건에서 서비스 어카운트를 뽑는다
pub fn service_accounts(trust: &str) -> Vec<ServiceAccountRef> {
    let Ok(doc) = serde_json::from_str::<Value>(trust) else { return vec![] };
    let statements: Vec<&Value> = match doc.get("Statement") {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(single @ Value::Object(_)) => vec![single],
        _ => vec![],
    };
    let mut out: Vec<ServiceAccountRef> = Vec::new();
    for s in statements {
        if s.get("Effect").and_then(Value::as_str) != Some("Allow") {
            continue;
        }
        let federated = match s.get("Principal").and_then(|p| p.get("Federated")) {
            Some(Value::String(f)) => vec![f.as_str()],
            Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect(),
            _ => continue,
        };
        let Some(provider) = federated.iter().find_map(|f| f.split_once("oidc-provider/").map(|(_, p)| p.to_string())) else { continue };
        let Some(Value::Object(operators)) = s.get("Condition") else { continue };
        for keys in operators.values() {
            let Value::Object(keys) = keys else { continue };
            for (key, values) in keys {
                if !key.ends_with(":sub") {
                    continue;
                }
                let values: Vec<&str> = match values {
                    Value::String(v) => vec![v.as_str()],
                    Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
                    _ => vec![],
                };
                for v in values {
                    let Some(rest) = v.strip_prefix("system:serviceaccount:") else { continue };
                    let Some((namespace, name)) = rest.split_once(':') else { continue };
                    let item = ServiceAccountRef { provider: provider.clone(), namespace: namespace.into(), name: name.into() };
                    if !out.contains(&item) {
                        out.push(item);
                    }
                }
            }
        }
    }
    out
}

/// 리전 EKS 클러스터의 이름과 OIDC 발급자(`https://` 없이)
#[derive(Debug, Clone, PartialEq)]
pub struct ClusterRef {
    pub name: String,
    pub issuer: String,
}

fn cluster_for<'a>(clusters: &'a [ClusterRef], provider: &str) -> Option<&'a ClusterRef> {
    clusters.iter().find(|c| c.issuer == provider)
}

/// Pod Identity 연결 하나: 클러스터의 `<namespace>/<serviceAccount>`가 이 역할을 맡는다
#[derive(Debug, Clone, PartialEq)]
pub struct PodIdentityRef {
    pub cluster: String,
    pub namespace: String,
    pub service_account: String,
    pub role_arn: String,
}

/// 리전 EKS에서 읽은 것: IRSA 매칭용 클러스터(OIDC 발급자)와 Pod Identity 연결
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EksInfo {
    pub clusters: Vec<ClusterRef>,
    pub pod_identities: Vec<PodIdentityRef>,
}

/// 클러스터마다 읽는 Pod Identity 연결의 상한(넘으면 gap에 적는다)
const MAX_ASSOCIATIONS: usize = 200;
const POD_IDENTITY_SERVICE: &str = "pods.eks.amazonaws.com";

/// 이 역할을 맡는 Pod Identity 연결
pub fn pod_identities_for<'a>(role_arn: &str, all: &'a [PodIdentityRef]) -> Vec<&'a PodIdentityRef> {
    all.iter().filter(|p| p.role_arn == role_arn).collect()
}

/// 신뢰 정책이 EKS Pod Identity(`pods.eks.amazonaws.com`)가 맡는 것을 허용하는가
pub fn trusts_pod_identity(trust: &str) -> bool {
    let Ok(doc) = serde_json::from_str::<Value>(trust) else { return false };
    let statements: Vec<&Value> = match doc.get("Statement") {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(single @ Value::Object(_)) => vec![single],
        _ => vec![],
    };
    statements.into_iter().any(|s| {
        if s.get("Effect").and_then(Value::as_str) != Some("Allow") {
            return false;
        }
        match s.get("Principal").and_then(|p| p.get("Service")) {
            Some(Value::String(v)) => v.eq_ignore_ascii_case(POD_IDENTITY_SERVICE),
            Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).any(|v| v.eq_ignore_ascii_case(POD_IDENTITY_SERVICE)),
            _ => false,
        }
    })
}

async fn eks_cluster_names(client: &aws_sdk_eks::Client) -> Result<Vec<String>, AppError> {
    let mut names: Vec<String> = Vec::new();
    let mut pages = client.list_clusters().into_paginator().send();
    while let Some(page) = pages.next().await {
        names.extend(page.map_err(|e| from_sdk(e, "eks:ListClusters"))?.clusters().iter().cloned());
    }
    Ok(names)
}

async fn eks_clusters(client: &aws_sdk_eks::Client, names: Vec<String>) -> Result<Vec<ClusterRef>, AppError> {
    let described = map_concurrent(names, |name| {
        let client = client.clone();
        async move {
            let out = client.describe_cluster().name(&name).send().await.map_err(|e| from_sdk(e, "eks:DescribeCluster"))?;
            let issuer = out.cluster().and_then(|c| c.identity()).and_then(|i| i.oidc()).and_then(|o| o.issuer()).map(|i| i.trim_start_matches("https://").to_string());
            Ok::<_, AppError>(issuer.map(|issuer| ClusterRef { name, issuer }))
        }
    })
    .await;
    let mut out = Vec::new();
    for item in described {
        if let Some(c) = item? {
            out.push(c);
        }
    }
    Ok(out)
}

/// 한 클러스터의 Pod Identity 연결(상한까지). 두 번째 값은 상한에 걸려 잘렸는가
async fn pod_identities_of(client: &aws_sdk_eks::Client, cluster: &str) -> Result<(Vec<PodIdentityRef>, bool), AppError> {
    let mut ids: Vec<String> = Vec::new();
    let mut cut = false;
    let mut pages = client.list_pod_identity_associations().cluster_name(cluster).into_paginator().send();
    'pages: while let Some(page) = pages.next().await {
        for a in page.map_err(|e| from_sdk(e, "eks:ListPodIdentityAssociations"))?.associations() {
            if ids.len() >= MAX_ASSOCIATIONS {
                cut = true;
                break 'pages;
            }
            if let Some(id) = a.association_id() {
                ids.push(id.to_string());
            }
        }
    }
    let described = map_concurrent(ids, |id| {
        let client = client.clone();
        let cluster = cluster.to_string();
        async move {
            let out = client.describe_pod_identity_association().cluster_name(&cluster).association_id(id).send().await.map_err(|e| from_sdk(e, "eks:DescribePodIdentityAssociation"))?;
            Ok::<_, AppError>(out.association().map(|a| PodIdentityRef {
                cluster: cluster.clone(),
                namespace: a.namespace().unwrap_or_default().to_string(),
                service_account: a.service_account().unwrap_or_default().to_string(),
                role_arn: a.role_arn().unwrap_or_default().to_string(),
            }))
        }
    })
    .await;
    let mut out = Vec::new();
    for item in described {
        if let Some(p) = item? {
            out.push(p);
        }
    }
    Ok((out, cut))
}

/// 필요한 만큼만 EKS를 읽는다. 클러스터 목록·OIDC 발급자 실패는 "EKS 클러스터", Pod Identity 실패는 "EKS Pod Identity" gap이다
async fn read_eks(cfg: &SdkConfig, irsa: bool, pod_identity: bool, gaps: &mut Vec<SqsGap>) -> EksInfo {
    let client = aws_sdk_eks::Client::new(cfg);
    let names = match eks_cluster_names(&client).await {
        Ok(n) => n,
        Err(e) => {
            gaps.push(gap("EKS 클러스터", e.to_string()));
            return EksInfo::default();
        }
    };
    let mut info = EksInfo::default();
    if irsa {
        match eks_clusters(&client, names.clone()).await {
            Ok(c) => info.clusters = c,
            Err(e) => gaps.push(gap("EKS 클러스터", e.to_string())),
        }
    }
    if pod_identity {
        for name in &names {
            match pod_identities_of(&client, name).await {
                Ok((found, cut)) => {
                    info.pod_identities.extend(found);
                    if cut {
                        gaps.push(gap("EKS Pod Identity", format!("클러스터 `{name}`의 연결이 {MAX_ASSOCIATIONS}개를 넘어 앞의 {MAX_ASSOCIATIONS}개만 읽었어요")));
                    }
                }
                Err(e) => gaps.push(gap("EKS Pod Identity", format!("클러스터 `{name}`: {e}"))),
            }
        }
    }
    info
}

/// IAM으로 계산한 보내는/받는 주체 노드
pub struct IamNodes {
    pub producers: Vec<FlowNode>,
    pub consumers: Vec<FlowNode>,
    /// 받을 수 있는 주체 수(허용·조건부)
    pub receivers: usize,
    pub truncated: Vec<String>,
}

fn kind_label(kind: PrincipalKind) -> &'static str {
    match kind {
        PrincipalKind::User => "사용자",
        PrincipalKind::Group => "그룹",
        PrincipalKind::Role => "역할",
    }
}

fn principal_nodes(s: &Snapshot, result: &WhoCanResult, eks: &EksInfo) -> (Vec<FlowNode>, usize) {
    let hits: Vec<_> = result.hits.iter().filter(|h| matches!(h.status, Status::Allowed | Status::Conditional)).collect();
    let total = hits.len();
    let mut nodes = Vec::new();
    for hit in hits.into_iter().take(MAX_PRINCIPALS) {
        let p = &hit.principal;
        let conditional = hit.status == Status::Conditional;
        let mut rows = vec![detail("종류", kind_label(p.kind)), detail("판정", if conditional { "조건부 허용" } else { "허용" })];
        let policies: Vec<String> = hit.sources.iter().map(|g| g.policy_name.clone()).collect();
        if !policies.is_empty() {
            rows.push(detail("근거 정책", policies.join(", ")));
        }
        nodes.push(FlowNode {
            kind: FlowNodeKind::Principal,
            id: p.arn.clone(),
            label: p.name.clone(),
            state: Some(if conditional { "조건부" } else { "허용" }.into()),
            allowed_by_policy: None,
            cross_account: false,
            detail: rows,
            jump: Some(SqsJump::Iam { arn: p.arn.clone() }),
        });
        if p.kind == PrincipalKind::Role {
            for sa in role_service_accounts(s, &p.arn) {
                let cluster = cluster_for(&eks.clusters, &sa.provider);
                let sa_rows = vec![detail("역할", p.name.clone()), detail("클러스터", cluster.map(|c| c.name.clone()).unwrap_or_else(|| format!("알 수 없음 ({})", sa.provider)))];
                nodes.push(FlowNode {
                    kind: FlowNodeKind::ServiceAccount,
                    id: format!("{}#{}/{}", p.arn, sa.namespace, sa.name),
                    label: format!("{}/{}", sa.namespace, sa.name),
                    state: None,
                    allowed_by_policy: None,
                    cross_account: false,
                    detail: sa_rows,
                    jump: cluster.map(|c| SqsJump::Eks { cluster: c.name.clone() }),
                });
            }
            for pi in pod_identities_for(&p.arn, &eks.pod_identities) {
                let label = format!("{}/{}", pi.namespace, pi.service_account);
                let jump = SqsJump::Eks { cluster: pi.cluster.clone() };
                // 같은 역할·클러스터의 같은 서비스 어카운트를 IRSA로 이미 보였으면 한 번만
                if nodes.iter().any(|n| n.kind == FlowNodeKind::ServiceAccount && n.label == label && n.jump.as_ref() == Some(&jump) && n.id.starts_with(&format!("{}#", p.arn))) {
                    continue;
                }
                nodes.push(FlowNode {
                    kind: FlowNodeKind::ServiceAccount,
                    id: format!("{}#{}/{}", p.arn, pi.cluster, label),
                    label,
                    state: None,
                    allowed_by_policy: None,
                    cross_account: false,
                    detail: vec![detail("역할", p.name.clone()), detail("클러스터", pi.cluster.clone()), detail("연결 방식", "Pod Identity")],
                    jump: Some(jump),
                });
            }
        }
    }
    (nodes, total)
}

fn role_service_accounts(s: &Snapshot, role_arn: &str) -> Vec<ServiceAccountRef> {
    s.roles.iter().find(|r| r.arn == role_arn).and_then(|r| r.trust_raw.as_deref()).map(service_accounts).unwrap_or_default()
}

fn allowed_roles<'a>(results: &'a [&WhoCanResult]) -> impl Iterator<Item = &'a str> {
    results.iter().flat_map(|r| r.hits.iter()).filter(|h| matches!(h.status, Status::Allowed | Status::Conditional) && h.principal.kind == PrincipalKind::Role).map(|h| h.principal.arn.as_str())
}

fn role_trust<'a>(s: &'a Snapshot, role_arn: &str) -> Option<&'a str> {
    s.roles.iter().find(|r| r.arn == role_arn).and_then(|r| r.trust_raw.as_deref())
}

/// 허용 주체 가운데 신뢰 정책에 OIDC 서비스 어카운트(IRSA)가 있는 역할이 있는가(EKS 클러스터의 OIDC 발급자를 읽을 필요가 있는가)
pub fn needs_clusters(s: &Snapshot, results: &[&WhoCanResult]) -> bool {
    allowed_roles(results).any(|arn| !role_service_accounts(s, arn).is_empty())
}

/// 허용 주체 가운데 신뢰 정책이 `pods.eks.amazonaws.com`을 허용하는 역할이 있는가(Pod Identity 연결을 읽을 필요가 있는가)
pub fn needs_pod_identity(s: &Snapshot, results: &[&WhoCanResult]) -> bool {
    allowed_roles(results).any(|arn| role_trust(s, arn).is_some_and(trusts_pod_identity))
}

/// 이 큐에 보낼 수 있는/받을 수 있는 주체와 그 역할이 가리키는 서비스 어카운트
pub fn iam_nodes(s: &Snapshot, send: &WhoCanResult, receive: &WhoCanResult, eks: &EksInfo) -> IamNodes {
    let (producers, sends) = principal_nodes(s, send, eks);
    let (consumers, receives) = principal_nodes(s, receive, eks);
    let mut truncated = Vec::new();
    for (side, total) in [("보낼 수 있는", sends), ("받을 수 있는", receives)] {
        if total > MAX_PRINCIPALS {
            truncated.push(format!("{side} 주체 {total}개 중 {MAX_PRINCIPALS}개만 보여요"));
        }
    }
    IamNodes { producers, consumers, receivers: receives, truncated }
}

// ---------- 합치기 ----------

fn queue_node(arn: &str, peers: &[SqsQueue], own: &SqsQueue, dlq_of: Option<i64>) -> FlowNode {
    let cross = account_of(arn) != account_of(&own.arn);
    let peer = peers.iter().find(|p| p.arn == arn);
    let mut rows = Vec::new();
    if let Some(p) = peer {
        rows.push(detail("메시지", format!("보이는 {}개 · 처리 중 {}개", p.visible, p.in_flight)));
    }
    if let Some(max) = dlq_of {
        rows.push(detail("maxReceiveCount", max.to_string()));
    }
    if cross {
        rows.push(detail("계정", format!("{} (다른 계정이라 읽지 않아요)", account_of(arn))));
    }
    FlowNode {
        kind: FlowNodeKind::Queue,
        id: arn.to_string(),
        label: name_of_arn(arn),
        state: None,
        allowed_by_policy: None,
        cross_account: cross,
        detail: rows,
        jump: if cross { None } else { peer.map(|p| p.url.clone()).or_else(|| url_from_arn(arn)).map(|url| SqsJump::Queue { url }) },
    }
}

fn links_of(nodes: &[FlowNode]) -> Vec<ProducerLink> {
    nodes
        .iter()
        .filter_map(|n| {
            let kind = match (n.kind, n.state.as_deref()) {
                (FlowNodeKind::Sns, Some("Confirmed")) => ProducerKind::Sns,
                (FlowNodeKind::Rule, Some("ENABLED")) => ProducerKind::Rule,
                _ => return None,
            };
            Some(ProducerLink { kind, label: n.label.clone(), allowed: n.allowed_by_policy })
        })
        .collect()
}

/// 큐 하나의 흐름. `peers`는 같은 리전의 마지막 목록(DLQ·원본 큐 노드의 수치용). `iam`은 `withIam`일 때만: 스냅숏을 읽은 결과
pub async fn read_flow(cfg: &SdkConfig, q: &SqsQueue, peers: &[SqsQueue], iam: Option<Result<Arc<Snapshot>, AppError>>) -> SqsFlow {
    let (sns, rules, pipes_in, pipes_out, lambdas, s3) = join!(sns_section(cfg, q), rules_section(cfg, q), pipes_from(cfg, &q.arn), pipes_to(cfg, &q.arn), lambda_reads(cfg, q), s3_section(cfg, q));
    let mut gaps: Vec<SqsGap> = Vec::new();

    if let Some(e) = &sns.error {
        gaps.push(gap("SNS 구독", e.clone()));
    }
    if let Some(e) = &rules.error {
        gaps.push(gap("EventBridge 규칙", e.clone()));
    }
    if let Some(e) = &s3.error {
        gaps.push(gap("S3 알림", e.clone()));
    }

    let mut producers: Vec<FlowNode> = Vec::new();
    producers.extend(sns.nodes);
    producers.extend(rules.nodes);
    let mut consumers: Vec<FlowNode> = Vec::new();

    let mut pipe_running = false;
    match pipes_in {
        Ok(list) => {
            pipe_running = list.iter().any(|p| pipe_active(&p.state));
            consumers.extend(list.iter().map(|p| pipe_node(p, vec![detail("대상", p.target.clone())])));
        }
        Err(e) => gaps.push(gap("Pipes", e.to_string())),
    }
    match pipes_out {
        Ok(list) => producers.extend(list.iter().map(|p| pipe_node(p, vec![detail("원본", p.source.clone())]))),
        Err(e) => {
            if !gaps.iter().any(|g| g.section == "Pipes") {
                gaps.push(gap("Pipes", e.to_string()));
            }
        }
    }

    let mut lambda_consumers: Vec<LambdaConsumer> = Vec::new();
    match lambdas {
        Ok(list) => {
            for l in &list {
                lambda_consumers.push(LambdaConsumer { name: last_segment(&l.esm.function_arn, ':'), timeout_secs: l.timeout, enabled: esm_active(&l.esm.state) });
            }
            if let Some(e) = list.iter().find_map(|l| l.error.as_ref()) {
                gaps.push(gap("Lambda", e.to_string()));
            }
            consumers.extend(list.iter().map(|l| lambda_node(q, l)));
        }
        Err(e) => gaps.push(gap("Lambda", e.to_string())),
    }

    // 연결 없이 정책만 허용하는 출처(SNS·EventBridge)와 S3
    let connected: HashSet<String> = producers.iter().map(|n| n.id.clone()).collect();
    let mut s3_nodes = s3.nodes;
    producers.extend(policy_only_nodes(q, &connected));
    producers.append(&mut s3_nodes);

    // IAM 주체
    let mut iam_receivers = None;
    if let Some(snapshot) = iam {
        match snapshot {
            Ok(s) => {
                let send = who_can(&s, "sqs:SendMessage", Some(&q.arn));
                let receive = who_can(&s, "sqs:ReceiveMessage", Some(&q.arn));
                let (irsa, pod_identity) = (needs_clusters(&s, &[&send, &receive]), needs_pod_identity(&s, &[&send, &receive]));
                let eks = if irsa || pod_identity { read_eks(cfg, irsa, pod_identity, &mut gaps).await } else { EksInfo::default() };
                let nodes = iam_nodes(&s, &send, &receive, &eks);
                iam_receivers = Some(nodes.receivers);
                for note in nodes.truncated {
                    gaps.push(gap("IAM", note));
                }
                producers.extend(nodes.producers);
                consumers.extend(nodes.consumers);
            }
            Err(e) => gaps.push(gap("IAM", e.to_string())),
        }
    }

    let links = links_of(&producers);
    let (kms, kms_error) = kms_access(cfg, q, &links).await;
    if let Some(e) = kms_error {
        gaps.push(gap("KMS 키 정책", e));
    }
    let findings = flow_findings(q, &FlowParts { lambdas: &lambda_consumers, pipe_running, iam_receivers, producers: &links, kms: &kms });

    let dlq = q.redrive.as_ref().map(|r| queue_node(&r.dlq_arn, peers, q, Some(r.max_receive_count)));
    let sources = q
        .sources
        .iter()
        .map(|arn| {
            let max = peers.iter().find(|p| p.arn == *arn).and_then(|p| p.redrive.as_ref()).map(|r| r.max_receive_count);
            queue_node(arn, peers, q, max)
        })
        .collect();

    SqsFlow { producers, consumers, dlq, sources, policy: q.policy.as_deref().map(policy::parse).unwrap_or_default(), findings, gaps, iam: iam_receivers.is_some() }
}

// ---------- 리전 흐름 ----------

fn region_queue_node(arn: &str, region: &str, account: &str, peers: &[SqsQueue]) -> FlowNode {
    let peer = peers.iter().find(|p| p.arn == arn);
    let cross = account_of(arn) != account || region_of_arn(arn) != region;
    FlowNode {
        kind: FlowNodeKind::Queue,
        id: arn.to_string(),
        label: name_of_arn(arn),
        state: None,
        allowed_by_policy: None,
        cross_account: account_of(arn) != account,
        detail: peer.map(|p| vec![detail("메시지", format!("보이는 {}개 · 처리 중 {}개", p.visible, p.in_flight))]).unwrap_or_default(),
        jump: if cross { None } else { peer.map(|p| SqsJump::Queue { url: p.url.clone() }).or_else(|| url_from_arn(arn).map(|url| SqsJump::Queue { url })) },
    }
}

struct RegionBuilder {
    nodes: Vec<FlowNode>,
    edges: Vec<FlowEdge>,
}

impl RegionBuilder {
    fn node(&mut self, n: FlowNode) {
        if !self.nodes.iter().any(|x| x.id == n.id) {
            self.nodes.push(n);
        }
    }
    fn edge(&mut self, from: &str, to: &str, kind: FlowEdgeKind) {
        if !self.edges.iter().any(|e| e.from == from && e.to == to && e.kind == kind) {
            self.edges.push(FlowEdge { from: from.into(), to: to.into(), kind });
        }
    }
}

/// 리전 전체의 SNS → SQS → Lambda/Pipes 흐름(IAM·EventBridge 규칙 제외). 노드 id는 ARN이다
pub async fn region_flow(cfg: &SdkConfig, region: &str, queues: &[SqsQueue]) -> SqsRegionFlow {
    let account = queues.iter().map(|q| account_of(&q.arn)).find(|a| !a.is_empty()).unwrap_or_default().to_string();
    let sns_client = aws_sdk_sns::Client::new(cfg);
    let lambda_client = aws_sdk_lambda::Client::new(cfg);
    let pipes_client = aws_sdk_pipes::Client::new(cfg);
    let (subs, esms, pipes) = join!(list_sqs_subscriptions(&sns_client), esms_in(&lambda_client, None), pipes_in(&pipes_client, None, None));
    let mut b = RegionBuilder { nodes: vec![], edges: vec![] };
    let mut gaps: Vec<SqsGap> = Vec::new();

    match subs {
        Ok(list) => {
            for (topic, endpoint) in list {
                let cross = account_of(&topic) != account;
                b.node(FlowNode {
                    kind: FlowNodeKind::Sns,
                    id: topic.clone(),
                    label: name_of_arn(&topic),
                    state: None,
                    allowed_by_policy: None,
                    cross_account: cross,
                    detail: vec![],
                    jump: (!cross).then(|| SqsJump::Resource { service: "sns".into(), type_id: "topics".into(), id: topic.clone() }),
                });
                b.node(region_queue_node(&endpoint, region, &account, queues));
                b.edge(&topic, &endpoint, FlowEdgeKind::Subscription);
            }
        }
        Err(e) => gaps.push(SqsGap { section: "SNS 구독".into(), error: e.to_string() }),
    }
    match esms {
        Ok(list) => {
            for m in list {
                if !m.source_arn.starts_with("arn:aws:sqs:") {
                    continue;
                }
                let source = m.source_arn.clone();
                let name = last_segment(&m.function_arn, ':');
                let cross = account_of(&m.function_arn) != account;
                b.node(region_queue_node(&source, region, &account, queues));
                b.node(FlowNode {
                    kind: FlowNodeKind::Lambda,
                    id: m.function_arn.clone(),
                    label: name.clone(),
                    state: Some(m.state.clone()),
                    allowed_by_policy: None,
                    cross_account: cross,
                    detail: vec![],
                    jump: (!cross).then(|| SqsJump::Resource { service: "lambda".into(), type_id: "functions".into(), id: name }),
                });
                b.edge(&source, &m.function_arn, FlowEdgeKind::Esm);
            }
        }
        Err(e) => gaps.push(SqsGap { section: "Lambda".into(), error: e.to_string() }),
    }
    match pipes {
        Ok(list) => {
            for p in list {
                let from_queue = p.source.starts_with("arn:aws:sqs:");
                let to_queue = p.target.starts_with("arn:aws:sqs:");
                if !from_queue && !to_queue {
                    continue;
                }
                b.node(pipe_node(&p, vec![]));
                if from_queue {
                    b.node(region_queue_node(&p.source, region, &account, queues));
                    b.edge(&p.source, &p.arn, FlowEdgeKind::Pipe);
                }
                if to_queue {
                    b.node(region_queue_node(&p.target, region, &account, queues));
                    b.edge(&p.arn, &p.target, FlowEdgeKind::Pipe);
                }
            }
        }
        Err(e) => gaps.push(SqsGap { section: "Pipes".into(), error: e.to_string() }),
    }
    for q in queues.iter().filter(|q| q.error.is_none()) {
        if let Some(r) = &q.redrive {
            b.node(region_queue_node(&q.arn, region, &account, queues));
            b.node(region_queue_node(&r.dlq_arn, region, &account, queues));
            b.edge(&q.arn, &r.dlq_arn, FlowEdgeKind::Dlq);
        }
    }
    SqsRegionFlow { nodes: b.nodes, edges: b.edges, gaps }
}

/// 리전의 SNS 구독 가운데 프로토콜이 sqs인 것: (토픽 ARN, 큐 ARN). `PendingConfirmation`은 건너뛴다
async fn list_sqs_subscriptions(client: &aws_sdk_sns::Client) -> Result<Vec<(String, String)>, AppError> {
    let mut out = Vec::new();
    let mut pages = client.list_subscriptions().into_paginator().send();
    while let Some(page) = pages.next().await {
        for s in page.map_err(|e| from_sdk(e, "sns:ListSubscriptions"))?.subscriptions() {
            if s.protocol() == Some("sqs") && s.subscription_arn() != Some("PendingConfirmation") {
                if let (Some(topic), Some(endpoint)) = (s.topic_arn(), s.endpoint()) {
                    out.push((topic.to_string(), endpoint.to_string()));
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
