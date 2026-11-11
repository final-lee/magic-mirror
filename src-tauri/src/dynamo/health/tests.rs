use std::collections::BTreeMap;

use super::*;
use crate::dynamo::{Pitr, Replica};

fn cap(peak_consumed: f64, peak_utilization: Option<f64>) -> Capacity {
    Capacity { peak_consumed, peak_utilization }
}

fn metrics(table: UsageMetrics) -> TableMetrics {
    TableMetrics { table, indexes: BTreeMap::new() }
}

fn scale(index: Option<&str>, dimension: Dimension, min: i64) -> ScalingTarget {
    ScalingTarget { index: index.map(str::to_string), dimension, min, max: 1000, target_utilization: Some(70.0) }
}

/// 온디맨드·PITR·삭제 보호가 모두 갖춰진 테이블이라 아무 지적이 없다
fn quiet() -> DynamoTable {
    DynamoTable::fixture("orders")
}

fn run(table: &DynamoTable, scaling: Option<&[ScalingTarget]>, metrics: Option<&TableMetrics>) -> Vec<Finding> {
    health(&HealthInput { table, scaling, metrics, connections: None })
}

fn ids(findings: &[Finding]) -> Vec<(FindingId, FindingLevel)> {
    findings.iter().map(|f| (f.id, f.level)).collect()
}

fn has(findings: &[Finding], id: FindingId) -> bool {
    findings.iter().any(|f| f.id == id)
}

#[test]
fn a_well_kept_table_has_no_findings() {
    assert!(run(&quiet(), Some(&[]), Some(&metrics(UsageMetrics::default()))).is_empty());
}

#[test]
fn throttle_boundaries() {
    let at = |read: f64, write: f64| {
        let m = metrics(UsageMetrics { read_throttle: read, write_throttle: write, ..Default::default() });
        ids(&run(&quiet(), Some(&[]), Some(&m)))
    };
    assert_eq!(at(0.0, 0.0), vec![]);
    assert_eq!(at(1.0, 0.0), vec![(FindingId::Throttled, FindingLevel::Warn)]);
    assert_eq!(at(0.0, 1.0), vec![(FindingId::Throttled, FindingLevel::Warn)]);
    // 읽기와 쓰기를 합쳐서 본다
    assert_eq!(at(99.0, 0.0), vec![(FindingId::Throttled, FindingLevel::Warn)]);
    assert_eq!(at(60.0, 39.0), vec![(FindingId::Throttled, FindingLevel::Warn)]);
    assert_eq!(at(60.0, 40.0), vec![(FindingId::Throttled, FindingLevel::Fail)]);
    assert_eq!(at(100.0, 0.0), vec![(FindingId::Throttled, FindingLevel::Fail)]);
}

#[test]
fn a_throttled_index_is_reported_on_its_own_and_blames_the_base_table() {
    let table = quiet().with_gsi("by-user", None).with_gsi("by-day", None);
    let mut m = metrics(UsageMetrics::default());
    m.indexes.insert("by-user".into(), UsageMetrics { write_throttle: 3.0, ..Default::default() });
    m.indexes.insert("by-day".into(), UsageMetrics { read_throttle: 3.0, ..Default::default() });
    let findings = run(&table, Some(&[]), Some(&m));
    let backpressure: Vec<_> = findings.iter().filter(|f| f.id == FindingId::GsiBackpressure).collect();
    // 쓰기 스로틀이 있는 인덱스만 원본 쓰기를 막는다
    assert_eq!(backpressure.len(), 1);
    assert_eq!(backpressure[0].index.as_deref(), Some("by-user"));
    assert_eq!(backpressure[0].level, FindingLevel::Fail);
    // 스로틀은 인덱스마다 따로 나온다
    let throttled: Vec<_> = findings.iter().filter(|f| f.id == FindingId::Throttled).map(|f| f.index.as_deref()).collect();
    assert_eq!(throttled, vec![Some("by-user"), Some("by-day")]);
    // 테이블 자체는 스로틀되지 않았다
    assert!(!findings.iter().any(|f| f.id == FindingId::Throttled && f.index.is_none()));
}

