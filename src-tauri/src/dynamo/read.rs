//! 테이블 읽기와 해석. 리소스 목록 어댑터(`adapters::dynamodb`)와 DynamoDB 탭이 같은 해석 함수(`parse_table`)를 쓴다.
//! 읽기만 한다: `dynamodb:ListTables`·`DescribeTable`·`DescribeTimeToLive`·`DescribeContinuousBackups`·`DescribeContributorInsights`·`GetResourcePolicy`,
//! `application-autoscaling:DescribeScalableTargets`·`DescribeScalingPolicies`, `cloudwatch:GetMetricData`·`GetInsightRuleReport`.

use std::collections::HashMap;

use aws_config::SdkConfig;
use aws_sdk_applicationautoscaling::types::{PolicyType, ServiceNamespace};
use aws_sdk_cloudwatch::primitives::DateTime;
use aws_sdk_dynamodb::types::{ContributorInsightsStatus, KeyType, TableDescription};

use super::health::{health, HealthInput};
use super::metrics::{self, Target};
use super::{
    Billing, BillingMode, Dimension, DynamoOverview, DynamoTable, Gap, Index, IndexKind, KeyAttr, Keys, Pitr, Projection, Replica, ScalingTarget, Sse, StreamSpec, TableMetrics, TopKeyEntry, TopKeyGroup,
    TopKeyKind, TopKeys, Ttl,
};
use crate::adapters::util::{map_concurrent, settle, Capped};
use crate::error::{from_sdk, AppError};
use crate::iam::clock::now_secs;

pub const CONTRIBUTOR_INSIGHTS_OFF: &str = "Contributor Insights가 꺼져 있어요";
/// 상위 키를 읽는 구간(초)과 개수
const TOP_KEYS_WINDOW_SECS: i64 = 3_600;
const TOP_KEYS_COUNT: i32 = 10;

// 테이블 해석 ----------------------------------------------------------------------------------

fn key_attr(name: &str, types: &HashMap<&str, &str>) -> KeyAttr {
    KeyAttr { name: name.to_string(), kind: types.get(name).copied().unwrap_or_default().to_string() }
}

/// `KeySchema`에서 (파티션 키, 정렬 키)를 가린다. 스키마가 비어 있으면(읽지 못한 테이블) 이름 없는 키다
fn key_pair(schema: &[aws_sdk_dynamodb::types::KeySchemaElement], types: &HashMap<&str, &str>) -> (KeyAttr, Option<KeyAttr>) {
    let pick = |wanted: KeyType| schema.iter().find(|k| *k.key_type() == wanted).map(|k| key_attr(k.attribute_name(), types));
    (pick(KeyType::Hash).unwrap_or_else(|| key_attr("", types)), pick(KeyType::Range))
}

fn projection(p: Option<&aws_sdk_dynamodb::types::Projection>) -> Projection {
    Projection {
        kind: p.and_then(|p| p.projection_type()).map(|t| t.as_str().to_string()).unwrap_or_else(|| "ALL".to_string()),
        attrs: p.map(|p| p.non_key_attributes().to_vec()).unwrap_or_default(),
    }
}

