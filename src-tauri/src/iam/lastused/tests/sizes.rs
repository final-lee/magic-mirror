//! 초안이 AWS 한도보다 길면 알린다. AWS는 공백을 뺀 글자 수를 센다. 인라인 정책은 주체 하나에 붙은 것을 모두 합쳐
//! 사용자 2,048자·그룹 5,120자·역할 10,240자, 관리형 정책은 6,144자까지다. 초안은 그대로 주고 안내만 붙인다.

use serde_json::json;

use super::*;
use crate::iam::view::PrincipalKind;

/// 공백이 아닌 글자 수(구현과 따로 세는 값).
fn chars(text: &str) -> usize {
    text.chars().filter(|c| !c.is_whitespace()).count()
}

/// 1,000 이상 99,999 이하의 수에 쉼표를 찍는다.
fn grouped(n: usize) -> String {
    format!("{},{:03}", n / 1000, n % 1000)
}

fn inline_note(kind: &str, n: usize, limit: &str) -> String {
    format!("초안이 {}자라 {kind} 인라인 정책 한도({limit}자)를 넘어요. 관리형 정책으로 만들거나 작업을 줄여 주세요", grouped(n))
}

fn managed_note(n: usize) -> String {
    format!("초안이 {}자라 관리형 정책 한도(6,144자)도 넘어요", grouped(n))
}

/// 공백이 아닌 글자가 `size`개인 문서.
fn document_of(size: usize) -> String {
    "x".repeat(size)
}

// ---- 한도 ----

#[test]
fn a_user_draft_over_2048_characters_gets_the_inline_note() {
    assert!(size_notes(&document_of(2_048), PrincipalKind::User).is_empty());
    assert_eq!(size_notes(&document_of(2_049), PrincipalKind::User), vec![inline_note("사용자", 2_049, "2,048")]);
    assert_eq!(size_notes(&document_of(6_144), PrincipalKind::User), vec![inline_note("사용자", 6_144, "2,048")]);
}

#[test]
fn a_draft_over_the_managed_limit_too_adds_a_second_note() {
    assert_eq!(size_notes(&document_of(6_145), PrincipalKind::User), vec![inline_note("사용자", 6_145, "2,048"), managed_note(6_145)]);
}

#[test]
fn a_group_may_have_5120_characters() {
    assert!(size_notes(&document_of(5_120), PrincipalKind::Group).is_empty());
    assert_eq!(size_notes(&document_of(5_121), PrincipalKind::Group), vec![inline_note("그룹", 5_121, "5,120")]);
    assert_eq!(size_notes(&document_of(6_145), PrincipalKind::Group), vec![inline_note("그룹", 6_145, "5,120"), managed_note(6_145)]);
}

#[test]
fn a_role_may_have_10240_characters_even_above_the_managed_limit() {
    assert!(size_notes(&document_of(10_240), PrincipalKind::Role).is_empty());
    // 인라인으로는 들어가니 관리형 한도 이야기는 하지 않는다
    assert!(size_notes(&document_of(7_000), PrincipalKind::Role).is_empty());
    assert_eq!(size_notes(&document_of(10_241), PrincipalKind::Role), vec![inline_note("역할", 10_241, "10,240"), managed_note(10_241)]);
}

#[test]
fn whitespace_does_not_count_and_characters_are_not_bytes() {
    let spaced = format!("{}{}", document_of(2_048), " \n\t".repeat(500));
    assert!(spaced.len() > 3_000);
    assert!(size_notes(&spaced, PrincipalKind::User).is_empty());
    // 한글은 한 글자로 센다(바이트로 세면 6,144를 넘는다)
    assert!(size_notes(&"한".repeat(2_048), PrincipalKind::User).is_empty());
    assert_eq!(size_notes(&"한".repeat(2_049), PrincipalKind::User), vec![inline_note("사용자", 2_049, "2,048")]);
}

// ---- 만든 초안 ----

/// 서로 다른 ec2 작업 `count`개를 하나씩 적은 Allow 문장. 초안도 하나씩 적어서(와일드카드로 줄이지 못해서) 길어진다.
fn explicit_ec2(count: usize) -> Value {
    let names: Vec<String> = catalog().actions("ec2").iter().take(count).map(|(n, _)| format!("ec2:{n}")).collect();
    assert_eq!(names.len(), count);
    allow(json!(names), "*")
}

fn ec2_used() -> LastAccessedRaw {
    raw(vec![svc("ec2", used())])
}

