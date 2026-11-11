//! 리소스 상세에 붙이는 CloudWatch 지표의 목록(순수 함수). 서비스마다 가장 큰 단위(클러스터·복제 그룹·인스턴스·함수 …)에만 붙인다.
//! 지표 이름과 차원은 personal·finallee 계정의 `list-metrics`로 확인한 것이다. ECS 클러스터와 ElastiCache 서버리스 캐시는 두 계정에 없어
//! AWS 문서의 이름을 따랐다.
//!
//! - 클러스터에 속한 RDS 인스턴스와 복제 그룹에 속한 ElastiCache 노드는 지표 대신 클러스터에서 보라는 안내를 낸다.
//! - ElastiCache 복제 그룹의 지표는 멤버 노드(`CacheClusterId`)마다 쌓이므로 노드마다 선을 하나씩 그린다.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::aws::context::GLOBAL_REGION;

/// 값의 단위. 화면이 축과 값을 이 단위로 쓴다
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MetricUnit {
    Percent,
    Bytes,
    Count,
    Seconds,
    Milliseconds,
    Microseconds,
    BytesPerSecond,
    CountPerSecond,
}

/// 지표 하나: 이름, 통계, 단위, 이 지표에만 붙는 차원(S3의 `StorageType` …)
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MetricDef {
    pub name: &'static str,
    pub stat: &'static str,
    pub unit: MetricUnit,
    pub extra: &'static [(&'static str, &'static str)],
}

const fn m(name: &'static str, stat: &'static str, unit: MetricUnit) -> MetricDef {
    MetricDef { name, stat, unit, extra: &[] }
}

use MetricUnit::*;

const EC2: &[MetricDef] = &[
    m("CPUUtilization", "Average", Percent),
    m("NetworkIn", "Sum", Bytes),
    m("NetworkOut", "Sum", Bytes),
    m("NetworkPacketsIn", "Sum", Count),
    m("NetworkPacketsOut", "Sum", Count),
    m("EBSReadBytes", "Sum", Bytes),
    m("EBSWriteBytes", "Sum", Bytes),
    m("EBSReadOps", "Sum", Count),
    m("EBSWriteOps", "Sum", Count),
    m("StatusCheckFailed", "Maximum", Count),
    m("CPUCreditBalance", "Average", Count),
];

/// S3 저장 지표는 하루에 한 번 쌓인다
const S3: &[MetricDef] = &[
    MetricDef { name: "BucketSizeBytes", stat: "Average", unit: Bytes, extra: &[("StorageType", "StandardStorage")] },
    MetricDef { name: "NumberOfObjects", stat: "Average", unit: Count, extra: &[("StorageType", "AllStorageTypes")] },
];

const LAMBDA: &[MetricDef] = &[
    m("Invocations", "Sum", Count),
    m("Errors", "Sum", Count),
    m("Throttles", "Sum", Count),
    m("Duration", "Average", Milliseconds),
    m("Duration", "p99", Milliseconds),
    m("ConcurrentExecutions", "Maximum", Count),
];

const RDS_CLUSTER: &[MetricDef] = &[
    m("CPUUtilization", "Average", Percent),
    m("DatabaseConnections", "Average", Count),
    m("FreeableMemory", "Average", Bytes),
    m("ReadIOPS", "Average", CountPerSecond),
    m("WriteIOPS", "Average", CountPerSecond),
    m("ReadLatency", "Average", Seconds),
    m("WriteLatency", "Average", Seconds),
    m("ReadThroughput", "Average", BytesPerSecond),
    m("WriteThroughput", "Average", BytesPerSecond),
    m("CommitLatency", "Average", Milliseconds),
    m("BufferCacheHitRatio", "Average", Percent),
    m("Deadlocks", "Average", CountPerSecond),
    m("VolumeBytesUsed", "Average", Bytes),
    m("AuroraReplicaLagMaximum", "Maximum", Milliseconds),
];

const RDS_INSTANCE: &[MetricDef] = &[
    m("CPUUtilization", "Average", Percent),
    m("DatabaseConnections", "Average", Count),
    m("FreeableMemory", "Average", Bytes),
    m("FreeStorageSpace", "Average", Bytes),
    m("ReadIOPS", "Average", CountPerSecond),
    m("WriteIOPS", "Average", CountPerSecond),
    m("ReadLatency", "Average", Seconds),
    m("WriteLatency", "Average", Seconds),
    m("ReadThroughput", "Average", BytesPerSecond),
    m("WriteThroughput", "Average", BytesPerSecond),
    m("DiskQueueDepth", "Average", Count),
    m("ReplicaLag", "Maximum", Seconds),
];

