use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_route53::types::HostedZone;

use super::util::{opt, s, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct Route53;

#[async_trait]
impl ResourceAdapter for Route53 {
    fn service_id(&self) -> &'static str {
        "route53"
    }
    fn display_name(&self) -> &'static str {
        "Route53"
    }
    fn is_global(&self) -> bool {
        true
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "hosted-zones",
            name: "Hosted Zones",
            columns: vec![
                col("name", "Name", Text),
                col("id", "Zone ID", Mono),
                col("private", "Private", Text),
                col("records", "Record count", Text),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "hosted-zones" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_route53::Client::new(cfg);
        let mut out = Capped::new();
        let mut pages = client.list_hosted_zones().into_paginator().send();
        'pages: while let Some(page) = pages.next().await {
            let page = page.map_err(|e| from_sdk(e, "route53:ListHostedZones"))?;
            for z in page.hosted_zones() {
                if !out.push(zone(z)) {
                    break 'pages;
                }
            }
        }
        Ok(out.finish())
    }
}

fn zone(z: &HostedZone) -> Resource {
    let id = z.id().trim_start_matches("/hostedzone/").to_string();
    let name = z.name().to_string();
    let private = z.config().map(|c| c.private_zone()).unwrap_or(false);
    Resource::new(&id, &name)
        .arn(Some(format!("arn:aws:route53:::hostedzone/{id}")))
        .value("name", &name)
        .value("id", &id)
        .value("private", if private { "Yes" } else { "No" })
        .value("records", opt(z.resource_record_set_count()))
        .field("Comment", s(z.config().and_then(|c| c.comment())))
        .raw(z)
        .console(format!("https://console.aws.amazon.com/route53/v2/hostedzones#ListRecordSets/{id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_route53::types::HostedZoneConfig;

    #[test]
    fn zone_strips_prefix() {
        let z = HostedZone::builder()
            .id("/hostedzone/Z123")
            .name("example.com.")
            .caller_reference("ref")
            .config(HostedZoneConfig::builder().private_zone(true).build())
            .resource_record_set_count(12)
            .build()
            .unwrap();
        let r = zone(&z);
        assert_eq!(r.id, "Z123");
        assert_eq!(r.values["private"], "Yes");
        assert_eq!(r.values["records"], "12");
        assert_eq!(r.arn.as_deref(), Some("arn:aws:route53:::hostedzone/Z123"));
    }
}
