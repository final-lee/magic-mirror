use super::*;
use crate::sqs::{SqsActivity, SqsRedrive};

fn queue(name: &str) -> SqsQueue {
    // 규칙이 하나씩만 보이도록 DLQ가 있는 암호화된 큐로 시작한다
    let mut q = SqsQueue::fixture(name);
    q.redrive = Some(SqsRedrive { dlq_arn: format!("arn:aws:sqs:ap-northeast-2:111111111111:{name}-dlq"), max_receive_count: 5 });
    q
}

fn dlq_of(q: &SqsQueue) -> SqsQueue {
    let mut d = SqsQueue::fixture(&format!("{}-dlq", q.name));
    d.is_dlq = true;
    d.sources = vec![q.arn.clone()];
    d.redrive = None;
    d.retention = q.retention * 3;
    d
}

fn ids(findings: &[SqsFinding]) -> Vec<FindingId> {
    findings.iter().map(|f| f.id).collect()
}

fn with_activity(mut q: SqsQueue, oldest: Option<f64>, received: Option<f64>, empty: Option<f64>) -> SqsQueue {
    q.activity = Some(SqsActivity { oldest_age_sec: oldest, received15m: received, empty_receives15m: empty });
    q
}

#[test]
fn a_healthy_queue_with_a_dlq_has_no_findings() {
    let q = queue("orders");
    assert_eq!(health(&q, &[q.clone(), dlq_of(&q)]), vec![]);
}

#[test]
fn queues_that_could_not_be_read_get_no_findings() {
    let mut q = SqsQueue::fixture("orders");
    q.error = Some("권한 없음".into());
    assert_eq!(health(&q, &[]), vec![]);
}

#[test]
fn dlq_backlog_fails_on_the_dlq_and_on_its_source() {
    let source = queue("orders");
    let mut dlq = dlq_of(&source);
    dlq.visible = 3;
    let own = health(&dlq, &[source.clone(), dlq.clone()]);
    assert_eq!(own[0].id, FindingId::DlqBacklog);
    assert_eq!(own[0].level, FindingLevel::Fail);
    assert_eq!(own[0].summary, "DLQ에 3개가 쌓여 있어요");

    let on_source = health(&source, &[source.clone(), dlq]);
    assert_eq!(on_source[0].id, FindingId::DlqBacklog);
    assert_eq!(on_source[0].summary, "DLQ `orders-dlq`에 3개가 쌓여 있어요");
}

#[test]
fn an_empty_dlq_is_not_a_backlog() {
    let source = queue("orders");
    let dlq = dlq_of(&source);
    assert!(!ids(&health(&dlq, &[source.clone(), dlq.clone()])).contains(&FindingId::DlqBacklog));
    assert!(!ids(&health(&source, &[source.clone(), dlq])).contains(&FindingId::DlqBacklog));
}

#[test]
fn a_dlq_that_is_also_a_source_reports_its_own_backlog_once() {
    let mut mid = queue("mid");
    mid.is_dlq = true;
    mid.sources = vec!["arn:aws:sqs:ap-northeast-2:111111111111:first".into()];
    mid.visible = 2;
    let mut last = dlq_of(&mid);
    last.visible = 9;
    let backlog: Vec<_> = health(&mid, &[mid.clone(), last]).into_iter().filter(|f| f.id == FindingId::DlqBacklog).collect();
    assert_eq!(backlog.len(), 1);
    assert_eq!(backlog[0].summary, "DLQ에 2개가 쌓여 있어요");
}

#[test]
fn near_expiry_boundaries_at_half_and_four_fifths_of_retention() {
    let mut base = queue("orders");
    base.retention = 1000;
    let level = |age: f64| {
        let q = with_activity(base.clone(), Some(age), None, None);
        health(&q, &[q.clone(), dlq_of(&q)]).into_iter().find(|f| f.id == FindingId::NearExpiry).map(|f| f.level)
    };
    assert_eq!(level(499.0), None);
    assert_eq!(level(500.0), Some(FindingLevel::Warn));
    assert_eq!(level(799.0), Some(FindingLevel::Warn));
    assert_eq!(level(800.0), Some(FindingLevel::Fail));
    assert_eq!(level(5000.0), Some(FindingLevel::Fail));
}

