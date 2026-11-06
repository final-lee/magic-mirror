use super::*;
use crate::error::AppError;
use crate::sns::policy;
use serde_json::json;

const OWN: &str = "431847470565";
const REGION: &str = "ap-northeast-2";
const TOPIC: &str = "arn:aws:sns:ap-northeast-2:431847470565:orders";
const QUEUE: &str = "arn:aws:sqs:ap-northeast-2:431847470565:orders-q";
const FUNCTION: &str = "arn:aws:lambda:ap-northeast-2:431847470565:function:handler";

fn statements(list: Vec<serde_json::Value>) -> Vec<StatementView> {
    policy::describe(
        &json!({"Version": "2012-10-17", "Statement": list}).to_string(),
        OWN,
    )
    .unwrap()
}

/// 모든 점검이 조용한 주제(암호화, 서명 2, 로깅 켜짐, 구독 없음)
fn clean() -> TopicFacts {
    TopicFacts {
        arn: TOPIC.into(),
        kms_key: Some("alias/aws/sns".into()),
        signature_version: 2,
        logging_on: true,
        subscriptions: Vec::new(),
    }
}

fn sub(protocol: &str, endpoint: &str) -> SubFacts {
    SubFacts {
        arn: Some(format!("{TOPIC}:id-{endpoint}")),
        protocol: protocol.into(),
        endpoint: endpoint.into(),
        confirmed: true,
        pending: false,
        dlq: Dlq::Present,
    }
}

fn run(facts: &TopicFacts, statements: &[StatementView]) -> Vec<SnsFinding> {
    topic_findings(facts, statements, None, OWN, REGION, &Existence::default())
}

fn ids(findings: &[SnsFinding]) -> Vec<&str> {
    findings.iter().map(|f| f.check.as_str()).collect()
}

/// 기본 주제 정책(S0): 이 계정 안의 주체. 공개가 아니다.
fn default_policy() -> serde_json::Value {
    json!({"Sid": "__default_statement_ID", "Effect": "Allow", "Principal": {"AWS": "*"},
        "Action": ["SNS:Subscribe", "SNS:Publish", "SNS:Receive"], "Resource": TOPIC,
        "Condition": {"StringEquals": {"AWS:SourceOwner": OWN}}})
}

#[test]
fn a_clean_topic_with_the_default_policy_has_no_findings() {
    assert!(run(&clean(), &statements(vec![default_policy()])).is_empty());
}

#[test]
fn every_check_has_a_unique_id_and_the_table_levels() {
    let mut seen = HashSet::new();
    assert!(CHECKS.iter().all(|c| seen.insert(c.id)));
    let level = |id: &str| info(id).level;
    assert_eq!(
        [level("publicPolicy"), level("crossAccountAccess")],
        [Level::High; 2]
    );
    assert_eq!(
        [
            level("confusedDeputy"),
            level("unencrypted"),
            level("httpEndpoint")
        ],
        [Level::Medium; 3]
    );
    assert_eq!(
        [
            level("signatureV1"),
            level("pendingConfirmation"),
            level("orphanSubscription"),
            level("noDlq")
        ],
        [Level::Low; 4]
    );
    assert_eq!(level("noDeliveryLogging"), Level::Info);
    assert_eq!(CHECKS.len(), 10);
}

#[test]
fn public_policy_is_principal_star_without_a_restricting_condition() {
    let open = statements(vec![
        json!({"Effect": "Allow", "Principal": "*", "Action": "sns:Publish", "Resource": TOPIC}),
    ]);
    let found = run(&clean(), &open);
    assert_eq!(ids(&found), ["publicPolicy"]);
    assert_eq!(found[0].level, Level::High);
    assert_eq!(found[0].items.len(), 1);
    // AWS 주체 *도 조건이 없으면 공개
    let aws_star = statements(vec![
        json!({"Effect": "Allow", "Principal": {"AWS": "*"}, "Action": "sns:Subscribe", "Resource": TOPIC}),
    ]);
    assert_eq!(ids(&run(&clean(), &aws_star)), ["publicPolicy"]);
    // 출처 조건이 걸리면 공개로 보지 않는다
    let guarded = statements(vec![
        json!({"Effect": "Allow", "Principal": "*", "Action": "sns:Publish", "Resource": TOPIC, "Condition": {"ArnLike": {"aws:SourceArn": "arn:aws:s3:::my-bucket"}}}),
    ]);
    assert!(run(&clean(), &guarded).is_empty());
    // Deny는 공개가 아니다
    let deny = statements(vec![
        json!({"Effect": "Deny", "Principal": "*", "Action": "sns:Publish", "Resource": TOPIC}),
    ]);
    assert!(run(&clean(), &deny).is_empty());
}

