use aws_sdk_lambda::types::{DestinationConfig, EventSourcePosition, Filter, FilterCriteria, OnFailure};

use super::*;
use crate::dynamo::health::{health, HealthInput};
use crate::dynamo::{DynamoTable, FindingId, FindingLevel};

const MINUTE_MS: f64 = 60_000.0;
const HOUR_MS: f64 = 3_600_000.0;

fn esm_health(function: &str) -> EsmHealth {
    EsmHealth { function: function.into(), state: "Enabled".into(), iterator_age_ms: None, max_retries: Some(3), has_failure_destination: true }
}

/// 스트림이 켜져 있고 소비자가 하나 있는, 지적할 것 없는 입력
fn quiet() -> ConnectionHealth {
    ConnectionHealth { stream_enabled: true, consumer_count: Some(1), esms: vec![], replication_latency_ms: vec![] }
}

fn with_esm(configure: impl FnOnce(&mut EsmHealth)) -> ConnectionHealth {
    let mut esm = esm_health("worker");
    configure(&mut esm);
    ConnectionHealth { esms: vec![esm], ..quiet() }
}

fn kinds(findings: &[Finding]) -> Vec<(FindingId, FindingLevel)> {
    findings.iter().map(|f| (f.id, f.level)).collect()
}

// 진단 규칙 ------------------------------------------------------------------------------------

#[test]
fn a_healthy_connection_has_no_findings() {
    assert!(connection_findings(&quiet()).is_empty());
}

#[test]
fn replication_lag_is_reported_only_above_sixty_seconds() {
    let at = |latency_ms: f64| kinds(&connection_findings(&ConnectionHealth { replication_latency_ms: vec![("us-east-1".into(), latency_ms)], ..quiet() }));

    assert_eq!(at(60.0 * 1000.0), vec![]);
    assert_eq!(at(60_001.0), vec![(FindingId::ReplicationLag, FindingLevel::Warn)]);
}

#[test]
fn replication_lag_names_each_lagging_region() {
    let input = ConnectionHealth { replication_latency_ms: vec![("us-east-1".into(), 90_000.0), ("eu-west-1".into(), 1_000.0), ("ap-northeast-1".into(), 61_000.0)], ..quiet() };
    let findings = connection_findings(&input);

    assert_eq!(findings.len(), 2);
    assert!(findings[0].summary.contains("us-east-1"));
    assert!(findings[1].summary.contains("ap-northeast-1"));
}

#[test]
fn iterator_age_warns_at_five_minutes_and_fails_at_twelve_hours() {
    let at = |age_ms: f64| kinds(&connection_findings(&with_esm(|esm| esm.iterator_age_ms = Some(age_ms))));

    assert_eq!(at(5.0 * MINUTE_MS - 1.0), vec![]);
    assert_eq!(at(5.0 * MINUTE_MS), vec![(FindingId::IteratorAge, FindingLevel::Warn)]);
    assert_eq!(at(12.0 * HOUR_MS - 1.0), vec![(FindingId::IteratorAge, FindingLevel::Warn)]);
    assert_eq!(at(12.0 * HOUR_MS), vec![(FindingId::IteratorAge, FindingLevel::Fail)]);
    assert_eq!(at(30.0 * HOUR_MS), vec![(FindingId::IteratorAge, FindingLevel::Fail)]);
}

#[test]
fn a_function_without_an_iterator_age_metric_is_not_reported_as_late() {
    assert!(connection_findings(&with_esm(|esm| esm.iterator_age_ms = None)).is_empty());
}

#[test]
fn a_stream_with_no_consumers_is_reported_only_when_every_source_was_read() {
    let with_count = |stream_enabled, consumer_count| kinds(&connection_findings(&ConnectionHealth { stream_enabled, consumer_count, ..quiet() }));

    assert_eq!(with_count(true, Some(0)), vec![(FindingId::StreamNoConsumer, FindingLevel::Info)]);
    assert_eq!(with_count(true, Some(1)), vec![]);
    // 소비자 출처를 하나라도 읽지 못했다
    assert_eq!(with_count(true, None), vec![]);
    assert_eq!(with_count(false, Some(0)), vec![]);
}

