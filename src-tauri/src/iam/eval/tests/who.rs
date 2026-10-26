//! 누가 할 수 있나 테스트.

use serde_json::json;

use crate::iam::eval::{who_can, Status};
use crate::iam::fixtures::*;
use crate::iam::model::Snapshot;
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
