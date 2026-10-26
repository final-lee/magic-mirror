use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_dynamodb::types::TableDescription;

use super::util::{degraded, dt, map_concurrent, opt, region, s, settle, unknown_type, Capped};
use super::ResourceAdapter;
use crate::error::{from_sdk, AppError};
use crate::model::{col, ColumnKind::*, ListResult, Resource, ResourceType};

pub struct DynamoDb;

#[async_trait]
impl ResourceAdapter for DynamoDb {
    fn service_id(&self) -> &'static str {
        "dynamodb"
    }
    fn display_name(&self) -> &'static str {
        "DynamoDB"
    }
    fn resource_types(&self) -> Vec<ResourceType> {
        vec![ResourceType {
            id: "tables",
            name: "Tables",
            columns: vec![
                col("name", "Name", Text),
                col("status", "Status", State),
                col("items", "Items", Text),
                col("size", "Size", Bytes),
                col("billing", "Billing mode", Text),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "tables" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_dynamodb::Client::new(cfg);
        let region = region(cfg);
        let mut names = Capped::new();
        let mut pages = client.list_tables().into_paginator().send();
        'pages: while let Some(page) = pages.next().await {
            let page = page.map_err(|e| from_sdk(e, "dynamodb:ListTables"))?;
            for n in page.table_names() {
                if !names.push(n.clone()) {
                    break 'pages;
                }
            }
        }
        let table_names = names.items.clone();
        let results = map_concurrent(names.items, |name| {
            let client = client.clone();
            let region = region.clone();
            async move {
                client
                    .describe_table()
                    .table_name(name)
                    .send()
                    .await
                    .map(|out| out.table().map(|t| table(t, &region)))
                    .map_err(|e| from_sdk(e, "dynamodb:DescribeTable"))
            }
        })
        .await;
        let items = settle(results, |i, e| {
            Some(degraded(&table_names[i], &table_names[i], None, e))
        })?
        .into_iter()
        .flatten()
        .collect();
        Ok(ListResult {
            items,
            truncated: names.truncated,
        })
    }
}

fn table(t: &TableDescription, region: &str) -> Resource {
    let name = s(t.table_name());
    let billing = t
        .billing_mode_summary()
        .and_then(|b| b.billing_mode())
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "PROVISIONED".to_string());
    let keys = t
        .key_schema()
        .iter()
        .map(|k| format!("{} ({})", k.attribute_name(), k.key_type().as_str()))
        .collect::<Vec<_>>()
        .join(", ");
    Resource::new(&name, &name)
        .arn(t.table_arn())
        .value("name", &name)
        .value("status", s(t.table_status().map(|st| st.as_str())))
        .value("items", opt(t.item_count()))
        .value("size", opt(t.table_size_bytes()))
        .value("billing", billing)
        .field("Keys", keys)
        .field("GSIs", t.global_secondary_indexes().len())
        .field("Created", dt(t.creation_date_time()))
        .raw(t)
        .console(format!("https://{region}.console.aws.amazon.com/dynamodbv2/home?region={region}#table?name={name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_dynamodb::types::{
        BillingMode, BillingModeSummary, KeySchemaElement, KeyType, TableStatus,
    };

    #[test]
    fn table_resource() {
        let t = TableDescription::builder()
            .table_name("orders")
            .table_status(TableStatus::Active)
            .item_count(120)
            .table_size_bytes(2048)
            .billing_mode_summary(
                BillingModeSummary::builder()
                    .billing_mode(BillingMode::PayPerRequest)
                    .build(),
            )
            .key_schema(
                KeySchemaElement::builder()
                    .attribute_name("pk")
                    .key_type(KeyType::Hash)
                    .build()
                    .unwrap(),
            )
            .build();
        let r = table(&t, "ap-northeast-2");
        assert_eq!(r.values["status"], "ACTIVE");
        assert_eq!(r.values["items"], "120");
        assert_eq!(r.values["size"], "2048");
        assert_eq!(r.values["billing"], "PAY_PER_REQUEST");
        assert!(r
            .fields
            .iter()
            .any(|f| f.label == "Keys" && f.value == "pk (HASH)"));
    }

    #[test]
    fn billing_defaults_to_provisioned() {
        let t = TableDescription::builder().table_name("legacy").build();
        assert_eq!(table(&t, "us-east-1").values["billing"], "PROVISIONED");
    }
}
