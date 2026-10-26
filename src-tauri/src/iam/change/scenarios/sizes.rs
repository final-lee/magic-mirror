//! 정책 문서 크기 한도: 공백을 뺀 글자 수로 센다. 인라인 정책은 한 주체의 인라인 정책 전체의 합이 한도다.

use super::*;
use crate::iam::change::document::size;

/// 공백을 뺀 글자 수가 정확히 `n`인 올바른 정책 문서.
fn doc_of_size(n: usize) -> String {
    let make = |pad: usize| {
        json!({ "Version": "2012-10-17", "Statement": [{ "Sid": "a".repeat(pad), "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*" }] }).to_string()
    };
    let base = size(&make(0));
    assert!(n >= base, "문서가 최소 {base}자예요");
    let document = make(n - base);
    assert_eq!(size(&document), n);
    document
}

fn blocks(s: &Snapshot, change: &IamChange) -> Vec<String> {
    preview(s, change, None).warnings.into_iter().filter(|w| w.level == WarnLevel::Block).map(|w| w.message).collect()
}

#[test]
fn the_size_is_the_number_of_characters_without_whitespace() {
    assert_eq!(size(""), 0);
    assert_eq!(size("a b\n\tc  d"), 4);
    assert_eq!(size("한 글\r\n자"), 3, "바이트가 아니라 글자 수예요");
    let pretty = serde_json::to_string_pretty(&policy(json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*" }]))).unwrap();
    assert!(pretty.len() > size(&pretty));
    assert_eq!(size(&pretty), policy(json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*" }])).to_string().len());
}

#[test]
fn a_managed_policy_may_have_6144_characters() {
    let s = snapshot();
    assert!(blocks(&s, &update_managed(UNUSED_POLICY, doc_of_size(6_144))).is_empty());
    let over = blocks(&s, &update_managed(UNUSED_POLICY, doc_of_size(6_145)));
    assert_eq!(over.len(), 1);
    assert!(over[0].contains("6,144") && over[0].contains("6,145"), "{}", over[0]);
}

#[test]
fn whitespace_does_not_count_so_a_pretty_printed_document_still_fits() {
    let s = snapshot();
    let compact = doc_of_size(6_144);
    let pretty = serde_json::to_string_pretty(&serde_json::from_str::<Value>(&compact).unwrap()).unwrap();
    assert!(pretty.chars().count() > 6_144);
    assert!(blocks(&s, &update_managed(UNUSED_POLICY, pretty)).is_empty());
    assert!(blocks(&s, &update_managed(UNUSED_POLICY, format!("{compact}\n\n\n    "))).is_empty());
}

#[test]
fn a_user_may_have_2048_characters_of_inline_policies_in_total() {
    let s = snapshot();
    // carol은 인라인 정책이 없다
    assert!(blocks(&s, &put_inline(CAROL, "big", doc_of_size(2_048))).is_empty());
    let over = blocks(&s, &put_inline(CAROL, "big", doc_of_size(2_049)));
    assert_eq!(over.len(), 1);
    assert!(over[0].contains("2,048") && over[0].contains("사용자"), "{}", over[0]);
}

#[test]
fn other_inline_policies_of_the_same_user_use_up_the_limit() {
    let s = snapshot();
    let existing = size(&s.user("bob").unwrap().inline[0].raw);
    assert!(existing > 0 && existing < 2_048);
    assert!(blocks(&s, &put_inline(BOB, "second", doc_of_size(2_048 - existing))).is_empty());
    let over = blocks(&s, &put_inline(BOB, "second", doc_of_size(2_048 - existing + 1)));
    assert_eq!(over.len(), 1);
    assert!(over[0].contains(&existing.to_string()), "다른 정책이 차지한 글자 수를 알려 줘야 해요: {}", over[0]);
}

#[test]
fn replacing_a_policy_does_not_count_the_old_version_of_itself() {
    let s = snapshot();
    assert!(blocks(&s, &put_inline(BOB, "assets-read", doc_of_size(2_048))).is_empty());
    assert_eq!(blocks(&s, &put_inline(BOB, "assets-read", doc_of_size(2_049))).len(), 1);
}

#[test]
fn inline_policies_in_url_encoded_form_are_counted_by_their_decoded_size() {
    let mut s = snapshot();
    let existing = size(&s.user("bob").unwrap().inline[0].raw);
    s.users[1].inline[0].raw = url_encoded(&s.users[1].inline[0].raw.clone());
    assert!(blocks(&s, &put_inline(BOB, "second", doc_of_size(2_048 - existing))).is_empty());
    assert_eq!(blocks(&s, &put_inline(BOB, "second", doc_of_size(2_048 - existing + 1))).len(), 1);
}

#[test]
fn a_group_may_have_5120_characters_of_inline_policies() {
    let s = snapshot();
    assert!(blocks(&s, &put_inline(ADMINS, "big", doc_of_size(5_120))).is_empty());
    let over = blocks(&s, &put_inline(ADMINS, "big", doc_of_size(5_121)));
    assert_eq!(over.len(), 1);
    assert!(over[0].contains("5,120") && over[0].contains("그룹"), "{}", over[0]);
}

#[test]
fn a_role_may_have_10240_characters_of_inline_policies() {
    let s = snapshot();
    // ci 역할은 인라인 정책이 없다
    assert!(blocks(&s, &put_inline(CI, "big", doc_of_size(10_240))).is_empty());
    let over = blocks(&s, &put_inline(CI, "big", doc_of_size(10_241)));
    assert_eq!(over.len(), 1);
    assert!(over[0].contains("10,240") && over[0].contains("역할"), "{}", over[0]);
}

#[test]
fn deleting_or_attaching_has_no_document_to_measure() {
    let s = snapshot();
    assert!(blocks(&s, &drop_inline(BOB, "assets-read")).is_empty());
    assert!(blocks(&s, &attach(BOB, S3_FULL)).is_empty());
}

#[test]
fn replacing_a_policy_under_another_casing_does_not_count_the_old_version_either() {
    let s = snapshot();
    assert!(blocks(&s, &put_inline(BOB, "ASSETS-READ", doc_of_size(2_048))).is_empty());
}
