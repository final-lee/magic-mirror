use std::collections::HashMap;

use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_sqs::types::QueueAttributeName as A;

use super::util::{dt_millis, last_segment, map_concurrent, region, unknown_type, url_encode, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Sqs;

#[async_trait]
impl ResourceAdapter for Sqs {
    fn service_id(&self) -> &'static str {
        "sqs"
    }
    fn display_name(&self) -> &'static str {
        "SQS"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "queues",
            name: "Queues",
            columns: vec![
                col("name", "Name", Text),
                col("type", "Type", Text),
                col("messages", "Messages", Text),
                col("url", "URL", Mono),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "queues" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_sqs::Client::new(cfg);
        let region = region(cfg);
        let mut urls = Capped::new();
        let mut pages = client.list_queues().into_paginator().send();
        'pages: while let Some(page) = pages.next().await {
            let page = page.map_err(|e| from_sdk(e, "sqs:ListQueues"))?;
            for u in page.queue_urls() {
                if !urls.push(u.clone()) {
                    break 'pages;
                }
            }
        }
        let results = map_concurrent(urls.items.clone(), |url| {
            let client = client.clone();
            async move { client.get_queue_attributes().queue_url(url).attribute_names(A::All).send().await }
        })
        .await;
        let mut items = Vec::new();
        for (url, res) in urls.items.iter().zip(results) {
            let res = res.map_err(|e| from_sdk(e, "sqs:GetQueueAttributes"))?;
            let empty = HashMap::new();
            items.push(queue(url, res.attributes().unwrap_or(&empty), &region));
        }
        Ok(ListResult { items, truncated: urls.truncated })
    }
}

fn queue(url: &str, attrs: &HashMap<A, String>, region: &str) -> Resource {
    let name = last_segment(url, '/');
    let get = |k: A| attrs.get(&k).cloned().unwrap_or_default();
    let created = get(A::CreatedTimestamp).parse::<i64>().ok().map(|secs| secs * 1000);
    Resource::new(url, &name)
        .arn(Some(get(A::QueueArn)).filter(|a| !a.is_empty()))
        .value("name", &name)
        .value("type", if name.ends_with(".fifo") { "FIFO" } else { "Standard" })
        .value("messages", get(A::ApproximateNumberOfMessages))
        .value("url", url)
        .field("In flight", get(A::ApproximateNumberOfMessagesNotVisible))
        .field("Visibility timeout (s)", get(A::VisibilityTimeout))
        .field("Retention (s)", get(A::MessageRetentionPeriod))
        .field("Redrive policy", get(A::RedrivePolicy))
        .field("Created", dt_millis(created))
        .raw(attrs)
        .console(format!("https://{region}.console.aws.amazon.com/sqs/v3/home?region={region}#/queues/{}", url_encode(url)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_from_attributes() {
        let attrs = HashMap::from([
            (A::QueueArn, "arn:aws:sqs:r:1:jobs.fifo".to_string()),
            (A::ApproximateNumberOfMessages, "5".to_string()),
            (A::CreatedTimestamp, "0".to_string()),
        ]);
        let r = queue("https://sqs.r.amazonaws.com/1/jobs.fifo", &attrs, "ap-northeast-2");
        assert_eq!(r.name, "jobs.fifo");
        assert_eq!(r.values["type"], "FIFO");
        assert_eq!(r.values["messages"], "5");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:sqs:r:1:jobs.fifo"));
        assert!(r.fields.iter().any(|f| f.label == "Created" && f.value == "1970-01-01T00:00:00Z"));
    }

    #[test]
    fn standard_queue_without_attrs() {
        let r = queue("https://sqs.r.amazonaws.com/1/emails", &HashMap::new(), "us-east-1");
        assert_eq!(r.values["type"], "Standard");
        assert_eq!(r.arn, None);
    }
}