fn size_of(draft: &Option<String>) -> usize {
    chars(draft.as_ref().expect("초안이 있어야 해요"))
}

fn role_world(statements: Value) -> World {
    let mut role = fixtures::role("r", "/", fixtures::trust(json!({ "Service": "ec2.amazonaws.com" }), "sts:AssumeRole", None));
    role.inline.push(inline("big", policy(statements)));
    let arn = role.arn.clone();
    World { s: Snapshot { account_id: fixtures::ACCOUNT.into(), roles: vec![role], ..Default::default() }, arn }
}

fn group_world(statements: Value) -> World {
    let group = GroupRec {
        arn: "arn:aws:iam::111111111111:group/g".into(),
        name: "g".into(),
        path: "/".into(),
        inline: vec![inline("big", policy(statements))],
        ..Default::default()
    };
    let arn = group.arn.clone();
    World { s: Snapshot { account_id: fixtures::ACCOUNT.into(), groups: vec![group], ..Default::default() }, arn }
}

#[test]
fn a_small_draft_has_no_size_note() {
    let w = world(&[("small", json!([explicit_ec2(5)]))], &[]);
    let (_, draft, notes) = run(&w, &ec2_used());
    assert!(size_of(&draft) < 2_048);
    assert!(!has_note(&notes, "한도"), "{notes:?}");
}

#[test]
fn a_user_draft_over_the_inline_limit_still_comes_with_the_note() {
    let w = world(&[("big", json!([explicit_ec2(120)]))], &[]);
    let (_, draft, notes) = run(&w, &ec2_used());
    let n = size_of(&draft);
    assert!(n > 2_048 && n <= 6_144, "{n}");
    assert!(has_note(&notes, &inline_note("사용자", n, "2,048")), "{notes:?}");
    assert!(!has_note(&notes, "관리형 정책 한도"), "{notes:?}");
}

#[test]
fn a_user_draft_over_the_managed_limit_gets_both_notes_in_order() {
    let w = world(&[("big", json!([explicit_ec2(300)]))], &[]);
    let (_, draft, notes) = run(&w, &ec2_used());
    let n = size_of(&draft);
    assert!(n > 6_144, "{n}");
    let at = |part: &str| notes.iter().position(|note| note.contains(part)).unwrap_or_else(|| panic!("{part}: {notes:?}"));
    assert_eq!(notes[at("사용자 인라인 정책 한도")], inline_note("사용자", n, "2,048"));
    assert_eq!(notes[at("관리형 정책 한도")], managed_note(n));
    assert!(at("사용자 인라인 정책 한도") < at("관리형 정책 한도"), "{notes:?}");
}

#[test]
fn a_role_draft_is_judged_by_the_role_limit() {
    // 사용자라면 둘 다 넘지만 역할의 인라인 한도(10,240자) 안이다
    let w = role_world(json!([explicit_ec2(300)]));
    let (_, draft, notes) = run(&w, &ec2_used());
    assert!(size_of(&draft) > 6_144 && size_of(&draft) <= 10_240, "{}", size_of(&draft));
    assert!(!has_note(&notes, "한도"), "{notes:?}");

    let w = role_world(json!([explicit_ec2(450)]));
    let (_, draft, notes) = run(&w, &ec2_used());
    let n = size_of(&draft);
    assert!(n > 10_240, "{n}");
    assert!(has_note(&notes, &inline_note("역할", n, "10,240")), "{notes:?}");
    assert!(has_note(&notes, &managed_note(n)), "{notes:?}");
}

#[test]
fn a_group_draft_is_judged_by_the_group_limit() {
    // 5,120자를 처음 넘는 길이까지 작업을 늘린다
    let (mut count, mut found) = (100, None);
    while found.is_none() && count <= 400 {
        count += 10;
        let w = group_world(json!([explicit_ec2(count)]));
        let (_, draft, notes) = run(&w, &ec2_used());
        if size_of(&draft) > 5_120 {
            found = Some((size_of(&draft), notes));
        } else {
            assert!(!has_note(&notes, "한도"), "{count}: {notes:?}");
        }
    }
    let (n, notes) = found.expect("작업 400개 안에 5,120자를 넘어야 해요");
    assert!(n <= 6_144, "{n}");
    assert!(has_note(&notes, &inline_note("그룹", n, "5,120")), "{notes:?}");
    assert!(!has_note(&notes, "관리형 정책 한도"), "{notes:?}");
}
