//! 경고 규칙: 막힘(block)과 확인(confirm) 경고, 확인 문구. 주의(warn)와 경고 순서는 `notices.rs`.

use super::*;

fn blocked_reason(s: &Snapshot, change: &IamChange) -> String {
    let p = preview(s, change, None);
    let reason = only(&p, WarnLevel::Block).to_string();
    assert_eq!(p.confirm_text, None, "{change:?}");
    assert!(!p.reversible, "{change:?}");
    assert!(p.impacts.is_empty(), "{change:?}");
    reason
}

fn sso_by_name() -> crate::iam::model::RoleRec {
    role("AWSReservedSSO_Other_1", "/", trust(json!({ "Service": "sso.amazonaws.com" }), "sts:AssumeRole", None))
}

// ── 막힘 ────────────────────────────────────────────────────────────────

#[test]
fn a_plain_attach_needs_no_confirmation() {
    let s = snapshot();
    let change = attach(BOB, S3_FULL);
    let p = preview(&s, &change, None);
    assert_clean(&p);
    assert_eq!(p.change, change);
    assert_eq!(p.summary, "bob에 AmazonS3FullAccess 붙이기");
    assert_eq!(p.calls, calls(&s, &change));
    assert_eq!(impact_names(&p), vec!["bob"]);
    assert!(p.reversible);
}

#[test]
fn service_linked_roles_cannot_be_changed() {
    let s = snapshot();
    for change in [attach(SLR, S3_FULL), detach(SLR, S3_FULL), put_inline(SLR, "p", allow(&["s3:*"])), drop_inline(SLR, "p")] {
        let reason = blocked_reason(&s, &change);
        assert!(reason.contains("서비스 연결 역할"), "{reason}");
    }
}

#[test]
fn identity_center_roles_cannot_be_changed_by_path_or_by_name() {
    let mut s = snapshot();
    let by_name = sso_by_name();
    let by_name_arn = by_name.arn.clone();
    s.roles.push(by_name);
    for target in [SSO.to_string(), by_name_arn] {
        for change in [attach(&target, S3_FULL), put_inline(&target, "p", allow(&["s3:*"])), drop_inline(&target, "p")] {
            let reason = blocked_reason(&s, &change);
            assert!(reason.contains("Identity Center"), "{reason}");
        }
    }
}

#[test]
fn aws_managed_policies_cannot_be_edited() {
    let s = snapshot();
    for arn in [ADMIN_POLICY, S3_FULL, "arn:aws:iam::aws:policy/NotInTheSnapshot"] {
        let reason = blocked_reason(&s, &update_managed(arn, allow(&["s3:*"])));
        assert!(reason.contains("AWS 관리형 정책"), "{reason}");
    }
}

#[test]
fn a_managed_policy_missing_from_the_snapshot_cannot_be_edited() {
    let reason = blocked_reason(&snapshot(), &update_managed(&account_arn("policy/missing"), allow(&["s3:*"])));
    assert!(reason.contains("정책을 찾을 수 없어요"), "{reason}");
}

#[test]
fn invalid_policy_documents_are_blocked() {
    let s = snapshot();
    for document in ["{not json", "[]", "", "{\"Version\":\"2012-10-17\"}", "{\"Statement\":[{\"Effect\":\"Maybe\",\"Action\":\"*\",\"Resource\":\"*\"}]}"] {
        let reason = blocked_reason(&s, &put_inline(BOB, "p", document.to_string()));
        assert!(!reason.is_empty());
        let reason = blocked_reason(&s, &update_managed(UNUSED_POLICY, document.to_string()));
        assert!(!reason.is_empty());
    }
    assert!(blocked_reason(&s, &put_inline(BOB, "p", "{not json".into())).contains("JSON"));
}

#[test]
fn an_unparsable_document_that_is_also_too_big_gets_both_reasons() {
    let s = snapshot();
    let junk = format!("{{{}", "x".repeat(7_000));
    let p = preview(&s, &update_managed(UNUSED_POLICY, junk), None);
    assert_eq!(messages(&p, WarnLevel::Block).len(), 2, "{:?}", p.warnings);
}

