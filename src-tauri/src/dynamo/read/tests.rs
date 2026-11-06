use aws_sdk_dynamodb::types::{
    AttributeDefinition, BillingMode as SdkBilling, BillingModeSummary, GlobalSecondaryIndexDescription, IndexStatus, KeySchemaElement, KeyType, LocalSecondaryIndexDescription, Projection as SdkProjection,
    ProjectionType, ProvisionedThroughputDescription, ReplicaDescription, ReplicaStatus, ScalarAttributeType, SseDescription, SseType, StreamSpecification, StreamViewType, TableClass, TableClassSummary,
    TableStatus,
};

use super::*;

fn key(name: &str, kind: KeyType) -> KeySchemaElement {
    KeySchemaElement::builder().attribute_name(name).key_type(kind).build().unwrap()
}

fn attr(name: &str, kind: ScalarAttributeType) -> AttributeDefinition {
    AttributeDefinition::builder().attribute_name(name).attribute_type(kind).build().unwrap()
}

fn throughput(read: i64, write: i64) -> ProvisionedThroughputDescription {
    ProvisionedThroughputDescription::builder().read_capacity_units(read).write_capacity_units(write).build()
}

fn base() -> aws_sdk_dynamodb::types::builders::TableDescriptionBuilder {
    TableDescription::builder()
        .table_name("orders")
        .table_arn("arn:aws:dynamodb:ap-northeast-2:111111111111:table/orders")
        .table_status(TableStatus::Active)
        .attribute_definitions(attr("pk", ScalarAttributeType::S))
        .attribute_definitions(attr("sk", ScalarAttributeType::N))
        .attribute_definitions(attr("gpk", ScalarAttributeType::S))
        .key_schema(key("pk", KeyType::Hash))
        .key_schema(key("sk", KeyType::Range))
        .item_count(120)
        .table_size_bytes(2048)
}

#[test]
fn keys_come_from_the_schema_with_types_from_the_attribute_definitions() {
    let t = parse_table(&base().build());
    assert_eq!(t.keys.pk, KeyAttr { name: "pk".into(), kind: "S".into() });
    assert_eq!(t.keys.sk, Some(KeyAttr { name: "sk".into(), kind: "N".into() }));
    assert_eq!(t.attribute_types["gpk"], "S");
    assert_eq!((t.item_count, t.size_bytes, t.status.as_str()), (120, 2048, "ACTIVE"));
}

#[test]
fn a_hash_only_table_has_no_sort_key_and_the_schema_order_does_not_matter() {
    let t = parse_table(&TableDescription::builder().attribute_definitions(attr("id", ScalarAttributeType::S)).key_schema(key("id", KeyType::Hash)).build());
    assert_eq!((t.keys.pk.name.as_str(), t.keys.sk.as_ref()), ("id", None));
    let reversed = parse_table(&TableDescription::builder().key_schema(key("sk", KeyType::Range)).key_schema(key("pk", KeyType::Hash)).build());
    assert_eq!(reversed.keys.pk.name, "pk");
    assert_eq!(reversed.keys.sk.map(|k| k.name), Some("sk".to_string()));
}

#[test]
fn billing_is_provisioned_unless_the_summary_says_pay_per_request() {
    let provisioned = parse_table(&base().provisioned_throughput(throughput(5, 7)).build());
    assert_eq!(provisioned.billing, Billing { mode: BillingMode::Provisioned, read: Some(5), write: Some(7) });
    let on_demand = parse_table(&base().billing_mode_summary(BillingModeSummary::builder().billing_mode(SdkBilling::PayPerRequest).build()).provisioned_throughput(throughput(0, 0)).build());
    assert_eq!(on_demand.billing, Billing { mode: BillingMode::OnDemand, read: None, write: None });
    let explicit = parse_table(&base().billing_mode_summary(BillingModeSummary::builder().billing_mode(SdkBilling::Provisioned).build()).provisioned_throughput(throughput(1, 2)).build());
    assert_eq!(explicit.billing.mode, BillingMode::Provisioned);
}

