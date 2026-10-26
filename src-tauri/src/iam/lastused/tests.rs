use std::collections::BTreeSet;

use serde_json::{json, Value};

use super::*;
use crate::iam::catalog::catalog;
use crate::iam::clock::{iso, parse_iso};
use crate::iam::eval::evaluate;
use crate::iam::fixtures::{self, inline, managed, policy, user};
use crate::iam::model::{GroupRec, Scope};

fn used() -> Option<i64> {
    parse_iso("2026-10-20T12:00:00Z")
}

fn svc(prefix: &str, last_used: Option<i64>) -> RawService {
    RawService { prefix: prefix.into(), name: prefix.to_uppercase(), last_used, actions: None }
}

fn raw(services: Vec<RawService>) -> LastAccessedRaw {
    LastAccessedRaw { completed_at: used(), services }
}

fn action(name: &str, last_used: Option<i64>) -> RawAction {
    RawAction { name: name.into(), last_used }
}

fn local(name: &str) -> String {
    format!("arn:aws:iam::111111111111:policy/{name}")
}

struct World {
    s: Snapshot,
    arn: String,
}

/// 사용자 `u`에 인라인 정책과 직접 붙은 고객 관리형 정책을 건 스냅숏.
fn world(inlines: &[(&str, Value)], managed_policies: &[(&str, Value)]) -> World {
    let mut u = user("u");
    for (name, statements) in inlines {
        u.inline.push(inline(name, policy(statements.clone())));
    }
    let mut s = Snapshot { account_id: fixtures::ACCOUNT.into(), ..Default::default() };
    for (name, statements) in managed_policies {
        let arn = local(name);
        s.policies.insert(arn.clone(), managed(&arn, Scope::Local, 1, policy(statements.clone())));
        u.attached.push(arn);
    }
    let arn = u.arn.clone();
    s.users.push(u);
    World { s, arn }
}

fn allow(action: Value, resource: &str) -> Value {
    json!({ "Effect": "Allow", "Action": action, "Resource": resource })
}

fn run(w: &World, raw: &LastAccessedRaw) -> (Vec<UnusedPolicy>, Option<String>, Vec<String>) {
    let eval = evaluate(&w.s, &w.arn).expect("주체가 있어야 해요");
    least_privilege(&eval, raw, &w.s, &w.arn)
}

fn statements(draft: &Option<String>) -> Vec<Value> {
    let doc: Value = serde_json::from_str(draft.as_ref().expect("초안이 있어야 해요")).unwrap();
    assert_eq!(doc["Version"], json!("2012-10-17"));
    doc["Statement"].as_array().unwrap().clone()
}

fn action_list(statement: &Value) -> Vec<String> {
    statement["Action"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect()
}

fn has_note(notes: &[String], part: &str) -> bool {
    notes.iter().any(|n| n.contains(part))
}

// ---- 안 쓰는 정책 ----

#[test]
fn a_policy_for_a_service_nobody_used_is_unused_and_the_draft_keeps_only_what_was_used() {
    let w = world(&[("s3-all", json!([allow(json!("s3:*"), "*")]))], &[("ec2-all", json!([allow(json!("ec2:*"), "*")]))]);
    let (unused, draft, notes) = run(&w, &raw(vec![svc("s3", used()), svc("ec2", None)]));
    assert_eq!(unused.len(), 1);
    assert_eq!((unused[0].policy_id.as_str(), unused[0].name.as_str(), unused[0].via.clone()), (local("ec2-all").as_str(), "ec2-all", None));
    assert!(unused[0].reason.contains("EC2") && unused[0].reason.contains("400일"), "{}", unused[0].reason);
    assert_eq!(statements(&draft), vec![json!({ "Effect": "Allow", "Action": ["s3:*"], "Resource": "*" })]);
    assert!(has_note(&notes, "조건"), "{notes:?}");
}

#[test]
fn inline_policy_ids_and_names() {
    let w = world(&[("ec2-inline", json!([allow(json!("ec2:*"), "*")]))], &[]);
    let (unused, _, _) = run(&w, &raw(vec![svc("ec2", None)]));
    assert_eq!(unused.len(), 1);
    assert_eq!(unused[0].policy_id, format!("inline:{}:ec2-inline", w.arn));
    assert_eq!(unused[0].name, "ec2-inline");
    assert_eq!(unused[0].via, None);
}

#[test]
fn nothing_used_means_every_allowing_policy_is_unused_and_there_is_no_draft() {
    let w = world(&[("s3-all", json!([allow(json!("s3:*"), "*")]))], &[("ec2-all", json!([allow(json!("ec2:*"), "*")]))]);
    let (unused, draft, notes) = run(&w, &raw(vec![svc("s3", None), svc("ec2", None)]));
    let names: Vec<&str> = unused.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, vec!["s3-all", "ec2-all"]);
    assert_eq!(draft, None);
    assert!(has_note(&notes, "초안을 만들지 않았어요"), "{notes:?}");
}

