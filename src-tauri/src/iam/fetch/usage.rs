//! 서비스별 마지막 사용 기록: 작업 단위로 만들기를 요청하고, 다 만들어질 때까지(최대 30초) 확인한 뒤 끝까지 읽는다.

use std::time::Duration;

use aws_sdk_iam::operation::get_service_last_accessed_details::GetServiceLastAccessedDetailsOutput;
use aws_sdk_iam::types::{AccessAdvisorUsageGranularityType, JobStatusType, ServiceLastAccessed};

use super::{poll, POLL_INTERVAL};
use crate::error::{from_sdk, AppError};
use crate::iam::lastused::{LastAccessedRaw, RawAction, RawService};

const USAGE_WAIT: Duration = Duration::from_secs(30);

/// 한 번에 받는 서비스 수(AWS가 허용하는 최대). 기본값 100이면 서비스가 많은 주체는 여러 번 받아야 한다.
const PAGE_SIZE: i32 = 1000;

fn raw_service(service: &ServiceLastAccessed) -> RawService {
    let tracked: Vec<RawAction> = service
        .tracked_actions_last_accessed()
        .iter()
        .filter_map(|action| {
            Some(RawAction { name: action.action_name().filter(|name| !name.is_empty())?.to_string(), last_used: action.last_accessed_time().map(|t| t.secs()) })
        })
        .collect();
    RawService {
        prefix: service.service_namespace().to_string(),
        name: service.service_name().to_string(),
        last_used: service.last_authenticated().map(|t| t.secs()),
        actions: (!tracked.is_empty()).then_some(tracked),
    }
}

/// 다음 페이지가 있을 때만 그 표식을 돌려준다.
fn next_marker(page: &GetServiceLastAccessedDetailsOutput) -> Option<String> {
    page.is_truncated().then(|| page.marker().map(str::to_string)).flatten()
}

fn failure(page: &GetServiceLastAccessedDetailsOutput) -> AppError {
    match page.error() {
        Some(e) => AppError::other(format!("AWS가 사용 기록을 만들지 못했어요: {} ({})", e.message(), e.code())),
        None => AppError::other("AWS가 사용 기록을 만들지 못했어요"),
    }
}