#[test]
fn indexes_carry_keys_projection_state_and_provisioned_capacity() {
    let gsi = GlobalSecondaryIndexDescription::builder()
        .index_name("by-user")
        .key_schema(key("gpk", KeyType::Hash))
        .key_schema(key("sk", KeyType::Range))
        .projection(SdkProjection::builder().projection_type(ProjectionType::Include).non_key_attributes("email").non_key_attributes("name").build())
        .index_status(IndexStatus::Creating)
        .backfilling(true)
        .provisioned_throughput(throughput(3, 4))
        .item_count(9)
        .index_size_bytes(90)
        .build();
    let lsi = LocalSecondaryIndexDescription::builder().index_name("by-sk").key_schema(key("pk", KeyType::Hash)).key_schema(key("sk", KeyType::Range)).item_count(2).index_size_bytes(20).build();
    let t = parse_table(&base().provisioned_throughput(throughput(5, 5)).global_secondary_indexes(gsi).local_secondary_indexes(lsi).build());
    assert_eq!(t.indexes.len(), 2);
    let g = &t.indexes[0];
    assert_eq!((g.kind, g.name.as_str(), g.status.as_str(), g.backfilling), (IndexKind::Gsi, "by-user", "CREATING", true));
    assert_eq!((g.read, g.write, g.item_count, g.size_bytes), (Some(3), Some(4), 9, 90));
    assert_eq!(g.pk, KeyAttr { name: "gpk".into(), kind: "S".into() });
    assert_eq!(g.projection, Projection { kind: "INCLUDE".into(), attrs: vec!["email".into(), "name".into()] });
    let l = &t.indexes[1];
    assert_eq!((l.kind, l.status.as_str(), l.read, l.sk.as_ref().map(|k| k.kind.as_str())), (IndexKind::Lsi, "ACTIVE", None, Some("N")));
}

#[test]
fn an_on_demand_index_has_no_provisioned_capacity() {
    let gsi = GlobalSecondaryIndexDescription::builder().index_name("g").key_schema(key("gpk", KeyType::Hash)).provisioned_throughput(throughput(0, 0)).build();
    let t = parse_table(&base().billing_mode_summary(BillingModeSummary::builder().billing_mode(SdkBilling::PayPerRequest).build()).global_secondary_indexes(gsi).build());
    assert_eq!((t.indexes[0].read, t.indexes[0].write), (None, None));
    // 프로젝션이 없으면 ALL로 본다
    assert_eq!(t.indexes[0].projection.kind, "ALL");
}

#[test]
fn settings_default_to_standard_class_owned_key_and_no_stream() {
    let t = parse_table(&base().build());
    assert_eq!((t.class.as_str(), t.sse.kind.as_str(), t.deletion_protection), ("STANDARD", "OWNED", false));
    assert!(t.stream.is_none() && t.replicas.is_empty());
    assert_eq!((t.ttl.as_ref(), t.pitr.as_ref(), t.scaling.as_ref(), t.contributor_insights.as_ref(), t.resource_policy), (None, None, None, None, None));
}

#[test]
fn class_stream_encryption_protection_and_replicas_are_read() {
    let t = parse_table(
        &base()
            .table_class_summary(TableClassSummary::builder().table_class(TableClass::StandardInfrequentAccess).build())
            .stream_specification(StreamSpecification::builder().stream_enabled(true).stream_view_type(StreamViewType::NewAndOldImages).build().unwrap())
            .latest_stream_arn("arn:aws:dynamodb:ap-northeast-2:111111111111:table/orders/stream/2026-11-06T00:00:00.000")
            .sse_description(SseDescription::builder().sse_type(SseType::Kms).kms_master_key_arn("arn:aws:kms:ap-northeast-2:111111111111:key/abc").build())
            .deletion_protection_enabled(true)
            .replicas(ReplicaDescription::builder().region_name("us-east-1").replica_status(ReplicaStatus::Active).build())
            .replicas(ReplicaDescription::builder().region_name("eu-west-1").replica_status(ReplicaStatus::Updating).replica_table_class_summary(TableClassSummary::builder().table_class(TableClass::Standard).build()).build())
            .build(),
    );
    assert_eq!(t.class, "STANDARD_INFREQUENT_ACCESS");
    assert_eq!(t.stream, Some(StreamSpec { arn: "arn:aws:dynamodb:ap-northeast-2:111111111111:table/orders/stream/2026-11-06T00:00:00.000".into(), view_type: "NEW_AND_OLD_IMAGES".into() }));
    assert_eq!(t.sse, Sse { kind: "KMS".into(), kms_key: Some("arn:aws:kms:ap-northeast-2:111111111111:key/abc".into()) });
    assert!(t.deletion_protection);
    assert_eq!(t.replicas.len(), 2);
    assert_eq!((t.replicas[1].region.as_str(), t.replicas[1].status.as_str(), t.replicas[1].class.as_deref()), ("eu-west-1", "UPDATING", Some("STANDARD")));
}