#[test]
fn near_expiry_needs_a_metric() {
    let q = with_activity(queue("orders"), None, Some(5.0), Some(0.0));
    assert!(!ids(&health(&q, &[q.clone(), dlq_of(&q)])).contains(&FindingId::NearExpiry));
}

#[test]
fn stalled_needs_visible_messages_and_a_zero_receive_metric() {
    let mut q = with_activity(queue("orders"), None, Some(0.0), None);
    let peers = |q: &SqsQueue| vec![q.clone(), dlq_of(q)];
    assert!(!ids(&health(&q, &peers(&q))).contains(&FindingId::Stalled), "nothing waiting");
    q.visible = 1;
    assert!(ids(&health(&q, &peers(&q))).contains(&FindingId::Stalled));
    q.activity = Some(SqsActivity { oldest_age_sec: None, received15m: Some(1.0), empty_receives15m: None });
    assert!(!ids(&health(&q, &peers(&q))).contains(&FindingId::Stalled), "something received");
    q.activity = Some(SqsActivity { oldest_age_sec: None, received15m: None, empty_receives15m: None });
    assert!(!ids(&health(&q, &peers(&q))).contains(&FindingId::Stalled), "a missing metric is not zero");
}

#[test]
fn a_dlq_with_messages_is_a_backlog_not_a_stalled_queue() {
    let source = queue("orders");
    let mut dlq = with_activity(dlq_of(&source), None, Some(0.0), None);
    dlq.visible = 2;
    let found = ids(&health(&dlq, &[source, dlq.clone()]));
    assert!(found.contains(&FindingId::DlqBacklog));
    assert!(!found.contains(&FindingId::Stalled));
}

#[test]
fn public_policy_needs_an_unconditional_wildcard_allow() {
    let health_of = |policy: &str| {
        let mut q = queue("orders");
        q.policy = Some(policy.into());
        let peers = vec![q.clone(), dlq_of(&q)];
        health(&q, &peers)
    };
    let public = r#"{"Statement":[{"Effect":"Allow","Principal":"*","Action":"sqs:SendMessage","Resource":"*"}]}"#;
    let aws_star = r#"{"Statement":[{"Effect":"Allow","Principal":{"AWS":"*"},"Action":"sqs:*","Resource":"*"}]}"#;
    let conditional = r#"{"Statement":[{"Effect":"Allow","Principal":"*","Action":"sqs:SendMessage","Resource":"*","Condition":{"ArnEquals":{"aws:SourceArn":"arn:aws:sns:ap-northeast-2:111111111111:t"}}}]}"#;
    let deny = r#"{"Statement":[{"Effect":"Deny","Principal":"*","Action":"sqs:*","Resource":"*","Condition":{"Bool":{"aws:SecureTransport":"false"}}}]}"#;
    let service = r#"{"Statement":[{"Effect":"Allow","Principal":{"Service":"sns.amazonaws.com"},"Action":"sqs:SendMessage","Resource":"*"}]}"#;
    assert_eq!(ids(&health_of(public)), vec![FindingId::PublicPolicy]);
    assert_eq!(health_of(public)[0].level, FindingLevel::Fail);
    assert_eq!(ids(&health_of(aws_star)), vec![FindingId::PublicPolicy]);
    for safe in [conditional, deny, service] {
        assert_eq!(ids(&health_of(safe)), vec![], "{safe}");
    }
}

