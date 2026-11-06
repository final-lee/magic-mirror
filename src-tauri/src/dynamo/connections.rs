use aws_config::SdkConfig;
use aws_sdk_cloudwatch::{primitives::DateTime, types::{Dimension, Metric, MetricDataQuery, MetricStat}};
use serde::Serialize;
use super::{Finding, Gap, Replica, StreamSpec, health::{connection_findings, ConnectionHealth, EsmHealth}, read::parse_table};
use crate::{error::{AppError, from_sdk}, iam::clock::now_secs};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connections { pub stream: Option<StreamSpec>, pub esms: Vec<Esm>, pub pipes: Vec<Pipe>, pub kinesis: Vec<Kinesis>, pub replicas: Vec<ReplicaConnection>, pub gaps: Vec<Gap>, pub findings: Vec<Finding> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Esm { pub id: String, pub function: String, pub state: String, pub batch_size: Option<i32>, pub starting_position: Option<String>, pub parallelization: Option<i32>, pub bisect: Option<bool>, pub retries: Option<i32>, pub max_age: Option<i32>, pub failure_destination: Option<String>, pub filters: Vec<String>, pub iterator_age_ms: Option<f64> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pipe { pub name: String, pub state: String, pub target: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kinesis { pub arn: String, pub state: String, pub precision: Option<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaConnection { #[serde(flatten)] pub replica: Replica, pub latency_ms: Option<f64> }
fn gap(gaps: &mut Vec<Gap>, section: &str, error: AppError) -> Result<(), AppError> {
    if error == AppError::SsoExpired { return Err(error); }
    gaps.push(Gap { section: section.into(), error: error.to_string() }); Ok(())
}
async fn metric(cfg: &SdkConfig, namespace: &str, name: &str, dimensions: &[(&str, &str)], stat: &str, window: i64) -> Result<Option<f64>, AppError> {
    let dims = dimensions.iter().map(|(k,v)| Dimension::builder().name(*k).value(*v).build()).collect();
    let m = Metric::builder().namespace(namespace).metric_name(name).set_dimensions(Some(dims)).build();
    let q = MetricDataQuery::builder().id("m0").metric_stat(MetricStat::builder().metric(m).period(60).stat(stat).build()).return_data(true).build();
    let now = now_secs();
    let result = aws_sdk_cloudwatch::Client::new(cfg).get_metric_data().metric_data_queries(q).start_time(DateTime::from_secs(now-window)).end_time(DateTime::from_secs(now)).send().await.map_err(|e| from_sdk(e, "cloudwatch:GetMetricData"))?;
    let values = result.metric_data_results().first().map(|r| r.values()).unwrap_or_default();
    if values.is_empty() { return Ok(None); }
    Ok(Some(if stat == "Maximum" { values.iter().copied().fold(f64::NEG_INFINITY, f64::max) } else { values.iter().sum::<f64>() / values.len() as f64 }))
}
pub async fn read(cfg: &SdkConfig, table: &str) -> Result<Connections, AppError> {
    let db = aws_sdk_dynamodb::Client::new(cfg);
    let description = db.describe_table().table_name(table).send().await.map_err(|e| from_sdk(e, "dynamodb:DescribeTable"))?;
    let table_info = parse_table(description.table().ok_or_else(|| AppError::other("테이블 설명이 없어요"))?);
    let mut out = Connections { stream: table_info.stream, esms: vec![], pipes: vec![], kinesis: vec![], replicas: table_info.replicas.into_iter().map(|replica| ReplicaConnection { replica, latency_ms: None }).collect(), gaps: vec![], findings: vec![] };
    let mut consumers_complete = true;
    if let Some(stream) = &out.stream {
        let client = aws_sdk_lambda::Client::new(cfg); let mut marker = None;
        loop {
            match client.list_event_source_mappings().event_source_arn(&stream.arn).set_marker(marker).send().await {
                Ok(page) => {
                    for m in page.event_source_mappings() {
                        out.esms.push(Esm { id: m.uuid().unwrap_or_default().into(), function: m.function_arn().unwrap_or_default().into(), state: m.state().unwrap_or_default().into(), batch_size: m.batch_size(), starting_position: m.starting_position().map(|x| x.as_str().into()), parallelization: m.parallelization_factor(), bisect: m.bisect_batch_on_function_error(), retries: m.maximum_retry_attempts(), max_age: m.maximum_record_age_in_seconds(), failure_destination: m.destination_config().and_then(|d| d.on_failure()).and_then(|d| d.destination()).map(str::to_string), filters: m.filter_criteria().map(|f| f.filters().iter().filter_map(|f| f.pattern().map(str::to_string)).collect()).unwrap_or_default(), iterator_age_ms: None });
                    }
                    marker = page.next_marker().map(str::to_string); if marker.is_none() { break; }
                }
                Err(e) => { consumers_complete = false; gap(&mut out.gaps, "lambda", from_sdk(e, "lambda:ListEventSourceMappings"))?; break; }
            }
        }
        let client = aws_sdk_pipes::Client::new(cfg); let mut token = None;
        loop {
            match client.list_pipes().source_prefix(&stream.arn).set_next_token(token).send().await {
                Ok(page) => { for p in page.pipes() { if p.source() == Some(stream.arn.as_str()) { out.pipes.push(Pipe { name: p.name().unwrap_or_default().into(), state: p.current_state().map(|s| s.as_str()).unwrap_or_default().into(), target: p.target().unwrap_or_default().into() }); } } token = page.next_token().map(str::to_string); if token.is_none() { break; } }
                Err(e) => { consumers_complete = false; gap(&mut out.gaps, "pipes", from_sdk(e, "pipes:ListPipes"))?; break; }
            }
        }
    }
    match db.describe_kinesis_streaming_destination().table_name(table).send().await {
        Ok(page) => for d in page.kinesis_data_stream_destinations() { out.kinesis.push(Kinesis { arn: d.stream_arn().unwrap_or_default().into(), state: d.destination_status().map(|s| s.as_str()).unwrap_or_default().into(), precision: d.approximate_creation_date_time_precision().map(|s| s.as_str().into()) }); },
        Err(e) => { consumers_complete = false; gap(&mut out.gaps, "kinesis", from_sdk(e, "dynamodb:DescribeKinesisStreamingDestination"))?; }
    }
    for esm in &mut out.esms {
        let function = esm.function.split(":function:").nth(1).unwrap_or(&esm.function).split(':').next().unwrap_or_default();
        match metric(cfg, "AWS/Lambda", "IteratorAge", &[("FunctionName", function)], "Maximum", 900).await { Ok(v) => esm.iterator_age_ms = v, Err(e) => gap(&mut out.gaps, "iteratorAge", e)? }
    }
    for replica in &mut out.replicas {
        match metric(cfg, "AWS/DynamoDB", "ReplicationLatency", &[("TableName", table), ("ReceivingRegion", &replica.replica.region)], "Average", 3600).await { Ok(v) => replica.latency_ms = v, Err(e) => gap(&mut out.gaps, "replicationLatency", e)? }
    }
    let health = ConnectionHealth { stream_enabled: out.stream.is_some(), consumer_count: consumers_complete.then_some(out.esms.len() + out.pipes.len() + out.kinesis.len()), esms: out.esms.iter().map(|e| EsmHealth { function: e.function.clone(), state: e.state.clone(), iterator_age_ms: e.iterator_age_ms, max_retries: e.retries, has_failure_destination: e.failure_destination.is_some() }).collect(), replication_latency_ms: out.replicas.iter().filter_map(|r| r.latency_ms.map(|v| (r.replica.region.clone(), v))).collect() };
    out.findings = connection_findings(&health); Ok(out)
}
