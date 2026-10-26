//! 리뷰 반영 테스트 2: 모든 리소스에 조건 없이 열린 작업(관리자급 90% 규칙, "모든 리소스" 위험 표시),
//! 권한 경계로 좁힌 뒤의 조건과 Deny, 리소스 패턴 단위로 따지는 Deny.

use serde_json::json;

use super::{assert_paths_agree, resources_of, status, strings, verdict_of};
use crate::iam::catalog::AccessLevel;
use crate::iam::danger::admin_like_statementwise;
use crate::iam::eval::{evaluate, evaluate_action, principal_actions, principal_view, Status};
use crate::iam::fixtures::*;
use crate::iam::model::{Scope, Snapshot};
use crate::iam::view::BadgeKind;

/// 칸을 눌렀을 때 나오는 작업 목록에서 `action`의 위험 표시.
fn danger_of(s: &Snapshot, arn: &str, prefix: &str, level: AccessLevel, action: &str) -> Option<String> {
    let grants = principal_actions(s, arn, prefix, level);
    grants.into_iter().find(|g| g.action == action).unwrap_or_else(|| panic!("{action}이 목록에 없어요")).danger
}

/// 권한 표의 S3 줄에 위험 표시가 있는지.
fn s3_row_is_dangerous(s: &Snapshot, arn: &str) -> bool {
    principal_view(s, arn).unwrap().services.iter().find(|svc| svc.prefix == "s3").expect("S3 줄이 있어야 해요").danger
}

const MFA: &str = "aws:MultiFactorAuthPresent";

// ---- NotResource로 몇 곳만 뺀 전체 허용은 모든 리소스로 센다 ----

#[test]
fn full_access_except_a_not_resource_list_is_admin_like() {
    let (s, arn) = solo_user(json!([{ "Effect": "Allow", "Action": "*", "NotResource": "arn:aws:s3:::secret/*" }]));
    // 문장만 봐서는 `Resource:"*"`가 아니라 90% 규칙으로만 관리자급이 된다
    assert!(!admin_like_statementwise(&s, &arn));
    assert!(evaluate(&s, &arn).unwrap().admin_like);
    let view = principal_view(&s, &arn).unwrap();
    assert!(view.admin_like);
    assert_eq!(view.summary.badges.first().map(|b| b.kind), Some(BadgeKind::Admin));
    // 권한 관리 작업은 모든 리소스에 대한 것으로 표시한다
    assert_eq!(resources_of(&s, &arn, "s3:PutBucketPolicy"), Some((Status::Allowed, strings(&["* (제외: arn:aws:s3:::secret/*)"]))));
    assert!(verdict_of(&s, &arn, "s3:PutBucketPolicy").unwrap().full_scope);
    let danger = danger_of(&s, &arn, "s3", AccessLevel::Permissions, "s3:PutBucketPolicy");
    assert!(danger.as_deref().is_some_and(|d| d.contains("모든 리소스")), "{danger:?}");
    assert!(s3_row_is_dangerous(&s, &arn));
}

