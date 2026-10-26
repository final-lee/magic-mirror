//! 사용자의 액세스 키: 상태·나이·마지막 사용, 그리고 점검의 빠른 조치에 쓰는 키 목록. 키 ID만 다루고 비밀 키는 다루지 않는다.

use std::future::Future;

use aws_sdk_iam::types::{AccessKeyLastUsed, AccessKeyMetadata, StatusType};
use futures::future::join_all;
use futures::stream::{self, StreamExt};
use serde::Serialize;

use crate::error::{from_sdk, AppError};
use crate::iam::clock::{days_between, iso_of};
use crate::iam::findings::{ListedKey, ListedKeys};

/// 점검의 빠른 조치용 키 목록을 한꺼번에 몇 명까지 읽을지. 점검은 첫 화면이고 그 화면에서 적용한 뒤에도 다시 읽어서 적게 둔다.
const KEY_LIST_CONCURRENCY: usize = 5;

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
    /// 마지막 사용을 읽지 못했다(권한 없음 등). 참이면 `last_used_*`가 비어 있어도 "한 번도 안 씀"이 아니다
    pub last_used_unknown: bool,
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
        last_used_unknown: false,
    }
}

/// 키 목록과 키마다 `GetAccessKeyLastUsed` 결과를 합쳐 만든 순서대로 늘어놓는다. SSO 만료·요청 제한은 요청 전체의 오류다.
fn key_infos(metas: &[AccessKeyMetadata], used: Vec<Result<Option<AccessKeyLastUsed>, AppError>>, now: i64) -> Result<Vec<AccessKeyInfo>, AppError> {
    if let Some(fatal) = used.iter().filter_map(|r| r.as_ref().err()).find(|e| matches!(e, AppError::SsoExpired | AppError::Throttled)) {
        return Err(fatal.clone());
    }
    let mut keys: Vec<AccessKeyInfo> = metas
        .iter()
        .zip(used)
        .map(|(meta, used)| {
            // 못 읽었거나(권한 없음 등) AWS가 마지막 사용 정보를 비워 보냈으면 "모름"이다. 키 목록은 그대로 보여 준다
            let used = used.ok().flatten();
            let mut info = key_info(meta, used.as_ref(), now);
            info.last_used_unknown = used.is_none();
            info
        })
        .collect();
    keys.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
    Ok(keys)
}

async fn last_used(client: &aws_sdk_iam::Client, key_id: &str) -> Result<Option<AccessKeyLastUsed>, AppError> {
    let out = client.get_access_key_last_used().access_key_id(key_id).send().await.map_err(|e| from_sdk(e, "iam:GetAccessKeyLastUsed"))?;
    Ok(out.access_key_last_used().cloned())
}

/// 사용자의 액세스 키 목록(`ListAccessKeys`, 끝까지).
async fn list_metadata(client: &aws_sdk_iam::Client, user_name: &str) -> Result<Vec<AccessKeyMetadata>, AppError> {
    let mut pages = client.list_access_keys().user_name(user_name).into_paginator().send();
    let mut metas: Vec<AccessKeyMetadata> = Vec::new();
    while let Some(page) = pages.next().await {
        metas.extend(page.map_err(|e| from_sdk(e, "iam:ListAccessKeys"))?.access_key_metadata().iter().cloned());
    }
    Ok(metas)
}

/// 사용자의 액세스 키를 만든 순서대로. 마지막 사용을 못 읽어도(권한 없음 등) 키 목록은 보여 주되 그 키는 `last_used_unknown`으로 표시하고,
/// SSO 만료·요청 제한은 오류로 돌려준다.
pub(crate) async fn fetch_keys(client: &aws_sdk_iam::Client, user_name: &str, now: i64) -> Result<Vec<AccessKeyInfo>, AppError> {
    let metas = list_metadata(client, user_name).await?;
    let used = join_all(metas.iter().map(|meta| last_used(client, meta.access_key_id().unwrap_or_default()))).await;
    key_infos(&metas, used, now)
}

fn listed_key(meta: &AccessKeyMetadata) -> ListedKey {
    ListedKey {
        id: meta.access_key_id().unwrap_or_default().to_string(),
        active: meta.status() == Some(&StatusType::Active),
        created: meta.create_date().map(|created| created.secs()),
    }
}

