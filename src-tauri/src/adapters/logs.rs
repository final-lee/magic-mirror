use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_cloudwatchlogs::types::LogGroup;

use super::util::{dt_millis, opt, region, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Logs;

#[async_trait]
impl ResourceAdapter for Logs {
    fn service_id(&self) -> &'static str {
        "logs"
    }
    fn display_name(&self) -> &'static str {
        "CloudWatch Logs"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "log-groups",
            name: "Log Groups",
            columns: vec![
                col("name", "Name", Text),
                col("retention", "Retention", Text),
                col("stored", "Stored bytes", Bytes),
                col("created", "Created", Datetime),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "log-groups" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_cloudwatchlogs::Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        let mut pages = client.describe_log_groups().into_paginator().send();
        'pages: while let Some(page) = pages.next().await {
            let page = page.map_err(|e| from_sdk(e, "logs:DescribeLogGroups"))?;
            for g in page.log_groups() {
                if !out.push(log_group(g, &region)) {
                    break 'pages;
                }
            }
        }
        Ok(out.finish())
    }
}

fn log_group(g: &LogGroup, region: &str) -> Resource {
    let name = s(g.log_group_name());
    let retention = g.retention_in_days().map(|d| format!("{d}일")).unwrap_or_else(|| "만료 없음".to_string());
    Resource::new(&name, &name)
        .arn(g.arn().map(|a| a.trim_end_matches(":*").to_string()))
        .value("name", &name)
        .value("retention", retention)
        .value("stored", opt(g.stored_bytes()))
        .value("created", dt_millis(g.creation_time()))
        .field("Class", s(g.log_group_class().map(|c| c.as_str())))
        .field("KMS key", s(g.kms_key_id()))
        .raw(g)
        .console(format!(
            "https://{region}.console.aws.amazon.com/cloudwatch/home?region={region}#logsV2:log-groups/log-group/{}",
            name.replace('/', "$252F")
        ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_group_resource() {
        let g = LogGroup::builder()
            .log_group_name("/aws/lambda/order-processor")
            .arn("arn:aws:logs:r:1:log-group:/aws/lambda/order-processor:*")
            .retention_in_days(14)
            .stored_bytes(4096)
            .creation_time(0)
            .build();
        let r = log_group(&g, "ap-northeast-2");
        assert_eq!(r.values["retention"], "14일");
        assert_eq!(r.values["stored"], "4096");
        assert_eq!(r.values["created"], "1970-01-01T00:00:00Z");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:logs:r:1:log-group:/aws/lambda/order-processor"));
        assert!(r.console_url.unwrap().ends_with("$252Faws$252Flambda$252Forder-processor"));
    }

    #[test]
    fn missing_retention_means_never_expire() {
        let g = LogGroup::builder().log_group_name("app").build();
        assert_eq!(log_group(&g, "us-east-1").values["retention"], "만료 없음");
    }
}
