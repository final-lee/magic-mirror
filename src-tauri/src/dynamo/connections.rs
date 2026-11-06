//! 테이블의 연결: 스트림 소비자(Lambda 이벤트 소스 매핑·EventBridge Pipes), Kinesis 대상, 글로벌 테이블 복제본과 그 지연.
//! 읽기만 한다: `dynamodb:DescribeTable`·`DescribeKinesisStreamingDestination`, `lambda:ListEventSourceMappings`, `pipes:ListPipes`, `cloudwatch:GetMetricData`.
//! 한 부분을 읽지 못해도(권한 없음 등) 나머지는 돌려주고 그 부분을 `gaps`에 적는다. 다른 리전의 복제본은 읽지 않는다(지표는 이 리전 CloudWatch에서).

use aws_config::SdkConfig;
use aws_sdk_cloudwatch::primitives::DateTime;
use aws_sdk_cloudwatch::types::{Dimension, Metric, MetricDataQuery, MetricStat};
use aws_sdk_lambda::types::EventSourceMappingConfiguration;
use serde::Serialize;

use super::health::{connection_findings, ConnectionHealth, EsmHealth};
use super::read::parse_table;
use super::{Finding, Gap, Replica, StreamSpec};
use crate::error::{from_sdk, AppError};
use crate::iam::clock::now_secs;

/// 함수별 `IteratorAge`를 보는 구간(초): 최근 15분의 최댓값
const ITERATOR_AGE_WINDOW_SECS: i64 = 900;
/// 복제 지연을 보는 구간(초): 최근 1시간의 평균
const REPLICATION_LATENCY_WINDOW_SECS: i64 = 3_600;
/// 지표 샘플 간격(초)
const METRIC_PERIOD_SECS: i32 = 60;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connections {
    pub stream: Option<StreamSpec>,
    pub esms: Vec<Esm>,
    pub pipes: Vec<Pipe>,
    pub kinesis: Vec<Kinesis>,
    pub replicas: Vec<ReplicaConnection>,
    /// 읽지 못한 부분. `section`은 `lambda` · `pipes` · `kinesis` · `iteratorAge` · `replicationLatency`
    pub gaps: Vec<Gap>,
    pub findings: Vec<Finding>,
}

