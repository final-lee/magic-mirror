//! 문서를 읽지 못한 정책(리뷰 I1). 그런 정책은 권한 계산에서 빠지므로, 붙거나 떨어지면 계산한 증감이 비어 보여도
//! 앱의 자격 증명이 관리자 권한을 잃는 변경일 수 있다. 그래서 확인받고, 그대로 남는 것은 알려만 준다.

use super::*;

const CHANGED: &str = "문서를 읽지 못한 정책이 있어 권한 변화를 다 계산하지 못했어요";
const KEPT: &str = "문서를 읽지 못한 정책은 계산에서 뺐어요";

/// 스냅숏을 읽을 때 AdministratorAccess의 `GetPolicy`가 실패했다: 그 정책은 `policies`에 없다.
fn admin_unreadable() -> Snapshot {
    let mut s = snapshot();
    s.policies.remove(ADMIN_POLICY);
    s
}

#[test]
fn removing_the_caller_from_a_group_whose_admin_policy_is_unreadable_needs_the_callers_name() {
    // P7: alice(앱이 쓰는 주체)는 admins의 AdministratorAccess로 관리자인데 그 정책을 읽지 못했다
    let s = admin_unreadable();
    let p = preview(&s, &remove_from_group("alice", "admins"), None);
    assert_eq!(only(&p, WarnLevel::Confirm), format!("{CHANGED}: AdministratorAccess (admins 그룹)"));
    assert_eq!(p.confirm_text.as_deref(), Some("alice"));
    // 읽은 정책만으로는 alice의 권한이 그대로라 영향 목록은 비어 있다. 그래서 더더욱 확인이 필요하다
    assert!(p.impacts.is_empty());
    assert!(!has_level(&p, WarnLevel::Block));
}

#[test]
fn the_caller_detaching_an_unreadable_policy_from_itself_needs_confirmation() {
    // P2
    let mut s = snapshot();
    let mystery = account_arn("policy/mystery");
    s.users[0].attached.push(mystery.clone());
    let p = preview(&s, &detach(ALICE, &mystery), None);
    assert_eq!(only(&p, WarnLevel::Confirm), format!("{CHANGED}: mystery"));
    assert_eq!(p.confirm_text.as_deref(), Some("alice"));
}

#[test]
fn attaching_a_policy_that_could_not_be_read_needs_confirmation_even_if_it_may_be_admin() {
    // P1: 읽지 못한 정책이 관리자급인지 알 수 없으니 "관리자급을 새로 얻는 주체" 확인도 낼 수 없다. 대신 이 확인을 받는다
    let s = admin_unreadable();
    let p = preview(&s, &attach(BOB, ADMIN_POLICY), None);
    assert_eq!(only(&p, WarnLevel::Confirm), format!("{CHANGED}: AdministratorAccess"));
    assert_eq!(p.confirm_text.as_deref(), Some("bob"));
    assert!(p.reversible);
}

#[test]
fn a_group_of_the_user_that_is_missing_from_the_snapshot_counts_as_unreadable() {
    let mut s = snapshot();
    s.users[1].groups.push("ghosts".into());
    let p = preview(&s, &remove_from_group("bob", "ghosts"), None);
    assert_eq!(only(&p, WarnLevel::Confirm), format!("{CHANGED}: ghosts 그룹의 정책"));
    assert_eq!(p.confirm_text.as_deref(), Some("bob"));
    // 그대로 남는 변경에서는 알리기만 한다
    let p = preview(&s, &attach(BOB, S3_FULL), None);
    assert_eq!(only(&p, WarnLevel::Warn), format!("{KEPT}: ghosts 그룹의 정책"));
    assert!(!has_level(&p, WarnLevel::Confirm), "{:?}", p.warnings);
}

#[test]
fn a_boundary_whose_document_becomes_readable_needs_confirmation() {
    let mut s = snapshot();
    // carol의 권한 경계 문서를 읽지 못했다. 계산에서는 경계가 없는 것처럼 본다
    s.policies.get_mut(CAROL_BOUNDARY).unwrap().document = None;
    let p = preview(&s, &update_managed(CAROL_BOUNDARY, allow(&["s3:Get*"])), None);
    assert_eq!(only(&p, WarnLevel::Confirm), format!("{CHANGED}: carol-boundary (권한 경계)"));
    assert_eq!(p.confirm_text.as_deref(), Some("carol-boundary"));
}

#[test]
fn an_unreadable_inline_policy_that_stays_is_mentioned_without_asking() {
    let mut s = snapshot();
    s.users[1].inline[0].document = None;
    let p = preview(&s, &attach(BOB, S3_FULL), None);
    assert_eq!(only(&p, WarnLevel::Warn), format!("{KEPT}: assets-read"));
    assert!(!has_level(&p, WarnLevel::Confirm), "{:?}", p.warnings);
    assert_eq!(p.confirm_text, None);
    // 그 정책을 고쳐 쓰면 이전 문서가 주던 권한을 몰라서 확인받는다
    let p = preview(&s, &put_inline(BOB, "assets-read", allow(&["s3:GetObject"])), None);
    assert_eq!(only(&p, WarnLevel::Confirm), format!("{CHANGED}: assets-read"));
    assert!(!has_level(&p, WarnLevel::Warn), "{:?}", p.warnings);
}

#[test]
fn a_policy_that_reaches_new_principals_is_changed_even_where_someone_already_had_it() {
    let mut s = snapshot();
    let mystery = account_arn("policy/mystery");
    s.groups.push(group_rec("ops", &[]));
    for name in ["dave", "erin"] {
        let mut u = user(name);
        u.groups = vec!["ops".into()];
        s.users.push(u);
    }
    // erin은 이미 그 정책을 직접 받고 있다: erin에게는 그대로지만 ops와 dave에게는 새로 붙는다
    s.users.iter_mut().find(|u| u.name == "erin").unwrap().attached.push(mystery.clone());
    let p = preview(&s, &attach(&account_arn("group/ops"), &mystery), None);
    assert_eq!(only(&p, WarnLevel::Confirm), format!("{CHANGED}: mystery"));
    assert!(!has_level(&p, WarnLevel::Warn), "바뀐 정책을 '그대로'로도 알리지 않아요: {:?}", p.warnings);
    assert_eq!(p.confirm_text.as_deref(), Some("ops"));
}

#[test]
fn the_reason_the_policy_to_attach_could_not_be_read_is_shown() {
    let s = snapshot();
    let facts = Facts { policy_error: Some("권한 없음 (iam:GetPolicy)".into()), ..Facts::default() };
    let p = super::super::preview(&s, &attach(BOB, &account_arn("policy/brand-new")), &facts);
    assert_eq!(only(&p, WarnLevel::Warn), "brand-new 정책을 읽지 못했어요: 권한 없음 (iam:GetPolicy)");
    assert_eq!(only(&p, WarnLevel::Confirm), format!("{CHANGED}: brand-new"));
}

#[test]
fn many_unreadable_policies_are_shortened() {
    let mut s = snapshot();
    let mut ops = group_rec("ops", &[]);
    ops.attached = (0..7).map(|i| account_arn(&format!("policy/gone-{i}"))).collect();
    s.groups.push(ops);
    let p = preview(&s, &add_to_group("bob", "ops"), None);
    let message = only(&p, WarnLevel::Confirm);
    assert!(message.contains("gone-0 (ops 그룹)") && message.contains("gone-4 (ops 그룹)") && !message.contains("gone-5"), "{message}");
    assert!(message.contains("외 2개"), "{message}");
}
