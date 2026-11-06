//! DynamoDB 변경의 미리 보기와 되돌리기 모델. 아이템 값은 기록에 담지 않는다.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use super::DynamoTable;

mod inverse;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DynamoChange {
    Ttl { enabled: bool, attribute: String },
    Pitr { enabled: bool, days: Option<i64> },
    DeletionProtection { enabled: bool },
    Stream { enabled: bool, view_type: Option<String> },
    TableClass { class: String },
    Billing {
        mode: String,
        read: Option<i64>,
        write: Option<i64>,
        indexes: Vec<IndexCapacity>,
    },
    ContributorInsights { enabled: bool },
    CreateBackup { name: String },
    DeleteBackup { arn: String },
    RestoreBackup { arn: String, target: String },
    RestorePitr { time: Option<String>, target: String },
    ExportS3 {
        bucket: String,
        prefix: String,
        format: String,
        time: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IndexCapacity {
    pub name: String,
    pub read: i64,
    pub write: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Call {
    pub api: String,
    pub params: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamoPreview {
    pub title: String,
    pub calls: Vec<Call>,
    pub diff: Option<Value>,
    pub impact: Vec<String>,
    pub warnings: Vec<String>,
    pub blocked: Option<String>,
    pub confirm_name: Option<String>,
    pub inverse: Option<DynamoChange>,
}

struct PreviewBuilder {
    api: &'static str,
    title: &'static str,
    params: Value,
    impact: Vec<String>,
    warnings: Vec<String>,
    blocked: Option<String>,
}

impl PreviewBuilder {
    fn new(api: &'static str, title: &'static str, params: Value) -> Self {
        Self {
            api,
            title,
            params,
            impact: Vec::new(),
            warnings: Vec::new(),
            blocked: None,
        }
    }

    fn warning(&mut self, message: &str) {
        self.warnings.push(message.into());
    }

    fn block(&mut self, message: &str) {
        self.blocked = Some(message.into());
    }
}

pub fn preview(table: &DynamoTable, change: &DynamoChange, stream_consumers: bool) -> DynamoPreview {
    let builder = match change {
        DynamoChange::Ttl { enabled, attribute } => preview_ttl(table, *enabled, attribute),
        DynamoChange::Pitr { enabled, days } => preview_pitr(table, *enabled, *days),
        DynamoChange::DeletionProtection { enabled } => PreviewBuilder::new(
            "UpdateTable", "삭제 보호 변경",
            json!({"tableName": table.name, "deletionProtectionEnabled": enabled}),
        ),
        DynamoChange::Stream { enabled, view_type } => preview_stream(table, *enabled, view_type.as_deref()),
        DynamoChange::TableClass { class } => preview_class(table, class),
        DynamoChange::Billing { mode, read, write, indexes } => preview_billing(table, mode, *read, *write, indexes),
        DynamoChange::ContributorInsights { enabled } => preview_insights(table, *enabled),
        DynamoChange::CreateBackup { name } => PreviewBuilder::new("CreateBackup", "백업 만들기", json!({"tableName": table.name, "backupName": name})),
        DynamoChange::DeleteBackup { arn } => PreviewBuilder::new("DeleteBackup", "백업 삭제", json!({"backupArn": arn})),
        DynamoChange::RestoreBackup { arn, target } => preview_restore_backup(arn, target),
        DynamoChange::RestorePitr { time, target } => preview_restore_pitr(table, time.as_deref(), target),
        DynamoChange::ExportS3 { bucket, prefix, format, time } => preview_export(table, bucket, prefix, format, time.as_deref()),
    };
    let inverse = inverse::inverse(table, change);
    let diff = inverse.as_ref().map(|before| json!({"before": before, "after": change}));
    DynamoPreview {
        title: builder.title.into(),
        calls: vec![Call { api: builder.api.into(), params: builder.params }],
        diff,
        impact: builder.impact,
        warnings: builder.warnings,
        blocked: builder.blocked,
        confirm_name: confirmation_name(table, change, stream_consumers),
        inverse,
    }
}

fn confirmation_name(table: &DynamoTable, change: &DynamoChange, stream_consumers: bool) -> Option<String> {
    let name = table.name.to_ascii_lowercase();
    let needs_name = name.contains("prod") || name.contains("prd")
        || matches!(change, DynamoChange::DeleteBackup { .. })
        || (matches!(change, DynamoChange::Stream { enabled: false, .. }) && stream_consumers);
    needs_name.then(|| table.name.clone())
}

fn preview_ttl(table: &DynamoTable, enabled: bool, attribute: &str) -> PreviewBuilder {
    let mut result = PreviewBuilder::new("UpdateTimeToLive", "TTL 변경", json!({"tableName": table.name, "timeToLiveSpecification": {"enabled": enabled, "attributeName": attribute}}));
    result.warning("TTL 변경 후 한 시간 동안 다시 변경할 수 없어요. 켜면 이미 만료된 아이템도 삭제될 수 있어요.");
    if attribute.trim().is_empty() {
        result.block("TTL 속성 이름을 입력해 주세요.");
    }
    match &table.ttl {
        None => result.block("현재 TTL 설정을 읽지 못했어요."),
        Some(ttl) if ttl.status == "ENABLING" || ttl.status == "DISABLING" => result.block("TTL 변경이 진행 중이에요."),
        Some(ttl) => {
            if ttl.status == "ENABLED" && ttl.attribute.as_deref() != Some(attribute) {
                let message = if enabled {
                    "TTL 속성을 바꾸려면 먼저 TTL을 끄고 변경이 끝날 때까지 기다려 주세요."
                } else {
                    "TTL을 끄려면 현재 TTL 속성 이름을 입력해 주세요."
                };
                result.block(message);
            }
        }
    }
    result
}

fn preview_pitr(table: &DynamoTable, enabled: bool, days: Option<i64>) -> PreviewBuilder {
    let mut specification = json!({"pointInTimeRecoveryEnabled": enabled});
    if enabled {
        if let Some(days) = days {
            specification["recoveryPeriodInDays"] = json!(days);
        }
    }
    let mut result = PreviewBuilder::new("UpdateContinuousBackups", "PITR 변경", json!({"tableName": table.name, "pointInTimeRecoverySpecification": specification}));
    if !enabled {
        result.warning("끄면 기존 복원 지점이 사라지며 되돌려도 복원 지점은 돌아오지 않아요.");
    }
    if days.is_some_and(|days| !(1..=35).contains(&days)) {
        result.block("복구 기간은 1~35일이어야 해요.");
    }
    if table.pitr.is_none() {
        result.block("현재 PITR 설정을 읽지 못했어요.");
    }
    result
}

fn preview_stream(table: &DynamoTable, enabled: bool, view_type: Option<&str>) -> PreviewBuilder {
    let mut specification = json!({"streamEnabled": enabled});
    if enabled {
        specification["streamViewType"] = json!(view_type);
    }
    let mut result = PreviewBuilder::new("UpdateTable", "스트림 변경", json!({"tableName": table.name, "streamSpecification": specification}));
    if !enabled {
        result.warning("스트림을 끄면 24시간 뒤 레코드가 사라지고 다시 켤 때 ARN이 바뀌어 기존 소비자 연결이 끊겨요.");
    }
    if enabled && !matches!(view_type, Some("KEYS_ONLY" | "NEW_IMAGE" | "OLD_IMAGE" | "NEW_AND_OLD_IMAGES")) {
        result.block("스트림 뷰 타입을 선택해 주세요.");
    }
    if enabled && table.stream.as_ref().is_some_and(|stream| Some(stream.view_type.as_str()) != view_type) {
        result.block("뷰 타입을 바꾸려면 먼저 스트림을 끄고 다시 켜 주세요.");
    }
    result
}

fn preview_class(table: &DynamoTable, class: &str) -> PreviewBuilder {
    let mut result = PreviewBuilder::new("UpdateTable", "테이블 클래스 변경", json!({"tableName": table.name, "tableClass": class}));
    result.warning("테이블 클래스 변경에는 시간이 걸리며 30일 동안 두 번까지 바꿀 수 있어요.");
    if !matches!(class, "STANDARD" | "STANDARD_INFREQUENT_ACCESS") {
        result.block("테이블 클래스를 선택해 주세요.");
    }
    result
}

fn preview_billing(table: &DynamoTable, mode: &str, read: Option<i64>, write: Option<i64>, indexes: &[IndexCapacity]) -> PreviewBuilder {
    let mut params = json!({"tableName": table.name, "billingMode": if mode == "provisioned" { "PROVISIONED" } else { "PAY_PER_REQUEST" }});
    if mode == "provisioned" {
        params["provisionedThroughput"] = json!({"readCapacityUnits": read, "writeCapacityUnits": write});
        if !indexes.is_empty() {
            params["globalSecondaryIndexUpdates"] = json!(indexes.iter().map(|index| json!({"update": {"indexName": index.name, "provisionedThroughput": {"readCapacityUnits": index.read, "writeCapacityUnits": index.write}}})).collect::<Vec<_>>());
        }
    }
    let mut result = PreviewBuilder::new("UpdateTable", "용량 변경", params);
    result.warning("프로비저닝에서 온디맨드로 전환은 24시간 동안 네 번까지 가능해요. 용량 감소는 테이블과 각 GSI마다 UTC 하루 최대 27회이며 시간별 제한이 있어요. 오토스케일링이 설정값을 덮어쓸 수 있어요.");
    let invalid_capacity = read.unwrap_or(0) < 1 || write.unwrap_or(0) < 1
        || indexes.iter().any(|index| index.read < 1 || index.write < 1);
    if !matches!(mode, "onDemand" | "provisioned") || (mode == "provisioned" && invalid_capacity) {
        result.block("용량 모드와 양의 RCU·WCU를 입력해 주세요.");
    }
    result.impact.push(format!("요청 용량: RCU {} / WCU {} (시간당 비용은 리전 단가에 따라 달라져요).", read.unwrap_or(0), write.unwrap_or(0)));
    result
}

fn preview_insights(table: &DynamoTable, enabled: bool) -> PreviewBuilder {
    let mut result = PreviewBuilder::new("UpdateContributorInsights", "Contributor Insights 변경", json!({"tableName": table.name, "contributorInsightsAction": if enabled { "ENABLE" } else { "DISABLE" }}));
    result.warning("Contributor Insights 규칙마다 요금이 발생해요.");
    match table.contributor_insights.as_deref() {
        None => result.block("현재 Contributor Insights 설정을 읽지 못했어요."),
        Some(status) => {
            if status == "ENABLING" || status == "DISABLING" {
                result.block("Contributor Insights 변경이 진행 중이에요.");
            }
        }
    }
    result
}

const RESTORE_WARNING: &str = "새 테이블에는 오토스케일링, TTL, 태그, 스트림과 PITR이 따라오지 않아요.";

fn preview_restore_backup(arn: &str, target: &str) -> PreviewBuilder {
    let mut result = PreviewBuilder::new("RestoreTableFromBackup", "백업 복원", json!({"backupArn": arn, "targetTableName": target}));
    result.warning(RESTORE_WARNING);
    result
}

fn preview_restore_pitr(table: &DynamoTable, time: Option<&str>, target: &str) -> PreviewBuilder {
    let mut params = json!({"sourceTableName": table.name, "targetTableName": target});
    if let Some(time) = time.filter(|time| !time.is_empty()) {
        params["restoreDateTime"] = json!(time);
    } else {
        params["useLatestRestorableTime"] = json!(true);
    }
    let mut result = PreviewBuilder::new("RestoreTableToPointInTime", "시점 복원", params);
    result.warning(RESTORE_WARNING);
    result
}

fn preview_export(table: &DynamoTable, bucket: &str, prefix: &str, format: &str, time: Option<&str>) -> PreviewBuilder {
    let mut params = json!({"tableArn": table.arn, "s3Bucket": bucket, "s3Prefix": prefix, "exportFormat": format});
    if let Some(time) = time.filter(|time| !time.is_empty()) {
        params["exportTime"] = json!(time);
    }
    let mut result = PreviewBuilder::new("ExportTableToPointInTime", "S3로 내보내기", params);
    result.warning("내보내기에는 PITR이 필요하고 데이터 크기에 따른 요금이 발생해요.");
    match &table.pitr {
        None => result.block("현재 PITR 설정을 읽지 못했어요."),
        Some(pitr) if pitr.status != "ENABLED" => result.block("PITR을 먼저 켜 주세요."),
        Some(_) => {}
    }
    result
}

#[cfg(test)]
mod tests;