#[test]
fn analyzer_fail_makes_it_public_even_when_the_statements_look_fine() {
    let policy = statements(vec![default_policy()]);
    let pass = PublicAccess {
        fail: false,
        message: None,
        reasons: Vec::new(),
    };
    assert!(topic_findings(
        &clean(),
        &policy,
        Some(&pass),
        OWN,
        REGION,
        &Existence::default()
    )
    .is_empty());
    let fail = PublicAccess {
        fail: true,
        message: Some("공개 접근이 가능해요".into()),
        reasons: vec!["문장 0".into()],
    };
    let found = topic_findings(
        &clean(),
        &policy,
        Some(&fail),
        OWN,
        REGION,
        &Existence::default(),
    );
    assert_eq!(ids(&found), ["publicPolicy"]);
    assert_eq!(found[0].detail.as_deref(), Some("공개 접근이 가능해요"));
    assert_eq!(found[0].items, ["문장 0"]);
    // 따로 받은 결과로 만든 점검 결과도 같은 id
    assert_eq!(
        public_access_finding(TOPIC, &fail).unwrap().check,
        "publicPolicy"
    );
    assert!(public_access_finding(TOPIC, &pass).is_none());
}

#[test]
fn another_account_that_can_subscribe_or_receive_is_flagged() {
    let subscribe = statements(vec![
        json!({"Effect": "Allow", "Principal": {"AWS": "arn:aws:iam::676499404107:root"}, "Action": "SNS:Subscribe", "Resource": TOPIC}),
    ]);
    assert_eq!(ids(&run(&clean(), &subscribe)), ["crossAccountAccess"]);
    let wildcard = statements(vec![
        json!({"Effect": "Allow", "Principal": {"AWS": "676499404107"}, "Action": "sns:*", "Resource": TOPIC}),
    ]);
    assert_eq!(ids(&run(&clean(), &wildcard)), ["crossAccountAccess"]);
    let not_action = statements(vec![
        json!({"Effect": "Allow", "Principal": {"AWS": "676499404107"}, "NotAction": "sns:Publish", "Resource": TOPIC}),
    ]);
    assert_eq!(ids(&run(&clean(), &not_action)), ["crossAccountAccess"]);
    // 발행만 허용하면 이 점검 대상이 아니다
    let publish = statements(vec![
        json!({"Effect": "Allow", "Principal": {"AWS": "676499404107"}, "Action": "sns:Publish", "Resource": TOPIC}),
    ]);
    assert!(run(&clean(), &publish).is_empty());
    // 같은 계정이면 아니다
    let own = statements(vec![
        json!({"Effect": "Allow", "Principal": {"AWS": format!("arn:aws:iam::{OWN}:root")}, "Action": "sns:Subscribe", "Resource": TOPIC}),
    ]);
    assert!(run(&clean(), &own).is_empty());
}

#[test]
fn service_allow_needs_source_account_or_source_arn() {
    let bare = statements(vec![
        json!({"Effect": "Allow", "Principal": {"Service": "events.amazonaws.com"}, "Action": "sns:Publish", "Resource": TOPIC}),
    ]);
    let found = run(&clean(), &bare);
    assert_eq!(ids(&found), ["confusedDeputy"]);
    assert_eq!(found[0].level, Level::Medium);
    for condition in [
        json!({"StringEquals": {"aws:SourceAccount": OWN}}),
        json!({"ArnLike": {"aws:SourceArn": "arn:aws:events:*:431847470565:rule/*"}}),
    ] {
        let guarded = statements(vec![
            json!({"Effect": "Allow", "Principal": {"Service": "events.amazonaws.com"}, "Action": "sns:Publish", "Resource": TOPIC, "Condition": condition}),
        ]);
        assert!(run(&clean(), &guarded).is_empty());
    }
    // 다른 조건 키만으로는 부족하다
    let other = statements(vec![
        json!({"Effect": "Allow", "Principal": {"Service": "events.amazonaws.com"}, "Action": "sns:Publish", "Resource": TOPIC, "Condition": {"StringEquals": {"aws:SourceOwner": OWN}}}),
    ]);
    assert_eq!(ids(&run(&clean(), &other)), ["confusedDeputy"]);
}

#[test]
fn unencrypted_means_no_kms_key() {
    let mut facts = clean();
    facts.kms_key = None;
    assert_eq!(ids(&run(&facts, &[])), ["unencrypted"]);
    facts.kms_key = Some("arn:aws:kms:ap-northeast-2:431847470565:key/abc".into());
    assert!(run(&facts, &[]).is_empty());
}

