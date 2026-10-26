//! 리뷰 반영 테스트: 관리자급 판정, 경계가 좁히는 리소스, 부분 Deny, 큰 NotAction 문장들.

use serde_json::json;

use super::{assert_paths_agree, key, resources_of, status, strings, table_status, verdict_of};
use crate::iam::catalog::{catalog, AccessLevel};
use crate::iam::danger::admin_like_statementwise;
use crate::iam::eval::{decide_action, evaluate, evaluate_action, policy_sources, principal_actions, principal_view, Status};
use crate::iam::fixtures::*;

// ---- 관리자급: 리소스를 좁혀 허용한 작업은 세지 않는다 ----

#[test]
fn a_wildcard_action_on_one_bucket_is_not_admin_like() {
    let (s, arn) = solo_user(json!([{ "Effect": "Allow", "Action": "*", "Resource": "arn:aws:s3:::bucket/*" }]));
    let eval = evaluate(&s, &arn).unwrap();
    // 카탈로그의 모든 작업이 허용이지만 전부 그 버킷에서만이다
    assert_eq!(eval.actions.len(), catalog().all_count());
    assert!(eval.actions.values().all(|(_, e)| e.status == Status::Allowed && e.resources == strings(&["arn:aws:s3:::bucket/*"])));
    assert!(!eval.admin_like);
    assert!(!admin_like_statementwise(&s, &arn));
    let view = principal_view(&s, &arn).unwrap();
    assert!(!view.admin_like);
    assert!(view.summary.badges.iter().all(|b| b.kind != crate::iam::view::BadgeKind::Admin));

    // 리소스 목록에 `*`가 하나라도 있으면 관리자급이다
    let (s, arn) = solo_user(json!([{ "Effect": "Allow", "Action": "*", "Resource": ["arn:aws:s3:::bucket/*", "*"] }]));
    assert!(evaluate(&s, &arn).unwrap().admin_like);
    assert!(principal_view(&s, &arn).unwrap().admin_like);
}

#[test]
fn the_ninety_percent_rule_needs_every_resource() {
    // `*:?*`는 문장만 봐서는 와일드카드 관리자 문장이 아니라 90% 규칙으로만 관리자급이 된다
    let (s, arn) = solo_user(json!([{ "Effect": "Allow", "Action": "*:?*", "Resource": "*" }]));
    assert!(!admin_like_statementwise(&s, &arn));
    assert!(evaluate(&s, &arn).unwrap().admin_like);
    let (s, arn) = solo_user(json!([{ "Effect": "Allow", "Action": "*:?*", "Resource": "arn:aws:s3:::bucket/*" }]));
    assert!(!evaluate(&s, &arn).unwrap().admin_like);
    // 경계가 리소스를 좁히면 신원 정책이 `*`여도 관리자급이 아니다
    let (s, arn) = solo_user_with_boundary(
        json!([{ "Effect": "Allow", "Action": "*:?*", "Resource": "*" }]),
        json!([{ "Effect": "Allow", "Action": "*:?*", "Resource": "arn:aws:s3:::team-*" }]),
    );
    assert!(!evaluate(&s, &arn).unwrap().admin_like);
    assert!(!principal_view(&s, &arn).unwrap().admin_like);
}

// ---- 권한 경계가 리소스 범위를 좁힌다 ----