#[test]
fn a_table_write_throttle_is_not_gsi_backpressure() {
    let m = metrics(UsageMetrics { write_throttle: 500.0, ..Default::default() });
    assert!(!has(&run(&quiet(), Some(&[]), Some(&m)), FindingId::GsiBackpressure));
}

#[test]
fn indexes_that_are_changing_or_backfilling_are_noted() {
    let mut table = quiet().with_gsi("ready", None).with_gsi("building", None).with_gsi("filling", None).with_gsi("dropping", None);
    table.indexes[1].status = "CREATING".into();
    table.indexes[1].backfilling = true;
    table.indexes[2].backfilling = true;
    table.indexes[3].status = "DELETING".into();
    let findings = run(&table, Some(&[]), None);
    let noted: Vec<_> = findings.iter().filter(|f| f.id == FindingId::IndexNotActive).map(|f| (f.index.as_deref().unwrap(), f.level)).collect();
    assert_eq!(noted, vec![("building", FindingLevel::Info), ("filling", FindingLevel::Info), ("dropping", FindingLevel::Info)]);
}

#[test]
fn under_provisioned_starts_at_eighty_percent() {
    let table = quiet().provisioned(100, 100);
    let scaling = [scale(None, Dimension::Read, 1), scale(None, Dimension::Write, 1)];
    let at = |utilization: f64| {
        let m = metrics(UsageMetrics { read: Some(cap(utilization * 100.0, Some(utilization))), write: Some(cap(1.0, Some(0.5))), ..Default::default() });
        has(&run(&table, Some(&scaling), Some(&m)), FindingId::UnderProvisioned)
    };
    assert!(!at(0.79));
    assert!(at(0.8));
    assert!(at(1.2));
}

#[test]
fn under_provisioned_is_judged_against_the_capacity_of_that_time() {
    // 지금 프로비저닝(100)으로 보면 소비 90은 90%지만, 소비가 있던 때의 프로비저닝은 컸다(사용률 50%)
    let table = quiet().provisioned(100, 100);
    let scaling = [scale(None, Dimension::Read, 1), scale(None, Dimension::Write, 1)];
    let m = metrics(UsageMetrics { read: Some(cap(90.0, Some(0.5))), write: Some(cap(0.0, None)), ..Default::default() });
    assert!(!has(&run(&table, Some(&scaling), Some(&m)), FindingId::UnderProvisioned));
    // 같은 시각의 지표가 없으면 지금 프로비저닝으로 본다
    let m = metrics(UsageMetrics { read: Some(cap(90.0, None)), write: Some(cap(0.0, None)), ..Default::default() });
    assert!(has(&run(&table, Some(&scaling), Some(&m)), FindingId::UnderProvisioned));
}

#[test]
fn over_provisioned_is_below_twenty_percent() {
    let table = quiet().provisioned(100, 100);
    let scaling = [scale(None, Dimension::Read, 1), scale(None, Dimension::Write, 1)];
    let at = |peak: f64| {
        let m = metrics(UsageMetrics { read: Some(cap(peak, None)), write: Some(cap(50.0, None)), ..Default::default() });
        has(&run(&table, Some(&scaling), Some(&m)), FindingId::OverProvisioned)
    };
    assert!(at(0.0));
    assert!(at(19.9));
    assert!(!at(20.0));
    assert!(!at(55.0));
}

#[test]
fn over_provisioned_uses_the_autoscaling_minimum_when_it_is_higher() {
    let table = quiet().provisioned(100, 100);
    let write_ok = Some(cap(50.0, None));
    // 소비 30은 프로비저닝의 20%(20)를 넘지만 오토스케일링 최소값(40)보다는 낮다
    let m = metrics(UsageMetrics { read: Some(cap(30.0, None)), write: write_ok, ..Default::default() });
    let with_min = [scale(None, Dimension::Read, 40), scale(None, Dimension::Write, 1)];
    assert!(has(&run(&table, Some(&with_min), Some(&m)), FindingId::OverProvisioned));
    // 최소값이 더 작으면 20% 기준 그대로다
    let low_min = [scale(None, Dimension::Read, 5), scale(None, Dimension::Write, 1)];
    assert!(!has(&run(&table, Some(&low_min), Some(&m)), FindingId::OverProvisioned));
    // 소비가 최소값 이상이면 지적하지 않는다
    let m = metrics(UsageMetrics { read: Some(cap(40.0, None)), write: write_ok, ..Default::default() });
    assert!(!has(&run(&table, Some(&with_min), Some(&m)), FindingId::OverProvisioned));
}

