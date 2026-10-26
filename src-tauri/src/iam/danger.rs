//! 위험 판정과 배지: 관리자급, 권한 상승 위험, 외부 신뢰, 서비스 연결·Identity Center 역할.

use super::catalog::{catalog, AccessLevel};
use super::eval::{all_star, decide_action, find_principal, policy_sources, Principal, Source, SourceKind, Status, Verdict};
use super::model::{ManagedPolicyRec, Scope, Snapshot};
use super::policy::{Actions, Effect, PolicyDocument, Resources, Statement};
use super::trust::parse_trust;
use super::view::{Badge, BadgeKind, Level, TrustKind};

/// 이 작업을 모든 리소스에 조건 없이 허용하면 권한 상승에 쓸 수 있다.
/// (Service Reference는 PassRole·CreateAccessKey·AssumeRole을 Write로 분류하므로 접근 수준만으로는 못 거른다.)
pub const PRIVESC_ACTIONS: &[&str] = &[
    "iam:CreatePolicyVersion",
    "iam:SetDefaultPolicyVersion",
    "iam:PassRole",
    "iam:CreateAccessKey",
    "iam:CreateLoginProfile",
    "iam:UpdateLoginProfile",
    "iam:AttachUserPolicy",
    "iam:AttachGroupPolicy",
    "iam:AttachRolePolicy",
    "iam:PutUserPolicy",
    "iam:PutGroupPolicy",
    "iam:PutRolePolicy",
    "iam:AddUserToGroup",
    "iam:UpdateAssumeRolePolicy",
    "iam:PutUserPermissionsBoundary",
    "iam:PutRolePermissionsBoundary",
    "iam:DeleteUserPermissionsBoundary",
    "iam:DeleteRolePermissionsBoundary",
    "sts:AssumeRole",
];

const CFN_STACK_TAG: &str = "aws:cloudformation:stack-name";

const REASON_PRIVESC: &str = "권한 상승에 쓸 수 있는 작업이에요";
const REASON_PERMISSIONS: &str = "모든 리소스에 대한 권한 관리 작업이에요";
const REASON_WILDCARD: &str = "모든 작업을 허용하는 와일드카드(*) 문장 때문에 허용돼요";

/// 서비스 연결 역할은 AWS 서비스가 관리한다(path `/aws-service-role/…`).
pub fn is_service_linked(path: &str) -> bool {
    path.starts_with("/aws-service-role/")
}

/// Identity Center가 만든 역할(path `/aws-reserved/sso.amazonaws.com/…` 또는 이름 `AWSReservedSSO_*`).
pub fn is_sso_role(name: &str, path: &str) -> bool {
    path.starts_with("/aws-reserved/sso.amazonaws.com/") || name.starts_with("AWSReservedSSO_")
}

fn is_privesc(prefix: &str, action: &str) -> bool {
    PRIVESC_ACTIONS
        .iter()
        .filter_map(|full| full.split_once(':'))
        .any(|(p, a)| p.eq_ignore_ascii_case(prefix) && a.eq_ignore_ascii_case(action))
}

/// 작업 하나가 위험한 이유(한국어). 위험하지 않으면 None.
/// 권한 상승 작업이거나, 모든 리소스에서 조건 없이 허용된 권한 관리 작업이거나(`Verdict::full_scope`: NotResource 목록만 뺀 전부도 포함하고,
/// 조건이 맞아야 모든 리소스에 열리는 것은 뺀다), 모든 작업을 여는 와일드카드 문장으로 허용된 경우다.
pub(super) fn danger_reason(prefix: &str, action: &str, level: AccessLevel, verdict: &Verdict, admin_statement: bool) -> Option<&'static str> {
    if is_privesc(prefix, action) {
        return Some(REASON_PRIVESC);
    }
    if level == AccessLevel::Permissions && verdict.full_scope {
        return Some(REASON_PERMISSIONS);
    }
    if admin_statement && verdict.eval.status == Status::Allowed {
        return Some(REASON_WILDCARD);
    }
    None
}

fn all_actions(pattern: &str) -> bool {
    all_star(pattern) || pattern == "*:*"
}

