use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_ecr::types::Repository;

use super::util::{dt, region, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Ecr;

#[async_trait]
impl ResourceAdapter for Ecr {
    fn service_id(&self) -> &'static str {
        "ecr"
    }
    fn display_name(&self) -> &'static str {
        "ECR"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "repositories",
            name: "Repositories",
            columns: vec![
                col("name", "Name", Text),
                col("uri", "URI", Mono),
                col("created", "Created", Datetime),
                col("scanOnPush", "Scan on push", Text),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "repositories" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_ecr::Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        let mut pages = client.describe_repositories().into_paginator().send();
        'pages: while let Some(page) = pages.next().await {
            let page = page.map_err(|e| from_sdk(e, "ecr:DescribeRepositories"))?;
            for r in page.repositories() {
                if !out.push(repository(r, &region)) {
                    break 'pages;
                }
            }
        }
        Ok(out.finish())
    }
}

fn repository(r: &Repository, region: &str) -> Resource {
    let name = s(r.repository_name());
    let account = s(r.registry_id());
    let scan = r.image_scanning_configuration().map(|c| c.scan_on_push()).unwrap_or(false);
    Resource::new(&name, &name)
        .arn(r.repository_arn())
        .value("name", &name)
        .value("uri", s(r.repository_uri()))
        .value("created", dt(r.created_at()))
        .value("scanOnPush", if scan { "Yes" } else { "No" })
        .field("Tag mutability", s(r.image_tag_mutability().map(|m| m.as_str())))
        .field("Encryption", s(r.encryption_configuration().map(|e| e.encryption_type().as_str())))
        .raw(r)
        .console(format!("https://{region}.console.aws.amazon.com/ecr/repositories/private/{account}/{name}?region={region}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_ecr::types::ImageScanningConfiguration;

    #[test]
    fn repository_resource() {
        let r = Repository::builder()
            .repository_name("api")
            .repository_uri("1.dkr.ecr.r.amazonaws.com/api")
            .registry_id("1")
            .image_scanning_configuration(ImageScanningConfiguration::builder().scan_on_push(true).build())
            .build();
        let res = repository(&r, "ap-northeast-2");
        assert_eq!(res.values["scanOnPush"], "Yes");
        assert_eq!(res.values["uri"], "1.dkr.ecr.r.amazonaws.com/api");
        assert!(res.console_url.unwrap().contains("/private/1/api"));
    }
}