#[test]
fn a_provisioned_index_is_judged_on_its_own_capacity() {
    let table = quiet().provisioned(100, 100).with_gsi("by-user", Some((10, 10)));
    let scaling = [scale(None, Dimension::Read, 1), scale(None, Dimension::Write, 1), scale(Some("by-user"), Dimension::Read, 1), scale(Some("by-user"), Dimension::Write, 1)];
    let mut m = metrics(UsageMetrics { read: Some(cap(50.0, None)), write: Some(cap(50.0, None)), ..Default::default() });
    m.indexes.insert("by-user".into(), UsageMetrics { read: Some(cap(9.0, None)), write: Some(cap(5.0, None)), ..Default::default() });
    let findings = run(&table, Some(&scaling), Some(&m));
    let under: Vec<_> = findings.iter().filter(|f| f.id == FindingId::UnderProvisioned).collect();
    assert_eq!(under.len(), 1);
    assert_eq!(under[0].index.as_deref(), Some("by-user"));
}

#[test]
fn capacity_rules_skip_on_demand_tables_and_missing_metrics() {
    let on_demand = quiet();
    let m = metrics(UsageMetrics { read: Some(cap(1000.0, Some(9.0))), write: Some(cap(0.0, None)), ..Default::default() });
    assert!(run(&on_demand, Some(&[]), Some(&m)).is_empty());
    let provisioned = quiet().provisioned(100, 100);
    let scaling = [scale(None, Dimension::Read, 1), scale(None, Dimension::Write, 1)];
    // 지표를 읽지 못했으면 사용량 규칙은 건너뛴다
    assert!(run(&provisioned, Some(&scaling), None).is_empty());
}

#[test]
fn auto_scaling_is_missing_only_when_there_is_no_target_at_all() {
    let table = quiet().provisioned(5, 5).with_gsi("by-user", Some((5, 5)));
    let findings = run(&table, Some(&[]), None);
    let missing: Vec<_> = findings.iter().filter(|f| f.id == FindingId::NoAutoScaling).map(|f| (f.index.as_deref(), f.level)).collect();
    assert_eq!(missing, vec![(None, FindingLevel::Warn), (Some("by-user"), FindingLevel::Warn)]);
    // 테이블에만 있으면 인덱스만 남는다
    let only_table = [scale(None, Dimension::Read, 1)];
    let findings = run(&table, Some(&only_table), None);
    let missing: Vec<_> = findings.iter().filter(|f| f.id == FindingId::NoAutoScaling).map(|f| f.index.as_deref()).collect();
    assert_eq!(missing, vec![Some("by-user")]);
    // 온디맨드는 대상이 아니다
    assert!(run(&quiet(), Some(&[]), None).is_empty());
}

#[test]
fn auto_scaling_that_could_not_be_read_is_not_called_missing() {
    let table = quiet().provisioned(5, 5);
    assert!(!has(&run(&table, None, None), FindingId::NoAutoScaling));
}

#[test]
fn pitr_off_only_when_it_is_known_to_be_off() {
    let mut table = quiet();
    table.pitr = Some(Pitr { status: "DISABLED".into(), days: None });
    assert_eq!(ids(&run(&table, Some(&[]), None)), vec![(FindingId::PitrOff, FindingLevel::Warn)]);
    table.pitr = Some(Pitr { status: "ENABLED".into(), days: Some(35) });
    assert!(run(&table, Some(&[]), None).is_empty());
    // 읽지 못했으면 모른다
    table.pitr = None;
    assert!(run(&table, Some(&[]), None).is_empty());
}