/// `DescribeTable` 결과를 해석한다. TTL·PITR·Contributor Insights·정책·오토스케일링·진단은 비어 있다(`read_overview`·`read_table`이 채운다)
pub fn parse_table(t: &TableDescription) -> DynamoTable {
    let types: HashMap<&str, &str> = t.attribute_definitions().iter().map(|a| (a.attribute_name(), a.attribute_type().as_str())).collect();
    let (pk, sk) = key_pair(t.key_schema(), &types);
    let provisioned = t.billing_mode_summary().and_then(|b| b.billing_mode()).is_none_or(|m| *m != aws_sdk_dynamodb::types::BillingMode::PayPerRequest);
    let throughput = t.provisioned_throughput();
    let billing = if provisioned {
        Billing { mode: BillingMode::Provisioned, read: throughput.and_then(|p| p.read_capacity_units()), write: throughput.and_then(|p| p.write_capacity_units()) }
    } else {
        Billing { mode: BillingMode::OnDemand, read: None, write: None }
    };

    let mut indexes: Vec<Index> = t
        .global_secondary_indexes()
        .iter()
        .map(|g| {
            let (pk, sk) = key_pair(g.key_schema(), &types);
            let capacity = g.provisioned_throughput().filter(|_| provisioned);
            Index {
                name: g.index_name().unwrap_or_default().to_string(),
                kind: IndexKind::Gsi,
                pk,
                sk,
                projection: projection(g.projection()),
                status: g.index_status().map(|s| s.as_str().to_string()).unwrap_or_else(|| "ACTIVE".to_string()),
                backfilling: g.backfilling().unwrap_or(false),
                read: capacity.and_then(|c| c.read_capacity_units()),
                write: capacity.and_then(|c| c.write_capacity_units()),
                item_count: g.item_count().unwrap_or(0),
                size_bytes: g.index_size_bytes().unwrap_or(0),
            }
        })
        .collect();
    indexes.extend(t.local_secondary_indexes().iter().map(|l| {
        let (pk, sk) = key_pair(l.key_schema(), &types);
        Index {
            name: l.index_name().unwrap_or_default().to_string(),
            kind: IndexKind::Lsi,
            pk,
            sk,
            projection: projection(l.projection()),
            status: "ACTIVE".to_string(),
            backfilling: false,
            read: None,
            write: None,
            item_count: l.item_count().unwrap_or(0),
            size_bytes: l.index_size_bytes().unwrap_or(0),
        }
    }));

    let stream = t
        .stream_specification()
        .filter(|s| s.stream_enabled())
        .zip(t.latest_stream_arn())
        .map(|(s, arn)| StreamSpec { arn: arn.to_string(), view_type: s.stream_view_type().map(|v| v.as_str().to_string()).unwrap_or_default() });
    let sse = match t.sse_description() {
        Some(d) if d.sse_type().is_some_and(|k| k.as_str() == "KMS") => Sse { kind: "KMS".to_string(), kms_key: d.kms_master_key_arn().map(str::to_string) },
        _ => Sse { kind: "OWNED".to_string(), kms_key: None },
    };

    DynamoTable {
        name: t.table_name().unwrap_or_default().to_string(),
        arn: t.table_arn().unwrap_or_default().to_string(),
        status: t.table_status().map(|s| s.as_str().to_string()).unwrap_or_default(),
        keys: Keys { pk, sk },
        attribute_types: types.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        indexes,
        billing,
        scaling: None,
        class: t.table_class_summary().and_then(|c| c.table_class()).map(|c| c.as_str().to_string()).unwrap_or_else(|| "STANDARD".to_string()),
        ttl: None,
        pitr: None,
        deletion_protection: t.deletion_protection_enabled().unwrap_or(false),
        stream,
        sse,
        replicas: t
            .replicas()
            .iter()
            .map(|r| Replica {
                region: r.region_name().unwrap_or_default().to_string(),
                status: r.replica_status().map(|s| s.as_str().to_string()).unwrap_or_default(),
                class: r.replica_table_class_summary().and_then(|c| c.table_class()).map(|c| c.as_str().to_string()),
            })
            .collect(),
        contributor_insights: None,
        resource_policy: None,
        item_count: t.item_count().unwrap_or(0),
        size_bytes: t.table_size_bytes().unwrap_or(0),
        created_at: t.creation_date_time().and_then(|d| d.to_millis().ok()),
        findings: vec![],
        error: None,
    }
}

/// 읽지 못한 테이블: 이름과 이유만 있고 나머지는 비어 있다
fn failed_table(name: &str, err: &AppError) -> DynamoTable {
    let mut t = parse_table(&TableDescription::builder().table_name(name).build());
    t.error = Some(err.to_string());
    t
}

// 목록과 DescribeTable ---------------------------------------------------------------------------

