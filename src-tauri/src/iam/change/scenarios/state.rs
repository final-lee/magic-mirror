//! `apply_to_snapshot`: 변경을 적용한 뒤의 가상 스냅숏.

use super::*;
use crate::iam::eval::{evaluate_action, Status};

fn applied(s: &Snapshot, change: &IamChange) -> Snapshot {
    apply_to_snapshot(s, change).unwrap_or_else(|e| panic!("{change:?}: {e}"))
}

fn refused(s: &Snapshot, change: &IamChange) -> String {
    apply_to_snapshot(s, change).err().unwrap_or_else(|| panic!("{change:?}가 성공했어요"))
}

fn status(s: &Snapshot, arn: &str, action: &str) -> Option<Status> {
    evaluate_action(s, arn, action, None).map(|e| e.status)
}

#[test]
fn attaching_adds_the_policy_to_the_target_only() {
    let s = snapshot();
    let after = applied(&s, &attach(BOB, S3_FULL));
    assert_eq!(after.user("bob").unwrap().attached, vec![S3_FULL.to_string()]);
    // 원래 스냅숏은 그대로다
    assert!(s.user("bob").unwrap().attached.is_empty());
    assert_eq!(after.user("carol").unwrap().attached, s.user("carol").unwrap().attached);

    assert_eq!(applied(&s, &attach(DEPLOY, S3_FULL)).role("deploy").unwrap().attached, vec![S3_FULL.to_string()]);
    assert_eq!(applied(&s, &attach(ADMINS, S3_FULL)).group("admins").unwrap().attached, vec![ADMIN_POLICY.to_string(), S3_FULL.to_string()]);
}

#[test]
fn attaching_gives_the_target_the_permissions() {
    let s = snapshot();
    assert_eq!(status(&s, BOB, "s3:PutObject"), None);
    let after = applied(&s, &attach(BOB, S3_FULL));
    assert_eq!(status(&after, BOB, "s3:PutObject"), Some(Status::Allowed));
    assert_eq!(status(&s, BOB, "s3:PutObject"), None);
}

#[test]
fn attaching_something_already_attached_changes_nothing() {
    let s = snapshot();
    let after = applied(&s, &attach(CAROL, S3_FULL));
    assert_eq!(after.user("carol").unwrap().attached, vec![S3_FULL.to_string()]);
}

#[test]
fn detaching_removes_only_that_policy() {
    let mut s = snapshot();
    s.users[1].attached = vec![S3_FULL.to_string(), UNUSED_POLICY.to_string()];
    let after = applied(&s, &detach(BOB, S3_FULL));
    assert_eq!(after.user("bob").unwrap().attached, vec![UNUSED_POLICY.to_string()]);
    assert!(applied(&s, &detach(CAROL, S3_FULL)).user("carol").unwrap().attached.is_empty());
    assert!(applied(&s, &detach(ADMINS, ADMIN_POLICY)).group("admins").unwrap().attached.is_empty());
}

#[test]
fn detaching_the_group_policy_takes_it_from_its_members() {
    let s = snapshot();
    assert_eq!(status(&s, ALICE, "ec2:RunInstances"), Some(Status::Allowed));
    let after = applied(&s, &detach(ADMINS, ADMIN_POLICY));
    assert_eq!(status(&after, ALICE, "ec2:RunInstances"), None);
}

#[test]
fn a_policy_that_is_not_attached_directly_cannot_be_detached() {
    let s = snapshot();
    // alice는 그룹에서만 받는다
    assert!(refused(&s, &detach(ALICE, ADMIN_POLICY)).contains("붙어 있지 않은"));
    assert!(refused(&s, &detach(BOB, S3_FULL)).contains("붙어 있지 않은"));
}

