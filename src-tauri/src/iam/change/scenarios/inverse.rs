//! 역변경: 변경 전 스냅숏으로 구하고, 되돌릴 수 없는 변경은 None이다.

use super::*;
use crate::iam::policy::parse_document;

fn inv(s: &Snapshot, change: &IamChange) -> Option<IamChange> {
    inverse(s, change, None)
}

/// 두 정책 문서가 JSON으로 같은가(서식은 무시).
fn same_document(a: &str, b: &str) -> bool {
    serde_json::from_str::<Value>(a).unwrap() == serde_json::from_str::<Value>(b).unwrap()
}

#[test]
fn attaching_and_detaching_undo_each_other() {
    let s = snapshot();
    assert_eq!(inv(&s, &attach(BOB, S3_FULL)), Some(detach(BOB, S3_FULL)));
    assert_eq!(inv(&s, &detach(CAROL, S3_FULL)), Some(attach(CAROL, S3_FULL)));
    assert_eq!(inv(&s, &attach(ADMINS, S3_FULL)), Some(detach(ADMINS, S3_FULL)));
    assert_eq!(inv(&s, &detach(DEPLOY, S3_FULL)), None, "붙어 있지 않아 떼지 못하는 변경은 되돌릴 것도 없어요");
}

#[test]
fn attaching_what_is_already_attached_leaves_nothing_to_undo() {
    // 되돌리기로 떼면 원래 있던 연결까지 없앤다
    assert_eq!(inv(&snapshot(), &attach(CAROL, S3_FULL)), None);
}

#[test]
fn group_membership_changes_undo_each_other() {
    let s = snapshot();
    assert_eq!(inv(&s, &add_to_group("bob", "admins")), Some(remove_from_group("bob", "admins")));
    assert_eq!(inv(&s, &remove_from_group("alice", "admins")), Some(add_to_group("alice", "admins")));
    assert_eq!(inv(&s, &add_to_group("alice", "admins")), None, "이미 구성원이에요");
    assert_eq!(inv(&s, &remove_from_group("bob", "admins")), None, "구성원이 아니에요");
}

#[test]
fn a_key_status_goes_back_to_what_it_was() {
    let s = snapshot();
    let to_inactive = set_status("bob", "AKIA1", "Inactive");
    assert_eq!(inverse(&s, &to_inactive, Some("Active")), Some(set_status("bob", "AKIA1", "Active")));
    let to_active = set_status("bob", "AKIA1", "Active");
    assert_eq!(inverse(&s, &to_active, Some("Inactive")), Some(set_status("bob", "AKIA1", "Inactive")));
    // 지금 상태를 모르면 반대로 본다
    assert_eq!(inverse(&s, &to_inactive, None), Some(set_status("bob", "AKIA1", "Active")));
    assert_eq!(inverse(&s, &to_active, None), Some(set_status("bob", "AKIA1", "Inactive")));
    // 이미 그 상태면 바뀐 것이 없다
    assert_eq!(inverse(&s, &to_inactive, Some("Inactive")), None);
}

#[test]
fn a_deleted_key_cannot_come_back() {
    let s = snapshot();
    assert_eq!(inverse(&s, &delete_key("bob", "AKIA1"), Some("Active")), None);
    assert_eq!(inverse(&s, &delete_key("bob", "AKIA1"), None), None);
}

#[test]
fn putting_over_an_inline_policy_restores_the_old_document() {
    let s = snapshot();
    let old = s.user("bob").unwrap().inline[0].raw.clone();
    let Some(IamChange::PutInlinePolicy { target, name, document }) = inv(&s, &put_inline(BOB, "assets-read", allow(&["sqs:*"]))) else {
        panic!("이전 문서로 되돌리는 변경이어야 해요");
    };
    assert_eq!((target.as_str(), name.as_str()), (BOB, "assets-read"));
    assert!(same_document(&document, &old));
    assert!(parse_document(&document).is_ok());
}

#[test]
fn the_restored_document_is_readable_even_when_aws_returned_it_url_encoded() {
    let mut s = snapshot();
    let old = s.user("bob").unwrap().inline[0].raw.clone();
    s.users[1].inline[0].raw = url_encoded(&old);
    let Some(IamChange::PutInlinePolicy { document, .. }) = inv(&s, &put_inline(BOB, "assets-read", allow(&["sqs:*"]))) else {
        panic!("이전 문서로 되돌리는 변경이어야 해요");
    };
    assert!(same_document(&document, &old), "{document}");
}