/// 리전의 테이블 이름(최대 `MAX_ITEMS`개)
pub async fn list_table_names(client: &aws_sdk_dynamodb::Client) -> Result<Capped<String>, AppError> {
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
    Ok(names)
}

/// 이름마다 `DescribeTable`(동시 8개). 결과는 입력 순서다
pub async fn describe_tables(client: &aws_sdk_dynamodb::Client, names: Vec<String>) -> Vec<Result<TableDescription, AppError>> {
    map_concurrent(names, |name| {
        let client = client.clone();
        async move { describe_table(&client, &name).await }
    })
    .await
}

async fn describe_table(client: &aws_sdk_dynamodb::Client, name: &str) -> Result<TableDescription, AppError> {
    let out = client.describe_table().table_name(name).send().await.map_err(|e| from_sdk(e, "dynamodb:DescribeTable"))?;
    out.table().cloned().ok_or_else(|| AppError::other(format!("테이블 `{name}`의 설명을 받지 못했어요")))
}

// 테이블별 부가 정보 ---------------------------------------------------------------------------------

struct Extras {
    ttl: Result<Ttl, AppError>,
    pitr: Result<Pitr, AppError>,
    /// 상태
    insights: Result<String, AppError>,
    policy: Result<bool, AppError>,
}

async fn read_extras(client: &aws_sdk_dynamodb::Client, table: &DynamoTable) -> Extras {
    let name = table.name.as_str();
    let ttl = async {
        let out = client.describe_time_to_live().table_name(name).send().await.map_err(|e| from_sdk(e, "dynamodb:DescribeTimeToLive"))?;
        let d = out.time_to_live_description();
        Ok(Ttl {
            status: d.and_then(|d| d.time_to_live_status()).map(|s| s.as_str().to_string()).unwrap_or_else(|| "DISABLED".to_string()),
            attribute: d.and_then(|d| d.attribute_name()).filter(|a| !a.is_empty()).map(str::to_string),
        })
    };
    let pitr = async {
        let out = client.describe_continuous_backups().table_name(name).send().await.map_err(|e| from_sdk(e, "dynamodb:DescribeContinuousBackups"))?;
        let d = out.continuous_backups_description().and_then(|d| d.point_in_time_recovery_description());
        Ok(Pitr {
            status: d.and_then(|d| d.point_in_time_recovery_status()).map(|s| s.as_str().to_string()).unwrap_or_else(|| "DISABLED".to_string()),
            days: d.and_then(|d| d.recovery_period_in_days()).map(i64::from),
        })
    };
    let insights = async {
        let out = client.describe_contributor_insights().table_name(name).send().await.map_err(|e| from_sdk(e, "dynamodb:DescribeContributorInsights"))?;
        Ok(out.contributor_insights_status().map(|s| s.as_str().to_string()).unwrap_or_else(|| "DISABLED".to_string()))
    };
    let policy = async {
        match client.get_resource_policy().resource_arn(&table.arn).send().await {
            Ok(out) => Ok(out.policy().is_some_and(|p| !p.is_empty())),
            Err(e) if e.as_service_error().is_some_and(|se| se.is_policy_not_found_exception()) => Ok(false),
            Err(e) => Err(from_sdk(e, "dynamodb:GetResourcePolicy")),
        }
    };
    let (ttl, pitr, insights, policy) = futures::join!(ttl, pitr, insights, policy);
    Extras { ttl, pitr, insights, policy }
}

/// 읽지 못한 부분을 구역(`section`)별로 하나씩 모은다. 같은 구역의 오류가 여러 테이블에서 나면 처음 것과 개수만 남긴다.
/// SSO 만료는 전체를 멈춰야 하므로 따로 알려 준다.
#[derive(Default)]
struct Gaps {
    entries: Vec<(&'static str, AppError, usize)>,
    expired: bool,
}

impl Gaps {
    fn note(&mut self, section: &'static str, err: AppError) {
        if err == AppError::SsoExpired {
            self.expired = true;
        }
        match self.entries.iter_mut().find(|(s, _, _)| *s == section) {
            Some((_, _, n)) => *n += 1,
            None => self.entries.push((section, err, 1)),
        }
    }

