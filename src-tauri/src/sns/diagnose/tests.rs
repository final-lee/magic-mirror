use super::*;
use crate::sns::{
    evidence::{KeyEvidence, QueueEvidence},
    model::{SnsSubscriptionRow, TopicOverview},
};
use serde_json::json;
use std::collections::HashMap;

const TOPIC: &str = "arn:aws:sns:ap-northeast-2:123456789012:orders";
const QUEUE: &str = "arn:aws:sqs:ap-northeast-2:123456789012:q";
fn fixture(protocol: &str) -> SnsTopic {
    let row = SnsSubscriptionRow {
        arn: Some(format!("{TOPIC}:sub")),
        topic_arn: TOPIC.into(),
        protocol: protocol.into(),
        endpoint: QUEUE.into(),
        state: "confirmed".into(),
    };
    SnsTopic {
        arn: TOPIC.into(),
        name: "orders".into(),
        region: "ap-northeast-2".into(),
        account: "123456789012".into(),
        fifo: false,
        attributes: HashMap::new(),
        overview: TopicOverview::from_attributes(&HashMap::new()),
        subscriptions: vec![SnsSubscription::from_row(row, HashMap::new(), None)],
        tags: HashMap::new(),
        data_protection_policy: None,
        errors: vec![],
    }
}
fn target(policy: Option<String>, kms: Option<&str>) -> SnsTarget {
    SnsTarget::Sqs {
        arn: QUEUE.into(),
        url: "https://queue".into(),
        fifo: false,
        kms_key: kms.map(str::to_owned),
        policy,
        redrive_policy: None,
        error: None,
    }
}
fn queue_policy(source: &str, principal: serde_json::Value) -> String {
    json!({"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":principal,"Action":"sqs:SendMessage","Resource":QUEUE,"Condition":{"ArnEquals":{"aws:SourceArn":source}}}]}).to_string()
}
fn status<'a>(r: &'a SnsDiagnosisReport, id: &str) -> &'a str {
    &r.subscriptions[0]
        .checks
        .iter()
        .find(|c| c.id == id)
        .unwrap()
        .status
}
#[test]
fn queue_policy_source_and_legacy_wildcard() {
    let mut t = fixture("sqs");
    let e = Evidence::default();
    t.subscriptions[0].target = Some(target(None, None));
    assert_eq!(status(&diagnose(&t, &e, &[]), "queuePolicy"), "fail");
    t.subscriptions[0].target = Some(target(
        Some(queue_policy(
            "arn:other",
            json!({"Service":"sns.amazonaws.com"}),
        )),
        None,
    ));
    assert_eq!(status(&diagnose(&t, &e, &[]), "queuePolicy"), "fail");
    t.subscriptions[0].target = Some(target(Some(queue_policy(TOPIC, json!("*"))), None));
    assert_eq!(status(&diagnose(&t, &e, &[]), "queuePolicy"), "ok");
}
#[test]
fn kms_and_lambda_missing_grants() {
    let mut t = fixture("sqs");
    let mut e = Evidence::default();
    e.keys.insert(
        "key".into(),
        KeyEvidence {
            arn: "key".into(),
            managed: false,
            state: "Enabled".into(),
            policy: Some(json!({"Version":"2012-10-17","Statement":[]}).to_string()),
            error: None,
        },
    );
    t.subscriptions[0].target = Some(target(
        Some(queue_policy(TOPIC, json!({"Service":"sns.amazonaws.com"}))),
        Some("key"),
    ));
    assert_eq!(status(&diagnose(&t, &e, &[]), "queueKms"), "fail");
    e.keys.insert(
        "alias/aws/sqs".into(),
        KeyEvidence {
            arn: "key".into(),
            managed: true,
            state: "Enabled".into(),
            policy: None,
            error: None,
        },
    );
    t.subscriptions[0].target = Some(target(None, Some("alias/aws/sqs")));
    assert_eq!(status(&diagnose(&t, &e, &[]), "queueKms"), "fail");
    let mut t = fixture("lambda");
    t.subscriptions[0].target = Some(SnsTarget::Lambda {
        arn: "function".into(),
        policy: None,
        error: None,
    });
    assert_eq!(status(&diagnose(&t, &e, &[]), "lambdaPolicy"), "fail");
}
#[test]
fn failures_filter_transport_and_verdict_order() {
    let mut t = fixture("http");
    let mut e = Evidence::default();
    t.subscriptions[0].state = "pending".into();
    t.subscriptions[0]
        .attributes
        .insert("FilterPolicy".into(), "not-json".into());
    e.metrics.insert("NumberOfNotificationsFailed".into(), 3.0);
    let r = diagnose(&t, &e, &[]);
    assert_eq!(status(&r, "confirmed"), "fail");
    assert_eq!(status(&r, "transport"), "warn");
    assert_eq!(status(&r, "filter"), "fail");
    assert_eq!(status(&r, "recentFailures"), "warn");
    assert_eq!(
        r.subscriptions[0].verdict,
        r.subscriptions[0].checks[0].summary
    );
}
#[test]
fn dlq_checks_and_topic_managed_key() {
    let mut t = fixture("https");
    let mut e = Evidence::default();
    t.subscriptions[0].dlq_arn = Some(QUEUE.into());
    e.queues.insert(
        QUEUE.into(),
        QueueEvidence {
            arn: QUEUE.into(),
            url: "url".into(),
            policy: Some(queue_policy(TOPIC, json!({"Service":"sns.amazonaws.com"}))),
            kms_key: None,
            error: None,
        },
    );
    t.overview.kms_key = Some("alias/aws/sns".into());
    e.keys.insert(
        "alias/aws/sns".into(),
        KeyEvidence {
            arn: "key".into(),
            managed: true,
            state: "Enabled".into(),
            policy: None,
            error: None,
        },
    );
    let p = Publisher {
        kind: "alarm".into(),
        name: "alarm".into(),
        arn: None,
        principal: Some("cloudwatch.amazonaws.com".into()),
        configured: true,
    };
    let r = diagnose(&t, &e, &[p]);
    assert_eq!(status(&r, "dlq"), "ok");
    assert_eq!(r.topic_checks[0].status, "fail");
}