#[test]
fn dlq_retention_short_only_for_standard_sources_whose_dlq_is_listed() {
    let mut q = queue("orders");
    q.retention = 345_600;
    let mut dlq = dlq_of(&q);
    let check = |q: &SqsQueue, peers: &[SqsQueue]| ids(&health(q, peers)).contains(&FindingId::DlqRetentionShort);
    dlq.retention = 345_600;
    assert!(check(&q, &[q.clone(), dlq.clone()]), "equal is too short");
    dlq.retention = 345_599;
    assert!(check(&q, &[q.clone(), dlq.clone()]));
    dlq.retention = 345_601;
    assert!(!check(&q, &[q.clone(), dlq.clone()]));
    dlq.retention = 10;
    assert!(!check(&q, &[q.clone()]), "DLQ not in the list");
    let mut fifo = queue("orders.fifo");
    fifo.retention = 345_600;
    let mut fifo_dlq = dlq_of(&fifo);
    fifo_dlq.retention = 60;
    assert!(!check(&fifo, &[fifo.clone(), fifo_dlq]), "FIFO keeps the move time");
}

#[test]
fn max_receive_one_is_a_warning_only_at_exactly_one() {
    let mut q = queue("orders");
    let peers = |q: &SqsQueue| vec![q.clone(), dlq_of(q)];
    q.redrive.as_mut().unwrap().max_receive_count = 1;
    let found = health(&q, &peers(&q));
    assert_eq!(ids(&found), vec![FindingId::MaxReceiveOne]);
    assert_eq!(found[0].level, FindingLevel::Warn);
    q.redrive.as_mut().unwrap().max_receive_count = 2;
    assert_eq!(health(&q, &peers(&q)), vec![]);
}

#[test]
fn no_dlq_is_info_for_plain_queues_but_not_for_a_dlq() {
    let plain = SqsQueue::fixture("jobs");
    let found = health(&plain, std::slice::from_ref(&plain));
    assert_eq!(ids(&found), vec![FindingId::NoDlq]);
    assert_eq!(found[0].level, FindingLevel::Info);
    let source = queue("orders");
    let dlq = dlq_of(&source);
    assert_eq!(health(&dlq, &[source, dlq.clone()]), vec![]);
}

#[test]
fn short_polling_needs_zero_wait_and_many_mostly_empty_receives() {
    let check = |wait: i64, received: f64, empty: f64| {
        let mut q = with_activity(queue("orders"), None, Some(received), Some(empty));
        q.wait_time = wait;
        ids(&health(&q, &[q.clone(), dlq_of(&q)])).contains(&FindingId::ShortPolling)
    };
    assert!(check(0, 10.0, 100.0));
    assert!(!check(0, 10.0, 99.0), "under 100 empty receives");
    assert!(!check(0, 100.0, 100.0), "empty must exceed received");
    assert!(check(0, 99.0, 100.0));
    assert!(!check(20, 0.0, 500.0), "long polling");
}

#[test]
fn no_encryption_is_info_unless_sse_or_kms_is_on() {
    let mut q = queue("orders");
    let peers = |q: &SqsQueue| vec![q.clone(), dlq_of(q)];
    q.sse_managed = false;
    assert_eq!(ids(&health(&q, &peers(&q))), vec![FindingId::NoEncryption]);
    q.kms_key = Some("alias/app".into());
    assert_eq!(health(&q, &peers(&q)), vec![]);
}