#[test]
fn unknown_targets_are_refused_with_the_arn() {
    let s = snapshot();
    let missing = account_arn("user/nobody");
    for change in [attach(&missing, S3_FULL), detach(&missing, S3_FULL), put_inline(&missing, "p", allow(&["s3:*"])), drop_inline(&missing, "p")] {
        let reason = refused(&s, &change);
        assert!(reason.contains("알 수 없는") && reason.contains(&missing), "{reason}");
    }
}

#[test]
fn group_membership_changes_the_users_group_list() {
    let s = snapshot();
    let joined = applied(&s, &add_to_group("bob", "admins"));
    assert_eq!(joined.user("bob").unwrap().groups, vec!["admins".to_string()]);
    assert_eq!(status(&joined, BOB, "ec2:RunInstances"), Some(Status::Allowed));
    assert!(s.user("bob").unwrap().groups.is_empty());

    let left = applied(&s, &remove_from_group("alice", "admins"));
    assert!(left.user("alice").unwrap().groups.is_empty());
    assert_eq!(status(&left, ALICE, "ec2:RunInstances"), None);
}

#[test]
fn joining_a_group_twice_keeps_one_membership() {
    let s = snapshot();
    let after = applied(&s, &add_to_group("alice", "admins"));
    assert_eq!(after.user("alice").unwrap().groups, vec!["admins".to_string()]);
}

#[test]
fn membership_changes_need_a_real_user_and_group_and_a_real_membership() {
    let s = snapshot();
    assert!(refused(&s, &add_to_group("nobody", "admins")).contains("nobody"));
    assert!(refused(&s, &add_to_group("bob", "nogroup")).contains("nogroup"));
    assert!(refused(&s, &remove_from_group("nobody", "admins")).contains("nobody"));
    assert!(refused(&s, &remove_from_group("bob", "admins")).contains("구성원이 아닌"));
}

#[test]
fn access_key_changes_leave_the_permissions_alone() {
    let s = snapshot();
    for change in [set_status("bob", "AKIA1", "Inactive"), delete_key("bob", "AKIA1")] {
        let after = applied(&s, &change);
        assert_eq!(after.user("bob").unwrap().inline.len(), 1, "{change:?}");
        assert_eq!(after.users.len(), s.users.len());
    }
    assert!(refused(&s, &set_status("nobody", "AKIA1", "Inactive")).contains("nobody"));
    assert!(refused(&s, &delete_key("nobody", "AKIA1")).contains("nobody"));
}

#[test]
fn putting_an_inline_policy_adds_or_replaces_it() {
    let s = snapshot();
    let added = applied(&s, &put_inline(BOB, "extra", allow(&["sqs:SendMessage"])));
    let bob = added.user("bob").unwrap();
    assert_eq!(bob.inline.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), vec!["assets-read", "extra"]);
    assert_eq!(status(&added, BOB, "sqs:SendMessage"), Some(Status::Allowed));
    assert_eq!(s.user("bob").unwrap().inline.len(), 1);

    // 같은 이름이면 덮어쓴다
    let replaced = applied(&s, &put_inline(BOB, "assets-read", allow(&["sqs:SendMessage"])));
    let bob = replaced.user("bob").unwrap();
    assert_eq!(bob.inline.len(), 1);
    assert_eq!(bob.inline[0].raw, allow(&["sqs:SendMessage"]));
    assert!(bob.inline[0].document.is_some());
    assert_eq!(status(&replaced, BOB, "s3:GetObject"), None);
    assert_eq!(status(&replaced, BOB, "sqs:SendMessage"), Some(Status::Allowed));
}

#[test]
fn inline_policies_work_on_groups_and_roles_too() {
    let s = snapshot();
    let group = applied(&s, &put_inline(ADMINS, "extra", allow(&["sqs:*"])));
    assert_eq!(group.group("admins").unwrap().inline.len(), 1);
    let role = applied(&s, &put_inline(DEPLOY, "extra", allow(&["sqs:*"])));
    assert_eq!(role.role("deploy").unwrap().inline.len(), 2);
}

