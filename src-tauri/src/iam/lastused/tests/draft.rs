//! 초안은 지금보다 넓게 허용하지 않는다: 조건부로만 허용된 작업은 빼고, 걸려 있는 거부 문장은 원문 그대로 옮기고,
//! 와일드카드는 원래 문장이 덮을 때만 쓴다.

use serde_json::json;

use super::*;
use crate::iam::eval::{evaluate_action, policy_sources, statement_actions, ActionEval, Status};
use crate::iam::policy::{Effect, Resources};

#[test]
fn conditionally_allowed_actions_are_excluded_and_listed() {
    let w = world(
        &[(
            "mixed",
            json!([
                allow(json!("s3:GetObject"), "*"),
                { "Effect": "Allow", "Action": "sqs:SendMessage", "Resource": "*", "Condition": { "Bool": { "aws:SecureTransport": "true" } } }
            ]),
        )],
        &[],
    );
    let (_, draft, notes) = run(&w, &raw(vec![svc("s3", used()), svc("sqs", used())]));
    assert_eq!(statements(&draft), vec![json!({ "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": "*" })]);
    assert!(has_note(&notes, "조건부로만 허용된 작업은 초안에서 뺐어요: sqs:SendMessage"), "{notes:?}");
}

#[test]
fn a_long_conditional_list_names_ten_and_counts_the_rest() {
    let gets: Vec<String> = names_with("s3", "Get").into_iter().take(12).map(|n| format!("s3:{n}")).collect();
    let w = world(&[("cond", json!([{ "Effect": "Allow", "Action": gets, "Resource": "*", "Condition": { "Bool": { "aws:SecureTransport": "true" } } }]))], &[]);
    let (_, draft, notes) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(draft, None);
    let note = notes.iter().find(|n| n.starts_with("조건부로만 허용된 작업은 초안에서 뺐어요: ")).unwrap();
    assert!(note.ends_with(" 외 2개"), "{note}");
    assert_eq!(note.matches("s3:").count(), 10, "{note}");
}

