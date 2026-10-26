//! 한 줄 요약과 확인 문구.

use super::*;
use crate::iam::change::text::{confirm_name, describe, policy_name, principal_label};

#[test]
fn principals_are_labelled_by_kind_except_users() {
    let s = snapshot();
    assert_eq!(principal_label(&s, ALICE), "alice");
    assert_eq!(principal_label(&s, ADMINS), "admins 그룹");
    assert_eq!(principal_label(&s, DEPLOY), "deploy 역할");
    // 스냅숏에 없으면 ARN의 마지막 조각
    assert_eq!(principal_label(&s, &account_arn("user/dev/team/ghost")), "ghost");
    assert_eq!(principal_label(&s, ""), "");
}

#[test]
fn policies_are_named_by_the_snapshot_or_the_end_of_the_arn() {
    let s = snapshot();
    assert_eq!(policy_name(&s, ADMIN_POLICY), "AdministratorAccess");
    assert_eq!(policy_name(&s, "arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"), "ViewOnlyAccess");
}

#[test]
fn every_change_has_a_one_line_summary_without_particles_that_depend_on_the_last_letter() {
    let s = snapshot();
    let cases = [
        (detach(ALICE, ADMIN_POLICY), "alice에서 AdministratorAccess 떼기"),
        (detach(ADMINS, ADMIN_POLICY), "admins 그룹에서 AdministratorAccess 떼기"),
        (attach(DEPLOY, S3_FULL), "deploy 역할에 AmazonS3FullAccess 붙이기"),
        (add_to_group("bob", "admins"), "admins 그룹에 bob 추가하기"),
        (remove_from_group("alice", "admins"), "admins 그룹에서 alice 빼기"),
        (set_status("bob", "AKIA1", "Inactive"), "bob의 액세스 키 AKIA1 비활성화하기"),
        (set_status("bob", "AKIA1", "Active"), "bob의 액세스 키 AKIA1 활성화하기"),
        (set_status("bob", "AKIA1", "Weird"), "bob의 액세스 키 AKIA1 상태 바꾸기: Weird"),
        (delete_key("bob", "AKIA1"), "bob의 액세스 키 AKIA1 삭제하기"),
        (put_inline(BOB, "extra", allow(&["s3:*"])), "bob에 인라인 정책 extra 추가하기"),
        (put_inline(BOB, "assets-read", allow(&["s3:*"])), "bob의 인라인 정책 assets-read 수정하기"),
        (put_inline(BOB, "ASSETS-READ", allow(&["s3:*"])), "bob의 인라인 정책 ASSETS-READ 수정하기"),
        (drop_inline(DEPLOY, "deploy-inline"), "deploy 역할의 인라인 정책 deploy-inline 삭제하기"),
        (update_managed(UNUSED_POLICY, allow(&["s3:*"])), "관리형 정책 unused-policy 수정하기"),
    ];
    for (change, summary) in cases {
        assert_eq!(describe(&s, &change), summary, "{change:?}");
    }
}

#[test]
fn the_confirmation_name_is_the_short_name_of_what_the_change_targets() {
    let s = snapshot();
    let cases = [
        (attach(BOB, S3_FULL), "bob"),
        (detach(ADMINS, ADMIN_POLICY), "admins"),
        (put_inline(DEPLOY, "p", allow(&["s3:*"])), "deploy"),
        (drop_inline(BOB, "assets-read"), "bob"),
        (add_to_group("bob", "admins"), "bob"),
        (remove_from_group("alice", "admins"), "alice"),
        (set_status("bob", "AKIA1", "Inactive"), "AKIA1"),
        (delete_key("bob", "AKIA1"), "AKIA1"),
        (update_managed(UNUSED_POLICY, allow(&["s3:*"])), "unused-policy"),
    ];
    for (change, name) in cases {
        assert_eq!(confirm_name(&s, &change), name, "{change:?}");
    }
    // 경로가 있는 대상도 짧은 이름이다
    let mut dev = user("dev");
    dev.arn = account_arn("user/team/dev");
    let mut s = snapshot();
    let arn = dev.arn.clone();
    s.users.push(dev);
    assert_eq!(confirm_name(&s, &attach(&arn, S3_FULL)), "dev");
}
