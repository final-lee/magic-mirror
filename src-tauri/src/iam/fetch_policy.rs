//! 스냅숏에 없는 관리형 정책을 붙이려 할 때 그 정책의 기본 버전 문서를 그 자리에서 읽는다(읽기 전용 호출: GetPolicy, GetPolicyVersion).
//! 스냅숏에는 어딘가에 붙은 AWS 관리형 정책만 들어 있어서, 아직 아무도 쓰지 않는 정책을 붙일 때 이 문서가 있어야 영향을 계산할 수 있다.

use std::sync::Arc;

use aws_sdk_iam::types::{Policy, PolicyVersion};

use crate::error::{from_sdk, AppError};
use crate::iam::change::{missing_policy, IamChange};
use crate::iam::clock::iso_of;
use crate::iam::model::{ManagedPolicyRec, Scope, Snapshot, VersionRec};
use crate::iam::policy::{decode_document, parse_document};

/// ARN의 계정 칸이 `aws`면 AWS 관리형이다.
fn scope_of(arn: &str) -> Scope {
    if arn.split(':').nth(4) == Some("aws") {
        Scope::Aws
    } else {
        Scope::Local
    }
}

/// 정책 정보와 기본 버전으로 스냅숏의 정책 기록을 만든다. 문서를 못 읽거나 해석하지 못하면 `document`는 None이다.
fn record(arn: &str, policy: &Policy, version: Option<&PolicyVersion>) -> ManagedPolicyRec {
    let raw = version.and_then(|v| v.document()).map(decode_document);
    let document = raw.as_deref().and_then(|text| parse_document(text).ok());
    let default_id = policy.default_version_id();
    ManagedPolicyRec {
        arn: arn.to_string(),
        name: policy.policy_name().unwrap_or_else(|| arn.rsplit('/').next().unwrap_or(arn)).to_string(),
        scope: scope_of(arn),
        description: policy.description().map(str::to_string),
        default_version_id: default_id.map(str::to_string),
        attachment_count: policy.attachment_count().unwrap_or(0),
        updated_at: iso_of(policy.update_date()),
        raw,
        document,
        versions: default_id
            .map(|id| VersionRec { id: id.to_string(), is_default: true, created_at: iso_of(version.and_then(|v| v.create_date())) })
            .into_iter()
            .collect(),
    }
}

/// 관리형 정책 하나를 읽는다: `GetPolicy`로 기본 버전 번호를, `GetPolicyVersion`으로 그 문서를.
pub(crate) async fn fetch_policy(client: &aws_sdk_iam::Client, arn: &str) -> Result<ManagedPolicyRec, AppError> {
    let out = client.get_policy().policy_arn(arn).send().await.map_err(|e| from_sdk(e, "iam:GetPolicy"))?;
    let policy = out.policy().ok_or_else(|| AppError::other("정책 정보가 비어 있어요"))?;
    let version = match policy.default_version_id() {
        Some(id) => client.get_policy_version().policy_arn(arn).version_id(id).send().await.map_err(|e| from_sdk(e, "iam:GetPolicyVersion"))?.policy_version().cloned(),
        None => None,
    };
    Ok(record(arn, policy, version.as_ref()))
}

/// 변경이 붙이려는 정책의 문서가 스냅숏에 없으면 읽어서 넣은 스냅숏을 돌려준다(캐시된 스냅숏은 건드리지 않는다).
/// 읽지 못하면 스냅숏을 그대로 돌려준다: 미리보기가 "문서를 읽지 못했어요" 주의와 함께 영향 계산 없이 나온다.
pub(crate) async fn ensure_policy(client: &aws_sdk_iam::Client, s: Arc<Snapshot>, c: &IamChange) -> Arc<Snapshot> {
    let Some(arn) = missing_policy(&s, c) else {
        return s;
    };
    match fetch_policy(client, arn).await {
        Ok(rec) => {
            let mut owned = (*s).clone();
            owned.policies.insert(arn.to_string(), rec);
            Arc::new(owned)
        }
        Err(_) => s,
    }
}

#[cfg(test)]
mod tests {
    use aws_smithy_types::DateTime;

    use super::*;
    use crate::adapters::util::url_encode;
    use crate::error::AppError;
    use crate::iam::change::{preview, WarnLevel};
    use crate::iam::fixtures::{self, ADMIN_POLICY, BOB};
    use crate::iam::mock_aws::{error_xml, ok_with, Recorder, Sent};
    use crate::iam::model::Scope;

    const ABSENT: &str = "arn:aws:iam::aws:policy/FullAdminClone";
    const ADMIN_DOC: &str = r#"{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}"#;