#[test]
fn targets_the_snapshot_does_not_know_are_blocked() {
    let s = snapshot();
    let missing = account_arn("user/nobody");
    let p = preview(&s, &attach(&missing, S3_FULL), None);
    assert!(only(&p, WarnLevel::Block).contains(&missing));
    assert!(p.calls.is_empty());
    assert!(!p.reversible);
    assert!(blocked_reason(&s, &add_to_group("nobody", "admins")).contains("nobody"));
    assert!(blocked_reason(&s, &add_to_group("bob", "nogroup")).contains("nogroup"));
}

#[test]
fn changes_that_cannot_hold_in_the_current_state_are_blocked() {
    let s = snapshot();
    assert!(blocked_reason(&s, &detach(BOB, S3_FULL)).contains("붙어 있지 않은"));
    assert!(blocked_reason(&s, &detach(ALICE, ADMIN_POLICY)).contains("붙어 있지 않은"));
    assert!(blocked_reason(&s, &remove_from_group("bob", "admins")).contains("구성원이 아닌"));
    assert!(blocked_reason(&s, &drop_inline(BOB, "missing")).contains("missing"));
}

#[test]
fn a_key_status_must_be_active_or_inactive() {
    let s = snapshot();
    let reason = blocked_reason(&s, &set_status("bob", "AKIA1", "Disabled"));
    assert!(reason.contains("Active") && reason.contains("Inactive"), "{reason}");
    assert!(blocked_reason(&s, &set_status("bob", "AKIA1", "active")).contains("Active"));
    for status in ["Active", "Inactive"] {
        assert!(!has_level(&preview(&s, &set_status("bob", "AKIA1", status), None), WarnLevel::Block), "{status}");
    }
}

#[test]
fn inline_policy_names_follow_the_aws_rules() {
    let s = snapshot();
    for bad in ["", "has space", "slash/name", "한글", &"a".repeat(129)] {
        let reason = blocked_reason(&s, &put_inline(CAROL, bad, allow(&["s3:*"])));
        assert!(reason.contains("이름"), "{bad}: {reason}");
    }
    for good in ["a", "My_Policy-1.2@x+y=z,", &"a".repeat(128)] {
        assert!(!has_level(&preview(&s, &put_inline(CAROL, good, allow(&["s3:*"])), None), WarnLevel::Block), "{good}");
    }
}

// ── 확인 ────────────────────────────────────────────────────────────────

#[test]
fn losing_the_permissions_of_the_credentials_in_use_needs_the_targets_name() {
    // alice가 앱이 쓰는 주체이고 그룹 admins로 관리자 권한을 받는다
    let s = snapshot();
    let p = preview(&s, &detach(ADMINS, ADMIN_POLICY), None);
    let message = only(&p, WarnLevel::Confirm);
    assert!(message.contains("alice") && message.contains("권한이 줄어요"), "{message}");
    assert_eq!(p.confirm_text.as_deref(), Some("admins"));
    assert!(!has_level(&p, WarnLevel::Block));

    let p = preview(&s, &remove_from_group("alice", "admins"), None);
    assert!(only(&p, WarnLevel::Confirm).contains("alice"));
    assert_eq!(p.confirm_text.as_deref(), Some("alice"));
}

#[test]
fn losing_permissions_of_a_role_in_use_needs_confirmation_too() {
    let s = called_by(snapshot(), Some(DEPLOY));
    let p = preview(&s, &drop_inline(DEPLOY, "deploy-inline"), None);
    // 인라인 정책 삭제와 앱 자격 증명의 권한 축소, 둘 다 확인이 필요하지만 입력할 이름은 하나다
    assert_eq!(messages(&p, WarnLevel::Confirm).len(), 2, "{:?}", p.warnings);
    assert!(messages(&p, WarnLevel::Confirm).iter().any(|m| m.contains("deploy") && m.contains("권한이 줄어요")));
    assert_eq!(p.confirm_text.as_deref(), Some("deploy"));
}

