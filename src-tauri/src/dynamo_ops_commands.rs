//! 백업, 내보내기와 같은 계정 S3 버킷을 읽는다.
use serde::Serialize;
use tauri::State;
use crate::{commands::AppState, error::{AppError, from_sdk}, iam::clock::iso_of};

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Backup { arn:String, name:String, status:String, size:Option<i64>, created_at:Option<String> }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Export { arn:String, status:String, bucket:Option<String>, prefix:Option<String>, size:Option<i64>, created_at:Option<String>, error:Option<String> }

#[tauri::command]
pub async fn dynamo_backups(state: State<'_, AppState>, profile:String, region:String, table:String) -> Result<Vec<Backup>,AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    let client = aws_sdk_dynamodb::Client::new(&cfg);
    let mut start = None; let mut rows = Vec::new();
    loop {
        let out = client.list_backups().table_name(&table).set_exclusive_start_backup_arn(start).send().await.map_err(|e| from_sdk(e,"dynamodb:ListBackups"))?;
        rows.extend(out.backup_summaries().iter().map(|b| Backup { arn:b.backup_arn().unwrap_or_default().into(), name:b.backup_name().unwrap_or_default().into(), status:b.backup_status().map(|s| s.as_str()).unwrap_or_default().into(), size:b.backup_size_bytes(), created_at:iso_of(b.backup_creation_date_time()) }));
        start = out.last_evaluated_backup_arn().map(str::to_owned);
        if start.is_none() { break; }
    }
    Ok(rows)
}
#[tauri::command]
pub async fn dynamo_exports(state: State<'_, AppState>, profile:String, region:String, table_arn:String) -> Result<Vec<Export>,AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    let client = aws_sdk_dynamodb::Client::new(&cfg);
    let mut next = None; let mut rows = Vec::new();
    loop {
        let out = client.list_exports().table_arn(&table_arn).set_next_token(next).send().await.map_err(|e| from_sdk(e,"dynamodb:ListExports"))?;
        for item in out.export_summaries() {
            if let Some(arn) = item.export_arn() {
                let detail = client.describe_export().export_arn(arn).send().await.map_err(|e| from_sdk(e,"dynamodb:DescribeExport"))?;
                if let Some(d) = detail.export_description() { rows.push(Export { arn:arn.into(), status:d.export_status().map(|s| s.as_str()).unwrap_or_default().into(), bucket:d.s3_bucket().map(str::to_owned), prefix:d.s3_prefix().map(str::to_owned), size:d.billed_size_bytes(), created_at:iso_of(d.start_time()), error:d.failure_message().map(str::to_owned) }); }
            }
        }
        next = out.next_token().map(str::to_owned); if next.is_none() { break; }
    }
    Ok(rows)
}
#[tauri::command]
pub async fn dynamo_buckets(state: State<'_, AppState>, profile:String, region:String) -> Result<Vec<String>,AppError> {
    let cfg = state.ctx.config(&profile, &region).await?;
    let client = aws_sdk_s3::Client::new(&cfg);
    let mut token = None; let mut names = Vec::new();
    loop {
        let out = client.list_buckets().set_continuation_token(token).send().await.map_err(|e| from_sdk(e,"s3:ListAllMyBuckets"))?;
        names.extend(out.buckets().iter().filter_map(|b| b.name().map(str::to_owned)));
        token = out.continuation_token().map(str::to_owned); if token.is_none() { break; }
    }
    Ok(names)
}
