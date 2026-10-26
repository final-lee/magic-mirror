//! 화면 값 테스트: 권한 표, 칸을 눌렀을 때의 작업 목록, JSON 모양.

use serde_json::{json, Value};

use crate::iam::catalog::{catalog, AccessLevel, LEVELS};
use crate::iam::danger::admin_like_statementwise;
use crate::iam::eval::{principal_actions, principal_view, Status};
use crate::iam::fixtures::*;
use crate::iam::summary::principal_summary;
use crate::iam::view::{AttachedKind, Badge, BadgeKind, LevelCell, PrincipalKind, PrincipalView, ServicePermissions, TrustKind};

fn service<'a>(view: &'a PrincipalView, prefix: &str) -> &'a ServicePermissions {
    view.services.iter().find(|s| s.prefix == prefix).unwrap_or_else(|| panic!("{prefix} 서비스가 없어요"))
}

fn cell(view: &PrincipalView, prefix: &str, level: AccessLevel) -> LevelCell {
    service(view, prefix).levels[&level]
}

fn sorted_keys(value: &Value) -> Vec<&str> {
    let mut keys: Vec<&str> = value.as_object().expect("JSON 객체여야 해요").keys().map(String::as_str).collect();
    keys.sort_unstable();
    keys
}

/// `s3`에서 이름이 `starts`로 시작하는 작업 중 그 수준인 것의 수.
fn s3_count(level: AccessLevel, starts: &[&str]) -> usize {
    catalog().actions("s3").iter().filter(|(name, l)| *l == level && starts.iter().any(|p| name.starts_with(p))).count()
}

#[test]
fn alice_view_lists_every_service_as_admin() {
    let s = snapshot();
    let view = principal_view(&s, ALICE).unwrap();
    assert!(view.admin_like);
    let services_with_actions = catalog().services().filter(|(prefix, _)| !catalog().actions(prefix).is_empty()).count();
    assert_eq!(view.services.len(), services_with_actions);
    let allowed: usize = view.services.iter().flat_map(|svc| svc.levels.values()).map(|c| c.allowed).sum();
    assert_eq!(allowed, catalog().all_count());
    assert!(view.services.iter().all(|svc| svc.danger && svc.levels.len() == LEVELS.len()));
    assert!(view.services.windows(2).all(|w| w[0].name.to_lowercase() <= w[1].name.to_lowercase()));

    assert_eq!(view.groups, vec!["admins".to_string()]);
    assert_eq!(view.summary.kind, PrincipalKind::User);
    assert_eq!(view.summary.policy_count, 0);
    assert!(view.summary.badges.iter().any(|b| b.kind == BadgeKind::Admin));
    assert_eq!(view.policies.len(), 1);
    let policy = &view.policies[0];
    assert_eq!((policy.id.as_str(), policy.kind, policy.via.as_deref(), policy.detachable), (ADMIN_POLICY, AttachedKind::Managed, Some("admins"), false));
    assert!(policy.badges.iter().any(|b| b.kind == BadgeKind::Admin) && policy.badges.iter().any(|b| b.kind == BadgeKind::AwsManaged));
    assert!(view.trust.is_empty() && view.unknown_actions.is_empty() && view.notes.is_empty());
}

#[test]
fn bob_view_reads_but_never_writes() {
    let s = snapshot();
    let view = principal_view(&s, BOB).unwrap();
    assert!(!view.admin_like);
    assert_eq!(view.services.len(), 1);
    let s3 = service(&view, "s3");
    assert_eq!(s3.name, "S3");
    assert!(!s3.danger);

    let read = cell(&view, "s3", AccessLevel::Read);
    assert!(read.allowed > 0, "{read:?}");
    assert_eq!(read.allowed, s3_count(AccessLevel::Read, &["Get"]));
    assert_eq!((read.conditional, read.denied), (0, 0));
    assert_eq!(read.total, catalog().total("s3", AccessLevel::Read));
    for level in LEVELS {
        let c = cell(&view, "s3", level);
        assert_eq!(c.allowed, s3_count(level, &["Get", "List"]), "{level:?}");
        assert_eq!((c.conditional, c.denied), (0, 0), "{level:?}");
    }
    // 쓰기는 하나도 열려 있지 않다
    let write = cell(&view, "s3", AccessLevel::Write);
    assert_eq!((write.allowed, write.conditional, write.denied), (0, 0, 0));
    assert!(write.total > 0);

    assert_eq!(view.summary.policy_count, 1);
    assert_eq!(view.policies.len(), 1);
    let policy = &view.policies[0];
    assert_eq!(policy.id, format!("inline:{BOB}:assets-read"));
    assert_eq!((policy.kind, policy.scope, policy.via.as_deref(), policy.detachable), (AttachedKind::Inline, None, None, false));
    assert!(view.groups.is_empty() && view.trust.is_empty() && view.tags.is_empty() && view.notes.is_empty());
}

