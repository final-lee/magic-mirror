//! 주의(warn) 경고와 경고의 순서·확인 문구 규칙.

use super::*;

#[test]
fn targets_managed_by_cloudformation_get_a_warning() {
    let mut s = snapshot();
    let p = preview(&s, &attach(DEPLOY, S3_FULL), None);
    let message = only(&p, WarnLevel::Warn);
    assert!(message.contains("CloudFormation") && message.contains("deploy-stack"), "{message}");
    assert_eq!(p.confirm_text, None);

    s.users[1].tags.insert("aws:cloudformation:stack-name".into(), "users-stack".into());
    for change in [attach(BOB, S3_FULL), add_to_group("bob", "admins"), drop_inline(BOB, "assets-read")] {
        assert!(messages(&preview(&s, &change, None), WarnLevel::Warn).iter().any(|m| m.contains("users-stack")), "{change:?}");
    }
    // 태그가 없는 대상은 조용하다
    assert!(!has_level(&preview(&s, &attach(CAROL, UNUSED_POLICY), None), WarnLevel::Warn));
}

#[test]
fn a_full_version_list_is_mentioned_and_the_oldest_version_goes_first() {
    let mut s = snapshot();
    s.policies.get_mut(UNUSED_POLICY).unwrap().versions = versions(&["v3", "v4", "v5", "v6", "v7"], "v7");
    let p = preview(&s, &update_managed(UNUSED_POLICY, allow(&["sqs:*"])), None);
    let message = only(&p, WarnLevel::Warn);
    assert!(message.contains("5개") && message.contains("v3"), "{message}");
    assert_eq!(p.calls.iter().map(|c| c.api.as_str()).collect::<Vec<_>>(), vec!["iam:DeletePolicyVersion", "iam:CreatePolicyVersion"]);
    assert_eq!(p.calls[0].params["VersionId"], "v3");

    s.policies.get_mut(UNUSED_POLICY).unwrap().versions = versions(&["v4", "v5", "v6", "v7"], "v7");
    assert!(!has_level(&preview(&s, &update_managed(UNUSED_POLICY, allow(&["sqs:*"])), None), WarnLevel::Warn));
}

#[test]
fn five_or_more_affected_principals_get_a_warning() {
    let mut s = called_by(snapshot(), None);
    let reader = add_policy(&mut s, "reader", json!([{ "Effect": "Allow", "Action": "sqs:ReceiveMessage", "Resource": "*" }]));
    s.groups.push(group_rec("many", &[&reader]));
    let group = account_arn("group/many");
    for i in 0..3 {
        let mut u = user(&format!("u{i}"));
        u.groups = vec!["many".into()];
        s.users.push(u);
    }
    // 그룹 하나와 구성원 셋: 4
    let p = preview(&s, &detach(&group, &reader), None);
    assert_eq!(p.impacts.len(), 4);
    assert!(!has_level(&p, WarnLevel::Warn));

    let mut u = user("u3");
    u.groups = vec!["many".into()];
    s.users.push(u);
    let p = preview(&s, &detach(&group, &reader), None);
    assert_eq!(p.impacts.len(), 5);
    assert!(only(&p, WarnLevel::Warn).contains('5'), "{:?}", p.warnings);
}

#[test]
fn action_names_the_catalog_does_not_know_are_pointed_out_for_documents_the_user_writes() {
    let s = snapshot();
    let p = preview(&s, &put_inline(BOB, "typo", allow(&["s3:GetObjct", "s3:GetObject"])), None);
    let message = only(&p, WarnLevel::Warn);
    assert!(message.contains("s3:GetObjct") && !message.contains("s3:GetObject"), "{message}");
    assert!(!has_level(&p, WarnLevel::Block), "오타는 막지 않고 알려 주기만 해요");
}

#[test]
fn unknown_actions_that_were_already_there_are_not_blamed_on_this_change() {
    let mut s = snapshot();
    s.users[1].inline.push(inline("old", policy(json!([{ "Effect": "Allow", "Action": "madeup:Thing", "Resource": "*" }]))));
    let p = preview(&s, &put_inline(BOB, "fine", allow(&["sqs:SendMessage"])), None);
    assert!(!has_level(&p, WarnLevel::Warn), "{:?}", p.warnings);
}

#[test]
fn a_managed_policy_edit_with_a_typo_warns_when_someone_has_the_policy() {
    let mut s = snapshot();
    let shared = add_policy(&mut s, "shared", json!([{ "Effect": "Allow", "Action": "sqs:*", "Resource": "*" }]));
    s.users[1].attached.push(shared.clone());
    let p = preview(&s, &update_managed(&shared, allow(&["sqs:SendMesage"])), None);
    assert!(only(&p, WarnLevel::Warn).contains("sqs:SendMesage"));
}

#[test]
fn attaching_a_policy_somebody_else_wrote_does_not_check_its_action_names() {
    let mut s = snapshot();
    let odd = add_policy(&mut s, "odd", json!([{ "Effect": "Allow", "Action": "madeup:Thing", "Resource": "*" }]));
    assert!(!has_level(&preview(&s, &attach(BOB, &odd), None), WarnLevel::Warn));
}