#[test]
fn an_administrator_with_a_not_resource_boundary_is_still_admin_like() {
    let mut s = snapshot();
    let guard = format!("arn:aws:iam::{ACCOUNT}:policy/audit-guard");
    let boundary = policy(json!([{ "Effect": "Allow", "Action": "*", "NotResource": "arn:aws:s3:::audit/*" }]));
    s.policies.insert(guard.clone(), managed(&guard, Scope::Local, 0, boundary));
    s.users.iter_mut().find(|u| u.arn == ALICE).unwrap().boundary = Some(guard);
    // 경계 문장이 `Resource:"*"`가 아니라 문장 단위 판정은 관리자급이 아니다
    assert!(!admin_like_statementwise(&s, ALICE));
    assert!(evaluate(&s, ALICE).unwrap().admin_like);
    assert!(principal_view(&s, ALICE).unwrap().admin_like);
    assert_eq!(resources_of(&s, ALICE, "s3:PutBucketPolicy"), Some((Status::Allowed, strings(&["* (제외: arn:aws:s3:::audit/*)"]))));
    assert!(verdict_of(&s, ALICE, "s3:PutBucketPolicy").unwrap().full_scope);
    let danger = danger_of(&s, ALICE, "s3", AccessLevel::Permissions, "s3:PutBucketPolicy");
    assert!(danger.as_deref().is_some_and(|d| d.contains("모든 리소스")), "{danger:?}");

    // 리소스를 한 버킷으로 좁힌 전체 허용은 그대로 관리자급이 아니고 "모든 리소스"도 아니다
    let (s, arn) = solo_user(json!([{ "Effect": "Allow", "Action": "*", "Resource": "arn:aws:s3:::bucket/*" }]));
    assert!(!evaluate(&s, &arn).unwrap().admin_like);
    assert!(!verdict_of(&s, &arn, "s3:PutBucketPolicy").unwrap().full_scope);
    assert_eq!(danger_of(&s, &arn, "s3", AccessLevel::Permissions, "s3:PutBucketPolicy"), None);
}

// ---- 조건이 있어야 넓게 열리는 허용은 세지 않는다 ----

#[test]
fn a_wildcard_that_needs_a_condition_is_neither_admin_like_nor_every_resource() {
    let (s, arn) = solo_user(json!([
        { "Effect": "Allow", "Action": "*", "Resource": "arn:aws:s3:::bucket" },
        { "Effect": "Allow", "Action": "*", "Resource": "*", "Condition": { "Bool": { MFA: "true" } } }
    ]));
    let eval = evaluate(&s, &arn).unwrap();
    // 버킷 하나에는 조건 없이 열려 있어 작업마다 허용이지만, 모든 리소스에 열리는 것은 MFA를 썼을 때뿐이다
    assert!(eval.actions.values().all(|(_, e)| e.status == Status::Allowed));
    assert!(!eval.admin_like);
    let view = principal_view(&s, &arn).unwrap();
    assert!(!view.admin_like);
    assert!(view.summary.badges.iter().all(|b| b.kind != BadgeKind::Admin), "{:?}", view.summary.badges);
    assert!(!s3_row_is_dangerous(&s, &arn));
    let grants = principal_actions(&s, &arn, "s3", AccessLevel::Permissions);
    assert!(!grants.is_empty());
    assert!(grants.iter().all(|g| g.danger.is_none()), "{grants:?}");
    let put = verdict_of(&s, &arn, "s3:PutBucketPolicy").unwrap();
    assert_eq!((put.eval.status, put.full_scope), (Status::Allowed, false));
    assert_eq!(put.eval.resources, strings(&["arn:aws:s3:::bucket", "*"]));
}

#[test]
fn the_scope_flag_agrees_between_the_table_and_single_actions() {
    let principals = [
        solo_user(json!([{ "Effect": "Allow", "Action": "*", "NotResource": "arn:aws:s3:::secret/*" }])),
        solo_user(json!([
            { "Effect": "Allow", "Action": "*", "Resource": "arn:aws:s3:::bucket" },
            { "Effect": "Allow", "Action": "*", "Resource": "*", "Condition": { "Bool": { MFA: "true" } } }
        ])),
        solo_user_with_boundary(
            json!([{ "Effect": "Allow", "Action": "*", "Resource": "*" }, { "Effect": "Deny", "Action": "s3:Delete*", "Resource": "arn:aws:s3:::team-*" }]),
            json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "arn:aws:s3:::team-*" }, { "Effect": "Allow", "Action": "iam:*", "NotResource": "arn:aws:iam::*:role/admin" }]),
        ),
    ];
    for (s, arn) in &principals {
        assert!(assert_paths_agree(s, arn, &["s3", "iam", "ec2"]) > 0);
    }
    let flag = |i: usize, action: &str| verdict_of(&principals[i].0, &principals[i].1, action).map(|v| v.full_scope);
    assert_eq!(flag(0, "ec2:RunInstances"), Some(true));
    assert_eq!(flag(1, "ec2:RunInstances"), Some(false));
    // 경계가 S3는 team-*로 좁히고 IAM은 NotResource로 연다. 그 밖의 서비스는 경계가 막는다
    assert_eq!(flag(2, "s3:GetObject"), Some(false));
    assert_eq!(flag(2, "iam:CreateUser"), Some(true));
    assert_eq!(flag(2, "ec2:RunInstances"), Some(false));
    assert_eq!(resources_of(&principals[2].0, &principals[2].1, "ec2:RunInstances").map(|r| r.0), Some(Status::Boundary));
}