#[test]
fn a_boundary_narrows_the_resources_an_action_is_allowed_on() {
    let (s, arn) = solo_user_with_boundary(
        json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*" }]),
        json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "arn:aws:s3:::team-*" }]),
    );
    assert_eq!(resources_of(&s, &arn, "s3:PutBucketPolicy"), Some((Status::Allowed, strings(&["arn:aws:s3:::team-*"]))));
    assert_eq!(resources_of(&s, &arn, "s3:GetObject"), Some((Status::Allowed, strings(&["arn:aws:s3:::team-*"]))));
    // 대상 리소스를 정하면 경계에 든 것만 허용이다
    assert_eq!(status(&s, &arn, "s3:PutBucketPolicy", Some("arn:aws:s3:::team-a")), Some(Status::Allowed));
    assert_eq!(status(&s, &arn, "s3:PutBucketPolicy", Some("arn:aws:s3:::other")), Some(Status::Boundary));

    // 위험 표시도 좁혀진 리소스로 계산한다: 모든 리소스에 대한 권한 관리가 아니다
    let grants = principal_actions(&s, &arn, "s3", AccessLevel::Permissions);
    assert!(grants.iter().any(|g| g.action == "s3:PutBucketPolicy"));
    assert!(grants.iter().all(|g| g.danger.is_none()), "{grants:?}");
    assert!(!principal_view(&s, &arn).unwrap().services.iter().find(|svc| svc.prefix == "s3").unwrap().danger);

    // 경계가 모든 리소스를 허용하면 그대로 위험하다
    let (s, arn) = solo_user_with_boundary(
        json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*" }]),
        json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*" }]),
    );
    assert_eq!(resources_of(&s, &arn, "s3:PutBucketPolicy"), Some((Status::Allowed, strings(&["*"]))));
    let grants = principal_actions(&s, &arn, "s3", AccessLevel::Permissions);
    let put = grants.iter().find(|g| g.action == "s3:PutBucketPolicy").unwrap();
    assert!(put.danger.as_deref().is_some_and(|d| d.contains("모든 리소스")), "{put:?}");
    assert!(principal_view(&s, &arn).unwrap().services.iter().find(|svc| svc.prefix == "s3").unwrap().danger);
}

