//! 계정 개요 `📣 SNS`: 주제별 지난 24시간 지표, 고아·대기 구독, 점검 모음, 계정 지표.
//! 읽기만 한다(`sns:List*`·`sns:Get*`, `sqs:ListQueues`, `lambda:ListFunctions`, `cloudwatch:ListMetrics`·`GetMetricData`).
//! `GetMetricData`는 요청한 지표 1,000개에 $0.01이다. 주제당 4개씩 500개 단위로 묶어 한 번 읽고 화면이 자동으로 다시 읽지 않는다.

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};
use aws_config::SdkConfig;
use aws_sdk_cloudwatch::primitives::DateTime;
use aws_sdk_cloudwatch::types::{Dimension, Metric, MetricDataQuery, MetricStat};
use serde::Serialize;
use serde_json::Value;
use crate::adapters::util::map_concurrent;
use crate::error::{from_sdk, AppError};
use crate::model::MAX_ITEMS;
use super::fetch;
use super::findings::{self, CheckInfo, Dlq, Existence, OrphanReason, SnsFinding, SubFacts, TopicFacts, CHECKS};
use super::model::{SnsSubscriptionRow, TopicOverview};
use super::policy;

/// `GetMetricData` 한 번에 보낼 수 있는 쿼리 수의 상한
pub const MAX_QUERIES_PER_CALL: usize = 500;
/// 구독 속성(DLQ)을 읽는 구독 수의 상한. 넘으면 나머지는 DLQ를 판단하지 않는다.
const MAX_DLQ_LOOKUPS: usize = 400;
const WINDOW_SECS: i64 = 24 * 3600;
const PERIOD_SECS: i32 = 3600;
const MAX_METRIC_PAGES: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TopicMetric { Published, Delivered, Failed, FilteredOut }

impl TopicMetric {
    pub const ALL: [TopicMetric; 4] = [Self::Published, Self::Delivered, Self::Failed, Self::FilteredOut];
    pub fn name(self) -> &'static str {
        match self {
            Self::Published => "NumberOfMessagesPublished",
            Self::Delivered => "NumberOfNotificationsDelivered",
            Self::Failed => "NumberOfNotificationsFailed",
            Self::FilteredOut => "NumberOfNotificationsFilteredOut",
        }
    }
}

/// 지표 쿼리 하나: 어느 주제의 어느 지표인가
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuerySpec { pub id: String, pub topic: usize, pub metric: TopicMetric }

/// 주제마다 지표 4개씩 쿼리를 만들고 `MAX_QUERIES_PER_CALL`개 단위로 나눈다. 쿼리 ID는 소문자로 시작해야 한다.
pub fn plan_queries(topic_count: usize) -> Vec<Vec<QuerySpec>> {
    let all: Vec<QuerySpec> = (0..topic_count).flat_map(|topic| TopicMetric::ALL.into_iter().enumerate().map(move |(m, metric)| QuerySpec { id: format!("t{topic}m{m}"), topic, metric })).collect();
    all.chunks(MAX_QUERIES_PER_CALL).map(<[_]>::to_vec).collect()
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicTotals { pub published: f64, pub delivered: f64, pub failed: f64, pub filtered_out: f64 }

/// 한 번 읽은 결과(쿼리 ID → 값 합)를 주제별 합계에 더한다. 지표가 없던 쿼리는 값이 없으므로 0으로 남는다.
pub fn fold_totals(batch: &[QuerySpec], sums: &HashMap<String, f64>, totals: &mut [TopicTotals]) {
    for q in batch {
        let (Some(value), Some(total)) = (sums.get(&q.id), totals.get_mut(q.topic)) else { continue };
        match q.metric {
            TopicMetric::Published => total.published += value,
            TopicMetric::Delivered => total.delivered += value,
            TopicMetric::Failed => total.failed += value,
            TopicMetric::FilteredOut => total.filtered_out += value,
        }
    }
}

/// 계정 지표를 어떤 통계로 읽을지. 이번 달 지출은 누적이라 최댓값, 성공률은 평균, 나머지는 합이다.
pub fn account_stat(name: &str) -> &'static str {
    if name.ends_with("SuccessRate") { "Average" } else if name.starts_with("SMSMonthToDateSpentUSD") { "Maximum" } else { "Sum" }
}

