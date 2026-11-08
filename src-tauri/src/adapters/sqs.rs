use std::collections::HashMap;

use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_sqs::types::QueueAttributeName as A;

use super::util::{degraded, dt_millis, last_segment, region, unknown_type, url_encode};
use super::ResourceAdapter;
use crate::error::AppError;
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};
use crate::sqs::read::{encryption_label, human_duration, list_queues, name_of_arn};
use crate::sqs::SqsQueue;

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
                col("in_flight", "In flight", Text),
                col("delayed", "Delayed", Text),
                col("dlq", "DLQ", Text),
                col("retention", "Retention", Text),
                col("encryption", "Encryption", Text),
                col("url", "URL", Mono),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "queues" {
            return Err(unknown_type(type_id));
        }
        let region = region(cfg);
        let list = list_queues(cfg).await?;
        let items = list
            .items
            .into_iter()
            .map(|read| match read.failure {
                Some(e) => degraded(&read.queue.url, &read.queue.name, None, &e),
                None => resource(&read.queue, &read.attrs, &region),
            })
            .collect();
        Ok(ListResult {
            items,
            truncated: list.truncated,
        })
    }
}

#[cfg(test)]
fn queue(url: &str, attrs: &HashMap<A, String>, region: &str) -> Resource {
    resource(&crate::sqs::read::parse_queue(url, attrs), attrs, region)
}

fn resource(q: &SqsQueue, attrs: &HashMap<A, String>, region: &str) -> Resource {
    let url = &q.url;
    let name = last_segment(url, '/');
    Resource::new(url, &name)
        .arn(Some(q.arn.as_str()).filter(|a| !a.is_empty()))
        .value("name", &name)
        .value("type", if q.fifo { "FIFO" } else { "Standard" })
        .value("messages", q.visible)
        .value("in_flight", q.in_flight)
        .value("delayed", q.delayed)
        .value("dlq", q.redrive.as_ref().map(|r| name_of_arn(&r.dlq_arn)).unwrap_or_default())
        .value("retention", human_duration(q.retention))
        .value("encryption", encryption_label(q))
        .value("url", url)
        .field("Visibility timeout (s)", q.visibility_timeout)
        .field("Redrive policy", attrs.get(&A::RedrivePolicy).cloned().unwrap_or_default())
        .field("Created", dt_millis(q.created_at))
        .raw(attrs)
        .console(format!(
            "https://{region}.console.aws.amazon.com/sqs/v3/home?region={region}#/queues/{}",
            url_encode(url)
        ))
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
        let r = queue(
            "https://sqs.r.amazonaws.com/1/jobs.fifo",
            &attrs,
            "ap-northeast-2",
        );
        assert_eq!(r.name, "jobs.fifo");
        assert_eq!(r.values["type"], "FIFO");
        assert_eq!(r.values["messages"], "5");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:sqs:r:1:jobs.fifo"));
        assert!(r
            .fields
            .iter()
            .any(|f| f.label == "Created" && f.value == "1970-01-01T00:00:00Z"));
    }

    #[test]
    fn standard_queue_without_attrs() {
        let r = queue(
            "https://sqs.r.amazonaws.com/1/emails",
            &HashMap::new(),
            "us-east-1",
        );
        assert_eq!(r.values["type"], "Standard");
        assert_eq!(r.arn, None);
    }

    #[test]
    fn list_columns_come_from_the_same_attributes_as_the_workspace() {
        let attrs = HashMap::from([
            (A::QueueArn, "arn:aws:sqs:r:1:jobs".to_string()),
            (A::ApproximateNumberOfMessages, "3".to_string()),
            (A::ApproximateNumberOfMessagesNotVisible, "2".to_string()),
            (A::ApproximateNumberOfMessagesDelayed, "1".to_string()),
            (A::MessageRetentionPeriod, "129600".to_string()),
            (A::KmsMasterKeyId, "alias/app".to_string()),
            (A::SqsManagedSseEnabled, "false".to_string()),
            (
                A::RedrivePolicy,
                r#"{"deadLetterTargetArn":"arn:aws:sqs:r:1:jobs-dlq","maxReceiveCount":5}"#.to_string(),
            ),
        ]);
        let r = queue("https://sqs.r.amazonaws.com/1/jobs", &attrs, "r");
        assert_eq!(r.values["in_flight"], "2");
        assert_eq!(r.values["delayed"], "1");
        assert_eq!(r.values["dlq"], "jobs-dlq");
        assert_eq!(r.values["retention"], "1d 12h");
        assert_eq!(r.values["encryption"], "KMS");
        // 새 열과 겹치는 상세 필드는 없다
        assert!(!r.fields.iter().any(|f| f.label == "In flight" || f.label == "Retention (s)"));
    }
}
