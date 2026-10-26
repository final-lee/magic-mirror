//! 정책 붙이기 선택용 목록: 고객 관리형 + AWS 관리형을 한 번 읽어 두고 이름으로 거른다.
//! 문서는 가져오지 않으니 배지는 알려진 AWS 관리형 정책 이름으로만 단다.

use aws_sdk_iam::types::{Policy, PolicyScopeType};
use serde::Serialize;

use crate::error::{from_sdk, AppError};
use crate::iam::model::{Scope, Snapshot};
use crate::iam::view::{Badge, BadgeKind, Level};

/// 붙이기 선택 목록에서 한 번에 보여 주는 최대 개수.
pub const MAX_RESULTS: usize = 100;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRef {
    pub arn: String,
    pub name: String,
    pub scope: Scope,
    pub description: Option<String>,
    pub badges: Vec<Badge>,
}

/// 모든 작업을 열어 주는 AWS 관리형 정책(PowerUserAccess는 IAM 등 몇 서비스만 뺀 거의 전부다).
const ADMIN_POLICIES: [&str; 2] = ["arn:aws:iam::aws:policy/AdministratorAccess", "arn:aws:iam::aws:policy/PowerUserAccess"];
/// IAM을 통째로 여는 AWS 관리형 정책이라 권한 상승에 쓸 수 있다.
const PRIVESC_POLICIES: [&str; 1] = ["arn:aws:iam::aws:policy/IAMFullAccess"];

fn name_badges(arn: &str) -> Vec<Badge> {
    if ADMIN_POLICIES.contains(&arn) {
        vec![Badge::new(BadgeKind::Admin, "관리자급", Level::Danger)]
    } else if PRIVESC_POLICIES.contains(&arn) {
        vec![Badge::new(BadgeKind::Privesc, "권한 상승 위험", Level::Warn)]
    } else {
        Vec::new()
    }
}

/// 붙일 수 없는 정책(`IsAttachable`이 거짓)과 이름·ARN이 없는 항목은 뺀다. 설명은 `ListPolicies`가 주지 않으니 `describe`가 채운다.
fn policy_ref(policy: &Policy) -> Option<PolicyRef> {
    if !policy.is_attachable() {
        return None;
    }
    let (arn, name) = (policy.arn()?, policy.policy_name()?);
    Some(PolicyRef {
        arn: arn.to_string(),
        name: name.to_string(),
        scope: if arn.split(':').nth(4) == Some("aws") { Scope::Aws } else { Scope::Local },
        description: None,
        badges: name_badges(arn),
    })
}

/// 고객 관리형이 먼저, 각각 이름순(대소문자 무시).
pub(crate) fn build_refs<'a>(policies: impl IntoIterator<Item = &'a Policy>) -> Vec<PolicyRef> {
    let mut refs: Vec<PolicyRef> = policies.into_iter().filter_map(policy_ref).collect();
    refs.sort_by_cached_key(|p| (p.scope == Scope::Aws, p.name.to_lowercase(), p.arn.clone()));
    refs
}

pub(crate) async fn fetch_refs(client: &aws_sdk_iam::Client) -> Result<Vec<PolicyRef>, AppError> {
    let mut pages = client.list_policies().scope(PolicyScopeType::All).only_attached(false).into_paginator().page_size(1000).send();
    let mut policies: Vec<Policy> = Vec::new();
    while let Some(page) = pages.next().await {
        policies.extend(page.map_err(|e| from_sdk(e, "iam:ListPolicies"))?.policies().iter().cloned());
    }
    Ok(build_refs(&policies))
}

/// 이름에 `query`가 든(대소문자 무시) 정책을 목록 순서대로 `limit`개까지. 빈 검색어는 처음부터 `limit`개다.
pub fn search(all: &[PolicyRef], query: &str, limit: usize) -> Vec<PolicyRef> {
    let query = query.trim().to_lowercase();
    all.iter().filter(|p| query.is_empty() || p.name.to_lowercase().contains(&query)).take(limit).cloned().collect()
}

