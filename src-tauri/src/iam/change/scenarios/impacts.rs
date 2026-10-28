//! 영향 계산: 누가 영향받고, 서비스·접근 수준 단위로 무엇이 늘고 줄어드는지.

use super::*;
use crate::iam::catalog::{catalog, AccessLevel, LEVELS};
use crate::iam::change::impact::{affected, MAX_AFFECTED, MAX_ROWS, MAX_SHOWN, SAMPLE};
use crate::iam::eval::{evaluate, Status};
use crate::iam::view::{BadgeKind, PrincipalKind};

fn member_of(name: &str, group: &str) -> crate::iam::model::UserRec {
    let mut u = user(name);
    u.groups = vec![group.to_string()];
    u
}

fn delta<'a>(deltas: &'a [PermDelta], prefix: &str, level: AccessLevel) -> Option<&'a PermDelta> {
    deltas.iter().find(|d| d.prefix == prefix && d.level == level)
}

#[test]
fn detaching_admin_from_a_group_lists_the_group_and_its_member_with_lost_counts() {
    let s = snapshot();
    let p = preview(&s, &detach(ADMINS, ADMIN_POLICY), None);
    assert_eq!(impact_names(&p), vec!["admins", "alice"]);
    assert_eq!(p.impacts[0].principal.kind, PrincipalKind::Group);
    assert_eq!(p.impacts[1].principal.kind, PrincipalKind::User);

    let alice = &p.impacts[1];
    assert!(alice.gained.is_empty() && alice.restricted.is_empty());
    // 관리자 정책을 잃으면 카탈로그의 모든 (서비스, 접근 수준) 줄을 잃는다. 작업이 많은 20줄만 보내고 나머지는 줄 수만 센다
    let rows = catalog_rows();
    assert_eq!(alice.lost.len(), MAX_ROWS);
    assert_eq!(alice.lost_omitted, rows.len() - MAX_ROWS);
    let mut counts: Vec<usize> = rows.iter().map(|(_, _, total)| *total).collect();
    counts.sort_unstable_by(|a, b| b.cmp(a));
    let mut kept: Vec<usize> = alice.lost.iter().map(|d| d.count).collect();
    kept.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(kept, counts[..MAX_ROWS], "작업이 가장 많은 줄들이에요");
    for d in &alice.lost {
        assert_eq!(d.count, catalog().total(&d.prefix, d.level), "{}", d.prefix);
        assert_eq!(d.sample.len(), SAMPLE.min(d.count));
        assert!(d.sample.iter().all(|a| a.starts_with(&format!("{}:", d.prefix))));
        // 작업 이름순으로 앞의 5개
        let mut sorted = d.sample.clone();
        sorted.sort();
        assert_eq!(sorted, d.sample);
    }
    // 남긴 줄도 서비스 접두어순, 같은 서비스에서는 접근 수준 순서다
    assert!(alice.lost.windows(2).all(|w| (&w[0].prefix, w[0].level) < (&w[1].prefix, w[1].level)));
}

/// 카탈로그의 (서비스, 접근 수준, 작업 수) 가운데 작업이 하나라도 있는 줄.
fn catalog_rows() -> Vec<(String, AccessLevel, usize)> {
    let cat = catalog();
    cat.services()
        .flat_map(|(prefix, _)| LEVELS.iter().map(move |level| (prefix.to_string(), *level, cat.total(prefix, *level))))
        .filter(|(_, _, total)| *total > 0)
        .collect()
}

#[test]
fn impact_principals_are_summarized_as_they_are_now() {
    let p = preview(&snapshot(), &detach(ADMINS, ADMIN_POLICY), None);
    let alice = &p.impacts[1].principal;
    assert_eq!((alice.arn.as_str(), alice.name.as_str()), (ALICE, "alice"));
    assert!(alice.badges.iter().any(|b| b.kind == BadgeKind::Admin), "변경 전 모습이라 아직 관리자급이에요");
    assert_eq!(p.impacts[0].principal.member_count, Some(1));
}

