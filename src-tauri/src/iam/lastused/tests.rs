use std::collections::BTreeSet;

use serde_json::{json, Value};

use super::draft::{compress, verb};
use super::*;
use crate::iam::catalog::catalog;
use crate::iam::clock::{iso, parse_iso, DAY_SECS};
use crate::iam::eval::evaluate;
use crate::iam::fixtures::{self, inline, managed, policy, user};
use crate::iam::model::{GroupRec, Scope};

mod draft;
mod unused;

/// 사용 기록을 만든 시각. 이 시각에 쓴 서비스는 "최근에 쓴" 서비스다.
fn used() -> Option<i64> {
    parse_iso("2026-10-20T12:00:00Z")
}

/// 사용 기록을 만든 시각보다 `days`일 앞.
fn days_before(days: i64) -> Option<i64> {
    used().map(|t| t - days * DAY_SECS)
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
    assert_eq!(unused[0].reason, "허용하는 서비스(EC2)를 400일 동안 한 번도 안 썼어요");
    assert_eq!(statements(&draft), vec![json!({ "Effect": "Allow", "Action": ["s3:*"], "Resource": "*" })]);
    assert!(has_note(&notes, "작업 단위 기록이 없는 서비스"), "{notes:?}");
    // 조건이 걸린 문장이 없으니 조건 안내도 없다
    assert!(!has_note(&notes, "조건"), "{notes:?}");
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
fn action_level_records_drop_only_tracked_actions_that_were_not_used() {
    let w = world(&[("s3-read", json!([allow(json!("s3:Get*"), "*")]))], &[]);
    let mut s3 = svc("s3", used());
    s3.actions = Some(vec![
        action("GetObject", used()),
        // AWS가 소문자로 돌려줘도 카탈로그의 이름과 맞춰 본다
        action("getbucketlocation", used()),
        action("GetBucketAcl", None),
        // 허용받지 않은 작업은 쓴 기록이 있어도 초안에 넣지 않는다
        action("PutObject", used()),
    ]);
    let (_, draft, notes) = run(&w, &raw(vec![s3]));
    let list = statements(&draft);
    assert_eq!(list.len(), 1);
    // AWS가 기록했는데 안 쓴 GetBucketAcl만 빠지고, 기록에 없는 Get 작업(데이터 작업 등)은 그대로 남는다
    let mut expected: Vec<String> = names_with("s3", "Get").into_iter().filter(|n| n != "GetBucketAcl").map(|n| format!("s3:{n}")).collect();
    expected.sort();
    assert_eq!(action_list(&list[0]), expected);
    assert!(has_note(&notes, "최근에 안 쓴 것으로 나온 작업만 뺐어요"), "{notes:?}");
    assert!(has_note(&notes, "데이터 작업"), "{notes:?}");
    assert!(!has_note(&notes, "작업 단위 기록이 없는 서비스"), "{notes:?}");
}

#[test]
fn tracked_actions_reported_unused_are_dropped_even_when_no_tracked_action_was_used() {
    let w = world(&[("s3-all", json!([allow(json!("s3:*"), "*")]))], &[]);
    let mut s3 = svc("s3", used());
    s3.actions = Some(vec![action("GetBucketAcl", None)]);
    let (_, draft, notes) = run(&w, &raw(vec![s3]));
    let actions = action_list(&statements(&draft)[0]);
    let has = |a: &str| actions.contains(&a.to_string());
    assert!(!has("s3:*") && !has("s3:GetBucketAcl") && !has("s3:Get*"), "{actions:?}");
    // 기록되지 않은 작업과 빠진 작업이 없는 묶음은 그대로다
    assert!(has("s3:GetObject") && has("s3:Put*") && has("s3:List*"), "{actions:?}");
    assert!(has_note(&notes, "최근에 안 쓴 것으로 나온 작업만 뺐어요"), "{notes:?}");
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
fn conditionally_allowed_actions_are_left_out_instead_of_losing_their_condition() {
    // 조건을 버리고 옮기면 지금보다 넓게 허용하는 초안이 된다
    let w = world(
        &[(
            "cond",
            json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*", "Condition": { "IpAddress": { "aws:SourceIp": "10.0.0.0/8" } } }]),
        )],
        &[],
    );
    let (_, draft, notes) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(draft, None);
    assert!(has_note(&notes, "조건부로만 허용된 작업은 초안에서 뺐어요: s3:*"), "{notes:?}");
    assert!(has_note(&notes, "초안을 만들지 않았어요"), "{notes:?}");
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
    assert_eq!(notes, vec!["작업 단위 기록이 없는 서비스는 지금 허용된 작업을 그대로 남겼어요".to_string()]);
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

fn anything(_: &str) -> bool {
    true
}

#[test]
fn compress_writes_the_whole_service_as_prefix_star() {
    let all: BTreeSet<String> = catalog().actions("sqs").iter().map(|(n, _)| n.clone()).collect();
    assert_eq!(compress("sqs", &all, anything), vec!["sqs:*"]);
}

#[test]
fn compress_uses_a_wildcard_only_for_a_complete_group() {
    let gets: BTreeSet<String> = names_with("s3", "Get").into_iter().collect();
    assert!(gets.len() > 5);
    assert_eq!(compress("s3", &gets, anything), vec!["s3:Get*"]);

    let mut almost = gets.clone();
    almost.remove("GetObject");
    let out = compress("s3", &almost, anything);
    assert!(!out.contains(&"s3:Get*".to_string()) && !out.contains(&"s3:GetObject".to_string()), "{out:?}");
    assert_eq!(out.len(), almost.len());

    // 하나만 고른 건 이름 그대로
    assert_eq!(compress("s3", &set(&["GetObject"]), anything), vec!["s3:GetObject"]);
    assert_eq!(compress("s3", &set(&["PutObject", "GetObject"]), anything), vec!["s3:GetObject", "s3:PutObject"]);
    assert!(compress("s3", &BTreeSet::new(), anything).is_empty());
}

#[test]
fn compress_writes_a_wildcard_only_where_it_is_allowed_to() {
    // 카탈로그의 작업을 다 골라도, 와일드카드가 카탈로그에 없는 작업까지 덮어도 되는 경우가 아니면 이름을 하나씩 적는다
    let all: BTreeSet<String> = catalog().actions("sqs").iter().map(|(n, _)| n.clone()).collect();
    let none = |_: &str| false;
    let out = compress("sqs", &all, none);
    assert_eq!(out.len(), all.len());
    assert!(out.iter().all(|a| !a.ends_with('*')), "{out:?}");
    // 묶음 와일드카드만 허락되면 서비스 전체 대신 묶음으로 적는다
    let only_gets = |w: &str| w == "sqs:Get*";
    let out = compress("sqs", &all, only_gets);
    assert!(out.contains(&"sqs:Get*".to_string()) && !out.contains(&"sqs:*".to_string()), "{out:?}");
    assert!(!out.iter().any(|a| a.starts_with("sqs:Get") && a != "sqs:Get*"), "{out:?}");
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
