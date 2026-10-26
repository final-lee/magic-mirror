//! 누가 할 수 있나 테스트.

use serde_json::json;

use crate::iam::eval::{who_can, Status};
use crate::iam::fixtures::*;
use crate::iam::model::{InlinePolicy, Snapshot};
use crate::iam::view::{BadgeKind, PrincipalKind, WhoCanResult};

fn summary_of(result: &WhoCanResult) -> Vec<(&str, Status)> {
    result.hits.iter().map(|hit| (hit.principal.name.as_str(), hit.status)).collect()
}

#[test]
fn everyone_who_can_read_an_object_in_the_bucket() {
    let s = snapshot();
    let result = who_can(&s, "s3:GetObject", Some("arn:aws:s3:::prod-assets/a"));
    assert_eq!(result.action, "s3:GetObject");
    assert_eq!(result.resource.as_deref(), Some("arn:aws:s3:::prod-assets/a"));
    assert_eq!(summary_of(&result), vec![("alice", Status::Allowed), ("bob", Status::Allowed), ("carol", Status::Allowed)]);
    assert!(result.hits.iter().all(|hit| hit.principal.kind == PrincipalKind::User));
    assert!(!result.notes.iter().any(|n| n.contains("카탈로그")), "{:?}", result.notes);
}

#[test]
fn without_a_resource_the_boundary_shows_up() {
    let s = snapshot();
    let result = who_can(&s, "s3:PutObject", None);
    assert_eq!(result.resource, None);
    assert_eq!(summary_of(&result), vec![("alice", Status::Allowed), ("carol", Status::Boundary)]);
    let carol = &result.hits[1];
    assert!(carol.sources.iter().all(|src| !src.boundary));
    assert_eq!(carol.principal.arn, CAROL);
}

#[test]
fn denied_hits_sort_after_allowed_ones() {
    let s = snapshot();
    let result = who_can(&s, "s3:GetObject", Some("arn:aws:s3:::prod-assets/secret/x"));
    assert_eq!(summary_of(&result), vec![("alice", Status::Allowed), ("carol", Status::Allowed), ("bob", Status::Denied)]);
    let bob = &result.hits[2];
    assert_eq!(bob.sources[0].sid.as_deref(), Some("DenySecret"));
}

#[test]
fn roles_are_included_and_conditional_hits_come_between() {
    let s = snapshot();
    let pass = who_can(&s, "iam:PassRole", None);
    assert_eq!(summary_of(&pass), vec![("alice", Status::Allowed), ("deploy", Status::Allowed)]);
    assert_eq!(pass.hits[1].principal.kind, PrincipalKind::Role);
    assert!(pass.hits[1].principal.badges.iter().any(|b| b.kind == BadgeKind::Privesc));

    let invoke = who_can(&s, "lambda:InvokeFunction", None);
    assert_eq!(summary_of(&invoke), vec![("alice", Status::Allowed), ("deploy", Status::Conditional)]);
    assert!(invoke.hits[1].sources[0].conditional);
}

#[test]
fn group_grants_count_for_members_and_are_noted() {
    let s = snapshot();
    let result = who_can(&s, "ec2:RunInstances", None);
    assert_eq!(summary_of(&result), vec![("alice", Status::Allowed)]);
    let source = &result.hits[0].sources[0];
    assert_eq!((source.policy_id.as_str(), source.via.as_deref()), (ADMIN_POLICY, Some("admins")));
    assert!(result.notes.iter().any(|n| n.contains("그룹")), "{:?}", result.notes);
    assert!(result.hits[0].principal.badges.iter().any(|b| b.kind == BadgeKind::Admin));
}

#[test]
fn actions_missing_from_the_catalog_are_noted() {
    let s = snapshot();
    let result = who_can(&s, "foo:Bar", None);
    assert_eq!(summary_of(&result), vec![("alice", Status::Allowed)]);
    assert!(result.notes.iter().any(|n| n.contains("카탈로그")), "{:?}", result.notes);
    assert!(who_can(&Snapshot::default(), "s3:GetObject", None).hits.is_empty());
}