/// 사용자마다 `list`로 키 목록을 읽는다(`KEY_LIST_CONCURRENCY`명씩 동시에). 빠른 조치는 없어도 되는 것이라 목록을 못 읽은 사용자
/// (권한 없음, 요청 제한 등)는 그 오류로 남긴다. SSO 만료만 전체 오류다: 다시 로그인해야 점검도 다시 읽을 수 있다.
async fn list_each<F, Fut>(users: Vec<String>, list: F) -> Result<ListedKeys, AppError>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = (String, Result<Vec<ListedKey>, AppError>)>,
{
    let results: Vec<(String, Result<Vec<ListedKey>, AppError>)> = stream::iter(users).map(list).buffered(KEY_LIST_CONCURRENCY).collect().await;
    if results.iter().any(|(_, keys)| matches!(keys, Err(AppError::SsoExpired))) {
        return Err(AppError::SsoExpired);
    }
    Ok(results.into_iter().collect())
}

/// 점검의 빠른 조치를 만들려고 사용자들의 키 목록을 읽는다(읽기만, 마지막 사용은 읽지 않는다). 규칙은 `list_each`다.
pub(crate) async fn list_keys(client: &aws_sdk_iam::Client, users: Vec<String>) -> Result<ListedKeys, AppError> {
    list_each(users, |user| async move {
        let keys = list_metadata(client, &user).await.map(|metas| metas.iter().map(listed_key).collect());
        (user, keys)
    })
    .await
}

#[cfg(test)]
mod tests {
    use aws_smithy_types::DateTime;
    use serde_json::json;