#[test]
fn carol_view_counts_boundary_blocks_as_denied() {
    let s = snapshot();
    let view = principal_view(&s, CAROL).unwrap();
    assert!(!view.admin_like);
    // 경계가 `s3:Get*`만 허용하니, 나머지 작업은 모두 경계에 막혀 거부 칸에 센다
    for level in LEVELS {
        let c = cell(&view, "s3", level);
        let boundary_allows = s3_count(level, &["Get"]);
        assert_eq!((c.allowed, c.conditional, c.denied), (boundary_allows, 0, c.total - boundary_allows), "{level:?}");
    }
    let write = cell(&view, "s3", AccessLevel::Write);
    assert_eq!((write.allowed, write.denied), (0, write.total));
    assert!(write.total > 0);

    assert!(view.summary.badges.iter().any(|b| b.kind == BadgeKind::Boundary));
    assert_eq!(view.policies.len(), 2);
    let managed = &view.policies[0];
    assert_eq!((managed.id.as_str(), managed.kind, managed.detachable), (S3_FULL, AttachedKind::Managed, true));
    let boundary = &view.policies[1];
    assert_eq!((boundary.id.as_str(), boundary.kind, boundary.detachable), (CAROL_BOUNDARY, AttachedKind::Boundary, false));
    assert!(boundary.badges.iter().any(|b| b.kind == BadgeKind::Boundary));
    assert!(view.notes.iter().any(|n| n.contains("carol-boundary")), "{:?}", view.notes);
}

#[test]
fn deploy_view_flags_pass_role_and_keeps_lambda_conditional() {
    let s = snapshot();
    let view = principal_view(&s, DEPLOY).unwrap();
    assert!(!view.admin_like);
    let iam = service(&view, "iam");
    assert!(iam.danger);
    assert_eq!(cell(&view, "iam", AccessLevel::Write).allowed, 1);
    let lambda = service(&view, "lambda");
    assert!(!lambda.danger, "조건부 허용은 위험 표시에 넣지 않아요");
    let write = cell(&view, "lambda", AccessLevel::Write);
    assert_eq!((write.allowed, write.denied), (0, 0));
    assert!(write.conditional > 0);

    assert_eq!(view.summary.kind, PrincipalKind::Role);
    assert_eq!(view.summary.last_used.as_deref(), Some("2026-10-20T00:00:00Z"));
    let badges: Vec<BadgeKind> = view.summary.badges.iter().map(|b| b.kind).collect();
    assert_eq!(badges, vec![BadgeKind::Privesc, BadgeKind::Cfn]);
    assert_eq!(view.tags.get("aws:cloudformation:stack-name").map(String::as_str), Some("deploy-stack"));
    assert_eq!(view.trust.len(), 1);
    assert_eq!((view.trust[0].kind, view.trust[0].value.as_str()), (TrustKind::Service, "codebuild.amazonaws.com"));
}

