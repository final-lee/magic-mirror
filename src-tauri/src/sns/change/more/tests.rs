use super::*;

const ACCOUNT: &str = "123456789012";
const TOPIC: &str = "arn:aws:sns:ap-northeast-2:123456789012:orders";
const SUB: &str = "arn:aws:sns:ap-northeast-2:123456789012:orders:aaaa";
const QUEUE: &str = "arn:aws:sqs:ap-northeast-2:123456789012:q";

fn text(v: &Value) -> String {
    v.to_string()
}
fn attribute(name: &str, data_type: &str, value: &str) -> PublishAttribute {
    PublishAttribute {
        name: name.into(),
        data_type: data_type.into(),
        value: value.into(),
    }
}
fn record_of(
    request: SnsChangeRequest,
    calls: Vec<SnsCall>,
    before: Value,
    after: Value,
) -> SnsChangeRecord {
    SnsChangeRecord {
        id: "1".into(),
        at: "now".into(),
        profile: "personal".into(),
        region: "ap-northeast-2".into(),
        topic_arn: TOPIC.into(),
        request,
        calls,
        before,
        after,
        undo_of: None,
        undone: false,
        undo_blocked: None,
    }
}
fn plan_of(request: SnsChangeRequest, calls: Vec<SnsCall>, fields: Vec<SnsFieldChange>) -> SnsPlan {
    SnsPlan {
        request,
        topic_arn: TOPIC.into(),
        calls,
        fields,
        impact: vec![],
        warnings: vec![],
        confirm: None,
        fingerprint: "f".into(),
        undo_of: None,
    }
}

#[test]
fn endpoints_are_checked_per_protocol() {
    assert_eq!(endpoint_problem("sqs", QUEUE), None);
    assert!(endpoint_problem(
        "sqs",
        "arn:aws:lambda:ap-northeast-2:123456789012:function:f"
    )
    .is_some());
    assert_eq!(
        endpoint_problem(
            "lambda",
            "arn:aws:lambda:ap-northeast-2:123456789012:function:f"
        ),
        None
    );
    assert!(endpoint_problem("lambda", QUEUE).is_some());
    assert_eq!(endpoint_problem("https", "https://example.com/hook"), None);
    assert!(endpoint_problem("https", "http://example.com").is_some());
    assert!(endpoint_problem("http", "https://example.com").is_some());
    assert_eq!(endpoint_problem("email", "ops@example.com"), None);
    assert!(endpoint_problem("email", "not an email").is_some());
    assert!(endpoint_problem("sms", "+8210").is_some());
    assert!(endpoint_problem("sqs", " ").is_some());
}