/// 노드 기반(Valkey·Redis OSS·Memcached) ElastiCache. 엔진에 없는 지표는 빈 차트가 된다
const ELASTICACHE_NODE: &[MetricDef] = &[
    m("CPUUtilization", "Average", Percent),
    m("EngineCPUUtilization", "Average", Percent),
    m("DatabaseMemoryUsagePercentage", "Average", Percent),
    m("CurrConnections", "Average", Count),
    m("NewConnections", "Sum", Count),
    m("NetworkBytesIn", "Sum", Bytes),
    m("NetworkBytesOut", "Sum", Bytes),
    m("CacheHits", "Sum", Count),
    m("CacheMisses", "Sum", Count),
    m("Evictions", "Sum", Count),
    m("CurrItems", "Average", Count),
    m("FreeableMemory", "Average", Bytes),
    m("SwapUsage", "Average", Bytes),
    m("MemoryFragmentationRatio", "Average", Count),
    m("ReplicationLag", "Maximum", Seconds),
];

const ELASTICACHE_SERVERLESS: &[MetricDef] = &[
    m("BytesUsedForCache", "Average", Bytes),
    m("ElastiCacheProcessingUnits", "Sum", Count),
    m("CacheHitRate", "Average", Percent),
    m("CurrConnections", "Average", Count),
    m("NetworkBytesIn", "Sum", Bytes),
    m("NetworkBytesOut", "Sum", Bytes),
    m("ThrottledCmds", "Sum", Count),
    m("SuccessfulReadRequestLatency", "Average", Microseconds),
    m("SuccessfulWriteRequestLatency", "Average", Microseconds),
];

const ECS: &[MetricDef] = &[
    m("CPUUtilization", "Average", Percent),
    m("MemoryUtilization", "Average", Percent),
    m("CPUReservation", "Average", Percent),
    m("MemoryReservation", "Average", Percent),
];

/// EKS 컨트롤 플레인 지표(쿠버네티스 1.28 이상 클러스터에 쌓인다)
const EKS: &[MetricDef] = &[
    m("apiserver_request_total", "Sum", Count),
    m("apiserver_request_total_4XX", "Sum", Count),
    m("apiserver_request_total_5XX", "Sum", Count),
    m("apiserver_request_total_429", "Sum", Count),
    m("apiserver_request_duration_seconds_GET_P99", "Average", Seconds),
    m("apiserver_request_duration_seconds_LIST_P99", "Average", Seconds),
    m("apiserver_storage_size_bytes", "Maximum", Bytes),
    m("scheduler_pending_pods", "Average", Count),
    m("scheduler_schedule_attempts_UNSCHEDULABLE", "Sum", Count),
];

const DYNAMODB: &[MetricDef] = &[
    m("ConsumedReadCapacityUnits", "Sum", Count),
    m("ConsumedWriteCapacityUnits", "Sum", Count),
    m("ProvisionedReadCapacityUnits", "Average", Count),
    m("ProvisionedWriteCapacityUnits", "Average", Count),
    m("ReadThrottleEvents", "Sum", Count),
    m("WriteThrottleEvents", "Sum", Count),
];

const LOGS: &[MetricDef] = &[m("IncomingBytes", "Sum", Bytes), m("IncomingLogEvents", "Sum", Count)];

const CLOUDFRONT: &[MetricDef] = &[
    m("Requests", "Sum", Count),
    m("BytesDownloaded", "Sum", Bytes),
    m("BytesUploaded", "Sum", Bytes),
    m("TotalErrorRate", "Average", Percent),
    m("4xxErrorRate", "Average", Percent),
    m("5xxErrorRate", "Average", Percent),
];

const SQS: &[MetricDef] = &[
    m("ApproximateNumberOfMessagesVisible", "Maximum", Count),
    m("ApproximateNumberOfMessagesNotVisible", "Maximum", Count),
    m("ApproximateAgeOfOldestMessage", "Maximum", Seconds),
    m("NumberOfMessagesSent", "Sum", Count),
    m("NumberOfMessagesReceived", "Sum", Count),
    m("NumberOfMessagesDeleted", "Sum", Count),
    m("NumberOfEmptyReceives", "Sum", Count),
];