/// Lambda 이벤트 소스 매핑 하나
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Esm {
    pub id: String,
    /// 함수 ARN(별칭·버전이 붙을 수 있다)
    pub function: String,
    pub state: String,
    pub batch_size: Option<i32>,
    pub starting_position: Option<String>,
    pub parallelization: Option<i32>,
    pub bisect: Option<bool>,
    /// -1은 무제한
    pub retries: Option<i32>,
    pub max_age: Option<i32>,
    pub failure_destination: Option<String>,
    pub filters: Vec<String>,
    /// 함수의 최근 15분 `IteratorAge` 최댓값(밀리초). 지표가 없으면 None
    pub iterator_age_ms: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pipe {
    pub name: String,
    pub state: String,
    pub target: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kinesis {
    pub arn: String,
    pub state: String,
    pub precision: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaConnection {
    #[serde(flatten)]
    pub replica: Replica,
    /// 받는 리전 기준 최근 1시간 `ReplicationLatency` 평균(밀리초). 지표가 없으면 None
    pub latency_ms: Option<f64>,
}

// 순수 해석 ------------------------------------------------------------------------------------

/// 함수 ARN에서 함수 이름만. 별칭·버전(`:live`)은 떼고, ARN이 아니면 그대로 돌려준다
fn function_name(function_arn: &str) -> &str {
    let after_function = function_arn.split(":function:").nth(1).unwrap_or(function_arn);
    after_function.split(':').next().unwrap_or_default()
}

fn esm_from(mapping: &EventSourceMappingConfiguration) -> Esm {
    let failure_destination = mapping.destination_config().and_then(|config| config.on_failure()).and_then(|on_failure| on_failure.destination());
    let filters = mapping.filter_criteria().map(|criteria| criteria.filters().iter().filter_map(|filter| filter.pattern().map(str::to_string)).collect());
    Esm {
        id: mapping.uuid().unwrap_or_default().to_string(),
        function: mapping.function_arn().unwrap_or_default().to_string(),
        state: mapping.state().unwrap_or_default().to_string(),
        batch_size: mapping.batch_size(),
        starting_position: mapping.starting_position().map(|position| position.as_str().to_string()),
        parallelization: mapping.parallelization_factor(),
        bisect: mapping.bisect_batch_on_function_error(),
        retries: mapping.maximum_retry_attempts(),
        max_age: mapping.maximum_record_age_in_seconds(),
        failure_destination: failure_destination.map(str::to_string),
        filters: filters.unwrap_or_default(),
        iterator_age_ms: None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Statistic {
    Maximum,
    Average,
}

impl Statistic {
    fn as_str(self) -> &'static str {
        match self {
            Statistic::Maximum => "Maximum",
            Statistic::Average => "Average",
        }
    }
}

/// 구간의 샘플을 하나로 줄인다. 샘플이 없으면 None(지표가 없는 것이지 0이 아니다)
fn aggregate(values: &[f64], statistic: Statistic) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    Some(match statistic {
        Statistic::Maximum => values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        Statistic::Average => values.iter().sum::<f64>() / values.len() as f64,
    })
}

/// 읽은 연결을 진단 입력으로. 소비자 수는 소비자 출처(Lambda·Pipes·Kinesis)를 모두 읽었을 때만 알 수 있다:
/// 하나라도 읽지 못했으면 없다고 단정할 수 없어서 None이고, 그러면 `streamNoConsumer`를 내지 않는다
fn connection_health(connections: &Connections, consumers_complete: bool) -> ConnectionHealth {
    let consumer_count = connections.esms.len() + connections.pipes.len() + connections.kinesis.len();
    ConnectionHealth {
        stream_enabled: connections.stream.is_some(),
        consumer_count: consumers_complete.then_some(consumer_count),
        esms: connections
            .esms
            .iter()
            .map(|esm| EsmHealth {
                function: esm.function.clone(),
                state: esm.state.clone(),
                iterator_age_ms: esm.iterator_age_ms,
                max_retries: esm.retries,
                has_failure_destination: esm.failure_destination.is_some(),
            })
            .collect(),
        replication_latency_ms: connections.replicas.iter().filter_map(|replica| replica.latency_ms.map(|latency| (replica.replica.region.clone(), latency))).collect(),
    }
}

/// 읽기 결과를 받는다. 실패하면 `gaps`에 적고 None을 돌려준다(같은 부분은 한 번만 적는다).
/// SSO 세션이 끝났으면 나머지도 모두 실패할 테니 그대로 올려 보낸다
fn read_or_gap<T>(gaps: &mut Vec<Gap>, section: &str, result: Result<T, AppError>) -> Result<Option<T>, AppError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(AppError::SsoExpired) => Err(AppError::SsoExpired),
        Err(error) => {
            if gaps.iter().all(|gap| gap.section != section) {
                gaps.push(Gap { section: section.to_string(), error: error.to_string() });
            }
            Ok(None)
        }
    }
}

// AWS 호출 -------------------------------------------------------------------------------------

async fn list_esms(cfg: &SdkConfig, stream_arn: &str) -> Result<Vec<Esm>, AppError> {
    let client = aws_sdk_lambda::Client::new(cfg);
    let mut esms = Vec::new();
    let mut marker = None;
    loop {
        let page = client
            .list_event_source_mappings()
            .event_source_arn(stream_arn)
            .set_marker(marker)
            .send()
            .await
            .map_err(|e| from_sdk(e, "lambda:ListEventSourceMappings"))?;
        esms.extend(page.event_source_mappings().iter().map(esm_from));
        marker = page.next_marker().map(str::to_string);
        if marker.is_none() {
            return Ok(esms);
        }
    }
}

async fn list_pipes(cfg: &SdkConfig, stream_arn: &str) -> Result<Vec<Pipe>, AppError> {
    let client = aws_sdk_pipes::Client::new(cfg);
    let mut pipes = Vec::new();
    let mut token = None;
    loop {
        let page = client.list_pipes().source_prefix(stream_arn).set_next_token(token).send().await.map_err(|e| from_sdk(e, "pipes:ListPipes"))?;
        // 접두사로 찾으므로 이 스트림이 소스인 파이프만 남긴다
        for pipe in page.pipes().iter().filter(|pipe| pipe.source() == Some(stream_arn)) {
            pipes.push(Pipe {
                name: pipe.name().unwrap_or_default().to_string(),
                state: pipe.current_state().map(|state| state.as_str()).unwrap_or_default().to_string(),
                target: pipe.target().unwrap_or_default().to_string(),
            });
        }
        token = page.next_token().map(str::to_string);
        if token.is_none() {
            return Ok(pipes);
        }
    }
}

async fn list_kinesis(db: &aws_sdk_dynamodb::Client, table: &str) -> Result<Vec<Kinesis>, AppError> {
    let output = db.describe_kinesis_streaming_destination().table_name(table).send().await.map_err(|e| from_sdk(e, "dynamodb:DescribeKinesisStreamingDestination"))?;
    let destinations = output.kinesis_data_stream_destinations().iter().map(|destination| Kinesis {
        arn: destination.stream_arn().unwrap_or_default().to_string(),
        state: destination.destination_status().map(|status| status.as_str()).unwrap_or_default().to_string(),
        precision: destination.approximate_creation_date_time_precision().map(|precision| precision.as_str().to_string()),
    });
    Ok(destinations.collect())
}

/// 지표 하나를 최근 `window_secs`초 동안 읽어 하나로 줄인다
async fn read_metric(cfg: &SdkConfig, namespace: &str, name: &str, dimensions: &[(&str, &str)], statistic: Statistic, window_secs: i64) -> Result<Option<f64>, AppError> {
    let dimensions = dimensions.iter().map(|(key, value)| Dimension::builder().name(*key).value(*value).build()).collect();
    let metric = Metric::builder().namespace(namespace).metric_name(name).set_dimensions(Some(dimensions)).build();
    let stat = MetricStat::builder().metric(metric).period(METRIC_PERIOD_SECS).stat(statistic.as_str()).build();
    let query = MetricDataQuery::builder().id("m0").metric_stat(stat).return_data(true).build();
    let now = now_secs();
    let output = aws_sdk_cloudwatch::Client::new(cfg)
        .get_metric_data()
        .metric_data_queries(query)
        .start_time(DateTime::from_secs(now - window_secs))
        .end_time(DateTime::from_secs(now))
        .send()
        .await
        .map_err(|e| from_sdk(e, "cloudwatch:GetMetricData"))?;
    let values = output.metric_data_results().first().map(|result| result.values()).unwrap_or_default();
    Ok(aggregate(values, statistic))
}

/// 테이블의 연결을 읽는다. 읽지 못한 부분은 `gaps`에 적고 나머지로 그린다
pub async fn read(cfg: &SdkConfig, table: &str) -> Result<Connections, AppError> {
    let db = aws_sdk_dynamodb::Client::new(cfg);
    let description = db.describe_table().table_name(table).send().await.map_err(|e| from_sdk(e, "dynamodb:DescribeTable"))?;
    let table_info = parse_table(description.table().ok_or_else(|| AppError::other("테이블 설명이 없어요"))?);
    let mut gaps = Vec::new();
    // 소비자 출처를 하나라도 읽지 못하면 소비자가 없다고 단정하지 않는다
    let mut consumers_complete = true;

    let mut esms = Vec::new();
    let mut pipes = Vec::new();
    if let Some(stream) = &table_info.stream {
        match read_or_gap(&mut gaps, "lambda", list_esms(cfg, &stream.arn).await)? {
            Some(found) => esms = found,
            None => consumers_complete = false,
        }
        match read_or_gap(&mut gaps, "pipes", list_pipes(cfg, &stream.arn).await)? {
            Some(found) => pipes = found,
            None => consumers_complete = false,
        }
    }
    let mut kinesis = Vec::new();
    match read_or_gap(&mut gaps, "kinesis", list_kinesis(&db, table).await)? {
        Some(found) => kinesis = found,
        None => consumers_complete = false,
    }

    for esm in &mut esms {
        let dimensions = [("FunctionName", function_name(&esm.function))];
        let age = read_metric(cfg, "AWS/Lambda", "IteratorAge", &dimensions, Statistic::Maximum, ITERATOR_AGE_WINDOW_SECS).await;
        esm.iterator_age_ms = read_or_gap(&mut gaps, "iteratorAge", age)?.flatten();
    }

    let mut replicas = Vec::new();
    for replica in table_info.replicas {
        let dimensions = [("TableName", table), ("ReceivingRegion", replica.region.as_str())];
        let latency = read_metric(cfg, "AWS/DynamoDB", "ReplicationLatency", &dimensions, Statistic::Average, REPLICATION_LATENCY_WINDOW_SECS).await;
        let latency_ms = read_or_gap(&mut gaps, "replicationLatency", latency)?.flatten();
        replicas.push(ReplicaConnection { replica, latency_ms });
    }

    let mut connections = Connections { stream: table_info.stream, esms, pipes, kinesis, replicas, gaps, findings: Vec::new() };
    connections.findings = connection_findings(&connection_health(&connections, consumers_complete));
    Ok(connections)
}

#[cfg(test)]
mod tests;
