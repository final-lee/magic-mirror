use super::{health::{connection_findings, ConnectionHealth, EsmHealth}, FindingId, FindingLevel};

#[test]
fn connection_health_boundaries_and_incomplete_sources() {
    let esm = |age| EsmHealth { function: "fn".into(), state: "Disabled".into(), iterator_age_ms: Some(age), max_retries: Some(-1), has_failure_destination: false };
    let mut input = ConnectionHealth { stream_enabled: true, consumer_count: None, esms: vec![esm(299_999.0)], replication_latency_ms: vec![("r".into(), 60_000.0)] };
    let findings = connection_findings(&input);
    assert!(!findings.iter().any(|f| matches!(f.id, FindingId::StreamNoConsumer | FindingId::IteratorAge | FindingId::ReplicationLag)));
    assert!(findings.iter().any(|f| f.id == FindingId::EsmDisabled));
    assert!(findings.iter().any(|f| f.id == FindingId::EsmNoOnFailure));
    input.consumer_count = Some(0); input.esms[0].iterator_age_ms = Some(300_000.0); input.replication_latency_ms[0].1 = 60_001.0;
    let findings = connection_findings(&input);
    assert!(findings.iter().any(|f| f.id == FindingId::StreamNoConsumer));
    assert!(findings.iter().any(|f| f.id == FindingId::IteratorAge && f.level == FindingLevel::Warn));
    assert!(findings.iter().any(|f| f.id == FindingId::ReplicationLag));
    input.esms[0].iterator_age_ms = Some(43_200_000.0);
    assert!(connection_findings(&input).iter().any(|f| f.id == FindingId::IteratorAge && f.level == FindingLevel::Fail));
}
