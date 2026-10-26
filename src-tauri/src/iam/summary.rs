//! 목록 화면의 요약(주체·정책)과 정책 상세 값.

use std::collections::{BTreeSet, HashSet};

use super::catalog::{catalog, AccessLevel};
use super::danger::{badges_from, document_badges, is_service_linked, is_sso_role, managed_policy_badges};
use super::eval::{cmp_ignore_case, find_principal, policy_sources, statement_actions, Principal, Source};
use super::model::{ManagedPolicyRec, Scope, Snapshot};
use super::policy::{pretty, Actions, Resources, Statement};
use super::view::{
    AttachedTo, PolicyScope, PolicySummary, PolicyView, PrincipalKind, PrincipalSummary, StatementService, StatementView, VersionView,
};

/// 주체 한 명의 목록용 요약. 정책 출처는 이미 구해 둔 것을 받는다.
pub(super) fn summary_of<'a>(s: &Snapshot, principal: Principal, sources: &'a [Source<'a>], boundary: Option<&'a Source<'a>>) -> PrincipalSummary {
    PrincipalSummary {
        arn: principal.arn().to_string(),
        name: principal.name().to_string(),
        kind: principal.kind(),
        path: principal.path().to_string(),
        created_at: principal.created_at().map(str::to_string),
        last_used: match principal {
            Principal::Role(role) => role.last_used.clone(),
            _ => None,
        },
        policy_count: principal.inline().len() + principal.attached().len(),
        member_count: match principal {
            Principal::Group(group) => Some(s.users.iter().filter(|u| u.groups.contains(&group.name)).count()),
            _ => None,
        },
        badges: badges_from(s, principal, sources, boundary),
    }
}

/// ARN으로 찾은 사용자·그룹·역할의 요약. 모르는 ARN이면 None.
pub fn principal_summary(s: &Snapshot, arn: &str) -> Option<PrincipalSummary> {
    let principal = find_principal(s, arn)?;
    let (sources, boundary) = policy_sources(s, arn);
    Some(summary_of(s, principal, &sources, boundary.as_ref()))
}

fn sorted_by_name(mut list: Vec<PrincipalSummary>) -> Vec<PrincipalSummary> {
    list.sort_by(|a, b| cmp_ignore_case(&a.name, &b.name).then_with(|| a.arn.cmp(&b.arn)));
    list
}

fn policy_summary(p: &ManagedPolicyRec) -> PolicySummary {
    PolicySummary {
        id: p.arn.clone(),
        arn: p.arn.clone(),
        name: p.name.clone(),
        scope: p.scope,
        attachment_count: p.attachment_count,
        default_version_id: p.default_version_id.clone(),
        updated_at: p.updated_at.clone(),
        badges: managed_policy_badges(p),
    }
}

/// 개요 화면 값: (사용자, 그룹, 역할, 정책), 이름순. 정책은 고객 관리형 전체와 어딘가에 붙어 있는 AWS 관리형이다.
/// 사용자의 `lastUsed`는 자격 증명 보고서에서 나중에 채운다.
pub fn summaries(s: &Snapshot) -> (Vec<PrincipalSummary>, Vec<PrincipalSummary>, Vec<PrincipalSummary>, Vec<PolicySummary>) {
    let summarize = |principal: Principal| {
        let (sources, boundary) = policy_sources(s, principal.arn());
        summary_of(s, principal, &sources, boundary.as_ref())
    };
    let users = sorted_by_name(s.users.iter().map(|u| summarize(Principal::User(u))).collect());
    let groups = sorted_by_name(s.groups.iter().map(|g| summarize(Principal::Group(g))).collect());
    let roles = sorted_by_name(s.roles.iter().map(|r| summarize(Principal::Role(r))).collect());

    let mut in_use: HashSet<&str> = HashSet::new();
    in_use.extend(s.users.iter().flat_map(|u| u.attached.iter().map(String::as_str).chain(u.boundary.as_deref())));
    in_use.extend(s.groups.iter().flat_map(|g| g.attached.iter().map(String::as_str)));
    in_use.extend(s.roles.iter().flat_map(|r| r.attached.iter().map(String::as_str).chain(r.boundary.as_deref())));
    let mut policies: Vec<PolicySummary> = s
        .policies
        .values()
        .filter(|p| p.scope == Scope::Local || p.attachment_count > 0 || in_use.contains(p.arn.as_str()))
        .map(policy_summary)
        .collect();
    policies.sort_by(|a, b| cmp_ignore_case(&a.name, &b.name).then_with(|| a.arn.cmp(&b.arn)));
    (users, groups, roles, policies)
}

