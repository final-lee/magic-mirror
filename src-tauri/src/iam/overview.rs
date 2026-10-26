//! 개요 화면 값: 사용자·그룹·역할·정책 요약에, 자격 증명 보고서에서 알 수 있는 사용자 배지와 마지막 사용 시각을 합친다. 순수 코드다.

use serde::Serialize;

use super::findings::{credential_badges, findings, user_last_used};
use super::model::Snapshot;
use super::summary::summaries;
use super::view::{PolicySummary, PrincipalKind, PrincipalSummary};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caller {
    /// `GetCallerIdentity`가 돌려준 ARN
    pub arn: String,
    /// 앱이 쓰는 자격 증명의 IAM 사용자·역할 ARN(SSO 역할 포함). 알 수 없으면 None
    pub principal_arn: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IamOverview {
    pub account_id: String,
    pub caller: Caller,
    pub fetched_at: String,
    pub users: Vec<PrincipalSummary>,
    pub groups: Vec<PrincipalSummary>,
    pub roles: Vec<PrincipalSummary>,
    /// 고객 관리형 전체 + 어딘가에 붙어 있는 AWS 관리형
    pub policies: Vec<PolicySummary>,
    /// 점검 항목 수(모든 그룹의 합)
    pub finding_count: usize,
    pub warnings: Vec<String>,
}

/// 사용자 요약에 자격 증명 보고서의 배지(MFA 없음·오래된 키 등)와 마지막 사용 시각을 넣는다. 사용자가 아니면 그대로 둔다.
pub fn apply_credentials(s: &Snapshot, summary: &mut PrincipalSummary, now: i64) {
    if summary.kind != PrincipalKind::User {
        return;
    }
    summary.badges.extend(credential_badges(s, &summary.arn, now));
    if let Some(last_used) = user_last_used(s, &summary.arn) {
        summary.last_used = Some(last_used);
    }
}

pub fn overview(s: &Snapshot, now: i64) -> IamOverview {
    let (mut users, groups, roles, policies) = summaries(s);
    for user in &mut users {
        apply_credentials(s, user, now);
    }
    let finding_count = findings(s, now).groups.iter().map(|group| group.items.len()).sum();
    IamOverview {
        account_id: s.account_id.clone(),
        caller: Caller { arn: s.caller_arn.clone(), principal_arn: s.caller_principal_arn.clone() },
        fetched_at: s.fetched_at.clone(),
        users,
        groups,
        roles,
        policies,
        finding_count,
        warnings: s.warnings.clone(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::iam::clock::iso;
    use crate::iam::findings::parse_credential_report;
    use crate::iam::findings::sample::{ago, csv, now};
    use crate::iam::fixtures::{self, ALICE, BOB, CAROL};
    use crate::iam::view::BadgeKind;

    fn snap() -> Snapshot {
        let mut s = fixtures::snapshot();
        s.cred_report = Some(parse_credential_report(&csv()));
        s.warnings.push("샘플 경고".into());
        s
    }

    fn kinds(list: &[PrincipalSummary], name: &str) -> Vec<BadgeKind> {
        list.iter().find(|p| p.name == name).unwrap().badges.iter().map(|b| b.kind).collect()
    }

    #[test]
    fn credential_badges_are_added_after_the_policy_badges_for_users_only() {
        let o = overview(&snap(), now());
        assert_eq!(kinds(&o.users, "alice"), vec![BadgeKind::Admin, BadgeKind::OldKey]);
        assert_eq!(kinds(&o.users, "bob"), vec![BadgeKind::NoMfa, BadgeKind::OldKey, BadgeKind::UnusedKey]);
        assert_eq!(kinds(&o.users, "carol"), vec![BadgeKind::Boundary, BadgeKind::OldKey, BadgeKind::UnusedKey, BadgeKind::Inactive]);
        // 역할과 그룹은 그대로다
        assert_eq!(kinds(&o.groups, "admins"), vec![BadgeKind::Admin]);
        assert_eq!(kinds(&o.roles, "deploy"), vec![BadgeKind::Privesc, BadgeKind::Cfn]);
        assert_eq!(kinds(&o.roles, "vendor"), vec![BadgeKind::ExternalTrust]);
    }

    #[test]
    fn user_last_used_comes_from_the_report_and_roles_keep_theirs() {
        let o = overview(&snap(), now());
        let last = |name: &str| o.users.iter().find(|u| u.name == name).unwrap().last_used.clone();
        assert_eq!(last("alice"), Some(iso(now() - 86_400)));
        assert_eq!(last("bob"), Some(iso(now() - 10 * 86_400)));
        assert_eq!(last("carol"), Some(iso(now() - 100 * 86_400)));
        assert_eq!(o.roles.iter().find(|r| r.name == "deploy").unwrap().last_used.as_deref(), Some("2026-10-20T00:00:00Z"));
        assert_eq!(ago(1).replace("+00:00", "Z"), last("alice").unwrap());
    }

    #[test]
    fn counts_and_identity_fields() {
        let s = snap();
        let o = overview(&s, now());
        assert_eq!(o.account_id, fixtures::ACCOUNT);
        assert_eq!(o.caller, Caller { arn: ALICE.into(), principal_arn: Some(ALICE.into()) });
        assert_eq!(o.fetched_at, "2026-10-26T00:00:00Z");
        assert_eq!(o.warnings, vec!["샘플 경고".to_string()]);
        // 루트 2 + 콘솔 MFA 1 + 오래된 키 3 + 안 쓰는 키 2 + 안 쓰는 사용자 3 + 안 쓰는 역할 3 + 관리자 1 + 권한 상승 1 + 외부 신뢰 2 + 안 붙은 정책 1
        assert_eq!(o.finding_count, 19);
        assert_eq!(o.users.len(), 3);
        assert_eq!(o.groups.len(), 1);
        assert_eq!(o.roles.len(), 6);
        assert_eq!(o.policies.len(), 4);
    }

    #[test]
    fn without_a_report_users_keep_their_plain_summaries() {
        let s = fixtures::snapshot();
        let o = overview(&s, now());
        assert_eq!(kinds(&o.users, "bob"), Vec::<BadgeKind>::new());
        assert!(o.users.iter().all(|u| u.last_used.is_none()));
        // 보고서가 없으면 보고서로 찾는 점검은 빠진다: 안 쓰는 역할 3 + 관리자 1 + 권한 상승 1 + 외부 신뢰 2 + 안 붙은 정책 1
        assert_eq!(o.finding_count, 8);
    }

    #[test]
    fn apply_credentials_leaves_groups_and_roles_alone() {
        let s = snap();
        let (_, groups, roles, _) = summaries(&s);
        for mut summary in groups.into_iter().chain(roles) {
            let before = summary.clone();
            apply_credentials(&s, &mut summary, now());
            assert_eq!(summary, before);
        }
        let mut bob = crate::iam::summary::principal_summary(&s, BOB).unwrap();
        apply_credentials(&s, &mut bob, now());
        assert!(bob.badges.iter().any(|b| b.kind == BadgeKind::NoMfa));
        let mut carol = crate::iam::summary::principal_summary(&s, CAROL).unwrap();
        apply_credentials(&s, &mut carol, now());
        assert_eq!(carol.last_used, Some(iso(now() - 100 * 86_400)));
    }

    #[test]
    fn json_shape_matches_the_contract() {
        let value = serde_json::to_value(overview(&snap(), now())).unwrap();
        let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["accountId", "caller", "fetchedAt", "findingCount", "groups", "policies", "roles", "users", "warnings"]);
        assert_eq!(value["caller"], json!({ "arn": ALICE, "principalArn": ALICE }));
        assert_eq!(value["findingCount"], json!(19));
    }
}
