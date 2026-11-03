use super::*;
use crate::k8s::checks::testkit::{cluster, of};
use crate::k8s::checks::versions::epoch_of;
use crate::k8s::checks::AwsAuthUse;

fn names(findings: &[Finding]) -> Vec<CheckId> {
    findings.iter().map(|f| f.check).collect()
}

fn run(c: &ClusterFacts) -> Vec<Finding> {
    check_cluster(c, &Ok(vec![]), epoch_of(2026, 1, 1))
}

// ── 퍼블릭 엔드포인트 ──

#[test]
fn a_public_endpoint_open_to_everyone_is_high() {
    let mut c = cluster();
    c.endpoint_public = true;
    c.public_cidrs = vec!["0.0.0.0/0".into()];
    let found = run(&c);
    assert_eq!(names(&found), [CheckId::ClusterPublicEndpoint]);
    assert_eq!(found[0].severity, Severity::High);
    assert!(found[0].evidence.iter().any(|e| e.contains("0.0.0.0/0")));
    assert_eq!(found[0].namespace, None);
}

#[test]
fn a_restricted_or_private_endpoint_is_fine() {
    let mut c = cluster();
    c.endpoint_public = true;
    c.public_cidrs = vec!["203.0.113.0/24".into(), "198.51.100.7/32".into()];
    assert!(run(&c).is_empty());
    c.endpoint_public = false;
    c.public_cidrs = vec!["0.0.0.0/0".into()];
    assert!(run(&c).is_empty(), "퍼블릭이 꺼져 있으면 허용 CIDR 값은 뜻이 없다");
}

#[test]
fn an_open_cidr_among_restricted_ones_and_the_ipv6_wildcard_both_count() {
    let mut c = cluster();
    c.endpoint_public = true;
    c.public_cidrs = vec!["203.0.113.0/24".into(), "0.0.0.0/0".into()];
    assert_eq!(names(&run(&c)), [CheckId::ClusterPublicEndpoint]);
    c.public_cidrs = vec!["::/0".into()];
    assert_eq!(names(&run(&c)), [CheckId::ClusterPublicEndpoint]);
}

#[test]
fn an_empty_cidr_list_on_a_public_endpoint_is_treated_as_open() {
    let mut c = cluster();
    c.endpoint_public = true;
    c.public_cidrs = vec![];
    let found = run(&c);
    assert_eq!(names(&found), [CheckId::ClusterPublicEndpoint]);
    assert!(found[0].evidence[0].contains("비어"));
}

// ── 컨트롤 플레인 로그 ──

#[test]
fn all_five_log_types_on_is_clean() {
    assert!(run(&cluster()).is_empty());
}

#[test]
fn missing_audit_or_authenticator_logs_are_medium_and_listed() {
    let mut c = cluster();
    c.logging_enabled = vec!["api".into(), "controllerManager".into(), "scheduler".into()];
    let found = run(&c);
    assert_eq!(found[0].check, CheckId::ClusterLoggingOff);
    assert_eq!(found[0].severity, Severity::Medium);
    assert!(found[0].message.contains("audit, authenticator"), "{}", found[0].message);
}

#[test]
fn missing_only_less_critical_log_types_is_low() {
    let mut c = cluster();
    c.logging_enabled = vec!["api".into(), "audit".into(), "authenticator".into()];
    let found = run(&c);
    assert_eq!(found[0].severity, Severity::Low);
    assert!(found[0].message.contains("controllerManager, scheduler"));
}

#[test]
fn every_log_off_lists_all_five_types() {
    let mut c = cluster();
    c.logging_enabled = vec![];
    let found = run(&c);
    for t in LOG_TYPES {
        assert!(found[0].message.contains(t), "{t}");
    }
    assert!(found[0].evidence.iter().any(|e| e.contains("켜진 유형: 없음")));
}

// ── Secret 암호화 ──

#[test]
fn secrets_without_envelope_encryption_are_flagged() {
    let mut c = cluster();
    c.secrets_encrypted = false;
    let found = run(&c);
    assert_eq!(names(&found), [CheckId::ClusterSecretsPlain]);
    assert_eq!(found[0].severity, Severity::Medium);
}

// ── 버전 지원 기간 ──

fn at_version(version: &str, versions: Result<Vec<VersionSupport>, AppError>, now: i64) -> Vec<Finding> {
    let mut c = cluster();
    c.version = version.into();
    check_cluster(&c, &versions, now)
}

fn api(version: &str, end: i64) -> VersionSupport {
    VersionSupport { version: version.into(), end_of_standard_support: Some(end) }
}

#[test]
fn support_ending_within_ninety_days_is_flagged_and_ninety_one_is_not() {
    let end = epoch_of(2026, 6, 1);
    let day = SECONDS_PER_DAY;
    let found = at_version("1.40", Ok(vec![api("1.40", end)]), end - 90 * day);
    assert_eq!(names(&found), [CheckId::ClusterVersionSupport]);
    assert_eq!(found[0].severity, Severity::Medium);
    assert!(found[0].message.contains("90일 뒤"), "{}", found[0].message);
    assert!(at_version("1.40", Ok(vec![api("1.40", end)]), end - 91 * day).is_empty());
    // 마지막 날과 종료 직전도 아직 "남음"이다
    let last = at_version("1.40", Ok(vec![api("1.40", end)]), end - 1);
    assert!(last[0].message.contains("0일 뒤"), "{}", last[0].message);
}

