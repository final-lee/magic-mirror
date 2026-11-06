//! DynamoDB 운영 API 호출.
use aws_config::SdkConfig;
use aws_sdk_dynamodb::{Client, types::*};
use aws_smithy_types::DateTime;
use crate::error::{from_sdk, AppError};
use crate::iam::clock::parse_iso;
use super::change::DynamoChange;

fn timestamp(s: &str) -> Result<DateTime, AppError> { parse_iso(s).map(DateTime::from_secs).ok_or_else(|| AppError::other("시각은 ISO 8601 형식으로 입력해 주세요.")) }
fn throughput(read: i64, write: i64) -> Result<ProvisionedThroughput, AppError> {
    ProvisionedThroughput::builder().read_capacity_units(read).write_capacity_units(write).build().map_err(|e| AppError::other(e.to_string()))
}

pub async fn apply(cfg: &SdkConfig, table: &str, arn: &str, change: &DynamoChange) -> Result<Option<DynamoChange>, AppError> {
    let c = Client::new(cfg);
    match change {
        DynamoChange::Ttl { enabled, attribute } => {
            let spec = TimeToLiveSpecification::builder().enabled(*enabled).attribute_name(attribute).build().map_err(|e| AppError::other(e.to_string()))?;
            c.update_time_to_live().table_name(table).time_to_live_specification(spec).send().await.map_err(|e| from_sdk(e,"dynamodb:UpdateTimeToLive"))?;
        },
        DynamoChange::Pitr { enabled, days } => {
            let spec = PointInTimeRecoverySpecification::builder().point_in_time_recovery_enabled(*enabled).set_recovery_period_in_days(if *enabled { days.map(|d| d as i32) } else { None }).build().map_err(|e| AppError::other(e.to_string()))?;
            c.update_continuous_backups().table_name(table).point_in_time_recovery_specification(spec).send().await.map_err(|e| from_sdk(e,"dynamodb:UpdateContinuousBackups"))?;
        },
        DynamoChange::DeletionProtection { enabled } => { c.update_table().table_name(table).deletion_protection_enabled(*enabled).send().await.map_err(|e| from_sdk(e,"dynamodb:UpdateTable"))?; },
        DynamoChange::Stream { enabled, view_type } => {
            let spec = StreamSpecification::builder().stream_enabled(*enabled).set_stream_view_type(view_type.as_deref().map(StreamViewType::from)).build().map_err(|e| AppError::other(e.to_string()))?;
            c.update_table().table_name(table).stream_specification(spec).send().await.map_err(|e| from_sdk(e,"dynamodb:UpdateTable"))?;
        },
        DynamoChange::TableClass { class } => { c.update_table().table_name(table).table_class(TableClass::from(class.as_str())).send().await.map_err(|e| from_sdk(e,"dynamodb:UpdateTable"))?; },
        DynamoChange::Billing { mode, read, write, indexes } => {
            let mut req = c.update_table().table_name(table).billing_mode(if mode == "provisioned" { BillingMode::Provisioned } else { BillingMode::PayPerRequest });
            if mode == "provisioned" {
                req = req.provisioned_throughput(throughput(read.unwrap_or(0), write.unwrap_or(0))?);
                for i in indexes {
                    let update = UpdateGlobalSecondaryIndexAction::builder().index_name(&i.name).provisioned_throughput(throughput(i.read, i.write)?).build().map_err(|e| AppError::other(e.to_string()))?;
                    req = req.global_secondary_index_updates(GlobalSecondaryIndexUpdate::builder().update(update).build());
                }
            }
            req.send().await.map_err(|e| from_sdk(e,"dynamodb:UpdateTable"))?;
        },
        DynamoChange::ContributorInsights { enabled } => { c.update_contributor_insights().table_name(table).contributor_insights_action(if *enabled { ContributorInsightsAction::Enable } else { ContributorInsightsAction::Disable }).send().await.map_err(|e| from_sdk(e,"dynamodb:UpdateContributorInsights"))?; },
        DynamoChange::CreateBackup { name } => {
            let out = c.create_backup().table_name(table).backup_name(name).send().await.map_err(|e| from_sdk(e,"dynamodb:CreateBackup"))?;
            let backup_arn = out.backup_details().map(|b| b.backup_arn()).ok_or_else(|| AppError::other("만든 백업의 ARN을 받지 못했어요."))?;
            return Ok(Some(DynamoChange::DeleteBackup { arn:backup_arn.to_string() }));
        },
        DynamoChange::DeleteBackup { arn } => { c.delete_backup().backup_arn(arn).send().await.map_err(|e| from_sdk(e,"dynamodb:DeleteBackup"))?; },
        DynamoChange::RestoreBackup { arn, target } => { c.restore_table_from_backup().backup_arn(arn).target_table_name(target).send().await.map_err(|e| from_sdk(e,"dynamodb:RestoreTableFromBackup"))?; },
        DynamoChange::RestorePitr { time, target } => {
            let mut req = c.restore_table_to_point_in_time().source_table_name(table).target_table_name(target);
            req = if let Some(t) = time.as_deref().filter(|s| !s.is_empty()) { req.restore_date_time(timestamp(t)?) } else { req.use_latest_restorable_time(true) };
            req.send().await.map_err(|e| from_sdk(e,"dynamodb:RestoreTableToPointInTime"))?;
        },
        DynamoChange::ExportS3 { bucket, prefix, format, time } => {
            let mut req = c.export_table_to_point_in_time().table_arn(arn).s3_bucket(bucket).s3_prefix(prefix).export_format(ExportFormat::from(format.as_str()));
            if let Some(t) = time.as_deref().filter(|s| !s.is_empty()) { req = req.export_time(timestamp(t)?); }
            req.send().await.map_err(|e| from_sdk(e,"dynamodb:ExportTableToPointInTime"))?;
        },
    }
    Ok(None)
}
