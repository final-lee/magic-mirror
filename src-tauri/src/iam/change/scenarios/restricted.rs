//! 허용이던 작업이 조건부가 되는 변경(조건 있는 Deny). 잃은 것은 아니지만 조건이 맞지 않으면 막히므로,
//! 앱이 쓰는 자격 증명이면 권한 축소처럼 확인받고, 다른 주체면 알려 준다.

use super::*;
use crate::iam::change::impact::MAX_ROWS;

const CALLER_RESTRICTED: &str = "조건에 따라 이 앱의 자격 증명이 막힐 수 있어요 (예: MFA·IP 조건)";

/// AWS 문서의 "MFA로 로그인하지 않으면 거부" 정책: MFA 관리에 필요한 작업만 빼고 모두, MFA가 없으면(키에는 그 값이 아예 없다) 거부한다.
fn deny_without_mfa(s: &mut Snapshot) -> String {
    add_policy(
        s,
        "deny-without-mfa",
        json!([{
            "Sid": "DenyAllExceptListedIfNoMFA",
            "Effect": "Deny",
            "NotAction": [
                "iam:CreateVirtualMFADevice", "iam:EnableMFADevice", "iam:GetUser", "iam:ChangePassword",
                "iam:ListMFADevices", "iam:ListVirtualMFADevices", "iam:ResyncMFADevice", "sts:GetSessionToken"
            ],
            "Resource": "*",
            "Condition": { "BoolIfExists": { "aws:MultiFactorAuthPresent": "false" } }
        }]),
    )
}

fn member(name: &str, group: &str, statements: Value) -> crate::iam::model::UserRec {
    let mut u = user(name);
    u.groups = vec![group.to_string()];
    u.inline.push(inline("own", policy(statements)));
    u
}

#[test]
fn a_deny_unless_mfa_on_the_callers_group_needs_confirmation() {
    // alice가 앱이 쓰는 주체이고 그룹 admins로 관리자 권한을 받는다
    let mut s = snapshot();
    let mfa = deny_without_mfa(&mut s);
    let p = preview(&s, &attach(ADMINS, &mfa), None);

    let message = only(&p, WarnLevel::Confirm);
    assert!(message.starts_with(CALLER_RESTRICTED) && !message.contains("권한이 줄어요"), "잃은 것은 없으니 권한 축소 문구는 없어요: {message}");
    // 되돌리는 데 쓸 iam:DetachGroupPolicy도 MFA가 없으면 막힌다: 키로 쓰는 이 앱은 되돌리지 못할 수 있다
    assert!(message.contains("iam:DetachGroupPolicy") && message.contains("조건부"), "{message}");
    assert!(!p.reversible);
    assert_eq!(p.confirm_text.as_deref(), Some("admins"));
    assert!(!has_level(&p, WarnLevel::Block));
    // 그룹은 로그인하지 않으므로 "다른 사람" 수에 들지 않는다
    assert!(!messages(&p, WarnLevel::Warn).iter().any(|m| m.contains("조건부로 바뀌어요")), "{:?}", p.warnings);

    assert_eq!(impact_names(&p), vec!["admins", "alice"]);
    let alice = &p.impacts[1];
    assert!(alice.gained.is_empty() && alice.lost.is_empty());
    assert_eq!(alice.restricted.len(), MAX_ROWS);
    assert!(alice.restricted_omitted > 0);
    // NotAction에 든 작업은 그대로 조건 없이 허용된다
    assert!(alice.restricted.iter().all(|d| !d.sample.iter().any(|a| a == "sts:GetSessionToken" || a == "iam:GetUser")));
}

#[test]
fn the_restriction_warning_says_when_the_caller_could_not_undo_it() {
    // dave(앱이 쓰는 주체)는 그룹 ops에 정책을 붙일 수는 있지만 뗄 권한은 원래 없다
    let mut s = called_by(snapshot(), None);
    let mfa = deny_without_mfa(&mut s);
    s.groups.push(group_rec("ops", &[]));
    let dave = member("dave", "ops", json!([{ "Effect": "Allow", "Action": ["s3:*", "iam:AttachGroupPolicy"], "Resource": "*" }]));
    s.caller_principal_arn = Some(dave.arn.clone());
    s.users.push(dave);

    let p = preview(&s, &attach(&account_arn("group/ops"), &mfa), None);
    let message = only(&p, WarnLevel::Confirm);
    assert!(message.starts_with(CALLER_RESTRICTED), "{message}");
    assert!(message.contains("iam:DetachGroupPolicy") && message.contains("되돌릴 수 없어요"), "{message}");
    assert_eq!(p.confirm_text.as_deref(), Some("ops"));
}