    fn sdk_policy(arn: &str) -> Policy {
        Policy::builder()
            .arn(arn)
            .policy_name(arn.rsplit('/').next().unwrap())
            .default_version_id("v4")
            .attachment_count(2)
            .description("설명")
            .update_date(DateTime::from_secs(1_767_323_045))
            .build()
    }

    fn sdk_version(document: &str) -> PolicyVersion {
        PolicyVersion::builder().document(url_encode(document)).version_id("v4").is_default_version(true).create_date(DateTime::from_secs(1_767_323_045)).build()
    }

    fn policy_xml(arn: &str) -> String {
        let name = arn.rsplit('/').next().unwrap();
        ok_with(
            "GetPolicy",
            &format!(
                "<Policy><PolicyName>{name}</PolicyName><PolicyId>ANPAEXAMPLE</PolicyId><Arn>{arn}</Arn><Path>/</Path><DefaultVersionId>v4</DefaultVersionId><AttachmentCount>0</AttachmentCount><IsAttachable>true</IsAttachable><UpdateDate>2026-01-02T03:04:05Z</UpdateDate></Policy>"
            ),
        )
    }

    fn version_xml(document: &str) -> String {
        ok_with(
            "GetPolicyVersion",
            &format!("<PolicyVersion><Document>{}</Document><VersionId>v4</VersionId><IsDefaultVersion>true</IsDefaultVersion><CreateDate>2026-01-02T03:04:05Z</CreateDate></PolicyVersion>", url_encode(document)),
        )
    }

    /// 어떤 정책이든 `document`를 기본 버전 문서로 가진 것처럼 답한다.
    fn serving(document: &'static str) -> Recorder {
        Recorder::new(move |sent: &Sent| match sent.action.as_str() {
            "GetPolicy" => (200, policy_xml(&sent.params["PolicyArn"])),
            "GetPolicyVersion" => (200, version_xml(document)),
            other => (400, error_xml("InvalidAction", other)),
        })
    }

    fn actions(recorder: &Recorder) -> Vec<String> {
        recorder.sent().into_iter().map(|s| s.action).collect()
    }

    fn attach_absent() -> IamChange {
        IamChange::AttachPolicy { target: BOB.into(), policy_arn: ABSENT.into() }
    }

    #[test]
    fn a_record_carries_the_policy_facts_and_the_decoded_default_document() {
        let rec = record(ABSENT, &sdk_policy(ABSENT), Some(&sdk_version(ADMIN_DOC)));
        assert_eq!((rec.arn.as_str(), rec.name.as_str(), rec.scope), (ABSENT, "FullAdminClone", Scope::Aws));
        assert_eq!(rec.description.as_deref(), Some("설명"));
        assert_eq!((rec.default_version_id.as_deref(), rec.attachment_count), (Some("v4"), 2));
        assert_eq!(rec.updated_at.as_deref(), Some("2026-01-02T03:04:05Z"));
        assert_eq!(rec.raw.as_deref(), Some(ADMIN_DOC), "URL 인코딩을 푼 문서");
        assert_eq!(rec.document.as_ref().map(|d| d.statements.len()), Some(1));
        assert_eq!(rec.versions.len(), 1);
        assert_eq!((rec.versions[0].id.as_str(), rec.versions[0].is_default), ("v4", true));
        assert_eq!(rec.versions[0].created_at.as_deref(), Some("2026-01-02T03:04:05Z"));
    }

    #[test]
    fn a_policy_of_this_account_is_local() {
        let arn = "arn:aws:iam::111111111111:policy/mine";
        assert_eq!(record(arn, &sdk_policy(arn), Some(&sdk_version(ADMIN_DOC))).scope, Scope::Local);
    }

    #[test]
    fn a_document_that_does_not_parse_or_is_missing_leaves_the_policy_unreadable() {
        let broken = record(ABSENT, &sdk_policy(ABSENT), Some(&sdk_version("{not json")));
        assert_eq!(broken.raw.as_deref(), Some("{not json"));
        assert!(broken.document.is_none());
        let missing = record(ABSENT, &sdk_policy(ABSENT), None);
        assert!(missing.raw.is_none() && missing.document.is_none());
        assert_eq!(missing.name, "FullAdminClone");
    }

    #[test]
    fn a_policy_without_a_name_falls_back_to_the_arn() {
        let nameless = Policy::builder().arn(ABSENT).default_version_id("v1").build();
        assert_eq!(record(ABSENT, &nameless, None).name, "FullAdminClone");
    }