#[test]
fn someone_elses_permission_loss_or_an_unknown_caller_needs_no_confirmation() {
    let s = snapshot();
    let p = preview(&s, &detach(CAROL, S3_FULL), None);
    assert!(!p.impacts.is_empty());
    assert_clean(&p);

    let anonymous = called_by(snapshot(), None);
    let p = preview(&anonymous, &detach(ADMINS, ADMIN_POLICY), None);
    assert_eq!(p.impacts.len(), 2);
    assert_clean(&p);
}

#[test]
fn gaining_permissions_never_trips_the_caller_rule() {
    let s = snapshot();
    let p = preview(&s, &attach(ALICE, S3_FULL), None);
    assert_clean(&p);
}

#[test]
fn the_warning_says_when_the_caller_could_no_longer_undo_the_change() {
    // P3: 확인 문구가 "이 자격 증명으로는 되돌릴 수 없어요"라고 하니 미리보기도 되돌릴 수 있다고 하지 않는다
    let s = snapshot();
    let p = preview(&s, &detach(ADMINS, ADMIN_POLICY), None);
    let message = only(&p, WarnLevel::Confirm);
    assert!(message.contains("되돌") && message.contains("iam:AttachGroupPolicy"), "{message}");
    assert!(!p.reversible);
    // 기록에는 역변경이 남는다: 권한이 있는 다른 자격 증명으로는 되돌릴 수 있다
    assert_eq!(inverse(&s, &detach(ADMINS, ADMIN_POLICY), None), Some(attach(ADMINS, ADMIN_POLICY)));
}

#[test]
fn the_warning_stays_quiet_about_undoing_when_the_caller_keeps_the_needed_rights() {
    let mut s = snapshot();
    s.users[0].inline.push(inline("iam-admin", policy(json!([{ "Effect": "Allow", "Action": "iam:*", "Resource": "*" }]))));
    let p = preview(&s, &detach(ADMINS, ADMIN_POLICY), None);
    let message = only(&p, WarnLevel::Confirm);
    assert!(!message.contains("되돌"), "{message}");
    assert_eq!(p.confirm_text.as_deref(), Some("admins"));
    assert!(p.reversible);
}

#[test]
fn making_someone_admin_needs_confirmation() {
    let s = snapshot();
    let p = preview(&s, &attach(BOB, ADMIN_POLICY), None);
    let message = only(&p, WarnLevel::Confirm);
    assert!(message.contains("관리자급") && message.contains("bob"), "{message}");
    assert_eq!(p.confirm_text.as_deref(), Some("bob"));
    assert!(!message.contains("권한 상승"), "관리자급이면 권한 상승은 따로 말하지 않아요");
}

#[test]
fn a_group_that_becomes_admin_takes_its_members_with_it() {
    let mut s = snapshot();
    s.groups.push(group_rec("ops", &[]));
    let mut dave = user("dave");
    dave.groups = vec!["ops".into()];
    s.users.push(dave);
    let p = preview(&s, &attach(&account_arn("group/ops"), ADMIN_POLICY), None);
    let message = only(&p, WarnLevel::Confirm);
    assert!(message.contains("ops 그룹") && message.contains("dave"), "{message}");
    assert_eq!(p.confirm_text.as_deref(), Some("ops"));
}

#[test]
fn only_a_full_administrator_counts_as_admin() {
    let s = snapshot();
    let p = preview(&s, &attach(BOB, S3_FULL), None);
    assert!(!has_level(&p, WarnLevel::Confirm), "S3 전체는 관리자급이 아니에요");
    // 권한 경계 안에 갇힌 carol은 관리자 정책을 받아도 관리자급이 되지 않는다
    assert_clean(&preview(&s, &attach(CAROL, ADMIN_POLICY), None));
}

