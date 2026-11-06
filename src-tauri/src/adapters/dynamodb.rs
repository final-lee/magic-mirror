use async_trait::async_trait;
use aws_config::SdkConfig;
use aws_sdk_dynamodb::types::TableDescription;

use super::util::{degraded, dt, region, settle, unknown_type};
use super::ResourceAdapter;
use crate::dynamo::read::{describe_tables, list_table_names, parse_table};
use crate::dynamo::{BillingMode, DynamoTable, IndexKind, KeyAttr};
use crate::error::AppError;
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
                col("pk", "PK", Mono),
                col("sk", "SK", Mono),
                col("gsis", "GSIs", Text),
                col("billing", "Billing mode", Text),
                col("class", "Class", Text),
                col("stream", "Stream", Text),
                col("items", "Items", Text),
                col("size", "Size", Bytes),
            ],
        }]
    }

    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError> {
        if type_id != "tables" {
            return Err(unknown_type(type_id));
        }
        let client = aws_sdk_dynamodb::Client::new(cfg);
        let region = region(cfg);
        let names = list_table_names(&client).await?;
        let table_names = names.items.clone();
        let results = describe_tables(&client, names.items).await;
        let rows = results.into_iter().map(|r| r.map(|t| table(&t, &region))).collect();
        let items = settle(rows, |i, e| degraded(&table_names[i], &table_names[i], None, e))?;
        Ok(ListResult {
            items,
            truncated: names.truncated,
        })
    }
}

/// `PK`·`SK` 칸: `이름 (타입)`
fn key_label(k: &KeyAttr) -> String {
    if k.kind.is_empty() {
        k.name.clone()
    } else {
        format!("{} ({})", k.name, k.kind)
    }
}

fn table(t: &TableDescription, region: &str) -> Resource {
    let parsed = parse_table(t);
    let name = &parsed.name;
    let mut r = Resource::new(name, name)
        .arn(t.table_arn())
        .value("name", name)
        .value("status", &parsed.status)
        .value("pk", key_label(&parsed.keys.pk))
        .value("sk", parsed.keys.sk.as_ref().map(key_label).unwrap_or_default())
        .value("gsis", parsed.indexes.iter().filter(|i| i.kind == IndexKind::Gsi).count())
        .value("billing", billing_mode(&parsed))
        .value("class", &parsed.class)
        .value("stream", parsed.stream.as_ref().map(|s| s.view_type.as_str()).unwrap_or_default())
        .value("items", parsed.item_count)
        .value("size", parsed.size_bytes);
    // 칸으로 이미 보이는 것(키, GSI 수, 클래스, 스트림 종류)은 상세에 되풀이하지 않는다
    let names = |kind: IndexKind| parsed.indexes.iter().filter(|i| i.kind == kind).map(|i| i.name.as_str()).collect::<Vec<_>>().join(", ");
    r = r.field("Provisioned", provisioned_label(&parsed)).field("Global indexes", names(IndexKind::Gsi)).field("Local indexes", names(IndexKind::Lsi));
    if let Some(s) = &parsed.stream {
        r = r.field("Stream ARN", &s.arn);
    }
    r.field("Created", dt(t.creation_date_time()))
        .raw(t)
        .console(format!("https://{region}.console.aws.amazon.com/dynamodbv2/home?region={region}#table?name={name}"))
}

/// 목록 칸은 AWS가 쓰는 이름(`PAY_PER_REQUEST`·`PROVISIONED`) 그대로다
fn billing_mode(t: &DynamoTable) -> &'static str {
    match t.billing.mode {
        BillingMode::OnDemand => "PAY_PER_REQUEST",
        BillingMode::Provisioned => "PROVISIONED",
    }
}

