//! 버전이 2012-10-17이 아닌 정책(Version이 없거나 2008-10-17)에서는 `${aws:username}` 같은 글자가 변수가 아니라 글자 그대로다.
//! 초안은 늘 2012-10-17이라, 그런 Allow 문장을 옮기면 변수가 되어 지금보다 넓게 허용한다. 그래서 초안에서 뺀다.
//! Deny 문장은 원문 그대로 옮긴다(리소스의 변수는 더 많이 막을 뿐이다).

use serde_json::json;

use super::*;
use crate::iam::model::InlinePolicy;
use crate::iam::policy::parse_document;

const NOTE: &str = "버전이 2012-10-17이 아닌 정책의 변수(${…}) 리소스 문장은 초안에서 뺐어요";
const DENY_UNCOPIED: &str = "거부(Deny) 문장을 원문 그대로 옮기지 못해서 초안을 만들지 않았어요";
const HOME: &str = "arn:aws:s3:::home/${aws:username}/*";

/// `Version`이 있으면 넣은 정책 문서.
fn versioned(version: Option<&str>, statements: Value) -> Value {
    let mut doc = json!({ "Statement": statements });
    if let Some(version) = version {
        doc["Version"] = json!(version);
    }
    doc
}

/// 사용자 `u`에 이 문서를 인라인 정책 `name`으로 붙인 세계.
fn world_with(name: &str, doc: Value) -> World {
    let mut w = world(&[], &[]);
    w.s.users[0].inline.push(inline(name, doc));
    w
}

fn list_allow(action: &str, resource: &str) -> Value {
    json!({ "Effect": "Allow", "Action": [action], "Resource": resource })
}

fn s3_used() -> LastAccessedRaw {
    raw(vec![svc("s3", used())])
}

#[test]
fn a_variable_resource_in_an_old_policy_stays_out_of_the_draft() {
    for version in [Some("2008-10-17"), None] {
        let w = world_with("home", versioned(version, json!([allow(json!("s3:GetObject"), HOME), allow(json!("s3:ListBucket"), "arn:aws:s3:::home")])));
        let (_, draft, notes) = run(&w, &s3_used());
        assert_eq!(statements(&draft), vec![list_allow("s3:ListBucket", "arn:aws:s3:::home")], "{version:?}");
        assert!(has_note(&notes, &format!("{NOTE}: home")), "{version:?} {notes:?}");
    }
}

#[test]
fn the_same_statement_is_kept_when_the_policy_is_2012_10_17() {
    // 2012-10-17에서는 변수가 변수로 쓰이니 초안(2012-10-17)에서도 뜻이 같다
    let w = world_with("home", versioned(Some("2012-10-17"), json!([allow(json!("s3:GetObject"), HOME)])));
    let (_, draft, notes) = run(&w, &s3_used());
    assert_eq!(statements(&draft), vec![list_allow("s3:GetObject", HOME)]);
    assert!(!has_note(&notes, "변수(${…})"), "{notes:?}");
}

#[test]
fn a_variable_in_not_resource_counts_too() {
    let w = world_with(
        "all-but-mine",
        versioned(
            Some("2008-10-17"),
            json!([
                { "Effect": "Allow", "Action": "s3:GetObject", "NotResource": "arn:aws:s3:::secret/${aws:username}/*" },
                { "Effect": "Allow", "Action": "s3:PutObject", "NotResource": "arn:aws:s3:::secret/*" }
            ]),
        ),
    );
    let (_, draft, notes) = run(&w, &s3_used());
    assert_eq!(statements(&draft), vec![json!({ "Effect": "Allow", "Action": ["s3:PutObject"], "NotResource": "arn:aws:s3:::secret/*" })]);
    assert!(has_note(&notes, &format!("{NOTE}: all-but-mine")), "{notes:?}");
}

