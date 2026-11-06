use super::*;
use crate::sqs::SqsCall;
use std::collections::BTreeMap;

fn record(id: &str, profile: &str, region: &str, ok: bool) -> SqsChangeRecord {
    SqsChangeRecord {
        id: id.into(),
        at: "2026-11-06T01:02:03Z".into(),
        profile: profile.into(),
        region: region.into(),
        queue_url: "https://sqs.ap-northeast-2.amazonaws.com/111111111111/orders".into(),
        queue_name: "orders".into(),
        kind: "purge".into(),
        summary: "`orders` 비우기".into(),
        calls: vec![SqsCall { api: "sqs:PurgeQueue".into(), params: BTreeMap::from([("QueueUrl".to_string(), "u".to_string())]) }],
        ok,
        error: (!ok).then(|| "실패".to_string()),
        count: Some(3),
    }
}

#[test]
fn records_come_back_oldest_first_and_filtered_by_profile_and_region() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sqs-changes.jsonl");
    append(&path, &record("1", "personal", "ap-northeast-2", true)).unwrap();
    append(&path, &record("2", "other", "ap-northeast-2", true)).unwrap();
    append(&path, &record("3", "personal", "us-east-1", true)).unwrap();
    append(&path, &record("4", "personal", "ap-northeast-2", false)).unwrap();
    let got = read(&path, "personal", "ap-northeast-2");
    assert_eq!(got.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["1", "4"]);
    assert_eq!(got[1].error.as_deref(), Some("실패"));
    assert_eq!(read(&dir.path().join("none.jsonl"), "personal", "ap-northeast-2"), vec![]);
}

#[test]
fn a_record_serializes_in_the_contract_shape_and_holds_no_message_body() {
    let value = serde_json::to_value(record("1", "personal", "r", true)).unwrap();
    let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["at", "calls", "count", "error", "id", "kind", "ok", "profile", "queueName", "queueUrl", "region", "summary"]);
    assert_eq!(value["calls"][0], serde_json::json!({ "api": "sqs:PurgeQueue", "params": { "QueueUrl": "u" } }));
}