#[test]
fn support_that_already_ended_is_high_and_says_how_long_ago() {
    let end = epoch_of(2026, 6, 1);
    let found = at_version("1.40", Ok(vec![api("1.40", end)]), end + 3 * SECONDS_PER_DAY);
    assert_eq!(found[0].severity, Severity::High);
    assert!(found[0].message.contains("3일 전"), "{}", found[0].message);
    assert!(found[0].evidence.iter().any(|e| e.contains("표준 지원 종료: 2026-06-01")));
}

#[test]
fn the_api_source_is_named_and_beats_the_table() {
    // 표는 1.30이 2025-07-23에 끝났다고 하지만 API가 먼 미래를 알려 주면 API를 따른다
    let now = epoch_of(2026, 1, 1);
    assert!(at_version("1.30", Ok(vec![api("1.30", epoch_of(2030, 1, 1))]), now).is_empty());
    let found = at_version("1.30", Ok(vec![api("1.30", epoch_of(2026, 1, 10))]), now);
    assert!(found[0].evidence.iter().any(|e| e.contains("DescribeClusterVersions")));
}

#[test]
fn when_the_api_cannot_be_read_the_table_is_used_and_labelled() {
    let found = at_version("1.30", Err(AppError::AccessDenied { action: "eks:DescribeClusterVersions".into() }), epoch_of(2026, 1, 1));
    assert_eq!(names(&found), [CheckId::ClusterVersionSupport]);
    assert_eq!(found[0].severity, Severity::High, "1.30의 표준 지원은 2025-07-23에 끝났다");
    assert!(found[0].evidence.iter().any(|e| e.contains("앱에 넣어 둔 표")));
}

#[test]
fn a_version_neither_the_api_nor_the_table_knows_is_not_flagged() {
    assert!(at_version("1.99", Ok(vec![]), epoch_of(2099, 1, 1)).is_empty());
}

// ── aws-auth ──

fn use_of(arn: &str, groups: &[&str]) -> AwsAuthUse {
    AwsAuthUse { arn: arn.into(), groups: groups.iter().map(|g| g.to_string()).collect() }
}

fn facts(entries: Vec<AwsAuthUse>) -> AwsAuthFacts {
    AwsAuthFacts { mode: Some("API_AND_CONFIG_MAP".into()), entries }
}

#[test]
fn aws_auth_without_effective_entries_is_not_in_use() {
    assert!(check_aws_auth(&facts(vec![])).is_empty());
}

#[test]
fn aws_auth_mapping_people_is_medium_and_links_to_the_configmap() {
    let found = check_aws_auth(&facts(vec![use_of("arn:aws:iam::1:role/dev", &["devs"]), use_of("arn:aws:iam::1:role/node", &["system:nodes"])]));
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].severity, Severity::Medium);
    match &found[0].target {
        Target::Object { kind, namespace, name } => assert_eq!((kind.kind.as_str(), namespace.as_deref(), name.as_str()), ("ConfigMap", Some("kube-system"), "aws-auth")),
        other => panic!("{other:?}"),
    }
    assert_eq!(found[0].namespace, None, "클러스터 점검은 시스템 네임스페이스 제외에 걸리지 않는다");
    assert!(found[0].evidence.iter().any(|e| e.contains("role/dev → devs")));
}

#[test]
fn aws_auth_holding_only_node_roles_is_low() {
    let found = check_aws_auth(&facts(vec![use_of("arn:aws:iam::1:role/node", &["system:bootstrappers", "system:nodes"])]));
    assert_eq!(found[0].severity, Severity::Low);
}

#[test]
fn a_long_aws_auth_list_is_cut_with_a_remainder_line() {
    let entries = (0..13).map(|i| use_of(&format!("arn:aws:iam::1:role/r{i}"), &["g"])).collect();
    let found = check_aws_auth(&facts(entries));
    assert!(found[0].message.contains("13개"));
    assert_eq!(found[0].evidence.last().unwrap(), "…외 3개");
}

// ── 생성자 관리자 ──

fn entry(arn: &str, created_at: Option<i64>) -> AdminEntry {
    AdminEntry { principal_arn: arn.into(), created_at }
}

#[test]
fn only_the_admin_entry_created_with_the_cluster_is_the_bootstrap_candidate() {
    let c = cluster();
    let created = c.created_at.unwrap();
    let entries = vec![
        entry("arn:aws:iam::1:role/creator", Some(created + 20)),
        entry("arn:aws:iam::1:role/later-admin", Some(created + 86_400)),
        entry("arn:aws:iam::1:role/unknown-time", None),
    ];
    let found = check_creator_admin(&c, &entries);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].check, CheckId::ClusterCreatorAdmin);
    assert_eq!(found[0].target, Target::Subject { subject: Subject::iam("arn:aws:iam::1:role/creator") });
    assert!(found[0].evidence.iter().any(|e| e.contains("추정")), "만든 신원을 EKS가 알려 주지 않으니 추정이라고 밝힌다");
}

#[test]
fn the_creator_window_edges_are_inclusive_and_nothing_outside_counts() {
    let c = cluster();
    let created = c.created_at.unwrap();
    let hit = |offset: i64| !check_creator_admin(&c, &[entry("arn:aws:iam::1:role/x", Some(created + offset))]).is_empty();
    assert!(hit(-60));
    assert!(!hit(-61));
    assert!(hit(300));
    assert!(!hit(301));
}

#[test]
fn without_the_cluster_creation_time_nothing_is_guessed() {
    let mut c = cluster();
    c.created_at = None;
    assert!(check_creator_admin(&c, &[entry("arn:aws:iam::1:role/x", Some(1))]).is_empty());
}

#[test]
fn a_clean_cluster_has_no_cluster_findings_at_all() {
    assert!(of(&run(&cluster()), CheckId::ClusterPublicEndpoint).is_empty());
    assert!(run(&cluster()).is_empty());
}