#[test]
fn a_policy_that_also_covers_a_used_service_is_kept() {
    let w = world(&[("both", json!([allow(json!(["s3:*", "ec2:*"]), "*")]))], &[]);
    let (unused, draft, _) = run(&w, &raw(vec![svc("s3", used()), svc("ec2", None)]));
    assert!(unused.is_empty(), "{unused:?}");
    assert_eq!(statements(&draft), vec![json!({ "Effect": "Allow", "Action": ["s3:*"], "Resource": "*" })]);
}

#[test]
fn guards_unreported_services_and_unknown_actions_are_never_called_unused() {
    let w = world(
        &[],
        &[
            ("guard", json!([{ "Effect": "Deny", "Action": "iam:*", "Resource": "*" }])),
            ("unreported", json!([allow(json!("ec2:*"), "*")])),
            ("typo", json!([allow(json!("s3:GetObjct"), "*")])),
            ("mystery", json!([allow(json!("newsvc:Do*"), "*")])),
            // 카탈로그에 없는 서비스가 같이 있으면 그쪽을 썼는지 알 수 없다
            ("mixed", json!([allow(json!(["s3:*", "newsvc:*"]), "*")])),
            ("s3-only", json!([allow(json!("s3:*"), "*")])),
        ],
    );
    // iam·s3는 안 쓴 걸로 나오고, ec2는 AWS가 알려 주지 않았다
    let (unused, _, _) = run(&w, &raw(vec![svc("s3", None), svc("iam", None)]));
    let names: Vec<&str> = unused.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, vec!["s3-only"]);
}

#[test]
fn group_policies_name_the_group_they_come_from() {
    let mut w = world(&[("s3-all", json!([allow(json!("s3:*"), "*")]))], &[]);
    let group_arn = "arn:aws:iam::111111111111:group/devs";
    w.s.policies.insert(local("sqs-all"), managed(&local("sqs-all"), Scope::Local, 1, policy(json!([allow(json!("sqs:*"), "*")]))));
    w.s.groups.push(GroupRec {
        arn: group_arn.into(),
        name: "devs".into(),
        path: "/".into(),
        inline: vec![inline("sns-inline", policy(json!([allow(json!("sns:*"), "*")])))],
        attached: vec![local("sqs-all")],
        ..Default::default()
    });
    w.s.users[0].groups = vec!["devs".into()];
    let (unused, draft, _) = run(&w, &raw(vec![svc("s3", used()), svc("sqs", None), svc("sns", None)]));
    let found: Vec<(String, String, Option<String>)> = unused.iter().map(|p| (p.policy_id.clone(), p.name.clone(), p.via.clone())).collect();
    assert_eq!(
        found,
        vec![
            (format!("inline:{group_arn}:sns-inline"), "sns-inline".to_string(), Some("devs".to_string())),
            (local("sqs-all"), "sqs-all".to_string(), Some("devs".to_string())),
        ]
    );
    assert_eq!(statements(&draft).len(), 1);
}