#[test]
fn findings_sort_fail_then_warn_then_info_keeping_table_order_within_a_level() {
    let mut source = SqsQueue::fixture("orders");
    source.redrive = Some(SqsRedrive { dlq_arn: "arn:aws:sqs:ap-northeast-2:111111111111:orders-dlq".into(), max_receive_count: 1 });
    source.sse_managed = false;
    source.retention = 1000;
    source.visible = 4;
    source.policy = Some(r#"{"Statement":[{"Effect":"Allow","Principal":"*","Action":"sqs:*"}]}"#.into());
    source.activity = Some(SqsActivity { oldest_age_sec: Some(900.0), received15m: Some(0.0), empty_receives15m: None });
    let mut dlq = dlq_of(&source);
    dlq.retention = 1000;
    dlq.visible = 2;
    let found = health(&source, &[source.clone(), dlq]);
    assert_eq!(
        ids(&found),
        vec![
            FindingId::DlqBacklog,
            FindingId::NearExpiry,
            FindingId::PublicPolicy,
            FindingId::Stalled,
            FindingId::DlqRetentionShort,
            FindingId::MaxReceiveOne,
            FindingId::NoEncryption,
        ]
    );
    let levels: Vec<_> = found.iter().map(|f| f.level).collect();
    assert_eq!(
        levels,
        vec![FindingLevel::Fail, FindingLevel::Fail, FindingLevel::Fail, FindingLevel::Warn, FindingLevel::Warn, FindingLevel::Warn, FindingLevel::Info]
    );
}

fn lambda(name: &str, timeout: Option<i64>, enabled: bool) -> LambdaConsumer {
    LambdaConsumer { name: name.into(), timeout_secs: timeout, enabled }
}

fn parts<'a>(lambdas: &'a [LambdaConsumer], producers: &'a [ProducerLink], kms: &'a KmsAccess) -> FlowParts<'a> {
    FlowParts { lambdas, pipe_running: false, iam_receivers: None, producers, kms }
}

#[test]
fn visibility_vs_lambda_compares_six_times_the_timeout_and_names_the_function() {
    let mut q = SqsQueue::fixture("orders");
    q.visibility_timeout = 60;
    let kms = KmsAccess::NotApplicable;
    let run = |timeout| {
        let lambdas = [lambda("worker", Some(timeout), true)];
        flow_findings(&q, &parts(&lambdas, &[], &kms))
    };
    assert_eq!(run(10), vec![], "10 × 6 = 60 is enough");
    let found = run(11);
    assert_eq!(ids(&found), vec![FindingId::VisibilityVsLambda]);
    assert!(found[0].detail.as_deref().unwrap().contains("`worker`(제한 시간 11초)"));
}

#[test]
fn visibility_vs_lambda_ignores_disabled_mappings_and_unknown_timeouts() {
    let mut q = SqsQueue::fixture("orders");
    q.visibility_timeout = 30;
    let kms = KmsAccess::NotApplicable;
    let lambdas = [lambda("off", Some(900), false), lambda("unknown", None, true), lambda("fine", Some(5), true)];
    assert_eq!(flow_findings(&q, &parts(&lambdas, &[], &kms)), vec![]);
}

#[test]
fn visibility_vs_lambda_lists_every_offending_function() {
    let mut q = SqsQueue::fixture("orders");
    q.visibility_timeout = 30;
    let kms = KmsAccess::NotApplicable;
    let lambdas = [lambda("a", Some(60), true), lambda("b", Some(120), true)];
    let found = flow_findings(&q, &parts(&lambdas, &[], &kms));
    let detail = found[0].detail.as_deref().unwrap();
    assert!(detail.contains("`a`") && detail.contains("`b`"));
}

#[test]
fn no_consumer_needs_no_enabled_mapping_no_running_pipe_and_no_iam_receiver() {
    let q = SqsQueue::fixture("jobs");
    let kms = KmsAccess::NotApplicable;
    let check = |lambdas: &[LambdaConsumer], pipe: bool, iam: Option<usize>| {
        let p = FlowParts { lambdas, pipe_running: pipe, iam_receivers: iam, producers: &[], kms: &kms };
        ids(&flow_findings(&q, &p)).contains(&FindingId::NoConsumer)
    };
    assert!(check(&[], false, None));
    assert!(check(&[lambda("off", Some(1), false)], false, None), "a disabled mapping is not a consumer");
    assert!(!check(&[lambda("on", Some(1), true)], false, None));
    assert!(!check(&[], true, None));
    assert!(check(&[], false, Some(0)), "IAM computed and nobody can receive");
    assert!(!check(&[], false, Some(2)), "IAM found receivers");
}

