use super::*;
#[test]
fn parses_observed_topic_attributes() {
    let a = [("FifoTopic", "true"), ("ContentBasedDeduplication", "true"), ("ArchivePolicy", "{\"MessageRetentionPeriod\":30}"), ("BeginningArchiveTime", "1700000000"), ("KmsMasterKeyId", "alias/aws/sns"), ("SubscriptionsConfirmed", "3"), ("SubscriptionsPending", "1"), ("SQSSuccessFeedbackSampleRate", "100"), ("EffectiveDeliveryPolicy", "{\"http\":{\"defaultHealthyRetryPolicy\":{\"numRetries\":3}}}")].into_iter().map(|(k,v)| (k.into(),v.into())).collect();
    let o = TopicOverview::from_attributes(&a);
    assert!(o.fifo && o.content_based_deduplication && o.aws_managed_key);
    assert_eq!(o.archive_retention_days, Some(30));
    assert_eq!(o.signature_version, 1);
    assert_eq!((o.confirmed_count, o.pending_count), (3, 1));
    assert_eq!(o.delivery_logging[1].sample_rate, Some(100));
    assert_eq!(o.http_delivery_policy[0].value, "3");
}
#[test]
fn parses_subscription_attributes() {
    let row = SnsSubscriptionRow { arn: Some("arn".into()), topic_arn: "topic".into(), protocol: "sqs".into(), endpoint: "queue".into(), state: "confirmed".into() };
    let attrs = [("FilterPolicy", "{\"event\":[\"created\"]}"), ("FilterPolicyScope", "MessageBody"), ("RawMessageDelivery", "true"), ("RedrivePolicy", "{\"deadLetterTargetArn\":\"dlq\"}")].into_iter().map(|(k,v)| (k.into(),v.into())).collect();
    let sub = SnsSubscription::from_row(row, attrs, None);
    assert!(sub.raw); assert_eq!(sub.dlq_arn.as_deref(), Some("dlq"));
    assert_eq!(sub.filter.unwrap().scope, "MessageBody");
}

#[test]
fn pending_key_is_stable_and_contains_no_endpoint() {
    let row = SnsSubscriptionRow { arn: None, topic_arn: "topic".into(), protocol: "email".into(), endpoint: "alice@example.com".into(), state: "pending".into() };
    let key = row.key();
    assert_eq!(key.len(), "topic#pending#".len() + 12);
    assert!(!key.contains("alice@example.com"));
    assert_eq!(SnsSubscription::from_row(row, HashMap::new(), None).key, key);
}