#[test]
fn a_disabled_stream_is_not_reported_even_if_a_stale_arn_remains() {
    let t = parse_table(&base().stream_specification(StreamSpecification::builder().stream_enabled(false).build().unwrap()).latest_stream_arn("arn:old").build());
    assert!(t.stream.is_none());
}

#[test]
fn a_table_that_could_not_be_read_keeps_its_name_and_the_reason() {
    let t = failed_table("secret", &AppError::AccessDenied { action: "dynamodb:DescribeTable".into() });
    assert_eq!(t.name, "secret");
    assert_eq!(t.error.as_deref(), Some("권한 없음 (dynamodb:DescribeTable)"));
    assert!(t.findings.is_empty());
}

fn denied() -> AppError {
    AppError::AccessDenied { action: "dynamodb:DescribeTable".into() }
}

fn described(name: &str) -> Result<TableDescription, AppError> {
    Ok(TableDescription::builder().table_name(name).build())
}

#[test]
fn one_unreadable_table_does_not_hide_the_others() {
    let names = vec!["a".to_string(), "b".to_string(), "c".to_string()];
    let tables = settle_tables(&names, vec![described("a"), Err(denied()), described("c")]).unwrap();
    assert_eq!(tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["a", "b", "c"]);
    assert_eq!(tables.iter().map(|t| t.error.is_some()).collect::<Vec<_>>(), vec![false, true, false]);
}

#[test]
fn when_every_table_fails_or_the_session_expired_the_whole_read_fails() {
    let names = vec!["a".to_string(), "b".to_string()];
    assert_eq!(settle_tables(&names, vec![Err(denied()), Err(denied())]).unwrap_err(), denied());
    assert_eq!(settle_tables(&names, vec![described("a"), Err(AppError::SsoExpired)]).unwrap_err(), AppError::SsoExpired);
    assert!(settle_tables(&[], vec![]).unwrap().is_empty());
}

#[test]
fn gaps_are_one_per_section_with_a_count_and_never_hide_an_expired_session() {
    let mut gaps = Gaps::default();
    assert_eq!(gaps.take("ttl", Ok(1)), Some(1));
    assert_eq!(gaps.take::<i32>("ttl", Err(denied())), None);
    gaps.take::<i32>("ttl", Err(denied()));
    gaps.take::<i32>("ttl", Err(denied()));
    gaps.take::<i32>("metrics", Err(AppError::other("느려요")));
    let list = gaps.finish().unwrap();
    assert_eq!(list, vec![Gap { section: "ttl".into(), error: "권한 없음 (dynamodb:DescribeTable) (외 2곳)".into() }, Gap { section: "metrics".into(), error: "느려요".into() }]);

    let mut gaps = Gaps::default();
    gaps.take::<i32>("pitr", Err(AppError::SsoExpired));
    assert_eq!(gaps.finish().unwrap_err(), AppError::SsoExpired);
}

