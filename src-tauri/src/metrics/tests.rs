use std::collections::BTreeMap;

use super::catalog::{plan_for, supported_types, MetricRow, Planned};
use super::queries;

fn row(id: &str, name: &str, values: &[(&str, &str)]) -> MetricRow {
    MetricRow { id: id.into(), name: name.into(), values: values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>() }
}

fn plan(service: &str, type_id: &str, r: &MetricRow) -> super::catalog::Plan {
    match plan_for(service, type_id, r) {
        Some(Planned::Metrics(plan)) => plan,
        other => panic!("{service}/{type_id}: {other:?}"),
    }
}

#[test]
fn only_the_largest_unit_of_each_service_gets_metrics() {
    assert_eq!(supported_types("eks"), ["clusters"]);
    assert_eq!(supported_types("ec2"), ["instances"]);
    assert!(supported_types("iam").is_empty() && supported_types("vpc").is_empty() && supported_types("secretsmanager").is_empty());
    assert!(plan_for("eks", "node-groups", &row("ng", "ng", &[])).is_none());
}

#[test]
fn a_replication_group_draws_one_line_per_member_node() {
    let p = plan("elasticache", "replication-groups", &row("sessions", "sessions", &[("members", "sessions-001, sessions-002")]));
    assert_eq!(p.namespace, "AWS/ElastiCache");
    let lines: Vec<_> = p.series.iter().map(|s| (s.label.as_str(), s.dims.clone())).collect();
    assert_eq!(lines, [("sessions-001", vec![("CacheClusterId".to_string(), "sessions-001".to_string())]), ("sessions-002", vec![("CacheClusterId".to_string(), "sessions-002".to_string())])]);
    assert!(matches!(plan_for("elasticache", "replication-groups", &row("empty", "empty", &[])), Some(Planned::Note(_))));
}

#[test]
fn cluster_members_point_to_their_cluster_and_standalone_ones_get_metrics() {
    let Some(Planned::Note(note)) = plan_for("rds", "db-instances", &row("orders-1", "orders-1", &[("cluster", "orders")])) else { panic!() };
    assert!(note.contains("orders"), "{note}");
    assert_eq!(plan("rds", "db-instances", &row("legacy", "legacy", &[("cluster", "")])).series[0].dims, [("DBInstanceIdentifier".to_string(), "legacy".to_string())]);
    let Some(Planned::Note(note)) = plan_for("elasticache", "cache-clusters", &row("sessions-001", "sessions-001", &[("group", "sessions")])) else { panic!() };
    assert!(note.contains("sessions"), "{note}");
    assert_eq!(plan("elasticache", "cache-clusters", &row("memcache", "memcache", &[])).series[0].dims, [("CacheClusterId".to_string(), "memcache".to_string())]);
}

#[test]
fn dimensions_come_from_the_part_of_the_row_cloudwatch_names_and_the_region_where_the_metric_lives() {
    // SQS 행의 ID는 URL, SNS 행의 ID는 ARN이다
    let sqs = plan("sqs", "queues", &row("https://sqs.ap-northeast-2.amazonaws.com/1/jobs", "jobs", &[]));
    assert_eq!(sqs.series[0].dims, [("QueueName".to_string(), "jobs".to_string())]);
    let sns = plan("sns", "topics", &row("arn:aws:sns:ap-northeast-2:1:alerts", "alerts", &[]));
    assert_eq!(sns.series[0].dims, [("TopicName".to_string(), "alerts".to_string())]);
    let cf = plan("cloudfront", "distributions", &row("E2ABC", "cdn", &[]));
    assert_eq!((cf.region.as_deref(), cf.series[0].dims.clone()), (Some("us-east-1"), vec![("DistributionId".into(), "E2ABC".into()), ("Region".into(), "Global".into())]));
    assert_eq!(plan("route53", "hosted-zones", &row("Z123", "example.com.", &[])).region.as_deref(), Some("us-east-1"));
    let s3 = plan("s3", "buckets", &row("assets", "assets", &[("region", "us-west-2")]));
    assert_eq!((s3.region.as_deref(), s3.daily), (Some("us-west-2"), true));
    assert_eq!(plan("ec2", "instances", &row("i-1", "web", &[])).region, None);
}

#[test]
fn sns_filter_and_dlq_metrics_are_counts() {
    let sns = plan("sns", "topics", &row("arn:aws:sns:r:1:alerts", "alerts", &[]));
    for name in [
        "NumberOfNotificationsFilteredOut", "NumberOfNotificationsFilteredOut-InvalidAttributes",
        "NumberOfNotificationsFilteredOut-InvalidMessageBody", "NumberOfNotificationsFilteredOut-NoMessageAttributes",
        "NumberOfNotificationsRedrivenToDlq", "NumberOfNotificationsFailedToRedriveToDlq",
    ] {
        let metric = sns.metrics.iter().find(|m| m.name == name).unwrap();
        assert_eq!((metric.stat, metric.unit), ("Sum", super::catalog::MetricUnit::Count));
    }
}

#[test]
fn a_query_per_metric_and_line_with_the_metric_s_own_dimensions_added() {
    let s3 = plan("s3", "buckets", &row("assets", "assets", &[("region", "us-west-2")]));
    let q = queries(&s3, 86_400);
    assert_eq!(q.len(), 2);
    let stat = q[0].metric_stat().unwrap();
    let dims: Vec<_> = stat.metric().unwrap().dimensions().iter().map(|d| (d.name().unwrap(), d.value().unwrap())).collect();
    assert_eq!((q[0].id(), stat.metric().unwrap().metric_name(), stat.period(), dims), (Some("m0s0"), Some("BucketSizeBytes"), Some(86_400), vec![("BucketName", "assets"), ("StorageType", "StandardStorage")]));
    let rg = plan("elasticache", "replication-groups", &row("s", "s", &[("members", "s-001,s-002")]));
    let ids: Vec<_> = queries(&rg, 60).iter().take(3).map(|q| q.id().unwrap().to_string()).collect();
    assert_eq!(ids, ["m0s0", "m0s1", "m1s0"]);
}