#[test]
fn the_reason_lists_a_few_services_and_shortens_the_rest() {
    let w = world(&[], &[("many", json!([allow(json!(["s3:*", "ec2:*", "sqs:*", "sns:*", "lambda:*"]), "*")]))]);
    let services = ["s3", "ec2", "sqs", "sns", "lambda"].map(|p| svc(p, None)).to_vec();
    let (unused, _, _) = run(&w, &raw(services));
    assert_eq!(unused.len(), 1);
    assert!(unused[0].reason.contains(" 외 2개"), "{}", unused[0].reason);
    assert!(unused[0].reason.contains("400일"));
}

#[test]
fn an_empty_report_proves_nothing() {
    let w = world(&[("s3-all", json!([allow(json!("s3:*"), "*")]))], &[]);
    let (unused, draft, notes) = run(&w, &raw(vec![]));
    assert!(unused.is_empty());
    assert_eq!(draft, None);
    assert!(!notes.is_empty());
}

// ---- 초안 ----

#[test]
fn action_level_records_keep_only_the_used_actions_the_principal_is_allowed() {
    let w = world(&[("s3-read", json!([allow(json!("s3:Get*"), "*")]))], &[]);
    let mut s3 = svc("s3", used());
    s3.actions = Some(vec![
        action("GetObject", used()),
        // AWS가 소문자로 돌려줘도 카탈로그의 이름으로 적는다
        action("getbucketlocation", used()),
        action("GetBucketAcl", None),
        // 허용받지 않은 작업은 쓴 기록이 있어도 초안에 넣지 않는다
        action("PutObject", used()),
    ]);
    let (_, draft, notes) = run(&w, &raw(vec![s3]));
    let list = statements(&draft);
    assert_eq!(list.len(), 1);
    assert_eq!(action_list(&list[0]), vec!["s3:GetBucketLocation", "s3:GetObject"]);
    // 관리 작업만 기록되니 빠진 데이터 작업이 있는지 확인하라고 알린다
    assert!(has_note(&notes, "데이터 작업"), "{notes:?}");
}

#[test]
fn tracked_actions_without_any_use_do_not_narrow_the_draft() {
    let w = world(&[("s3-all", json!([allow(json!("s3:*"), "*")]))], &[]);
    let mut s3 = svc("s3", used());
    s3.actions = Some(vec![action("GetBucketAcl", None)]);
    let (_, draft, notes) = run(&w, &raw(vec![s3]));
    assert_eq!(statements(&draft), vec![json!({ "Effect": "Allow", "Action": ["s3:*"], "Resource": "*" })]);
    assert!(!has_note(&notes, "데이터 작업"), "{notes:?}");
    assert!(has_note(&notes, "작업 단위 기록이 없는 서비스"), "{notes:?}");
}

#[test]
fn the_draft_never_grants_more_than_the_principal_has() {
    let w = world(
        &[(
            "narrow",
            json!([allow(json!("s3:GetObject"), "arn:aws:s3:::b/*"), allow(json!("s3:ListBucket"), "arn:aws:s3:::b")]),
        )],
        &[],
    );
    let (_, draft, _) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(
        statements(&draft),
        vec![
            json!({ "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::b" }),
            json!({ "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": "arn:aws:s3:::b/*" }),
        ]
    );
}

#[test]
fn complete_verb_groups_are_written_as_wildcards() {
    let w = world(&[("read", json!([allow(json!(["s3:Get*", "s3:List*", "s3:PutObject"]), "*")]))], &[]);
    let (_, draft, _) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(action_list(&statements(&draft)[0]), vec!["s3:Get*", "s3:List*", "s3:PutObject"]);
}

