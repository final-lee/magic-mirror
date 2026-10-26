//! 평가 엔진 테스트: 판정 규칙은 작은 정책으로, 화면 값은 `fixtures::snapshot()`으로 확인한다.

mod scope;
mod verdicts;
mod views;
mod who;

use std::collections::HashMap;

use serde_json::json;

use super::index::{index, ActionId};
use super::{decide_verdict, evaluate_ids, Verdict};
use crate::iam::catalog::{catalog, AccessLevel};
use crate::iam::danger::{admin_like_statementwise, policy_badges, privesc_reasons};
use crate::iam::eval::{evaluate, evaluate_action, policy_sources, principal_view, statement_actions, ActionEval, SourceKind, Status};
use crate::iam::fixtures::*;
use crate::iam::model::{InlinePolicy, Scope, Snapshot};
use crate::iam::policy::Effect;
use crate::iam::view::BadgeKind;

fn key(prefix: &str, action: &str) -> (String, String) {
    (prefix.to_string(), action.to_string())
}

fn status(s: &Snapshot, arn: &str, action: &str, resource: Option<&str>) -> Option<Status> {
    evaluate_action(s, arn, action, resource).map(|eval| eval.status)
}

/// 전체 계산에서 그 작업의 판정.
fn table_status(s: &Snapshot, arn: &str, prefix: &str, action: &str) -> Option<Status> {
    evaluate(s, arn).unwrap().actions.get(&key(prefix, action)).map(|(_, eval)| eval.status)
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

/// 전체 계산과 한 건 계산이 같은 판정(리소스·근거·범위 플래그까지)을 내는지 확인하고 그 판정을 돌려준다.
fn verdict_of(s: &Snapshot, arn: &str, action: &str) -> Option<Verdict> {
    let (prefix, name) = action.split_once(':').unwrap();
    let listed = evaluate(s, arn).unwrap().actions.get(&key(prefix, name)).map(|(_, e)| e.clone());
    assert_eq!(evaluate_action(s, arn, action, None), listed, "{action}: 전체 계산과 한 건 계산이 달라요");
    let (sources, boundary) = policy_sources(s, arn);
    let single = decide_verdict(&sources, boundary.as_ref(), action, None);
    let done = evaluate_ids(&sources, boundary.as_ref(), true);
    let table = done.verdicts.iter().find(|(id, _)| index().names(*id) == (prefix, name)).map(|(_, v)| done.distinct[*v].clone());
    assert_eq!(single, table, "{action}: 범위 플래그까지 같아야 해요");
    single
}

/// `verdict_of`의 판정과 리소스.
fn resources_of(s: &Snapshot, arn: &str, action: &str) -> Option<(Status, Vec<String>)> {
    verdict_of(s, arn, action).map(|v| (v.eval.status, v.eval.resources))
}

/// 한 주체의 판정을 두 길로 구해 견준다: 전체 계산(같은 문장들에 맞은 작업끼리 판정을 나눠 쓴다)과 작업 하나씩 계산.
/// `prefixes`의 서비스(비었으면 카탈로그 전체)의 작업마다 판정·리소스·근거·범위 플래그와 접근 수준이 같아야 한다. 견준 작업 수를 돌려준다.
fn assert_paths_agree(s: &Snapshot, arn: &str, prefixes: &[&str]) -> usize {
    let (sources, boundary) = policy_sources(s, arn);
    let ix = index();
    let named = evaluate(s, arn).unwrap();
    let done = evaluate_ids(&sources, boundary.as_ref(), true);
    let table: HashMap<ActionId, &Verdict> = done.verdicts.iter().map(|(id, v)| (*id, &done.distinct[*v])).collect();
    let mut checked = 0;
    for id in 0..ix.total() as ActionId {
        let (prefix, name) = ix.names(id);
        if !prefixes.is_empty() && !prefixes.contains(&prefix) {
            continue;
        }
        let action = format!("{prefix}:{name}");
        let single = decide_verdict(&sources, boundary.as_ref(), &action, None);
        assert_eq!(single.as_ref(), table.get(&id).copied(), "{arn} {action}");
        let listed = named.actions.get(&key(prefix, name));
        assert_eq!(single.as_ref().map(|v| &v.eval), listed.map(|(_, e)| e), "{arn} {action}");
        if let Some((level, _)) = listed {
            assert_eq!(Some(*level), catalog().level(prefix, name), "{arn} {action}");
        }
        checked += 1;
    }
    checked
}

#[test]
fn alice_gets_everything_through_her_group() {
    let s = snapshot();
    let eval = evaluate(&s, ALICE).unwrap();
    assert!(eval.admin_like);
    assert_eq!(eval.actions.len(), catalog().all_count());
    assert!(eval.actions.values().all(|(_, e)| e.status == Status::Allowed));
    assert!(eval.unknown.is_empty());

    let (level, get_object) = &eval.actions[&key("s3", "GetObject")];
    assert_eq!(*level, AccessLevel::Read);
    assert_eq!(get_object.resources, vec!["*".to_string()]);
    assert_eq!(get_object.sources.len(), 1);
    let source = &get_object.sources[0];
    assert_eq!((source.policy_id.as_str(), source.policy_name.as_str()), (ADMIN_POLICY, "AdministratorAccess"));
    assert_eq!(source.via.as_deref(), Some("admins"));
    assert!(!source.conditional && !source.boundary);

    assert!(admin_like_statementwise(&s, ALICE));
    assert!(policy_badges(&s, ALICE).iter().any(|b| b.kind == BadgeKind::Admin));
    assert!(principal_view(&s, ALICE).unwrap().admin_like);
}

#[test]
fn bob_reads_one_bucket_and_a_secret_prefix_is_denied() {
    let s = snapshot();
    let eval = evaluate(&s, BOB).unwrap();
    let (level, get) = &eval.actions[&key("s3", "GetObject")];
    assert_eq!(*level, AccessLevel::Read);
    assert_eq!(get.status, Status::Allowed);
    assert_eq!(get.resources, vec!["arn:aws:s3:::prod-assets*".to_string()]);

    let allow = get.sources.iter().find(|g| g.effect == Effect::Allow).unwrap();
    assert_eq!((allow.policy_name.as_str(), allow.sid.as_deref(), allow.statement_index), ("assets-read", Some("ReadAssets"), 0));
    assert_eq!(allow.policy_id, format!("inline:{BOB}:assets-read"));
    assert_eq!(allow.via, None);
    // 일부 리소스만 막는 Deny는 출처로만 남고, 대상 리소스를 안 정하면 판정을 바꾸지 않는다
    let deny = get.sources.iter().find(|g| g.effect == Effect::Deny).unwrap();
    assert_eq!((deny.sid.as_deref(), deny.statement_index), (Some("DenySecret"), 1));
    assert_eq!(evaluate_action(&s, BOB, "s3:GetObject", None).as_ref(), Some(get));

    let secret = evaluate_action(&s, BOB, "s3:GetObject", Some("arn:aws:s3:::prod-assets/secret/x")).unwrap();
    assert_eq!(secret.status, Status::Denied);
    assert_eq!(secret.sources[0].effect, Effect::Deny);
    assert_eq!(status(&s, BOB, "s3:GetObject", Some("arn:aws:s3:::prod-assets/public/x")), Some(Status::Allowed));
    assert_eq!(status(&s, BOB, "s3:GetObject", Some("arn:aws:s3:::other/x")), None);
    assert_eq!(status(&s, BOB, "s3:ListBucket", Some("arn:aws:s3:::prod-assets")), Some(Status::Allowed));

    assert_eq!(status(&s, BOB, "s3:PutObject", None), None);
    assert!(!eval.actions.contains_key(&key("s3", "PutObject")));
    assert_eq!(status(&s, BOB, "S3:getobject", None), Some(Status::Allowed));
}

#[test]
fn carol_is_limited_by_her_boundary() {
    let s = snapshot();
    assert_eq!(status(&s, CAROL, "s3:GetObject", None), Some(Status::Allowed));
    let put = evaluate_action(&s, CAROL, "s3:PutObject", None).unwrap();
    assert_eq!(put.status, Status::Boundary);
    assert!(put.sources.iter().all(|g| !g.boundary), "{:?}", put.sources);
    assert_eq!(put.sources[0].policy_id, S3_FULL);

    let get = evaluate_action(&s, CAROL, "s3:GetObject", None).unwrap();
    let boundary = get.sources.iter().find(|g| g.boundary).unwrap();
    assert_eq!((boundary.policy_id.as_str(), boundary.sid.as_deref()), (CAROL_BOUNDARY, Some("ReadOnly")));
    assert_eq!(table_status(&s, CAROL, "s3", "PutObject"), Some(Status::Boundary));
    assert_eq!(table_status(&s, CAROL, "s3", "GetObject"), Some(Status::Allowed));
}

#[test]
fn deploy_role_passes_roles_and_lambda_needs_a_condition() {
    let s = snapshot();
    let pass = evaluate_action(&s, DEPLOY, "iam:PassRole", None).unwrap();
    assert_eq!(pass.status, Status::Allowed);
    assert_eq!(pass.sources[0].sid.as_deref(), Some("PassRole"));
    let reasons = privesc_reasons(&s, DEPLOY);
    assert_eq!(reasons.len(), 1);
    assert!(reasons[0].starts_with("iam:PassRole"), "{reasons:?}");

    let invoke = evaluate_action(&s, DEPLOY, "lambda:InvokeFunction", None).unwrap();
    assert_eq!(invoke.status, Status::Conditional);
    assert!(invoke.sources[0].conditional);
    assert_eq!(invoke.sources[0].sid.as_deref(), Some("LambdaInRegion"));
    assert_eq!(table_status(&s, DEPLOY, "lambda", "InvokeFunction"), Some(Status::Conditional));
}

#[test]
fn a_conditional_deny_over_an_unconditional_allow_is_conditional() {
    let (s, arn) = solo_user(json!([
        { "Sid": "All", "Effect": "Allow", "Action": "s3:*", "Resource": "*" },
        { "Sid": "TlsOnly", "Effect": "Deny", "Action": "s3:DeleteBucket", "Resource": "*", "Condition": { "Bool": { "aws:SecureTransport": "false" } } }
    ]));
    let delete = evaluate_action(&s, &arn, "s3:DeleteBucket", None).unwrap();
    assert_eq!(delete.status, Status::Conditional);
    let deny = delete.sources.iter().find(|g| g.effect == Effect::Deny).unwrap();
    assert!(deny.conditional);
    assert_eq!(status(&s, &arn, "s3:GetObject", None), Some(Status::Allowed));
    assert_eq!(table_status(&s, &arn, "s3", "DeleteBucket"), Some(Status::Conditional));
    // 대상 리소스가 있어도 같다
    assert_eq!(status(&s, &arn, "s3:DeleteBucket", Some("arn:aws:s3:::b")), Some(Status::Conditional));
}

#[test]
fn an_unconditional_deny_beats_every_allow() {
    let (s, arn) = solo_user(json!([
        { "Effect": "Allow", "Action": "s3:*", "Resource": "*" },
        { "Effect": "Allow", "Action": "s3:DeleteBucket", "Resource": "*", "Condition": { "Bool": { "aws:SecureTransport": "true" } } },
        { "Sid": "NoDelete", "Effect": "Deny", "Action": "s3:Delete*", "Resource": "*" }
    ]));
    assert_eq!(status(&s, &arn, "s3:DeleteBucket", None), Some(Status::Denied));
    assert_eq!(table_status(&s, &arn, "s3", "DeleteObject"), Some(Status::Denied));
    assert_eq!(status(&s, &arn, "s3:GetObject", None), Some(Status::Allowed));
    let denied = evaluate_action(&s, &arn, "s3:DeleteBucket", None).unwrap();
    assert_eq!(denied.sources[0].sid.as_deref(), Some("NoDelete"));
}

#[test]
fn only_conditional_allows_make_a_conditional_grant() {
    let (s, arn) = solo_user(json!([
        { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*", "Condition": { "IpAddress": { "aws:SourceIp": "10.0.0.0/8" } } },
        { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"], "Resource": "*" },
        { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "*", "Condition": { "IpAddress": { "aws:SourceIp": "10.0.0.0/8" } } }
    ]));
    assert_eq!(status(&s, &arn, "s3:GetObject", None), Some(Status::Allowed));
    assert_eq!(status(&s, &arn, "s3:PutObject", None), Some(Status::Allowed));
    assert_eq!(status(&s, &arn, "s3:ListBucket", None), Some(Status::Conditional));
}

#[test]
fn a_deny_without_an_allow_leaves_the_action_out() {
    let (s, arn) = solo_user(json!([{ "Effect": "Deny", "Action": "s3:*", "Resource": "*" }]));
    assert_eq!(status(&s, &arn, "s3:GetObject", None), None);
    assert!(evaluate(&s, &arn).unwrap().actions.is_empty());
}

#[test]
fn a_deny_on_part_of_the_resources_only_matters_for_those_resources() {
    let (s, arn) = solo_user(json!([
        { "Effect": "Allow", "Action": "s3:*", "Resource": "*" },
        { "Effect": "Deny", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::secret/*", "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "false" } } }
    ]));
    assert_eq!(status(&s, &arn, "s3:GetObject", None), Some(Status::Allowed));
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::secret/key")), Some(Status::Conditional));
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::open/key")), Some(Status::Allowed));
}

#[test]
fn a_deny_that_covers_every_allowed_resource_denies_without_a_resource() {
    let (s, arn) = solo_user(json!([
        { "Effect": "Allow", "Action": "s3:*", "Resource": ["arn:aws:s3:::data/*", "arn:aws:s3:::data"] },
        { "Effect": "Deny", "Action": "s3:Delete*", "Resource": "arn:aws:s3:::data*" },
        { "Effect": "Deny", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::data/private/*" }
    ]));
    assert_eq!(status(&s, &arn, "s3:DeleteObject", None), Some(Status::Denied));
    // 덮지 못하는 Deny는 판정을 바꾸지 않는다
    assert_eq!(status(&s, &arn, "s3:PutObject", None), Some(Status::Allowed));
    assert_eq!(status(&s, &arn, "s3:PutObject", Some("arn:aws:s3:::data/private/x")), Some(Status::Denied));
    // 모든 리소스를 허용한 Allow는 일부만 덮는 Deny로 막히지 않는다
    let (s, arn) = solo_user(json!([
        { "Effect": "Allow", "Action": "s3:*", "Resource": "*" },
        { "Effect": "Deny", "Action": "s3:Delete*", "Resource": "arn:aws:s3:::data*" }
    ]));
    assert_eq!(status(&s, &arn, "s3:DeleteObject", None), Some(Status::Allowed));
    let (s, arn) = solo_user(json!([
        { "Effect": "Allow", "Action": "s3:*", "Resource": "*" },
        { "Effect": "Deny", "Action": "s3:Delete*", "NotResource": "arn:aws:s3:::keep/*" }
    ]));
    assert_eq!(status(&s, &arn, "s3:DeleteObject", None), Some(Status::Allowed));
    assert_eq!(status(&s, &arn, "s3:DeleteObject", Some("arn:aws:s3:::other/x")), Some(Status::Denied));
    assert_eq!(status(&s, &arn, "s3:DeleteObject", Some("arn:aws:s3:::keep/x")), Some(Status::Allowed));
}

#[test]
fn policy_variables_make_the_statement_conditional_for_a_resource() {
    let (s, arn) = solo_user(json!([
        { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::home/${aws:username}/*" }
    ]));
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::home/alice/file")), Some(Status::Conditional));
    let eval = evaluate_action(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::home/alice/file")).unwrap();
    assert!(eval.sources[0].conditional);
    // 대상을 안 정하면 자기 폴더를 읽을 수 있다는 뜻으로 허용이다
    assert_eq!(status(&s, &arn, "s3:GetObject", None), Some(Status::Allowed));

    let (s, arn) = solo_user(json!([
        { "Effect": "Allow", "Action": "s3:*", "Resource": "*" },
        { "Effect": "Deny", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::home/${aws:username}/*" }
    ]));
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::home/bob/file")), Some(Status::Conditional));
}

#[test]
fn not_action_means_the_rest_of_the_catalog() {
    let (s, arn) = solo_user(json!([{ "Effect": "Allow", "NotAction": "iam:*", "Resource": "*" }]));
    let eval = evaluate(&s, &arn).unwrap();
    assert_eq!(eval.actions.len(), catalog().all_count() - catalog().actions("iam").len());
    assert_eq!(eval.actions[&key("s3", "GetObject")].1.status, Status::Allowed);
    assert!(!eval.actions.contains_key(&key("iam", "GetUser")));
    assert!(eval.unknown.is_empty());
    assert_eq!(status(&s, &arn, "s3:GetObject", None), Some(Status::Allowed));
    assert_eq!(status(&s, &arn, "iam:GetUser", None), None);
    // PowerUserAccess처럼 몇 서비스만 뺀 허용은 관리자급이다
    assert!(eval.admin_like);
    assert!(admin_like_statementwise(&s, &arn));

    // Deny의 NotAction: S3 말고는 전부 거부
    let (s, arn) = solo_user(json!([
        { "Effect": "Allow", "Action": "*", "Resource": "*" },
        { "Effect": "Deny", "NotAction": "s3:*", "Resource": "*" }
    ]));
    assert_eq!(table_status(&s, &arn, "s3", "GetObject"), Some(Status::Allowed));
    assert_eq!(table_status(&s, &arn, "iam", "GetUser"), Some(Status::Denied));
    assert_eq!(status(&s, &arn, "iam:GetUser", None), Some(Status::Denied));
    assert!(!evaluate(&s, &arn).unwrap().admin_like);
    assert!(!admin_like_statementwise(&s, &arn));
}

#[test]
fn unknown_actions_are_reported_and_left_out_of_the_table() {
    let (s, arn) = solo_user(json!([
        { "Effect": "Allow", "Action": ["foo:Bar", "s3:GetObject", "s3:NoSuchThing", "nosuch:*"], "Resource": "*" },
        { "Effect": "Allow", "Action": "foo:Bar", "Resource": "arn:aws:foo:::x" },
        { "Effect": "Deny", "Action": "bar:Baz", "Resource": "*" },
        { "Effect": "Allow", "NotAction": "qux:Nope", "Resource": "arn:aws:nothing:::*" }
    ]));
    let eval = evaluate(&s, &arn).unwrap();
    assert_eq!(eval.unknown, vec!["foo:Bar".to_string(), "nosuch:*".to_string(), "s3:NoSuchThing".to_string()]);
    assert!(!eval.actions.keys().any(|(prefix, _)| prefix == "foo" || prefix == "nosuch"));
    // 한 건씩 보는 쪽은 카탈로그에 없어도 패턴으로 판정한다
    assert_eq!(status(&s, &arn, "foo:Bar", None), Some(Status::Allowed));
    assert_eq!(principal_view(&s, &arn).unwrap().unknown_actions, eval.unknown);
}

#[test]
fn boundaries_block_or_condition_the_grant() {
    let allow_s3 = json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*" }]);
    let (s, arn) = solo_user_with_boundary(allow_s3.clone(), json!([{ "Sid": "B", "Effect": "Allow", "Action": "s3:Get*", "Resource": "*" }]));
    assert_eq!(status(&s, &arn, "s3:GetObject", None), Some(Status::Allowed));
    assert_eq!(status(&s, &arn, "s3:PutObject", None), Some(Status::Boundary));
    assert_eq!(table_status(&s, &arn, "s3", "PutObject"), Some(Status::Boundary));
    // 경계가 조건부로만 허용하면 조건부
    let (s, arn) = solo_user_with_boundary(
        allow_s3.clone(),
        json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*", "Condition": { "StringEquals": { "aws:RequestedRegion": "us-east-1" } } }]),
    );
    assert_eq!(status(&s, &arn, "s3:GetObject", None), Some(Status::Conditional));
    // 경계의 Deny도 Deny다
    let (s, arn) = solo_user_with_boundary(
        allow_s3.clone(),
        json!([{ "Effect": "Allow", "Action": "*", "Resource": "*" }, { "Effect": "Deny", "Action": "s3:Delete*", "Resource": "*" }]),
    );
    assert_eq!(status(&s, &arn, "s3:DeleteBucket", None), Some(Status::Denied));
    assert_eq!(status(&s, &arn, "s3:GetObject", None), Some(Status::Allowed));
    // 대상 리소스가 경계 밖이면 막힌다
    let (s, arn) = solo_user_with_boundary(allow_s3, json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "arn:aws:s3:::only/*" }]));
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::only/x")), Some(Status::Allowed));
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::other/x")), Some(Status::Boundary));
    // 허용하는 문장이 없으면 경계가 있어도 표에서 빠진다
    assert_eq!(status(&s, &arn, "ec2:RunInstances", None), None);
    // 조건부 허용이어도 경계가 아예 허용하지 않으면 경계 차단이 먼저다
    let (cs, carn) = solo_user_with_boundary(
        json!([{ "Effect": "Allow", "Action": "s3:*", "Resource": "*", "Condition": { "Bool": { "aws:SecureTransport": "true" } } }]),
        json!([{ "Effect": "Allow", "Action": "ec2:*", "Resource": "*" }]),
    );
    assert_eq!(status(&cs, &carn, "s3:GetObject", None), Some(Status::Boundary));
    // 읽지 못한 경계 정책은 없는 것으로 본다
    let boundary_arn = s.users[0].boundary.clone().unwrap();
    let mut s = s;
    s.policies.get_mut(&boundary_arn).unwrap().document = None;
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::other/x")), Some(Status::Allowed));
}

#[test]
fn single_action_matching_agrees_with_catalog_expansion() {
    let patterns = [
        "*", "*:*", "s3:*", "S3:get*", "s3:GetObject", "iam:*User*", "ec2:Describe?pc*", "*:Get*Policy", "s*:List*", "e?2:*Tags", "nosuch:*", "ec2*",
        "*Object", "s3?GetObject", "s3-object-lambda:*", "s3:", ":*", "lambda:INVOKE*",
    ];
    let cat = catalog();
    for pattern in patterns {
        let expanded: std::collections::BTreeSet<String> = cat.expand(pattern).into_iter().map(|(p, a, _)| format!("{p}:{a}")).collect();
        for (prefix, _) in cat.services() {
            for (name, _) in cat.actions(prefix) {
                let full = format!("{prefix}:{name}");
                assert_eq!(super::pattern_matches(pattern, &full), expanded.contains(&full), "{pattern} vs {full}");
            }
        }
    }
}

#[test]
fn overlapping_patterns_count_a_statement_once() {
    let (s, arn) = solo_user(json!([{ "Sid": "Dup", "Effect": "Allow", "Action": ["s3:*", "s3:Get*", "S3:GETOBJECT"], "Resource": ["*", "*"] }]));
    let single = evaluate_action(&s, &arn, "s3:GetObject", None).unwrap();
    assert_eq!(single.sources.len(), 1);
    assert_eq!(single.resources, vec!["*".to_string()]);
    let table = &evaluate(&s, &arn).unwrap().actions[&key("s3", "GetObject")].1;
    assert_eq!(table, &single);
}

#[test]
fn not_resource_allows_are_labeled_with_their_exclusions() {
    let (s, arn) = solo_user(json!([
        { "Effect": "Allow", "Action": "s3:GetObject", "NotResource": ["arn:aws:s3:::secret/*", "arn:aws:s3:::audit/*"] },
        { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::open/*" }
    ]));
    let get = evaluate_action(&s, &arn, "s3:GetObject", None).unwrap();
    assert_eq!(get.resources, vec!["* (제외: arn:aws:s3:::secret/*, arn:aws:s3:::audit/*)".to_string(), "arn:aws:s3:::open/*".to_string()]);
    // NotResource에 든 리소스에는 그 문장이 적용되지 않는다
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::secret/x")), None);
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::other/x")), Some(Status::Allowed));
    assert_eq!(status(&s, &arn, "s3:GetObject", Some("arn:aws:s3:::open/x")), Some(Status::Allowed));
}

#[test]
fn statement_actions_lists_names_in_byte_order_for_other_modules() {
    let d = doc(policy(json!([
        { "Effect": "Allow", "Action": ["s3:Get*", "S3:GETOBJECT", "foo:Bar", "iam:CreateUser", "iam:createuser"], "Resource": "*" },
        { "Effect": "Allow", "NotAction": ["iam:*", "foo:Bar"], "Resource": "*" }
    ])));
    let cat = catalog();
    let (found, unmatched) = statement_actions(&d.statements[0]);
    assert_eq!(unmatched, vec!["foo:Bar"]);
    assert!(found.windows(2).all(|w| (&w[0].0, &w[0].1) < (&w[1].0, &w[1].1)), "(접두어, 작업)의 바이트순이고 중복이 없어야 해요");
    let expected: std::collections::BTreeSet<(String, String, AccessLevel)> =
        ["s3:Get*", "iam:CreateUser"].iter().flat_map(|pattern| cat.expand(pattern)).collect();
    assert_eq!(found.iter().cloned().collect::<std::collections::BTreeSet<_>>(), expected);
    assert!(found.iter().any(|(prefix, action, level)| (prefix.as_str(), action.as_str(), *level) == ("s3", "GetObject", AccessLevel::Read)));

    // NotAction은 카탈로그에서 뺀 나머지이고 맞지 않은 패턴을 알리지 않는다
    let (rest, unmatched) = statement_actions(&d.statements[1]);
    assert!(unmatched.is_empty());
    assert_eq!(rest.len(), cat.all_count() - cat.actions("iam").len());
    assert!(rest.windows(2).all(|w| (&w[0].0, &w[0].1) < (&w[1].0, &w[1].1)));
    assert!(rest.iter().all(|(prefix, _, _)| prefix != "iam"));
}

#[test]
fn policy_sources_cover_inline_managed_group_and_boundary_policies() {
    let s = snapshot();
    let (alice, boundary) = policy_sources(&s, ALICE);
    assert!(boundary.is_none());
    assert_eq!(alice.len(), 1);
    assert_eq!((alice[0].id.as_str(), alice[0].via.as_deref(), alice[0].kind), (ADMIN_POLICY, Some("admins"), SourceKind::Managed));
    assert_eq!(alice[0].scope, Some(Scope::Aws));

    let (bob, _) = policy_sources(&s, BOB);
    assert_eq!(bob.len(), 1);
    assert_eq!((bob[0].id.clone(), bob[0].kind, bob[0].scope), (format!("inline:{BOB}:assets-read"), SourceKind::Inline, None));

    let (carol, boundary) = policy_sources(&s, CAROL);
    assert_eq!(carol.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec![S3_FULL]);
    let boundary = boundary.unwrap();
    assert_eq!((boundary.id.as_str(), boundary.kind, boundary.scope), (CAROL_BOUNDARY, SourceKind::Boundary, Some(Scope::Local)));

    // 그룹은 자기 정책만, 모르는 ARN은 아무것도 없다
    let (admins, boundary) = policy_sources(&s, ADMINS);
    assert_eq!((admins.len(), admins[0].via.clone(), boundary.is_none()), (1, None, true));
    let (none, boundary) = policy_sources(&s, "arn:aws:iam::111111111111:user/nobody");
    assert!(none.is_empty() && boundary.is_none());
    assert!(evaluate(&s, "arn:aws:iam::111111111111:user/nobody").is_none());
    assert!(evaluate_action(&s, "arn:aws:iam::111111111111:user/nobody", "s3:GetObject", None).is_none());
    assert!(principal_view(&s, "arn:aws:iam::111111111111:user/nobody").is_none());
}

#[test]
fn policies_without_a_readable_document_are_skipped() {
    let (mut s, arn) = solo_user(json!([{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*" }]));
    s.users[0].attached.push("arn:aws:iam::aws:policy/Missing".into());
    s.users[0].inline.push(InlinePolicy { name: "broken".into(), raw: "{".into(), document: None });
    let (sources, _) = policy_sources(&s, &arn);
    assert_eq!(sources.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["p", "broken", "Missing"]);
    assert_eq!(sources[2].scope, Some(Scope::Aws));
    assert_eq!(sources.iter().filter(|x| x.document.is_none()).count(), 2);
    assert_eq!(evaluate(&s, &arn).unwrap().actions.len(), 1);
    assert_eq!(status(&s, &arn, "s3:GetObject", None), Some(Status::Allowed));
    let notes = principal_view(&s, &arn).unwrap().notes;
    assert_eq!(notes.len(), 2, "{notes:?}");
    assert!(notes.iter().any(|n| n.contains("broken")) && notes.iter().any(|n| n.contains("Missing")));
}

/// 그룹·경계·Deny·NotAction이 섞인 주체. 전체 계산과 한 건 계산이 같은 답을 내는지 본다.
fn mixed() -> (Snapshot, String) {
    let (mut s, arn) = solo_user_with_boundary(
        json!([
            { "Sid": "S3", "Effect": "Allow", "Action": ["s3:*", "lambda:Get*", "lambda:INVOKE*"], "Resource": "*" },
            { "Sid": "Cond", "Effect": "Deny", "Action": "s3:Delete*", "Resource": "*", "Condition": { "Bool": { "aws:SecureTransport": "false" } } },
            { "Sid": "Part", "Effect": "Deny", "Action": "s3:PutBucketPolicy", "Resource": "arn:aws:s3:::x*" },
            { "Sid": "Rest", "Effect": "Allow", "NotAction": ["ec2:*", "iam:*"], "Resource": "arn:aws:s3:::*" },
            { "Sid": "Var", "Effect": "Allow", "Action": "ec2:Describe*", "Resource": "arn:aws:ec2:*:*:instance/${aws:username}" }
        ]),
        json!([
            { "Effect": "Allow", "Action": ["s3:*", "iam:*", "ec2:Describe*"], "Resource": "*" },
            { "Effect": "Allow", "Action": "lambda:*", "Resource": "*", "Condition": { "Bool": { "aws:ViaAWSService": "true" } } },
            { "Effect": "Deny", "Action": "s3:DeleteBucket", "Resource": "*" }
        ]),
    );
    s.groups.push(crate::iam::model::GroupRec {
        arn: format!("arn:aws:iam::{ACCOUNT}:group/devs"),
        name: "devs".into(),
        path: "/".into(),
        inline: vec![inline("g", policy(json!([{ "Effect": "Allow", "Action": ["iam:Get*", "sts:AssumeRole"], "Resource": "*" }])))],
        ..Default::default()
    });
    s.users[0].groups.push("devs".into());
    (s, arn)
}

#[test]
fn the_full_expansion_agrees_with_the_single_action_path() {
    let mut s = snapshot();
    let (mixed_snapshot, mixed_arn) = mixed();
    s.users.extend(mixed_snapshot.users);
    s.groups.extend(mixed_snapshot.groups);
    s.policies.extend(mixed_snapshot.policies);
    let prefixes = ["s3", "iam", "lambda", "sts", "ec2"];
    let in_catalog: usize = prefixes.iter().map(|prefix| catalog().actions(prefix).len()).sum();
    for arn in [ALICE, BOB, CAROL, DEPLOY, mixed_arn.as_str()] {
        assert_eq!(assert_paths_agree(&s, arn, &prefixes), in_catalog, "{arn}");
        // 공개 함수(`evaluate_action`)로 물어도 같다
        let eval = evaluate(&s, arn).unwrap();
        for prefix in prefixes {
            for (name, _) in catalog().actions(prefix) {
                let table = eval.actions.get(&key(prefix, name)).map(|(_, e)| e);
                assert_eq!(evaluate_action(&s, arn, &format!("{prefix}:{name}"), None).as_ref(), table, "{arn} {prefix}:{name}");
            }
        }
    }
    // 섞인 주체의 몇 가지 판정을 직접 확인한다
    let eval = evaluate(&s, &mixed_arn).unwrap();
    let at = |prefix: &str, action: &str| eval.actions.get(&key(prefix, action)).map(|(_, e): &(AccessLevel, ActionEval)| e.status);
    assert_eq!(at("s3", "GetObject"), Some(Status::Allowed));
    assert_eq!(at("s3", "DeleteObject"), Some(Status::Conditional));
    assert_eq!(at("s3", "DeleteBucket"), Some(Status::Denied));
    assert_eq!(at("s3", "PutBucketPolicy"), Some(Status::Allowed));
    assert_eq!(at("lambda", "GetFunction"), Some(Status::Conditional));
    assert_eq!(at("lambda", "InvokeFunction"), Some(Status::Conditional));
    assert_eq!(at("iam", "GetUser"), Some(Status::Allowed));
    assert_eq!(at("sts", "AssumeRole"), Some(Status::Boundary));
    assert_eq!(at("ec2", "DescribeInstances"), Some(Status::Allowed));
    assert_eq!(at("ec2", "RunInstances"), None);
}