const SNS: &[MetricDef] = &[
    m("NumberOfMessagesPublished", "Sum", Count),
    m("NumberOfNotificationsDelivered", "Sum", Count),
    m("NumberOfNotificationsFailed", "Sum", Count),
    m("NumberOfNotificationsFilteredOut", "Sum", Count),
    m("NumberOfNotificationsFilteredOut-InvalidAttributes", "Sum", Count),
    m("NumberOfNotificationsFilteredOut-InvalidMessageBody", "Sum", Count),
    m("NumberOfNotificationsFilteredOut-NoMessageAttributes", "Sum", Count),
    m("NumberOfNotificationsRedrivenToDlq", "Sum", Count),
    m("NumberOfNotificationsFailedToRedriveToDlq", "Sum", Count),
    m("PublishSize", "Average", Bytes),
];

const ECR: &[MetricDef] = &[m("RepositoryPullCount", "Sum", Count)];

/// 공개 호스팅 영역에만 쌓인다
const ROUTE53: &[MetricDef] = &[m("DNSQueries", "Sum", Count)];

/// 지표를 붙이는 (서비스, 리소스 종류). 클러스터 구성원 종류(RDS 인스턴스, ElastiCache 노드)는 클러스터에 속하지 않은 것만 그린다
pub const SUPPORTED: &[(&str, &str)] = &[
    ("ec2", "instances"),
    ("s3", "buckets"),
    ("lambda", "functions"),
    ("rds", "db-clusters"),
    ("rds", "db-instances"),
    ("elasticache", "replication-groups"),
    ("elasticache", "serverless-caches"),
    ("elasticache", "cache-clusters"),
    ("ecs", "clusters"),
    ("eks", "clusters"),
    ("dynamodb", "tables"),
    ("logs", "log-groups"),
    ("cloudfront", "distributions"),
    ("sqs", "queues"),
    ("sns", "topics"),
    ("ecr", "repositories"),
    ("route53", "hosted-zones"),
];

/// 이 서비스에서 지표를 붙이는 종류들
pub fn supported_types(service: &str) -> Vec<&'static str> {
    SUPPORTED.iter().filter(|(s, _)| *s == service).map(|(_, t)| *t).collect()
}

/// 화면이 보내는 목록 행(차원을 만드는 데 필요한 것만)
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MetricRow {
    pub id: String,
    pub name: String,
    pub values: BTreeMap<String, String>,
}

