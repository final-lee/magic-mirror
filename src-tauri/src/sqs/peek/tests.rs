use super::*;
use aws_sdk_sqs::primitives::Blob;
use aws_sdk_sqs::types::MessageAttributeValue;

fn queue(dlq: bool) -> SqsQueue {
    let mut q = SqsQueue::fixture(if dlq { "orders-dlq" } else { "orders" });
    q.is_dlq = dlq;
    q
}

#[test]
fn a_dlq_is_peekable_unless_an_enabled_lambda_consumes_it() {
    let q = queue(true);
    assert_eq!(peekable(&q, false, false, None), Ok(()), "metrics don't matter for a DLQ");
    assert_eq!(peekable(&q, false, true, Some(50.0)), Ok(()), "a pipe doesn't block a DLQ");
    assert!(peekable(&q, true, false, Some(0.0)).unwrap_err().contains("Lambda"));
}

#[test]
fn a_consumed_queue_is_blocked_by_any_visible_consumer() {
    let q = queue(false);
    assert_eq!(peekable(&q, true, false, Some(0.0)).unwrap_err(), CONSUMER_BLOCKED);
    assert_eq!(peekable(&q, false, true, Some(0.0)).unwrap_err(), CONSUMER_BLOCKED);
}

#[test]
fn an_unconsumed_queue_needs_a_zero_receive_metric() {
    let q = queue(false);
    assert_eq!(peekable(&q, false, false, Some(0.0)), Ok(()));
    let busy = peekable(&q, false, false, Some(12.0)).unwrap_err();
    assert!(busy.contains("12개") && busy.contains(CONSUMER_BLOCKED));
    assert_eq!(peekable(&q, false, false, None).unwrap_err(), "최근 수신 지표를 읽지 못해 소비자가 없는지 알 수 없어요");
}

#[test]
fn consumer_wins_over_a_missing_metric_in_the_reason() {
    assert_eq!(peekable(&queue(false), true, false, None).unwrap_err(), CONSUMER_BLOCKED);
}

#[test]
fn only_stopped_mappings_and_pipes_do_not_count_as_consumers() {
    for active in ["Enabled", "Enabling", "Updating", "Creating", "Resuming"] {
        assert!(esm_active(active), "{active}");
    }
    for idle in ["Disabled", "Disabling", "Deleting", "disabled"] {
        assert!(!esm_active(idle), "{idle}");
    }
    for running in ["RUNNING", "STARTING", "CREATING", "UPDATING"] {
        assert!(pipe_active(running), "{running}");
    }
    for idle in ["STOPPED", "STOPPING", "DELETING", "CREATE_FAILED", ""] {
        assert!(!pipe_active(idle), "{idle}");
    }
}

#[test]
fn receive_requests_are_range_checked() {
    assert!(validate(1, 10).is_ok());
    assert!(validate(500, 600).is_ok());
    assert!(validate(0, 60).is_err());
    assert!(validate(501, 60).is_err());
    assert!(validate(50, 9).is_err());
    assert!(validate(50, 601).is_err());
}

fn held(id: &str, group: Option<&str>, source: Option<&str>) -> Held {
    let mut attributes = HashMap::new();
    if let Some(g) = group {
        attributes.insert("MessageGroupId".to_string(), g.to_string());
    }
    if let Some(s) = source {
        attributes.insert("DeadLetterQueueSourceArn".to_string(), s.to_string());
    }
    Held { receipt: format!("receipt-{id}"), message: SqsMessage { message_id: id.into(), body: format!("body-{id}"), md5: String::new(), attributes, message_attributes: vec![], size: 0 } }
}