#[test]
fn resources_are_kept_as_written_including_not_resource() {
    let w = world(
        &[(
            "res",
            json!([
                allow(json!("s3:GetObject"), "arn:aws:s3:::a/*"),
                { "Effect": "Allow", "Action": "s3:PutObject", "NotResource": "arn:aws:s3:::secret/*" },
                { "Effect": "Allow", "Action": "s3:DeleteObject", "Resource": ["arn:aws:s3:::z/*", "arn:aws:s3:::y/*"] }
            ]),
        )],
        &[],
    );
    let (_, draft, _) = run(&w, &raw(vec![svc("s3", used())]));
    let list = statements(&draft);
    assert_eq!(list.len(), 3);
    assert!(list.contains(&json!({ "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": "arn:aws:s3:::a/*" })));
    assert!(list.contains(&json!({ "Effect": "Allow", "Action": ["s3:PutObject"], "NotResource": "arn:aws:s3:::secret/*" })));
    // 리소스가 여럿이면 배열이고 정렬돼 있다
    assert!(list.contains(&json!({ "Effect": "Allow", "Action": ["s3:DeleteObject"], "Resource": ["arn:aws:s3:::y/*", "arn:aws:s3:::z/*"] })));
}

#[test]
fn conditions_are_dropped_from_the_draft() {
    let w = world(
        &[(
            "cond",
            json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*", "Condition": { "IpAddress": { "aws:SourceIp": "10.0.0.0/8" } } }]),
        )],
        &[],
    );
    let (_, draft, notes) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(statements(&draft), vec![json!({ "Effect": "Allow", "Action": ["s3:*"], "Resource": "*" })]);
    assert!(has_note(&notes, "조건(Condition)은 초안에 넣지 않았어요"), "{notes:?}");
}

#[test]
fn denied_and_boundary_blocked_actions_are_left_out() {
    let w = world(
        &[("deny", json!([allow(json!("s3:*"), "*"), { "Effect": "Deny", "Action": "s3:DeleteObject", "Resource": "*" }]))],
        &[],
    );
    let (_, draft, _) = run(&w, &raw(vec![svc("s3", used())]));
    let actions = action_list(&statements(&draft)[0]);
    assert!(!actions.contains(&"s3:*".to_string()) && !actions.contains(&"s3:DeleteObject".to_string()), "{actions:?}");
    assert!(actions.contains(&"s3:Get*".to_string()) && actions.contains(&"s3:DeleteBucket".to_string()), "{actions:?}");

    let (s, arn) = fixtures::solo_user_with_boundary(json!([allow(json!("s3:*"), "*")]), json!([allow(json!("s3:Get*"), "*")]));
    let bounded = World { s, arn };
    let (_, draft, _) = run(&bounded, &raw(vec![svc("s3", used())]));
    assert_eq!(statements(&draft), vec![json!({ "Effect": "Allow", "Action": ["s3:Get*"], "Resource": "*" })]);
}

#[test]
fn an_admin_user_who_only_used_s3_gets_an_s3_only_draft() {
    let s = fixtures::snapshot();
    let eval = evaluate(&s, fixtures::ALICE).unwrap();
    let report = raw(vec![svc("s3", used()), svc("ec2", None), svc("iam", None)]);
    let (unused, draft, _) = least_privilege(&eval, &report, &s, fixtures::ALICE);
    // AdministratorAccess는 AWS가 알려 주지 않은 서비스까지 허용하니 통째로 안 쓴다고 말하지 않는다
    assert!(unused.is_empty(), "{unused:?}");
    assert_eq!(statements(&draft), vec![json!({ "Effect": "Allow", "Action": ["s3:*"], "Resource": "*" })]);
}

#[test]
fn notes_depend_on_what_ended_up_in_the_draft() {
    let w = world(&[("s3-all", json!([allow(json!("s3:*"), "*")]))], &[]);
    let (_, draft, notes) = run(&w, &raw(vec![svc("s3", used())]));
    assert!(draft.is_some());
    assert!(has_note(&notes, "조건"));
    assert!(has_note(&notes, "작업 단위 기록이 없는 서비스"));
    assert!(!has_note(&notes, "데이터 작업"));
}

// ---- 화면 값 ----