#[test]
fn identity_and_boundary_patterns_that_never_meet_leave_nothing() {
    let (s, arn) = solo_user_with_boundary(
        json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::a/*" }]),
        json!([{ "Sid": "B", "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::b/*" }]),
    );
    let (verdict, resources) = resources_of(&s, &arn, "s3:GetObject").unwrap();
    assert_eq!(verdict, Status::Boundary);
    // 막힌 작업은 신원 정책이 허용하려던 리소스를 그대로 보여 준다
    assert_eq!(resources, strings(&["arn:aws:s3:::a/*"]));
    // 경계가 허용하는 문장은 근거로 남는다
    let eval = evaluate_action(&s, &arn, "s3:GetObject", None).unwrap();
    assert!(eval.sources.iter().any(|g| g.boundary && g.sid.as_deref() == Some("B")), "{:?}", eval.sources);
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::a/x")), Some(Status::Boundary));

    // 조건부 허용이어도 경계와 겹치는 리소스가 없으면 경계 차단이 먼저다
    let (s, arn) = solo_user_with_boundary(
        json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::a/*", "Condition": { "Bool": { "aws:SecureTransport": "true" } } }]),
        json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::b/*" }]),
    );
    assert_eq!(resources_of(&s, &arn, "s3:GetObject").map(|r| r.0), Some(Status::Boundary));
}

#[test]
fn nested_patterns_keep_the_narrower_one() {
    let narrowed = |identity: serde_json::Value, boundary: serde_json::Value| {
        let (s, arn) = solo_user_with_boundary(
            json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": identity }]),
            json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": boundary }]),
        );
        resources_of(&s, &arn, "s3:GetObject").unwrap()
    };
    // 경계가 더 좁으면 경계 쪽, 신원 정책이 더 좁으면 신원 쪽
    assert_eq!(narrowed(json!("arn:aws:s3:::bucket/*"), json!("arn:aws:s3:::bucket/public/*")), (Status::Allowed, strings(&["arn:aws:s3:::bucket/public/*"])));
    assert_eq!(narrowed(json!("arn:aws:s3:::bucket/public/*"), json!("arn:aws:s3:::bucket/*")), (Status::Allowed, strings(&["arn:aws:s3:::bucket/public/*"])));
    // 여러 패턴은 겹치는 것만 남는다
    assert_eq!(narrowed(json!(["arn:aws:s3:::a/*", "arn:aws:s3:::c/*"]), json!(["arn:aws:s3:::a/*", "arn:aws:s3:::b/*"])), (Status::Allowed, strings(&["arn:aws:s3:::a/*"])));
    assert_eq!(narrowed(json!("*"), json!(["arn:aws:s3:::x/*", "arn:aws:s3:::y/*"])), (Status::Allowed, strings(&["arn:aws:s3:::x/*", "arn:aws:s3:::y/*"])));
    assert_eq!(narrowed(json!(["arn:aws:s3:::x/*", "arn:aws:s3:::y/*"]), json!("*")), (Status::Allowed, strings(&["arn:aws:s3:::x/*", "arn:aws:s3:::y/*"])));
    // 서로 일부만 겹치면 하나의 패턴으로 적을 수 없어 신원 정책의 패턴이 남는다(경계 차단으로 보이지 않는다)
    assert_eq!(narrowed(json!("arn:aws:s3:::team-*"), json!("arn:aws:s3:::*-prod")), (Status::Allowed, strings(&["arn:aws:s3:::team-*"])));
}

#[test]
fn not_resource_on_either_side_is_narrowed_too() {
    let narrowed = |identity: serde_json::Value, boundary: serde_json::Value| {
        let (s, arn) = solo_user_with_boundary(
            json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": identity }]),
            json!([{ "Effect": "Allow", "Action": "s3:GetObject", "NotResource": boundary }]),
        );
        resources_of(&s, &arn, "s3:GetObject").unwrap()
    };
    let secret = "arn:aws:s3:::secret/*";
    let label = "* (제외: arn:aws:s3:::secret/*)";
    assert_eq!(narrowed(json!("*"), json!(secret)), (Status::Allowed, strings(&[label])));
    assert_eq!(narrowed(json!("arn:aws:s3:::open/*"), json!(secret)), (Status::Allowed, strings(&["arn:aws:s3:::open/*"])));
    // 신원 정책이 허용한 리소스가 경계의 제외 목록에 통째로 들면 경계가 막는다
    assert_eq!(narrowed(json!(secret), json!(secret)).0, Status::Boundary);

    let (s, arn) = solo_user_with_boundary(
        json!([{ "Effect": "Allow", "Action": "s3:GetObject", "NotResource": "arn:aws:s3:::audit/*" }]),
        json!([{ "Effect": "Allow", "Action": "s3:GetObject", "NotResource": secret }]),
    );
    assert_eq!(resources_of(&s, &arn, "s3:GetObject"), Some((Status::Allowed, strings(&["* (제외: arn:aws:s3:::audit/*, arn:aws:s3:::secret/*)"]))));
}

// ---- 부분 Deny ----

#[test]
fn a_deny_that_removes_the_unconditional_allow_leaves_the_conditional_one() {
    let (s, arn) = solo_user(json!([
        { "Sid": "Narrow", "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::x/*" },
        { "Sid": "Wide", "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*", "Condition": { "Bool": { "aws:SecureTransport": "true" } } },
        { "Sid": "NoX", "Effect": "Deny", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::x/*" }
    ]));
    // 남은 Allow는 조건이 달린 것뿐이다. 지워진 Allow의 리소스는 목록에서 빠진다
    assert_eq!(resources_of(&s, &arn, "s3:GetObject"), Some((Status::Conditional, strings(&["*"]))));
    let get = evaluate_action(&s, &arn, "s3:GetObject", None).unwrap();
    let sids: Vec<_> = get.sources.iter().map(|g| g.sid.as_deref().unwrap()).collect();
    assert_eq!(sids, vec!["Narrow", "Wide", "NoX"]);
    assert_eq!(table_status(&s, &arn, "s3", "GetObject"), Some(Status::Conditional));
    // 대상 리소스를 정하면 그 리소스에서의 답이다
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::x/key")), Some(Status::Denied));
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::y/key")), Some(Status::Conditional));

    // 남은 Allow에 조건이 없으면 그대로 허용이다
    let (s, arn) = solo_user(json!([
        { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::x/*" },
        { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*" },
        { "Effect": "Deny", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::x/*" }
    ]));
    assert_eq!(resources_of(&s, &arn, "s3:GetObject"), Some((Status::Allowed, strings(&["*"]))));
}

#[test]
fn several_unconditional_denies_can_remove_every_allow_together() {
    let allow = |resource: &str| json!({ "Effect": "Allow", "Action": "s3:GetObject", "Resource": resource });
    let deny = |resource: &str| json!({ "Effect": "Deny", "Action": "s3:GetObject", "Resource": resource });
    let (s, arn) = solo_user(json!([allow("arn:aws:s3:::a/*"), allow("arn:aws:s3:::b/*"), deny("arn:aws:s3:::a/*"), deny("arn:aws:s3:::b/*")]));
    assert_eq!(resources_of(&s, &arn, "s3:GetObject").map(|r| r.0), Some(Status::Denied));
    // 하나라도 남으면 허용이다
    let (s, arn) = solo_user(json!([allow("arn:aws:s3:::a/*"), allow("arn:aws:s3:::b/*"), deny("arn:aws:s3:::a/*")]));
    assert_eq!(resources_of(&s, &arn, "s3:GetObject"), Some((Status::Allowed, strings(&["arn:aws:s3:::b/*"]))));
    // 조건 있는 Deny는 남은 Allow를 모두 덮을 때만 판정을 바꾼다
    let conditional = json!({ "Effect": "Deny", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::b/*", "Condition": { "Bool": { "aws:SecureTransport": "false" } } });
    let (s, arn) = solo_user(json!([allow("arn:aws:s3:::a/*"), allow("arn:aws:s3:::b/*"), deny("arn:aws:s3:::a/*"), conditional]));
    assert_eq!(resources_of(&s, &arn, "s3:GetObject").map(|r| r.0), Some(Status::Conditional));
}

#[test]
fn a_not_resource_deny_covers_allows_that_fall_outside_its_list() {
    let deny = json!({ "Sid": "OnlyAllowed", "Effect": "Deny", "Action": "s3:GetObject", "NotResource": "arn:aws:s3:::allowed/*" });
    let with_allow = |resource: serde_json::Value| {
        let (s, arn) = solo_user(json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": resource }, deny.clone()]));
        resources_of(&s, &arn, "s3:GetObject").map(|r| r.0)
    };
    // 허용한 리소스가 제외 목록 밖에만 있으면 Deny가 전부 덮는다
    assert_eq!(with_allow(json!("arn:aws:s3:::other/*")), Some(Status::Denied));
    assert_eq!(with_allow(json!(["arn:aws:s3:::other/*", "arn:aws:s3:::more/*"])), Some(Status::Denied));
    // 제외 목록과 겹치는 부분이 있으면 거기서는 막히지 않는다
    assert_eq!(with_allow(json!("arn:aws:s3:::allowed/*")), Some(Status::Allowed));
    assert_eq!(with_allow(json!("arn:aws:s3:::allowed/deep/*")), Some(Status::Allowed));
    assert_eq!(with_allow(json!("*")), Some(Status::Allowed));
    assert_eq!(with_allow(json!("arn:aws:s3:::*/*")), Some(Status::Allowed));
    assert_eq!(with_allow(json!(["arn:aws:s3:::other/*", "arn:aws:s3:::allowed/*"])), Some(Status::Allowed));
    // 대상 리소스를 정하면 그 리소스만 본다
    let (s, arn) = solo_user(json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*" }, deny]));
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::other/x")), Some(Status::Denied));
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::allowed/x")), Some(Status::Allowed));
}

// ---- NotAction 문장이 여럿인 주체 ----

#[test]
fn many_not_action_statements_agree_with_the_single_action_path() {
    let (s, arn) = solo_user_with_boundary(
        json!([
            { "Sid": "A", "Effect": "Allow", "NotAction": "iam:*", "Resource": "*" },
            { "Sid": "B", "Effect": "Allow", "NotAction": ["ec2:*", "s3:*"], "Resource": "arn:aws:s3:::*" },
            { "Sid": "C", "Effect": "Allow", "NotAction": ["sts:*", "kms:*"], "Resource": "*", "Condition": { "Bool": { "aws:SecureTransport": "true" } } },
            { "Sid": "D", "Effect": "Deny", "NotAction": ["s3:*", "ec2:*", "lambda:*"], "Resource": "*", "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "false" } } },
            { "Sid": "E", "Effect": "Deny", "NotAction": ["s3:*", "ec2:*", "lambda:*", "iam:*", "sts:*", "kms:*"], "Resource": "arn:aws:s3:::secret/*" }
        ]),
        json!([
            { "Sid": "Limit", "Effect": "Allow", "NotAction": ["organizations:*", "account:*"], "Resource": "*" },
            { "Sid": "NoDelete", "Effect": "Deny", "Action": "s3:Delete*", "Resource": "*" }
        ]),
    );
    let eval = evaluate(&s, &arn).unwrap();
    let cat = catalog();
    // 카탈로그의 모든 작업에서 판정·리소스·근거·범위 플래그가 같다
    assert_eq!(assert_paths_agree(&s, &arn, &[]), cat.all_count());
    // `decide_action`(다른 모듈이 쓰는 한 건 판정)도 같은 답이다
    let (sources, boundary) = policy_sources(&s, &arn);
    for (prefix, _) in cat.services().filter(|(prefix, _)| ["s3", "iam", "sts", "kms", "organizations"].contains(prefix)) {
        for (name, _) in cat.actions(prefix) {
            let single = decide_action(&sources, boundary.as_ref(), &format!("{prefix}:{name}"), None);
            assert_eq!(single.as_ref(), eval.actions.get(&key(prefix, name)).map(|(_, e)| e), "{prefix}:{name}");
        }
    }
    // 범위 플래그가 실제로 갈리는 작업들이다: A와 경계가 조건 없이 모든 리소스에 열면 true, 조건부·거부·경계 차단이면 false
    let full_scope = |action: &str| verdict_of(&s, &arn, action).map(|v| v.full_scope);
    assert_eq!(full_scope("s3:GetObject"), Some(true));
    assert_eq!(full_scope("iam:GetUser"), Some(false));
    assert_eq!(full_scope("s3:DeleteBucket"), Some(false));
    assert_eq!(full_scope("organizations:ListAccounts"), Some(false));

    let at = |prefix: &str, action: &str| eval.actions.get(&key(prefix, action)).map(|(_, e)| e.status);
    // A가 허용하고 막는 문장은 없다
    assert_eq!(at("s3", "GetObject"), Some(Status::Allowed));
    // iam은 A에서 빠지고 B·C가 허용하지만 D의 조건 Deny가 걸린다
    assert_eq!(at("iam", "GetUser"), Some(Status::Conditional));
    // sts는 C에서 빠지고 A·B가 허용한다. D도 걸려 조건부다
    assert_eq!(at("sts", "AssumeRole"), Some(Status::Conditional));
    // 경계가 허용하지 않는 서비스는 막힌다
    assert_eq!(at("organizations", "ListAccounts"), Some(Status::Boundary));
    // 경계의 Deny는 Deny다
    assert_eq!(at("s3", "DeleteBucket"), Some(Status::Denied));
    assert!(eval.unknown.is_empty());
    // 모든 작업이 A나 B 중 하나에는 맞아서 표에 빠지는 작업이 없다
    assert_eq!(eval.actions.len(), cat.all_count());
}
