//! DynamoDB 운영 API 호출.
use aws_config::SdkConfig;
use aws_sdk_dynamodb::{Client, types::*};
use aws_smithy_types::DateTime;
use crate::error::{from_sdk, AppError};
use crate::iam::clock::parse_iso;
use super::change::DynamoChange;

fn timestamp(value: &str) -> Result<DateTime, AppError> {
    parse_iso(value).map(DateTime::from_secs)
        .ok_or_else(|| AppError::other("시각은 ISO 8601 형식으로 입력해 주세요."))
}

fn throughput(read: i64, write: i64) -> Result<ProvisionedThroughput, AppError> {
    ProvisionedThroughput::builder()
        .read_capacity_units(read)
        .write_capacity_units(write)
        .build()
        .map_err(|error| AppError::other(error.to_string()))
}

pub async fn apply(
    cfg: &SdkConfig,
    table: &str,
    arn: &str,
    change: &DynamoChange,
) -> Result<Option<DynamoChange>, AppError> {
    let client = Client::new(cfg);
    match change {
        DynamoChange::PutItem { .. } | DynamoChange::UpdateItem { .. }
        | DynamoChange::MoveItem { .. } | DynamoChange::DeleteItems { .. }
        | DynamoChange::RestoreItems { .. } => unreachable!("아이템 쓰기는 별도로 처리해요"),
        DynamoChange::Ttl { enabled, attribute } => {
            let specification = TimeToLiveSpecification::builder()
                .enabled(*enabled)
                .attribute_name(attribute)
                .build().map_err(|error| AppError::other(error.to_string()))?;
            client.update_time_to_live().table_name(table)
                .time_to_live_specification(specification).send().await
                .map_err(|error| from_sdk(error, "dynamodb:UpdateTimeToLive"))?;
        }
        DynamoChange::Pitr { enabled, days } => {
            let specification = PointInTimeRecoverySpecification::builder()
                .point_in_time_recovery_enabled(*enabled)
                .set_recovery_period_in_days(if *enabled { days.map(|days| days as i32) } else { None })
                .build().map_err(|error| AppError::other(error.to_string()))?;
            client.update_continuous_backups().table_name(table)
                .point_in_time_recovery_specification(specification).send().await
                .map_err(|error| from_sdk(error, "dynamodb:UpdateContinuousBackups"))?;
        }
        DynamoChange::DeletionProtection { enabled } => {
            client.update_table().table_name(table).deletion_protection_enabled(*enabled)
                .send().await.map_err(|error| from_sdk(error, "dynamodb:UpdateTable"))?;
        }
        DynamoChange::Stream { enabled, view_type } => {
            let specification = StreamSpecification::builder()
                .stream_enabled(*enabled)
                .set_stream_view_type(view_type.as_deref().map(StreamViewType::from))
                .build().map_err(|error| AppError::other(error.to_string()))?;
            client.update_table().table_name(table).stream_specification(specification)
                .send().await.map_err(|error| from_sdk(error, "dynamodb:UpdateTable"))?;
        }
        DynamoChange::TableClass { class } => {
            client.update_table().table_name(table).table_class(TableClass::from(class.as_str()))
                .send().await.map_err(|error| from_sdk(error, "dynamodb:UpdateTable"))?;
        }
        DynamoChange::Billing { mode, read, write, indexes } => {
            let billing_mode = if mode == "provisioned" { BillingMode::Provisioned } else { BillingMode::PayPerRequest };
            let mut request = client.update_table().table_name(table).billing_mode(billing_mode);
            if mode == "provisioned" {
                request = request.provisioned_throughput(throughput(read.unwrap_or(0), write.unwrap_or(0))?);
                for index in indexes {
                    let update = UpdateGlobalSecondaryIndexAction::builder()
                        .index_name(&index.name)
                        .provisioned_throughput(throughput(index.read, index.write)?)
                        .build().map_err(|error| AppError::other(error.to_string()))?;
                    request = request.global_secondary_index_updates(
                        GlobalSecondaryIndexUpdate::builder().update(update).build(),
                    );
                }
            }
            request.send().await.map_err(|error| from_sdk(error, "dynamodb:UpdateTable"))?;
        }
        DynamoChange::ContributorInsights { enabled } => {
            let action = if *enabled { ContributorInsightsAction::Enable } else { ContributorInsightsAction::Disable };
            client.update_contributor_insights().table_name(table).contributor_insights_action(action)
                .send().await.map_err(|error| from_sdk(error, "dynamodb:UpdateContributorInsights"))?;
        }
        DynamoChange::CreateBackup { name } => {
            let output = client.create_backup().table_name(table).backup_name(name)
                .send().await.map_err(|error| from_sdk(error, "dynamodb:CreateBackup"))?;
            let backup_arn = output.backup_details().map(|backup| backup.backup_arn())
                .ok_or_else(|| AppError::other("만든 백업의 ARN을 받지 못했어요."))?;
            return Ok(Some(DynamoChange::DeleteBackup { arn: backup_arn.to_string() }));
        }
        DynamoChange::DeleteBackup { arn } => {
            client.delete_backup().backup_arn(arn).send().await
                .map_err(|error| from_sdk(error, "dynamodb:DeleteBackup"))?;
        }
        DynamoChange::RestoreBackup { arn, target } => {
            client.restore_table_from_backup().backup_arn(arn).target_table_name(target)
                .send().await.map_err(|error| from_sdk(error, "dynamodb:RestoreTableFromBackup"))?;
        }
        DynamoChange::RestorePitr { time, target } => {
            let mut request = client.restore_table_to_point_in_time()
                .source_table_name(table).target_table_name(target);
            request = if let Some(time) = time.as_deref().filter(|time| !time.is_empty()) {
                request.restore_date_time(timestamp(time)?)
            } else {
                request.use_latest_restorable_time(true)
            };
            request.send().await.map_err(|error| from_sdk(error, "dynamodb:RestoreTableToPointInTime"))?;
        }
        DynamoChange::ExportS3 { bucket, prefix, format, time } => {
            let mut request = client.export_table_to_point_in_time().table_arn(arn)
                .s3_bucket(bucket).s3_prefix(prefix).export_format(ExportFormat::from(format.as_str()));
            if let Some(time) = time.as_deref().filter(|time| !time.is_empty()) {
                request = request.export_time(timestamp(time)?);
            }
            request.send().await.map_err(|error| from_sdk(error, "dynamodb:ExportTableToPointInTime"))?;
        }
    }
    Ok(None)
}