    /// 값이면 그대로, 오류면 구역에 적고 None
    fn take<T>(&mut self, section: &'static str, result: Result<T, AppError>) -> Option<T> {
        result.map_err(|e| self.note(section, e)).ok()
    }

    fn finish(self) -> Result<Vec<Gap>, AppError> {
        if self.expired {
            return Err(AppError::SsoExpired);
        }
        Ok(self
            .entries
            .into_iter()
            .map(|(section, err, n)| Gap { section: section.to_string(), error: if n > 1 { format!("{err} (외 {}곳)", n - 1) } else { err.to_string() } })
            .collect())
    }
}

fn apply_extras(table: &mut DynamoTable, extras: Extras, gaps: &mut Gaps) {
    table.ttl = gaps.take("ttl", extras.ttl);
    table.pitr = gaps.take("pitr", extras.pitr);
    table.contributor_insights = gaps.take("contributorInsights", extras.insights);
    table.resource_policy = gaps.take("resourcePolicy", extras.policy);
}

// 오토스케일링 ---------------------------------------------------------------------------------------

/// Application Auto Scaling이 돌려준 대상 한 줄(해석 전)
#[derive(Debug, Clone, PartialEq)]
pub struct RawScalable {
    pub resource_id: String,
    pub dimension: String,
    pub min: i64,
    pub max: i64,
}

/// 목표 추적 정책의 목표값
#[derive(Debug, Clone, PartialEq)]
pub struct RawPolicy {
    pub resource_id: String,
    pub dimension: String,
    pub target_value: f64,
}

/// `table/<이름>` 또는 `table/<이름>/index/<GSI>` → (테이블, GSI)
fn parse_resource_id(id: &str) -> Option<(&str, Option<&str>)> {
    let mut parts = id.split('/');
    match (parts.next()?, parts.next()?, parts.next(), parts.next(), parts.next()) {
        ("table", table, None, _, _) => Some((table, None)),
        ("table", table, Some("index"), Some(index), None) => Some((table, Some(index))),
        _ => None,
    }
}

fn dimension_of(scalable_dimension: &str) -> Option<Dimension> {
    if scalable_dimension.ends_with(":ReadCapacityUnits") {
        Some(Dimension::Read)
    } else if scalable_dimension.ends_with(":WriteCapacityUnits") {
        Some(Dimension::Write)
    } else {
        None
    }
}

/// 대상과 정책을 테이블 이름별 오토스케일링 대상으로 묶는다. 알아보지 못하는 항목은 건너뛴다
pub fn build_scaling(targets: &[RawScalable], policies: &[RawPolicy]) -> HashMap<String, Vec<ScalingTarget>> {
    let mut out: HashMap<String, Vec<ScalingTarget>> = HashMap::new();
    for t in targets {
        let (Some((table, index)), Some(dimension)) = (parse_resource_id(&t.resource_id), dimension_of(&t.dimension)) else {
            continue;
        };
        let target_utilization = policies.iter().find(|p| p.resource_id == t.resource_id && p.dimension == t.dimension).map(|p| p.target_value);
        out.entry(table.to_string()).or_default().push(ScalingTarget { index: index.map(str::to_string), dimension, min: t.min, max: t.max, target_utilization });
    }
    out
}

/// 리전의 DynamoDB 오토스케일링 대상 전체(테이블 이름 → 대상들)
pub async fn read_scaling(cfg: &SdkConfig) -> Result<HashMap<String, Vec<ScalingTarget>>, AppError> {
    let client = aws_sdk_applicationautoscaling::Client::new(cfg);
    let mut targets = Vec::new();
    let mut pages = client.describe_scalable_targets().service_namespace(ServiceNamespace::Dynamodb).into_paginator().send();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "application-autoscaling:DescribeScalableTargets"))?;
        targets.extend(page.scalable_targets().iter().map(|t| RawScalable {
            resource_id: t.resource_id().to_string(),
            dimension: t.scalable_dimension().as_str().to_string(),
            min: i64::from(t.min_capacity()),
            max: i64::from(t.max_capacity()),
        }));
    }
    let mut policies = Vec::new();
    let mut pages = client.describe_scaling_policies().service_namespace(ServiceNamespace::Dynamodb).into_paginator().send();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "application-autoscaling:DescribeScalingPolicies"))?;
        policies.extend(page.scaling_policies().iter().filter(|p| *p.policy_type() == PolicyType::TargetTrackingScaling).filter_map(|p| {
            p.target_tracking_scaling_policy_configuration().map(|c| RawPolicy { resource_id: p.resource_id().to_string(), dimension: p.scalable_dimension().as_str().to_string(), target_value: c.target_value() })
        }));
    }
    Ok(build_scaling(&targets, &policies))
}