fn universal_resources(stmt: &Statement) -> bool {
    matches!(&stmt.resources, Resources::Resource(patterns) if patterns.iter().any(|p| all_star(p)))
}

/// 허용 범위로 볼 때 모든 리소스에 열린 문장: `Resource`에 `*`가 있거나, `*`를 빼지 않는 NotResource(몇 곳만 뺀 전부)다.
/// 권한 계산(`Verdict::full_scope`)도 NotResource 목록만 뺀 전부를 모든 리소스로 센다. 거부 쪽(`blanket_denied`)은 `universal_resources`만 본다.
fn opens_every_resource(stmt: &Statement) -> bool {
    match &stmt.resources {
        Resources::NotResource(excluded) => !excluded.iter().any(|e| all_star(e)),
        _ => universal_resources(stmt),
    }
}

fn statements<'a>(src: &Source<'a>) -> impl Iterator<Item = &'a Statement> + 'a {
    src.document.into_iter().flat_map(|doc| doc.statements.iter())
}

/// 조건 없는 Allow 문장이 `Action:"*"`(또는 `"*:*"`)를 `Resource:"*"`에 열어 두었다.
pub(super) fn has_admin_statement(sources: &[Source]) -> bool {
    sources.iter().flat_map(statements).any(|st| {
        st.effect == Effect::Allow
            && !st.conditional
            && universal_resources(st)
            && matches!(&st.actions, Actions::Action(patterns) if patterns.iter().any(|p| all_actions(p)))
    })
}

/// 패턴들이 가리키는 카탈로그 작업의 수(겹치는 것은 한 번만 센다).
fn union_size(patterns: &[String]) -> usize {
    let mut keys: Vec<(String, String)> = patterns.iter().flat_map(|p| catalog().expand(p)).map(|(prefix, action, _)| (prefix, action)).collect();
    keys.sort_unstable();
    keys.dedup();
    keys.len()
}

/// 문장이 가리키는 카탈로그 작업 수. `count_lists`가 false이면 Action 목록은 세지 않는다(와일드카드만 센다).
fn breadth(stmt: &Statement, count_lists: bool) -> usize {
    let total = catalog().all_count();
    match &stmt.actions {
        Actions::Action(patterns) if patterns.iter().any(|p| all_actions(p)) => total,
        Actions::Action(patterns) if count_lists => union_size(patterns),
        Actions::Action(_) => 0,
        Actions::NotAction(patterns) => total.saturating_sub(union_size(patterns)),
    }
}

/// 조건 없이 모든 리소스(NotResource 목록만 뺀 전부도)에 작업을 여는 Allow 문장 하나가 가리키는 작업 수의 최댓값.
fn widest_allow<'a>(sources: impl Iterator<Item = &'a Source<'a>>) -> usize {
    sources
        .flat_map(statements)
        .filter(|st| st.effect == Effect::Allow && !st.conditional && opens_every_resource(st))
        .map(|st| breadth(st, false))
        .max()
        .unwrap_or(0)
}

/// 조건 없이 모든 리소스에서 작업을 막는 Deny 문장들이 가리키는 작업 수의 합(겹침을 따지지 않은 상한).
fn blanket_denied<'a>(sources: impl Iterator<Item = &'a Source<'a>>) -> usize {
    sources
        .flat_map(statements)
        .filter(|st| st.effect == Effect::Deny && !st.conditional && universal_resources(st))
        .map(|st| breadth(st, true))
        .sum()
}

