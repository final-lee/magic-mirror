use super::*;
use crate::sns::{
    evidence::Evidence,
    model::{SnsSubscription, SnsSubscriptionRow, SnsTarget, SnsTopic, TopicOverview},
};
use std::collections::HashMap;

const TOPIC: &str = "arn:aws:sns:ap-northeast-2:123456789012:orders";
const QUEUE: &str = "arn:aws:sqs:ap-northeast-2:123456789012:q";
fn request() -> SnsChangeRequest {
    SnsChangeRequest::QueuePolicy {
        topic_arn: TOPIC.into(),
        queue_url: "https://queue".into(),
        queue_arn: QUEUE.into(),
    }
}
fn fixture() -> SnsTopic {
    let row = SnsSubscriptionRow {
        arn: Some(format!("{TOPIC}:sub")),
        topic_arn: TOPIC.into(),
        protocol: "sqs".into(),
        endpoint: QUEUE.into(),
        state: "confirmed".into(),
    };
    let mut sub = SnsSubscription::from_row(row, HashMap::new(), None);
    sub.target = Some(SnsTarget::Sqs {
        arn: QUEUE.into(),
        url: "https://queue".into(),
        fifo: false,
        kms_key: None,
        policy: None,
        redrive_policy: None,
        error: None,
    });
    SnsTopic {
        arn: TOPIC.into(),
        name: "orders".into(),
        region: "ap-northeast-2".into(),
        account: "123456789012".into(),
        fifo: false,
        attributes: HashMap::new(),
        overview: TopicOverview::from_attributes(&HashMap::new()),
        subscriptions: vec![sub],
        tags: HashMap::new(),
        data_protection_policy: None,
        errors: vec![],
    }
}
#[test]
fn policy_plan_preserves_other_statements_and_projects_diagnosis() {
    let original = json!({"Version":"2012-10-17","Statement":[{"Sid":"other","Effect":"Allow","Principal":"*","Action":"sqs:GetQueueAttributes","Resource":QUEUE}]}).to_string();
    let next = policy::add_statement(
        Some(&original),
        QUEUE,
        queue_statement(TOPIC, QUEUE, "https://queue"),
    )
    .unwrap();
    assert!(allowed(Some(&next), TOPIC, QUEUE, "123456789012"));
    let impact = projected_impact(
        &fixture(),
        &Evidence::default(),
        &request(),
        &[field("queuePolicy", None, Some(&next), true)],
        None,
    );
    assert!(impact
        .iter()
        .any(|i| i.check == "queuePolicy" && i.before == "fail" && i.after == "ok"));
    let removed = policy::remove_statement(&next, &sid(TOPIC))
        .unwrap()
        .unwrap();
    let parsed: Value = serde_json::from_str(&removed).unwrap();
    assert_eq!(parsed["Statement"].as_array().unwrap().len(), 1);
    assert_eq!(parsed["Statement"][0]["Sid"], "other");
}
#[test]
fn fingerprints_and_preview_mismatch_prevent_apply() {
    let req = request();
    let plan = SnsPlan {
        request: req,
        topic_arn: TOPIC.into(),
        calls: vec![],
        fields: vec![],
        impact: vec![],
        warnings: vec![],
        confirm: None,
        fingerprint: fingerprint(&json!({"policy":null})),
        undo_of: None,
    };
    let mut fresh = plan.clone();
    assert!(is_current(&plan, &fresh));
    fresh.fingerprint = fingerprint(&json!({"policy":"changed"}));
    assert!(!is_current(&plan, &fresh));
    assert_eq!(
        serde_json::to_value(AppError::StalePlan).unwrap()["kind"],
        "stalePlan"
    );
}
#[test]
fn redact_nested_policy_and_messages() {
    let mut v = json!({"calls":[{"body":{"Policy":json!({"Email":"alice@example.com","Phone":"+821012341234"}).to_string(),"Message":"secret"}}]});
    redact(&mut v);
    let text = v.to_string();
    assert!(!text.contains("alice@example.com"));
    assert!(!text.contains("+821012341234"));
    assert!(!text.contains("secret"));
    assert!(text.contains("a***@example.com"));
}
#[test]
fn undo_derives_previous_redrive_and_checks_ownership() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("changes.jsonl");
    let record = SnsChangeRecord {
        id: "1".into(),
        at: "now".into(),
        profile: "personal".into(),
        region: "ap-northeast-2".into(),
        topic_arn: TOPIC.into(),
        request: SnsChangeRequest::AddDlq {
            subscription_arn: format!("{TOPIC}:sub"),
            dlq_arn: QUEUE.into(),
        },
        calls: vec![call(
            "sns:SetSubscriptionAttributes",
            "sub",
            json!({"RedrivePolicy":"new"}),
        )],
        before: json!({"redrivePolicy":"old"}),
        after: json!({"redrivePolicy":"new"}),
        undo_of: None,
        undone: false,
        undo_blocked: None,
    };
    crate::jsonl::append(&path, &record).unwrap();
    let found = undo_record(&path, "personal", "ap-northeast-2", "1").unwrap();
    assert_eq!(prior(&found, "redrivePolicy").as_deref(), Some("old"));
    assert!(undo_record(&path, "other", "ap-northeast-2", "1").is_err());
    assert!(undo_record(&path, "personal", "us-east-1", "1").is_err());
}

