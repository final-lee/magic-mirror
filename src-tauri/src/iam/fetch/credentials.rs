//! 자격 증명 보고서: 만들기를 요청하고, 다 만들어질 때까지(최대 20초) 확인한 뒤 CSV를 읽는다.

use std::time::Duration;

use aws_sdk_iam::types::ReportStateType;

use super::{poll, POLL_INTERVAL};
use crate::error::{from_sdk, AppError};
use crate::iam::clock::iso_of;
use crate::iam::findings::parse_credential_report;
use crate::iam::model::CredRow;

const REPORT_WAIT: Duration = Duration::from_secs(20);

pub(super) struct Report {
    pub rows: Vec<CredRow>,
    pub generated_at: Option<String>,
}

/// 보고서는 4시간 안에 만든 게 있으면 AWS가 그대로 돌려준다. 못 읽거나 줄이 하나도 없으면(루트 줄은 늘 있다) 오류다.
pub(super) async fn fetch_report(client: &aws_sdk_iam::Client) -> Result<Report, AppError> {
    let ready = poll(REPORT_WAIT, POLL_INTERVAL, || async {
        let out = client.generate_credential_report().send().await.map_err(|e| from_sdk(e, "iam:GenerateCredentialReport"))?;
        Ok((out.state() == Some(&ReportStateType::Complete)).then_some(()))
    })
    .await?;
    if ready.is_none() {
        return Err(AppError::other("AWS가 아직 보고서를 만드는 중이에요"));
    }
    let out = client.get_credential_report().send().await.map_err(|e| from_sdk(e, "iam:GetCredentialReport"))?;
    let content = out.content().ok_or_else(|| AppError::other("보고서 내용이 비어 있어요"))?;
    let rows = parse_credential_report(&String::from_utf8_lossy(content.as_ref()));
    if rows.is_empty() {
        return Err(AppError::other("보고서 형식을 읽지 못했어요"));
    }
    Ok(Report { rows, generated_at: iso_of(out.generated_time()) })
}