// ---- 경계로 좁힌 뒤에는 겹친 문장 쌍의 조건을 본다 ----

#[test]
fn an_unconditional_allow_outside_the_boundary_does_not_make_the_grant_unconditional() {
    let (s, arn) = solo_user_with_boundary(
        json!([
            { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::a/*" },
            { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*", "Condition": { "Bool": { MFA: "true" } } }
        ]),
        json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::b/*" }]),
    );
    // 조건 없는 Allow(a/*)는 경계(b/*)와 겹치지 않으니, 남는 것은 조건 있는 Allow가 b/*에 여는 것뿐이다
    assert_eq!(resources_of(&s, &arn, "s3:GetObject"), Some((Status::Conditional, strings(&["arn:aws:s3:::b/*"]))));
    // 대상 리소스를 정한 답과도 맞는다
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::b/x")), Some(Status::Conditional));
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::a/x")), Some(Status::Boundary));
}

#[test]
fn a_conditional_boundary_statement_does_not_make_the_grant_unconditional() {
    let boundary = json!([
        { "Effect": "Allow", "Action": "s3:*", "Resource": "arn:aws:s3:::team-*" },
        { "Effect": "Allow", "Action": "*", "Resource": "*", "Condition": { "StringEquals": { "aws:RequestedRegion": "us-east-1" } } }
    ]);
    let (s, arn) = solo_user_with_boundary(json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "arn:aws:s3:::other-bucket/*" }]), boundary.clone());
    // 조건 없는 경계 문장(team-*)은 신원 정책(other-bucket/*)과 겹치지 않고, 겹치는 것은 조건 있는 `*`뿐이다
    assert_eq!(resources_of(&s, &arn, "s3:GetObject"), Some((Status::Conditional, strings(&["arn:aws:s3:::other-bucket/*"]))));
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::other-bucket/x")), Some(Status::Conditional));

    // 조건 없는 쌍이 하나라도 겹치면 허용이다
    let (s, arn) = solo_user_with_boundary(json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "arn:aws:s3:::team-a/*" }]), boundary);
    assert_eq!(resources_of(&s, &arn, "s3:GetObject"), Some((Status::Allowed, strings(&["arn:aws:s3:::team-a/*"]))));
}

// ---- 경계로 좁힌 범위에 Deny를 다시 적용한다 ----

#[test]
fn a_deny_that_covers_what_the_boundary_leaves_denies_the_action() {
    let (s, arn) = solo_user_with_boundary(
        json!([
            { "Effect": "Allow", "Action": "s3:*", "Resource": "*" },
            { "Sid": "KeepTeam", "Effect": "Deny", "Action": "s3:Delete*", "Resource": "arn:aws:s3:::team-*" }
        ]),
        json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "arn:aws:s3:::team-*" }]),
    );
    // 신원 정책만 보면 Deny는 team-*만 막지만, 경계가 남기는 것이 team-*뿐이라 지울 수 없는 곳이 없다
    let delete = evaluate_action(&s, &arn, "s3:DeleteBucket", None).unwrap();
    assert_eq!(delete.status, Status::Denied);
    assert_eq!(delete.sources[0].sid.as_deref(), Some("KeepTeam"));
    // 거부면 신원 정책 Allow가 열려던 리소스를 적는다
    assert_eq!(resources_of(&s, &arn, "s3:DeleteBucket"), Some((Status::Denied, strings(&["*"]))));
    // Deny가 걸리지 않는 작업은 경계가 좁힌 범위에서 허용이다
    assert_eq!(resources_of(&s, &arn, "s3:GetObject"), Some((Status::Allowed, strings(&["arn:aws:s3:::team-*"]))));
    // 대상 리소스를 정한 답과도 맞는다
    assert_eq!(status(&s, &arn, "s3:DeleteBucket", Some("arn:aws:s3:::team-a")), Some(Status::Denied));
    assert_eq!(status(&s, &arn, "s3:DeleteBucket", Some("arn:aws:s3:::other")), Some(Status::Boundary));
}

// ---- 리소스 패턴 하나하나를 따로 따진다 ----

#[test]
fn denies_remove_allowed_patterns_one_by_one() {
    let allow = json!({ "Effect": "Allow", "Action": "s3:GetObject", "Resource": ["arn:aws:s3:::a/*", "arn:aws:s3:::b/*"] });
    let deny = |resource: &str| json!({ "Effect": "Deny", "Action": "s3:GetObject", "Resource": resource });
    // Deny 둘이 한 Allow의 두 패턴을 하나씩 막으면 남는 것이 없다
    let (s, arn) = solo_user(json!([allow.clone(), deny("arn:aws:s3:::a/*"), deny("arn:aws:s3:::b/*")]));
    assert_eq!(resources_of(&s, &arn, "s3:GetObject").map(|r| r.0), Some(Status::Denied));
    // 하나만 막으면 남은 패턴만 허용으로 적는다
    let (s, arn) = solo_user(json!([allow, deny("arn:aws:s3:::a/*")]));
    assert_eq!(resources_of(&s, &arn, "s3:GetObject"), Some((Status::Allowed, strings(&["arn:aws:s3:::b/*"]))));
}

#[test]
fn a_conditional_deny_over_every_unconditional_grant_makes_it_conditional() {
    let conditional_deny = json!({ "Effect": "Deny", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::a/*", "Condition": { "Bool": { MFA: "false" } } });
    // 조건 없이 열린 곳(a/*)은 MFA가 없으면 막히고, 나머지(*)는 조건이 맞아야 열린다: 조건 없이 되는 곳이 없다
    let (s, arn) = solo_user(json!([
        { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::a/*" },
        { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*", "Condition": { "Bool": { "aws:SecureTransport": "true" } } },
        conditional_deny.clone()
    ]));
    assert_eq!(resources_of(&s, &arn, "s3:GetObject").map(|r| r.0), Some(Status::Conditional));
    // 같은 Allow에 권한 경계(a/*)를 더해도 답이 같다
    let (s, arn) = solo_user_with_boundary(
        json!([
            { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::a/*" },
            { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*", "Condition": { "Bool": { "aws:SecureTransport": "true" } } },
            conditional_deny.clone()
        ]),
        json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::a/*" }]),
    );
    assert_eq!(resources_of(&s, &arn, "s3:GetObject").map(|r| r.0), Some(Status::Conditional));
    // 조건 없이 열린 곳이 Deny 밖에도 남으면 허용이다
    let (s, arn) = solo_user(json!([
        { "Effect": "Allow", "Action": "s3:GetObject", "Resource": ["arn:aws:s3:::a/*", "arn:aws:s3:::b/*"] },
        conditional_deny
    ]));
    assert_eq!(resources_of(&s, &arn, "s3:GetObject"), Some((Status::Allowed, strings(&["arn:aws:s3:::a/*", "arn:aws:s3:::b/*"]))));
}
