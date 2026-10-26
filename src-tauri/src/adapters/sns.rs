use std::collections::HashMap;

use async_trait::async_trait;
use aws_config::SdkConfig;

use super::util::{degraded, last_segment, map_concurrent, region, settle, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Sns;

#[async_trait]
impl ResourceAdapter for Sns {
    fn service_id(&self) -> &'static str {
        "sns"
    }
    fn display_name(&self) -> &'static str {
        "SNS"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "topics",
            name: "Topics",
            columns: vec![
                col("name", "Name", Text),
                col("arn", "ARN", Mono),
                col("subscriptions", "Subscriptions", Text),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "topics" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_sns::Client::new(cfg);
        let region = region(cfg);
        let mut arns = Capped::new();
        let mut pages = client.list_topics().into_paginator().send();
        'pages: while let Some(page) = pages.next().await {
            let page = page.map_err(|e| from_sdk(e, "sns:ListTopics"))?;
            for t in page.topics() {
                if let Some(arn) = t.topic_arn() {
                    if !arns.push(arn.to_string()) {
                        break 'pages;
                    }
                }
            }
        }
        let results = map_concurrent(arns.items.clone(), |arn| {
            let client = client.clone();
            let region = region.clone();
            async move {
                client
                    .get_topic_attributes()
                    .topic_arn(&arn)
                    .send()
                    .await
                    .map(|res| {
                        topic(
                            &arn,
                            &res.attributes().cloned().unwrap_or_default(),
                            &region,
                        )
                    })
                    .map_err(|e| from_sdk(e, "sns:GetTopicAttributes"))
            }
        })
        .await;
        let items = settle(results, |i, e| {
            let arn = &arns.items[i];
            degraded(arn, &last_segment(arn, ':'), Some(arn), e)
        })?;
        Ok(ListResult {
            items,
            truncated: arns.truncated,
        })
    }
}

fn topic(arn: &str, attrs: &HashMap<String, String>, region: &str) -> Resource {
    let name = last_segment(arn, ':');
    let get = |k: &str| attrs.get(k).cloned().unwrap_or_default();
    Resource::new(arn, &name)
        .arn(Some(arn))
        .value("name", &name)
        .value("arn", arn)
        .value("subscriptions", get("SubscriptionsConfirmed"))
        .field("Pending subscriptions", get("SubscriptionsPending"))
        .field("Display name", get("DisplayName"))
        .field("Owner", get("Owner"))
        .field("FIFO", get("FifoTopic"))
        .raw(attrs)
        .console(format!(
            "https://{region}.console.aws.amazon.com/sns/v3/home?region={region}#/topic/{arn}"
        ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_from_attributes() {
        let attrs = HashMap::from([("SubscriptionsConfirmed".to_string(), "3".to_string())]);
        let r = topic(
            "arn:aws:sns:ap-northeast-2:1:alerts",
            &attrs,
            "ap-northeast-2",
        );
        assert_eq!(r.name, "alerts");
        assert_eq!(r.values["subscriptions"], "3");
        assert!(r
            .console_url
            .unwrap()
            .ends_with("#/topic/arn:aws:sns:ap-northeast-2:1:alerts"));
    }
}
