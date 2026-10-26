use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_secretsmanager::types::SecretListEntry;

use super::util::{dt, region, s, unknown_type, url_encode, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

/// 메타데이터만 조회한다. GetSecretValue는 절대 호출하지 않는다.
pub struct SecretsManager;

#[async_trait]
impl ResourceAdapter for SecretsManager {
    fn service_id(&self) -> &'static str {
        "secretsmanager"
    }
    fn display_name(&self) -> &'static str {
        "Secrets Manager"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "secrets",
            name: "Secrets",
            columns: vec![
                col("name", "Name", Text),
                col("description", "Description", Text),
                col("lastChanged", "Last changed", Datetime),
                col("rotation", "Rotation", Text),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "secrets" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_secretsmanager::Client::new(cfg);
        let region = region(cfg);
        let mut out = Capped::new();
        let mut pages = client.list_secrets().into_paginator().send();
        'pages: while let Some(page) = pages.next().await {
            let page = page.map_err(|e| from_sdk(e, "secretsmanager:ListSecrets"))?;
            for sec in page.secret_list() {
                if !out.push(secret(sec, &region)) {
                    break 'pages;
                }
            }
        }
        Ok(out.finish())
    }
}

fn secret(sec: &SecretListEntry, region: &str) -> Resource {
    let name = s(sec.name());
    Resource::new(s(sec.arn()), &name)
        .arn(sec.arn())
        .value("name", &name)
        .value("description", s(sec.description()))
        .value("lastChanged", dt(sec.last_changed_date()))
        .value("rotation", if sec.rotation_enabled() == Some(true) { "Enabled" } else { "Disabled" })
        .field("Last accessed", dt(sec.last_accessed_date()))
        .field("Created", dt(sec.created_date()))
        .field("KMS key", s(sec.kms_key_id()))
        .tags(sec.tags().iter().map(|t| (t.key(), t.value())))
        .raw(sec)
        .console(format!(
            "https://{region}.console.aws.amazon.com/secretsmanager/secret?name={}&region={region}",
            url_encode(&name)
        ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_secretsmanager::types::Tag;

    #[test]
    fn secret_metadata_only() {
        let sec = SecretListEntry::builder()
            .name("prod/db/password")
            .arn("arn:aws:secretsmanager:r:1:secret:prod/db/password-abc")
            .rotation_enabled(true)
            .tags(Tag::builder().key("team").value("platform").build())
            .build();
        let r = secret(&sec, "ap-northeast-2");
        assert_eq!(r.name, "prod/db/password");
        assert_eq!(r.values["rotation"], "Enabled");
        assert_eq!(r.tags["team"], "platform");
        assert!(r.console_url.unwrap().contains("name=prod%2Fdb%2Fpassword"));
    }
}
