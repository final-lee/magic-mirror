//! AWS 읽기(읽기 전용 호출만). `fetch_snapshot`이 계정의 IAM 상태를 한 번에 읽어 스냅숏으로 만들고,
//! 나머지 하위 모듈은 요청마다 따로 부르는 조회(액세스 키·사용 기록·정책 목록·시뮬레이터·정책 검사)다.

use std::future::Future;
use std::time::Duration;

use aws_config::SdkConfig;

use super::clock::{iso, now_secs};
use super::model::Snapshot;
use crate::error::{from_sdk, AppError};

pub mod checks;
mod credentials;
mod details;
pub mod keys;
pub mod policies;
pub mod usage;

/// AWS가 보고서·사용 기록을 만드는 동안 얼마나 자주 확인할지.
pub const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// `check`가 값을 돌려줄 때까지 `interval`마다 불러 본다. 처음에 한 번 바로 확인하고, 그 뒤로 `max_wait`가 지날 때까지 확인한다.
/// 시간 안에 끝나지 않으면 None, `check`가 오류를 내면 바로 그 오류다.
pub(crate) async fn poll<T, Fut>(max_wait: Duration, interval: Duration, mut check: impl FnMut() -> Fut) -> Result<Option<T>, AppError>
where
    Fut: Future<Output = Result<Option<T>, AppError>>,
{
    let tries = 1 + max_wait.as_millis() / interval.as_millis().max(1);
    for attempt in 0..tries {
        if attempt > 0 {
            tokio::time::sleep(interval).await;
        }
        if let Some(done) = check().await? {
            return Ok(Some(done));
        }
    }
    Ok(None)
}

/// 앱이 쓰는 자격 증명이 가리키는 IAM 사용자·역할의 ARN. 스냅숏에 있는 것만 돌려준다.
/// `assumed-role/<역할 이름>/<세션>`은 그 이름의 역할 ARN(경로가 붙은 ARN)으로, `user/…`는 사용자 ARN 그대로, 루트·연합 사용자·다른 계정은 None이다.
pub fn caller_principal(s: &Snapshot, caller_arn: &str) -> Option<String> {
    let mut parts = caller_arn.splitn(6, ':');
    let (service, account, resource) = (parts.nth(2)?, parts.nth(1)?, parts.next()?);
    if account != s.account_id {
        return None;
    }
    match service {
        "iam" if resource.starts_with("user/") => s.user(caller_arn).map(|u| u.arn.clone()),
        "sts" => {
            let name = resource.strip_prefix("assumed-role/")?.split('/').next()?;
            s.role(name).map(|r| r.arn.clone())
        }
        _ => None,
    }
}

async fn caller_identity(sts: &aws_sdk_sts::Client) -> Result<(String, String), AppError> {
    let out = sts.get_caller_identity().send().await.map_err(|e| from_sdk(e, "sts:GetCallerIdentity"))?;
    Ok((out.account().unwrap_or_default().to_string(), out.arn().unwrap_or_default().to_string()))
}