    use super::*;
    use crate::iam::clock::{iso, parse_iso, DAY_SECS};
    use crate::iam::mock_aws::{error_xml, ok_with, Recorder, Sent};

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
        assert!(!info.last_used_unknown);
        // 마지막 사용 정보가 없으면 칸은 비어 있다. "모름" 표시는 `key_infos`가 단다
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
        assert_eq!(keys, vec!["ageDays", "createdAt", "id", "lastUsedAt", "lastUsedRegion", "lastUsedService", "lastUsedUnknown", "status"]);
        assert_eq!(value["lastUsedUnknown"], json!(false));
        assert_eq!(serde_json::to_value(KeyStatus::Inactive).unwrap(), json!("Inactive"));
    }

    fn denied() -> AppError {
        AppError::AccessDenied { action: "iam:GetAccessKeyLastUsed".into() }
    }

    #[test]
    fn a_last_use_that_could_not_be_read_is_unknown_not_never_used() {
        let never = AccessKeyLastUsed::builder().service_name("N/A").region("N/A").build().unwrap();
        let metas = [meta("AKIA1", StatusType::Active, 200), meta("AKIA2", StatusType::Active, 100), meta("AKIA3", StatusType::Active, 50), meta("AKIA4", StatusType::Active, 10)];
        let results = vec![Err(denied()), Ok(Some(used(5, "s3", "us-east-1"))), Ok(Some(never)), Ok(None)];
        let keys = key_infos(&metas, results, now()).unwrap();
        let ids: Vec<&str> = keys.iter().map(|k| k.id.as_str()).collect();
        assert_eq!(ids, vec!["AKIA1", "AKIA2", "AKIA3", "AKIA4"]);
        // 권한이 없어 못 읽었다: 한 번도 안 쓴 것처럼 보이면 안 된다
        assert!(keys[0].last_used_unknown);
        assert_eq!((keys[0].last_used_at.clone(), keys[0].last_used_service.clone()), (None, None));
        assert_eq!(serde_json::to_value(&keys[0]).unwrap()["lastUsedUnknown"], json!(true));
        // 읽었으면 쓴 기록이 있든 없든 아는 값이다
        assert!(!keys[1].last_used_unknown && keys[1].last_used_at.is_some());
        assert!(!keys[2].last_used_unknown && keys[2].last_used_at.is_none());
        // 성공했는데 마지막 사용 정보가 비어 있으면 그것도 모르는 것이다
        assert!(keys[3].last_used_unknown);
    }

    fn keys_xml(members: &[(&str, &str, &str)]) -> String {
        let members: String = members
            .iter()
            .map(|(id, status, created)| format!("<member><UserName>u</UserName><AccessKeyId>{id}</AccessKeyId><Status>{status}</Status><CreateDate>{created}</CreateDate></member>"))
            .collect();
        ok_with("ListAccessKeys", &format!("<AccessKeyMetadata>{members}</AccessKeyMetadata><IsTruncated>false</IsTruncated>"))
    }

    #[tokio::test]
    async fn key_lists_for_quick_fixes_are_read_per_user_and_failures_stay_with_their_user() {
        let recorder = Recorder::new(|sent: &Sent| match sent.params.get("UserName").map(String::as_str) {
            Some("alice") => (200, keys_xml(&[("AKIAALICE1", "Active", "2026-04-09T00:00:00Z"), ("AKIAALICE2", "Inactive", "2026-10-01T12:30:15Z")])),
            Some("bob") => (403, error_xml("AccessDenied", "no")),
            _ => (200, keys_xml(&[])),
        });
        let listed = list_keys(&recorder.client(), vec!["alice".into(), "bob".into(), "carol".into()]).await.unwrap();
        assert_eq!(
            listed["alice"],
            Ok(vec![
                ListedKey { id: "AKIAALICE1".into(), active: true, created: parse_iso("2026-04-09T00:00:00Z") },
                ListedKey { id: "AKIAALICE2".into(), active: false, created: parse_iso("2026-10-01T12:30:15Z") },
            ])
        );
        assert_eq!(listed["bob"], Err(AppError::AccessDenied { action: "iam:ListAccessKeys".into() }));
        assert_eq!(listed["carol"], Ok(Vec::new()));
        // 키 목록만 읽는다: 마지막 사용(GetAccessKeyLastUsed)도, 쓰기 호출도 없다
        let sent = recorder.sent();
        assert_eq!(sent.len(), 3);
        assert!(sent.iter().all(|s| s.action == "ListAccessKeys"), "{sent:?}");
    }

    #[tokio::test]
    async fn only_sso_expiry_while_listing_keys_for_quick_fixes_fails_the_findings() {
        let recorder = Recorder::new(|sent: &Sent| match sent.params.get("UserName").map(String::as_str) {
            Some("bob") => (400, error_xml("ExpiredToken", "no")),
            _ => (200, keys_xml(&[])),
        });
        assert_eq!(list_keys(&recorder.client(), vec!["alice".into(), "bob".into()]).await, Err(AppError::SsoExpired));

        // 요청 제한은 빠른 조치만 못 만드는 일이라 그 사용자에게만 남는다(점검 화면은 그대로 열린다)
        let recorder = Recorder::new(|sent: &Sent| match sent.params.get("UserName").map(String::as_str) {
            Some("bob") => (400, error_xml("Throttling", "Rate exceeded")),
            _ => (200, keys_xml(&[("AKIAALICE1", "Active", "2026-04-09T00:00:00Z")])),
        });
        let listed = list_keys(&recorder.client(), vec!["alice".into(), "bob".into()]).await.unwrap();
        assert_eq!(listed["bob"], Err(AppError::Throttled));
        assert!(matches!(&listed["alice"], Ok(keys) if keys.len() == 1));
        assert_eq!(list_keys(&Recorder::ok().client(), Vec::new()).await, Ok(ListedKeys::new()));
    }

    #[tokio::test]
    async fn key_lists_are_read_for_at_most_five_users_at_a_time() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (running, most) = (AtomicUsize::new(0), AtomicUsize::new(0));
        let users: Vec<String> = (0..12).map(|i| format!("user{i}")).collect();
        let listed = list_each(users.clone(), |user| {
            let (running, most) = (&running, &most);
            async move {
                most.fetch_max(running.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                // 읽는 동안 한 번 양보해서 다른 사용자의 읽기가 함께 돌 틈을 준다
                tokio::task::yield_now().await;
                running.fetch_sub(1, Ordering::SeqCst);
                (user, Ok(Vec::new()))
            }
        })
        .await
        .unwrap();
        assert_eq!(listed.keys().cloned().collect::<std::collections::BTreeSet<String>>(), users.into_iter().collect());
        assert_eq!(most.load(Ordering::SeqCst), 5, "한꺼번에 5명까지만 읽어요");
    }

    #[test]
    fn sso_expiry_and_throttling_fail_the_whole_request() {
        for fatal in [AppError::SsoExpired, AppError::Throttled] {
            let results = vec![Ok(Some(used(1, "s3", "us-east-1"))), Err(denied()), Err(fatal.clone())];
            let metas = [meta("A", StatusType::Active, 3), meta("B", StatusType::Active, 2), meta("C", StatusType::Active, 1)];
            assert_eq!(key_infos(&metas, results, now()), Err(fatal));
        }
        assert_eq!(key_infos(&[], Vec::new(), now()), Ok(Vec::new()));
    }
}