/// 문장이 허용·거부하는 작업을 서비스별로 묶는다(서비스 이름순). 카탈로그에 없는 패턴은 빠진다.
fn statement_services(stmt: &Statement) -> Vec<StatementService> {
    let cat = catalog();
    let (actions, _) = statement_actions(stmt);
    let mut services: Vec<StatementService> = actions
        .chunk_by(|a, b| a.0 == b.0)
        .map(|group| {
            let prefix = &group[0].0;
            let levels: BTreeSet<AccessLevel> = group.iter().map(|action| action.2).collect();
            StatementService {
                prefix: prefix.clone(),
                name: cat.service_name(prefix).unwrap_or(prefix).to_string(),
                levels: levels.into_iter().collect(),
                count: group.len(),
            }
        })
        .collect();
    services.sort_by(|a, b| cmp_ignore_case(&a.name, &b.name).then_with(|| a.prefix.cmp(&b.prefix)));
    services
}

fn statement_view(stmt: &Statement) -> StatementView {
    let (not_action, action_patterns) = match &stmt.actions {
        Actions::Action(patterns) => (false, patterns.clone()),
        Actions::NotAction(patterns) => (true, patterns.clone()),
    };
    let (not_resource, resources) = match &stmt.resources {
        Resources::Resource(patterns) => (false, patterns.clone()),
        Resources::NotResource(patterns) => (true, patterns.clone()),
        Resources::Unspecified => (false, Vec::new()),
    };
    StatementView {
        sid: stmt.sid.clone(),
        effect: stmt.effect,
        not_action,
        action_patterns,
        services: statement_services(stmt),
        not_resource,
        resources,
        conditions: stmt.conditions.clone(),
    }
}

/// 이 관리형 정책을 붙였거나 권한 경계로 쓰는 사용자·그룹·역할(종류순, 이름순).
fn attached_to(s: &Snapshot, policy_arn: &str) -> Vec<AttachedTo> {
    let uses = |attached: &[String], boundary: Option<&str>| attached.iter().any(|arn| arn == policy_arn) || boundary == Some(policy_arn);
    let mut out = Vec::new();
    for u in s.users.iter().filter(|u| uses(&u.attached, u.boundary.as_deref())) {
        out.push(AttachedTo { arn: u.arn.clone(), name: u.name.clone(), kind: PrincipalKind::User });
    }
    for g in s.groups.iter().filter(|g| uses(&g.attached, None)) {
        out.push(AttachedTo { arn: g.arn.clone(), name: g.name.clone(), kind: PrincipalKind::Group });
    }
    for r in s.roles.iter().filter(|r| uses(&r.attached, r.boundary.as_deref())) {
        out.push(AttachedTo { arn: r.arn.clone(), name: r.name.clone(), kind: PrincipalKind::Role });
    }
    out.sort_by(|a, b| (a.kind as u8).cmp(&(b.kind as u8)).then_with(|| cmp_ignore_case(&a.name, &b.name)).then_with(|| a.arn.cmp(&b.arn)));
    out
}

fn managed_view(s: &Snapshot, rec: &ManagedPolicyRec) -> PolicyView {
    PolicyView {
        id: rec.arn.clone(),
        name: rec.name.clone(),
        scope: match rec.scope {
            Scope::Aws => PolicyScope::Aws,
            Scope::Local => PolicyScope::Local,
        },
        arn: Some(rec.arn.clone()),
        document: rec.raw.as_deref().map(pretty).unwrap_or_default(),
        statements: rec.document.iter().flat_map(|doc| doc.statements.iter()).map(statement_view).collect(),
        versions: rec
            .versions
            .iter()
            .map(|v| VersionView { id: v.id.clone(), is_default: v.is_default, created_at: v.created_at.clone() })
            .collect(),
        attached_to: attached_to(s, &rec.arn),
        // AWS 관리형 정책은 고칠 수 없다
        editable: rec.scope == Scope::Local,
        badges: managed_policy_badges(rec),
    }
}