#[test]
fn resource_ids_name_the_table_and_optionally_a_gsi() {
    assert_eq!(parse_resource_id("table/orders"), Some(("orders", None)));
    assert_eq!(parse_resource_id("table/orders/index/by-user"), Some(("orders", Some("by-user"))));
    assert_eq!(parse_resource_id("table/orders/index"), None);
    assert_eq!(parse_resource_id("table/orders/index/g/extra"), None);
    assert_eq!(parse_resource_id("function/orders"), None);
    assert_eq!(parse_resource_id("table"), None);
}

#[test]
fn scaling_groups_by_table_and_attaches_the_target_tracking_value() {
    let t = |id: &str, dim: &str, min, max| RawScalable { resource_id: id.into(), dimension: dim.into(), min, max };
    let targets = [
        t("table/orders", "dynamodb:table:ReadCapacityUnits", 5, 100),
        t("table/orders", "dynamodb:table:WriteCapacityUnits", 5, 50),
        t("table/orders/index/by-user", "dynamodb:index:ReadCapacityUnits", 1, 10),
        t("table/logs", "dynamodb:table:WriteCapacityUnits", 1, 2),
        t("table/orders", "dynamodb:table:Surprise", 1, 2),
        t("ecs/service", "ecs:service:DesiredCount", 1, 2),
    ];
    let policies = [
        RawPolicy { resource_id: "table/orders".into(), dimension: "dynamodb:table:ReadCapacityUnits".into(), target_value: 70.0 },
        RawPolicy { resource_id: "table/orders/index/by-user".into(), dimension: "dynamodb:index:WriteCapacityUnits".into(), target_value: 50.0 },
    ];
    let scaling = build_scaling(&targets, &policies);
    assert_eq!(scaling.len(), 2);
    let orders = &scaling["orders"];
    assert_eq!(orders.len(), 3);
    assert_eq!(orders[0], ScalingTarget { index: None, dimension: Dimension::Read, min: 5, max: 100, target_utilization: Some(70.0) });
    assert_eq!(orders[1].target_utilization, None);
    assert_eq!((orders[2].index.as_deref(), orders[2].dimension, orders[2].target_utilization), (Some("by-user"), Dimension::Read, None));
    assert_eq!(scaling["logs"][0].dimension, Dimension::Write);
}

#[test]
fn diagnosis_skips_rules_whose_inputs_were_not_read() {
    let mut tables = vec![parse_table(&base().provisioned_throughput(throughput(5, 5)).deletion_protection_enabled(true).build())];
    tables[0].pitr = Some(Pitr { status: "ENABLED".into(), days: Some(35) });
    // 오토스케일링을 읽지 못했으면 "없음"이라고 하지 않는다
    diagnose(&mut tables, None, None);
    assert!(tables[0].scaling.is_none() && tables[0].findings.is_empty());
    // 읽었는데 대상이 없으면 지적한다
    diagnose(&mut tables, Some(HashMap::new()), None);
    assert_eq!(tables[0].scaling, Some(vec![]));
    assert_eq!(tables[0].findings.iter().map(|f| f.id).collect::<Vec<_>>(), vec![crate::dynamo::FindingId::NoAutoScaling]);
}

#[test]
fn rule_names_say_which_report_they_are() {
    assert_eq!(classify_rule("DynamoDBContributorInsights-PKC-orders-1700000000"), Some((TopKeyKind::Accessed, false)));
    assert_eq!(classify_rule("DynamoDBContributorInsights-SKC-orders-1700000000"), Some((TopKeyKind::Accessed, true)));
    assert_eq!(classify_rule("DynamoDBContributorInsights-PKT-orders-1700000000"), Some((TopKeyKind::Throttled, false)));
    assert_eq!(classify_rule("DynamoDBContributorInsights-SKT-orders-1700000000"), Some((TopKeyKind::Throttled, true)));
    // 테이블 이름에 코드가 들어 있어도 앞의 코드만 본다
    assert_eq!(classify_rule("DynamoDBContributorInsights-PKC-SKT-1"), Some((TopKeyKind::Accessed, false)));
    assert_eq!(classify_rule("DynamoDBContributorInsights-XYZ-orders-1"), None);
    assert_eq!(classify_rule("SomeOtherRule-PKC-orders"), None);
}