#[test]
fn an_undo_permission_that_was_already_conditional_is_not_blamed_on_the_change() {
    // dave(앱이 쓰는 주체)는 S3를 조건 없이 쓰고, IAM 작업은 처음부터 MFA가 있어야 쓸 수 있다
    let mut s = called_by(snapshot(), None);
    let deny_s3 = add_policy(&mut s, "deny-s3", json!([{ "Effect": "Deny", "Action": "s3:*", "Resource": "*" }]));
    s.groups.push(group_rec("ops", &[]));
    let dave = member(
        "dave",
        "ops",
        json!([
            { "Effect": "Allow", "Action": "s3:*", "Resource": "*" },
            { "Effect": "Allow", "Action": "iam:*", "Resource": "*", "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "true" } } }
        ]),
    );
    s.caller_principal_arn = Some(dave.arn.clone());
    s.users.push(dave);

    let p = preview(&s, &attach(&account_arn("group/ops"), &deny_s3), None);
    let message = only(&p, WarnLevel::Confirm);
    assert!(message.contains("권한이 줄어요") && !message.contains("되돌"), "{message}");
    assert!(p.reversible);
}

#[test]
fn a_restriction_and_a_loss_of_the_caller_are_both_confirmed_and_the_undo_note_is_said_once() {
    let mut s = snapshot();
    let mixed = add_policy(
        &mut s,
        "mixed",
        json!([
            { "Effect": "Deny", "Action": "s3:*", "Resource": "*", "Condition": { "IpAddress": { "aws:SourceIp": "10.0.0.0/8" } } },
            { "Effect": "Deny", "Action": ["ec2:*", "iam:DetachGroupPolicy"], "Resource": "*" }
        ]),
    );
    let p = preview(&s, &attach(ADMINS, &mixed), None);
    let confirms = messages(&p, WarnLevel::Confirm);
    assert_eq!(confirms.len(), 2, "{:?}", p.warnings);
    assert!(confirms[0].contains("권한이 줄어요") && confirms[0].contains("iam:DetachGroupPolicy"), "{}", confirms[0]);
    assert_eq!(confirms[1], CALLER_RESTRICTED);
    let alice = &p.impacts[1];
    assert!(alice.lost.iter().any(|d| d.prefix == "ec2") && alice.restricted.iter().all(|d| d.prefix == "s3"));
}

#[test]
fn other_principals_whose_access_becomes_conditional_are_counted_but_not_confirmed() {
    let mut s = snapshot();
    let mfa = deny_without_mfa(&mut s);
    s.groups.push(group_rec("ops", &[]));
    for name in ["dave", "erin"] {
        s.users.push(member(name, "ops", json!([{ "Effect": "Allow", "Action": "sqs:*", "Resource": "*" }])));
    }
    let p = preview(&s, &attach(&account_arn("group/ops"), &mfa), None);
    assert_eq!(only(&p, WarnLevel::Warn), "2명의 일부 권한이 조건부로 바뀌어요");
    assert!(!has_level(&p, WarnLevel::Confirm), "{:?}", p.warnings);
    assert_eq!(impact_names(&p), vec!["dave", "erin"], "권한이 없는 그룹 자신은 바뀌는 것이 없어요");
    assert!(p.impacts.iter().all(|i| i.restricted.iter().all(|d| d.prefix == "sqs") && i.gained.is_empty() && i.lost.is_empty()));
}

#[test]
fn a_role_counts_as_someone_whose_access_becomes_conditional() {
    let mut s = snapshot();
    let mfa = deny_without_mfa(&mut s);
    let p = preview(&s, &attach(DEPLOY, &mfa), None);
    assert!(messages(&p, WarnLevel::Warn).contains(&"1명의 일부 권한이 조건부로 바뀌어요"), "{:?}", p.warnings);
}

#[test]
fn access_that_was_already_conditional_is_not_restricted_again() {
    let mut s = snapshot();
    let mfa = deny_without_mfa(&mut s);
    // deploy의 lambda:*는 처음부터 리전 조건이 붙은 조건부다. 조건 없는 iam:PassRole만 조건부로 바뀐다
    let p = preview(&s, &attach(DEPLOY, &mfa), None);
    let deploy = &p.impacts[0];
    assert!(deploy.restricted.iter().all(|d| d.prefix == "iam"), "{:?}", deploy.restricted);
    assert_eq!(deploy.restricted.iter().map(|d| d.count).sum::<usize>(), 1);
}
