//! DynamoDB 변경의 미리 보기와 되돌리기 모델. 아이템 값은 기록에 담지 않는다.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use super::{BillingMode, DynamoTable, IndexKind};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DynamoChange {
    Ttl { enabled: bool, attribute: String },
    Pitr { enabled: bool, days: Option<i64> },
    DeletionProtection { enabled: bool },
    Stream { enabled: bool, view_type: Option<String> },
    TableClass { class: String },
    Billing { mode: String, read: Option<i64>, write: Option<i64>, indexes: Vec<IndexCapacity> },
    ContributorInsights { enabled: bool },
    CreateBackup { name: String },
    DeleteBackup { arn: String },
    RestoreBackup { arn: String, target: String },
    RestorePitr { time: Option<String>, target: String },
    ExportS3 { bucket: String, prefix: String, format: String, time: Option<String> },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IndexCapacity { pub name: String, pub read: i64, pub write: i64 }
#[derive(Clone, Debug, Serialize)]
pub struct Call { pub api: String, pub params: Value }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamoPreview {
    pub title: String, pub calls: Vec<Call>, pub diff: Option<Value>, pub impact: Vec<String>,
    pub warnings: Vec<String>, pub blocked: Option<String>, pub confirm_name: Option<String>, pub inverse: Option<DynamoChange>,
}

