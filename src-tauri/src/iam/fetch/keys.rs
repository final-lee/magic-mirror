//! 사용자의 액세스 키: 상태·나이·마지막 사용. 키 ID만 다루고 비밀 키는 다루지 않는다.

use aws_sdk_iam::types::{AccessKeyLastUsed, AccessKeyMetadata, StatusType};
use futures::future::join_all;
use serde::Serialize;

use crate::error::{from_sdk, AppError};
use crate::iam::clock::{days_between, iso_of};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum KeyStatus {
    Active,
    Inactive,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessKeyInfo {
    pub id: String,
    pub status: KeyStatus,
    pub created_at: Option<String>,
    pub age_days: Option<i64>,
    pub last_used_at: Option<String>,
    pub last_used_service: Option<String>,
    pub last_used_region: Option<String>,
}

/// 한 번도 안 쓴 키는 서비스·리전이 `N/A`로 온다.
fn known(value: &str) -> Option<String> {
    (!value.is_empty() && value != "N/A").then(|| value.to_string())
}

fn key_info(meta: &AccessKeyMetadata, used: Option<&AccessKeyLastUsed>, now: i64) -> AccessKeyInfo {
    AccessKeyInfo {
        id: meta.access_key_id().unwrap_or_default().to_string(),
        // 키에는 활성과 비활성만 있다. 그 밖의 값이 오면 쓸 수 있다고 보지 않는다
        status: match meta.status() {
            Some(StatusType::Active) => KeyStatus::Active,
            _ => KeyStatus::Inactive,
        },
        created_at: iso_of(meta.create_date()),
        age_days: meta.create_date().map(|created| days_between(created.secs(), now)),
        last_used_at: used.and_then(|u| iso_of(u.last_used_date())),
        last_used_service: used.and_then(|u| known(u.service_name())),
        last_used_region: used.and_then(|u| known(u.region())),
    }
}

async fn last_used(client: &aws_sdk_iam::Client, key_id: &str) -> Result<Option<AccessKeyLastUsed>, AppError> {
    let out = client.get_access_key_last_used().access_key_id(key_id).send().await.map_err(|e| from_sdk(e, "iam:GetAccessKeyLastUsed"))?;
    Ok(out.access_key_last_used().cloned())
}

/// 사용자의 액세스 키를 만든 순서대로. 마지막 사용을 못 읽어도(권한 없음 등) 키 목록은 보여 주고, SSO 만료·요청 제한은 오류로 돌려준다.
pub(crate) async fn fetch_keys(client: &aws_sdk_iam::Client, user_name: &str, now: i64) -> Result<Vec<AccessKeyInfo>, AppError> {
    let mut pages = client.list_access_keys().user_name(user_name).into_paginator().send();
    let mut metas: Vec<AccessKeyMetadata> = Vec::new();
    while let Some(page) = pages.next().await {
        metas.extend(page.map_err(|e| from_sdk(e, "iam:ListAccessKeys"))?.access_key_metadata().iter().cloned());
    }
    let used = join_all(metas.iter().map(|meta| last_used(client, meta.access_key_id().unwrap_or_default()))).await;
    if let Some(fatal) = used.iter().filter_map(|r| r.as_ref().err()).find(|e| matches!(e, AppError::SsoExpired | AppError::Throttled)) {
        return Err(fatal.clone());
    }
    let mut keys: Vec<AccessKeyInfo> = metas.iter().zip(used).map(|(meta, used)| key_info(meta, used.ok().flatten().as_ref(), now)).collect();
    keys.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use aws_smithy_types::DateTime;
    use serde_json::json;

    use super::*;
    use crate::iam::clock::{iso, parse_iso, DAY_SECS};

    fn now() -> i64 {
        parse_iso("2026-10-26T00:00:00Z").unwrap()
    }

    fn meta(id: &str, status: StatusType, created_days_ago: i64) -> AccessKeyMetadata {
        AccessKeyMetadata::builder().user_name("bob").access_key_id(id).status(status).create_date(DateTime::from_secs(now() - created_days_ago * DAY_SECS)).build()
    }

    fn used(days_ago: i64, service: &str, region: &str) -> AccessKeyLastUsed {
        AccessKeyLastUsed::builder().last_used_date(DateTime::from_secs(now() - days_ago * DAY_SECS)).service_name(service).region(region).build().unwrap()
    }

    #[test]
    fn an_active_key_with_a_last_use() {
        let info = key_info(&meta("AKIA1", StatusType::Active, 200), Some(&used(5, "s3", "us-east-1")), now());
        assert_eq!(info.id, "AKIA1");
        assert_eq!(info.status, KeyStatus::Active);
        assert_eq!(info.created_at, Some(iso(now() - 200 * DAY_SECS)));
        assert_eq!(info.age_days, Some(200));
        assert_eq!(info.last_used_at, Some(iso(now() - 5 * DAY_SECS)));
        assert_eq!((info.last_used_service.as_deref(), info.last_used_region.as_deref()), (Some("s3"), Some("us-east-1")));
    }

    #[test]
    fn a_key_never_used_has_na_service_and_region() {
        let never = AccessKeyLastUsed::builder().service_name("N/A").region("N/A").build().unwrap();
        let info = key_info(&meta("AKIA2", StatusType::Inactive, 30), Some(&never), now());
        assert_eq!(info.status, KeyStatus::Inactive);
        assert_eq!((info.last_used_at, info.last_used_service, info.last_used_region), (None, None, None));
        assert_eq!(info.age_days, Some(30));
        // 마지막 사용을 못 읽은 경우도 같다
        let unknown = key_info(&meta("AKIA3", StatusType::Active, 1), None, now());
        assert_eq!((unknown.last_used_at, unknown.last_used_service), (None, None));
    }

    #[test]
    fn unexpected_statuses_and_missing_dates() {
        assert_eq!(key_info(&meta("K", StatusType::Expired, 1), None, now()).status, KeyStatus::Inactive);
        let no_status = AccessKeyMetadata::builder().access_key_id("K").build();
        let info = key_info(&no_status, None, now());
        assert_eq!((info.status, info.created_at, info.age_days), (KeyStatus::Inactive, None, None));
        // 만든 때가 미래로 찍혀도(시계 차이) 나이는 0이다
        let future = AccessKeyMetadata::builder().access_key_id("K").status(StatusType::Active).create_date(DateTime::from_secs(now() + 3 * DAY_SECS)).build();
        assert_eq!(key_info(&future, None, now()).age_days, Some(0));
    }

    #[test]
    fn json_shape_matches_the_contract() {
        let info = key_info(&meta("AKIA1", StatusType::Active, 1), Some(&used(1, "iam", "us-east-1")), now());
        let value = serde_json::to_value(info).unwrap();
        assert_eq!(value["status"], json!("Active"));
        let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["ageDays", "createdAt", "id", "lastUsedAt", "lastUsedRegion", "lastUsedService", "status"]);
        assert_eq!(serde_json::to_value(KeyStatus::Inactive).unwrap(), json!("Inactive"));
    }
}
