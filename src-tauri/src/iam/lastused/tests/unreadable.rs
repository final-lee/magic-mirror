//! 읽지 못한 신원 정책이 하나라도 있으면 초안을 만들지 않는다. 그 정책에 Deny가 있었는지 알 수 없고, 권한 계산도 그 Deny를 놓친다
//! (AWSDenyAll을 못 읽으면 막혀 있는 작업이 허용으로 나온다).

use serde_json::json;

use super::*;
use crate::iam::model::{InlinePolicy, ManagedPolicyRec};

const DENY_ALL: &str = "arn:aws:iam::aws:policy/AWSDenyAll";

fn s3_world() -> World {
    world(&[("s3-all", json!([allow(json!("s3:*"), "*")]))], &[])
}

fn note(names: &str) -> String {
    format!("읽지 못한 정책이 있어서 초안을 만들지 않았어요: {names}")
}

fn unparsable(name: &str) -> InlinePolicy {
    InlinePolicy { name: name.into(), raw: "{not json".into(), document: None }
}

fn devs(inline: Vec<InlinePolicy>, attached: Vec<String>) -> GroupRec {
    GroupRec { arn: "arn:aws:iam::111111111111:group/devs".into(), name: "devs".into(), path: "/".into(), inline, attached, ..Default::default() }
}

#[test]
fn an_attached_managed_policy_missing_from_the_snapshot_means_no_draft() {
    let mut w = s3_world();
    // GetPolicy가 AccessDenied라 본문을 못 읽은 AWS 관리형 정책: 붙어 있다는 것만 안다
    w.s.users[0].attached.push(DENY_ALL.into());
    let (_, draft, notes) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(draft, None);
    assert_eq!(notes, vec![note("AWSDenyAll")]);
}

#[test]
fn a_group_inline_policy_that_could_not_be_parsed_means_no_draft() {
    let mut w = s3_world();
    w.s.groups.push(devs(vec![unparsable("broken")], vec![]));
    w.s.users[0].groups = vec!["devs".into()];
    let (_, draft, notes) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(draft, None);
    assert_eq!(notes, vec![note("broken")]);
}

#[test]
fn a_managed_policy_in_the_snapshot_without_a_document_counts_too() {
    let mut w = s3_world();
    let arn = local("half-read");
    w.s.policies.insert(arn.clone(), ManagedPolicyRec { arn: arn.clone(), name: "half-read".into(), raw: Some("{not json".into()), ..Default::default() });
    w.s.users[0].attached.push(arn);
    let (_, draft, notes) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(draft, None);
    assert_eq!(notes, vec![note("half-read")]);
}

#[test]
fn an_unreadable_direct_inline_policy_counts_too() {
    let mut w = s3_world();
    w.s.users[0].inline.push(unparsable("mine"));
    let (_, draft, notes) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(draft, None);
    assert_eq!(notes, vec![note("mine")]);
}

#[test]
fn up_to_five_names_are_listed_and_the_rest_counted() {
    let mut w = s3_world();
    w.s.users[0].attached = (1..=7).map(|i| format!("arn:aws:iam::aws:policy/p{i}")).collect();
    let (_, draft, notes) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(draft, None);
    assert_eq!(notes, vec![note("p1, p2, p3, p4, p5 외 2개")]);

    w.s.users[0].attached.truncate(5);
    let (_, _, notes) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(notes, vec![note("p1, p2, p3, p4, p5")]);
}

#[test]
fn a_policy_reached_twice_is_named_once() {
    let mut w = s3_world();
    // 사용자에게도 그룹에게도 붙어 있다
    w.s.users[0].attached.push(DENY_ALL.into());
    w.s.groups.push(devs(vec![], vec![DENY_ALL.into()]));
    w.s.users[0].groups = vec!["devs".into()];
    let (_, _, notes) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(notes, vec![note("AWSDenyAll")]);
}

#[test]
fn an_unreadable_permissions_boundary_does_not_block_the_draft() {
    // 경계는 신원 정책이 아니다. 초안은 신원 정책만 바꾸고 경계는 주체에 그대로 남는다
    let (mut s, arn) = fixtures::solo_user_with_boundary(json!([allow(json!("s3:*"), "*")]), json!([allow(json!("s3:Get*"), "*")]));
    s.policies.clear();
    let w = World { s, arn };
    let (_, draft, notes) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(statements(&draft), vec![json!({ "Effect": "Allow", "Action": ["s3:*"], "Resource": "*" })]);
    assert!(!has_note(&notes, "읽지 못한 정책"), "{notes:?}");
}

#[test]
fn unused_policy_suggestions_do_not_depend_on_the_unreadable_one() {
    let mut w = world(&[("s3-all", json!([allow(json!("s3:*"), "*")]))], &[("ec2-all", json!([allow(json!("ec2:*"), "*")]))]);
    w.s.users[0].attached.push(DENY_ALL.into());
    let (unused, draft, notes) = run(&w, &raw(vec![svc("s3", used()), svc("ec2", None)]));
    assert_eq!(unused.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), vec!["ec2-all"]);
    assert_eq!(draft, None);
    assert_eq!(notes, vec![note("AWSDenyAll")]);
}

#[test]
fn the_note_comes_after_the_young_principal_note() {
    let mut w = s3_world();
    w.s.users[0].attached.push(DENY_ALL.into());
    w.s.users[0].created_at = days_before(30).map(iso);
    let (_, draft, notes) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(draft, None);
    assert_eq!(notes.len(), 2, "{notes:?}");
    assert!(notes[0].starts_with("만든 지 30일밖에 안 된 주체"), "{notes:?}");
    assert_eq!(notes[1], note("AWSDenyAll"));
}

#[test]
fn readable_policies_still_get_a_draft() {
    // 같은 주체에 AWS 관리형 정책이 읽힌 채로 붙어 있으면 막히지 않는다
    let mut w = s3_world();
    w.s.policies.insert(DENY_ALL.into(), managed(DENY_ALL, Scope::Aws, 1, policy(json!([deny(json!("iam:*"), json!("*"))]))));
    w.s.users[0].attached.push(DENY_ALL.into());
    let (_, draft, notes) = run(&w, &raw(vec![svc("s3", used())]));
    assert!(draft.is_some(), "{notes:?}");
    assert!(!has_note(&notes, "읽지 못한 정책"), "{notes:?}");
}