pub fn preview(table: &DynamoTable, change: &DynamoChange, stream_consumers: bool) -> DynamoPreview {
    let mut warnings = Vec::new();
    let mut blocked = None;
    let mut impact = Vec::new();
    let (api, title, params, inverse) = match change {
        DynamoChange::Ttl { enabled, attribute } => {
            warnings.push("TTL 변경 후 한 시간 동안 다시 변경할 수 없어요. 켜면 이미 만료된 아이템도 삭제될 수 있어요.".into());
            if attribute.trim().is_empty() { blocked = Some("TTL 속성 이름을 입력해 주세요.".into()); }
            if table.ttl.is_none() { blocked = Some("현재 TTL 설정을 읽지 못했어요.".into()); }
            let inverse = table.ttl.as_ref().and_then(|t| {
                if t.status == "ENABLING" || t.status == "DISABLING" { blocked = Some("TTL 변경이 진행 중이에요.".into()); return None; }
                if t.status == "ENABLED" && *enabled && t.attribute.as_deref() != Some(attribute) { blocked = Some("TTL 속성을 바꾸려면 먼저 TTL을 끄고 변경이 끝날 때까지 기다려 주세요.".into()); }
                if t.status == "ENABLED" && !*enabled && t.attribute.as_deref() != Some(attribute) { blocked = Some("TTL을 끄려면 현재 TTL 속성 이름을 입력해 주세요.".into()); }
                Some(DynamoChange::Ttl { enabled: t.status == "ENABLED", attribute: t.attribute.clone().unwrap_or_else(|| attribute.clone()) })
            });
            ("UpdateTimeToLive", "TTL 변경", json!({"tableName":table.name,"timeToLiveSpecification":{"enabled":enabled,"attributeName":attribute}}), inverse)
        },
        DynamoChange::Pitr { enabled, days } => {
            if !enabled { warnings.push("끄면 기존 복원 지점이 사라지며 되돌려도 복원 지점은 돌아오지 않아요.".into()); }
            if days.is_some_and(|d| !(1..=35).contains(&d)) { blocked = Some("복구 기간은 1~35일이어야 해요.".into()); }
            if table.pitr.is_none() { blocked = Some("현재 PITR 설정을 읽지 못했어요.".into()); }
            let inverse = table.pitr.as_ref().map(|p| DynamoChange::Pitr { enabled: p.status == "ENABLED", days: p.days });
            let mut spec = json!({"pointInTimeRecoveryEnabled":enabled});
            if *enabled { if let Some(days) = days { spec["recoveryPeriodInDays"] = json!(days); } }
            ("UpdateContinuousBackups", "PITR 변경", json!({"tableName":table.name,"pointInTimeRecoverySpecification":spec}), inverse)
        },
        DynamoChange::DeletionProtection { enabled } => ("UpdateTable", "삭제 보호 변경", json!({"tableName":table.name,"deletionProtectionEnabled":enabled}), Some(DynamoChange::DeletionProtection { enabled: table.deletion_protection })),
        DynamoChange::Stream { enabled, view_type } => {
            if !enabled { warnings.push("스트림을 끄면 24시간 뒤 레코드가 사라지고 다시 켤 때 ARN이 바뀌어 기존 소비자 연결이 끊겨요.".into()); }
            if *enabled && !matches!(view_type.as_deref(), Some("KEYS_ONLY" | "NEW_IMAGE" | "OLD_IMAGE" | "NEW_AND_OLD_IMAGES")) { blocked = Some("스트림 뷰 타입을 선택해 주세요.".into()); }
            if *enabled && table.stream.as_ref().is_some_and(|s| Some(s.view_type.as_str()) != view_type.as_deref()) { blocked = Some("뷰 타입을 바꾸려면 먼저 스트림을 끄고 다시 켜 주세요.".into()); }
            let inverse = if *enabled && table.stream.is_none() { Some(DynamoChange::Stream { enabled: false, view_type: None }) } else { None };
            let mut spec = json!({"streamEnabled":enabled});
            if *enabled { spec["streamViewType"] = json!(view_type); }
            ("UpdateTable", "스트림 변경", json!({"tableName":table.name,"streamSpecification":spec}), inverse)
        },
        DynamoChange::TableClass { class } => {
            warnings.push("테이블 클래스 변경에는 시간이 걸리며 30일 동안 두 번까지 바꿀 수 있어요.".into());
            if !matches!(class.as_str(), "STANDARD" | "STANDARD_INFREQUENT_ACCESS") { blocked = Some("테이블 클래스를 선택해 주세요.".into()); }
            ("UpdateTable", "테이블 클래스 변경", json!({"tableName":table.name,"tableClass":class}), Some(DynamoChange::TableClass { class: table.class.clone() }))
        },
        DynamoChange::Billing { mode, read, write, indexes } => {
            warnings.push("프로비저닝에서 온디맨드로 전환은 24시간 동안 네 번까지 가능해요. 용량 감소는 테이블과 각 GSI마다 UTC 하루 최대 27회이며 시간별 제한이 있어요. 오토스케일링이 설정값을 덮어쓸 수 있어요.".into());
            if !matches!(mode.as_str(), "onDemand" | "provisioned") || (mode == "provisioned" && (read.unwrap_or(0) < 1 || write.unwrap_or(0) < 1 || indexes.iter().any(|i| i.read < 1 || i.write < 1))) { blocked = Some("용량 모드와 양의 RCU·WCU를 입력해 주세요.".into()); }
            impact.push(format!("요청 용량: RCU {} / WCU {} (시간당 비용은 리전 단가에 따라 달라져요).", read.unwrap_or(0), write.unwrap_or(0)));
            let old_mode = if table.billing.mode == BillingMode::OnDemand { "onDemand" } else { "provisioned" };
            let old_indexes = table.indexes.iter().filter(|i| i.kind == IndexKind::Gsi).filter_map(|i| Some(IndexCapacity { name:i.name.clone(), read:i.read?, write:i.write? })).collect();
            let inverse = Some(DynamoChange::Billing { mode:old_mode.into(), read:table.billing.read, write:table.billing.write, indexes:old_indexes });
            let mut request = json!({"tableName":table.name,"billingMode":if mode == "provisioned" { "PROVISIONED" } else { "PAY_PER_REQUEST" }});
            if mode == "provisioned" {
                request["provisionedThroughput"] = json!({"readCapacityUnits":read,"writeCapacityUnits":write});
                if !indexes.is_empty() { request["globalSecondaryIndexUpdates"] = json!(indexes.iter().map(|i| json!({"update":{"indexName":i.name,"provisionedThroughput":{"readCapacityUnits":i.read,"writeCapacityUnits":i.write}}})).collect::<Vec<_>>()); }
            }
            ("UpdateTable", "용량 변경", request, inverse)
        },
        DynamoChange::ContributorInsights { enabled } => {
            warnings.push("Contributor Insights 규칙마다 요금이 발생해요.".into());
            if table.contributor_insights.as_deref().is_some_and(|s| s == "ENABLING" || s == "DISABLING") { blocked = Some("Contributor Insights 변경이 진행 중이에요.".into()); }
            if table.contributor_insights.is_none() { blocked = Some("현재 Contributor Insights 설정을 읽지 못했어요.".into()); }
            let inverse = table.contributor_insights.as_ref().map(|s| DynamoChange::ContributorInsights { enabled:s == "ENABLED" });
            ("UpdateContributorInsights", "Contributor Insights 변경", json!({"tableName":table.name,"contributorInsightsAction":if *enabled { "ENABLE" } else { "DISABLE" }}), inverse)
        },
        DynamoChange::CreateBackup { name } => ("CreateBackup", "백업 만들기", json!({"tableName":table.name,"backupName":name}), None),
        DynamoChange::DeleteBackup { arn } => ("DeleteBackup", "백업 삭제", json!({"backupArn":arn}), None),
        DynamoChange::RestoreBackup { arn, target } => { warnings.push("새 테이블에는 오토스케일링, TTL, 태그, 스트림과 PITR이 따라오지 않아요.".into()); ("RestoreTableFromBackup", "백업 복원", json!({"backupArn":arn,"targetTableName":target}), None) },
        DynamoChange::RestorePitr { time, target } => { warnings.push("새 테이블에는 오토스케일링, TTL, 태그, 스트림과 PITR이 따라오지 않아요.".into()); let mut p = json!({"sourceTableName":table.name,"targetTableName":target}); if let Some(t) = time.as_deref().filter(|s| !s.is_empty()) { p["restoreDateTime"] = json!(t); } else { p["useLatestRestorableTime"] = json!(true); } ("RestoreTableToPointInTime", "시점 복원", p, None) },
        DynamoChange::ExportS3 { bucket, prefix, format, time } => { warnings.push("내보내기에는 PITR이 필요하고 데이터 크기에 따른 요금이 발생해요.".into()); if table.pitr.as_ref().is_some_and(|p| p.status != "ENABLED") { blocked = Some("PITR을 먼저 켜 주세요.".into()); } let mut p = json!({"tableArn":table.arn,"s3Bucket":bucket,"s3Prefix":prefix,"exportFormat":format}); if let Some(t) = time.as_deref().filter(|s| !s.is_empty()) { p["exportTime"] = json!(t); } ("ExportTableToPointInTime", "S3로 내보내기", p, None) },
    };
    let lower = table.name.to_ascii_lowercase();
    let confirm_name = if lower.contains("prod") || lower.contains("prd") || matches!(change, DynamoChange::DeleteBackup { .. }) || (matches!(change, DynamoChange::Stream { enabled:false, .. }) && stream_consumers) { Some(table.name.clone()) } else { None };
    let diff = inverse.as_ref().map(|before| json!({"before":before,"after":change}));
    DynamoPreview { title:title.into(), calls:vec![Call { api:api.into(), params }], diff, impact, warnings, blocked, confirm_name, inverse }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confirmation_covers_production_backup_and_consumers() {
        let mut t = DynamoTable::fixture("prd-orders");
        assert_eq!(preview(&t, &DynamoChange::DeletionProtection { enabled:true }, false).confirm_name, Some(t.name.clone()));
        t.name = "test".into();
        assert!(preview(&t, &DynamoChange::DeleteBackup { arn:"arn".into() }, false).confirm_name.is_some());
        assert!(preview(&t, &DynamoChange::Stream { enabled:false, view_type:None }, true).confirm_name.is_some());
        assert!(preview(&t, &DynamoChange::Stream { enabled:false, view_type:None }, false).confirm_name.is_none());
    }
    #[test]
    fn settings_inverse_and_limits_are_derived_from_original_state() {
        let t = DynamoTable::fixture("test");
        assert_eq!(preview(&t, &DynamoChange::DeletionProtection { enabled:false }, false).inverse, Some(DynamoChange::DeletionProtection { enabled:true }));
        assert_eq!(preview(&t, &DynamoChange::Pitr { enabled:false, days:None }, false).inverse, Some(DynamoChange::Pitr { enabled:true, days:Some(35) }));
        assert!(preview(&t, &DynamoChange::Pitr { enabled:true, days:Some(0) }, false).blocked.is_some());
        assert!(preview(&t, &DynamoChange::Pitr { enabled:true, days:Some(36) }, false).blocked.is_some());
        assert!(preview(&t, &DynamoChange::Pitr { enabled:true, days:Some(1) }, false).blocked.is_none());
        assert!(preview(&t, &DynamoChange::Pitr { enabled:true, days:Some(35) }, false).blocked.is_none());
    }
    #[test]
    fn stream_view_change_requires_disable_first() {
        let mut t = DynamoTable::fixture("test");
        t.stream = Some(super::super::StreamSpec { arn:"arn".into(), view_type:"KEYS_ONLY".into() });
        assert!(preview(&t, &DynamoChange::Stream { enabled:true, view_type:Some("NEW_IMAGE".into()) }, false).blocked.is_some());
        assert!(preview(&t, &DynamoChange::Stream { enabled:false, view_type:None }, false).inverse.is_none());
        t.stream = None;
        assert!(preview(&t, &DynamoChange::Stream { enabled:true, view_type:Some("NEW_IMAGE".into()) }, false).inverse.is_some());
    }
    #[test]
    fn ttl_transition_and_missing_attribute_are_blocked() {
        let mut t = DynamoTable::fixture("test");
        assert!(preview(&t, &DynamoChange::Ttl { enabled:true, attribute:"".into() }, false).blocked.is_some());
        t.ttl.as_mut().unwrap().status = "ENABLING".into();
        assert!(preview(&t, &DynamoChange::Ttl { enabled:false, attribute:"ttl".into() }, false).blocked.is_some());
    }
}