#[test]
fn a_disabled_mapping_is_reported_whatever_the_case_of_its_state() {
    let with_state = |state: &str| kinds(&connection_findings(&with_esm(|esm| esm.state = state.into())));

    assert_eq!(with_state("Disabled"), vec![(FindingId::EsmDisabled, FindingLevel::Warn)]);
    assert_eq!(with_state("DISABLED"), vec![(FindingId::EsmDisabled, FindingLevel::Warn)]);
    assert_eq!(with_state("Enabled"), vec![]);
    assert_eq!(with_state("Disabling"), vec![]);
}

#[test]
fn unlimited_retries_are_a_problem_only_without_a_failure_destination() {
    let with = |retries: Option<i32>, destination: bool| {
        kinds(&connection_findings(&with_esm(|esm| {
            esm.max_retries = retries;
            esm.has_failure_destination = destination;
        })))
    };

    assert_eq!(with(Some(-1), false), vec![(FindingId::EsmNoOnFailure, FindingLevel::Warn)]);
    assert_eq!(with(Some(-1), true), vec![]);
    assert_eq!(with(Some(0), false), vec![]);
    assert_eq!(with(Some(3), false), vec![]);
    assert_eq!(with(None, false), vec![]);
}

#[test]
fn findings_come_failure_first_then_in_rule_order() {
    let mut late = esm_health("late");
    late.iterator_age_ms = Some(13.0 * HOUR_MS);
    let mut stuck = esm_health("stuck");
    stuck.max_retries = Some(-1);
    stuck.has_failure_destination = false;
    let mut off = esm_health("off");
    off.state = "Disabled".into();
    let input = ConnectionHealth {
        stream_enabled: true,
        consumer_count: Some(0),
        esms: vec![stuck, late, off],
        replication_latency_ms: vec![("us-east-1".into(), 2.0 * MINUTE_MS)],
    };

    assert_eq!(
        kinds(&connection_findings(&input)),
        vec![
            (FindingId::IteratorAge, FindingLevel::Fail),
            (FindingId::ReplicationLag, FindingLevel::Warn),
            (FindingId::EsmDisabled, FindingLevel::Warn),
            (FindingId::EsmNoOnFailure, FindingLevel::Warn),
            (FindingId::StreamNoConsumer, FindingLevel::Info),
        ]
    );
}

#[test]
fn connection_findings_sort_after_the_table_rules_by_severity() {
    let mut table = DynamoTable::fixture("orders");
    table.replicas = vec![Replica { region: "us-east-1".into(), status: "CREATING".into(), class: None }];
    let connections = ConnectionHealth { replication_latency_ms: vec![("us-east-1".into(), 2.0 * MINUTE_MS)], ..quiet() };
    let findings = health(&HealthInput { table: &table, scaling: Some(&[]), metrics: None, connections: Some(&connections) });

    assert_eq!(kinds(&findings), vec![(FindingId::ReplicaUnhealthy, FindingLevel::Fail), (FindingId::ReplicationLag, FindingLevel::Warn)]);
}

// 읽은 연결 → 진단 입력 --------------------------------------------------------------------------

fn esm(function: &str) -> Esm {
    Esm {
        id: "uuid".into(),
        function: function.into(),
        state: "Enabled".into(),
        batch_size: None,
        starting_position: None,
        parallelization: None,
        bisect: None,
        retries: None,
        max_age: None,
        failure_destination: None,
        filters: vec![],
        iterator_age_ms: None,
    }
}