#[test]
fn deletion_protection_is_a_warning_only_for_production_names() {
    let level = |name: &str| {
        let mut table = DynamoTable::fixture(name);
        table.deletion_protection = false;
        ids(&run(&table, Some(&[]), None))
    };
    assert_eq!(level("orders"), vec![(FindingId::DeletionProtectionOff, FindingLevel::Info)]);
    assert_eq!(level("prod-orders"), vec![(FindingId::DeletionProtectionOff, FindingLevel::Warn)]);
    assert_eq!(level("orders-prd"), vec![(FindingId::DeletionProtectionOff, FindingLevel::Warn)]);
    assert_eq!(level("PROD_Orders"), vec![(FindingId::DeletionProtectionOff, FindingLevel::Warn)]);
    assert_eq!(level("product-catalog"), vec![(FindingId::DeletionProtectionOff, FindingLevel::Warn)]);
}

#[test]
fn every_replica_that_is_not_active_fails() {
    let mut table = quiet();
    let replica = |region: &str, status: &str| Replica { region: region.into(), status: status.into(), class: None };
    table.replicas = vec![replica("us-east-1", "ACTIVE"), replica("eu-west-1", "UPDATING"), replica("ap-northeast-1", "REGION_DISABLED")];
    let findings = run(&table, Some(&[]), None);
    assert_eq!(ids(&findings), vec![(FindingId::ReplicaUnhealthy, FindingLevel::Fail), (FindingId::ReplicaUnhealthy, FindingLevel::Fail)]);
    assert!(findings[0].summary.contains("eu-west-1") && findings[1].summary.contains("ap-northeast-1"));
}

#[test]
fn findings_are_ordered_by_level_then_by_rule_order() {
    let mut table = quiet().provisioned(100, 100).with_gsi("by-user", Some((100, 100)));
    table.deletion_protection = false;
    table.pitr = Some(Pitr { status: "DISABLED".into(), days: None });
    table.indexes[0].backfilling = true;
    table.replicas = vec![Replica { region: "us-east-1".into(), status: "CREATING".into(), class: None }];
    let mut m = metrics(UsageMetrics { read_throttle: 5.0, read: Some(cap(0.0, None)), write: Some(cap(0.0, None)), ..Default::default() });
    m.indexes.insert("by-user".into(), UsageMetrics { write_throttle: 200.0, read: Some(cap(0.0, None)), write: Some(cap(0.0, None)), ..Default::default() });
    let findings = run(&table, Some(&[]), Some(&m));
    assert_eq!(
        ids(&findings),
        vec![
            // 실패: 스로틀(테이블은 주의라 아래) → 인덱스 스로틀, 인덱스 역압, 복제본
            (FindingId::Throttled, FindingLevel::Fail),
            (FindingId::GsiBackpressure, FindingLevel::Fail),
            (FindingId::ReplicaUnhealthy, FindingLevel::Fail),
            // 주의: 테이블 스로틀, 오토스케일링 없음(테이블, 인덱스), PITR
            (FindingId::Throttled, FindingLevel::Warn),
            (FindingId::NoAutoScaling, FindingLevel::Warn),
            (FindingId::NoAutoScaling, FindingLevel::Warn),
            (FindingId::PitrOff, FindingLevel::Warn),
            // 정보: 인덱스 상태, 과다 프로비저닝(테이블, 인덱스), 삭제 보호
            (FindingId::IndexNotActive, FindingLevel::Info),
            (FindingId::OverProvisioned, FindingLevel::Info),
            (FindingId::OverProvisioned, FindingLevel::Info),
            (FindingId::DeletionProtectionOff, FindingLevel::Info),
        ]
    );
}

#[test]
fn a_table_that_could_not_be_described_has_no_findings() {
    let mut table = quiet();
    table.deletion_protection = false;
    table.error = Some("권한 없음".into());
    assert!(run(&table, Some(&[]), None).is_empty());
}