#[test]
fn changes_that_are_already_true_say_so_and_leave_nothing_to_undo() {
    let s = snapshot();
    let p = preview(&s, &attach(CAROL, S3_FULL), None);
    assert!(only(&p, WarnLevel::Warn).contains("이미"));
    assert!(p.impacts.is_empty());
    assert!(!p.reversible);

    let p = preview(&s, &add_to_group("alice", "admins"), None);
    assert!(only(&p, WarnLevel::Warn).contains("이미"));
    assert!(!p.reversible);

    let p = preview(&s, &set_status("bob", "AKIA1", "Inactive"), Some("Inactive"));
    assert!(only(&p, WarnLevel::Warn).contains("이미"));
    assert!(!p.reversible);
}

#[test]
fn a_policy_whose_document_is_unknown_says_the_effect_could_not_be_computed() {
    let mut s = snapshot();
    let p = preview(&s, &attach(BOB, &account_arn("policy/brand-new")), None);
    assert_eq!(only(&p, WarnLevel::Warn), "정책 문서를 읽지 못해 권한 변화를 계산하지 못했어요");
    assert!(p.impacts.is_empty());
    assert!(p.reversible);

    s.policies.get_mut(UNUSED_POLICY).unwrap().document = None;
    s.users[1].attached.push(UNUSED_POLICY.into());
    let p = preview(&s, &detach(BOB, UNUSED_POLICY), None);
    assert!(only(&p, WarnLevel::Warn).contains("읽지 못"));
}

#[test]
fn warnings_are_listed_block_first_then_confirm_then_warn() {
    let mut s = snapshot();
    s.policies.get_mut(ADMIN_POLICY).unwrap().versions = versions(&["v1", "v2", "v3", "v4", "v5"], "v1");
    let p = preview(&s, &update_managed(ADMIN_POLICY, allow(&["s3:*"])), None);
    let levels: Vec<WarnLevel> = p.warnings.iter().map(|w| w.level).collect();
    assert_eq!(levels, vec![WarnLevel::Block, WarnLevel::Warn]);

    let s = called_by(snapshot(), Some(DEPLOY));
    let p = preview(&s, &drop_inline(DEPLOY, "deploy-inline"), None);
    let levels: Vec<WarnLevel> = p.warnings.iter().map(|w| w.level).collect();
    assert_eq!(levels, vec![WarnLevel::Confirm, WarnLevel::Confirm, WarnLevel::Warn]);
}

#[test]
fn a_confirmation_text_exists_exactly_when_a_confirm_warning_does() {
    let s = snapshot();
    let samples = [
        attach(BOB, S3_FULL),
        attach(BOB, ADMIN_POLICY),
        detach(ADMINS, ADMIN_POLICY),
        delete_key("bob", "AKIA1"),
        drop_inline(BOB, "assets-read"),
        put_inline(SLR, "p", allow(&["s3:*"])),
        add_to_group("alice", "admins"),
    ];
    for change in samples {
        let p = preview(&s, &change, Some("Active"));
        assert_eq!(p.confirm_text.is_some(), has_level(&p, WarnLevel::Confirm), "{change:?}: {:?}", p.warnings);
    }
}

#[test]
fn the_preview_is_pure_and_repeatable() {
    let s = snapshot();
    let change = detach(ADMINS, ADMIN_POLICY);
    assert_eq!(preview(&s, &change, None), preview(&s, &change, None));
}

#[test]
fn many_unknown_action_names_are_shortened() {
    let s = snapshot();
    let typos: Vec<String> = (0..7).map(|i| format!("madeup:Thing{i}")).collect();
    let refs: Vec<&str> = typos.iter().map(String::as_str).collect();
    let p = preview(&s, &put_inline(BOB, "typos", allow(&refs)), None);
    let message = only(&p, WarnLevel::Warn);
    assert!(message.contains("madeup:Thing0") && message.contains("madeup:Thing4") && !message.contains("madeup:Thing5"), "{message}");
    assert!(message.contains("외 2개"), "{message}");
}

#[test]
fn warnings_are_sorted_even_when_a_later_rule_adds_a_more_serious_one() {
    let mut s = called_by(snapshot(), None);
    let mut many = group_rec("many", &[]);
    many.inline.push(inline("p", policy(json!([{ "Effect": "Allow", "Action": "sqs:ReceiveMessage", "Resource": "*" }]))));
    s.groups.push(many);
    for i in 0..6 {
        let mut u = user(&format!("u{i}"));
        u.groups = vec!["many".into()];
        s.users.push(u);
    }
    // 영향받는 주체 수(주의)는 영향 계산에서, 인라인 정책 삭제(확인)는 그 뒤에 만들어지지만 확인이 먼저 온다
    let p = preview(&s, &drop_inline(&account_arn("group/many"), "p"), None);
    let levels: Vec<WarnLevel> = p.warnings.iter().map(|w| w.level).collect();
    assert_eq!(levels, vec![WarnLevel::Confirm, WarnLevel::Warn], "{:?}", p.warnings);
    assert!(p.warnings[1].message.contains('7'), "{:?}", p.warnings);
}