#[test]
fn attaching_a_policy_gains_only_what_the_principal_did_not_have() {
    let s = snapshot();
    let p = preview(&s, &attach(BOB, S3_FULL), None);
    assert_eq!(impact_names(&p), vec!["bob"]);
    let bob = &p.impacts[0];
    assert!(bob.lost.is_empty());
    assert!(!bob.gained.is_empty() && bob.gained.iter().all(|d| d.prefix == "s3"));

    let write = delta(&bob.gained, "s3", AccessLevel::Write).unwrap();
    assert_eq!(write.count, catalog().total("s3", AccessLevel::Write), "bob은 S3 쓰기가 하나도 없었어요");
    assert!(write.sample.len() <= 5 && write.sample.iter().all(|a| a.starts_with("s3:")));
    assert!(delta(&bob.gained, "s3", AccessLevel::Permissions).is_some());

    // 이미 허용돼 있던 읽기 작업은 늘어난 것으로 세지 않는다
    let before = evaluate(&s, BOB).unwrap();
    let already = before
        .actions
        .iter()
        .filter(|((prefix, _), (level, eval))| prefix == "s3" && *level == AccessLevel::Read && matches!(eval.status, Status::Allowed | Status::Conditional))
        .count();
    assert!(already > 0);
    let read = delta(&bob.gained, "s3", AccessLevel::Read).unwrap();
    assert_eq!(read.count, catalog().total("s3", AccessLevel::Read) - already);
}

#[test]
fn a_permission_boundary_keeps_a_new_policy_from_changing_anything() {
    // carol은 경계(s3:Get*) 안에서만 쓴다. 관리자 정책을 붙여도 더 얻는 것이 없다
    let p = preview(&snapshot(), &attach(CAROL, ADMIN_POLICY), None);
    assert!(p.impacts.is_empty(), "{:?}", impact_names(&p));
    assert_clean(&p);
}

#[test]
fn only_principals_whose_permissions_change_are_listed() {
    let mut s = snapshot();
    // bob도 admins의 구성원이 되지만 이미 같은 정책을 직접 받고 있어서 정책을 떼도 잃는 것이 없다
    s.users[1].groups = vec!["admins".into()];
    s.users[1].attached = vec![ADMIN_POLICY.into()];
    let p = preview(&s, &detach(ADMINS, ADMIN_POLICY), None);
    assert_eq!(impact_names(&p), vec!["admins", "alice"]);
}

#[test]
fn members_follow_the_group_in_user_list_order() {
    let mut s = snapshot();
    s.users[1].groups = vec!["admins".into()];
    s.users[2].groups = vec!["admins".into()];
    let p = preview(&s, &detach(ADMINS, ADMIN_POLICY), None);
    // carol은 권한 경계 때문에 원래 s3:Get* 말고는 쓰지 못했다. 그래도 그 안에서 잃는 것은 없다
    assert_eq!(impact_names(&p), vec!["admins", "alice", "bob"]);
    assert_eq!(affected(&s, &detach(ADMINS, ADMIN_POLICY)), vec![ADMINS, ALICE, BOB, CAROL]);
}

#[test]
fn editing_a_managed_policy_reaches_everyone_who_has_it_directly_or_through_a_group() {
    let mut s = snapshot();
    let shared = add_policy(&mut s, "shared", json!([{ "Effect": "Allow", "Action": "sqs:*", "Resource": "*" }]));
    s.users[1].attached.push(shared.clone());
    s.groups.push(group_rec("ops", &[&shared]));
    s.users.push(member_of("dave", "ops"));
    s.roles.iter_mut().find(|r| r.arn == CI).unwrap().attached.push(shared.clone());

    let change = update_managed(&shared, allow(&["sns:*"]));
    assert_eq!(affected(&s, &change), vec![BOB, &account_arn("group/ops"), CI, &account_arn("user/dave")]);
    let p = preview(&s, &change, None);
    assert_eq!(impact_names(&p), vec!["bob", "ops", "ci", "dave"]);
    let bob = &p.impacts[0];
    assert_eq!(delta(&bob.lost, "sqs", AccessLevel::Write).unwrap().count, catalog().total("sqs", AccessLevel::Write));
    assert_eq!(delta(&bob.gained, "sns", AccessLevel::Write).unwrap().count, catalog().total("sns", AccessLevel::Write));
    assert!(bob.gained.iter().all(|d| d.prefix == "sns") && bob.lost.iter().all(|d| d.prefix == "sqs"));
}

#[test]
fn a_user_who_has_the_policy_directly_and_through_a_group_is_listed_once() {
    let mut s = snapshot();
    let shared = add_policy(&mut s, "shared", json!([{ "Effect": "Allow", "Action": "sqs:*", "Resource": "*" }]));
    s.groups.push(group_rec("ops", &[&shared]));
    let mut dave = member_of("dave", "ops");
    dave.attached.push(shared.clone());
    s.users.push(dave);
    let who = affected(&s, &update_managed(&shared, allow(&["sns:*"])));
    assert_eq!(who, vec![account_arn("user/dave"), account_arn("group/ops")]);
}