#[test]
fn unknown_policy_read_errors_and_missing_endpoint() {
    let mut t = fixture("sqs");
    let e = Evidence::default();
    let unknown = json!({"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"sns.amazonaws.com"},"Action":"sqs:SendMessage","Resource":QUEUE,"Condition":{"Bool":{"aws:SecureTransport":"true"}}}]}).to_string();
    t.subscriptions[0].target = Some(target(Some(unknown), None));
    assert_eq!(status(&diagnose(&t, &e, &[]), "queuePolicy"), "warn");
    t.subscriptions[0].target = Some(SnsTarget::Sqs {
        arn: QUEUE.into(),
        url: String::new(),
        fifo: false,
        kms_key: None,
        policy: None,
        redrive_policy: None,
        error: Some(crate::error::AppError::other("QueueDoesNotExist")),
    });
    assert_eq!(status(&diagnose(&t, &e, &[]), "endpoint"), "fail");
    t.subscriptions[0].target = Some(SnsTarget::Sqs {
        arn: QUEUE.into(),
        url: String::new(),
        fifo: false,
        kms_key: None,
        policy: None,
        redrive_policy: None,
        error: Some(crate::error::AppError::AccessDenied {
            action: "sqs:GetQueueUrl".into(),
        }),
    });
    assert_eq!(status(&diagnose(&t, &e, &[]), "endpoint"), "skip");
}

#[test]
fn email_confirmation_and_logging_failure() {
    let mut t = fixture("email");
    t.subscriptions[0].state = "pending".into();
    let mut e = Evidence::default();
    e.metrics.insert("NumberOfNotificationsFailed".into(), 1.0);
    e.logs_missing = true;
    let r = diagnose(&t, &e, &[]);
    let c = &r.subscriptions[0].checks[0];
    assert_eq!(c.status, "fail");
    assert!(c.detail.as_ref().unwrap().contains("3일"));
    assert_eq!(r.topic_checks[0].id, "deliveryLogging");
    assert_eq!(r.topic_checks[0].status, "warn");
}

#[test]
fn valid_filter_and_topic_metrics_report_uncertainty() {
    let mut t = fixture("https");
    t.subscriptions[0]
        .attributes
        .insert("FilterPolicy".into(), r#"{"event":["order"]}"#.into());
    let mut e = Evidence::default();
    assert_eq!(status(&diagnose(&t, &e, &[]), "filter"), "ok");
    assert_eq!(status(&diagnose(&t, &e, &[]), "dlq"), "warn");
    e.metrics.insert(
        "NumberOfNotificationsFilteredOut-InvalidMessageBody".into(),
        2.0,
    );
    assert_eq!(status(&diagnose(&t, &e, &[]), "filter"), "warn");
    e.metric_error = Some(crate::error::AppError::AccessDenied {
        action: "cloudwatch:GetMetricData".into(),
    });
    let r = diagnose(&t, &e, &[]);
    assert_eq!(status(&r, "filter"), "skip");
    assert_eq!(status(&r, "recentFailures"), "skip");
    assert_eq!(r.metrics.filtered_invalid_body, None);
}

#[test]
fn customer_topic_key_requires_each_service_grant() {
    let mut t = fixture("email");
    t.overview.kms_key = Some("key".into());
    let mut e = Evidence::default();
    e.keys.insert(
        "key".into(),
        KeyEvidence {
            arn: "key".into(),
            managed: false,
            state: "Enabled".into(),
            policy: Some(json!({"Version":"2012-10-17","Statement":[]}).to_string()),
            error: None,
        },
    );
    let p = Publisher {
        kind: "alarm".into(),
        name: "alarm".into(),
        arn: None,
        principal: Some("cloudwatch.amazonaws.com".into()),
        configured: true,
    };
    let r = diagnose(&t, &e, &[p]);
    assert_eq!(r.topic_checks[0].status, "fail");
    assert!(matches!(
        r.topic_checks[0].fix.as_ref(),
        Some(SnsFix::KmsStatement { .. })
    ));
}

#[test]
fn dlq_failure_and_recent_log_details() {
    let mut t = fixture("https");
    t.subscriptions[0].dlq_arn = Some(QUEUE.into());
    let mut e = Evidence::default();
    e.queues.insert(
        QUEUE.into(),
        QueueEvidence {
            arn: QUEUE.into(),
            url: "url".into(),
            policy: None,
            kms_key: None,
            error: None,
        },
    );
    e.metrics.insert("NumberOfNotificationsFailed".into(), 2.0);
    e.failures.push(DeliveryFailure {
        destination: QUEUE.into(),
        status_code: Some("403".into()),
        response: Some("거부됨".into()),
        timestamp: None,
        attempts: Some(2),
    });
    let r = diagnose(&t, &e, &[]);
    assert_eq!(status(&r, "dlq"), "fail");
    let c = r.subscriptions[0]
        .checks
        .iter()
        .find(|c| c.id == "recentFailures")
        .unwrap();
    assert_eq!(c.status, "warn");
    assert!(c.detail.as_ref().unwrap().contains("403 거부됨 · 시도 2"));
    assert_eq!(
        r.subscriptions[0].verdict,
        r.subscriptions[0]
            .checks
            .iter()
            .find(|c| c.id == "dlq")
            .unwrap()
            .summary
    );
}

#[test]
fn disabled_topic_key_is_failure_without_publishers() {
    let mut t = fixture("email");
    t.overview.kms_key = Some("key".into());
    let mut e = Evidence::default();
    e.keys.insert(
        "key".into(),
        KeyEvidence {
            arn: "key".into(),
            managed: false,
            state: "PendingDeletion".into(),
            policy: None,
            error: None,
        },
    );
    assert_eq!(diagnose(&t, &e, &[]).topic_checks[0].status, "fail");
}