#[test]
fn an_allow_that_leaves_out_every_resource_neither_makes_admin_nor_hides_a_loss() {
    // P5: `NotResource: "*"`는 어떤 리소스에도 열지 않는다
    let nothing = json!([{ "Effect": "Allow", "Action": "*", "NotResource": "*" }]);
    let s = snapshot();
    let p = preview(&s, &put_inline(BOB, "nothing", doc(nothing.clone())), None);
    assert_clean(&p);
    assert!(p.impacts.is_empty());

    // 그 문장이 모든 작업을 허용으로 남기면, 앱이 쓰는 alice가 관리자 정책을 잃어도 잃는 것이 없어 보였다
    let mut s = snapshot();
    s.users[0].inline.push(inline("nothing", policy(nothing)));
    let p = preview(&s, &detach(ADMINS, ADMIN_POLICY), None);
    assert!(only(&p, WarnLevel::Confirm).contains("권한이 줄어요"), "{:?}", p.warnings);
}

#[test]
fn becoming_admin_again_is_not_news() {
    let mut s = snapshot();
    let more = add_policy(&mut s, "more-admin", json!([{ "Effect": "Allow", "Action": "*", "Resource": "*" }]));
    // alice는 이미 관리자급이고 새로 얻는 권한도 없다
    let p = preview(&s, &attach(ALICE, &more), None);
    assert!(p.impacts.is_empty());
    assert_clean(&p);
}

#[test]
fn gaining_a_privilege_escalation_path_needs_confirmation() {
    let mut s = snapshot();
    let passer = add_policy(&mut s, "passer", json!([{ "Effect": "Allow", "Action": "iam:PassRole", "Resource": "*" }]));
    let p = preview(&s, &attach(BOB, &passer), None);
    let message = only(&p, WarnLevel::Confirm);
    assert!(message.contains("권한 상승") && message.contains("bob"), "{message}");
    assert_eq!(p.confirm_text.as_deref(), Some("bob"));

    // 이미 권한 상승 위험이 있는 deploy 역할은 새로 얻는 것이 아니다
    let p = preview(&s, &attach(DEPLOY, &passer), None);
    assert!(!has_level(&p, WarnLevel::Confirm), "{:?}", p.warnings);
}

#[test]
fn a_privilege_escalation_path_through_a_narrow_resource_is_not_flagged() {
    let mut s = snapshot();
    let narrow = add_policy(&mut s, "narrow", json!([{ "Effect": "Allow", "Action": "iam:PassRole", "Resource": "arn:aws:iam::111111111111:role/app-*" }]));
    assert_clean(&preview(&s, &attach(BOB, &narrow), None));
}

#[test]
fn deleting_an_access_key_needs_the_key_id_and_cannot_be_undone() {
    let s = snapshot();
    let p = preview(&s, &delete_key("bob", "AKIA1"), Some("Active"));
    let message = only(&p, WarnLevel::Confirm);
    assert!(message.contains("되돌릴 수 없"), "{message}");
    assert_eq!(p.confirm_text.as_deref(), Some("AKIA1"));
    assert!(!p.reversible);
    assert_eq!(p.summary, "bob의 액세스 키 AKIA1 삭제하기");
    assert_eq!(p.calls.iter().map(|c| c.api.as_str()).collect::<Vec<_>>(), vec!["iam:DeleteAccessKey"]);
    assert!(p.impacts.is_empty());
}

#[test]
fn changing_a_key_status_is_reversible_and_needs_no_confirmation() {
    let s = snapshot();
    let p = preview(&s, &set_status("bob", "AKIA1", "Inactive"), Some("Active"));
    assert_clean(&p);
    assert!(p.reversible);
    assert_eq!(p.summary, "bob의 액세스 키 AKIA1 비활성화하기");
    let p = preview(&s, &set_status("bob", "AKIA1", "Active"), Some("Inactive"));
    assert_eq!(p.summary, "bob의 액세스 키 AKIA1 활성화하기");
}

#[test]
fn deleting_an_inline_policy_needs_confirmation_but_can_be_undone() {
    let s = snapshot();
    let p = preview(&s, &drop_inline(BOB, "assets-read"), None);
    let message = only(&p, WarnLevel::Confirm);
    assert!(message.contains("assets-read") && message.contains("삭제"), "{message}");
    assert_eq!(p.confirm_text.as_deref(), Some("bob"));
    assert!(p.reversible);
    assert_eq!(p.summary, "bob의 인라인 정책 assets-read 삭제하기");
}