fn store_with(expires_at: i64) -> PeekStore {
    let store = PeekStore::default();
    let held: HashMap<String, Held> = [held("m1", Some("g1"), Some("arn:src")), held("m2", None, None)].into_iter().map(|h| (h.message.message_id.clone(), h)).collect();
    store.insert("p1".into(), Peek { profile: "personal".into(), region: "r".into(), url: "u".into(), expires_at, held }, 0);
    store
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn a_live_session_shows_only_the_requested_messages() {
    let store = store_with(1000);
    let SessionFacts::Live { messages } = store.facts("p1", "personal", "r", "u", &ids(&["m1", "nope"]), 500) else { panic!("live") };
    assert_eq!(messages.len(), 1);
    assert_eq!(messages["m1"], HeldFacts { body: "body-m1".into(), group_id: Some("g1".into()), source_arn: Some("arn:src".into()) });
}

#[test]
fn a_session_is_missing_for_another_profile_region_queue_or_id() {
    let store = store_with(1000);
    for (id, profile, region, url) in [("p9", "personal", "r", "u"), ("p1", "other", "r", "u"), ("p1", "personal", "x", "u"), ("p1", "personal", "r", "other-queue")] {
        assert_eq!(store.facts(id, profile, region, url, &[], 500), SessionFacts::Missing, "{id} {profile} {region} {url}");
    }
}

#[test]
fn a_session_expires_exactly_at_its_deadline() {
    let store = store_with(1000);
    assert!(matches!(store.facts("p1", "personal", "r", "u", &[], 999), SessionFacts::Live { .. }));
    assert_eq!(store.facts("p1", "personal", "r", "u", &[], 1000), SessionFacts::Expired);
}

#[test]
fn sweep_and_insert_drop_expired_sessions() {
    let store = store_with(1000);
    store.sweep(999);
    assert!(matches!(store.facts("p1", "personal", "r", "u", &[], 0), SessionFacts::Live { .. }));
    store.sweep(1000);
    assert_eq!(store.facts("p1", "personal", "r", "u", &[], 0), SessionFacts::Missing);

    let store = store_with(1000);
    store.insert("p2".into(), Peek { profile: "personal".into(), region: "r".into(), url: "u".into(), expires_at: 5000, held: HashMap::new() }, 2000);
    assert_eq!(store.facts("p1", "personal", "r", "u", &[], 0), SessionFacts::Missing, "the expired one went away on insert");
}

#[test]
fn held_returns_receipts_in_the_requested_order_and_none_if_any_is_gone() {
    let store = store_with(1000);
    let got = store.held("p1", &ids(&["m2", "m1"])).unwrap();
    assert_eq!(got.iter().map(|h| h.receipt.as_str()).collect::<Vec<_>>(), vec!["receipt-m2", "receipt-m1"]);
    assert!(store.held("p1", &ids(&["m1", "gone"])).is_none());
    assert!(store.held("nope", &ids(&["m1"])).is_none());
}

#[test]
fn forgetting_removes_only_the_handled_messages() {
    let store = store_with(1000);
    store.forget("p1", &ids(&["m1"]));
    assert!(store.held("p1", &ids(&["m1"])).is_none());
    assert!(store.held("p1", &ids(&["m2"])).is_some());
}

#[test]
fn take_only_hands_out_the_callers_own_session() {
    let store = store_with(1000);
    assert!(store.take("p1", "other").is_none());
    assert!(store.facts("p1", "personal", "r", "u", &[], 0) != SessionFacts::Missing, "still there");
    assert_eq!(store.take("p1", "personal").unwrap().held.len(), 2);
    assert!(store.take("p1", "personal").is_none());
}

#[test]
fn sdk_messages_become_held_messages_with_sorted_attributes_and_base64_binaries() {
    let message = Message::builder()
        .message_id("m-1")
        .receipt_handle("rh-1")
        .body("héllo")
        .md5_of_body("abc")
        .attributes(MessageSystemAttributeName::SentTimestamp, "1700000000000")
        .attributes(MessageSystemAttributeName::ApproximateReceiveCount, "3")
        .message_attributes("z-text", MessageAttributeValue::builder().data_type("String").string_value("v").build().unwrap())
        .message_attributes("a-bin", MessageAttributeValue::builder().data_type("Binary").binary_value(Blob::new(vec![0, 1, 2])).build().unwrap())
        .build();
    let h = held_of(&message).unwrap();
    assert_eq!(h.receipt, "rh-1");
    assert_eq!(h.message.message_id, "m-1");
    assert_eq!(h.message.size, 6, "bytes, not characters");
    assert_eq!(h.message.attributes["SentTimestamp"], "1700000000000");
    assert_eq!(h.message.attributes["ApproximateReceiveCount"], "3");
    let attrs: Vec<(&str, &str, &str)> = h.message.message_attributes.iter().map(|a| (a.name.as_str(), a.data_type.as_str(), a.value.as_str())).collect();
    assert_eq!(attrs, vec![("a-bin", "Binary", "AAEC"), ("z-text", "String", "v")]);
}

#[test]
fn a_response_without_an_id_or_receipt_is_skipped() {
    assert!(held_of(&Message::builder().body("x").build()).is_none());
    assert!(held_of(&Message::builder().message_id("m").build()).is_none());
}