#[test]
fn group_view_lists_members_and_its_own_policies() {
    let s = snapshot();
    let view = principal_view(&s, ADMINS).unwrap();
    assert_eq!(view.summary.kind, PrincipalKind::Group);
    assert_eq!(view.summary.member_count, Some(1));
    assert_eq!(view.groups, vec!["alice".to_string()]);
    assert!(view.admin_like);
    assert_eq!(view.policies.len(), 1);
    assert_eq!((view.policies[0].via.clone(), view.policies[0].detachable), (None, true));
    assert!(view.tags.is_empty());
    assert!(view.notes.iter().any(|n| n.contains("그룹")), "{:?}", view.notes);

    // 구성원과 소속 그룹은 대소문자를 무시한 이름순이다
    let mut s = snapshot();
    for name in ["Zed", "aaron"] {
        let mut u = user(name);
        u.groups = vec!["admins".into()];
        s.users.push(u);
    }
    s.users[0].groups.insert(0, "Zeta".into());
    s.groups.push(crate::iam::model::GroupRec { arn: format!("arn:aws:iam::{ACCOUNT}:group/Zeta"), name: "Zeta".into(), path: "/".into(), ..Default::default() });
    assert_eq!(principal_view(&s, ADMINS).unwrap().groups, vec!["aaron".to_string(), "alice".to_string(), "Zed".to_string()]);
    assert_eq!(principal_view(&s, ALICE).unwrap().groups, vec!["admins".to_string(), "Zeta".to_string()]);
}

#[test]
fn roles_without_permission_policies_still_show_their_trust() {
    let s = snapshot();
    for arn in [CI, VENDOR, OPEN, SLR, SSO] {
        let view = principal_view(&s, arn).unwrap();
        assert!(view.services.is_empty() && view.policies.is_empty() && !view.admin_like, "{arn}");
        assert_eq!(view.trust.len(), 1, "{arn}");
        assert!(view.groups.is_empty());
    }
}

#[test]
fn principal_actions_match_the_table_cells() {
    let s = snapshot();
    for (arn, prefix) in [(BOB, "s3"), (CAROL, "s3"), (DEPLOY, "iam"), (DEPLOY, "lambda")] {
        let view = principal_view(&s, arn).unwrap();
        for level in LEVELS {
            let grants = principal_actions(&s, arn, prefix, level);
            let c = cell(&view, prefix, level);
            let count = |status: Status| grants.iter().filter(|g| g.status == status).count();
            assert_eq!(count(Status::Allowed), c.allowed, "{arn} {prefix} {level:?}");
            assert_eq!(count(Status::Conditional), c.conditional, "{arn} {prefix} {level:?}");
            assert_eq!(count(Status::Denied) + count(Status::Boundary), c.denied, "{arn} {prefix} {level:?}");
            assert_eq!(grants.len(), c.allowed + c.conditional + c.denied);
        }
    }
    // 경계에 막힌 작업도 목록에 나온다
    let blocked = principal_actions(&s, CAROL, "s3", AccessLevel::Write);
    assert!(!blocked.is_empty() && blocked.iter().all(|g| g.status == Status::Boundary));
}

#[test]
fn principal_actions_carry_resources_sources_and_danger() {
    let s = snapshot();
    let grants = principal_actions(&s, BOB, "s3", AccessLevel::Read);
    let get = grants.iter().find(|g| g.action == "s3:GetObject").unwrap();
    assert_eq!(get.status, Status::Allowed);
    assert_eq!(get.resources, vec!["arn:aws:s3:::prod-assets*".to_string()]);
    assert!(get.sources.iter().any(|src| src.policy_name == "assets-read" && src.sid.as_deref() == Some("ReadAssets")));
    assert!(grants.iter().all(|g| g.danger.is_none()));
    assert!(grants.windows(2).all(|w| w[0].action.to_lowercase() <= w[1].action.to_lowercase()));
    // 접두어는 대소문자를 구분하지 않는다
    assert_eq!(principal_actions(&s, BOB, "S3", AccessLevel::Read), grants);

    let pass = principal_actions(&s, DEPLOY, "iam", AccessLevel::Write);
    let pass_role = pass.iter().find(|g| g.action == "iam:PassRole").unwrap();
    assert!(pass_role.danger.as_deref().is_some_and(|d| d.contains("권한 상승")), "{pass_role:?}");

    let admin = principal_actions(&s, ALICE, "iam", AccessLevel::Permissions);
    let danger_of = |action: &str| admin.iter().find(|g| g.action == action).and_then(|g| g.danger.clone()).unwrap_or_default();
    assert!(danger_of("iam:AttachUserPolicy").contains("권한 상승"));
    assert!(danger_of("iam:DeleteGroupPolicy").contains("권한 관리"));
    let admin_read = principal_actions(&s, ALICE, "s3", AccessLevel::Read);
    assert!(admin_read.iter().all(|g| g.danger.as_deref().is_some_and(|d| d.contains("와일드카드"))));

    assert!(principal_actions(&s, BOB, "s3", AccessLevel::Write).is_empty());
    assert!(principal_actions(&s, BOB, "nosuch", AccessLevel::Read).is_empty());
    assert!(principal_actions(&s, "arn:aws:iam::111111111111:user/nobody", "s3", AccessLevel::Read).is_empty());
}