/// 사용자·그룹·역할 하나의 서비스별 마지막 사용 기록. 작업 단위 기록(S3·EC2·IAM·Lambda 등 관리 작업)도 함께 받는다.
pub(crate) async fn fetch_usage(client: &aws_sdk_iam::Client, arn: &str) -> Result<LastAccessedRaw, AppError> {
    let job = client
        .generate_service_last_accessed_details()
        .arn(arn)
        .granularity(AccessAdvisorUsageGranularityType::ActionLevel)
        .send()
        .await
        .map_err(|e| from_sdk(e, "iam:GenerateServiceLastAccessedDetails"))?;
    let job_id = job.job_id().ok_or_else(|| AppError::other("AWS가 사용 기록 작업 번호를 주지 않았어요"))?.to_string();

    let first = poll(USAGE_WAIT, POLL_INTERVAL, || async {
        let page = client.get_service_last_accessed_details().job_id(&job_id).max_items(PAGE_SIZE).send().await.map_err(|e| from_sdk(e, "iam:GetServiceLastAccessedDetails"))?;
        match page.job_status() {
            JobStatusType::Completed => Ok(Some(page)),
            JobStatusType::Failed => Err(failure(&page)),
            _ => Ok(None),
        }
    })
    .await?
    .ok_or_else(|| AppError::other("AWS가 아직 사용 기록을 모으는 중이에요. 잠시 뒤에 다시 불러오세요"))?;

    let mut raw = LastAccessedRaw { completed_at: Some(first.job_completion_date().secs()), services: first.services_last_accessed().iter().map(raw_service).collect() };
    let mut marker = next_marker(&first);
    while let Some(next) = marker {
        let page = client
            .get_service_last_accessed_details()
            .job_id(&job_id)
            .max_items(PAGE_SIZE)
            .marker(next)
            .send()
            .await
            .map_err(|e| from_sdk(e, "iam:GetServiceLastAccessedDetails"))?;
        raw.services.extend(page.services_last_accessed().iter().map(raw_service));
        marker = next_marker(&page);
    }
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use aws_sdk_iam::types::{ErrorDetails, TrackedActionLastAccessed};
    use aws_smithy_types::DateTime;

    use super::*;

    fn tracked(name: &str, secs: Option<i64>) -> TrackedActionLastAccessed {
        let mut b = TrackedActionLastAccessed::builder().action_name(name);
        if let Some(secs) = secs {
            b = b.last_accessed_time(DateTime::from_secs(secs));
        }
        b.build()
    }

    #[test]
    fn a_service_maps_namespace_name_last_use_and_actions() {
        let service = ServiceLastAccessed::builder()
            .service_name("Amazon S3")
            .service_namespace("s3")
            .last_authenticated(DateTime::from_secs(1_700_000_000))
            .tracked_actions_last_accessed(tracked("GetObject", Some(1_699_999_000)))
            .tracked_actions_last_accessed(tracked("PutObject", None))
            .tracked_actions_last_accessed(tracked("", Some(1)))
            .build()
            .unwrap();
        let raw = raw_service(&service);
        assert_eq!((raw.prefix.as_str(), raw.name.as_str(), raw.last_used), ("s3", "Amazon S3", Some(1_700_000_000)));
        let actions = raw.actions.unwrap();
        // 이름이 없는 기록은 버린다
        assert_eq!(actions.len(), 2);
        assert_eq!((actions[0].name.as_str(), actions[0].last_used), ("GetObject", Some(1_699_999_000)));
        assert_eq!((actions[1].name.as_str(), actions[1].last_used), ("PutObject", None));
    }

    #[test]
    fn a_service_never_used_has_no_time_and_no_actions() {
        let service = ServiceLastAccessed::builder().service_name("Amazon EC2").service_namespace("ec2").build().unwrap();
        let raw = raw_service(&service);
        assert_eq!((raw.last_used, raw.actions.is_none()), (None, true));
    }

    fn page(truncated: bool, marker: Option<&str>) -> GetServiceLastAccessedDetailsOutput {
        let mut b = GetServiceLastAccessedDetailsOutput::builder()
            .job_status(JobStatusType::Completed)
            .job_creation_date(DateTime::from_secs(0))
            .job_completion_date(DateTime::from_secs(1))
            .set_services_last_accessed(Some(Vec::new()))
            .is_truncated(truncated);
        if let Some(m) = marker {
            b = b.marker(m);
        }
        b.build().unwrap()
    }

    #[test]
    fn paging_continues_only_while_truncated() {
        assert_eq!(next_marker(&page(true, Some("m1"))), Some("m1".to_string()));
        assert_eq!(next_marker(&page(false, Some("stale"))), None);
        assert_eq!(next_marker(&page(true, None)), None);
        assert_eq!(next_marker(&page(false, None)), None);
    }

    #[test]
    fn a_failed_job_reports_the_reason_from_aws() {
        let failed = GetServiceLastAccessedDetailsOutput::builder()
            .job_status(JobStatusType::Failed)
            .job_creation_date(DateTime::from_secs(0))
            .job_completion_date(DateTime::from_secs(1))
            .set_services_last_accessed(Some(Vec::new()))
            .is_truncated(false)
            .error(ErrorDetails::builder().message("Entity not found").code("NoSuchEntity").build().unwrap())
            .build()
            .unwrap();
        assert_eq!(failure(&failed), AppError::other("AWS가 사용 기록을 만들지 못했어요: Entity not found (NoSuchEntity)"));
        assert_eq!(failure(&page(false, None)), AppError::other("AWS가 사용 기록을 만들지 못했어요"));
    }
}