/// 문장 단위 관리자급 판정(카탈로그 전체를 펼치지 않는다). 조건 없이 모든 리소스(NotResource 목록만 뺀 전부도)에 카탈로그의 90% 이상을 여는
/// Allow 문장(`*`, 또는 몇 개만 뺀 NotAction)이 있고, 권한 경계와 모든 리소스 대상 Deny를 적용한 뒤에도 그 정도가 남는다.
/// NotResource로 몇 곳만 뺀 전체 허용도 전체 계산(`PrincipalEval::admin_like`)처럼 관리자급으로 본다(목록 배지·점검이 상세 화면과 같게).
pub(super) fn admin_like(sources: &[Source], boundary: Option<&Source>) -> bool {
    let total = catalog().all_count();
    let enough = |n: usize| n > 0 && n * 100 >= total * 90;
    let mut reach = widest_allow(sources.iter());
    let boundary = boundary.filter(|b| b.document.is_some());
    if let Some(b) = boundary {
        reach = reach.min(widest_allow(std::iter::once(b)));
    }
    enough(reach) && enough(reach.saturating_sub(blanket_denied(sources.iter().chain(boundary))))
}

/// 한 주체가 관리자급인지 문장만 보고 빠르게 판정한다(목록 배지용). 정확한 값은 `PrincipalEval::admin_like`.
pub fn admin_like_statementwise(s: &Snapshot, arn: &str) -> bool {
    let (sources, boundary) = policy_sources(s, arn);
    admin_like(&sources, boundary.as_ref())
}

pub(super) fn privesc_reasons_from<'a>(sources: &'a [Source<'a>], boundary: Option<&'a Source<'a>>) -> Vec<String> {
    PRIVESC_ACTIONS
        .iter()
        .filter(|action| decide_action(sources, boundary, action, Some("*")).is_some_and(|eval| eval.status == Status::Allowed))
        .map(|action| format!("{action} 작업을 모든 리소스에 조건 없이 허용해요"))
        .collect()
}

/// 권한 상승에 쓸 수 있는 작업을 `Resource:"*"`로 조건 없이 허용한 이유들(작업마다 한 줄). 없으면 빈 목록.
pub fn privesc_reasons(s: &Snapshot, arn: &str) -> Vec<String> {
    let (sources, boundary) = policy_sources(s, arn);
    privesc_reasons_from(&sources, boundary.as_ref())
}

fn admin_badge() -> Badge {
    Badge::new(BadgeKind::Admin, "관리자급", Level::Danger)
}

fn privesc_badge() -> Badge {
    Badge::new(BadgeKind::Privesc, "권한 상승 위험", Level::Warn)
}

/// 관리자급 배지를 맨 앞에 단다. 이미 있으면 그대로 두고, 관리자급이면 권한 상승 배지는 따로 달지 않으므로 그것은 뗀다.
pub(super) fn mark_admin(badges: &mut Vec<Badge>) {
    if badges.iter().any(|b| b.kind == BadgeKind::Admin) {
        return;
    }
    badges.retain(|b| b.kind != BadgeKind::Privesc);
    badges.insert(0, admin_badge());
}

/// 서비스 연결 역할이나 Identity Center 역할이면 정책을 바꾸거나 뗄 수 없다.
pub(super) fn is_locked_role(principal: Principal) -> bool {
    matches!(principal, Principal::Role(role) if is_service_linked(&role.path) || is_sso_role(&role.name, &role.path))
}

/// 정책 문서 자체가 관리자급이거나 권한 상승 작업을 여는지에 따른 배지. 관리자급이면 권한 상승 배지는 따로 달지 않는다.
pub(super) fn document_badges(doc: &PolicyDocument) -> Vec<Badge> {
    let sources = [Source { id: String::new(), name: String::new(), kind: SourceKind::Managed, scope: None, via: None, document: Some(doc) }];
    if admin_like(&sources, None) {
        vec![admin_badge()]
    } else if !privesc_reasons_from(&sources, None).is_empty() {
        vec![privesc_badge()]
    } else {
        Vec::new()
    }
}

/// 관리형 정책 배지: 문장으로 본 관리자급·권한 상승 위험, 붙은 곳 없는 고객 관리형, AWS 관리형.
pub fn managed_policy_badges(p: &ManagedPolicyRec) -> Vec<Badge> {
    let mut badges = p.document.as_ref().map(document_badges).unwrap_or_default();
    if p.scope == Scope::Local && p.attachment_count == 0 {
        badges.push(Badge::new(BadgeKind::Unattached, "안 붙음", Level::Info));
    }
    if p.scope == Scope::Aws {
        badges.push(Badge::new(BadgeKind::AwsManaged, "AWS 관리형", Level::Info));
    }
    badges
}