#[test]
fn editing_a_managed_policy_is_confirmed_by_the_policy_name() {
    let mut s = snapshot();
    // 앱이 쓰는 alice가 관리자 정책 대신 이 정책으로 권한을 받는다고 하자
    let shared = add_policy(&mut s, "shared", json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*" }]));
    s.users[0].attached.push(shared.clone());
    s.users[0].groups.clear();
    let p = preview(&s, &update_managed(&shared, allow(&["sqs:*"])), None);
    assert!(only(&p, WarnLevel::Confirm).contains("alice"));
    assert_eq!(p.confirm_text.as_deref(), Some("shared"));
    assert_eq!(p.summary, "관리형 정책 shared 수정하기");
}

#[test]
fn several_new_admins_are_listed_and_shortened_too() {
    let mut s = snapshot();
    let mut group = group_rec("ops", &[]);
    group.attached.clear();
    s.groups.push(group);
    for i in 0..6 {
        let mut u = user(&format!("m{i}"));
        u.groups = vec!["ops".into()];
        s.users.push(u);
    }
    let p = preview(&s, &attach(&account_arn("group/ops"), ADMIN_POLICY), None);
    let message = only(&p, WarnLevel::Confirm);
    assert!(message.contains("ops 그룹") && message.contains("m0") && message.contains("외 2개"), "{message}");
}

#[test]
fn the_caller_is_reached_through_a_group_when_a_shared_policy_is_edited() {
    let mut s = snapshot();
    let shared = add_policy(&mut s, "shared", json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*" }]));
    s.groups.push(group_rec("ops", &[&shared]));
    // alice는 admins를 떠나 ops로만 권한을 받는다
    s.users[0].groups = vec!["ops".into()];
    let p = preview(&s, &update_managed(&shared, allow(&["sqs:*"])), None);
    assert!(only(&p, WarnLevel::Confirm).contains("alice"));
    assert_eq!(p.confirm_text.as_deref(), Some("shared"));
}

#[test]
fn deleting_a_group_policy_the_caller_depends_on_needs_the_groups_name() {
    let mut s = snapshot();
    let mut ops = group_rec("ops", &[]);
    ops.inline.push(inline("s3-access", policy(json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*" }]))));
    s.groups.push(ops);
    s.users[0].groups = vec!["ops".into()];
    let p = preview(&s, &drop_inline(&account_arn("group/ops"), "s3-access"), None);
    let confirms = messages(&p, WarnLevel::Confirm);
    assert_eq!(confirms.len(), 2, "인라인 정책 삭제와 앱 자격 증명의 권한 축소: {:?}", p.warnings);
    assert!(confirms.iter().any(|m| m.contains("alice") && m.contains("권한이 줄어요")));
    assert_eq!(p.confirm_text.as_deref(), Some("ops"));
}

#[test]
fn removing_a_deny_can_make_someone_admin() {
    let mut s = snapshot();
    // bob은 관리자 정책을 받지만 모든 것을 막는 Deny 인라인 정책 때문에 아무것도 못 한다
    s.users[1].attached = vec![ADMIN_POLICY.into()];
    s.users[1].inline.push(inline("freeze", policy(json!([{ "Effect": "Deny", "Action": "*", "Resource": "*" }]))));
    let p = preview(&s, &drop_inline(BOB, "freeze"), None);
    assert!(only_new_admin(&p).contains("bob"), "{:?}", p.warnings);
}

fn only_new_admin(p: &ChangePreview) -> String {
    messages(p, WarnLevel::Confirm).into_iter().find(|m| m.contains("관리자급")).unwrap_or_default().to_string()
}

#[test]
fn an_unparsable_inline_document_that_is_also_too_big_gets_both_reasons() {
    let s = snapshot();
    let junk = format!("{{{}", "x".repeat(2_500));
    let p = preview(&s, &put_inline(CAROL, "p", junk), None);
    assert_eq!(messages(&p, WarnLevel::Block).len(), 2, "{:?}", p.warnings);
}
