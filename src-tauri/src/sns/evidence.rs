//! 배달 진단에 쓰는 최근 지표, 로그, 키와 DLQ 증거.
use std::collections::{HashMap, HashSet};
use aws_config::SdkConfig;
use aws_smithy_types::{DateTime, error::metadata::ProvideErrorMetadata};
use serde::Serialize;
use crate::{adapters::util::map_concurrent, error::{AppError, from_sdk}};
use super::model::{SnsTarget, SnsTopic};

#[derive(Debug, Clone)]
pub struct KeyEvidence { pub arn: String, pub managed: bool, pub state: String, pub policy: Option<String>, pub error: Option<AppError> }
#[derive(Debug, Clone)]
pub struct QueueEvidence { pub arn: String, pub url: String, pub policy: Option<String>, pub kms_key: Option<String>, pub error: Option<AppError> }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryFailure { pub destination: String, pub status_code: Option<String>, pub response: Option<String>, pub timestamp: Option<String>, pub attempts: Option<u64> }
#[derive(Debug, Default, Clone)]
pub struct Evidence { pub keys: HashMap<String, KeyEvidence>, pub queues: HashMap<String, QueueEvidence>, pub metrics: HashMap<String, f64>, pub metric_error: Option<AppError>, pub failures: Vec<DeliveryFailure>, pub logs_missing: bool, pub log_error: Option<AppError> }

fn parse_failure(message: &str) -> Option<DeliveryFailure> {
    let v: serde_json::Value = serde_json::from_str(message).ok()?;
    let d = v.get("delivery")?;
    let status_code = d.get("statusCode").map(|v| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string()));
    Some(DeliveryFailure { destination: d.get("destination")?.as_str()?.into(), status_code, response: d.get("providerResponse").and_then(|v| v.as_str()).map(str::to_owned), timestamp: v.pointer("/notification/timestamp").and_then(|v| v.as_str()).map(str::to_owned), attempts: d.get("attempts").and_then(|v| v.as_u64()) })
}

async fn queue(cfg: &SdkConfig, arn: String, topic: &SnsTopic) -> QueueEvidence {
    let mut q = QueueEvidence { arn: arn.clone(), url: String::new(), policy: None, kms_key: None, error: None };
    let parts: Vec<_> = arn.splitn(6, ':').collect();
    if parts.len() != 6 || parts[2] != "sqs" || parts[3] != topic.region || parts[4] != topic.account {
        q.error = Some(AppError::other("현재 계정과 리전 밖의 DLQ는 읽지 않아요")); return q;
    }
    let client = aws_sdk_sqs::Client::new(cfg);
    match client.get_queue_url().queue_name(parts[5]).send().await {
        Err(e) => q.error = Some(from_sdk(e, "sqs:GetQueueUrl")),
        Ok(out) => {
            q.url = out.queue_url().unwrap_or_default().into();
            match client.get_queue_attributes().queue_url(&q.url).attribute_names(aws_sdk_sqs::types::QueueAttributeName::All).send().await {
                Err(e) => q.error = Some(from_sdk(e, "sqs:GetQueueAttributes")),
                Ok(out) => if let Some(attrs) = out.attributes() {
                    q.policy = attrs.get(&aws_sdk_sqs::types::QueueAttributeName::Policy).cloned();
                    q.kms_key = attrs.get(&aws_sdk_sqs::types::QueueAttributeName::KmsMasterKeyId).cloned();
                }
            }
        }
    }
    q
}
async fn key(cfg: &SdkConfig, id: String, topic: &SnsTopic) -> KeyEvidence {
    let client = aws_sdk_kms::Client::new(cfg);
    let mut result = KeyEvidence { arn: id.clone(), managed: id.contains("alias/aws/"), state: String::new(), policy: None, error: None };
    if id.starts_with("arn:") {
        let parts: Vec<_> = id.splitn(6, ':').collect();
        if parts.len() != 6 || parts[2] != "kms" || parts[3] != topic.region || parts[4] != topic.account {
            result.error = Some(AppError::other("현재 계정과 리전 밖의 키는 읽지 않아요"));
            return result;
        }
    }
    match client.describe_key().key_id(&id).send().await {
        Err(e) => result.error = Some(from_sdk(e, "kms:DescribeKey")),
        Ok(out) => if let Some(meta) = out.key_metadata() {
            result.arn = meta.arn().unwrap_or(&id).into();
            result.managed |= meta.key_manager().is_some_and(|v| v.as_str() == "AWS");
            result.state = meta.key_state().map(|v| v.as_str().to_owned()).unwrap_or_default();
            match client.get_key_policy().key_id(&result.arn).policy_name("default").send().await {
                Ok(out) => result.policy = out.policy().map(str::to_owned),
                Err(e) => result.error = Some(from_sdk(e, "kms:GetKeyPolicy")),
            }
        }
    }
    result
}