/// 고객 관리형 정책의 설명을 스냅숏에서 채운다(`ListPolicies`는 설명을 돌려주지 않는다). AWS 관리형과 설명이 없는 정책은 null이다.
pub fn describe(mut refs: Vec<PolicyRef>, s: &Snapshot) -> Vec<PolicyRef> {
    for p in &mut refs {
        p.description = match p.scope {
            Scope::Local => s.policies.get(&p.arn).and_then(|rec| rec.description.clone()).filter(|d| !d.is_empty()),
            Scope::Aws => None,
        };
    }
    refs
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::iam::model::ManagedPolicyRec;

    fn policy(name: &str, arn: &str, attachable: bool) -> Policy {
        Policy::builder().policy_name(name).arn(arn).is_attachable(attachable).build()
    }

    fn local(name: &str) -> Policy {
        policy(name, &format!("arn:aws:iam::111111111111:policy/{name}"), true)
    }

    fn aws(name: &str) -> Policy {
        policy(name, &format!("arn:aws:iam::aws:policy/{name}"), true)
    }

    fn names(refs: &[PolicyRef]) -> Vec<&str> {
        refs.iter().map(|p| p.name.as_str()).collect()
    }

    #[test]
    fn customer_policies_come_first_then_aws_each_by_name() {
        let refs = build_refs(&[aws("Zeta"), local("beta"), aws("alpha"), local("Alpha")]);
        assert_eq!(names(&refs), vec!["Alpha", "beta", "alpha", "Zeta"]);
        assert_eq!(refs[0].scope, Scope::Local);
        assert_eq!(refs[2].scope, Scope::Aws);
    }

    #[test]
    fn unattachable_and_incomplete_entries_are_dropped() {
        let nameless = Policy::builder().arn("arn:aws:iam::aws:policy/X").is_attachable(true).build();
        let arnless = Policy::builder().policy_name("x").is_attachable(true).build();
        let refs = build_refs(&[policy("Old", "arn:aws:iam::aws:policy/Old", false), nameless, arnless, aws("Ok")]);
        assert_eq!(names(&refs), vec!["Ok"]);
    }

    #[test]
    fn the_list_itself_carries_no_descriptions() {
        // ListPolicies는 설명을 돌려주지 않는다. 값이 들어 있어도 믿지 않고 스냅숏에서 채운다
        let with = Policy::builder().policy_name("a").arn("arn:aws:iam::1:policy/a").is_attachable(true).description("읽기 전용").build();
        let refs = build_refs(&[with, local("c")]);
        assert!(refs.iter().all(|p| p.description.is_none()), "{refs:?}");
    }

    #[test]
    fn descriptions_come_from_the_snapshot_for_customer_policies_only() {
        let mut s = Snapshot::default();
        let mut add = |arn: &str, scope: Scope, description: Option<&str>| {
            let rec = ManagedPolicyRec { arn: arn.into(), name: arn.rsplit('/').next().unwrap().into(), scope, description: description.map(str::to_string), ..Default::default() };
            s.policies.insert(arn.into(), rec);
        };
        add("arn:aws:iam::111111111111:policy/a", Scope::Local, Some("읽기 전용"));
        add("arn:aws:iam::111111111111:policy/b", Scope::Local, Some(""));
        add("arn:aws:iam::aws:policy/X", Scope::Aws, Some("AWS가 붙인 설명"));
        let refs = build_refs(&[local("a"), local("b"), local("gone"), aws("X")]);
        let described = describe(refs, &s);
        let found: Vec<(&str, Option<&str>)> = described.iter().map(|p| (p.name.as_str(), p.description.as_deref())).collect();
        // 빈 설명과 스냅숏에 없는 정책은 null, AWS 관리형은 늘 null이다
        assert_eq!(found, vec![("a", Some("읽기 전용")), ("b", None), ("gone", None), ("X", None)]);
    }

    #[test]
    fn well_known_aws_policies_get_badges_by_name_only() {
        let refs = build_refs(&[aws("AdministratorAccess"), aws("PowerUserAccess"), aws("IAMFullAccess"), aws("AmazonS3FullAccess"), local("AdministratorAccess")]);
        let badge_kinds = |name: &str, scope: Scope| refs.iter().find(|p| p.name == name && p.scope == scope).unwrap().badges.iter().map(|b| b.kind).collect::<Vec<_>>();
        assert_eq!(badge_kinds("AdministratorAccess", Scope::Aws), vec![BadgeKind::Admin]);
        assert_eq!(badge_kinds("PowerUserAccess", Scope::Aws), vec![BadgeKind::Admin]);
        assert_eq!(badge_kinds("IAMFullAccess", Scope::Aws), vec![BadgeKind::Privesc]);
        assert!(badge_kinds("AmazonS3FullAccess", Scope::Aws).is_empty());
        // 이름이 같아도 고객 관리형은 내용을 모르니 배지를 달지 않는다
        assert!(badge_kinds("AdministratorAccess", Scope::Local).is_empty());
        assert_eq!(refs.iter().find(|p| p.name == "AdministratorAccess" && p.scope == Scope::Aws).unwrap().badges[0], Badge::new(BadgeKind::Admin, "관리자급", Level::Danger));
    }

    #[test]
    fn search_is_a_case_insensitive_contains_in_list_order() {
        let all = build_refs(&[local("DevReadOnly"), local("deploy"), aws("ReadOnlyAccess"), aws("AmazonS3ReadOnlyAccess"), aws("AdministratorAccess")]);
        assert_eq!(names(&search(&all, "readonly", 100)), vec!["DevReadOnly", "AmazonS3ReadOnlyAccess", "ReadOnlyAccess"]);
        assert_eq!(names(&search(&all, "  DEP ", 100)), vec!["deploy"]);
        assert!(search(&all, "nothing-matches", 100).is_empty());
        assert_eq!(names(&search(&all, "", 2)), vec!["deploy", "DevReadOnly"]);
        assert_eq!(search(&all, "", 100).len(), 5);
    }

    #[test]
    fn search_stops_at_the_limit() {
        let many: Vec<Policy> = (0..250).map(|i| local(&format!("p{i:03}"))).collect();
        let all = build_refs(&many);
        assert_eq!(search(&all, "p", MAX_RESULTS).len(), 100);
        assert_eq!(search(&all, "p", MAX_RESULTS)[0].name, "p000");
    }

    #[test]
    fn json_shape_matches_the_contract() {
        let refs = build_refs(&[aws("AdministratorAccess")]);
        assert_eq!(
            serde_json::to_value(&refs[0]).unwrap(),
            json!({
                "arn": "arn:aws:iam::aws:policy/AdministratorAccess", "name": "AdministratorAccess", "scope": "aws", "description": null,
                "badges": [{ "kind": "admin", "label": "관리자급", "level": "danger" }]
            })
        );
    }
}