fn read(esms: Vec<Esm>, pipes: usize, kinesis: usize, replicas: Vec<ReplicaConnection>) -> Connections {
    Connections {
        stream: Some(StreamSpec { arn: "arn:stream".into(), view_type: "KEYS_ONLY".into() }),
        esms,
        pipes: (0..pipes).map(|i| Pipe { name: format!("pipe-{i}"), state: "RUNNING".into(), target: "arn:target".into() }).collect(),
        kinesis: (0..kinesis).map(|i| Kinesis { arn: format!("arn:kinesis-{i}"), state: "ACTIVE".into(), precision: None }).collect(),
        replicas,
        gaps: vec![],
        findings: vec![],
    }
}

fn replica(region: &str, latency_ms: Option<f64>) -> ReplicaConnection {
    ReplicaConnection { replica: Replica { region: region.into(), status: "ACTIVE".into(), class: None }, latency_ms }
}

#[test]
fn consumers_are_counted_across_mappings_pipes_and_kinesis() {
    let connections = read(vec![esm("a"), esm("b")], 1, 2, vec![]);
    assert_eq!(connection_health(&connections, true).consumer_count, Some(5));
}

#[test]
fn a_source_that_could_not_be_read_hides_the_consumer_count_so_no_consumer_is_not_claimed() {
    let connections = read(vec![], 0, 0, vec![]);

    assert_eq!(connection_health(&connections, true).consumer_count, Some(0));
    assert_eq!(kinds(&connection_findings(&connection_health(&connections, true))), vec![(FindingId::StreamNoConsumer, FindingLevel::Info)]);

    assert_eq!(connection_health(&connections, false).consumer_count, None);
    assert!(connection_findings(&connection_health(&connections, false)).is_empty());
}

#[test]
fn a_table_without_a_stream_is_not_asked_for_consumers() {
    let mut connections = read(vec![], 0, 0, vec![]);
    connections.stream = None;
    let input = connection_health(&connections, true);

    assert!(!input.stream_enabled);
    assert!(connection_findings(&input).is_empty());
}

#[test]
fn replicas_without_a_latency_metric_are_left_out_of_the_diagnosis() {
    let connections = read(vec![], 1, 0, vec![replica("us-east-1", Some(90_000.0)), replica("eu-west-1", None)]);
    assert_eq!(connection_health(&connections, true).replication_latency_ms, vec![("us-east-1".to_string(), 90_000.0)]);
}

#[test]
fn the_diagnosis_input_keeps_what_each_rule_needs_from_a_mapping() {
    let mut mapping = esm("arn:aws:lambda:ap-northeast-2:111111111111:function:worker");
    mapping.state = "Disabled".into();
    mapping.iterator_age_ms = Some(2.0 * MINUTE_MS);
    mapping.retries = Some(-1);
    mapping.failure_destination = Some("arn:aws:sqs:ap-northeast-2:111111111111:dlq".into());
    let input = connection_health(&read(vec![mapping], 0, 0, vec![]), true);

    let esm = &input.esms[0];
    assert_eq!(esm.state, "Disabled");
    assert_eq!(esm.iterator_age_ms, Some(2.0 * MINUTE_MS));
    assert_eq!(esm.max_retries, Some(-1));
    assert!(esm.has_failure_destination);
}

// 해석 -----------------------------------------------------------------------------------------

#[test]
fn the_function_name_is_taken_from_the_arn_without_alias_or_version() {
    assert_eq!(function_name("arn:aws:lambda:ap-northeast-2:111111111111:function:worker"), "worker");
    assert_eq!(function_name("arn:aws:lambda:ap-northeast-2:111111111111:function:worker:live"), "worker");
    assert_eq!(function_name("arn:aws:lambda:ap-northeast-2:111111111111:function:worker:7"), "worker");
    assert_eq!(function_name("worker"), "worker");
    assert_eq!(function_name(""), "");
}

#[test]
fn a_window_without_samples_has_no_value_rather_than_zero() {
    assert_eq!(aggregate(&[], Statistic::Maximum), None);
    assert_eq!(aggregate(&[], Statistic::Average), None);
}