    #[tokio::test]
    async fn fetching_reads_the_policy_then_its_default_version() {
        let recorder = serving(ADMIN_DOC);
        let rec = fetch_policy(&recorder.client(), ABSENT).await.unwrap();
        assert_eq!(actions(&recorder), vec!["GetPolicy", "GetPolicyVersion"]);
        let sent = recorder.sent();
        assert_eq!(sent[0].params["PolicyArn"], ABSENT);
        assert_eq!((sent[1].params["PolicyArn"].as_str(), sent[1].params["VersionId"].as_str()), (ABSENT, "v4"));
        assert_eq!(rec.name, "FullAdminClone");
        assert!(rec.document.is_some());
    }

    #[tokio::test]
    async fn a_failed_policy_read_is_an_error_and_stops_there() {
        let recorder = Recorder::new(|_| (403, error_xml("AccessDenied", "no")));
        let err = fetch_policy(&recorder.client(), ABSENT).await.unwrap_err();
        assert_eq!(err, AppError::AccessDenied { action: "iam:GetPolicy".into() });
        assert_eq!(actions(&recorder), vec!["GetPolicy"]);

        let recorder = Recorder::new(|sent| match sent.action.as_str() {
            "GetPolicy" => (200, policy_xml(ABSENT)),
            _ => (403, error_xml("AccessDenied", "no")),
        });
        let err = fetch_policy(&recorder.client(), ABSENT).await.unwrap_err();
        assert_eq!(err, AppError::AccessDenied { action: "iam:GetPolicyVersion".into() });
    }

    #[tokio::test]
    async fn a_missing_policy_is_fetched_into_a_copy_of_the_snapshot() {
        let recorder = serving(ADMIN_DOC);
        let original = Arc::new(fixtures::snapshot());
        let enriched = ensure_policy(&recorder.client(), original.clone(), &attach_absent()).await;
        assert!(!Arc::ptr_eq(&original, &enriched));
        assert!(enriched.policies[ABSENT].document.is_some());
        assert!(!original.policies.contains_key(ABSENT), "캐시된 스냅숏은 그대로예요");
        assert_eq!(enriched.users.len(), original.users.len());
        assert_eq!(actions(&recorder), vec!["GetPolicy", "GetPolicyVersion"]);
    }

    #[tokio::test]
    async fn nothing_is_fetched_when_the_snapshot_already_has_the_document_or_the_change_needs_none() {
        let recorder = serving(ADMIN_DOC);
        let original = Arc::new(fixtures::snapshot());
        let have = IamChange::AttachPolicy { target: BOB.into(), policy_arn: ADMIN_POLICY.into() };
        let detach = IamChange::DetachPolicy { target: BOB.into(), policy_arn: ABSENT.into() };
        let key = IamChange::DeleteAccessKey { user_name: "bob".into(), access_key_id: "AKIA1".into() };
        for change in [have, detach, key] {
            let same = ensure_policy(&recorder.client(), original.clone(), &change).await;
            assert!(Arc::ptr_eq(&original, &same), "{change:?}");
        }
        assert!(recorder.sent().is_empty());
    }

    #[tokio::test]
    async fn a_policy_that_cannot_be_read_leaves_the_snapshot_as_it_was() {
        let recorder = Recorder::new(|_| (403, error_xml("AccessDenied", "no")));
        let original = Arc::new(fixtures::snapshot());
        let same = ensure_policy(&recorder.client(), original.clone(), &attach_absent()).await;
        assert!(Arc::ptr_eq(&original, &same));
    }

    #[tokio::test]
    async fn the_preview_sees_the_fetched_policy_and_asks_for_confirmation() {
        let recorder = serving(ADMIN_DOC);
        let original = Arc::new(fixtures::snapshot());
        let change = attach_absent();

        let blind = preview(&original, &change, None);
        assert!(blind.impacts.is_empty());
        assert!(blind.warnings.iter().any(|w| w.level == WarnLevel::Warn && w.message == "정책 문서를 읽지 못해 권한 변화를 계산하지 못했어요"));
        assert_eq!(blind.confirm_text, None);

        let enriched = ensure_policy(&recorder.client(), original, &change).await;
        let seen = preview(&enriched, &change, None);
        assert_eq!(seen.impacts.len(), 1);
        assert_eq!(seen.impacts[0].principal.name, "bob");
        assert!(seen.warnings.iter().any(|w| w.level == WarnLevel::Confirm && w.message.contains("관리자급")));
        assert_eq!(seen.confirm_text.as_deref(), Some("bob"));
        assert!(!seen.warnings.iter().any(|w| w.message.contains("읽지 못")));
        assert_eq!(seen.summary, "bob에 FullAdminClone 붙이기");
    }
}