#[test]
fn principal_view_json_has_the_contract_shape() {
    let s = snapshot();
    let value = serde_json::to_value(principal_view(&s, BOB).unwrap()).unwrap();
    assert_eq!(sorted_keys(&value), vec!["adminLike", "groups", "notes", "policies", "services", "summary", "tags", "trust", "unknownActions"]);
    assert_eq!(sorted_keys(&value["summary"]), vec!["arn", "badges", "createdAt", "kind", "lastUsed", "memberCount", "name", "path", "policyCount"]);
    assert_eq!(value["summary"]["kind"], json!("user"));
    assert_eq!(value["summary"]["arn"], json!(BOB));
    assert!(value["summary"]["lastUsed"].is_null() && value["summary"]["memberCount"].is_null());
    assert_eq!(value["adminLike"], json!(false));
    assert_eq!(
        value["policies"][0],
        json!({ "id": format!("inline:{BOB}:assets-read"), "name": "assets-read", "kind": "inline", "scope": null, "via": null, "badges": [], "detachable": false })
    );

    let service = &value["services"][0];
    assert_eq!(sorted_keys(service), vec!["danger", "levels", "name", "prefix"]);
    assert_eq!((&service["prefix"], &service["name"], &service["danger"]), (&json!("s3"), &json!("S3"), &json!(false)));
    assert_eq!(sorted_keys(&service["levels"]), vec!["list", "permissions", "read", "tagging", "write"]);
    assert_eq!(sorted_keys(&service["levels"]["read"]), vec!["allowed", "conditional", "denied", "total"]);
    assert!(service["levels"]["read"]["allowed"].as_u64().unwrap() > 0);

    let grants = serde_json::to_value(principal_actions(&s, BOB, "s3", AccessLevel::Read)).unwrap();
    let grant = grants.as_array().unwrap().iter().find(|g| g["action"] == json!("s3:GetObject")).unwrap();
    assert_eq!(sorted_keys(grant), vec!["action", "danger", "resources", "sources", "status"]);
    assert_eq!(grant["status"], json!("allowed"));
    assert!(grant["danger"].is_null());
    let source = &grant["sources"][0];
    assert_eq!(sorted_keys(source), vec!["boundary", "conditional", "effect", "policyId", "policyName", "sid", "statementIndex", "via"]);
    assert_eq!(source["effect"], json!("Allow"));
    assert_eq!(source["sid"], json!("ReadAssets"));
}

fn kinds(badges: &[Badge]) -> Vec<BadgeKind> {
    badges.iter().map(|b| b.kind).collect()
}

#[test]
fn a_policy_used_only_as_a_boundary_is_not_shown_as_unattached() {
    let s = snapshot();
    // AWS의 AttachmentCount는 권한 경계로 쓰는 것을 세지 않는다
    assert_eq!(s.policies[CAROL_BOUNDARY].attachment_count, 0);
    let view = principal_view(&s, CAROL).unwrap();
    let boundary = view.policies.iter().find(|p| p.id == CAROL_BOUNDARY).unwrap();
    assert_eq!(kinds(&boundary.badges), vec![BadgeKind::Boundary]);
    // 정말 어디에도 안 붙은 정책은 목록에서 그대로 안 붙음이다
    let (_, _, _, policies) = crate::iam::summary::summaries(&s);
    let badges_of = |arn: &str| kinds(&policies.iter().find(|p| p.arn == arn).unwrap().badges);
    assert!(badges_of(CAROL_BOUNDARY).is_empty());
    assert_eq!(badges_of(UNUSED_POLICY), vec![BadgeKind::Unattached]);
}

