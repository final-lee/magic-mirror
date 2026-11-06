use super::*;
use std::collections::HashMap;
use crate::sns::{evidence::Evidence, model::{SnsSubscription, SnsSubscriptionRow, SnsTarget, SnsTopic, TopicOverview}};

const TOPIC: &str = "arn:aws:sns:ap-northeast-2:123456789012:orders";
const QUEUE: &str = "arn:aws:sqs:ap-northeast-2:123456789012:q";
fn request() -> SnsChangeRequest { SnsChangeRequest::QueuePolicy { topic_arn: TOPIC.into(), queue_url: "https://queue".into(), queue_arn: QUEUE.into() } }
fn fixture() -> SnsTopic {
    let row = SnsSubscriptionRow { arn: Some(format!("{TOPIC}:sub")), topic_arn: TOPIC.into(), protocol: "sqs".into(), endpoint: QUEUE.into(), state: "confirmed".into() };
    let mut sub = SnsSubscription::from_row(row, HashMap::new(), None);
    sub.target = Some(SnsTarget::Sqs { arn: QUEUE.into(), url: "https://queue".into(), fifo: false, kms_key: None, policy: None, redrive_policy: None, error: None });
    SnsTopic { arn: TOPIC.into(), name: "orders".into(), region: "ap-northeast-2".into(), account: "123456789012".into(), fifo: false, attributes: HashMap::new(), overview: TopicOverview::from_attributes(&HashMap::new()), subscriptions: vec![sub], tags: HashMap::new(), data_protection_policy: None, errors: vec![] }
}
#[test]
fn policy_plan_preserves_other_statements_and_projects_diagnosis() {
    let original = json!({"Version":"2012-10-17","Statement":[{"Sid":"other","Effect":"Allow","Principal":"*","Action":"sqs:GetQueueAttributes","Resource":QUEUE}]}).to_string();
    let next = policy::add_statement(Some(&original), QUEUE, queue_statement(TOPIC, QUEUE, "https://queue")).unwrap();
    assert!(allowed(Some(&next), TOPIC, QUEUE, "123456789012"));
    let impact = projected_impact(&fixture(), &Evidence::default(), &request(), &[field("queuePolicy", None, Some(&next), true)], None);
    assert!(impact.iter().any(|i| i.check == "queuePolicy" && i.before == "fail" && i.after == "ok"));
    let removed = policy::remove_statement(&next, &sid(TOPIC)).unwrap().unwrap();
    let parsed: Value = serde_json::from_str(&removed).unwrap();
    assert_eq!(parsed["Statement"].as_array().unwrap().len(), 1);
    assert_eq!(parsed["Statement"][0]["Sid"], "other");
}
#[test]
fn fingerprints_and_preview_mismatch_prevent_apply() {
    let req = request();
    let plan = SnsPlan { request: req, topic_arn: TOPIC.into(), calls: vec![], fields: vec![], impact: vec![], warnings: vec![], confirm: None, fingerprint: fingerprint(&json!({"policy":null})), undo_of: None };
    let mut fresh = plan.clone();
    assert!(is_current(&plan, &fresh));
    fresh.fingerprint = fingerprint(&json!({"policy":"changed"}));
    assert!(!is_current(&plan, &fresh));
    assert_eq!(serde_json::to_value(AppError::StalePlan).unwrap()["kind"], "stalePlan");
}
#[test]
fn redact_nested_policy_and_messages() {
    let mut v = json!({"calls":[{"body":{"Policy":json!({"Email":"alice@example.com","Phone":"+821012341234"}).to_string(),"Message":"secret"}}]});
    redact(&mut v);
    let text = v.to_string();
    assert!(!text.contains("alice@example.com")); assert!(!text.contains("+821012341234")); assert!(!text.contains("secret"));
    assert!(text.contains("a***@example.com"));
}
#[test]
fn undo_derives_previous_redrive_and_checks_ownership() {
    let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("changes.jsonl");
    let record = SnsChangeRecord { id: "1".into(), at: "now".into(), profile: "personal".into(), region: "ap-northeast-2".into(), topic_arn: TOPIC.into(), request: SnsChangeRequest::AddDlq { subscription_arn: format!("{TOPIC}:sub"), dlq_arn: QUEUE.into() }, calls: vec![call("sns:SetSubscriptionAttributes", "sub", json!({"RedrivePolicy":"new"}))], before: json!({"redrivePolicy":"old"}), after: json!({"redrivePolicy":"new"}), undo_of: None, undone: false };
    crate::jsonl::append(&path, &record).unwrap();
    let found = undo_record(&path, "personal", "ap-northeast-2", "1").unwrap();
    assert_eq!(prior(&found, "redrivePolicy").as_deref(), Some("old"));
    assert!(undo_record(&path, "other", "ap-northeast-2", "1").is_err());
    assert!(undo_record(&path, "personal", "us-east-1", "1").is_err());
}
