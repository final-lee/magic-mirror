//! 큐의 최근 15분 CloudWatch 활동. 리전의 큐 전체를 `GetMetricData`로 읽는다(읽기 전용, 질의 500개를 넘으면 나눠서).

use std::collections::HashMap;

use aws_config::SdkConfig;
use aws_sdk_cloudwatch::primitives::DateTime;
use aws_sdk_cloudwatch::types::{Dimension, Metric, MetricDataQuery, MetricStat};

use super::SqsActivity;
use crate::error::{from_sdk, AppError};

const NAMESPACE: &str = "AWS/SQS";
/// 읽는 구간과 기간(초)
const WINDOW_SECS: i64 = 900;
const PERIOD_SECS: i32 = 900;
/// `GetMetricData` 한 번의 질의 한도
const MAX_QUERIES: usize = 500;
/// 큐마다 질의: 가장 오래된 나이, 받은 수, 빈 수신 수
const QUERIES_PER_QUEUE: usize = 3;

/// 한 호출에 담을 큐 수
pub const QUEUES_PER_CALL: usize = MAX_QUERIES / QUERIES_PER_QUEUE;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    OldestAge,
    Received,
    EmptyReceives,
}

impl Kind {
    const ALL: [Kind; 3] = [Kind::OldestAge, Kind::Received, Kind::EmptyReceives];

    fn metric(self) -> &'static str {
        match self {
            Kind::OldestAge => "ApproximateAgeOfOldestMessage",
            Kind::Received => "NumberOfMessagesReceived",
            Kind::EmptyReceives => "NumberOfEmptyReceives",
        }
    }

    fn stat(self) -> &'static str {
        match self {
            Kind::OldestAge => "Maximum",
            Kind::Received | Kind::EmptyReceives => "Sum",
        }
    }

    fn prefix(self) -> char {
        match self {
            Kind::OldestAge => 'a',
            Kind::Received => 'r',
            Kind::EmptyReceives => 'e',
        }
    }
}

/// 쿼리 ID: 지표 종류 글자와 큐 순번(소문자로 시작해야 한다)
fn query_id(kind: Kind, queue: usize) -> String {
    format!("{}{queue}", kind.prefix())
}

fn queries(names: &[String]) -> Vec<MetricDataQuery> {
    let mut out = Vec::new();
    for (i, name) in names.iter().enumerate() {
        for kind in Kind::ALL {
            let metric = Metric::builder()
                .namespace(NAMESPACE)
                .metric_name(kind.metric())
                .dimensions(Dimension::builder().name("QueueName").value(name).build())
                .build();
            let stat = MetricStat::builder().metric(metric).period(PERIOD_SECS).stat(kind.stat()).build();
            out.push(MetricDataQuery::builder().id(query_id(kind, i)).metric_stat(stat).return_data(true).build());
        }
    }
    out
}

/// 구간의 점들을 하나로 합친다: 가장 오래된 나이는 최댓값, 나머지는 합. 점이 없으면 None(0이 아니다)
fn fold(kind: Kind, values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    Some(match kind {
        Kind::OldestAge => values.iter().copied().fold(f64::MIN, f64::max),
        Kind::Received | Kind::EmptyReceives => values.iter().sum(),
    })
}

/// 질의 결과(쿼리 ID → 점들)를 큐 이름별 활동으로 묶는다
fn collect(names: &[String], points: &HashMap<String, Vec<f64>>) -> HashMap<String, SqsActivity> {
    names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let get = |kind: Kind| points.get(&query_id(kind, i)).and_then(|v| fold(kind, v));
            (name.clone(), SqsActivity { oldest_age_sec: get(Kind::OldestAge), received15m: get(Kind::Received), empty_receives15m: get(Kind::EmptyReceives) })
        })
        .collect()
}

/// 큐 이름들의 최근 15분 활동. 큐가 많으면 나눠서 읽는다
pub async fn read(cfg: &SdkConfig, names: &[String], now_secs: i64) -> Result<HashMap<String, SqsActivity>, AppError> {
    let client = aws_sdk_cloudwatch::Client::new(cfg);
    let mut out = HashMap::new();
    for chunk in names.chunks(QUEUES_PER_CALL) {
        let mut points: HashMap<String, Vec<f64>> = HashMap::new();
        let mut token: Option<String> = None;
        loop {
            let reply = client
                .get_metric_data()
                .set_metric_data_queries(Some(queries(chunk)))
                .start_time(DateTime::from_secs(now_secs - WINDOW_SECS))
                .end_time(DateTime::from_secs(now_secs))
                .set_next_token(token.take())
                .send()
                .await
                .map_err(|e| from_sdk(e, "cloudwatch:GetMetricData"))?;
            for result in reply.metric_data_results() {
                if let Some(id) = result.id() {
                    points.entry(id.to_string()).or_default().extend(result.values().iter().copied());
                }
            }
            token = reply.next_token().map(str::to_string);
            if token.is_none() {
                break;
            }
        }
        out.extend(collect(chunk, &points));
    }
    Ok(out)
}

/// 큐 하나의 최근 15분 받은 메시지 수. 지표가 없으면 None
pub async fn received_15m(cfg: &SdkConfig, name: &str, now_secs: i64) -> Result<Option<f64>, AppError> {
    let mut read = read(cfg, &[name.to_string()], now_secs).await?;
    Ok(read.remove(name).and_then(|a| a.received15m))
}

#[cfg(test)]
mod tests;