#[test]
fn the_detail_view_marks_admin_when_the_full_evaluation_says_so() {
    // `*:?*`는 모든 작업을 모든 리소스에 열지만 문장만 봐서는 `*` 와일드카드가 아니다
    let (mut s, arn) = solo_user(json!([{ "Effect": "Allow", "Action": "*:?*", "Resource": "*" }]));
    s.users[0].tags.insert("aws:cloudformation:stack-name".into(), "stack".into());
    assert!(!admin_like_statementwise(&s, &arn));
    // 목록 배지는 문장만 보고 정하니 권한 상승 위험까지만 단다
    assert_eq!(kinds(&principal_summary(&s, &arn).unwrap().badges), vec![BadgeKind::Privesc, BadgeKind::Cfn]);
    // 상세 화면은 전체 계산이 관리자급이면 관리자급 배지를 달고(권한 상승 배지는 대신 뗀다), 다른 배지는 그대로 둔다
    let view = principal_view(&s, &arn).unwrap();
    assert!(view.admin_like);
    assert_eq!(kinds(&view.summary.badges), vec![BadgeKind::Admin, BadgeKind::Cfn]);
    assert_eq!(view.summary.badges[0].label, "관리자급");

    // 문장만 봐도 관리자급이면 배지가 겹치지 않는다
    let view = principal_view(&snapshot(), ALICE).unwrap();
    assert_eq!(kinds(&view.summary.badges), vec![BadgeKind::Admin]);
    // 관리자급이 아니면 그대로다
    let view = principal_view(&snapshot(), DEPLOY).unwrap();
    assert_eq!(kinds(&view.summary.badges), vec![BadgeKind::Privesc, BadgeKind::Cfn]);
}

#[test]
fn managed_policies_of_service_linked_and_identity_center_roles_cannot_be_detached() {
    let mut s = snapshot();
    for arn in [SLR, SSO, DEPLOY] {
        s.roles.iter_mut().find(|r| r.arn == arn).unwrap().attached.push(S3_FULL.into());
    }
    let detachable = |arn: &str| principal_view(&s, arn).unwrap().policies.iter().find(|p| p.id == S3_FULL).map(|p| p.detachable);
    assert_eq!(detachable(SLR), Some(false));
    assert_eq!(detachable(SSO), Some(false));
    assert_eq!(detachable(DEPLOY), Some(true));
    // 사용자·그룹에 직접 붙은 것은 뗄 수 있다
    assert_eq!(detachable(CAROL), Some(true));
    assert_eq!(detachable(ADMINS), None);
    assert!(principal_view(&s, ADMINS).unwrap().policies[0].detachable);
}

#[test]
fn json_of_boundary_policies_and_trust_entries() {
    let s = snapshot();
    let carol = serde_json::to_value(principal_view(&s, CAROL).unwrap()).unwrap();
    assert_eq!(carol["policies"][1]["kind"], json!("boundary"));
    assert_eq!(carol["policies"][1]["scope"], json!("local"));
    assert_eq!(carol["policies"][0]["scope"], json!("aws"));
    assert_eq!(carol["summary"]["badges"][0], json!({ "kind": "boundary", "label": "권한 경계", "level": "info" }));

    let ci = serde_json::to_value(principal_view(&s, CI).unwrap()).unwrap();
    let entry = &ci["trust"][0];
    assert_eq!(sorted_keys(entry), vec!["actions", "conditional", "external", "kind", "value", "warning"]);
    assert_eq!(entry["kind"], json!("federated"));
    assert_eq!(entry["value"], json!("token.actions.githubusercontent.com"));
    assert_eq!(entry["actions"], json!(["sts:AssumeRoleWithWebIdentity"]));
    assert_eq!((&entry["conditional"], &entry["external"], &entry["warning"]), (&json!(true), &json!(false), &Value::Null));

    let vendor = serde_json::to_value(principal_view(&s, VENDOR).unwrap()).unwrap();
    assert_eq!(vendor["summary"]["badges"][0], json!({ "kind": "externalTrust", "label": "외부 신뢰", "level": "warn" }));
    assert_eq!(vendor["trust"][0]["kind"], json!("account"));
}