#[test]
fn replay_validates_range_and_builds_payload() {
    let now = chrono::DateTime::parse_from_rfc3339("2026-10-05T00:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let beginning = "2026-10-01T00:00:00Z";
    let start = "2026-10-02T00:00:00Z";
    let end = "2026-10-03T00:00:00Z";
    let payload: Value =
        serde_json::from_str(&replay_policy(start, Some(end), beginning, now).unwrap()).unwrap();
    assert_eq!(
        payload,
        json!({"PointType":"Timestamp","StartingPoint":start,"EndingPoint":end})
    );
    assert!(
        serde_json::from_str::<Value>(&replay_policy(start, None, beginning, now).unwrap())
            .unwrap()
            .get("EndingPoint")
            .is_none()
    );
    assert!(replay_policy("2026-09-30T00:00:00Z", None, beginning, now).is_err());
    assert!(replay_policy(start, Some(start), beginning, now).is_err());
    assert!(replay_policy(start, Some("2026-10-06T00:00:00Z"), beginning, now).is_err());
    assert!(replay_policy("bad", None, beginning, now).is_err());
    assert_eq!(replay_warnings(false).len(), 1);
    assert!(replay_warnings(true)
        .iter()
        .any(|w| w.contains("구독이 멈춰")));
}

#[test]
fn archive_payload_range_and_previous_value() {
    assert_eq!(
        serde_json::from_str::<Value>(&archive_policy(Some(30)).unwrap()).unwrap(),
        json!({"MessageRetentionPeriod":30})
    );
    assert_eq!(archive_policy(None).unwrap(), "{}");
    assert!(archive_policy(Some(0)).is_err());
    assert!(archive_policy(Some(366)).is_err());
    assert!(archive_warnings("{}")[0].contains("삭제"));
    assert!(archive_warnings(&archive_policy(Some(30)).unwrap()).is_empty());
    let record = SnsChangeRecord {
        id: "a".into(),
        at: "now".into(),
        profile: "p".into(),
        region: "r".into(),
        topic_arn: TOPIC.into(),
        request: SnsChangeRequest::ArchivePolicy {
            topic_arn: TOPIC.into(),
            retention_days: None,
        },
        calls: vec![],
        before: json!({"archivePolicy":"{\"MessageRetentionPeriod\":30}"}),
        after: json!({}),
        undo_of: None,
        undone: false,
        undo_blocked: None,
    };
    assert_eq!(
        prior(&record, "archivePolicy").unwrap(),
        "{\"MessageRetentionPeriod\":30}"
    );
}

fn queue_policy_with(statements: Vec<Value>) -> String {
    json!({"Version":"2012-10-17","Statement":statements}).to_string()
}

#[test]
fn queue_policy_undo_restores_the_statement_the_change_replaced() {
    let own = sid(TOPIC);
    let other = json!({"Sid":"other","Effect":"Allow","Principal":"*","Action":"sqs:GetQueueAttributes","Resource":QUEUE});
    let previous_statement = json!({"Sid":own,"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::123456789012:root"},"Action":"sqs:SendMessage","Resource":QUEUE});
    let before = queue_policy_with(vec![previous_statement.clone(), other.clone()]);
    // 변경이 같은 Sid의 문장을 덮어썼다
    let forward = policy::add_statement(
        Some(&before),
        QUEUE,
        queue_statement(TOPIC, QUEUE, "https://queue"),
    )
    .unwrap();
    // 그 사이 다른 문장이 하나 더해졌다
    let current = policy::add_statement(Some(&forward), QUEUE, json!({"Sid":"later","Effect":"Allow","Principal":"*","Action":"sqs:PurgeQueue","Resource":QUEUE})).unwrap();
    let undone = undo_statement(Some(&current), QUEUE, &own, Some(&before))
        .unwrap()
        .unwrap();
    let parsed: Value = serde_json::from_str(&undone).unwrap();
    let statements = parsed["Statement"].as_array().unwrap();
    assert_eq!(statements.len(), 3);
    assert_eq!(
        statements
            .iter()
            .find(|s| s["Sid"] == own.as_str())
            .unwrap(),
        &previous_statement
    );
    assert!(
        statements.iter().any(|s| s["Sid"] == "other")
            && statements.iter().any(|s| s["Sid"] == "later")
    );
    // 덮어쓴 문장이 없었으면 문장만 뺀다
    let plain = queue_policy_with(vec![other]);
    let added = policy::add_statement(
        Some(&plain),
        QUEUE,
        queue_statement(TOPIC, QUEUE, "https://queue"),
    )
    .unwrap();
    let removed: Value = serde_json::from_str(
        &undo_statement(Some(&added), QUEUE, &own, Some(&plain))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(removed["Statement"].as_array().unwrap().len(), 1);
    assert_eq!(
        undo_statement(
            Some(&queue_policy_with(vec![queue_statement(
                TOPIC,
                QUEUE,
                "https://queue"
            )])),
            QUEUE,
            &own,
            None
        )
        .unwrap(),
        None
    );
    assert_eq!(undo_statement(None, QUEUE, &own, None).unwrap(), None);
}

fn subscription(
    arn: &str,
    endpoint: &str,
    dlq: Option<&str>,
) -> super::super::model::SnsSubscription {
    let row = SnsSubscriptionRow {
        arn: Some(arn.into()),
        topic_arn: TOPIC.into(),
        protocol: "sqs".into(),
        endpoint: endpoint.into(),
        state: "confirmed".into(),
    };
    let attributes = dlq
        .map(|d| {
            HashMap::from([(
                "RedrivePolicy".to_owned(),
                json!({"deadLetterTargetArn": d}).to_string(),
            )])
        })
        .unwrap_or_default();
    SnsSubscription::from_row(row, attributes, None)
}

#[test]
fn dlq_users_lists_other_subscriptions_that_still_use_the_queue() {
    let dlq = "arn:aws:sqs:ap-northeast-2:123456789012:dlq";
    let subs = vec![
        subscription("a", QUEUE, Some(dlq)),
        subscription(
            "b",
            "arn:aws:sqs:ap-northeast-2:123456789012:other",
            Some(dlq),
        ),
        subscription("c", dlq, None),
        subscription("d", QUEUE, None),
    ];
    // a를 되돌릴 때 b(같은 DLQ)와 c(그 큐가 엔드포인트)가 남아 있다
    assert_eq!(
        queue_users(&subs, "a", dlq),
        vec!["b".to_owned(), "c".to_owned()]
    );
    assert!(queue_users(&subs[..1], "a", dlq).is_empty());
}

#[test]
fn a_record_blocked_for_personal_data_cannot_be_planned_for_undo() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("changes.jsonl");
    let mut record = SnsChangeRecord {
        id: "1".into(),
        at: "now".into(),
        profile: "personal".into(),
        region: "ap-northeast-2".into(),
        topic_arn: TOPIC.into(),
        request: SnsChangeRequest::FilterPolicy {
            subscription_arn: format!("{TOPIC}:sub"),
            filter_policy: None,
            scope: "MessageAttributes".into(),
        },
        calls: vec![call(
            "sns:SetSubscriptionAttributes",
            "sub",
            json!({"FilterPolicy":"{}"}),
        )],
        before: json!({}),
        after: json!({}),
        undo_of: None,
        undone: false,
        undo_blocked: Some(more::UNDO_BLOCKED_PII.into()),
    };
    crate::jsonl::append(&path, &record).unwrap();
    let err = undo_record(&path, "personal", "ap-northeast-2", "1").unwrap_err();
    assert_eq!(
        err,
        AppError::other("개인정보가 들어 있어 되돌릴 값을 저장하지 않았어요")
    );
    // 필드가 없는 예전 줄은 되돌릴 수 있다
    record.id = "2".into();
    record.undo_blocked = None;
    let mut line = serde_json::to_value(&record).unwrap();
    line.as_object_mut().unwrap().remove("undoBlocked");
    crate::jsonl::append(&path, &line).unwrap();
    assert!(undo_record(&path, "personal", "ap-northeast-2", "2").is_ok());
}

#[test]
fn pii_detection_looks_inside_nested_documents_and_ignores_masked_values() {
    assert!(contains_pii(
        &json!({"filterPolicy": r#"{"owner":["alice@example.com"]}"#})
    ));
    assert!(contains_pii(&json!({"a":[{"b":"+821012341234"}]})));
    assert!(!contains_pii(
        &json!({"endpoint":"a***@example.com","arn":"arn:aws:sqs:r:1:q@x","n":3,"p":"{\"k\":[\"v\"]}"})
    ));
}