#[test]
fn editing_a_policy_used_as_a_permission_boundary_reaches_that_principal() {
    let s = snapshot();
    // 경계를 s3:*로 넓히면 carol은 S3 전체를 쓰게 된다
    let change = update_managed(CAROL_BOUNDARY, allow(&["s3:*"]));
    assert_eq!(affected(&s, &change), vec![CAROL]);
    let p = preview(&s, &change, None);
    assert_eq!(impact_names(&p), vec!["carol"]);
    assert_eq!(delta(&p.impacts[0].gained, "s3", AccessLevel::Write).unwrap().count, catalog().total("s3", AccessLevel::Write));
}

#[test]
fn a_policy_nobody_has_affects_nobody() {
    let s = snapshot();
    let change = update_managed(UNUSED_POLICY, allow(&["sqs:*"]));
    assert!(affected(&s, &change).is_empty());
    let p = preview(&s, &change, None);
    assert!(p.impacts.is_empty());
    assert_clean(&p);
}

#[test]
fn principal_changes_affect_the_principal_and_membership_changes_the_user() {
    let s = snapshot();
    assert_eq!(affected(&s, &attach(BOB, S3_FULL)), vec![BOB]);
    assert_eq!(affected(&s, &detach(DEPLOY, S3_FULL)), vec![DEPLOY]);
    assert_eq!(affected(&s, &drop_inline(BOB, "assets-read")), vec![BOB]);
    assert_eq!(affected(&s, &put_inline(ADMINS, "p", allow(&["s3:*"]))), vec![ADMINS, ALICE]);
    assert_eq!(affected(&s, &add_to_group("bob", "admins")), vec![BOB]);
    assert_eq!(affected(&s, &remove_from_group("alice", "admins")), vec![ALICE]);
    assert!(affected(&s, &attach(&account_arn("user/nobody"), S3_FULL)).is_empty());
}

#[test]
fn access_key_changes_affect_no_permissions() {
    let s = snapshot();
    for change in [set_status("bob", "AKIA1", "Inactive"), delete_key("bob", "AKIA1")] {
        assert!(affected(&s, &change).is_empty());
        assert!(preview(&s, &change, Some("Active")).impacts.is_empty());
    }
}

#[test]
fn conditional_access_still_counts_as_access() {
    let s = snapshot();
    let with_condition = doc(json!([{
        "Effect": "Allow", "Action": ["s3:Get*", "s3:List*"], "Resource": "arn:aws:s3:::prod-assets*",
        "Condition": { "Bool": { "aws:SecureTransport": "true" } }
    }]));
    // 허용 → 조건부는 잃은 것도 얻은 것도 아니지만, 조건이 맞지 않으면 막히니 "조건부로 바뀜"으로 따로 센다
    let p = preview(&s, &put_inline(BOB, "assets-read", with_condition), None);
    assert_eq!(impact_names(&p), vec!["bob"]);
    let bob = &p.impacts[0];
    assert!(bob.gained.is_empty() && bob.lost.is_empty(), "{bob:?}");
    assert!(bob.restricted.iter().all(|d| d.prefix == "s3"));
    let get_or_list = catalog().actions("s3").iter().filter(|(name, _)| name.starts_with("Get") || name.starts_with("List")).count();
    assert_eq!(bob.restricted.iter().map(|d| d.count).sum::<usize>(), get_or_list);
    let read = delta(&bob.restricted, "s3", AccessLevel::Read).expect("s3 읽기가 조건부로 바뀌어요");
    assert!(read.sample.iter().all(|a| a.starts_with("s3:Get") || a.starts_with("s3:List")), "{:?}", read.sample);
    // 앱이 쓰는 주체가 아니니 확인은 필요 없고 주의만 한다
    assert_eq!(only(&p, WarnLevel::Warn), "1명의 일부 권한이 조건부로 바뀌어요");
    assert!(!has_level(&p, WarnLevel::Confirm));

    // 조건부로라도 새로 허용되면 얻은 것이다
    let conditional_sqs = doc(json!([{
        "Effect": "Allow", "Action": "sqs:SendMessage", "Resource": "*",
        "Condition": { "Bool": { "aws:SecureTransport": "true" } }
    }]));
    let p = preview(&s, &put_inline(BOB, "extra", conditional_sqs), None);
    let gained = &p.impacts[0].gained;
    assert_eq!(gained.len(), 1);
    assert_eq!((gained[0].prefix.as_str(), gained[0].level, gained[0].count), ("sqs", AccessLevel::Write, 1));
    assert_eq!(gained[0].sample, vec!["sqs:SendMessage".to_string()]);
}