#[test]
fn hits_with_the_same_status_sort_by_name_ignoring_case() {
    let mut s = Snapshot::default();
    for name in ["bob", "Alice", "carol"] {
        let mut u = user(name);
        u.inline.push(inline("p", policy(json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*" }]))));
        s.users.push(u);
    }
    let result = who_can(&s, "s3:GetObject", None);
    assert_eq!(result.hits.iter().map(|h| h.principal.name.as_str()).collect::<Vec<_>>(), vec!["Alice", "bob", "carol"]);
}

#[test]
fn policy_variable_resources_only_hit_when_the_rest_of_the_arn_can_match() {
    let mut s = Snapshot::default();
    let mut hana = user("hana");
    hana.inline.push(inline("home", policy(json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::home/${aws:username}/*" }]))));
    s.users.push(hana);
    // 변수를 무엇으로 바꿔도 `payroll/…`은 `home/…`이 될 수 없다
    let other = who_can(&s, "s3:GetObject", Some("arn:aws:s3:::payroll/x"));
    assert!(other.hits.is_empty(), "{:?}", summary_of(&other));
    // 앞부분이 맞으면 변수 값에 달려 있으니 조건부다
    let own = who_can(&s, "s3:GetObject", Some("arn:aws:s3:::home/hana/x"));
    assert_eq!(summary_of(&own), vec![("hana", Status::Conditional)]);
    assert!(own.hits[0].sources[0].conditional);
    // 대상을 안 정하면 자기 폴더를 읽을 수 있다는 뜻으로 허용이다
    assert_eq!(summary_of(&who_can(&s, "s3:GetObject", None)), vec![("hana", Status::Allowed)]);
}

fn broken(name: &str) -> crate::iam::model::UserRec {
    let mut u = user(name);
    u.inline.push(InlinePolicy { name: "broken".into(), raw: "{".into(), document: None });
    u
}

#[test]
fn principals_whose_policies_could_not_be_read_are_called_out() {
    let note_of = |result: &WhoCanResult| result.notes.iter().find(|n| n.contains("정책을 해석하지 못한")).cloned();

    let mut s = snapshot();
    assert_eq!(note_of(&who_can(&s, "s3:GetObject", None)), None);

    // 읽지 못한 정책만 있는 대상은 결과에서 빠지니 이름을 알려 준다
    s.users.push(broken("zed"));
    let one = who_can(&s, "s3:GetObject", None);
    assert_eq!(summary_of(&one).len(), 3);
    assert_eq!(note_of(&one).as_deref(), Some("정책을 해석하지 못한 대상 1개는 결과에서 빠졌어요: zed"));

    // 이름은 대소문자를 무시한 순서로 다섯 개까지, 나머지는 개수로 적는다
    for name in ["Mia", "ann", "bob2", "cy", "dee"] {
        s.users.push(broken(name));
    }
    let many = who_can(&s, "s3:GetObject", None);
    assert_eq!(note_of(&many).as_deref(), Some("정책을 해석하지 못한 대상 6개는 결과에서 빠졌어요: ann, bob2, cy, dee, Mia 외 1개"));

    // 읽지 못한 정책이 있어도 다른 정책으로 결과에 든 대상은 빠진 게 아니다
    s.users.iter_mut().find(|u| u.name == "alice").unwrap().inline.push(InlinePolicy { name: "broken".into(), raw: "{".into(), document: None });
    let again = who_can(&s, "s3:GetObject", None);
    assert!(summary_of(&again).iter().any(|(name, _)| *name == "alice"));
    assert!(!note_of(&again).unwrap().contains("alice"));

    // 붙어 있는데 정책 본문을 구하지 못한 관리형 정책이 있는 역할도 같다
    let mut s = snapshot();
    s.roles.iter_mut().find(|r| r.arn == CI).unwrap().attached.push("arn:aws:iam::aws:policy/Gone".into());
    let note = note_of(&who_can(&s, "s3:GetObject", None)).unwrap();
    assert!(note.contains("1개") && note.ends_with(": ci"), "{note}");
}

#[test]
fn who_can_json_has_the_contract_shape() {
    let s = snapshot();
    let value = serde_json::to_value(who_can(&s, "s3:PutObject", None)).unwrap();
    let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["action", "hits", "notes", "resource"]);
    assert!(value["resource"].is_null());
    let mut hit_keys: Vec<&str> = value["hits"][1].as_object().unwrap().keys().map(String::as_str).collect();
    hit_keys.sort_unstable();
    assert_eq!(hit_keys, vec!["principal", "sources", "status"]);
    assert_eq!(value["hits"][1]["status"], json!("boundary"));
    assert_eq!(value["hits"][1]["principal"]["name"], json!("carol"));
}