// 진단 --------------------------------------------------------------------------------------------------

/// 스케일링·지표를 테이블에 붙이고 진단을 계산한다. 읽지 못한 입력(None)은 그 입력이 필요한 규칙을 건너뛴다
fn diagnose(tables: &mut [DynamoTable], mut scaling: Option<HashMap<String, Vec<ScalingTarget>>>, metrics: Option<&HashMap<String, TableMetrics>>) {
    for t in tables.iter_mut().filter(|t| t.error.is_none()) {
        t.scaling = scaling.as_mut().map(|s| s.remove(&t.name).unwrap_or_default());
        t.findings = health(&HealthInput { table: t, scaling: t.scaling.as_deref(), metrics: metrics.and_then(|m| m.get(&t.name)) });
    }
}

fn metric_targets(tables: &[DynamoTable]) -> Vec<Target> {
    tables.iter().filter(|t| t.error.is_none()).flat_map(metrics::targets_of).collect()
}

/// 전부 실패했거나 SSO 만료·요청 제한이 있으면 오류, 그 밖의 부분 실패는 읽지 못한 테이블로 둔다(순서는 그대로)
fn settle_tables(names: &[String], results: Vec<Result<TableDescription, AppError>>) -> Result<Vec<DynamoTable>, AppError> {
    let parsed = results.into_iter().map(|r| r.map(|d| parse_table(&d))).collect();
    settle(parsed, |i, e| failed_table(&names[i], e))
}

/// 부가 정보(TTL·PITR·Contributor Insights·정책)를 읽어 테이블에 붙인다. 읽지 못한 테이블은 건너뛴다
async fn attach_extras(client: &aws_sdk_dynamodb::Client, tables: &mut [DynamoTable], gaps: &mut Gaps) {
    let extras = map_concurrent(tables.iter().filter(|t| t.error.is_none()).cloned().collect::<Vec<_>>(), |t| {
        let client = client.clone();
        async move { (t.name.clone(), read_extras(&client, &t).await) }
    })
    .await;
    for (name, extra) in extras {
        if let Some(table) = tables.iter_mut().find(|t| t.name == name) {
            apply_extras(table, extra, gaps);
        }
    }
}

/// 리전의 모든 테이블과 진단. 하나가 권한 없음이어도 나머지는 돌려주고 읽지 못한 부분은 `gaps`에 적는다
pub async fn read_overview(cfg: &SdkConfig) -> Result<DynamoOverview, AppError> {
    let client = aws_sdk_dynamodb::Client::new(cfg);
    let listed = list_table_names(&client).await?;
    let names = listed.items.clone();
    let mut tables = settle_tables(&names, describe_tables(&client, listed.items).await)?;
    let mut gaps = Gaps::default();

    let (_, scaling) = futures::join!(attach_extras(&client, &mut tables, &mut gaps), read_scaling(cfg));
    let scaling = gaps.take("autoscaling", scaling);
    let now = now_secs();
    let targets = metric_targets(&tables);
    let metrics = if targets.is_empty() { Some(HashMap::new()) } else { gaps.take("metrics", metrics::read(cfg, &targets, now).await) };

    diagnose(&mut tables, scaling, metrics.as_ref());
    Ok(DynamoOverview { tables, truncated: listed.truncated, gaps: gaps.finish()? })
}