#[test]
fn samples_reduce_to_their_maximum_or_average() {
    let samples = [10.0, 400.0, 30.0];

    assert_eq!(aggregate(&samples, Statistic::Maximum), Some(400.0));
    assert_eq!(aggregate(&samples, Statistic::Average), Some(440.0 / 3.0));
    assert_eq!(aggregate(&[7.0], Statistic::Average), Some(7.0));
}

#[test]
fn a_mapping_is_read_with_its_retry_failure_destination_and_filter_settings() {
    let on_failure = OnFailure::builder().destination("arn:aws:sqs:ap-northeast-2:111111111111:dlq").build();
    let filter = Filter::builder().pattern(r#"{"eventName":["INSERT"]}"#).build();
    let mapping = EventSourceMappingConfiguration::builder()
        .uuid("1234")
        .function_arn("arn:aws:lambda:ap-northeast-2:111111111111:function:worker")
        .state("Enabled")
        .batch_size(100)
        .starting_position(EventSourcePosition::Latest)
        .parallelization_factor(2)
        .bisect_batch_on_function_error(true)
        .maximum_retry_attempts(-1)
        .maximum_record_age_in_seconds(3600)
        .destination_config(DestinationConfig::builder().on_failure(on_failure).build())
        .filter_criteria(FilterCriteria::builder().filters(filter).build())
        .build();
    let parsed = esm_from(&mapping);

    assert_eq!(parsed.id, "1234");
    assert_eq!(parsed.state, "Enabled");
    assert_eq!(parsed.batch_size, Some(100));
    assert_eq!(parsed.starting_position.as_deref(), Some("LATEST"));
    assert_eq!(parsed.parallelization, Some(2));
    assert_eq!(parsed.bisect, Some(true));
    assert_eq!(parsed.retries, Some(-1));
    assert_eq!(parsed.max_age, Some(3600));
    assert_eq!(parsed.failure_destination.as_deref(), Some("arn:aws:sqs:ap-northeast-2:111111111111:dlq"));
    assert_eq!(parsed.filters, vec![r#"{"eventName":["INSERT"]}"#.to_string()]);
    assert_eq!(parsed.iterator_age_ms, None);
}

#[test]
fn a_mapping_without_a_failure_destination_or_filters_reads_as_none_and_empty() {
    let parsed = esm_from(&EventSourceMappingConfiguration::builder().uuid("1").build());

    assert_eq!(parsed.failure_destination, None);
    assert!(parsed.filters.is_empty());
}

// 읽지 못한 부분 ---------------------------------------------------------------------------------

#[test]
fn a_failed_read_becomes_a_gap_and_the_rest_carries_on() {
    let mut gaps = Vec::new();
    let denied = AppError::AccessDenied { action: "pipes:ListPipes".into() };

    assert_eq!(read_or_gap(&mut gaps, "lambda", Ok(3)).unwrap(), Some(3));
    assert_eq!(read_or_gap::<i32>(&mut gaps, "pipes", Err(denied.clone())).unwrap(), None);

    assert_eq!(gaps, vec![Gap { section: "pipes".into(), error: denied.to_string() }]);
}

#[test]
fn the_same_section_is_listed_as_a_gap_once() {
    let mut gaps = Vec::new();
    for _ in 0..3 {
        read_or_gap::<i32>(&mut gaps, "iteratorAge", Err(AppError::other("denied"))).unwrap();
    }
    read_or_gap::<i32>(&mut gaps, "replicationLatency", Err(AppError::other("denied"))).unwrap();

    assert_eq!(gaps.iter().map(|g| g.section.as_str()).collect::<Vec<_>>(), vec!["iteratorAge", "replicationLatency"]);
}

#[test]
fn an_expired_sso_session_stops_everything_instead_of_becoming_a_gap() {
    let mut gaps = Vec::new();

    assert_eq!(read_or_gap::<i32>(&mut gaps, "lambda", Err(AppError::SsoExpired)), Err(AppError::SsoExpired));
    assert!(gaps.is_empty());
}