/// 주체 배지: 관리자급(아니면 권한 상승 위험), 외부 신뢰, 권한 경계, 서비스 연결, Identity Center, CloudFormation.
/// 자격 증명 보고서에서 나오는 배지(MFA·키·휴면)는 여기서 다루지 않는다.
pub(super) fn badges_from<'a>(s: &Snapshot, principal: Principal, sources: &'a [Source<'a>], boundary: Option<&'a Source<'a>>) -> Vec<Badge> {
    let mut badges = Vec::new();
    if admin_like(sources, boundary) {
        badges.push(admin_badge());
    } else if !privesc_reasons_from(sources, boundary).is_empty() {
        badges.push(privesc_badge());
    }
    if let Principal::Role(role) = principal {
        let entries = role.trust.as_ref().map(|doc| parse_trust(doc, &s.account_id)).unwrap_or_default();
        if entries.iter().any(|e| e.external) {
            let open = entries.iter().any(|e| e.kind == TrustKind::Anyone && !e.conditional);
            badges.push(Badge::new(BadgeKind::ExternalTrust, "외부 신뢰", if open { Level::Danger } else { Level::Warn }));
        }
    }
    if principal.boundary_arn().is_some() {
        badges.push(Badge::new(BadgeKind::Boundary, "권한 경계", Level::Info));
    }
    if let Principal::Role(role) = principal {
        if is_service_linked(&role.path) {
            badges.push(Badge::new(BadgeKind::ServiceLinked, "서비스 연결", Level::Info));
        }
        if is_sso_role(&role.name, &role.path) {
            badges.push(Badge::new(BadgeKind::Sso, "Identity Center", Level::Info));
        }
    }
    if principal.tags().is_some_and(|tags| tags.contains_key(CFN_STACK_TAG)) {
        badges.push(Badge::new(BadgeKind::Cfn, "CloudFormation", Level::Info));
    }
    badges
}

