//! 화면으로 보내는 양의 한도: 증감마다 작업이 많은 20줄, 주체는 30명까지 자세히 보내고 나머지는 수만 센다.
//! 관리자 정책을 큰 그룹에 붙이는 최악의 경우에도 미리보기 JSON이 작게 유지된다.

use super::*;
use crate::iam::change::impact::{capped, MAX_AFFECTED, MAX_ROWS, MAX_SHOWN};
use crate::iam::model::RoleRec;

fn member_of(name: &str, group: &str) -> crate::iam::model::UserRec {
    let mut u = user(name);
    u.groups = vec![group.to_string()];
    u
}

/// 그룹 하나(`many`)에 구성원 `n`명을 넣고, 그 그룹에 붙은 정책(`reader`)의 ARN을 돌려준다.
fn group_of(s: &mut Snapshot, n: usize) -> String {
    let reader = add_policy(s, "reader", json!([{ "Effect": "Allow", "Action": "sqs:ReceiveMessage", "Resource": "*" }]));
    s.groups.push(group_rec("many", &[&reader]));
    for i in 0..n {
        s.users.push(member_of(&format!("u{i:03}"), "many"));
    }
    reader
}

fn rows(counts: &[usize]) -> Vec<PermDelta> {
    counts.iter().enumerate().map(|(i, count)| PermDelta { prefix: format!("svc{i:02}"), level: crate::iam::catalog::AccessLevel::Read, count: *count, sample: vec![] }).collect()
}

#[test]
fn a_short_list_of_rows_is_sent_whole() {
    let (kept, omitted) = capped(rows(&[3, 1, 2]));
    assert_eq!((kept.len(), omitted), (3, 0));
}

#[test]
fn a_long_list_keeps_the_largest_rows_in_their_order() {
    let counts: Vec<usize> = (0..25).map(|i| if i % 5 == 0 { 100 + i } else { i }).collect();
    let (kept, omitted) = capped(rows(&counts));
    assert_eq!((kept.len(), omitted), (MAX_ROWS, 5));
    // 작업이 가장 적은 다섯 줄(svc01~04, svc06)이 빠지고, 남은 줄은 원래 순서(서비스 이름순)다
    let names: Vec<&str> = kept.iter().map(|d| d.prefix.as_str()).collect();
    assert!(!["svc01", "svc02", "svc03", "svc04", "svc06"].iter().any(|n| names.contains(n)), "{names:?}");
    assert!(names.windows(2).all(|w| w[0] < w[1]));
    // 같은 수면 앞선 줄을 남긴다
    let (tied, _) = capped(rows(&[1; 21]));
    assert_eq!(tied.last().map(|d| d.prefix.as_str()), Some("svc19"));
}

#[test]
fn at_most_thirty_principals_are_sent_in_detail() {
    let mut s = called_by(snapshot(), None);
    let reader = group_of(&mut s, 39);
    let p = preview(&s, &detach(&account_arn("group/many"), &reader), None);
    assert_eq!((p.impacts.len(), p.impacts_omitted), (MAX_SHOWN, 10));
    assert_eq!(p.impacts[0].principal.name, "many");
    // 영향받는 주체 수를 알리는 주의는 보내지 못한 주체까지 센다
    assert!(messages(&p, WarnLevel::Warn).contains(&"영향받는 주체가 40개예요"), "{:?}", p.warnings);
    let value = serde_json::to_value(&p).unwrap();
    assert_eq!(value["impactsOmitted"], json!(10));
}

#[test]
fn the_caller_is_always_among_the_principals_sent_in_detail() {
    let mut s = snapshot();
    let reader = group_of(&mut s, 39);
    let last = s.users.last().unwrap().arn.clone();
    s.caller_principal_arn = Some(last.clone());
    let p = preview(&s, &detach(&account_arn("group/many"), &reader), None);
    assert_eq!(p.impacts.len(), MAX_SHOWN);
    assert_eq!(p.impacts[0].principal.arn, last);
}

#[test]
fn omitted_counts_are_sent_only_when_something_was_left_out() {
    let s = snapshot();
    // 작은 미리보기에는 새 필드가 없다(계약에 더한 선택 필드)
    let small = serde_json::to_value(preview(&s, &attach(BOB, S3_FULL), None)).unwrap();
    assert!(small.get("impactsOmitted").is_none());
    let impact = &small["impacts"][0];
    for field in ["restricted", "gainedOmitted", "lostOmitted", "restrictedOmitted"] {
        assert!(impact.get(field).is_none(), "{field}");
    }
    // 관리자 정책을 떼면 alice는 모든 줄을 잃는다
    let big = serde_json::to_value(preview(&s, &detach(ADMINS, ADMIN_POLICY), None)).unwrap();
    let alice = &big["impacts"][1];
    assert_eq!(alice["lost"].as_array().unwrap().len(), MAX_ROWS);
    assert!(alice["lostOmitted"].as_u64().is_some_and(|n| n > 0), "{}", alice["lostOmitted"]);
    assert!(alice.get("gainedOmitted").is_none());
}

#[test]
fn administrator_access_on_a_big_group_keeps_the_preview_small() {
    let mut s = snapshot();
    s.groups.push(group_rec("everyone", &[]));
    for i in 0..300 {
        s.users.push(member_of(&format!("person{i:03}"), "everyone"));
    }
    for name in ["ops", "qa", "data"] {
        s.groups.push(group_rec(name, &[S3_FULL]));
    }
    for name in ["app", "batch", "etl"] {
        let mut r: RoleRec = role(name, "/", trust(json!({ "Service": "ec2.amazonaws.com" }), "sts:AssumeRole", None));
        r.attached.push(S3_FULL.into());
        s.roles.push(r);
    }

    let p = preview(&s, &attach(&account_arn("group/everyone"), ADMIN_POLICY), None);
    assert_eq!((p.impacts.len(), p.impacts_omitted), (MAX_SHOWN, MAX_AFFECTED - MAX_SHOWN));
    assert!(p.impacts.iter().all(|i| i.gained.len() == MAX_ROWS && i.gained_omitted > 0));
    assert!(has_level(&p, WarnLevel::Confirm), "관리자급을 새로 얻는 주체가 있어요");
    let size = serde_json::to_vec(&p).unwrap().len();
    assert!(size < 500 * 1024, "미리보기가 {size}바이트예요");
}