#[test]
fn last_accessed_maps_services_and_serializes_the_contract_shape() {
    let w = world(&[("s3-all", json!([allow(json!("s3:*"), "*")]))], &[("ec2-all", json!([allow(json!("ec2:*"), "*")]))]);
    let eval = evaluate(&w.s, &w.arn).unwrap();
    let mut s3 = svc("s3", used());
    s3.name = "Amazon S3".into();
    s3.actions = Some(vec![action("GetObject", used()), action("PutObject", None)]);
    let report = raw(vec![s3, svc("ec2", None)]);
    let la = last_accessed(&eval, &report, &w.s, &w.arn);

    assert_eq!(la.tracking_days, 400);
    assert_eq!(la.completed_at, used().map(iso));
    let prefixes: Vec<&str> = la.services.iter().map(|s| s.prefix.as_str()).collect();
    assert_eq!(prefixes, vec!["ec2", "s3"]);
    assert_eq!((la.services[0].last_used.clone(), la.services[0].actions.clone()), (None, None));
    assert_eq!(la.services[1].name, "Amazon S3");
    assert_eq!(la.services[1].last_used, used().map(iso));
    assert_eq!(
        la.services[1].actions,
        Some(vec![
            LastAction { action: "s3:GetObject".into(), last_used: used().map(iso) },
            LastAction { action: "s3:PutObject".into(), last_used: None },
        ])
    );
    assert_eq!(la.unused_policies.len(), 1);
    assert!(la.draft.is_some() && !la.draft_notes.is_empty());

    let value = serde_json::to_value(&la).unwrap();
    let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["completedAt", "draft", "draftNotes", "services", "trackingDays", "unusedPolicies"]);
    let mut service_keys: Vec<&str> = value["services"][1].as_object().unwrap().keys().map(String::as_str).collect();
    service_keys.sort_unstable();
    assert_eq!(service_keys, vec!["actions", "lastUsed", "name", "prefix"]);
    assert_eq!(value["services"][1]["actions"][0], json!({ "action": "s3:GetObject", "lastUsed": iso(used().unwrap()) }));
    let mut policy_keys: Vec<&str> = value["unusedPolicies"][0].as_object().unwrap().keys().map(String::as_str).collect();
    policy_keys.sort_unstable();
    assert_eq!(policy_keys, vec!["name", "policyId", "reason", "via"]);
    assert_eq!(value["trackingDays"], json!(400));
}

// ---- 작업 묶기 ----

fn set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|n| n.to_string()).collect()
}

fn names_with(prefix: &str, start: &str) -> Vec<String> {
    catalog().actions(prefix).iter().map(|(n, _)| n.clone()).filter(|n| n.starts_with(start)).collect()
}

#[test]
fn compress_writes_the_whole_service_as_prefix_star() {
    let all: BTreeSet<String> = catalog().actions("sqs").iter().map(|(n, _)| n.clone()).collect();
    assert_eq!(compress("sqs", &all), vec!["sqs:*"]);
}

#[test]
fn compress_uses_a_wildcard_only_for_a_complete_group() {
    let gets: BTreeSet<String> = names_with("s3", "Get").into_iter().collect();
    assert!(gets.len() > 5);
    assert_eq!(compress("s3", &gets), vec!["s3:Get*"]);

    let mut almost = gets.clone();
    almost.remove("GetObject");
    let out = compress("s3", &almost);
    assert!(!out.contains(&"s3:Get*".to_string()) && !out.contains(&"s3:GetObject".to_string()), "{out:?}");
    assert_eq!(out.len(), almost.len());

    // 하나만 고른 건 이름 그대로
    assert_eq!(compress("s3", &set(&["GetObject"])), vec!["s3:GetObject"]);
    assert_eq!(compress("s3", &set(&["PutObject", "GetObject"])), vec!["s3:GetObject", "s3:PutObject"]);
    assert!(compress("s3", &BTreeSet::new()).is_empty());
}

#[test]
fn verbs_are_the_leading_word() {
    assert_eq!(verb("GetObject"), "Get");
    assert_eq!(verb("ListAllMyBuckets"), "List");
    assert_eq!(verb("DescribeVpcEndpoints"), "Describe");
    assert_eq!(verb("Query"), "Query");
    assert_eq!(verb("Get"), "Get");
    assert_eq!(verb("PutObjectV2"), "Put");
    assert_eq!(verb(""), "");
}