/// 프로비저닝 테이블의 읽기·쓰기 용량. 온디맨드면 빈 글
fn provisioned_label(t: &DynamoTable) -> String {
    match (t.billing.mode, t.billing.read, t.billing.write) {
        (BillingMode::Provisioned, Some(r), Some(w)) => format!("{r} RCU / {w} WCU"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_dynamodb::types::{
        AttributeDefinition, BillingMode, BillingModeSummary, GlobalSecondaryIndexDescription,
        KeySchemaElement, KeyType, LocalSecondaryIndexDescription, ProvisionedThroughputDescription,
        ScalarAttributeType, StreamSpecification, StreamViewType, TableClass, TableClassSummary,
        TableStatus,
    };

    fn key(name: &str, kind: KeyType) -> KeySchemaElement {
        KeySchemaElement::builder()
            .attribute_name(name)
            .key_type(kind)
            .build()
            .unwrap()
    }

    fn attr(name: &str, kind: ScalarAttributeType) -> AttributeDefinition {
        AttributeDefinition::builder()
            .attribute_name(name)
            .attribute_type(kind)
            .build()
            .unwrap()
    }

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
            .attribute_definitions(attr("pk", ScalarAttributeType::S))
            .key_schema(key("pk", KeyType::Hash))
            .build();
        let r = table(&t, "ap-northeast-2");
        assert_eq!(r.values["status"], "ACTIVE");
        assert_eq!(r.values["items"], "120");
        assert_eq!(r.values["size"], "2048");
        assert_eq!(r.values["billing"], "PAY_PER_REQUEST");
        assert_eq!(r.values["pk"], "pk (S)");
        assert_eq!(r.values["sk"], "");
        assert_eq!(r.values["gsis"], "0");
        assert_eq!(r.values["class"], "STANDARD");
        assert_eq!(r.values["stream"], "");
    }

    #[test]
    fn billing_defaults_to_provisioned() {
        let t = TableDescription::builder().table_name("legacy").build();
        assert_eq!(table(&t, "us-east-1").values["billing"], "PROVISIONED");
    }

    #[test]
    fn keys_indexes_class_and_stream_get_their_own_columns_not_detail_rows() {
        let gsi = |name: &str| {
            GlobalSecondaryIndexDescription::builder()
                .index_name(name)
                .key_schema(key("gpk", KeyType::Hash))
                .build()
        };
        let t = TableDescription::builder()
            .table_name("events")
            .table_arn("arn:aws:dynamodb:ap-northeast-2:111111111111:table/events")
            .attribute_definitions(attr("pk", ScalarAttributeType::S))
            .attribute_definitions(attr("sk", ScalarAttributeType::N))
            .key_schema(key("pk", KeyType::Hash))
            .key_schema(key("sk", KeyType::Range))
            .global_secondary_indexes(gsi("by-user"))
            .global_secondary_indexes(gsi("by-day"))
            .local_secondary_indexes(
                LocalSecondaryIndexDescription::builder()
                    .index_name("by-sk")
                    .build(),
            )
            .provisioned_throughput(
                ProvisionedThroughputDescription::builder()
                    .read_capacity_units(5)
                    .write_capacity_units(7)
                    .build(),
            )
            .table_class_summary(
                TableClassSummary::builder()
                    .table_class(TableClass::StandardInfrequentAccess)
                    .build(),
            )
            .stream_specification(
                StreamSpecification::builder()
                    .stream_enabled(true)
                    .stream_view_type(StreamViewType::KeysOnly)
                    .build()
                    .unwrap(),
            )
            .latest_stream_arn("arn:stream")
            .build();
        let r = table(&t, "ap-northeast-2");
        assert_eq!(r.values["pk"], "pk (S)");
        assert_eq!(r.values["sk"], "sk (N)");
        // LSI는 GSI 수에 넣지 않는다
        assert_eq!(r.values["gsis"], "2");
        assert_eq!(r.values["class"], "STANDARD_INFREQUENT_ACCESS");
        assert_eq!(r.values["stream"], "KEYS_ONLY");
        let field = |label: &str| r.fields.iter().find(|f| f.label == label).map(|f| f.value.as_str());
        assert_eq!(field("Provisioned"), Some("5 RCU / 7 WCU"));
        assert_eq!(field("Global indexes"), Some("by-user, by-day"));
        assert_eq!(field("Local indexes"), Some("by-sk"));
        assert_eq!(field("Stream ARN"), Some("arn:stream"));
        // 칸으로 보이는 것은 상세에 되풀이하지 않는다
        for dup in ["Keys", "GSIs", "Class", "Stream"] {
            assert_eq!(field(dup), None, "{dup}");
        }
    }

    #[test]
    fn on_demand_tables_have_no_provisioned_row() {
        let t = TableDescription::builder()
            .table_name("t")
            .billing_mode_summary(
                BillingModeSummary::builder()
                    .billing_mode(BillingMode::PayPerRequest)
                    .build(),
            )
            .build();
        assert!(table(&t, "us-east-1")
            .fields
            .iter()
            .all(|f| f.label != "Provisioned"));
    }
}