#[test]
fn http_subscriptions_are_flagged_but_https_is_not() {
    let mut facts = clean();
    facts.subscriptions = vec![sub("https", "https://example.com/hook")];
    assert!(run(&facts, &[]).is_empty());
    facts
        .subscriptions
        .push(sub("http", "http://example.com/hook"));
    let found = run(&facts, &[]);
    assert_eq!(ids(&found), ["httpEndpoint"]);
    assert_eq!(found[0].items, ["http://example.com/hook"]);
}

#[test]
fn signature_version_one_is_low() {
    let mut facts = clean();
    facts.signature_version = 1;
    let found = run(&facts, &[]);
    assert_eq!(
        (ids(&found), found[0].level),
        (vec!["signatureV1"], Level::Low)
    );
}

#[test]
fn pending_subscriptions_are_listed() {
    let mut facts = clean();
    let mut pending = sub("email", "a@example.com");
    pending.arn = None;
    pending.confirmed = false;
    pending.pending = true;
    pending.dlq = Dlq::Unknown;
    facts.subscriptions = vec![pending, sub("email", "b@example.com")];
    let found = run(&facts, &[]);
    assert_eq!(ids(&found), ["pendingConfirmation"]);
    assert_eq!(found[0].items, ["email · a@example.com"]);
}

#[test]
fn orphan_subscriptions_come_from_missing_queues_functions_and_topics() {
    let mut facts = clean();
    facts.subscriptions = vec![
        sub("sqs", QUEUE),
        sub("lambda", FUNCTION),
        sub(
            "lambda",
            "arn:aws:lambda:ap-northeast-2:431847470565:function:alive:live",
        ),
    ];
    let existence = Existence {
        topics: Some(HashSet::from([TOPIC.to_string()])),
        queues: Some(HashSet::from(["other-q".to_string()])),
        functions: Some(HashSet::from(["alive".to_string()])),
    };
    let found = topic_findings(&facts, &[], None, OWN, REGION, &existence);
    assert_eq!(ids(&found), ["orphanSubscription"]);
    assert_eq!(
        found[0].items,
        [format!("sqs · {QUEUE}"), format!("lambda · {FUNCTION}")]
    );
    // 목록을 못 읽었으면(None) 판단하지 않는다
    assert!(run(&facts, &[]).is_empty());
    // 다른 계정·리전의 엔드포인트는 건드리지 않는다
    for endpoint in [
        "arn:aws:sqs:ap-northeast-2:999999999999:q",
        "arn:aws:sqs:us-east-1:431847470565:q",
    ] {
        assert_eq!(
            orphan_reason(TOPIC, "sqs", endpoint, OWN, REGION, &existence),
            None
        );
    }
    // 주제가 목록에 없으면 TopicMissing, 다른 계정 주제는 판정하지 않는다
    let gone = "arn:aws:sns:ap-northeast-2:431847470565:deleted";
    assert_eq!(
        orphan_reason(gone, "email", "a@example.com", OWN, REGION, &existence),
        Some(OrphanReason::TopicMissing)
    );
    assert_eq!(
        orphan_reason(
            "arn:aws:sns:ap-northeast-2:999999999999:theirs",
            "email",
            "a@example.com",
            OWN,
            REGION,
            &existence
        ),
        None
    );
    assert_eq!(
        orphan_reason(TOPIC, "email", "a@example.com", OWN, REGION, &existence),
        None
    );
}

#[test]
fn missing_topics_group_into_one_finding_per_topic() {
    let found = missing_topic_findings(&[
        (
            "arn:aws:sns:ap-northeast-2:431847470565:b".into(),
            "sqs · q1".into(),
        ),
        (
            "arn:aws:sns:ap-northeast-2:431847470565:a".into(),
            "sqs · q2".into(),
        ),
        (
            "arn:aws:sns:ap-northeast-2:431847470565:b".into(),
            "email · x".into(),
        ),
    ]);
    assert_eq!(found.len(), 2);
    assert_eq!(
        (found[0].topic_name.as_str(), found[0].items.len()),
        ("a", 1)
    );
    assert_eq!(
        (found[1].topic_name.as_str(), found[1].items.len()),
        ("b", 2)
    );
    assert!(found
        .iter()
        .all(|f| f.check == "orphanSubscription" && f.level == Level::Low));
}

#[test]
fn missing_dlq_only_counts_confirmed_sqs_and_lambda_with_known_state() {
    let mut facts = clean();
    let mut no_dlq = sub("sqs", QUEUE);
    no_dlq.dlq = Dlq::Missing;
    let mut unknown = sub("lambda", FUNCTION);
    unknown.dlq = Dlq::Unknown;
    let mut email = sub("email", "a@example.com");
    email.dlq = Dlq::Missing;
    facts.subscriptions = vec![no_dlq, unknown, email];
    let found = run(&facts, &[]);
    assert_eq!(ids(&found), ["noDlq"]);
    assert_eq!(found[0].items, [format!("sqs · {QUEUE}")]);
}