#[test]
fn no_consumer_is_never_reported_on_a_dlq() {
    let mut q = SqsQueue::fixture("jobs-dlq");
    q.is_dlq = true;
    let kms = KmsAccess::NotApplicable;
    assert_eq!(flow_findings(&q, &parts(&[], &[], &kms)), vec![]);
}

fn link(kind: ProducerKind, label: &str, allowed: Option<bool>) -> ProducerLink {
    ProducerLink { kind, label: label.into(), allowed }
}

#[test]
fn subscription_denied_only_for_a_definite_policy_refusal() {
    let q = SqsQueue::fixture("jobs");
    let kms = KmsAccess::NotApplicable;
    let lambdas = [lambda("on", Some(1), true)];
    let producers = [link(ProducerKind::Sns, "topic-a", Some(true)), link(ProducerKind::Sns, "topic-b", None), link(ProducerKind::Rule, "rule-c", Some(false))];
    let found = flow_findings(&q, &parts(&lambdas, &producers, &kms));
    assert_eq!(ids(&found), vec![FindingId::SubscriptionDenied]);
    assert_eq!(found[0].level, FindingLevel::Fail);
    let detail = found[0].detail.as_deref().unwrap();
    assert!(detail.contains("EventBridge `rule-c`"));
    assert!(!detail.contains("topic-a") && !detail.contains("topic-b"));
}

#[test]
fn kms_findings_by_key_kind() {
    let q = SqsQueue::fixture("jobs");
    let lambdas = [lambda("on", Some(1), true)];
    let producers = [link(ProducerKind::Sns, "t", Some(true))];
    let run = |kms: KmsAccess, producers: &[ProducerLink]| flow_findings(&q, &parts(&lambdas, producers, &kms));

    assert_eq!(run(KmsAccess::AwsManaged, &producers)[0].level, FindingLevel::Fail);
    assert_eq!(run(KmsAccess::AwsManaged, &[]), vec![], "no service producer, nothing to block");
    assert_eq!(run(KmsAccess::NotApplicable, &producers), vec![]);

    let denied = run(KmsAccess::Customer(vec![(ProducerKind::Sns, Some(false))]), &producers);
    assert_eq!((denied[0].id, denied[0].level), (FindingId::KmsBlocksProducer, FindingLevel::Fail));
    assert_eq!(run(KmsAccess::Customer(vec![(ProducerKind::Sns, Some(true))]), &producers), vec![]);

    let unknown = run(KmsAccess::Customer(vec![(ProducerKind::Sns, None)]), &producers);
    assert_eq!(unknown[0].level, FindingLevel::Warn);
    // 한 서비스가 확실히 막히면 알 수 없는 서비스가 있어도 실패다
    let mixed = run(KmsAccess::Customer(vec![(ProducerKind::Sns, None), (ProducerKind::Rule, Some(false))]), &producers);
    assert_eq!(mixed[0].level, FindingLevel::Fail);

    let unreadable = run(KmsAccess::Unreadable("권한 없음".into()), &producers);
    assert_eq!(unreadable[0].level, FindingLevel::Warn);
    assert!(unreadable[0].summary.contains("알 수 없어요"));
}

#[test]
fn flow_findings_sort_by_level() {
    let mut q = SqsQueue::fixture("jobs");
    q.visibility_timeout = 30;
    let lambdas = [lambda("slow", Some(300), true)];
    let producers = [link(ProducerKind::Rule, "r", Some(false))];
    let kms = KmsAccess::NotApplicable;
    assert_eq!(ids(&flow_findings(&q, &parts(&lambdas, &producers, &kms))), vec![FindingId::SubscriptionDenied, FindingId::VisibilityVsLambda]);
}