pub async fn fetch(cfg: &SdkConfig, topic: &SnsTopic) -> Evidence {
    let mut evidence = Evidence::default();
    let dlqs: HashSet<_> = topic.subscriptions.iter().filter_map(|s| s.dlq_arn.clone()).collect();
    let queues = map_concurrent(dlqs.into_iter().collect(), |arn| queue(cfg, arn, topic)).await;
    evidence.queues = queues.into_iter().map(|q| (q.arn.clone(), q)).collect();
    let mut keys = HashSet::new();
    if let Some(k) = &topic.overview.kms_key { keys.insert(k.clone()); }
    for s in &topic.subscriptions { if let Some(SnsTarget::Sqs { kms_key: Some(k), .. }) = &s.target { keys.insert(k.clone()); } }
    for q in evidence.queues.values() { if let Some(k) = &q.kms_key { keys.insert(k.clone()); } }
    let entries = map_concurrent(keys.into_iter().collect(), |id: String| async move { let value = key(cfg, id.clone(), topic).await; (id, value) }).await;
    evidence.keys = entries.into_iter().collect();
    let end = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |v| v.as_secs() as i64);
    let names = ["NumberOfNotificationsDelivered", "NumberOfNotificationsFailed", "NumberOfNotificationsFilteredOut-InvalidAttributes", "NumberOfNotificationsFilteredOut-InvalidMessageBody", "NumberOfNotificationsRedrivenToDlq", "NumberOfMessagesPublished"];
    use aws_sdk_cloudwatch::types::{Dimension, Metric, MetricDataQuery, MetricStat};
    let queries: Vec<_> = names.iter().enumerate().map(|(i, name)| {
        let metric = Metric::builder().namespace("AWS/SNS").metric_name(*name).dimensions(Dimension::builder().name("TopicName").value(&topic.name).build()).build();
        MetricDataQuery::builder().id(format!("m{i}")).metric_stat(MetricStat::builder().metric(metric).period(3600).stat("Sum").build()).return_data(true).build()
    }).collect();
    let client = aws_sdk_cloudwatch::Client::new(cfg);
    let mut token = None;
    loop {
        match client.get_metric_data().set_metric_data_queries(Some(queries.clone())).start_time(DateTime::from_secs(end - 3600)).end_time(DateTime::from_secs(end)).set_next_token(token.take()).send().await {
            Err(e) => { evidence.metric_error = Some(from_sdk(e, "cloudwatch:GetMetricData")); break; },
            Ok(out) => {
                for r in out.metric_data_results() {
                    if let Some(status) = r.status_code() {
                        let status = status.as_str();
                        if status != "Complete" && !(status == "PartialData" && out.next_token().is_some()) {
                            evidence.metric_error = Some(AppError::other(format!("지표를 모두 읽지 못했어요 ({status})")));
                        }
                    }
                    if let Some(i) = r.id().and_then(|s| s.strip_prefix('m')).and_then(|s| s.parse::<usize>().ok()) { if let Some(name) = names.get(i) { *evidence.metrics.entry((*name).into()).or_insert(0.0) += r.values().iter().sum::<f64>(); } }
                }
                token = out.next_token().map(str::to_owned); if token.is_none() { break; }
            }
        }
    }
    let group = format!("sns/{}/{}/{}/Failure", topic.region, topic.account, topic.name);
    let logs = aws_sdk_cloudwatchlogs::Client::new(cfg);
    let mut next = None;
    let mut seen = 0;
    loop {
        match logs.filter_log_events().log_group_name(&group).start_time((end - 3600) * 1000).end_time(end * 1000).limit(50 - seen).set_next_token(next.take()).send().await {
            Ok(out) => {
                seen += out.events().len() as i32;
                evidence.failures.extend(out.events().iter().filter_map(|e| e.message().and_then(parse_failure)));
                next = out.next_token().map(str::to_owned);
                if seen >= 50 || next.is_none() { break; }
            }
            Err(e) if e.code() == Some("ResourceNotFoundException") => { evidence.logs_missing = true; break; }
            Err(e) => { evidence.log_error = Some(from_sdk(e, "logs:FilterLogEvents")); break; }
        }
    }
    evidence
}

#[cfg(test)]
mod tests;