fn inline_view(owner: Principal, policy_id: &str, name: &str) -> Option<PolicyView> {
    let inline = owner.inline().iter().find(|p| p.name == name)?;
    // 서비스 연결·Identity Center 역할의 정책은 바꿀 수 없다
    let locked = matches!(owner, Principal::Role(role) if is_service_linked(&role.path) || is_sso_role(&role.name, &role.path));
    Some(PolicyView {
        id: policy_id.to_string(),
        name: inline.name.clone(),
        scope: PolicyScope::Inline,
        arn: None,
        document: pretty(&inline.raw),
        statements: inline.document.iter().flat_map(|doc| doc.statements.iter()).map(statement_view).collect(),
        versions: Vec::new(),
        attached_to: vec![AttachedTo { arn: owner.arn().to_string(), name: owner.name().to_string(), kind: owner.kind() }],
        editable: !locked,
        badges: inline.document.as_ref().map(document_badges).unwrap_or_default(),
    })
}

/// 정책 상세 화면의 값. `policy_id`는 관리형 정책 ARN 또는 `inline:<소유자 ARN>:<이름>`이다. 없으면 None.
pub fn policy_view(s: &Snapshot, policy_id: &str) -> Option<PolicyView> {
    match policy_id.strip_prefix("inline:") {
        // 소유자 ARN에도 콜론이 있으니 이름은 마지막 콜론 뒤다(정책 이름에는 콜론을 쓸 수 없다)
        Some(rest) => {
            let (owner_arn, name) = rest.rsplit_once(':')?;
            inline_view(find_principal(s, owner_arn)?, policy_id, name)
        }
        None => s.policies.get(policy_id).map(|rec| managed_view(s, rec)),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::iam::catalog::LEVELS;
    use crate::iam::fixtures::*;
    use crate::iam::policy::Effect;
    use crate::iam::view::BadgeKind;

    fn s3_names(start: &str, level: AccessLevel) -> usize {
        catalog().actions("s3").iter().filter(|(name, l)| *l == level && name.starts_with(start)).count()
    }

    fn names(list: &[PrincipalSummary]) -> Vec<&str> {
        list.iter().map(|p| p.name.as_str()).collect()
    }

    #[test]
    fn summaries_are_sorted_and_carry_counts_and_badges() {
        let s = snapshot();
        let (users, groups, roles, policies) = summaries(&s);
        assert_eq!(names(&users), vec!["alice", "bob", "carol"]);
        assert_eq!(names(&groups), vec!["admins"]);
        assert_eq!(names(&roles), vec!["AWSReservedSSO_Admin_abc", "AWSServiceRoleForX", "ci", "deploy", "open", "vendor"]);

        let alice = &users[0];
        assert_eq!((alice.kind, alice.policy_count, alice.member_count, alice.last_used.as_deref()), (PrincipalKind::User, 0, None, None));
        assert_eq!(alice.created_at.as_deref(), Some("2025-01-01T00:00:00Z"));
        assert!(alice.badges.iter().any(|b| b.kind == BadgeKind::Admin));
        assert_eq!(users[1].policy_count, 1);
        assert_eq!(users[2].policy_count, 1);

        let admins = &groups[0];
        assert_eq!((admins.kind, admins.member_count, admins.policy_count), (PrincipalKind::Group, Some(1), 1));
        assert!(admins.badges.iter().any(|b| b.kind == BadgeKind::Admin));

        let deploy = roles.iter().find(|r| r.name == "deploy").unwrap();
        assert_eq!((deploy.last_used.as_deref(), deploy.policy_count, deploy.member_count), (Some("2026-10-20T00:00:00Z"), 1, None));
        assert_eq!(deploy.path, "/");
        let slr = roles.iter().find(|r| r.name == "AWSServiceRoleForX").unwrap();
        assert_eq!(slr.path, "/aws-service-role/x.amazonaws.com/");

        let policy_names: Vec<&str> = policies.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(policy_names, vec!["AdministratorAccess", "AmazonS3FullAccess", "carol-boundary", "unused-policy"]);
        let admin = &policies[0];
        assert_eq!((admin.id.as_str(), admin.arn.as_str(), admin.scope, admin.attachment_count), (ADMIN_POLICY, ADMIN_POLICY, Scope::Aws, 1));
        assert_eq!(admin.default_version_id.as_deref(), Some("v1"));
        assert_eq!(admin.updated_at.as_deref(), Some("2026-01-01T00:00:00Z"));
        let kinds: Vec<BadgeKind> = admin.badges.iter().map(|b| b.kind).collect();
        assert_eq!(kinds, vec![BadgeKind::Admin, BadgeKind::AwsManaged]);
        assert_eq!(policies[3].badges.iter().map(|b| b.kind).collect::<Vec<_>>(), vec![BadgeKind::Unattached]);
    }

    #[test]
    fn aws_managed_policies_nobody_uses_are_left_out() {
        let mut s = snapshot();
        let unused = managed("arn:aws:iam::aws:policy/Unused", Scope::Aws, 0, policy(json!([{ "Effect": "Allow", "Action": "s3:Get*", "Resource": "*" }])));
        let counted = managed("arn:aws:iam::aws:policy/Counted", Scope::Aws, 3, policy(json!([{ "Effect": "Allow", "Action": "s3:Get*", "Resource": "*" }])));
        let referenced = managed("arn:aws:iam::aws:policy/Referenced", Scope::Aws, 0, policy(json!([{ "Effect": "Allow", "Action": "s3:Get*", "Resource": "*" }])));
        for p in [unused, counted, referenced] {
            s.policies.insert(p.arn.clone(), p);
        }
        s.roles[0].attached.push("arn:aws:iam::aws:policy/Referenced".into());
        let (_, _, _, policies) = summaries(&s);
        let listed: Vec<&str> = policies.iter().map(|p| p.name.as_str()).collect();
        assert!(!listed.contains(&"Unused"), "{listed:?}");
        assert!(listed.contains(&"Counted") && listed.contains(&"Referenced"), "{listed:?}");
        assert!(listed.contains(&"unused-policy"), "붙은 곳 없는 고객 관리형 정책은 보여요: {listed:?}");
    }

    #[test]
    fn principal_summary_matches_the_list_entry() {
        let s = snapshot();
        let (users, _, roles, _) = summaries(&s);
        assert_eq!(principal_summary(&s, BOB).as_ref(), users.iter().find(|u| u.name == "bob"));
        assert_eq!(principal_summary(&s, DEPLOY).as_ref(), roles.iter().find(|r| r.name == "deploy"));
        assert_eq!(principal_summary(&s, "arn:aws:iam::111111111111:user/nobody"), None);
    }

    #[test]
    fn managed_policy_view() {
        let s = snapshot();
        let view = policy_view(&s, S3_FULL).unwrap();
        assert_eq!((view.id.as_str(), view.name.as_str(), view.scope, view.arn.as_deref()), (S3_FULL, "AmazonS3FullAccess", PolicyScope::Aws, Some(S3_FULL)));
        assert!(!view.editable);
        assert!(view.document.contains("\n  \"Statement\""), "{}", view.document);
        assert_eq!(view.versions, vec![VersionView { id: "v1".into(), is_default: true, created_at: Some("2026-01-01T00:00:00Z".into()) }]);
        assert_eq!(view.attached_to, vec![AttachedTo { arn: CAROL.into(), name: "carol".into(), kind: PrincipalKind::User }]);
        assert_eq!(view.badges.iter().map(|b| b.kind).collect::<Vec<_>>(), vec![BadgeKind::AwsManaged]);
        assert_eq!(view.statements.len(), 1);
        let stmt = &view.statements[0];
        assert_eq!((stmt.effect, stmt.not_action, stmt.not_resource), (Effect::Allow, false, false));
        assert_eq!((stmt.action_patterns.clone(), stmt.resources.clone(), stmt.sid.clone()), (vec!["s3:*".to_string()], vec!["*".to_string()], None));
        assert_eq!(stmt.services.len(), 1);
        let svc = &stmt.services[0];
        assert_eq!((svc.prefix.as_str(), svc.name.as_str(), svc.count), ("s3", "S3", catalog().actions("s3").len()));
        assert_eq!(svc.levels, LEVELS.to_vec());

        // 권한 경계로 쓰는 것도 붙어 있는 곳으로 센다
        let boundary = policy_view(&s, CAROL_BOUNDARY).unwrap();
        assert_eq!((boundary.scope, boundary.editable), (PolicyScope::Local, true));
        assert_eq!(boundary.attached_to.iter().map(|a| a.arn.as_str()).collect::<Vec<_>>(), vec![CAROL]);
        let svc = &boundary.statements[0].services[0];
        assert_eq!(svc.levels, vec![AccessLevel::Read]);
        assert_eq!(svc.count, s3_names("Get", AccessLevel::Read));
        assert_eq!(boundary.statements[0].sid.as_deref(), Some("ReadOnly"));

        let unused = policy_view(&s, UNUSED_POLICY).unwrap();
        assert!(unused.attached_to.is_empty());
        assert_eq!(unused.badges.iter().map(|b| b.kind).collect::<Vec<_>>(), vec![BadgeKind::Unattached]);

        let admin = policy_view(&s, ADMIN_POLICY).unwrap();
        assert_eq!(admin.attached_to, vec![AttachedTo { arn: ADMINS.into(), name: "admins".into(), kind: PrincipalKind::Group }]);
        let services_with_actions = catalog().services().filter(|(prefix, _)| !catalog().actions(prefix).is_empty()).count();
        assert_eq!(admin.statements[0].services.len(), services_with_actions);
        assert!(admin.statements[0].services.windows(2).all(|w| w[0].name.to_lowercase() <= w[1].name.to_lowercase()));
    }

    #[test]
    fn inline_policy_view() {
        let s = snapshot();
        let id = format!("inline:{BOB}:assets-read");
        let view = policy_view(&s, &id).unwrap();
        assert_eq!((view.id.as_str(), view.name.as_str(), view.scope, view.arn.clone()), (id.as_str(), "assets-read", PolicyScope::Inline, None));
        assert!(view.editable && view.versions.is_empty());
        assert_eq!(view.attached_to, vec![AttachedTo { arn: BOB.into(), name: "bob".into(), kind: PrincipalKind::User }]);
        assert!(view.document.contains("\"Sid\": \"ReadAssets\""), "{}", view.document);
        assert_eq!(view.statements.len(), 2);

        let read = &view.statements[0];
        assert_eq!((read.sid.as_deref(), read.effect), (Some("ReadAssets"), Effect::Allow));
        assert_eq!(read.action_patterns, vec!["s3:Get*".to_string(), "s3:List*".to_string()]);
        assert_eq!(read.resources, vec!["arn:aws:s3:::prod-assets*".to_string()]);
        assert_eq!(read.services.len(), 1);
        assert_eq!(read.services[0].levels, vec![AccessLevel::List, AccessLevel::Read]);
        assert_eq!(read.services[0].count, s3_names("Get", AccessLevel::Read) + s3_names("List", AccessLevel::List));
        let deny = &view.statements[1];
        assert_eq!((deny.effect, deny.services[0].count, deny.services[0].levels.clone()), (Effect::Deny, 1, vec![AccessLevel::Read]));

        // 서비스 연결 역할의 인라인 정책은 고칠 수 없다
        let mut s = snapshot();
        s.roles.iter_mut().find(|r| r.arn == SLR).unwrap().inline.push(inline("x", policy(json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*" }]))));
        s.roles.iter_mut().find(|r| r.arn == SSO).unwrap().inline.push(inline("x", policy(json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*" }]))));
        assert!(!policy_view(&s, &format!("inline:{SLR}:x")).unwrap().editable);
        assert!(!policy_view(&s, &format!("inline:{SSO}:x")).unwrap().editable);
        assert!(policy_view(&s, &format!("inline:{DEPLOY}:deploy-inline")).unwrap().editable);
        // 그룹이 소유한 인라인 정책은 소유자가 그룹으로 나온다
        s.groups[0].inline.push(inline("g", policy(json!([{ "Effect": "Allow", "Action": "iam:PassRole", "Resource": "*" }]))));
        let group_policy = policy_view(&s, &format!("inline:{ADMINS}:g")).unwrap();
        assert_eq!(group_policy.attached_to[0].kind, PrincipalKind::Group);
        assert_eq!(group_policy.badges.iter().map(|b| b.kind).collect::<Vec<_>>(), vec![BadgeKind::Privesc]);
    }

    #[test]
    fn unknown_policy_ids_are_none() {
        let s = snapshot();
        assert!(policy_view(&s, "arn:aws:iam::aws:policy/Nope").is_none());
        assert!(policy_view(&s, &format!("inline:{BOB}:nope")).is_none());
        assert!(policy_view(&s, "inline:arn:aws:iam::111111111111:user/nobody:p").is_none());
        assert!(policy_view(&s, "inline:no-colon").is_none());
        assert!(policy_view(&s, "").is_none());
    }

    #[test]
    fn statement_views_show_not_action_not_resource_and_conditions() {
        let (s, arn) = solo_user(json!([{
            "Sid": "Odd", "Effect": "Deny", "NotAction": ["iam:*", "sts:*"], "NotResource": "arn:aws:s3:::keep/*",
            "Condition": { "IpAddress": { "aws:SourceIp": ["10.0.0.0/8", "192.168.0.0/16"] }, "Bool": { "aws:SecureTransport": "false" } }
        }]));
        let view = policy_view(&s, &format!("inline:{arn}:p")).unwrap();
        let stmt = &view.statements[0];
        assert!(stmt.not_action && stmt.not_resource);
        assert_eq!(stmt.action_patterns, vec!["iam:*".to_string(), "sts:*".to_string()]);
        assert_eq!(stmt.resources, vec!["arn:aws:s3:::keep/*".to_string()]);
        assert_eq!(stmt.conditions, vec!["aws:SecureTransport · Bool · false".to_string(), "aws:SourceIp · IpAddress · 10.0.0.0/8, 192.168.0.0/16".to_string()]);
        assert!(!stmt.services.iter().any(|svc| svc.prefix == "iam" || svc.prefix == "sts"));
        assert!(stmt.services.iter().any(|svc| svc.prefix == "s3"));
    }

    #[test]
    fn policy_view_json_has_the_contract_shape() {
        let s = snapshot();
        let value = serde_json::to_value(policy_view(&s, CAROL_BOUNDARY).unwrap()).unwrap();
        let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["arn", "attachedTo", "badges", "document", "editable", "id", "name", "scope", "statements", "versions"]);
        assert_eq!(value["scope"], json!("local"));
        assert_eq!(value["versions"][0], json!({ "id": "v1", "isDefault": true, "createdAt": "2026-01-01T00:00:00Z" }));
        assert_eq!(value["attachedTo"][0], json!({ "arn": CAROL, "name": "carol", "kind": "user" }));
        let stmt = &value["statements"][0];
        let mut stmt_keys: Vec<&str> = stmt.as_object().unwrap().keys().map(String::as_str).collect();
        stmt_keys.sort_unstable();
        assert_eq!(stmt_keys, vec!["actionPatterns", "conditions", "effect", "notAction", "notResource", "resources", "services", "sid"]);
        assert_eq!(stmt["effect"], json!("Allow"));
        assert_eq!(stmt["services"][0]["levels"], json!(["read"]));
        assert_eq!(stmt["services"][0]["prefix"], json!("s3"));
        let inline_value = serde_json::to_value(policy_view(&s, &format!("inline:{BOB}:assets-read")).unwrap()).unwrap();
        assert_eq!(inline_value["scope"], json!("inline"));
        assert!(inline_value["arn"].is_null());

        let summary = serde_json::to_value(principal_summary(&s, ADMINS).unwrap()).unwrap();
        assert_eq!(summary["memberCount"], json!(1));
        assert_eq!(summary["kind"], json!("group"));
        let policy_summary = serde_json::to_value(summaries(&s).3.remove(0)).unwrap();
        let mut summary_keys: Vec<&str> = policy_summary.as_object().unwrap().keys().map(String::as_str).collect();
        summary_keys.sort_unstable();
        assert_eq!(summary_keys, vec!["arn", "attachmentCount", "badges", "defaultVersionId", "id", "name", "scope", "updatedAt"]);
        assert_eq!(policy_summary["scope"], json!("aws"));
    }
}