#[test]
fn delivery_logging_off_is_info_when_a_loggable_subscription_exists() {
    let mut facts = clean();
    facts.logging_on = false;
    assert!(run(&facts, &[]).is_empty(), "구독이 없으면 조용하다");
    facts.subscriptions = vec![sub("email", "a@example.com")];
    assert!(
        run(&facts, &[]).is_empty(),
        "email은 배달 상태 로깅 대상이 아니다"
    );
    facts.subscriptions = vec![sub("sqs", QUEUE)];
    let found = run(&facts, &[]);
    assert_eq!(
        (ids(&found), found[0].level),
        (vec!["noDeliveryLogging"], Level::Info)
    );
}

#[test]
fn findings_are_sorted_by_level_then_check_order() {
    let mut facts = clean();
    facts.kms_key = None;
    facts.signature_version = 1;
    facts.logging_on = false;
    facts.subscriptions = vec![sub("sqs", QUEUE)];
    let open = statements(vec![
        json!({"Effect": "Allow", "Principal": "*", "Action": "sns:Publish", "Resource": TOPIC}),
    ]);
    let found = run(&facts, &open);
    assert_eq!(
        ids(&found),
        [
            "publicPolicy",
            "unencrypted",
            "signatureV1",
            "noDeliveryLogging"
        ]
    );
}

#[test]
fn facts_come_from_a_topic_snapshot() {
    use std::collections::HashMap;
    let attributes: HashMap<String, String> = [
        ("KmsMasterKeyId", "alias/aws/sns"),
        (
            "SQSFailureFeedbackRoleArn",
            "arn:aws:iam::431847470565:role/r",
        ),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    let overview = crate::sns::model::TopicOverview::from_attributes(&attributes);
    let row = |state: &str, arn: Option<&str>| crate::sns::model::SnsSubscriptionRow {
        arn: arn.map(str::to_owned),
        topic_arn: TOPIC.into(),
        protocol: "sqs".into(),
        endpoint: QUEUE.into(),
        state: state.into(),
    };
    let with_dlq = SnsSubscription::from_row(
        row("confirmed", Some("arn:sub1")),
        [(
            "RedrivePolicy".to_string(),
            r#"{"deadLetterTargetArn":"arn:aws:sqs:ap-northeast-2:431847470565:dlq"}"#.to_string(),
        )]
        .into(),
        None,
    );
    let without =
        SnsSubscription::from_row(row("confirmed", Some("arn:sub2")), HashMap::new(), None);
    let unreadable = SnsSubscription::from_row(
        row("confirmed", Some("arn:sub3")),
        HashMap::new(),
        Some(AppError::Throttled),
    );
    let pending = SnsSubscription::from_row(row("pending", None), HashMap::new(), None);
    let topic = SnsTopic {
        arn: TOPIC.into(),
        name: "orders".into(),
        region: REGION.into(),
        account: OWN.into(),
        fifo: false,
        attributes,
        overview,
        subscriptions: vec![with_dlq, without, unreadable, pending],
        tags: HashMap::new(),
        data_protection_policy: None,
        errors: Vec::new(),
    };
    let facts = TopicFacts::from_topic(&topic);
    assert_eq!(facts.kms_key.as_deref(), Some("alias/aws/sns"));
    assert!(facts.logging_on);
    assert_eq!(facts.signature_version, 1);
    assert_eq!(
        facts
            .subscriptions
            .iter()
            .map(|s| s.dlq)
            .collect::<Vec<_>>(),
        [Dlq::Present, Dlq::Missing, Dlq::Unknown, Dlq::Unknown]
    );
    assert!(facts.subscriptions[3].pending && !facts.subscriptions[3].confirmed);
}

#[test]
fn own_topic_arns_are_checked_against_account_and_region() {
    assert!(is_own_topic(TOPIC, OWN, REGION));
    assert!(!is_own_topic(
        "arn:aws:sns:ap-northeast-2:676499404107:x",
        OWN,
        REGION
    ));
    assert!(!is_own_topic(
        "arn:aws:sns:us-east-1:431847470565:x",
        OWN,
        REGION
    ));
    assert!(!is_own_topic(
        "arn:aws:sqs:ap-northeast-2:431847470565:x",
        OWN,
        REGION
    ));
    assert!(!is_own_topic("not-an-arn", OWN, REGION));
}