#[test]
fn an_explicit_deny_counts_as_losing_the_action() {
    let s = snapshot();
    let deny = doc(json!([{ "Effect": "Deny", "Action": "s3:GetObject", "Resource": "*" }]));
    let p = preview(&s, &put_inline(BOB, "deny-get", deny), None);
    assert_eq!(impact_names(&p), vec!["bob"]);
    let bob = &p.impacts[0];
    assert!(bob.gained.is_empty());
    assert_eq!(bob.lost.len(), 1);
    assert_eq!((bob.lost[0].prefix.as_str(), bob.lost[0].level, bob.lost[0].count), ("s3", AccessLevel::Read, 1));
    assert_eq!(bob.lost[0].sample, vec!["s3:GetObject".to_string()]);
}

#[test]
fn at_most_fifty_principals_plus_the_caller_are_computed() {
    let mut s = snapshot();
    let reader = add_policy(&mut s, "reader", json!([{ "Effect": "Allow", "Action": "sqs:ReceiveMessage", "Resource": "*" }]));
    s.groups.push(group_rec("many", &[&reader]));
    for i in 0..60 {
        s.users.push(member_of(&format!("u{i:02}"), "many"));
    }
    // 앱을 쓰는 주체는 구성원 목록의 맨 끝이라 그냥 앞에서 50개를 자르면 빠진다. 한도 밖에서 앞으로 옮겨 오는 만큼 한 자리를 더 받는다
    let zed = member_of("zed", "many");
    s.caller_principal_arn = Some(zed.arn.clone());
    s.users.push(zed);

    let change = detach(&account_arn("group/many"), &reader);
    assert_eq!(affected(&s, &change).len(), 62);
    let p = preview(&s, &change, None);
    // 앞의 50명과 앱이 쓰는 주체까지 51명을 계산해서 30명은 자세히, 나머지 21명은 수만 보낸다
    assert_eq!((p.impacts.len(), p.impacts_omitted), (MAX_SHOWN, MAX_AFFECTED + 1 - MAX_SHOWN));
    assert_eq!(p.impacts[0].principal.name, "zed");
    assert_eq!(messages(&p, WarnLevel::Warn).iter().filter(|m| **m == "영향받는 대상이 많아 처음 50개만 계산했어요").count(), 1);
    // 앱이 쓰는 주체가 권한을 잃으니 확인이 필요하다
    assert!(has_level(&p, WarnLevel::Confirm));
    assert_eq!(p.confirm_text.as_deref(), Some("many"));
}

#[test]
fn a_caller_inside_the_limit_takes_no_extra_slot() {
    let mut s = snapshot();
    let reader = add_policy(&mut s, "reader", json!([{ "Effect": "Allow", "Action": "sqs:ReceiveMessage", "Resource": "*" }]));
    s.groups.push(group_rec("many", &[&reader]));
    for i in 0..60 {
        s.users.push(member_of(&format!("u{i:02}"), "many"));
    }
    // 앱을 쓰는 주체는 구성원 목록의 앞쪽이라 이미 한도 안에 든다: 앞으로 옮기기만 하고 한 자리를 더 받지 않는다
    let early = s.users.iter().find(|u| u.name == "u03").expect("u03").arn.clone();
    s.caller_principal_arn = Some(early);

    let p = preview(&s, &detach(&account_arn("group/many"), &reader), None);

    assert_eq!(p.impacts.len() + p.impacts_omitted, MAX_AFFECTED);
    assert_eq!(p.impacts[0].principal.name, "u03");
}

#[test]
fn exactly_fifty_principals_are_not_truncated() {
    let mut s = snapshot();
    s.caller_principal_arn = None;
    let reader = add_policy(&mut s, "reader", json!([{ "Effect": "Allow", "Action": "sqs:ReceiveMessage", "Resource": "*" }]));
    s.groups.push(group_rec("many", &[&reader]));
    for i in 0..49 {
        s.users.push(member_of(&format!("u{i:02}"), "many"));
    }
    let p = preview(&s, &detach(&account_arn("group/many"), &reader), None);
    assert_eq!(p.impacts.len() + p.impacts_omitted, 50);
    assert!(!messages(&p, WarnLevel::Warn).iter().any(|m| m.contains("처음 50개")));
}