#[test]
fn an_action_allowed_with_and_without_a_condition_keeps_only_the_unconditional_resources() {
    let w = world(
        &[(
            "p",
            json!([
                allow(json!("s3:GetObject"), "arn:aws:s3:::open/*"),
                { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::guarded/*", "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "true" } } }
            ]),
        )],
        &[],
    );
    let (_, draft, notes) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(statements(&draft), vec![json!({ "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": "arn:aws:s3:::open/*" })]);
    assert!(has_note(&notes, "조건이 걸린 허용 문장은 초안에 옮기지 않았어요"), "{notes:?}");
}

#[test]
fn a_partial_deny_is_copied_into_the_draft_verbatim() {
    // bob은 prod-assets*를 읽을 수 있지만 secret/* 의 객체는 Deny로 막혀 있다. 초안에 Deny가 없으면 그것까지 열린다
    let s = fixtures::snapshot();
    let eval = evaluate(&s, fixtures::BOB).unwrap();
    let (_, draft, notes) = least_privilege(&eval, &raw(vec![svc("s3", used())]), &s, fixtures::BOB);
    assert_eq!(
        statements(&draft),
        vec![
            json!({ "Effect": "Allow", "Action": ["s3:Get*", "s3:List*"], "Resource": "arn:aws:s3:::prod-assets*" }),
            // Sid만 빼고 원문 그대로다
            json!({ "Effect": "Deny", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::prod-assets/secret/*" }),
        ]
    );
    assert!(has_note(&notes, "거부(Deny) 문장 1개를 초안에 그대로 옮겼어요"), "{notes:?}");
}

#[test]
fn a_conditional_partial_deny_keeps_its_condition_and_unrelated_denies_stay_out() {
    let condition = json!({ "BoolIfExists": { "aws:MultiFactorAuthPresent": "false" } });
    let w = world(
        &[(
            "p",
            json!([
                allow(json!("s3:GetObject"), "*"),
                { "Sid": "NoSecretWithoutMfa", "Effect": "Deny", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": ["arn:aws:s3:::b/secret/*"], "Condition": condition },
                deny(json!("ec2:*"), json!("*"))
            ]),
        )],
        &[],
    );
    let (_, draft, _) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(
        statements(&draft),
        vec![
            json!({ "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": "*" }),
            json!({ "Effect": "Deny", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": ["arn:aws:s3:::b/secret/*"], "Condition": condition }),
        ]
    );
}

#[test]
fn denies_from_group_and_managed_policies_are_copied_once() {
    let mut w = world(&[], &[("guarded", json!([allow(json!("s3:GetObject"), "*"), deny(json!("s3:GetObject"), json!("arn:aws:s3:::secret/*"))]))]);
    // 같은 관리형 정책이 그룹에도 붙어 있다
    w.s.groups.push(GroupRec { arn: "arn:aws:iam::111111111111:group/devs".into(), name: "devs".into(), path: "/".into(), attached: vec![local("guarded")], ..Default::default() });
    w.s.users[0].groups = vec!["devs".into()];
    let (_, draft, notes) = run(&w, &raw(vec![svc("s3", used())]));
    let list = statements(&draft);
    assert_eq!(list.iter().filter(|st| st["Effect"] == json!("Deny")).count(), 1, "{list:?}");
    assert!(has_note(&notes, "거부(Deny) 문장 1개를"), "{notes:?}");
}

#[test]
fn denies_reachable_only_through_a_wildcard_are_copied_too() {
    // 초안이 s3:*를 쓰면 카탈로그에 아직 없는 작업도 열린다. 그런 작업을 막는 거부도 함께 옮긴다
    let w = world(
        &[("p", json!([allow(json!("s3:*"), "*"), deny(json!("s3:BrandNewAction"), json!("*")), deny(json!("ec2:BrandNewAction"), json!("*"))]))],
        &[],
    );
    let (_, draft, _) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(
        statements(&draft),
        vec![json!({ "Effect": "Allow", "Action": ["s3:*"], "Resource": "*" }), json!({ "Effect": "Deny", "Action": "s3:BrandNewAction", "Resource": "*" })]
    );
}

#[test]
fn a_wildcard_is_written_only_when_the_original_statement_covers_it() {
    // 원래 정책이 Get 작업을 하나씩 적었으면 초안도 하나씩 적는다(`s3:Get*`는 나중에 생길 Get 작업까지 연다)
    let gets: Vec<String> = names_with("s3", "Get").into_iter().map(|n| format!("s3:{n}")).collect();
    let w = world(&[("explicit", json!([allow(json!(gets.clone()), "*")]))], &[]);
    let (_, draft, _) = run(&w, &raw(vec![svc("s3", used())]));
    let mut expected = gets;
    expected.sort();
    assert_eq!(action_list(&statements(&draft)[0]), expected);

    let w = world(&[("wild", json!([allow(json!("s3:Get*"), "*")]))], &[]);
    let (_, draft, _) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(action_list(&statements(&draft)[0]), vec!["s3:Get*"]);

    // 다른 서비스만 빼는 NotAction은 이 서비스 전체를 덮는다
    let w = world(&[("not", json!([{ "Effect": "Allow", "NotAction": "iam:*", "Resource": "*" }]))], &[]);
    let (_, draft, _) = run(&w, &raw(vec![svc("s3", used())]));
    assert_eq!(action_list(&statements(&draft)[0]), vec!["s3:*"]);
    // 같은 서비스의 일부를 빼는 NotAction은 와일드카드로 쓰지 않는다
    let w = world(&[("not", json!([{ "Effect": "Allow", "NotAction": "sqs:Delete*", "Resource": "*" }]))], &[]);
    let (_, draft, _) = run(&w, &raw(vec![svc("sqs", used())]));
    let actions = action_list(&statements(&draft)[0]);
    assert!(actions.iter().all(|a| !a.ends_with('*')) && !actions.is_empty(), "{actions:?}");
    assert!(!actions.iter().any(|a| a.starts_with("sqs:Delete")), "{actions:?}");
}

// ---- 초안은 지금보다 넓지 않다(여러 주체에 대해 확인) ----

/// 초안을 주체의 유일한 신원 정책으로 바꿔 끼운 스냅숏. 권한 경계는 그대로 둔다.
fn with_only_the_draft(s: &Snapshot, arn: &str, draft: &str) -> Snapshot {
    let mut s = s.clone();
    let only = || vec![inline("draft", serde_json::from_str(draft).unwrap())];
    if let Some(u) = s.users.iter_mut().find(|u| u.arn == arn) {
        (u.inline, u.attached, u.groups) = (only(), Vec::new(), Vec::new());
    } else if let Some(r) = s.roles.iter_mut().find(|r| r.arn == arn) {
        (r.inline, r.attached) = (only(), Vec::new());
    } else if let Some(g) = s.groups.iter_mut().find(|g| g.arn == arn) {
        (g.inline, g.attached) = (only(), Vec::new());
    }
    s
}

/// 리소스 라벨 집합. NotResource 라벨(`* (제외: a, b)`)은 제외 목록 순서를 맞춘다.
fn labels(resources: &[String]) -> BTreeSet<String> {
    resources
        .iter()
        .map(|label| match label.strip_prefix("* (제외: ").and_then(|rest| rest.strip_suffix(')')) {
            Some(list) => {
                let mut parts: Vec<&str> = list.split(", ").collect();
                parts.sort_unstable();
                format!("* (제외: {})", parts.join(", "))
            }
            None => label.clone(),
        })
        .collect()
}

/// 주체가 허용받은 서비스를 모두 최근에 쓴 사용 기록. `tracked`면 서비스마다 첫 작업은 "기록했는데 안 씀", 둘째는 "씀"으로 넣는다.
fn report_for(eval: &PrincipalEval, tracked: bool) -> LastAccessedRaw {
    let prefixes: BTreeSet<&str> = eval.actions.keys().map(|(prefix, _)| prefix.as_str()).collect();
    let services = prefixes
        .into_iter()
        .map(|prefix| {
            let mut service = svc(prefix, used());
            if tracked {
                let names = catalog().actions(prefix);
                service.actions = Some(names.iter().take(2).enumerate().map(|(i, (name, _))| action(name, if i == 0 { None } else { used() })).collect());
            }
            service
        })
        .collect();
    raw(services)
}

/// 허용 정도: 조건 없이 허용 > 조건부 > 못 함(거부·경계·허용 문장 없음).
fn openness(result: Option<ActionEval>) -> u8 {
    match result.map(|e| e.status) {
        Some(Status::Allowed) => 2,
        Some(Status::Conditional) => 1,
        _ => 0,
    }
}

/// Deny 문장 하나가 가리키는 (작업들, 리소스 견본들).
type DenySample = (BTreeSet<(String, String)>, Vec<String>);

/// 주체의 신원 정책에 있는 Deny 문장마다 (그 문장이 가리키는 작업, 그 문장의 리소스를 하나씩 글자로 채운 ARN).
/// 일부 리소스만 막는 Deny가 초안에서 빠지면 이 리소스에서 초안이 지금보다 넓어진다.
fn deny_samples(s: &Snapshot, arn: &str) -> Vec<DenySample> {
    let mut out = Vec::new();
    for doc in policy_sources(s, arn).0.iter().filter_map(|src| src.document) {
        for stmt in doc.statements.iter().filter(|st| st.effect == Effect::Deny) {
            let Resources::Resource(patterns) = &stmt.resources else { continue };
            let actions = statement_actions(stmt).0.into_iter().map(|(prefix, action, _)| (prefix, action)).collect();
            let resources = patterns.iter().map(|p| p.replace("${aws:username}", "u").replace(['*', '?'], "x")).collect();
            out.push((actions, resources));
        }
    }
    out
}

fn assert_no_wider_than_today(s: &Snapshot, arn: &str) {
    let before = evaluate(s, arn).unwrap();
    for tracked in [false, true] {
        let (_, draft, _) = least_privilege(&before, &report_for(&before, tracked), s, arn);
        let Some(draft) = draft else { continue };
        let replaced = with_only_the_draft(s, arn, &draft);
        // 초안의 Allow 패턴이 가리키는 카탈로그 작업은 모두 지금 조건 없이 허용돼 있다
        let doc: Value = serde_json::from_str(&draft).unwrap();
        for st in doc["Statement"].as_array().unwrap().iter().filter(|st| st["Effect"] == json!("Allow")) {
            for pattern in action_list(st) {
                for (prefix, name, _) in catalog().expand(&pattern) {
                    let status = before.actions.get(&(prefix.clone(), name.clone())).map(|(_, e)| e.status);
                    assert_eq!(status, Some(Status::Allowed), "{arn} ({tracked}): {pattern} → {prefix}:{name}");
                }
            }
        }
        // 초안만 남긴 주체가 할 수 있는 작업은 지금 조건 없이 할 수 있는 작업이고, 리소스도 넓어지지 않는다
        let after = evaluate(&replaced, arn).unwrap();
        assert!(!after.actions.is_empty(), "{arn}: {draft}");
        let samples = deny_samples(s, arn);
        for (key, (_, now)) in after.actions.iter().filter(|(_, (_, e))| matches!(e.status, Status::Allowed | Status::Conditional)) {
            let (_, was) = before.actions.get(key).unwrap_or_else(|| panic!("{arn} ({tracked}): {key:?}는 지금 허용되지 않아요"));
            assert_eq!(was.status, Status::Allowed, "{arn} ({tracked}): {key:?}");
            assert!(labels(&now.resources).is_subset(&labels(&was.resources)), "{arn} ({tracked}): {key:?} {:?} ⊄ {:?}", now.resources, was.resources);
            // 지금 Deny가 막는 리소스에서는 초안도 막혀 있다
            let action = format!("{}:{}", key.0, key.1);
            for resource in samples.iter().filter(|(actions, _)| actions.contains(key)).flat_map(|(_, resources)| resources) {
                let (then, later) = (evaluate_action(s, arn, &action, Some(resource)), evaluate_action(&replaced, arn, &action, Some(resource)));
                assert!(openness(later) <= openness(then), "{arn} ({tracked}): {action} on {resource}");
            }
        }
    }
}

#[test]
fn drafts_never_allow_more_than_today_for_the_fixture_principals() {
    let s = fixtures::snapshot();
    for arn in [fixtures::ALICE, fixtures::BOB, fixtures::CAROL, fixtures::ADMINS, fixtures::DEPLOY, fixtures::CI, fixtures::VENDOR, fixtures::OPEN, fixtures::SLR, fixtures::SSO] {
        assert_no_wider_than_today(&s, arn);
    }
}

#[test]
fn drafts_never_allow_more_than_today_for_tricky_policies() {
    let condition = json!({ "Bool": { "aws:SecureTransport": "true" } });
    let cases = [
        json!([allow(json!("s3:*"), "*"), { "Effect": "Allow", "Action": "lambda:*", "Resource": "*", "Condition": condition }]),
        json!([allow(json!(["s3:Get*", "s3:List*"]), "arn:aws:s3:::data*"), deny(json!("s3:GetObject"), json!("arn:aws:s3:::data/private/*"))]),
        json!([allow(json!("s3:*"), "*"), { "Effect": "Deny", "Action": "s3:Delete*", "Resource": "*", "Condition": condition }]),
        json!([{ "Effect": "Allow", "NotAction": ["iam:*", "organizations:*"], "Resource": "*" }, deny(json!("ec2:TerminateInstances"), json!("*"))]),
        json!([{ "Effect": "Allow", "Action": "s3:PutObject", "NotResource": ["arn:aws:s3:::z/*", "arn:aws:s3:::a/*"] }]),
        json!([allow(json!("sqs:*"), "*"), { "Effect": "Deny", "NotAction": "sqs:SendMessage", "Resource": "arn:aws:sqs:*:*:locked" }]),
        json!([allow(json!("dynamodb:*"), "arn:aws:dynamodb:*:*:table/${aws:username}*")]),
    ];
    for statements in cases {
        let (s, arn) = fixtures::solo_user(statements.clone());
        assert_no_wider_than_today(&s, &arn);
        // 권한 경계가 일부만 허용하는 경우
        let (s, arn) = fixtures::solo_user_with_boundary(statements, json!([allow(json!(["s3:Get*", "sqs:*", "ec2:Describe*"]), "*")]));
        assert_no_wider_than_today(&s, &arn);
    }
}

// ---- 정책을 못 읽은 주체에는 초안이 없다 ----

/// 스냅숏에서 이 출처(관리형 ARN 또는 `inline:<소유자 ARN>:<이름>`)의 문서를 못 읽은 것처럼 만든다.
fn without_document(s: &Snapshot, id: &str) -> Snapshot {
    let mut s = s.clone();
    match id.strip_prefix("inline:").and_then(|rest| rest.rsplit_once(':')) {
        Some((owner, name)) => {
            let policies = s
                .users
                .iter_mut()
                .filter(|u| u.arn == owner)
                .flat_map(|u| u.inline.iter_mut())
                .chain(s.groups.iter_mut().filter(|g| g.arn == owner).flat_map(|g| g.inline.iter_mut()))
                .chain(s.roles.iter_mut().filter(|r| r.arn == owner).flat_map(|r| r.inline.iter_mut()));
            for policy in policies.filter(|p| p.name == name) {
                policy.document = None;
            }
        }
        None => {
            s.policies.remove(id);
        }
    }
    s
}

#[test]
fn no_principal_gets_a_draft_while_one_of_its_policies_cannot_be_read() {
    // 정책 하나를 못 읽어도 나머지로 초안이 나올 수 있도록, 모든 주체에 읽을 수 있는 정책 하나를 더 붙인다
    let mut s = fixtures::snapshot();
    let extra = || String::from(fixtures::UNUSED_POLICY);
    s.users.iter_mut().for_each(|u| u.attached.push(extra()));
    s.groups.iter_mut().for_each(|g| g.attached.push(extra()));
    s.roles.iter_mut().for_each(|r| r.attached.push(extra()));

    let mut exercised = 0;
    for arn in [fixtures::ALICE, fixtures::BOB, fixtures::CAROL, fixtures::ADMINS, fixtures::DEPLOY, fixtures::CI, fixtures::VENDOR, fixtures::OPEN, fixtures::SLR, fixtures::SSO] {
        let eval = evaluate(&s, arn).unwrap();
        let (_, whole, _) = least_privilege(&eval, &report_for(&eval, false), &s, arn);
        assert!(whole.is_some(), "{arn}");
        for source in policy_sources(&s, arn).0 {
            let blind = without_document(&s, &source.id);
            let eval = evaluate(&blind, arn).unwrap();
            // 나머지 정책만으로는 지금 할 수 있는 작업이 남아 있으니, 계산만 보면 초안을 만들 수 있다
            exercised += usize::from(!eval.actions.is_empty());
            let (_, draft, notes) = least_privilege(&eval, &report_for(&eval, false), &blind, arn);
            assert_eq!(draft, None, "{arn}: {}", source.id);
            assert!(has_note(&notes, &format!("읽지 못한 정책이 있어서 초안을 만들지 않았어요: {}", source.name)), "{arn}: {notes:?}");
        }
    }
    assert!(exercised >= 10, "{exercised}");
}

#[test]
fn a_deny_all_policy_that_could_not_be_read_cannot_leak_into_a_draft() {
    // 진짜 모습: AWSDenyAll이 붙어 있어 아무것도 못 한다
    let deny_all = "arn:aws:iam::aws:policy/AWSDenyAll";
    let (mut truth, arn) = fixtures::solo_user(json!([allow(json!("s3:*"), "*")]));
    truth.policies.insert(deny_all.into(), managed(deny_all, Scope::Aws, 1, policy(json!([deny(json!("*"), json!("*"))]))));
    truth.users[0].attached.push(deny_all.into());
    let today = evaluate(&truth, &arn).unwrap();
    assert!(!today.actions.is_empty() && today.actions.values().all(|(_, e)| e.status == Status::Denied));

    // 앱이 본 모습: 그 정책의 본문을 못 읽었다(GetPolicy가 AccessDenied). 이것만으로 계산하면 s3 작업이 허용으로 나온다
    let mut seen = truth.clone();
    seen.policies.remove(deny_all);
    let eval = evaluate(&seen, &arn).unwrap();
    assert!(eval.actions.values().any(|(_, e)| e.status == Status::Allowed));
    let (_, draft, notes) = least_privilege(&eval, &report_for(&eval, false), &seen, &arn);
    assert_eq!(draft, None, "초안을 쓰면 지금 막힌 s3 작업이 열려요");
    assert!(has_note(&notes, "읽지 못한 정책이 있어서 초안을 만들지 않았어요: AWSDenyAll"), "{notes:?}");
}
