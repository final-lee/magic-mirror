//! 문서를 읽지 못한 정책(리뷰 I1, 재검토 I-1·M-2). 그런 정책은 권한 계산에서 빠지므로, 붙거나 떨어지면 계산한 증감이 비어 보여도
//! 앱의 자격 증명이 관리자 권한을 잃는 변경일 수 있다. 그래서 확인받는다. 앱의 자격 증명에게 그대로 남는 정책도, 그 위에 Deny를 더하면
//! 그 정책이 주던 권한을 잃으니 확인받는다. 다른 주체에게 그대로 남는 것은 알려만 준다.

use super::*;

const CHANGED: &str = "문서를 읽지 못한 정책이 있어 권한 변화를 다 계산하지 못했어요";
const CALLER: &str = "문서를 읽지 못한 정책이 있어 이 앱 자격 증명의 권한 변화를 다 계산하지 못했어요";
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

/// 모든 작업을 모든 리소스에서 거부하는 고객 관리형 정책(어디에도 붙지 않았다).
fn deny_everything(s: &mut Snapshot) -> String {
    add_policy(s, "deny-all", json!([{ "Effect": "Deny", "Action": "*", "Resource": "*" }]))
}

fn lock_iam() -> IamChange {
    put_inline(ALICE, "lock", doc(json!([{ "Effect": "Deny", "Action": "iam:*", "Resource": "*" }])))
}

#[test]
fn a_deny_on_the_caller_whose_access_comes_from_an_unreadable_policy_needs_confirmation() {
    // P8a: alice(앱이 쓰는 주체)의 권한은 전부 읽지 못한 AdministratorAccess에서 온다. 그 위에 iam:* Deny를 더하면 이 앱은 IAM을 못 쓰는데,
    // 계산에 없는 권한이라 잃는 것으로 나오지 않는다
    let s = admin_unreadable();
    let p = preview(&s, &lock_iam(), None);
    assert_eq!(only(&p, WarnLevel::Confirm), format!("{CALLER}: AdministratorAccess (admins 그룹)"));
    assert_eq!(p.confirm_text.as_deref(), Some("alice"));
    assert!(!p.reversible, "되돌릴 권한(iam:DeleteUserPolicy)이 남는지 몰라요");
    assert!(p.impacts.is_empty());
    // 같은 정책을 '그대로'로도 알리지 않는다
    assert!(!has_level(&p, WarnLevel::Warn), "{:?}", p.warnings);
}

#[test]
fn denying_everything_to_the_callers_group_whose_admin_policy_is_unreadable_needs_confirmation() {
    // P8b: 정책을 읽었으면 "권한이 줄어요 … 되돌릴 수 없어요" 확인이 나오는 변경이다(`rules.rs`)
    let mut s = admin_unreadable();
    let deny = deny_everything(&mut s);
    let p = preview(&s, &attach(ADMINS, &deny), None);
    assert_eq!(only(&p, WarnLevel::Confirm), format!("{CALLER}: AdministratorAccess (admins 그룹)"));
    assert_eq!(p.confirm_text.as_deref(), Some("admins"));
    assert!(!p.reversible);
    assert!(p.impacts.is_empty());
    // admins 그룹에게도 그대로 남는 같은 정책이라 주의로 한 번 더 말하지 않는다
    assert!(!has_level(&p, WarnLevel::Warn), "{:?}", p.warnings);

    // 대조: 정책을 읽었으면 계산한 손실로 확인받는다
    let mut readable = snapshot();
    let deny = deny_everything(&mut readable);
    let p = preview(&readable, &attach(ADMINS, &deny), None);
    let message = only(&p, WarnLevel::Confirm);
    assert!(message.starts_with("지금 이 앱이 쓰는 자격 증명(alice)의 권한이 줄어요") && message.contains("iam:DetachGroupPolicy"), "{message}");
    assert!(!p.reversible);
}