/// 사용자·그룹·역할 ARN의 배지. 모르는 ARN이면 빈 목록.
pub fn policy_badges(s: &Snapshot, arn: &str) -> Vec<Badge> {
    let Some(principal) = find_principal(s, arn) else {
        return Vec::new();
    };
    let (sources, boundary) = policy_sources(s, arn);
    badges_from(s, principal, &sources, boundary.as_ref())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::iam::eval::ActionEval;
    use crate::iam::fixtures::*;

    fn kinds(s: &Snapshot, arn: &str) -> Vec<BadgeKind> {
        policy_badges(s, arn).iter().map(|b| b.kind).collect()
    }

    fn verdict_of(status: Status, resources: &[&str], full_scope: bool) -> Verdict {
        Verdict { eval: ActionEval { status, resources: resources.iter().map(|r| r.to_string()).collect(), sources: Vec::new() }, full_scope }
    }

    #[test]
    fn service_linked_and_identity_center_roles() {
        assert!(is_service_linked("/aws-service-role/"));
        assert!(is_service_linked("/aws-service-role/x.amazonaws.com/"));
        assert!(!is_service_linked("/"));
        assert!(!is_service_linked("/team/aws-service-role/"));
        assert!(is_sso_role("AWSReservedSSO_Admin_abc", "/"));
        assert!(is_sso_role("anything", "/aws-reserved/sso.amazonaws.com/"));
        assert!(is_sso_role("anything", "/aws-reserved/sso.amazonaws.com/ap-northeast-2/"));
        assert!(!is_sso_role("deploy", "/"));
        assert!(!is_sso_role("deploy", "/aws-reserved/"));
    }

    #[test]
    fn privesc_actions_are_all_in_the_catalog() {
        assert_eq!(PRIVESC_ACTIONS.len(), 19);
        for action in PRIVESC_ACTIONS {
            let (prefix, name) = action.split_once(':').unwrap();
            assert!(catalog().level(prefix, name).is_some(), "{action}");
        }
        // 접근 수준만으로는 거를 수 없는 작업이 들어 있다
        assert_eq!(catalog().level("iam", "PassRole"), Some(AccessLevel::Write));
        assert_eq!(catalog().level("sts", "AssumeRole"), Some(AccessLevel::Write));
    }

    #[test]
    fn admin_like_needs_an_unconditional_wildcard_on_every_resource() {
        let s = snapshot();
        assert!(admin_like_statementwise(&s, ALICE));
        assert!(admin_like_statementwise(&s, ADMINS));
        for arn in [BOB, CAROL, DEPLOY, CI, VENDOR, "arn:aws:iam::111111111111:user/nobody"] {
            assert!(!admin_like_statementwise(&s, arn), "{arn}");
        }
        let admin = |statements: serde_json::Value| {
            let (s, arn) = solo_user(statements);
            admin_like_statementwise(&s, &arn)
        };
        assert!(admin(json!([{ "Effect": "Allow", "Action": "*:*", "Resource": "*" }])));
        assert!(admin(json!([{ "Effect": "Allow", "Action": ["s3:*", "*"], "Resource": ["arn:aws:s3:::x", "*"] }])));
        assert!(!admin(json!([{ "Effect": "Allow", "Action": "*", "Resource": "arn:aws:s3:::*" }])));
        assert!(!admin(json!([{ "Effect": "Allow", "Action": "*", "Resource": "*", "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "true" } } }])));
        assert!(!admin(json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*" }])));
        assert!(!admin(json!([{ "Effect": "Deny", "Action": "*", "Resource": "*" }])));
    }

    #[test]
    fn a_full_allow_that_leaves_out_a_few_resources_is_admin_like_but_one_that_leaves_out_everything_is_not() {
        let admin = |statements: serde_json::Value| {
            let (s, arn) = solo_user(statements);
            admin_like_statementwise(&s, &arn)
        };
        assert!(admin(json!([{ "Effect": "Allow", "Action": "*", "NotResource": "arn:aws:s3:::secret/*" }])));
        assert!(admin(json!([{ "Effect": "Allow", "Action": "*", "NotResource": ["arn:aws:s3:::a", "arn:aws:s3:::b/*"] }])));
        // `*`를 빼면 남는 리소스가 없다
        assert!(!admin(json!([{ "Effect": "Allow", "Action": "*", "NotResource": "*" }])));
        assert!(!admin(json!([{ "Effect": "Allow", "Action": "*", "NotResource": ["arn:aws:s3:::a", "*"] }])));
        let mfa = json!({ "Bool": { "aws:MultiFactorAuthPresent": "true" } });
        assert!(!admin(json!([{ "Effect": "Allow", "Action": "*", "NotResource": "arn:aws:s3:::secret/*", "Condition": mfa }])));
        // 목록 배지도 같은 판정이다
        let (s, arn) = solo_user(json!([{ "Effect": "Allow", "Action": "*", "NotResource": "arn:aws:s3:::secret/*" }]));
        assert_eq!(kinds(&s, &arn), vec![BadgeKind::Admin]);
        // 권한 경계도 몇 곳만 뺀 전부를 열면 관리자급을 막지 않는다
        let (s, arn) = solo_user_with_boundary(json!([{ "Effect": "Allow", "Action": "*", "Resource": "*" }]), json!([{ "Effect": "Allow", "Action": "*", "NotResource": "arn:aws:s3:::audit/*" }]));
        assert!(admin_like_statementwise(&s, &arn));
        let (s, arn) = solo_user_with_boundary(json!([{ "Effect": "Allow", "Action": "*", "Resource": "*" }]), json!([{ "Effect": "Allow", "Action": "*", "NotResource": "*" }]));
        assert!(!admin_like_statementwise(&s, &arn));
    }

    #[test]
    fn admin_like_survives_small_denies_but_not_big_ones() {
        let admin_with = |deny: serde_json::Value| {
            let (s, arn) = solo_user(json!([{ "Effect": "Allow", "Action": "*", "Resource": "*" }, deny]));
            admin_like_statementwise(&s, &arn)
        };
        assert!(admin_with(json!({ "Effect": "Deny", "Action": "iam:*", "Resource": "*" })));
        assert!(admin_with(json!({ "Effect": "Deny", "Action": ["iam:*", "ec2:*"], "Resource": "*" })));
        // 조건이 있거나 일부 리소스만 막는 Deny는 관리자급을 깨지 않는다
        assert!(admin_with(json!({ "Effect": "Deny", "Action": "*", "Resource": "*", "Condition": { "Bool": { "aws:SecureTransport": "false" } } })));
        assert!(admin_with(json!({ "Effect": "Deny", "Action": "*", "Resource": "arn:aws:s3:::x*" })));
        assert!(!admin_with(json!({ "Effect": "Deny", "Action": "*", "Resource": "*" })));
        assert!(!admin_with(json!({ "Effect": "Deny", "NotAction": "s3:*", "Resource": "*" })));
        // 카탈로그의 10%가 넘는 서비스를 통째로 막으면 관리자급이 아니다
        let big = ["ec2:*", "sagemaker:*", "connect:*", "quicksight:*", "chime:*", "glue:*", "iot:*", "bedrock:*"];
        assert!(!admin_with(json!({ "Effect": "Deny", "Action": big, "Resource": "*" })));
    }

    #[test]
    fn admin_like_needs_the_boundary_to_allow_it_too() {
        let all = json!([{ "Effect": "Allow", "Action": "*", "Resource": "*" }]);
        let (s, arn) = solo_user_with_boundary(all.clone(), json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*" }]));
        assert!(!admin_like_statementwise(&s, &arn));
        let (s, arn) = solo_user_with_boundary(all.clone(), json!([{ "Effect": "Allow", "Action": "*", "Resource": "*" }]));
        assert!(admin_like_statementwise(&s, &arn));
        let (s, arn) = solo_user_with_boundary(all, json!([{ "Effect": "Allow", "Action": "*", "Resource": "*" }, { "Effect": "Deny", "Action": "*", "Resource": "*" }]));
        assert!(!admin_like_statementwise(&s, &arn));
    }

    #[test]
    fn privesc_needs_an_unconditional_allow_on_every_resource() {
        let s = snapshot();
        let deploy = privesc_reasons(&s, DEPLOY);
        assert_eq!(deploy.len(), 1);
        assert!(deploy[0].contains("iam:PassRole"));
        assert!(privesc_reasons(&s, BOB).is_empty() && privesc_reasons(&s, CAROL).is_empty());
        assert_eq!(privesc_reasons(&s, ALICE).len(), PRIVESC_ACTIONS.len());
        assert!(privesc_reasons(&s, "arn:aws:iam::111111111111:user/nobody").is_empty());

        let reasons = |statements: serde_json::Value| {
            let (s, arn) = solo_user(statements);
            privesc_reasons(&s, &arn)
        };
        assert!(reasons(json!([{ "Effect": "Allow", "Action": "iam:PassRole", "Resource": "arn:aws:iam::111111111111:role/app-*" }])).is_empty());
        let conditional = json!([{ "Effect": "Allow", "Action": "iam:PassRole", "Resource": "*", "Condition": { "StringEquals": { "iam:PassedToService": "lambda.amazonaws.com" } } }]);
        assert!(reasons(conditional).is_empty());
        // 좁은 Deny로는 해소되지 않고, 모든 리소스 Deny면 해소된다
        let narrow = json!([
            { "Effect": "Allow", "Action": "iam:PassRole", "Resource": "*" },
            { "Effect": "Deny", "Action": "iam:PassRole", "Resource": "arn:aws:iam::111111111111:role/admin" }
        ]);
        assert_eq!(reasons(narrow).len(), 1);
        let blanket = json!([{ "Effect": "Allow", "Action": "iam:*", "Resource": "*" }, { "Effect": "Deny", "Action": "iam:PassRole", "Resource": "*" }]);
        let remaining = reasons(blanket);
        assert_eq!(remaining.len(), PRIVESC_ACTIONS.iter().filter(|a| a.starts_with("iam:") && **a != "iam:PassRole").count());
        assert!(remaining.iter().all(|r| !r.contains("iam:PassRole")));
        let assume = reasons(json!([{ "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "*" }]));
        assert_eq!(assume.len(), 1);
        assert!(assume[0].contains("sts:AssumeRole"));
        // 경계가 막으면 위험하지 않다
        let (s, arn) = solo_user_with_boundary(
            json!([{ "Effect": "Allow", "Action": "iam:*", "Resource": "*" }]),
            json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*" }]),
        );
        assert!(privesc_reasons(&s, &arn).is_empty());
    }

    #[test]
    fn principal_badges() {
        let s = snapshot();
        assert_eq!(kinds(&s, ALICE), vec![BadgeKind::Admin]);
        assert_eq!(kinds(&s, ADMINS), vec![BadgeKind::Admin]);
        assert!(kinds(&s, BOB).is_empty());
        assert_eq!(kinds(&s, CAROL), vec![BadgeKind::Boundary]);
        assert_eq!(kinds(&s, DEPLOY), vec![BadgeKind::Privesc, BadgeKind::Cfn]);
        assert!(kinds(&s, CI).is_empty());
        assert_eq!(kinds(&s, VENDOR), vec![BadgeKind::ExternalTrust]);
        assert_eq!(kinds(&s, OPEN), vec![BadgeKind::ExternalTrust]);
        assert_eq!(kinds(&s, SLR), vec![BadgeKind::ServiceLinked]);
        assert_eq!(kinds(&s, SSO), vec![BadgeKind::Sso]);
        assert!(policy_badges(&s, "arn:aws:iam::111111111111:user/nobody").is_empty());
    }

    #[test]
    fn badge_levels_and_labels() {
        let s = snapshot();
        assert_eq!(policy_badges(&s, ALICE)[0], Badge::new(BadgeKind::Admin, "관리자급", Level::Danger));
        assert_eq!(policy_badges(&s, DEPLOY)[0], Badge::new(BadgeKind::Privesc, "권한 상승 위험", Level::Warn));
        assert_eq!(policy_badges(&s, VENDOR)[0], Badge::new(BadgeKind::ExternalTrust, "외부 신뢰", Level::Warn));
        assert_eq!(policy_badges(&s, OPEN)[0], Badge::new(BadgeKind::ExternalTrust, "외부 신뢰", Level::Danger));
        assert_eq!(policy_badges(&s, SLR)[0], Badge::new(BadgeKind::ServiceLinked, "서비스 연결", Level::Info));
        assert_eq!(policy_badges(&s, SSO)[0].label, "Identity Center");
        assert_eq!(policy_badges(&s, DEPLOY)[1].label, "CloudFormation");
        // 누구나 열려 있어도 조건이 걸려 있으면 위험 단계는 아니다
        let mut s = snapshot();
        let open = s.roles.iter_mut().find(|r| r.arn == OPEN).unwrap();
        open.trust = Some(doc(trust(json!({ "AWS": "*" }), "sts:AssumeRole", Some(json!({ "StringEquals": { "aws:PrincipalOrgID": "o-abc" } })))));
        assert_eq!(policy_badges(&s, OPEN)[0].level, Level::Warn);
        // 같은 계정만 믿는 역할은 외부 신뢰가 아니다
        let own = s.roles.iter_mut().find(|r| r.arn == OPEN).unwrap();
        own.trust = Some(doc(trust(json!({ "AWS": format!("arn:aws:iam::{ACCOUNT}:root") }), "sts:AssumeRole", None)));
        assert!(policy_badges(&s, OPEN).is_empty());
    }

    #[test]
    fn managed_policy_badges_follow_the_policy_itself() {
        let s = snapshot();
        let badge_kinds = |arn: &str| managed_policy_badges(&s.policies[arn]).iter().map(|b| b.kind).collect::<Vec<_>>();
        assert_eq!(badge_kinds(ADMIN_POLICY), vec![BadgeKind::Admin, BadgeKind::AwsManaged]);
        assert_eq!(badge_kinds(S3_FULL), vec![BadgeKind::AwsManaged]);
        // 정책 하나만 보면 AttachmentCount가 0이라 안 붙은 정책이다. 권한 경계로 쓰는 것까지 아는 `summary`의 배지에서는 이 배지가 빠진다
        assert_eq!(badge_kinds(CAROL_BOUNDARY), vec![BadgeKind::Unattached]);
        assert_eq!(badge_kinds(UNUSED_POLICY), vec![BadgeKind::Unattached]);

        let local_admin = managed("arn:aws:iam::111111111111:policy/root-like", Scope::Local, 0, policy(json!([{ "Effect": "Allow", "Action": "*", "Resource": "*" }])));
        let kinds: Vec<BadgeKind> = managed_policy_badges(&local_admin).iter().map(|b| b.kind).collect();
        assert_eq!(kinds, vec![BadgeKind::Admin, BadgeKind::Unattached]);
        let passer = managed("arn:aws:iam::111111111111:policy/passer", Scope::Local, 2, policy(json!([{ "Effect": "Allow", "Action": "iam:PassRole", "Resource": "*" }])));
        assert_eq!(managed_policy_badges(&passer)[0], Badge::new(BadgeKind::Privesc, "권한 상승 위험", Level::Warn));
        assert_eq!(managed_policy_badges(&passer).len(), 1);
        let unreadable = ManagedPolicyRec { arn: "arn:aws:iam::aws:policy/Gone".into(), scope: Scope::Aws, ..Default::default() };
        assert_eq!(managed_policy_badges(&unreadable), vec![Badge::new(BadgeKind::AwsManaged, "AWS 관리형", Level::Info)]);
    }

    #[test]
    fn danger_reasons() {
        let allowed_everywhere = verdict_of(Status::Allowed, &["*"], true);
        assert_eq!(danger_reason("iam", "PassRole", AccessLevel::Write, &allowed_everywhere, false), Some(REASON_PRIVESC));
        assert_eq!(danger_reason("IAM", "passrole", AccessLevel::Write, &verdict_of(Status::Conditional, &["arn:x"], false), false), Some(REASON_PRIVESC));
        assert_eq!(danger_reason("sts", "AssumeRole", AccessLevel::Write, &allowed_everywhere, false), Some(REASON_PRIVESC));
        assert_eq!(danger_reason("s3", "PutBucketPolicy", AccessLevel::Permissions, &allowed_everywhere, false), Some(REASON_PERMISSIONS));
        assert_eq!(danger_reason("s3", "PutBucketPolicy", AccessLevel::Permissions, &verdict_of(Status::Allowed, &["arn:aws:s3:::b"], false), false), None);
        // "모든 리소스"는 라벨이 아니라 판정이 정한 범위로 가른다: NotResource 목록만 뺀 전부는 모든 리소스이고,
        // `*`가 라벨에 있어도 조건이 맞아야 열리는 것이면 아니다
        let all_but_secret = verdict_of(Status::Allowed, &["* (제외: arn:aws:s3:::secret/*)"], true);
        assert_eq!(danger_reason("s3", "PutBucketPolicy", AccessLevel::Permissions, &all_but_secret, false), Some(REASON_PERMISSIONS));
        let star_needs_a_condition = verdict_of(Status::Allowed, &["arn:aws:s3:::b", "*"], false);
        assert_eq!(danger_reason("s3", "PutBucketPolicy", AccessLevel::Permissions, &star_needs_a_condition, false), None);
        assert_eq!(danger_reason("s3", "GetObject", AccessLevel::Read, &allowed_everywhere, false), None);
        assert_eq!(danger_reason("s3", "GetObject", AccessLevel::Read, &allowed_everywhere, true), Some(REASON_WILDCARD));
        assert_eq!(danger_reason("s3", "GetObject", AccessLevel::Read, &verdict_of(Status::Conditional, &["*"], false), true), None);
        assert_eq!(danger_reason("s3", "GetObject", AccessLevel::Read, &verdict_of(Status::Denied, &["*"], false), true), None);
        assert_eq!(danger_reason("iam", "GetUser", AccessLevel::Read, &allowed_everywhere, false), None);
    }
}
