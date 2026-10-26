//! "안 씀": 기록 기간(400일) 안에 한 번도 안 썼거나, 마지막 사용이 사용 기록을 만든 시각보다 90일 넘게 앞이다.
//! 안 쓰는 정책, 초안, 작업 단위 기록에 모두 같은 뜻으로 쓴다. 만든 지 얼마 안 된 주체에는 뗄 정책을 고르지 않는다.

use serde_json::json;

use super::*;

fn ec2_world() -> World {
    world(&[("s3-all", json!([allow(json!("s3:*"), "*")]))], &[("ec2-all", json!([allow(json!("ec2:*"), "*")]))])
}

#[test]
fn a_service_last_used_over_90_days_before_the_report_counts_as_unused() {
    let w = ec2_world();
    let (unused, draft, notes) = run(&w, &raw(vec![svc("s3", used()), svc("ec2", days_before(120))]));
    assert_eq!(unused.len(), 1);
    assert_eq!(unused[0].name, "ec2-all");
    assert_eq!(unused[0].reason, "허용하는 서비스(EC2)를 90일 넘게 안 썼어요(마지막 사용 120일 전)");
    // 초안에도 넣지 않고, 화면의 마지막 사용 날짜와 초안이 어긋나 보이지 않게 이유를 알린다
    assert_eq!(statements(&draft), vec![json!({ "Effect": "Allow", "Action": ["s3:*"], "Resource": "*" })]);
    assert!(has_note(&notes, "마지막 사용이 90일 넘게 지난 서비스는 안 쓰는 것으로 보고 초안에서 뺐어요: EC2"), "{notes:?}");
}

#[test]
fn the_stale_threshold_is_more_than_90_days() {
    let outcome = |days: i64| {
        let w = world(&[], &[("ec2-all", json!([allow(json!("ec2:*"), "*")]))]);
        let (unused, draft, _) = run(&w, &raw(vec![svc("ec2", days_before(days))]));
        (unused.len(), draft.is_some())
    };
    assert_eq!(outcome(0), (0, true));
    assert_eq!(outcome(90), (0, true));
    assert_eq!(outcome(91), (1, false));
}

#[test]
fn reasons_tell_never_used_and_long_unused_services_apart() {
    let w = world(&[], &[("many", json!([allow(json!(["ec2:*", "sqs:*", "sns:*"]), "*")]))]);
    let (unused, _, _) = run(&w, &raw(vec![svc("ec2", None), svc("sqs", days_before(200)), svc("sns", days_before(150))]));
    assert_eq!(unused.len(), 1);
    // 오래 안 쓴 쪽은 그중 가장 최근에 쓴 날을 알린다
    assert_eq!(unused[0].reason, "허용하는 서비스를 모두 90일 넘게 안 썼어요. 400일 동안 한 번도 안 썼어요: EC2. 마지막 사용 150일 전: SNS, SQS");
    let (unused, _, _) = run(&w, &raw(vec![svc("ec2", None), svc("sqs", None), svc("sns", None)]));
    assert_eq!(unused[0].reason, "허용하는 서비스(EC2, SNS, SQS)를 400일 동안 한 번도 안 썼어요");
    // 하나라도 최근에 썼으면 통째로 안 쓰는 정책이 아니다
    let (unused, _, _) = run(&w, &raw(vec![svc("ec2", None), svc("sqs", days_before(200)), svc("sns", days_before(10))]));
    assert!(unused.is_empty(), "{unused:?}");
}

#[test]
fn a_young_principal_gets_a_note_instead_of_suggestions() {
    let mut w = ec2_world();
    let report = raw(vec![svc("s3", used()), svc("ec2", None)]);
    w.s.users[0].created_at = days_before(30).map(iso);
    let (unused, draft, notes) = run(&w, &report);
    assert!(unused.is_empty(), "{unused:?}");
    assert_eq!(notes[0], "만든 지 30일밖에 안 된 주체라 통째로 안 쓰는 정책은 고르지 않았어요. 사용 기록이 90일 넘게 쌓인 뒤에 다시 확인해 주세요");
    // 초안은 그대로 만든다
    assert!(draft.is_some());

    w.s.users[0].created_at = days_before(90).map(iso);
    let (unused, _, notes) = run(&w, &report);
    assert_eq!(unused.len(), 1);
    assert!(!has_note(&notes, "통째로 안 쓰는 정책은 고르지 않았어요"), "{notes:?}");

    // 언제 만들었는지 모르면 고르지 않는다
    w.s.users[0].created_at = None;
    let (unused, _, notes) = run(&w, &report);
    assert!(unused.is_empty());
    assert!(has_note(&notes, "알 수 없어서 통째로 안 쓰는 정책은 고르지 않았어요"), "{notes:?}");
}

#[test]
fn without_the_report_time_nothing_is_called_stale_or_detachable() {
    let w = ec2_world();
    let report = LastAccessedRaw { completed_at: None, services: vec![svc("s3", None), svc("ec2", days_before(300))] };
    let (unused, draft, notes) = run(&w, &report);
    // 기준 시각이 없으면 주체의 나이도, 마지막 사용이 오래됐는지도 판단하지 않는다
    assert!(unused.is_empty());
    assert!(has_note(&notes, "알 수 없어서 통째로 안 쓰는 정책은 고르지 않았어요"), "{notes:?}");
    assert_eq!(statements(&draft), vec![json!({ "Effect": "Allow", "Action": ["ec2:*"], "Resource": "*" })]);
}

#[test]
fn tracked_actions_last_used_long_ago_are_dropped_like_unused_ones() {
    let w = world(&[("s3-read", json!([allow(json!(["s3:GetObject", "s3:GetBucketAcl", "s3:GetBucketPolicy"]), "*")]))], &[]);
    let mut s3 = svc("s3", used());
    s3.actions = Some(vec![action("GetBucketAcl", days_before(200)), action("GetBucketPolicy", days_before(10))]);
    let (_, draft, notes) = run(&w, &raw(vec![s3]));
    // 기록에 없는 GetObject는 남고, 200일 전에 쓴 GetBucketAcl은 빠진다
    assert_eq!(action_list(&statements(&draft)[0]), vec!["s3:GetBucketPolicy", "s3:GetObject"]);
    assert!(has_note(&notes, "S3: 작업 단위 기록에서 최근에 안 쓴 것으로 나온 작업만 뺐어요"), "{notes:?}");
}