#[test]
fn a_bad_inline_document_cannot_be_applied() {
    let s = snapshot();
    assert!(refused(&s, &put_inline(BOB, "p", "{not json".into())).contains("JSON"));
    assert!(refused(&s, &put_inline(BOB, "p", "[]".into())).contains("JSON 객체"));
    assert!(refused(&s, &put_inline(BOB, "p", json!({ "Version": "2012-10-17" }).to_string())).contains("Statement"));
}

#[test]
fn deleting_an_inline_policy_removes_it() {
    let s = snapshot();
    let after = applied(&s, &drop_inline(BOB, "assets-read"));
    assert!(after.user("bob").unwrap().inline.is_empty());
    assert_eq!(status(&after, BOB, "s3:GetObject"), None);
    assert!(refused(&s, &drop_inline(BOB, "missing")).contains("missing"));
}

#[test]
fn editing_a_managed_policy_replaces_its_document_for_everyone_who_has_it() {
    let s = snapshot();
    assert_eq!(status(&s, CAROL, "s3:ListBucket"), Some(Status::Boundary), "S3 전체를 받지만 경계가 Get만 허용해요");
    let after = applied(&s, &update_managed(S3_FULL, allow(&["s3:GetObject"])));
    let rec = &after.policies[S3_FULL];
    assert_eq!(rec.raw.as_deref(), Some(allow(&["s3:GetObject"]).as_str()));
    assert!(rec.document.is_some());
    assert_eq!(status(&after, CAROL, "s3:GetObject"), Some(Status::Allowed));
    assert_eq!(status(&after, CAROL, "s3:GetBucketLocation"), None);
    // 원래 스냅숏은 그대로다
    assert_eq!(s.policies[S3_FULL].raw, snapshot().policies[S3_FULL].raw);
}

#[test]
fn editing_an_unknown_policy_or_with_a_bad_document_is_refused() {
    let s = snapshot();
    assert!(refused(&s, &update_managed(&account_arn("policy/missing"), allow(&["s3:*"]))).contains("정책을 찾을 수 없어요"));
    assert!(refused(&s, &update_managed(UNUSED_POLICY, "nope".into())).contains("JSON"));
}

#[test]
fn only_attaching_a_policy_the_snapshot_cannot_read_needs_fetching() {
    let mut s = snapshot();
    let absent = "arn:aws:iam::aws:policy/ReadOnlyAccess";
    assert_eq!(missing_policy(&s, &attach(BOB, absent)), Some(absent));
    assert_eq!(missing_policy(&s, &attach(BOB, S3_FULL)), None);
    // 기록은 있어도 문서를 못 읽었다면 다시 읽어 본다
    s.policies.get_mut(UNUSED_POLICY).unwrap().document = None;
    assert_eq!(missing_policy(&s, &attach(BOB, UNUSED_POLICY)), Some(UNUSED_POLICY));
    // 다른 변경은 정책 문서를 새로 읽을 일이 없다
    let others = [
        detach(BOB, absent),
        update_managed(absent, allow(&["s3:*"])),
        add_to_group("bob", "admins"),
        remove_from_group("alice", "admins"),
        set_status("bob", "AKIA1", "Active"),
        delete_key("bob", "AKIA1"),
        put_inline(BOB, "x", allow(&["s3:*"])),
        drop_inline(BOB, "x"),
    ];
    for change in others {
        assert_eq!(missing_policy(&s, &change), None, "{change:?}");
    }
}

#[test]
fn inline_policy_names_are_not_case_sensitive() {
    let s = snapshot();
    let replaced = applied(&s, &put_inline(BOB, "ASSETS-READ", allow(&["sqs:SendMessage"])));
    let bob = replaced.user("bob").unwrap();
    assert_eq!(bob.inline.len(), 1, "같은 이름으로 보고 덮어써요");
    assert_eq!(bob.inline[0].raw, allow(&["sqs:SendMessage"]));
    assert!(applied(&s, &drop_inline(BOB, "Assets-Read")).user("bob").unwrap().inline.is_empty());
}
