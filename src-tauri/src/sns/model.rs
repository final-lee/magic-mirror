use crate::error::AppError;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsTopic {
    pub arn: String,
    pub name: String,
    pub region: String,
    pub account: String,
    pub fifo: bool,
    pub attributes: HashMap<String, String>,
    pub overview: TopicOverview,
    pub subscriptions: Vec<SnsSubscription>,
    pub tags: HashMap<String, String>,
    pub data_protection_policy: Option<String>,
    pub errors: Vec<AppError>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicOverview {
    pub kms_key: Option<String>,
    pub aws_managed_key: bool,
    pub fifo: bool,
    pub content_based_deduplication: bool,
    pub fifo_throughput_scope: Option<String>,
    pub archive_retention_days: Option<u64>,
    pub beginning_archive_time: Option<String>,
    pub signature_version: u32,
    pub tracing: Option<String>,
    pub delivery_logging: Vec<DeliveryLogging>,
    pub http_delivery_policy: Vec<HttpDeliveryRow>,
    pub display_name: Option<String>,
    pub confirmed_count: u64,
    pub pending_count: u64,
    pub deleted_count: u64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryLogging {
    pub protocol: String,
    pub success_role: Option<String>,
    pub failure_role: Option<String>,
    pub sample_rate: Option<u32>,
}
#[derive(Debug, Clone, Serialize)]
pub struct HttpDeliveryRow {
    pub key: String,
    pub value: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsFilter {
    pub policy: Value,
    pub scope: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsSubscription {
    pub key: String,
    pub arn: Option<String>,
    pub protocol: String,
    pub endpoint: String,
    pub state: String,
    pub filter: Option<SnsFilter>,
    pub raw: bool,
    pub dlq_arn: Option<String>,
    pub target: Option<SnsTarget>,
    pub summary: Option<String>,
    pub filter_errors: Vec<super::filter::PolicyError>,
    pub attributes: HashMap<String, String>,
    pub error: Option<AppError>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SnsTarget {
    Sqs {
        arn: String,
        url: String,
        fifo: bool,
        kms_key: Option<String>,
        policy: Option<String>,
        redrive_policy: Option<String>,
        error: Option<AppError>,
    },
    Lambda {
        arn: String,
        policy: Option<String>,
        error: Option<AppError>,
    },
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsSubscriptionRow {
    pub arn: Option<String>,
    pub topic_arn: String,
    pub protocol: String,
    pub endpoint: String,
    pub state: String,
}

impl SnsSubscriptionRow {
    pub fn key(&self) -> String {
        use sha2::{Digest, Sha256};
        if let Some(arn) = &self.arn {
            return arn.clone();
        }
        let mut hash = Sha256::new();
        hash.update(self.protocol.as_bytes());
        hash.update(b":");
        hash.update(self.endpoint.as_bytes());
        let digest = hash.finalize();
        use std::fmt::Write;
        let mut key = String::with_capacity(self.topic_arn.len() + 21);
        key.push_str(&self.topic_arn);
        key.push_str("#pending#");
        for b in &digest[..6] {
            write!(key, "{b:02x}").expect("문자열 쓰기 실패");
        }
        key
    }
}

impl TopicOverview {
    pub fn from_attributes(a: &HashMap<String, String>) -> Self {
        let get = |key: &str| a.get(key).filter(|s| !s.is_empty()).cloned();
        let number = |key: &str| a.get(key).and_then(|s| s.parse().ok()).unwrap_or(0);
        let kms_key = get("KmsMasterKeyId");
        let aws_managed_key = kms_key
            .as_deref()
            .is_some_and(|k| k == "alias/aws/sns" || k.ends_with(":alias/aws/sns"));
        let delivery_logging = ["Lambda", "SQS", "HTTP", "Application", "Firehose"]
            .into_iter()
            .map(|p| DeliveryLogging {
                protocol: p.into(),
                success_role: get(&format!("{p}SuccessFeedbackRoleArn")),
                failure_role: get(&format!("{p}FailureFeedbackRoleArn")),
                sample_rate: get(&format!("{p}SuccessFeedbackSampleRate"))
                    .and_then(|s| s.parse().ok()),
            })
            .collect();
        let archive_retention_days = get("ArchivePolicy")
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("MessageRetentionPeriod").and_then(Value::as_u64));
        let mut http_delivery_policy = Vec::new();
        if let Some(v) =
            get("EffectiveDeliveryPolicy").and_then(|s| serde_json::from_str::<Value>(&s).ok())
        {
            fn flatten(prefix: &str, value: &Value, out: &mut Vec<HttpDeliveryRow>) {
                if let Value::Object(map) = value {
                    for (k, v) in map {
                        let key = if prefix.is_empty() {
                            k.clone()
                        } else {
                            format!("{prefix}.{k}")
                        };
                        flatten(&key, v, out);
                    }
                } else {
                    out.push(HttpDeliveryRow {
                        key: prefix.into(),
                        value: value
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| value.to_string()),
                    });
                }
            }
            flatten("", &v, &mut http_delivery_policy);
        }
        Self {
            kms_key,
            aws_managed_key,
            fifo: a.get("FifoTopic").is_some_and(|s| s == "true"),
            content_based_deduplication: a
                .get("ContentBasedDeduplication")
                .is_some_and(|s| s == "true"),
            fifo_throughput_scope: get("FifoThroughputScope"),
            archive_retention_days,
            beginning_archive_time: get("BeginningArchiveTime"),
            signature_version: get("SignatureVersion")
                .and_then(|s| s.parse().ok())
                .unwrap_or(1),
            tracing: get("TracingConfig"),
            delivery_logging,
            http_delivery_policy,
            display_name: get("DisplayName"),
            confirmed_count: number("SubscriptionsConfirmed"),
            pending_count: number("SubscriptionsPending"),
            deleted_count: number("SubscriptionsDeleted"),
        }
    }
}
impl SnsSubscription {
    pub fn from_row(
        row: SnsSubscriptionRow,
        attributes: HashMap<String, String>,
        error: Option<AppError>,
    ) -> Self {
        let filter = attributes
            .get("FilterPolicy")
            .and_then(|s| serde_json::from_str(s).ok())
            .map(|policy| SnsFilter {
                policy,
                scope: attributes
                    .get("FilterPolicyScope")
                    .cloned()
                    .unwrap_or_else(|| "MessageAttributes".into()),
            });
        let scope = if attributes
            .get("FilterPolicyScope")
            .is_some_and(|s| s == "MessageBody")
        {
            super::filter::Scope::MessageBody
        } else {
            super::filter::Scope::MessageAttributes
        };
        let (summary, filter_errors) = match attributes.get("FilterPolicy") {
            None => (None, Vec::new()),
            Some(raw) => match super::filter::parse_policy(raw) {
                Ok(policy) => (
                    Some(super::filter::summarize(&policy, scope)),
                    super::filter::validate(&policy, scope),
                ),
                Err(error) => (None, vec![error]),
            },
        };
        let dlq_arn = attributes
            .get("RedrivePolicy")
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .and_then(|v| {
                v.get("deadLetterTargetArn")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        let raw = attributes
            .get("RawMessageDelivery")
            .is_some_and(|v| v == "true");
        let key = row.key();
        Self {
            key,
            arn: row.arn,
            protocol: row.protocol,
            endpoint: row.endpoint,
            state: row.state,
            filter,
            summary,
            filter_errors,
            raw,
            dlq_arn,
            target: None,
            attributes,
            error,
        }
    }
}
#[cfg(test)]
mod tests;
