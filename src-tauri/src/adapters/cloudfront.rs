use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_cloudfront::types::DistributionSummary;

use super::util::{dt, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct CloudFront;

#[async_trait]
impl ResourceAdapter for CloudFront {
    fn service_id(&self) -> &'static str {
        "cloudfront"
    }
    fn display_name(&self) -> &'static str {
        "CloudFront"
    }
    fn is_global(&self) -> bool {
        true
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "distributions",
            name: "Distributions",
            columns: vec![
                col("id", "ID", Mono),
                col("domain", "Domain", Mono),
                col("aliases", "Aliases", Text),
                col("status", "Status", State),
                col("enabled", "Enabled", Text),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "distributions" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_cloudfront::Client::new(cfg);
        let mut out = Capped::new();
        let mut marker: Option<String> = None;
        'pages: loop {
            let res = client
                .list_distributions()
                .set_marker(marker.clone())
                .send()
                .await
                .map_err(|e| from_sdk(e, "cloudfront:ListDistributions"))?;
            let Some(list) = res.distribution_list() else { break };
            for d in list.items() {
                if !out.push(distribution(d)) {
                    break 'pages;
                }
            }
            match (list.is_truncated(), list.next_marker()) {
                (true, Some(next)) => marker = Some(next.to_string()),
                _ => break,
            }
        }
        Ok(out.finish())
    }
}

fn distribution(d: &DistributionSummary) -> Resource {
    let aliases: Vec<&str> = d.aliases().map(|a| a.items().iter().map(String::as_str).collect()).unwrap_or_default();
    let name = aliases.first().copied().unwrap_or(d.domain_name()).to_string();
    let id = d.id().to_string();
    Resource::new(&id, &name)
        .arn(Some(d.arn()))
        .value("id", &id)
        .value("domain", d.domain_name())
        .value("aliases", aliases.join(", "))
        .value("status", d.status())
        .value("enabled", if d.enabled() { "Yes" } else { "No" })
        .field("Comment", d.comment())
        .field("Price class", d.price_class().as_str())
        .field(
            "Origins",
            d.origins().map(|o| o.items().iter().map(|x| x.domain_name()).collect::<Vec<_>>().join(", ")).unwrap_or_default(),
        )
        .field("Last modified", dt(Some(d.last_modified_time())))
        .raw(d)
        .console(format!("https://console.aws.amazon.com/cloudfront/v4/home#/distributions/{id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_cloudfront::types::Aliases;

    #[test]
    fn distribution_name_prefers_alias() {
        let d = DistributionSummary::builder()
            .id("E1")
            .arn("arn:aws:cloudfront::1:distribution/E1")
            .domain_name("d1.cloudfront.net")
            .status("Deployed")
            .enabled(true)
            .last_modified_time(aws_smithy_types::DateTime::from_secs(0))
            .comment("")
            .price_class(aws_sdk_cloudfront::types::PriceClass::PriceClassAll)
            .web_acl_id("")
            .http_version(aws_sdk_cloudfront::types::HttpVersion::Http2)
            .is_ipv6_enabled(false)
            .staging(false)
            .aliases(Aliases::builder().quantity(1).items("cdn.example.com").build().unwrap())
            .build();
        // 필수 필드가 많아 build()가 Result를 돌려주면 .unwrap()을 붙이고, 누락된 필수 필드는
        // 기본값(빈 문자열/false/DateTime::from_secs(0) 등)으로 채운다.
        let r = distribution(&d.unwrap());
        assert_eq!(r.name, "cdn.example.com");
        assert_eq!(r.values["enabled"], "Yes");
        assert_eq!(r.values["status"], "Deployed");
    }
}
