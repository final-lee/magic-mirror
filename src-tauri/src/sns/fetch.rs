use super::model::{SnsSubscription, SnsSubscriptionRow, SnsTarget, SnsTopic, TopicOverview};
use crate::adapters::util::map_concurrent;
use crate::error::{from_sdk, AppError};
use aws_config::SdkConfig;
use aws_smithy_types::error::metadata::ProvideErrorMetadata;
use std::collections::HashMap;

fn row(s: &aws_sdk_sns::types::Subscription) -> SnsSubscriptionRow {
    let raw = s.subscription_arn().unwrap_or_default();
    let pending = raw == "PendingConfirmation";
    let arn = (!raw.is_empty() && !pending && raw != "Deleted").then(|| raw.to_string());
    let state = if pending {
        "pending"
    } else if arn.is_some() {
        "confirmed"
    } else {
        "unknown"
    };
    SnsSubscriptionRow {
        arn,
        topic_arn: s.topic_arn().unwrap_or_default().into(),
        protocol: s.protocol().unwrap_or_default().into(),
        endpoint: s.endpoint().unwrap_or_default().into(),
        state: state.into(),
    }
}

pub async fn subscriptions_all(cfg: &SdkConfig) -> Result<Vec<SnsSubscriptionRow>, AppError> {
    let client = aws_sdk_sns::Client::new(cfg);
    let mut pages = client.list_subscriptions().into_paginator().send();
    let mut rows = Vec::new();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "sns:ListSubscriptions"))?;
        rows.extend(page.subscriptions().iter().map(row));
    }
    Ok(rows)
}

async fn resolve(
    cfg: &SdkConfig,
    sub: &SnsSubscription,
    account: &str,
    region: &str,
) -> Option<SnsTarget> {
    let parts: Vec<_> = sub.endpoint.splitn(6, ':').collect();
    if parts.len() != 6 || parts[0] != "arn" || parts[3] != region || parts[4] != account {
        return None;
    }
    match (sub.protocol.as_str(), parts[2]) {
        ("sqs", "sqs") => {
            let client = aws_sdk_sqs::Client::new(cfg);
            let arn = sub.endpoint.clone();
            let url_result = client.get_queue_url().queue_name(parts[5]).send().await;
            let (url, attrs, error) = match url_result {
                Err(e) => (
                    String::new(),
                    HashMap::new(),
                    Some(from_sdk(e, "sqs:GetQueueUrl")),
                ),
                Ok(out) => {
                    let url = out.queue_url().unwrap_or_default().to_string();
                    match client
                        .get_queue_attributes()
                        .queue_url(&url)
                        .attribute_names(aws_sdk_sqs::types::QueueAttributeName::All)
                        .send()
                        .await
                    {
                        Ok(out) => (url, out.attributes().cloned().unwrap_or_default(), None),
                        Err(e) => (
                            url,
                            HashMap::new(),
                            Some(from_sdk(e, "sqs:GetQueueAttributes")),
                        ),
                    }
                }
            };
            let get = |key: aws_sdk_sqs::types::QueueAttributeName| attrs.get(&key).cloned();
            Some(SnsTarget::Sqs {
                arn,
                url,
                fifo: get(aws_sdk_sqs::types::QueueAttributeName::FifoQueue).as_deref()
                    == Some("true"),
                kms_key: get(aws_sdk_sqs::types::QueueAttributeName::KmsMasterKeyId),
                policy: get(aws_sdk_sqs::types::QueueAttributeName::Policy),
                redrive_policy: get(aws_sdk_sqs::types::QueueAttributeName::RedrivePolicy),
                error,
            })
        }
        ("lambda", "lambda") => {
            let client = aws_sdk_lambda::Client::new(cfg);
            let arn = sub.endpoint.clone();
            let config_error = client
                .get_function_configuration()
                .function_name(&arn)
                .send()
                .await
                .err()
                .map(|e| from_sdk(e, "lambda:GetFunctionConfiguration"));
            let (policy, policy_error) = match client.get_policy().function_name(&arn).send().await
            {
                Ok(out) => (out.policy().map(str::to_owned), None),
                Err(e) if e.code() == Some("ResourceNotFoundException") => (None, None),
                Err(e) => (None, Some(from_sdk(e, "lambda:GetPolicy"))),
            };
            Some(SnsTarget::Lambda {
                arn,
                policy,
                error: config_error.or(policy_error),
            })
        }
        _ => None,
    }
}

pub async fn topic(
    cfg: &SdkConfig,
    arn: &str,
    account: &str,
    region: &str,
) -> Result<SnsTopic, AppError> {
    let parts: Vec<_> = arn.splitn(6, ':').collect();
    if parts.len() != 6 || parts[2] != "sns" || parts[3] != region || parts[4] != account {
        return Err(AppError::other("현재 계정과 리전의 주제만 열 수 있어요"));
    }
    let client = aws_sdk_sns::Client::new(cfg);
    let attrs = client
        .get_topic_attributes()
        .topic_arn(arn)
        .send()
        .await
        .map_err(|e| from_sdk(e, "sns:GetTopicAttributes"))?
        .attributes()
        .cloned()
        .unwrap_or_default();
    let mut errors = Vec::new();
    let mut rows = Vec::new();
    let mut pages = client
        .list_subscriptions_by_topic()
        .topic_arn(arn)
        .into_paginator()
        .send();
    while let Some(page) = pages.next().await {
        match page {
            Ok(page) => rows.extend(page.subscriptions().iter().map(row)),
            Err(e) => {
                errors.push(from_sdk(e, "sns:ListSubscriptionsByTopic"));
                break;
            }
        }
    }
    let subscriptions = map_concurrent(rows, |r| {
        let client = client.clone();
        let cfg = cfg.clone();
        let account = account.to_owned();
        let region = region.to_owned();
        async move {
            let (attributes, error) = if let Some(arn) = &r.arn {
                match client
                    .get_subscription_attributes()
                    .subscription_arn(arn)
                    .send()
                    .await
                {
                    Ok(out) => (out.attributes().cloned().unwrap_or_default(), None),
                    Err(e) => (
                        HashMap::new(),
                        Some(from_sdk(e, "sns:GetSubscriptionAttributes")),
                    ),
                }
            } else {
                (HashMap::new(), None)
            };
            let mut sub = SnsSubscription::from_row(r, attributes, error);
            sub.target = resolve(&cfg, &sub, &account, &region).await;
            sub
        }
    })
    .await;
    let tags = match client
        .list_tags_for_resource()
        .resource_arn(arn)
        .send()
        .await
    {
        Ok(out) => out
            .tags()
            .iter()
            .map(|t| (t.key().to_string(), t.value().to_string()))
            .collect(),
        Err(e) => {
            errors.push(from_sdk(e, "sns:ListTagsForResource"));
            HashMap::new()
        }
    };
    let data_protection_policy = match client
        .get_data_protection_policy()
        .resource_arn(arn)
        .send()
        .await
    {
        Ok(out) => out
            .data_protection_policy()
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        Err(e) => {
            errors.push(from_sdk(e, "sns:GetDataProtectionPolicy"));
            None
        }
    };
    let overview = TopicOverview::from_attributes(&attrs);
    Ok(SnsTopic {
        arn: arn.into(),
        name: parts[5].into(),
        region: region.into(),
        account: account.into(),
        fifo: overview.fifo,
        attributes: attrs,
        overview,
        subscriptions,
        tags,
        data_protection_policy,
        errors,
    })
}