/// 선 하나의 이름과 차원
#[derive(Debug, Clone, PartialEq)]
pub struct SeriesDims {
    pub label: String,
    pub dims: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub namespace: &'static str,
    /// 리소스의 리전과 다른 곳에 쌓이는 지표(CloudFront·Route 53은 us-east-1, S3는 버킷의 리전)
    pub region: Option<String>,
    pub series: Vec<SeriesDims>,
    pub metrics: &'static [MetricDef],
    /// 하루에 한 번 쌓이는 지표(S3 저장량): 기간과 상관없이 최근 2주를 하루 간격으로 읽는다
    pub daily: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Planned {
    Metrics(Plan),
    /// 지표 대신 보이는 안내(클러스터 구성원 …)
    Note(String),
}

fn one(label: &str, dims: &[(&str, &str)]) -> Vec<SeriesDims> {
    vec![SeriesDims { label: label.to_string(), dims: dims.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }]
}

fn plan(namespace: &'static str, series: Vec<SeriesDims>, metrics: &'static [MetricDef]) -> Planned {
    Planned::Metrics(Plan { namespace, region: None, series, metrics, daily: false })
}

/// 이 행에 붙일 지표. 지표를 붙이지 않는 종류면 `None`
pub fn plan_for(service: &str, type_id: &str, row: &MetricRow) -> Option<Planned> {
    let value = |key: &str| row.values.get(key).map(String::as_str).unwrap_or("").trim();
    let id = row.id.as_str();
    Some(match (service, type_id) {
        ("ec2", "instances") => plan("AWS/EC2", one("", &[("InstanceId", id)]), EC2),
        ("s3", "buckets") => {
            let region = Some(value("region")).filter(|r| !r.is_empty()).map(str::to_string);
            Planned::Metrics(Plan { namespace: "AWS/S3", region, series: one("", &[("BucketName", id)]), metrics: S3, daily: true })
        }
        ("lambda", "functions") => plan("AWS/Lambda", one("", &[("FunctionName", id)]), LAMBDA),
        ("rds", "db-clusters") => plan("AWS/RDS", one("", &[("DBClusterIdentifier", id)]), RDS_CLUSTER),
        ("rds", "db-instances") => match value("cluster") {
            "" => plan("AWS/RDS", one("", &[("DBInstanceIdentifier", id)]), RDS_INSTANCE),
            cluster => Planned::Note(format!("이 인스턴스는 클러스터 {cluster}에 속해요. 지표는 RDS → DB Clusters의 {cluster} 상세에서 보여요")),
        },
        ("elasticache", "replication-groups") => {
            let members: Vec<&str> = value("members").split(',').map(str::trim).filter(|m| !m.is_empty()).collect();
            if members.is_empty() {
                return Some(Planned::Note("멤버 노드가 없어 지표를 읽을 수 없어요".into()));
            }
            let series = members.iter().map(|m| SeriesDims { label: m.to_string(), dims: vec![("CacheClusterId".into(), m.to_string())] }).collect();
            plan("AWS/ElastiCache", series, ELASTICACHE_NODE)
        }
        ("elasticache", "cache-clusters") => match value("group") {
            "" => plan("AWS/ElastiCache", one("", &[("CacheClusterId", id)]), ELASTICACHE_NODE),
            group => Planned::Note(format!("이 노드는 복제 그룹 {group}에 속해요. 지표는 ElastiCache → Replication Groups의 {group} 상세에서 노드별로 보여요")),
        },
        ("elasticache", "serverless-caches") => plan("AWS/ElastiCache", one("", &[("clusterId", id)]), ELASTICACHE_SERVERLESS),
        ("ecs", "clusters") => plan("AWS/ECS", one("", &[("ClusterName", id)]), ECS),
        ("eks", "clusters") => plan("AWS/EKS", one("", &[("ClusterName", id)]), EKS),
        ("dynamodb", "tables") => plan("AWS/DynamoDB", one("", &[("TableName", id)]), DYNAMODB),
        ("logs", "log-groups") => plan("AWS/Logs", one("", &[("LogGroupName", id)]), LOGS),
        ("cloudfront", "distributions") => Planned::Metrics(Plan {
            namespace: "AWS/CloudFront",
            region: Some(GLOBAL_REGION.into()),
            series: one("", &[("DistributionId", id), ("Region", "Global")]),
            metrics: CLOUDFRONT,
            daily: false,
        }),
        // SQS 행의 ID는 큐 URL이고, SNS 행의 ID는 주제 ARN이다: 차원은 이름이다
        ("sqs", "queues") => plan("AWS/SQS", one("", &[("QueueName", row.name.as_str())]), SQS),
        ("sns", "topics") => plan("AWS/SNS", one("", &[("TopicName", row.name.as_str())]), SNS),
        ("ecr", "repositories") => plan("AWS/ECR", one("", &[("RepositoryName", id)]), ECR),
        ("route53", "hosted-zones") => Planned::Metrics(Plan {
            namespace: "AWS/Route53",
            region: Some(GLOBAL_REGION.into()),
            series: one("", &[("HostedZoneId", id)]),
            metrics: ROUTE53,
            daily: false,
        }),
        _ => return None,
    })
}

/// 화면에서 고르는 기간
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum MetricRange {
    #[serde(rename = "1h")]
    Hour1,
    #[serde(rename = "3h")]
    Hour3,
    #[serde(rename = "12h")]
    Hour12,
    #[serde(rename = "1d")]
    Day1,
    #[serde(rename = "3d")]
    Day3,
    #[serde(rename = "1w")]
    Week1,
}

impl MetricRange {
    /// (길이, 점 사이 간격) 초. 한 선이 약 60~300점이 되게 둔다. 기본 모니터링 지표는 5분 간격이라 짧은 간격에는 점이 듬성하다
    pub fn window(self) -> (i64, i32) {
        match self {
            MetricRange::Hour1 => (3_600, 60),
            MetricRange::Hour3 => (3 * 3_600, 60),
            MetricRange::Hour12 => (12 * 3_600, 300),
            MetricRange::Day1 => (86_400, 300),
            MetricRange::Day3 => (3 * 86_400, 900),
            MetricRange::Week1 => (7 * 86_400, 3_600),
        }
    }
}

/// 하루 지표(S3)의 길이와 간격: 최근 2주, 하루
pub const DAILY_WINDOW: (i64, i32) = (14 * 86_400, 86_400);