#[test]
fn filter_change_validates_orders_calls_and_removes_with_an_empty_object() {
    let ((calls, fields), _) = (
        filter_parts(
            SUB,
            (None, "MessageAttributes"),
            (Some(r#"{"event":["created"]}"#), "MessageAttributes"),
        )
        .unwrap(),
        (),
    );
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].body,
        json!({"FilterPolicy": r#"{"event":["created"]}"#})
    );
    assert_eq!(fields.len(), 1);
    assert!(fields[0].diff.as_deref().unwrap().contains("+  \"event\""));
    // 범위를 본문으로 옮길 때는 범위가 먼저, 속성으로 돌아올 때는 정책이 먼저
    let (to_body, _) = filter_parts(
        SUB,
        (Some(r#"{"a":["1"]}"#), "MessageAttributes"),
        (Some(r#"{"d":{"s":["1"]}}"#), "MessageBody"),
    )
    .unwrap();
    assert!(
        to_body[0].body.get("FilterPolicyScope").is_some()
            && to_body[1].body.get("FilterPolicy").is_some()
    );
    let (to_attributes, _) = filter_parts(
        SUB,
        (Some(r#"{"d":{"s":["1"]}}"#), "MessageBody"),
        (Some(r#"{"a":["1"]}"#), "MessageAttributes"),
    )
    .unwrap();
    assert!(
        to_attributes[0].body.get("FilterPolicy").is_some()
            && to_attributes[1].body.get("FilterPolicyScope").is_some()
    );
    let (removed, fields) = filter_parts(
        SUB,
        (Some(r#"{"a":["1"]}"#), "MessageAttributes"),
        (None, "MessageAttributes"),
    )
    .unwrap();
    assert_eq!(removed[0].body, json!({"FilterPolicy": "{}"}));
    assert_eq!(fields[0].after, Value::Null);
    // 서식만 다른 같은 정책은 호출하지 않는다
    let (same, _) = filter_parts(
        SUB,
        (Some(r#"{"a": ["1"]}"#), "MessageAttributes"),
        (Some(r#"{"a":["1"]}"#), "MessageAttributes"),
    )
    .unwrap();
    assert!(same.is_empty());
}

#[test]
fn invalid_filter_policies_are_rejected_before_any_call() {
    assert!(filter_parts(
        SUB,
        (None, "MessageAttributes"),
        (Some("{bad"), "MessageAttributes")
    )
    .is_err());
    assert!(filter_parts(
        SUB,
        (None, "MessageAttributes"),
        (Some(r#"{"a":[]}"#), "MessageAttributes")
    )
    .is_err());
    assert!(filter_parts(
        SUB,
        (None, "MessageAttributes"),
        (Some(r#"{"a":["1"]}"#), "Other")
    )
    .is_err());
    // 중첩 키는 속성 범위에서는 쓸 수 없다
    assert!(filter_parts(
        SUB,
        (None, "MessageAttributes"),
        (Some(r#"{"a":{"b":["1"]}}"#), "MessageAttributes")
    )
    .is_err());
}

#[test]
fn raw_delivery_is_for_sqs_and_http_only_and_noop_when_equal() {
    let (calls, fields) = raw_parts(SUB, "sqs", false, true).unwrap();
    assert_eq!(calls[0].body, json!({"RawMessageDelivery": "true"}));
    assert_eq!(
        (fields[0].before.as_str(), fields[0].after.as_str()),
        (Some("false"), Some("true"))
    );
    assert!(raw_parts(SUB, "sqs", true, true).unwrap().0.is_empty());
    assert!(raw_parts(SUB, "lambda", false, true).is_err());
    assert!(raw_parts(SUB, "email", false, true).is_err());
}

#[test]
fn delivery_policy_must_be_an_object_and_is_removed_with_an_empty_object() {
    let (calls, fields) = delivery_parts(
        "sns:SetSubscriptionAttributes",
        SUB,
        None,
        Some(r#"{"healthyRetryPolicy":{"numRetries":5}}"#),
    )
    .unwrap();
    assert_eq!(calls[0].api, "sns:SetSubscriptionAttributes");
    assert!(calls[0].body.get("DeliveryPolicy").is_some());
    assert!(fields[0].diff.is_some());
    assert!(delivery_parts("sns:SetTopicAttributes", TOPIC, None, Some("[1]")).is_err());
    assert!(delivery_parts("sns:SetTopicAttributes", TOPIC, None, Some("{bad")).is_err());
    let (removed, _) = delivery_parts(
        "sns:SetTopicAttributes",
        TOPIC,
        Some(r#"{"http":{}}"#),
        None,
    )
    .unwrap();
    assert_eq!(removed[0].body, json!({"DeliveryPolicy": "{}"}));
    assert!(delivery_parts(
        "sns:SetTopicAttributes",
        TOPIC,
        Some(r#"{"http":{}}"#),
        Some(r#"{ "http": {} }"#)
    )
    .unwrap()
    .0
    .is_empty());
}

fn default_policy() -> String {
    json!({"Version":"2008-10-17","Statement":[{"Sid":"default","Effect":"Allow","Principal":{"AWS":"*"},"Action":["SNS:Publish","SNS:Subscribe"],"Resource":TOPIC,"Condition":{"StringEquals":{"AWS:SourceOwner":ACCOUNT}}}]}).to_string()
}
fn public_policy() -> String {
    json!({"Version":"2012-10-17","Statement":[{"Sid":"open","Effect":"Allow","Principal":"*","Action":"sns:Subscribe","Resource":TOPIC}]}).to_string()
}

#[test]
fn widening_policies_are_detected_but_narrowing_and_service_statements_are_not() {
    assert!(widened(Some(&default_policy()), &public_policy(), ACCOUNT)
        .iter()
        .any(|s| s.contains("모든 주체")));
    let cross = json!({"Version":"2012-10-17","Statement":[{"Sid":"x","Effect":"Allow","Principal":{"AWS":"arn:aws:iam::999999999999:root"},"Action":"sns:Publish","Resource":TOPIC}]}).to_string();
    assert_eq!(widened(None, &cross, ACCOUNT).len(), 1);
    assert!(widened(Some(&public_policy()), &default_policy(), ACCOUNT).is_empty());
    assert!(widened(Some(&public_policy()), &public_policy(), ACCOUNT).is_empty());
    let service = json!({"Version":"2012-10-17","Statement":[{"Sid":"s","Effect":"Allow","Principal":{"Service":"events.amazonaws.com"},"Action":"sns:Publish","Resource":TOPIC}]}).to_string();
    assert!(widened(Some(&default_policy()), &service, ACCOUNT).is_empty());
}

#[test]
fn topic_policy_change_carries_a_line_diff_and_the_widening_list() {
    let ((calls, fields), wide) =
        topic_policy_parts(TOPIC, Some(&default_policy()), &public_policy(), ACCOUNT).unwrap();
    assert_eq!(calls[0].api, "sns:SetTopicAttributes");
    assert_eq!(calls[0].target, TOPIC);
    assert!(fields[0]
        .diff
        .as_deref()
        .unwrap()
        .lines()
        .any(|l| l.starts_with('+') && l.contains("open")));
    assert_eq!(wide.len(), 1);
    let ((none, _), wide) =
        topic_policy_parts(TOPIC, Some(&default_policy()), &default_policy(), ACCOUNT).unwrap();
    assert!(none.is_empty() && wide.is_empty());
    assert!(topic_policy_parts(TOPIC, None, "{bad", ACCOUNT).is_err());
    assert!(topic_policy_parts(
        TOPIC,
        None,
        r#"{"Version":"2012-10-17","Statement":[]}"#,
        ACCOUNT
    )
    .is_err());
}

#[test]
fn topic_policy_undo_only_when_unchanged_since() {
    let saved = public_policy();
    let record = record_of(
        SnsChangeRequest::TopicPolicy {
            topic_arn: TOPIC.into(),
            policy: saved.clone(),
        },
        vec![call(
            "sns:SetTopicAttributes",
            TOPIC,
            json!({"Policy": saved}),
        )],
        json!({"topicPolicy": default_policy()}),
        json!({"topicPolicy": saved}),
    );
    // 서식이 달라도 같은 문서면 되돌린다
    assert_eq!(
        policy_undo_target(
            &record,
            Some(
                &serde_json::to_string_pretty(&serde_json::from_str::<Value>(&saved).unwrap())
                    .unwrap()
            )
        )
        .unwrap(),
        default_policy()
    );
    assert!(policy_undo_target(&record, Some(&default_policy())).is_err());
    assert!(policy_undo_target(&record, None).is_err());
}

#[test]
fn a_foreign_source_owner_grant_counts_as_widening() {
    let foreign = json!({"Version":"2012-10-17","Statement":[{"Sid":"f","Effect":"Allow","Principal":{"AWS":"*"},"Action":"sns:Subscribe","Resource":TOPIC,"Condition":{"StringEquals":{"AWS:SourceOwner":"999999999999"}}}]}).to_string();
    assert_eq!(widened(Some(&default_policy()), &foreign, ACCOUNT).len(), 1);
    let ((calls, _), wide) =
        topic_policy_parts(TOPIC, Some(&default_policy()), &foreign, ACCOUNT).unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(wide.len(), 1);
    assert!(needs_name(
        "orders",
        &SnsChangeRequest::TopicPolicy {
            topic_arn: TOPIC.into(),
            policy: foreign
        },
        false,
        !wide.is_empty()
    ));
}

#[test]
fn logging_changes_only_what_differs_and_removes_with_empty_values() {
    let attrs: HashMap<String, String> = [
        (
            "SQSSuccessFeedbackRoleArn",
            "arn:aws:iam::123456789012:role/ok",
        ),
        ("SQSSuccessFeedbackSampleRate", "25"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    let ((calls, fields), warnings) = logging_parts(
        TOPIC,
        "SQS",
        &attrs,
        Some("arn:aws:iam::123456789012:role/ok"),
        Some("arn:aws:iam::123456789012:role/fail"),
        25,
    )
    .unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].body,
        json!({"SQSFailureFeedbackRoleArn": "arn:aws:iam::123456789012:role/fail"})
    );
    assert_eq!(fields[0].field, "SQSFailureFeedbackRoleArn");
    assert!(warnings.is_empty());
    let ((off, _), warnings) = logging_parts(TOPIC, "SQS", &attrs, None, None, 0).unwrap();
    assert_eq!(
        off.iter().map(|c| text(&c.body)).collect::<Vec<_>>(),
        vec![
            r#"{"SQSSuccessFeedbackRoleArn":""}"#,
            r#"{"SQSSuccessFeedbackSampleRate":"0"}"#
        ]
    );
    assert!(warnings.is_empty());
    let ((_, _), warnings) = logging_parts(
        TOPIC,
        "HTTP",
        &HashMap::new(),
        Some("arn:aws:iam::123456789012:role/ok"),
        None,
        0,
    )
    .unwrap();
    assert_eq!(warnings.len(), 1);
    assert!(logging_parts(TOPIC, "SMS", &attrs, None, None, 0).is_err());
    assert!(logging_parts(TOPIC, "SQS", &attrs, None, None, 101).is_err());
}

#[test]
fn logging_undo_restores_each_recorded_attribute() {
    let calls = vec![
        call(
            "sns:SetTopicAttributes",
            TOPIC,
            json!({"SQSSuccessFeedbackRoleArn": "arn:new"}),
        ),
        call(
            "sns:SetTopicAttributes",
            TOPIC,
            json!({"SQSSuccessFeedbackSampleRate": "50"}),
        ),
    ];
    let record = record_of(
        SnsChangeRequest::DeliveryLogging {
            topic_arn: TOPIC.into(),
            protocol: "SQS".into(),
            success_role_arn: Some("arn:new".into()),
            failure_role_arn: None,
            sample_rate: 50,
        },
        calls,
        json!({"SQSSuccessFeedbackRoleArn": null, "SQSSuccessFeedbackSampleRate": "10"}),
        json!({}),
    );
    let current: HashMap<String, String> = [
        ("SQSSuccessFeedbackRoleArn", "arn:new"),
        ("SQSSuccessFeedbackSampleRate", "50"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    let (undo, fields) = restore_topic_attributes(&record, TOPIC, &current);
    assert_eq!(
        undo.iter().map(|c| text(&c.body)).collect::<Vec<_>>(),
        vec![
            r#"{"SQSSuccessFeedbackRoleArn":""}"#,
            r#"{"SQSSuccessFeedbackSampleRate":"10"}"#
        ]
    );
    assert_eq!(fields.len(), 2);
}

#[test]
fn publish_follows_fifo_rules_and_attribute_rules() {
    fn ok<'a>(
        attributes: &'a [PublishAttribute],
        group: Option<&'a str>,
        dedup: Option<&'a str>,
    ) -> PublishInput<'a> {
        PublishInput {
            message: "{\"a\":1}",
            subject: None,
            json_structure: false,
            attributes,
            group_id: group,
            dedup_id: dedup,
        }
    }
    assert!(publish_parts(TOPIC, false, false, &ok(&[], None, None)).is_ok());
    assert!(publish_parts(TOPIC, false, false, &ok(&[], Some("g"), None)).is_err());
    assert!(publish_parts(TOPIC, true, false, &ok(&[], None, None)).is_err());
    assert!(publish_parts(TOPIC, true, false, &ok(&[], Some("g"), None)).is_err());
    assert!(publish_parts(TOPIC, true, false, &ok(&[], Some("g"), Some("d"))).is_ok());
    assert!(publish_parts(TOPIC, true, true, &ok(&[], Some("g"), None)).is_ok());
    let attrs = [
        attribute("event", "String", "created"),
        attribute("n", "Number", "3.5"),
        attribute("tags", "String.Array", r#"["a","b"]"#),
    ];
    let (calls, fields) = publish_parts(TOPIC, false, false, &ok(&attrs, None, None)).unwrap();
    assert_eq!(calls[0].api, "sns:Publish");
    assert_eq!(
        calls[0].body["MessageAttributes"]["n"],
        json!({"DataType":"Number","StringValue":"3.5"})
    );
    assert_eq!(
        fields[0].after["attributeNames"],
        json!(["event", "n", "tags"])
    );
    assert_eq!(fields[0].after["size"], 7);
    for bad in [
        attribute("n", "Number", "abc"),
        attribute("t", "String.Array", "x"),
        attribute("AWS.x", "String", "v"),
        attribute("a..b", "String", "v"),
        attribute("e", "String", ""),
        attribute("b", "Binary", "x"),
    ] {
        assert!(publish_parts(TOPIC, false, false, &ok(&[bad], None, None)).is_err());
    }
    assert!(publish_parts(
        TOPIC,
        false,
        false,
        &ok(
            &[attribute("a", "String", "1"), attribute("a", "String", "2")],
            None,
            None
        )
    )
    .is_err());
}

#[test]
fn publish_message_structure_and_subject_are_validated() {
    let mut input = PublishInput {
        message: r#"{"default":"hi","email":"hello"}"#,
        subject: Some("Hello"),
        json_structure: true,
        attributes: &[],
        group_id: None,
        dedup_id: None,
    };
    let (calls, _) = publish_parts(TOPIC, false, false, &input).unwrap();
    assert_eq!(calls[0].body["MessageStructure"], "json");
    assert_eq!(calls[0].body["Subject"], "Hello");
    input.message = r#"{"email":"hello"}"#;
    assert!(publish_parts(TOPIC, false, false, &input).is_err());
    input.message = "plain";
    assert!(publish_parts(TOPIC, false, false, &input).is_err());
    input.json_structure = false;
    input.subject = Some("한글 제목");
    assert!(publish_parts(TOPIC, false, false, &input).is_err());
    input.subject = None;
    input.message = "";
    assert!(publish_parts(TOPIC, false, false, &input).is_err());
}

#[test]
fn publish_record_keeps_message_id_size_attribute_names_and_digest_only() {
    let attrs = vec![attribute("event", "String", "secret-attribute-value")];
    let request = SnsChangeRequest::Publish {
        topic_arn: TOPIC.into(),
        message: "very secret body".into(),
        subject: Some("secret subject".into()),
        message_structure_json: false,
        attributes: attrs.clone(),
        message_group_id: Some("g1".into()),
        deduplication_id: None,
    };
    let input = PublishInput {
        message: "very secret body",
        subject: Some("secret subject"),
        json_structure: false,
        attributes: &attrs,
        group_id: Some("g1"),
        dedup_id: None,
    };
    let (calls, fields) = publish_parts(TOPIC, true, true, &input).unwrap();
    let plan = plan_of(request, calls.clone(), fields);
    let safe = record(
        "1",
        "now",
        "personal",
        "ap-northeast-2",
        &plan,
        &calls,
        &[json!({"messageId": "m-123", "sequenceNumber": null})],
    )
    .unwrap();
    let written = safe.to_string();
    for secret in [
        "very secret body",
        "secret subject",
        "secret-attribute-value",
    ] {
        assert!(!written.contains(secret), "{secret} leaked: {written}");
    }
    assert_eq!(safe["after"]["messageId"], "m-123");
    assert_eq!(safe["after"]["publish"]["size"], 16);
    assert_eq!(safe["after"]["publish"]["attributeNames"], json!(["event"]));
    assert_eq!(
        safe["after"]["publish"]["bodySha256"],
        format!("{:x}", Sha256::digest(b"very secret body"))
    );
    assert_eq!(safe["calls"][0]["body"]["MessageSize"], 16);
    assert_eq!(safe["calls"][0]["body"]["AttributeNames"], json!(["event"]));
    assert_eq!(safe["calls"][0]["body"]["MessageGroupId"], "g1");
    // 줄이 다시 읽혀야 변경 기록 화면이 보여 줄 수 있다
    let back: SnsChangeRecord = serde_json::from_value(safe).unwrap();
    assert!(
        matches!(back.request, SnsChangeRequest::Publish { ref message, .. } if message == MASKED)
    );
}

#[test]
fn subscribe_record_stores_the_arn_and_a_digest_but_never_the_email() {
    let request = SnsChangeRequest::Subscribe {
        topic_arn: TOPIC.into(),
        protocol: "email".into(),
        endpoint: "alice@example.com".into(),
        filter_policy: None,
        filter_policy_scope: None,
        raw_message_delivery: false,
        dlq_arn: None,
    };
    let attributes = BTreeMap::new();
    let calls = vec![subscribe_call(
        TOPIC,
        "email",
        "alice@example.com",
        &attributes,
    )];
    let fields = vec![SnsFieldChange {
        field: "subscription".into(),
        before: Value::Null,
        after: json!({"protocol": "email", "endpoint": masked_endpoint("email", "alice@example.com"), "attributes": attributes}),
        diff: None,
    }];
    let plan = plan_of(request, calls.clone(), fields);
    let safe = record(
        "1",
        "now",
        "personal",
        "ap-northeast-2",
        &plan,
        &calls,
        &[json!({"subscriptionArn": "arn:aws:sns:ap-northeast-2:123456789012:orders:uuid"})],
    )
    .unwrap();
    assert!(!safe.to_string().contains("alice@example.com"));
    assert!(safe.to_string().contains("a***@example.com"));
    assert_eq!(
        safe["after"]["subscriptionArn"],
        "arn:aws:sns:ap-northeast-2:123456789012:orders:uuid"
    );
    assert_eq!(
        safe["after"]["endpointDigest"],
        endpoint_digest("email", "alice@example.com")
    );
    assert_ne!(
        endpoint_digest("email", "alice@example.com"),
        endpoint_digest("email-json", "alice@example.com")
    );
}

#[test]
fn unsubscribe_record_keeps_restorable_attributes_untouched() {
    let attrs: HashMap<String, String> = [
        ("FilterPolicy", r#"{"owner":["alice"]}"#),
        ("RawMessageDelivery", "true"),
        (
            "RedrivePolicy",
            r#"{"deadLetterTargetArn":"arn:aws:sqs:ap-northeast-2:123456789012:dlq"}"#,
        ),
        ("TopicArn", TOPIC),
        ("Owner", ACCOUNT),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    let saved = saved_attributes(&attrs);
    assert_eq!(
        saved.keys().map(String::as_str).collect::<Vec<_>>(),
        vec!["FilterPolicy", "RawMessageDelivery", "RedrivePolicy"]
    );
    let field = SnsFieldChange {
        field: "subscription".into(),
        before: json!({"protocol": "sqs", "endpoint": QUEUE, "attributes": saved, "reconfirm": false}),
        after: Value::Null,
        diff: None,
    };
    let calls = vec![call("sns:Unsubscribe", SUB, json!({}))];
    let plan = plan_of(
        SnsChangeRequest::Unsubscribe {
            subscription_arn: SUB.into(),
        },
        calls.clone(),
        vec![field],
    );
    let safe = record(
        "1",
        "now",
        "personal",
        "ap-northeast-2",
        &plan,
        &calls,
        &[Value::Null],
    )
    .unwrap();
    assert_eq!(safe["undoBlocked"], Value::Null);
    let back: SnsChangeRecord = serde_json::from_value(safe).unwrap();
    let ((resubscribe, fields), protocol, endpoint, warnings) =
        resubscribe_parts(&back.before, TOPIC).unwrap();
    assert_eq!((protocol.as_str(), endpoint.as_str()), ("sqs", QUEUE));
    assert_eq!(resubscribe[0].api, "sns:Subscribe");
    assert_eq!(
        resubscribe[0].body["Attributes"]["FilterPolicy"],
        r#"{"owner":["alice"]}"#
    );
    assert_eq!(
        resubscribe[0].body["Attributes"]["RawMessageDelivery"],
        "true"
    );
    assert!(warnings.is_empty());
    assert_eq!(fields[0].field, "subscription");
}

#[test]
fn records_with_personal_data_store_masked_values_and_block_undo() {
    // 해지: 저장해 둔 다시 구독 속성의 필터에 이메일·전화번호가 있다
    let attrs: HashMap<String, String> = [(
        "FilterPolicy",
        r#"{"owner":["alice@example.com"],"phone":["+821012341234"]}"#,
    )]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    let field = SnsFieldChange {
        field: "subscription".into(),
        before: json!({"protocol": "sqs", "endpoint": QUEUE, "attributes": saved_attributes(&attrs), "reconfirm": false}),
        after: Value::Null,
        diff: None,
    };
    let calls = vec![call("sns:Unsubscribe", SUB, json!({}))];
    let plan = plan_of(
        SnsChangeRequest::Unsubscribe {
            subscription_arn: SUB.into(),
        },
        calls.clone(),
        vec![field],
    );
    let safe = record(
        "1",
        "now",
        "personal",
        "ap-northeast-2",
        &plan,
        &calls,
        &[Value::Null],
    )
    .unwrap();
    let written = safe.to_string();
    assert!(
        !written.contains("alice@example.com") && !written.contains("+821012341234"),
        "{written}"
    );
    assert!(written.contains("a***@example.com"));
    assert_eq!(
        safe["undoBlocked"],
        "개인정보가 들어 있어 되돌릴 값을 저장하지 않았어요"
    );

    // 필터 정책 변경: 이전·이후 값
    let (calls, fields) = filter_parts(
        SUB,
        (
            Some(r#"{"owner":["alice@example.com"]}"#),
            "MessageAttributes",
        ),
        (Some(r#"{"owner":["bob"]}"#), "MessageAttributes"),
    )
    .unwrap();
    let plan = plan_of(
        SnsChangeRequest::FilterPolicy {
            subscription_arn: SUB.into(),
            filter_policy: Some(r#"{"owner":["bob"]}"#.into()),
            scope: "MessageAttributes".into(),
        },
        calls.clone(),
        fields,
    );
    let safe = record(
        "2",
        "now",
        "personal",
        "ap-northeast-2",
        &plan,
        &calls,
        &vec![Value::Null; calls.len()],
    )
    .unwrap();
    assert!(!safe.to_string().contains("alice@example.com"));
    assert!(safe["undoBlocked"].is_string());

    // 주제 정책 저장
    let policy_with_email = json!({"Version":"2012-10-17","Statement":[{"Sid":"s","Effect":"Allow","Principal":{"AWS":"*"},"Action":"sns:Publish","Resource":TOPIC,"Condition":{"StringEquals":{"AWS:SourceOwner":ACCOUNT,"aws:PrincipalTag/owner":"carol@example.com"}}}]}).to_string();
    let ((calls, fields), _) =
        topic_policy_parts(TOPIC, Some(&public_policy()), &policy_with_email, ACCOUNT).unwrap();
    let plan = plan_of(
        SnsChangeRequest::TopicPolicy {
            topic_arn: TOPIC.into(),
            policy: policy_with_email,
        },
        calls.clone(),
        fields,
    );
    let safe = record(
        "3",
        "now",
        "personal",
        "ap-northeast-2",
        &plan,
        &calls,
        &[Value::Null],
    )
    .unwrap();
    assert!(!safe.to_string().contains("carol@example.com"), "{safe}");
    assert!(safe["undoBlocked"].is_string());

    // 개인 정보가 없는 필터는 그대로 남고 되돌릴 수 있다
    let (calls, fields) = filter_parts(
        SUB,
        (Some(r#"{"owner":["alice"]}"#), "MessageAttributes"),
        (Some(r#"{"owner":["bob"]}"#), "MessageAttributes"),
    )
    .unwrap();
    let plan = plan_of(
        SnsChangeRequest::FilterPolicy {
            subscription_arn: SUB.into(),
            filter_policy: Some(r#"{"owner":["bob"]}"#.into()),
            scope: "MessageAttributes".into(),
        },
        calls.clone(),
        fields,
    );
    let safe = record(
        "4",
        "now",
        "personal",
        "ap-northeast-2",
        &plan,
        &calls,
        &vec![Value::Null; calls.len()],
    )
    .unwrap();
    assert_eq!(safe["undoBlocked"], Value::Null);
    assert_eq!(safe["before"]["filterPolicy"], r#"{"owner":["alice"]}"#);
}

fn subscription(arn: Option<&str>, protocol: &str, endpoint: &str) -> SnsSubscription {
    let row = crate::sns::model::SnsSubscriptionRow {
        arn: arn.map(str::to_owned),
        topic_arn: TOPIC.into(),
        protocol: protocol.into(),
        endpoint: endpoint.into(),
        state: if arn.is_some() {
            "confirmed"
        } else {
            "pending"
        }
        .into(),
    };
    SnsSubscription::from_row(row, HashMap::new(), None)
}
fn subscribe_record(
    subscribe_ran: bool,
    protocol: &str,
    endpoint: &str,
    arn: &str,
) -> SnsChangeRecord {
    let request = SnsChangeRequest::Subscribe {
        topic_arn: TOPIC.into(),
        protocol: protocol.into(),
        endpoint: endpoint.into(),
        filter_policy: None,
        filter_policy_scope: None,
        raw_message_delivery: false,
        dlq_arn: None,
    };
    let mut calls = vec![call(
        "sqs:SetQueueAttributes",
        "https://queue",
        json!({"Policy": "{}"}),
    )];
    let mut after = json!({});
    if subscribe_ran {
        calls.push(subscribe_call(TOPIC, protocol, endpoint, &BTreeMap::new()));
        after =
            json!({"subscriptionArn": arn, "endpointDigest": endpoint_digest(protocol, endpoint)});
    }
    record_of(request, calls, json!({"queuePolicy": null}), after)
}

#[test]
fn subscribe_undo_only_targets_the_recorded_arn_never_a_replacement_with_the_same_endpoint() {
    let record = subscribe_record(true, "sqs", QUEUE, SUB);
    // 원래 구독이 해지된 뒤 같은 엔드포인트로 새로 만든 구독은 건드리지 않는다
    let replacement = subscription(
        Some("arn:aws:sns:ap-northeast-2:123456789012:orders:bbbb"),
        "sqs",
        QUEUE,
    );
    assert!(matches!(
        subscription_to_undo(&record, std::slice::from_ref(&replacement)),
        SubscriptionUndo::Gone
    ));
    // 기록한 ARN이 있으면 그것만 해지한다
    let original = subscription(Some(SUB), "sqs", QUEUE);
    assert!(
        matches!(subscription_to_undo(&record, &[replacement.clone(), original]), SubscriptionUndo::Unsubscribe(s) if s.arn.as_deref() == Some(SUB))
    );
    // 확인 대기 중인 구독은 확인된 뒤에
    let email = subscribe_record(true, "email", "alice@example.com", SUB);
    assert!(matches!(
        subscription_to_undo(&email, &[subscription(None, "email", "alice@example.com")]),
        SubscriptionUndo::Pending
    ));
}

#[test]
fn subscribe_undo_does_not_need_a_subscription_when_subscribe_never_ran() {
    // 큐 정책은 썼는데 Subscribe가 실패한 기록: 구독 없이도 정리를 이어 가야 한다
    let record = subscribe_record(false, "sqs", QUEUE, SUB);
    assert!(matches!(
        subscription_to_undo(&record, &[subscription(Some(SUB), "sqs", QUEUE)]),
        SubscriptionUndo::Gone
    ));
    assert!(matches!(
        subscription_to_undo(&record, &[]),
        SubscriptionUndo::Gone
    ));
    // 해지는 됐고 정리만 남은 기록도 구독이 없어서 막히지 않는다
    let done = subscribe_record(true, "sqs", QUEUE, SUB);
    assert!(matches!(
        subscription_to_undo(&done, &[]),
        SubscriptionUndo::Gone
    ));
}

#[test]
fn unsubscribe_undo_needs_reconfirmation_for_http_and_is_impossible_for_email() {
    let before = |protocol: &str, endpoint: &str| json!({"subscription": {"protocol": protocol, "endpoint": endpoint, "attributes": {}, "reconfirm": true}});
    let (_, _, _, warnings) =
        resubscribe_parts(&before("https", "https://example.com/hook"), TOPIC).unwrap();
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("확인 대기"));
    assert!(resubscribe_parts(&before("email", "a***@example.com"), TOPIC).is_err());
    assert!(resubscribe_parts(&json!({}), TOPIC).is_err());
}

#[test]
fn applied_fields_follow_the_calls_that_ran() {
    let queue_call = call(
        "sqs:SetQueueAttributes",
        "https://q",
        json!({"Policy": "p"}),
    );
    let dlq = field("dlqPolicy", None, Some("p"), true);
    assert!(applied(&dlq, &[queue_call.clone()]));
    assert!(!applied(
        &dlq,
        &[call(
            "sqs:SetQueueAttributes",
            "https://q",
            json!({"Policy": "other"})
        )]
    ));
    let filter = field("filterPolicy", None, Some("{}"), true);
    assert!(applied(
        &filter,
        &[call(
            "sns:SetSubscriptionAttributes",
            SUB,
            json!({"FilterPolicy": "{}"})
        )]
    ));
    assert!(!applied(
        &filter,
        &[call(
            "sns:SetSubscriptionAttributes",
            SUB,
            json!({"FilterPolicyScope": "MessageBody"})
        )]
    ));
    assert!(applied(
        &field("topicPolicy", None, Some("{}"), true),
        &[call(
            "sns:SetTopicAttributes",
            TOPIC,
            json!({"Policy": "{}"})
        )]
    ));
    assert!(applied(
        &field("SQSSuccessFeedbackRoleArn", None, Some("r"), false),
        &[call(
            "sns:SetTopicAttributes",
            TOPIC,
            json!({"SQSSuccessFeedbackRoleArn": "r"})
        )]
    ));
    assert!(applied(
        &field("replayPolicy", None, Some("{}"), false),
        &[call(
            "sns:SetSubscriptionAttributes",
            SUB,
            json!({"ReplayPolicy": "{}"})
        )]
    ));
    assert!(!applied(
        &field("subscription", None, None, false),
        &[queue_call]
    ));
}

#[test]
fn only_the_listed_changes_name_the_topic_in_prod() {
    let publish = SnsChangeRequest::Publish {
        topic_arn: TOPIC.into(),
        message: "m".into(),
        subject: None,
        message_structure_json: false,
        attributes: vec![],
        message_group_id: None,
        deduplication_id: None,
    };
    let raw = SnsChangeRequest::RawDelivery {
        subscription_arn: SUB.into(),
        enabled: true,
    };
    let old = SnsChangeRequest::QueuePolicy {
        topic_arn: TOPIC.into(),
        queue_url: "https://q".into(),
        queue_arn: QUEUE.into(),
    };
    assert!(needs_name(
        "orders-prod",
        &SnsChangeRequest::Unsubscribe {
            subscription_arn: SUB.into()
        },
        true,
        false
    ));
    assert!(!needs_name(
        "orders",
        &SnsChangeRequest::Unsubscribe {
            subscription_arn: SUB.into()
        },
        true,
        false
    ));
    assert!(!needs_name("orders-prod", &raw, false, false));
    assert!(!needs_name("orders-prod", &publish, false, false));
    assert!(needs_name("orders-prod", &old, false, false));
    // 정책을 넓히면 이름에 prod가 없어도 입력한다
    assert!(needs_name(
        "orders",
        &SnsChangeRequest::TopicPolicy {
            topic_arn: TOPIC.into(),
            policy: "{}".into()
        },
        true,
        true
    ));
    assert!(handles(&SnsChangeRequest::DeliveryLogging {
        topic_arn: TOPIC.into(),
        protocol: "SQS".into(),
        success_role_arn: None,
        failure_role_arn: None,
        sample_rate: 0
    }));
    assert!(!handles(&SnsChangeRequest::Undo { id: "1".into() }));
    assert!(!handles(&SnsChangeRequest::AddDlq {
        subscription_arn: SUB.into(),
        dlq_arn: QUEUE.into()
    }));
}

#[test]
fn projection_applies_the_filter_and_the_unsubscribe() {
    use crate::sns::model::SnsSubscriptionRow;
    let row = SnsSubscriptionRow {
        arn: Some(SUB.into()),
        topic_arn: TOPIC.into(),
        protocol: "sqs".into(),
        endpoint: QUEUE.into(),
        state: "confirmed".into(),
    };
    let sub = SnsSubscription::from_row(
        row,
        [("FilterPolicy".to_owned(), r#"{"a":["1"]}"#.to_owned())]
            .into_iter()
            .collect(),
        None,
    );
    let mut topic = SnsTopic {
        arn: TOPIC.into(),
        name: "orders".into(),
        region: "ap-northeast-2".into(),
        account: ACCOUNT.into(),
        fifo: false,
        attributes: HashMap::new(),
        overview: crate::sns::model::TopicOverview::from_attributes(&HashMap::new()),
        subscriptions: vec![sub],
        tags: HashMap::new(),
        data_protection_policy: None,
        errors: vec![],
    };
    let request = SnsChangeRequest::FilterPolicy {
        subscription_arn: SUB.into(),
        filter_policy: None,
        scope: "MessageAttributes".into(),
    };
    project(
        &mut topic,
        &request,
        &[field("filterPolicy", Some(r#"{"a":["1"]}"#), None, true)],
    );
    assert!(!topic.subscriptions[0]
        .attributes
        .contains_key("FilterPolicy"));
    assert!(topic.subscriptions[0].filter.is_none());
    project(
        &mut topic,
        &SnsChangeRequest::Unsubscribe {
            subscription_arn: SUB.into(),
        },
        &[],
    );
    assert!(topic.subscriptions.is_empty());
}

#[test]
fn subscribe_attributes_and_saved_attributes() {
    let map = subscribe_attributes(Some(r#"{"a":["1"]}"#), "MessageBody", true, Some("arn:dlq"));
    assert_eq!(map["FilterPolicyScope"], "MessageBody");
    assert_eq!(map["RawMessageDelivery"], "true");
    assert_eq!(map["RedrivePolicy"], r#"{"deadLetterTargetArn":"arn:dlq"}"#);
    assert!(subscribe_attributes(None, "MessageBody", false, None).is_empty());
    let saved = saved_attributes(
        &[("RawMessageDelivery", "false"), ("Owner", ACCOUNT)]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect(),
    );
    assert!(saved.is_empty());
}

#[test]
fn pending_protocols_get_a_notice_and_queues_do_not() {
    for protocol in ["email", "email-json", "http", "https"] {
        assert!(pending_notice(protocol).unwrap().contains("확인 대기"));
    }
    assert!(pending_notice("sqs").is_none());
    assert!(pending_notice("lambda").is_none());
}