#[test]
fn the_whole_statement_goes_when_only_one_of_its_resources_has_a_variable() {
    let w = world_with(
        "mixed",
        versioned(Some("2008-10-17"), json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": ["arn:aws:s3:::plain/*", HOME] }])),
    );
    let (_, draft, notes) = run(&w, &s3_used());
    assert_eq!(draft, None);
    assert!(has_note(&notes, &format!("{NOTE}: mixed")), "{notes:?}");
}

#[test]
fn a_conditional_statement_with_a_variable_is_still_reported_as_conditional() {
    // 조건이 걸린 문장은 어차피 초안에 옮기지 않는다. 변수 때문에 뺐다고 하지 않고 늘 하던 대로 조건부 작업으로 안내한다
    let w = world_with(
        "p",
        versioned(
            None,
            json!([
                { "Effect": "Allow", "Action": "s3:GetObject", "Resource": HOME, "Condition": { "Bool": { "aws:SecureTransport": "true" } } },
                allow(json!("s3:ListBucket"), "arn:aws:s3:::home")
            ]),
        ),
    );
    let (_, draft, notes) = run(&w, &s3_used());
    assert_eq!(statements(&draft), vec![list_allow("s3:ListBucket", "arn:aws:s3:::home")]);
    assert!(has_note(&notes, "조건부로만 허용된 작업은 초안에서 뺐어요: s3:GetObject"), "{notes:?}");
    assert!(!has_note(&notes, "변수(${…})"), "{notes:?}");
}

#[test]
fn a_draft_with_nothing_left_still_tells_why() {
    let w = world_with("home", versioned(None, json!([allow(json!("s3:GetObject"), HOME)])));
    let (_, draft, notes) = run(&w, &s3_used());
    assert_eq!(draft, None);
    assert!(has_note(&notes, "초안을 만들지 않았어요"), "{notes:?}");
    assert!(has_note(&notes, &format!("{NOTE}: home")), "{notes:?}");
}

#[test]
fn old_managed_policies_are_checked_by_their_own_version() {
    let mut w = world(&[], &[]);
    let (old, current) = (local("old-home"), local("new-home"));
    w.s.policies.insert(old.clone(), managed(&old, Scope::Local, 1, versioned(Some("2008-10-17"), json!([allow(json!("s3:GetObject"), HOME)]))));
    w.s.policies.insert(current.clone(), managed(&current, Scope::Local, 1, versioned(Some("2012-10-17"), json!([allow(json!("s3:PutObject"), HOME)]))));
    w.s.users[0].attached = vec![old, current];
    let (_, draft, notes) = run(&w, &s3_used());
    assert_eq!(statements(&draft), vec![list_allow("s3:PutObject", HOME)]);
    assert!(has_note(&notes, &format!("{NOTE}: old-home")), "{notes:?}");
}

#[test]
fn the_version_is_read_from_a_url_encoded_document_too() {
    // IAM API는 문서를 퍼센트 인코딩해서 돌려준다
    let plain = versioned(Some("2008-10-17"), json!([allow(json!("s3:GetObject"), HOME)])).to_string();
    let encoded: String = plain.bytes().map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    let mut w = world(&[], &[]);
    w.s.users[0].inline.push(InlinePolicy { name: "encoded".into(), document: parse_document(&encoded).ok(), raw: encoded });
    assert!(w.s.users[0].inline[0].document.is_some());
    let (_, draft, notes) = run(&w, &s3_used());
    assert_eq!(draft, None);
    assert!(has_note(&notes, &format!("{NOTE}: encoded")), "{notes:?}");
}

#[test]
fn policy_names_are_listed_once_each_and_shortened() {
    let mut w = world(&[], &[]);
    for i in 1..=12 {
        w.s.users[0].inline.push(inline(&format!("old-{i:02}"), versioned(None, json!([allow(json!("s3:GetObject"), HOME), allow(json!("s3:PutObject"), HOME)]))));
    }
    w.s.users[0].inline.push(inline("plain", versioned(None, json!([allow(json!("s3:ListBucket"), "*")]))));
    let (_, _, notes) = run(&w, &s3_used());
    let line = notes.iter().find(|n| n.starts_with(NOTE)).unwrap_or_else(|| panic!("{notes:?}"));
    assert_eq!(line, &format!("{NOTE}: old-01, old-02, old-03, old-04, old-05, old-06, old-07, old-08, old-09, old-10 외 2개"));
}

#[test]
fn a_deny_with_a_variable_resource_is_not_copied_from_an_old_version() {
    // 지금은 글자 그대로 `home/${aws:username}/…`인 리소스를 막는다. 2012-10-17 초안에서는 변수가 되어 그 리소스가 열리고,
    // 값이 없는 키면 아무것도 막지 않는다: 원문 그대로 옮길 수 없다
    let old = world_with("p", versioned(Some("2008-10-17"), json!([allow(json!("s3:GetObject"), "*"), deny(json!("s3:GetObject"), json!(HOME))])));
    let (_, draft, notes) = run(&old, &s3_used());
    assert_eq!(draft, None);
    assert!(has_note(&notes, DENY_UNCOPIED), "{notes:?}");

    // 2012-10-17 원문이면 뜻이 그대로라 옮긴다
    let current = world_with("p", versioned(Some("2012-10-17"), json!([allow(json!("s3:GetObject"), "*"), deny(json!("s3:GetObject"), json!(HOME))])));
    let (_, draft, notes) = run(&current, &s3_used());
    assert_eq!(statements(&draft), vec![list_allow("s3:GetObject", "*"), json!({ "Effect": "Deny", "Action": "s3:GetObject", "Resource": HOME })]);
    assert!(has_note(&notes, "거부(Deny) 문장 1개를 초안에 그대로 옮겼어요"), "{notes:?}");
}

#[test]
fn a_deny_whose_meaning_would_flip_is_not_copied_into_a_2012_draft() {
    // NotResource나 Condition의 변수는 2012-10-17에서 값으로 바뀌면 이 Deny가 더 적게 막는다: 원문 그대로 옮길 수 없다
    let negated = json!({ "Effect": "Deny", "Action": "s3:GetObject", "NotResource": "arn:aws:s3:::home/${aws:username}/*" });
    let conditional = json!({
        "Effect": "Deny", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::secret/*",
        "Condition": { "StringNotLike": { "aws:userid": "${aws:username}*" } }
    });
    for deny_statement in [negated, conditional] {
        let old = world_with("p", versioned(None, json!([allow(json!("s3:GetObject"), "*"), deny_statement.clone()])));
        let (_, draft, notes) = run(&old, &s3_used());
        assert_eq!(draft, None, "{deny_statement}");
        assert!(has_note(&notes, DENY_UNCOPIED), "{notes:?}");

        // 2012-10-17 원문이면 뜻이 그대로라 옮긴다
        let current = world_with("p", versioned(Some("2012-10-17"), json!([allow(json!("s3:GetObject"), "*"), deny_statement.clone()])));
        let (_, draft, _) = run(&current, &s3_used());
        assert_eq!(statements(&draft).len(), 2, "{deny_statement}");
    }
}

#[test]
fn a_variable_free_policy_never_triggers_the_version_rule() {
    for version in [Some("2008-10-17"), None] {
        let w = world_with("plain", versioned(version, json!([allow(json!("s3:GetObject"), "arn:aws:s3:::plain/*")])));
        let (_, draft, notes) = run(&w, &s3_used());
        assert_eq!(statements(&draft), vec![list_allow("s3:GetObject", "arn:aws:s3:::plain/*")]);
        assert!(!has_note(&notes, "변수(${…})"), "{notes:?}");
    }
}