#[test]
fn a_new_inline_policy_is_undone_by_deleting_it() {
    let s = snapshot();
    assert_eq!(inv(&s, &put_inline(BOB, "extra", allow(&["sqs:*"]))), Some(drop_inline(BOB, "extra")));
    assert_eq!(inv(&s, &put_inline(ADMINS, "extra", allow(&["sqs:*"]))), Some(drop_inline(ADMINS, "extra")));
}

#[test]
fn deleting_an_inline_policy_is_undone_by_putting_it_back() {
    let s = snapshot();
    let old = s.user("bob").unwrap().inline[0].raw.clone();
    let Some(IamChange::PutInlinePolicy { target, name, document }) = inv(&s, &drop_inline(BOB, "assets-read")) else {
        panic!("정책을 다시 만드는 변경이어야 해요");
    };
    assert_eq!((target.as_str(), name.as_str()), (BOB, "assets-read"));
    assert!(same_document(&document, &old));
    assert_eq!(inv(&s, &drop_inline(BOB, "missing")), None);
}

#[test]
fn an_inline_policy_whose_document_could_not_be_read_cannot_be_restored() {
    let mut s = snapshot();
    s.users[1].inline[0].document = None;
    s.users[1].inline[0].raw = "garbage".into();
    assert_eq!(inv(&s, &drop_inline(BOB, "assets-read")), None);
    assert_eq!(inv(&s, &put_inline(BOB, "assets-read", allow(&["sqs:*"]))), None);
}

#[test]
fn editing_a_managed_policy_is_undone_with_its_previous_default_document() {
    let s = snapshot();
    let old = s.policies[UNUSED_POLICY].raw.clone().unwrap();
    let Some(IamChange::UpdateManagedPolicy { policy_arn, document }) = inv(&s, &update_managed(UNUSED_POLICY, allow(&["sqs:*"]))) else {
        panic!("이전 문서로 다시 편집하는 변경이어야 해요");
    };
    assert_eq!(policy_arn, UNUSED_POLICY);
    assert!(same_document(&document, &old));
}

#[test]
fn a_managed_policy_without_a_readable_document_cannot_be_restored() {
    let mut s = snapshot();
    s.policies.get_mut(UNUSED_POLICY).unwrap().document = None;
    assert_eq!(inv(&s, &update_managed(UNUSED_POLICY, allow(&["sqs:*"]))), None);
    s.policies.get_mut(UNUSED_POLICY).unwrap().raw = None;
    assert_eq!(inv(&s, &update_managed(UNUSED_POLICY, allow(&["sqs:*"]))), None);
    assert_eq!(inv(&s, &update_managed(&account_arn("policy/missing"), allow(&["sqs:*"]))), None);
}

#[test]
fn unknown_targets_have_no_inverse() {
    let s = snapshot();
    let missing = account_arn("user/nobody");
    assert_eq!(inv(&s, &put_inline(&missing, "p", allow(&["s3:*"]))), None);
    assert_eq!(inv(&s, &drop_inline(&missing, "p")), None);
    assert_eq!(inv(&s, &attach(&missing, S3_FULL)), None);
    assert_eq!(inv(&s, &detach(&missing, S3_FULL)), None);
}

#[test]
fn the_inverse_of_the_inverse_is_the_original_where_state_allows() {
    let s = snapshot();
    let change = attach(BOB, S3_FULL);
    let undo = inv(&s, &change).unwrap();
    let after = apply_to_snapshot(&s, &change).unwrap();
    assert_eq!(inv(&after, &undo), Some(change));
}

#[test]
fn a_differently_cased_name_still_restores_the_policy_under_its_stored_name() {
    let s = snapshot();
    let Some(IamChange::PutInlinePolicy { name, .. }) = inv(&s, &put_inline(BOB, "ASSETS-READ", allow(&["sqs:*"]))) else {
        panic!("이전 문서로 되돌리는 변경이어야 해요");
    };
    assert_eq!(name, "assets-read");
    assert!(matches!(inv(&s, &drop_inline(BOB, "Assets-Read")), Some(IamChange::PutInlinePolicy { name, .. }) if name == "assets-read"));
}
