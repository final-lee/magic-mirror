use super::*;
use crate::sqs::SqsRedrive;

const URL: &str = "https://sqs.ap-northeast-2.amazonaws.com/111111111111/orders";
const ARN: &str = "arn:aws:sqs:ap-northeast-2:111111111111:orders";

fn attrs(pairs: &[(A, &str)]) -> HashMap<A, String> {
    pairs.iter().map(|(k, v)| (k.clone(), v.to_string())).collect()
}

#[test]
fn urls_and_arns_convert_both_ways() {
    assert_eq!(arn_from_url(URL, "ap-northeast-2"), ARN);
    assert_eq!(arn_from_url(&format!("{URL}/"), "ap-northeast-2"), ARN);
    assert_eq!(url_from_arn(ARN).as_deref(), Some(URL));
    assert_eq!(url_from_arn("arn:aws:sns:ap-northeast-2:111111111111:topic"), None);
    assert_eq!(url_from_arn("not an arn"), None);
    assert_eq!(name_of_arn(ARN), "orders");
}

#[test]
fn parse_queue_reads_every_attribute_the_workspace_shows() {
    let a = attrs(&[
        (A::QueueArn, ARN),
        (A::ApproximateNumberOfMessages, "7"),
        (A::ApproximateNumberOfMessagesNotVisible, "3"),
        (A::ApproximateNumberOfMessagesDelayed, "2"),
        (A::VisibilityTimeout, "45"),
        (A::MessageRetentionPeriod, "1209600"),
        (A::DelaySeconds, "5"),
        (A::MaximumMessageSize, "1024"),
        (A::ReceiveMessageWaitTimeSeconds, "20"),
        (A::RedrivePolicy, r#"{"deadLetterTargetArn":"arn:aws:sqs:ap-northeast-2:111111111111:orders-dlq","maxReceiveCount":3}"#),
        (A::RedriveAllowPolicy, r#"{"redrivePermission":"allowAll"}"#),
        (A::KmsMasterKeyId, "alias/app"),
        (A::SqsManagedSseEnabled, "false"),
        (A::Policy, r#"{"Statement":[]}"#),
        (A::CreatedTimestamp, "1700000000"),
        (A::LastModifiedTimestamp, "1700000100"),
    ]);
    let q = parse_queue(URL, &a);
    assert_eq!((q.name.as_str(), q.arn.as_str(), q.fifo), ("orders", ARN, false));
    assert_eq!((q.visible, q.in_flight, q.delayed), (7, 3, 2));
    assert_eq!((q.visibility_timeout, q.retention, q.delay, q.max_size, q.wait_time), (45, 1_209_600, 5, 1024, 20));
    assert_eq!(q.redrive, Some(SqsRedrive { dlq_arn: "arn:aws:sqs:ap-northeast-2:111111111111:orders-dlq".into(), max_receive_count: 3 }));
    assert_eq!(q.redrive_allow.as_deref(), Some(r#"{"redrivePermission":"allowAll"}"#));
    assert_eq!((q.sse_managed, q.kms_key.as_deref()), (false, Some("alias/app")));
    assert_eq!(q.policy.as_deref(), Some(r#"{"Statement":[]}"#));
    assert_eq!((q.created_at, q.modified_at), (Some(1_700_000_000_000), Some(1_700_000_100_000)));
    assert_eq!(q.content_dedup, None, "Standard queues have no dedup setting");
    assert!(q.sources.is_empty() && q.findings.is_empty() && q.tags.is_empty() && !q.is_dlq && q.error.is_none());
}

#[test]
fn parse_queue_fifo_options_and_lenient_numbers() {
    let a = attrs(&[
        (A::ContentBasedDeduplication, "true"),
        (A::DeduplicationScope, "messageGroup"),
        (A::FifoThroughputLimit, "perMessageGroupId"),
        (A::RedrivePolicy, r#"{"deadLetterTargetArn":"arn:aws:sqs:r:1:d.fifo","maxReceiveCount":"4"}"#),
        (A::VisibilityTimeout, "oops"),
    ]);
    let q = parse_queue("https://sqs.r.amazonaws.com/1/jobs.fifo", &a);
    assert!(q.fifo);
    assert_eq!(q.content_dedup, Some(true));
    assert_eq!(q.dedup_scope.as_deref(), Some("messageGroup"));
    assert_eq!(q.throughput_limit.as_deref(), Some("perMessageGroupId"));
    assert_eq!(q.redrive.unwrap().max_receive_count, 4, "string counts are accepted");
    assert_eq!(q.visibility_timeout, 0, "unparseable numbers fall back to 0");
    let fifo_default = parse_queue("https://sqs.r.amazonaws.com/1/x.fifo", &HashMap::new());
    assert_eq!(fifo_default.content_dedup, Some(false));
}

#[test]
fn a_broken_redrive_policy_is_no_redrive() {
    let q = parse_queue(URL, &attrs(&[(A::RedrivePolicy, "{")]));
    assert_eq!(q.redrive, None);
}

fn queue(name: &str, dlq: Option<&str>) -> SqsQueue {
    let mut q = SqsQueue::fixture(name);
    q.redrive = dlq.map(|d| SqsRedrive { dlq_arn: format!("arn:aws:sqs:ap-northeast-2:111111111111:{d}"), max_receive_count: 3 });
    q
}

#[test]
fn link_sources_groups_sources_under_their_dlq_including_shared_ones() {
    let mut queues = vec![queue("a", Some("shared-dlq")), queue("a-dlq", None), queue("shared-dlq", None), queue("b", Some("shared-dlq")), queue("solo", None), queue("orphan", Some("missing-dlq"))];
    link_sources(&mut queues);
    let by = |n: &str| queues.iter().find(|q| q.name == n).unwrap();
    assert_eq!(by("shared-dlq").sources, vec!["arn:aws:sqs:ap-northeast-2:111111111111:a".to_string(), "arn:aws:sqs:ap-northeast-2:111111111111:b".to_string()]);
    assert!(by("shared-dlq").is_dlq);
    assert!(!by("a-dlq").is_dlq, "nobody points at it");
    assert!(!by("solo").is_dlq && by("solo").sources.is_empty());
    assert!(!by("orphan").is_dlq, "a missing DLQ links nothing");
}

#[test]
fn link_sources_is_recomputed_not_accumulated() {
    let mut queues = vec![queue("a", Some("a-dlq")), queue("a-dlq", None)];
    link_sources(&mut queues);
    link_sources(&mut queues);
    assert_eq!(queues[1].sources.len(), 1);
}

#[test]
fn durations_read_as_the_two_largest_units() {
    assert_eq!(human_duration(0), "0s");
    assert_eq!(human_duration(45), "45s");
    assert_eq!(human_duration(300), "5m");
    assert_eq!(human_duration(3600), "1h");
    assert_eq!(human_duration(345_600), "4d");
    assert_eq!(human_duration(1_209_600), "14d");
    assert_eq!(human_duration(129_600), "1d 12h");
    assert_eq!(human_duration(90_061), "1d 1h", "seconds below the second unit are dropped");
}

#[test]
fn encryption_label_prefers_kms_over_sse_sqs() {
    let mut q = SqsQueue::fixture("a");
    q.sse_managed = false;
    assert_eq!(encryption_label(&q), "없음");
    q.sse_managed = true;
    assert_eq!(encryption_label(&q), "SSE-SQS");
    q.kms_key = Some("alias/app".into());
    assert_eq!(encryption_label(&q), "KMS");
}