/// 계정의 사용자·그룹·역할, 고객 관리형 정책 전부와 어딘가에 쓰이는 AWS 관리형 정책, 자격 증명 보고서를 읽어 스냅숏으로 만든다.
/// 사용자·그룹·역할·정책을 못 읽거나 SSO 만료·요청 제한이면 오류이고, 자격 증명 보고서나 일부 정책을 못 읽은 것은 `warnings`에 남기고 계속한다.
pub async fn fetch_snapshot(cfg: &SdkConfig) -> Result<Snapshot, AppError> {
    let iam = aws_sdk_iam::Client::new(cfg);
    let sts = aws_sdk_sts::Client::new(cfg);
    // 보고서는 못 만들어도 계속하니 오류 대신 결과로 감싼다. 사용자·정책을 못 읽으면 보고서를 기다리지 않고 바로 끝낸다.
    // 붙어 있는 AWS 관리형 정책은 보고서가 만들어지기를 기다리는 동안 읽는다
    let ((mut details, (account_id, caller_arn)), report) = tokio::try_join!(
        async {
            let (mut details, caller) = tokio::try_join!(details::fetch_all(&iam), caller_identity(&sts))?;
            details::fill_missing(&iam, &mut details).await?;
            Ok::<_, AppError>((details, caller))
        },
        async { Ok::<_, AppError>(credentials::fetch_report(&iam).await) },
    )?;

    let mut warnings = std::mem::take(&mut details.warnings);
    let (cred_report, cred_generated_at) = match report {
        Ok(report) => {
            warnings.extend(credentials::unreadable_warning(report.unreadable));
            (Some(report.rows), report.generated_at)
        }
        Err(e) => {
            warnings.push(format!("자격 증명 보고서를 불러오지 못했어요: {e}"));
            (None, None)
        }
    };
    warnings.dedup();

    let mut snapshot = Snapshot {
        account_id,
        caller_arn: caller_arn.clone(),
        caller_principal_arn: None,
        fetched_at: iso(now_secs()),
        users: details.users,
        groups: details.groups,
        roles: details.roles,
        policies: details.policies,
        cred_report,
        cred_generated_at,
        warnings,
    };
    snapshot.caller_principal_arn = caller_principal(&snapshot, &caller_arn);
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;
    use crate::iam::fixtures::{self, ACCOUNT, ALICE, DEPLOY, SSO};

    #[tokio::test]
    async fn poll_returns_as_soon_as_the_check_is_done() {
        let calls = AtomicU32::new(0);
        let done = poll(Duration::from_millis(50), Duration::from_millis(1), || async {
            let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
            Ok((n == 3).then_some(n))
        })
        .await;
        assert_eq!(done, Ok(Some(3)));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn poll_checks_right_away_and_then_until_the_wait_is_over() {
        let calls = AtomicU32::new(0);
        let never = poll(Duration::from_millis(5), Duration::from_millis(1), || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(None::<()>)
        })
        .await;
        assert_eq!(never, Ok(None));
        // 곧바로 한 번 + 기다리는 시간 / 간격
        assert_eq!(calls.load(Ordering::SeqCst), 6);

        let once = AtomicU32::new(0);
        let zero_wait = poll(Duration::ZERO, Duration::from_secs(1), || async {
            once.fetch_add(1, Ordering::SeqCst);
            Ok(None::<()>)
        })
        .await;
        assert_eq!((zero_wait, once.load(Ordering::SeqCst)), (Ok(None), 1));
    }

    #[tokio::test]
    async fn poll_stops_at_the_first_error() {
        let calls = AtomicU32::new(0);
        let result: Result<Option<()>, AppError> = poll(Duration::from_millis(50), Duration::from_millis(1), || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(AppError::Throttled)
        })
        .await;
        assert_eq!(result, Err(AppError::Throttled));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    fn account_arn(resource: &str, service: &str) -> String {
        format!("arn:aws:{service}::{ACCOUNT}:{resource}")
    }

    #[test]
    fn a_user_is_the_same_arn() {
        let s = fixtures::snapshot();
        assert_eq!(caller_principal(&s, ALICE).as_deref(), Some(ALICE));
        assert_eq!(caller_principal(&s, &account_arn("user/nobody", "iam")), None);
    }

    #[test]
    fn an_assumed_role_maps_to_the_role_arn_with_its_path() {
        let s = fixtures::snapshot();
        assert_eq!(caller_principal(&s, &account_arn("assumed-role/deploy/session-1", "sts")).as_deref(), Some(DEPLOY));
        // Identity Center 역할은 경로가 붙은 ARN이다
        assert_eq!(caller_principal(&s, &account_arn("assumed-role/AWSReservedSSO_Admin_abc/alice@example.com", "sts")).as_deref(), Some(SSO));
        assert_eq!(caller_principal(&s, &account_arn("assumed-role/missing/s", "sts")), None);
        assert_eq!(caller_principal(&s, &account_arn("assumed-role/", "sts")), None);
    }

    #[test]
    fn root_federated_other_accounts_and_garbage_are_unknown() {
        let s = fixtures::snapshot();
        for arn in [
            account_arn("root", "iam"),
            account_arn("federated-user/bob", "sts"),
            "arn:aws:sts::999999999999:assumed-role/deploy/s".to_string(),
            "arn:aws:iam::999999999999:user/alice".to_string(),
            "alice".to_string(),
            String::new(),
            "arn:aws:sts".to_string(),
        ] {
            assert_eq!(caller_principal(&s, &arn), None, "{arn}");
        }
    }

    #[test]
    fn other_partitions_work_too() {
        let mut s = fixtures::snapshot();
        s.roles[0].arn = format!("arn:aws-us-gov:iam::{ACCOUNT}:role/deploy");
        assert_eq!(
            caller_principal(&s, &format!("arn:aws-us-gov:sts::{ACCOUNT}:assumed-role/deploy/s")).as_deref(),
            Some(format!("arn:aws-us-gov:iam::{ACCOUNT}:role/deploy").as_str())
        );
    }
}