/// 테이블 하나와 진단. 읽지 못한 부분은 그 필드가 None이다
pub async fn read_table(cfg: &SdkConfig, name: &str) -> Result<DynamoTable, AppError> {
    let client = aws_sdk_dynamodb::Client::new(cfg);
    let mut tables = vec![parse_table(&describe_table(&client, name).await?)];
    let mut gaps = Gaps::default();
    let (extras, scaling) = futures::join!(read_extras(&client, &tables[0]), read_scaling(cfg));
    apply_extras(&mut tables[0], extras, &mut gaps);
    let scaling = gaps.take("autoscaling", scaling);
    let metrics = gaps.take("metrics", metrics::read(cfg, &metric_targets(&tables), now_secs()).await);
    diagnose(&mut tables, scaling, metrics.as_ref());
    gaps.finish()?;
    Ok(tables.remove(0))
}

// 상위 키(Contributor Insights) -----------------------------------------------------------------------------

/// 규칙 이름(`DynamoDBContributorInsights-PKC-<리소스>-<시각>`)이 어떤 보고서인가: (종류, 정렬 키까지 묶는가)
pub fn classify_rule(rule: &str) -> Option<(TopKeyKind, bool)> {
    let rest = rule.strip_prefix("DynamoDBContributorInsights-")?;
    let code = rest.split('-').next()?;
    match code {
        "PKC" => Some((TopKeyKind::Accessed, false)),
        "SKC" => Some((TopKeyKind::Accessed, true)),
        "PKT" => Some((TopKeyKind::Throttled, false)),
        "SKT" => Some((TopKeyKind::Throttled, true)),
        _ => None,
    }
}

/// Contributor Insights가 켜진 테이블의 최근 1시간 상위 키(접근이 많은 키, 스로틀된 키). 테이블 자체의 규칙만 읽는다
pub async fn top_keys(cfg: &SdkConfig, table: &str, now: i64) -> Result<TopKeys, AppError> {
    let dynamo = aws_sdk_dynamodb::Client::new(cfg);
    let described = dynamo.describe_contributor_insights().table_name(table).send().await.map_err(|e| from_sdk(e, "dynamodb:DescribeContributorInsights"))?;
    if described.contributor_insights_status() != Some(&ContributorInsightsStatus::Enabled) {
        return Err(AppError::other(CONTRIBUTOR_INSIGHTS_OFF));
    }
    let cloudwatch = aws_sdk_cloudwatch::Client::new(cfg);
    let end = now - now % 60 + 60;
    let mut groups = Vec::new();
    for rule in described.contributor_insights_rule_list() {
        let Some((kind, with_sort_key)) = classify_rule(rule) else { continue };
        let report = cloudwatch
            .get_insight_rule_report()
            .rule_name(rule)
            .start_time(DateTime::from_secs(end - TOP_KEYS_WINDOW_SECS))
            .end_time(DateTime::from_secs(end))
            .period(TOP_KEYS_WINDOW_SECS as i32)
            .max_contributor_count(TOP_KEYS_COUNT)
            .send()
            .await
            .map_err(|e| from_sdk(e, "cloudwatch:GetInsightRuleReport"))?;
        let entries = report
            .contributors()
            .iter()
            .map(|c| TopKeyEntry { keys: c.keys().to_vec(), count: c.approximate_aggregate_value().unwrap_or(0.0) })
            .collect();
        groups.push(TopKeyGroup { kind, with_sort_key, entries });
    }
    groups.sort_by_key(|g| (g.kind as u8, g.with_sort_key));
    Ok(TopKeys { window_secs: TOP_KEYS_WINDOW_SECS, groups })
}

#[cfg(test)]
mod tests;