#[test]
fn an_unreadable_policy_that_stays_with_someone_other_than_the_caller_is_only_mentioned() {
    // 대조: P8a·P8b와 같은 변경인데 앱이 쓰는 주체는 상관없는 carol이다. 읽지 못한 정책은 alice와 admins의 것이라 알리기만 한다
    let s = called_by(admin_unreadable(), Some(CAROL));
    let p = preview(&s, &lock_iam(), None);
    assert_eq!(only(&p, WarnLevel::Warn), format!("{KEPT}: AdministratorAccess (admins 그룹)"));
    assert!(!has_level(&p, WarnLevel::Confirm), "{:?}", p.warnings);
    assert_eq!(p.confirm_text, None);
    assert!(p.reversible);

    let mut s = s;
    let deny = deny_everything(&mut s);
    let p = preview(&s, &attach(ADMINS, &deny), None);
    assert_eq!(only(&p, WarnLevel::Warn), format!("{KEPT}: AdministratorAccess"));
    assert!(!has_level(&p, WarnLevel::Confirm), "{:?}", p.warnings);
    assert!(p.reversible);

    // 앱이 쓰는 alice도 영향받지만 읽지 못한 정책은 같은 그룹의 dave 것이다
    let mut s = snapshot();
    s.groups.push(group_rec("ops", &[]));
    s.users[0].groups.push("ops".into());
    let mut dave = user("dave");
    dave.groups = vec!["ops".into()];
    let mut secret = inline("dave-secret", policy(json!([{ "Effect": "Allow", "Action": "sqs:*", "Resource": "*" }])));
    secret.document = None;
    dave.inline.push(secret);
    s.users.push(dave);
    let p = preview(&s, &attach(&account_arn("group/ops"), S3_FULL), None);
    assert_eq!(only(&p, WarnLevel::Warn), format!("{KEPT}: dave-secret"));
    assert!(!has_level(&p, WarnLevel::Confirm), "{:?}", p.warnings);
    assert!(p.reversible);
}

#[test]
fn a_change_that_moves_an_unreadable_policy_onto_or_off_the_caller_is_not_called_reversible() {
    // P7r: 확인은 "다 계산하지 못했어요"라고 하는데 창 아래에 "되돌릴 수 있어요"가 보이면 안 된다. 읽지 못한 AdministratorAccess가
    // 다시 그룹에 넣는 권한(iam:AddUserToGroup)을 주고 있었다면 이 자격 증명으로는 되돌리지 못한다
    let p = preview(&admin_unreadable(), &remove_from_group("alice", "admins"), None);
    assert_eq!(only(&p, WarnLevel::Confirm), format!("{CHANGED}: AdministratorAccess (admins 그룹)"));
    assert!(!p.reversible);

    // P2와 반대 방향(읽지 못한 정책을 앱의 자격 증명에 붙임)도 같다: 그 정책에 Deny가 있으면 떼지 못한다
    let mut s = snapshot();
    let mystery = account_arn("policy/mystery");
    let p = preview(&s, &attach(ALICE, &mystery), None);
    assert_eq!(only(&p, WarnLevel::Confirm), format!("{CHANGED}: mystery"));
    assert!(!p.reversible);
    s.users[0].attached.push(mystery.clone());
    assert!(!preview(&s, &detach(ALICE, &mystery), None).reversible);

    // 다른 주체(bob)에게 붙이는 것은 앱의 자격 증명과 상관없어서 되돌릴 수 있다(P1)
    assert!(preview(&s, &attach(BOB, &mystery), None).reversible);
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
    assert!(p.reversible, "앱이 쓰는 alice는 영향받지 않아요");

    // 앱이 erin의 자격 증명을 쓰면 erin에게는 그대로 남는 정책이지만, 이미 바뀐 정책으로 확인받으니 같은 정책을 두 번 말하지 않는다
    let p = preview(&called_by(s, Some(&account_arn("user/erin"))), &attach(&account_arn("group/ops"), &mystery), None);
    assert_eq!(only(&p, WarnLevel::Confirm), format!("{CHANGED}: mystery"));
    assert!(!p.reversible);
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