/// 구독 속성의 `RedrivePolicy`로 DLQ 상태를 알아낸다.
pub fn dlq_state(attributes: &HashMap<String, String>) -> Dlq {
    let target = attributes.get("RedrivePolicy").and_then(|s| serde_json::from_str::<Value>(s).ok()).and_then(|v| v.get("deadLetterTargetArn").and_then(Value::as_str).map(str::to_owned));
    if target.is_some() { Dlq::Present } else { Dlq::Missing }
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// `GetMetricData`를 이어 읽으며 쿼리 ID별 값 합을 모은다.
async fn sums(client: &aws_sdk_cloudwatch::Client, queries: Vec<MetricDataQuery>, start: i64, end: i64) -> Result<HashMap<String, f64>, AppError> {
    let mut sums: HashMap<String, f64> = HashMap::new();
    let mut token: Option<String> = None;
    for _ in 0..MAX_METRIC_PAGES {
        let reply = client.get_metric_data().set_metric_data_queries(Some(queries.clone())).start_time(DateTime::from_secs(start)).end_time(DateTime::from_secs(end)).set_next_token(token.take()).send().await.map_err(|e| from_sdk(e, "cloudwatch:GetMetricData"))?;
        for result in reply.metric_data_results() {
            let Some(id) = result.id() else { continue };
            *sums.entry(id.to_string()).or_default() += result.values().iter().sum::<f64>();
        }
        token = reply.next_token().map(str::to_string);
        if token.is_none() { break; }
    }
    Ok(sums)
}

fn stat_query(id: String, metric: Metric, stat: &str) -> MetricDataQuery {
    MetricDataQuery::builder().id(id).metric_stat(MetricStat::builder().metric(metric).period(PERIOD_SECS).stat(stat).build()).return_data(true).build()
}

async fn topic_totals(client: &aws_sdk_cloudwatch::Client, names: &[String], start: i64, end: i64) -> Result<Vec<TopicTotals>, AppError> {
    let mut totals = vec![TopicTotals::default(); names.len()];
    for batch in plan_queries(names.len()) {
        let queries = batch.iter().map(|q| {
            let metric = Metric::builder().namespace("AWS/SNS").metric_name(q.metric.name()).dimensions(Dimension::builder().name("TopicName").value(&names[q.topic]).build()).build();
            stat_query(q.id.clone(), metric, "Sum")
        }).collect();
        fold_totals(&batch, &sums(client, queries, start, end).await?, &mut totals);
    }
    Ok(totals)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountMetric { pub name: String, pub stat: String, pub value: f64 }

/// 차원이 없는 `AWS/SNS` 지표(계정 단위). 있으면 지난 24시간 값을 돌려준다. SMS 지표는 SMS 화면에서 보여 준다.
async fn account_metrics(client: &aws_sdk_cloudwatch::Client, start: i64, end: i64) -> Result<Vec<AccountMetric>, AppError> {
    let mut pages = client.list_metrics().namespace("AWS/SNS").into_paginator().send();
    let mut names = std::collections::BTreeSet::new();
    for _ in 0..MAX_METRIC_PAGES {
        let Some(page) = pages.next().await else { break };
        for m in page.map_err(|e| from_sdk(e, "cloudwatch:ListMetrics"))?.metrics() {
            if m.dimensions().is_empty() {
                if let Some(name) = m.metric_name().filter(|n| !n.starts_with("SMS")) { names.insert(name.to_string()); }
            }
        }
    }
    let names: Vec<String> = names.into_iter().take(MAX_QUERIES_PER_CALL).collect();
    if names.is_empty() { return Ok(Vec::new()); }
    let queries = names.iter().enumerate().map(|(i, name)| stat_query(format!("a{i}"), Metric::builder().namespace("AWS/SNS").metric_name(name).build(), account_stat(name))).collect();
    let values = sums(client, queries, start, end).await?;
    Ok(names.into_iter().enumerate().filter_map(|(i, name)| values.get(&format!("a{i}")).map(|v| AccountMetric { stat: account_stat(&name).into(), name, value: *v })).collect())
}

/// 같은 프로필·리전의 큐 이름·함수 이름 목록. 쓰는 프로토콜만 읽고, 못 읽으면 그 점검은 건너뛰도록 `None`으로 둔다.
/// `topics`는 호출한 쪽이 채운다.
pub async fn existence(cfg: &SdkConfig, protocols: &[&str], topics: Option<HashSet<String>>) -> (Existence, Vec<AppError>) {
    let mut errors = Vec::new();
    let mut result = Existence { topics, queues: None, functions: None };
    if protocols.contains(&"sqs") {
        let mut names = HashSet::new();
        let mut pages = aws_sdk_sqs::Client::new(cfg).list_queues().into_paginator().send();
        let mut ok = true;
        while let Some(page) = pages.next().await {
            match page {
                Ok(page) => names.extend(page.queue_urls().iter().filter_map(|u| u.rsplit('/').next()).map(str::to_owned)),
                Err(e) => { errors.push(from_sdk(e, "sqs:ListQueues")); ok = false; break; }
            }
        }
        if ok { result.queues = Some(names); }
    }
    if protocols.contains(&"lambda") {
        let mut names = HashSet::new();
        let mut pages = aws_sdk_lambda::Client::new(cfg).list_functions().into_paginator().send();
        let mut ok = true;
        while let Some(page) = pages.next().await {
            match page {
                Ok(page) => names.extend(page.functions().iter().filter_map(|f| f.function_name()).map(str::to_owned)),
                Err(e) => { errors.push(from_sdk(e, "lambda:ListFunctions")); ok = false; break; }
            }
        }
        if ok { result.functions = Some(names); }
    }
    (result, errors)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountTopicRow {
    pub arn: String,
    pub name: String,
    pub fifo: bool,
    /// 확인됨 + 확인 대기
    pub subscriptions: u64,
    pub pending: u64,
    pub published: f64,
    pub delivered: f64,
    pub failed: f64,
    pub filtered_out: f64,
    /// 속성을 못 읽은 주제
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanSubscription { pub subscription_arn: Option<String>, pub topic_arn: String, pub protocol: String, pub endpoint: String, pub reason: OrphanReason }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSubscription { pub topic_arn: String, pub topic_name: String, pub protocol: String, pub endpoint: String }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsAccountOverview {
    pub account: String,
    pub region: String,
    /// 지표를 읽은 구간(epoch ms)
    pub start: i64,
    pub end: i64,
    /// 실패 많은 순
    pub topics: Vec<AccountTopicRow>,
    pub orphans: Vec<OrphanSubscription>,
    pub pending: Vec<PendingSubscription>,
    /// 모든 주제의 점검 결과. 끈 점검은 화면이 걸러 낸다.
    pub findings: Vec<SnsFinding>,
    pub checks: Vec<CheckInfo>,
    pub metrics: Vec<AccountMetric>,
    /// 지표를 읽었는가(못 읽으면 주제 표의 숫자는 비어 있는 값이다)
    pub metrics_available: bool,
    pub truncated: bool,
    pub errors: Vec<AppError>,
}

fn sub_facts(row: &SnsSubscriptionRow, dlq: &HashMap<String, Dlq>) -> SubFacts {
    SubFacts {
        arn: row.arn.clone(), protocol: row.protocol.clone(), endpoint: row.endpoint.clone(), confirmed: row.state == "confirmed", pending: row.state == "pending",
        dlq: row.arn.as_ref().and_then(|a| dlq.get(a)).copied().unwrap_or(Dlq::Unknown),
    }
}

/// 실패 많은 순, 같으면 발행 많은 순, 같으면 이름순
pub fn sort_rows(rows: &mut [AccountTopicRow]) {
    rows.sort_by(|a, b| b.failed.total_cmp(&a.failed).then(b.published.total_cmp(&a.published)).then(a.name.cmp(&b.name)));
}

fn fatal(e: &AppError) -> bool { matches!(e, AppError::SsoExpired | AppError::Throttled) }

pub async fn overview(cfg: &SdkConfig, account: &str, region: &str) -> Result<SnsAccountOverview, AppError> {
    let client = aws_sdk_sns::Client::new(cfg);
    let mut errors = Vec::new();

    let mut arns = Vec::new();
    let mut truncated = false;
    let mut pages = client.list_topics().into_paginator().send();
    'pages: while let Some(page) = pages.next().await {
        for t in page.map_err(|e| from_sdk(e, "sns:ListTopics"))?.topics() {
            if arns.len() >= MAX_ITEMS { truncated = true; break 'pages; }
            if let Some(arn) = t.topic_arn() { arns.push(arn.to_string()); }
        }
    }
    let topic_set: HashSet<String> = arns.iter().cloned().collect();

    let attributes = map_concurrent(arns.clone(), |arn| {
        let client = client.clone();
        async move { client.get_topic_attributes().topic_arn(&arn).send().await.map(|o| o.attributes().cloned().unwrap_or_default()).map_err(|e| from_sdk(e, "sns:GetTopicAttributes")) }
    }).await;
    if let Some(e) = attributes.iter().filter_map(|r| r.as_ref().err()).find(|e| fatal(e)) { return Err(e.clone()); }

    let rows = match fetch::subscriptions_all(cfg).await {
        Ok(rows) => rows,
        Err(e) if fatal(&e) => return Err(e),
        Err(e) => { errors.push(e); Vec::new() }
    };

    // DLQ는 구독 속성에만 있다: 이 계정 주제의 확인된 SQS·Lambda 구독만 읽는다.
    let lookups: Vec<String> = rows.iter().filter(|r| topic_set.contains(&r.topic_arn) && r.state == "confirmed" && matches!(r.protocol.as_str(), "sqs" | "lambda")).filter_map(|r| r.arn.clone()).collect();
    if lookups.len() > MAX_DLQ_LOOKUPS { truncated = true; }
    let looked: Vec<(String, Result<Dlq, AppError>)> = map_concurrent(lookups.into_iter().take(MAX_DLQ_LOOKUPS).collect(), |arn| {
        let client = client.clone();
        async move {
            let result = client.get_subscription_attributes().subscription_arn(&arn).send().await.map(|o| dlq_state(&o.attributes().cloned().unwrap_or_default())).map_err(|e| from_sdk(e, "sns:GetSubscriptionAttributes"));
            (arn, result)
        }
    }).await;
    let mut dlq = HashMap::new();
    for (arn, result) in looked {
        match result { Ok(state) => { dlq.insert(arn, state); } Err(e) if fatal(&e) => return Err(e), Err(e) => { if !errors.contains(&e) { errors.push(e); } } }
    }

    let protocols: Vec<&str> = rows.iter().map(|r| r.protocol.as_str()).collect();
    let (existence, existence_errors) = existence(cfg, &protocols, Some(topic_set.clone())).await;
    errors.extend(existence_errors);

    let mut table = Vec::new();
    let mut findings_all = Vec::new();
    for (arn, attrs) in arns.iter().zip(&attributes) {
        let name = findings::topic_name(arn).to_string();
        match attrs {
            Err(e) => table.push(AccountTopicRow { arn: arn.clone(), fifo: name.ends_with(".fifo"), name, subscriptions: 0, pending: 0, published: 0.0, delivered: 0.0, failed: 0.0, filtered_out: 0.0, error: Some(e.clone()) }),
            Ok(attrs) => {
                let overview = TopicOverview::from_attributes(attrs);
                let statements = attrs.get("Policy").filter(|p| !p.is_empty()).and_then(|p| policy::describe(p, account).ok()).unwrap_or_default();
                let facts = TopicFacts {
                    arn: arn.clone(), kms_key: overview.kms_key.clone(), signature_version: overview.signature_version,
                    logging_on: overview.delivery_logging.iter().any(|l| l.success_role.is_some() || l.failure_role.is_some()),
                    subscriptions: rows.iter().filter(|r| r.topic_arn == *arn).map(|r| sub_facts(r, &dlq)).collect(),
                };
                findings_all.extend(findings::topic_findings(&facts, &statements, None, account, region, &existence));
                table.push(AccountTopicRow { arn: arn.clone(), fifo: overview.fifo, name, subscriptions: overview.confirmed_count + overview.pending_count, pending: overview.pending_count, published: 0.0, delivered: 0.0, failed: 0.0, filtered_out: 0.0, error: None });
            }
        }
    }

    let orphans: Vec<OrphanSubscription> = rows.iter().filter_map(|r| {
        findings::orphan_reason(&r.topic_arn, &r.protocol, &r.endpoint, account, region, &existence).map(|reason| OrphanSubscription { subscription_arn: r.arn.clone(), topic_arn: r.topic_arn.clone(), protocol: r.protocol.clone(), endpoint: r.endpoint.clone(), reason })
    }).collect();
    let missing: Vec<(String, String)> = orphans.iter().filter(|o| o.reason == OrphanReason::TopicMissing).map(|o| (o.topic_arn.clone(), format!("{} · {}", o.protocol, o.endpoint))).collect();
    findings_all.extend(findings::missing_topic_findings(&missing));
    findings::sort(&mut findings_all);
    let pending: Vec<PendingSubscription> = rows.iter().filter(|r| r.state == "pending").map(|r| PendingSubscription { topic_arn: r.topic_arn.clone(), topic_name: findings::topic_name(&r.topic_arn).into(), protocol: r.protocol.clone(), endpoint: r.endpoint.clone() }).collect();

    let end = now_secs();
    let start = end - WINDOW_SECS;
    let cloudwatch = aws_sdk_cloudwatch::Client::new(cfg);
    let names: Vec<String> = table.iter().map(|t| t.name.clone()).collect();
    let mut metrics_available = true;
    match topic_totals(&cloudwatch, &names, start, end).await {
        Ok(totals) => for (row, t) in table.iter_mut().zip(totals) { row.published = t.published; row.delivered = t.delivered; row.failed = t.failed; row.filtered_out = t.filtered_out; },
        Err(e) if fatal(&e) => return Err(e),
        Err(e) => { errors.push(e); metrics_available = false; }
    }
    let metrics = match account_metrics(&cloudwatch, start, end).await {
        Ok(m) => m,
        Err(e) if fatal(&e) => return Err(e),
        Err(e) => { if !errors.contains(&e) { errors.push(e); } Vec::new() }
    };
    sort_rows(&mut table);

    Ok(SnsAccountOverview { account: account.into(), region: region.into(), start: start * 1000, end: end * 1000, topics: table, orphans, pending, findings: findings_all, checks: CHECKS.to_vec(), metrics, metrics_available, truncated, errors })
}

#[cfg(test)]
mod tests;
