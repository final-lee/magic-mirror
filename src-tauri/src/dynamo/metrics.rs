//! 테이블·GSI의 CloudWatch 지표. 리전의 대상 전체를 `GetMetricData`로 한 번에 읽는다(읽기 전용, 질의 500개를 넘으면 나눠서).
//! 최근 24시간을 한 번에 읽고, 스로틀은 그중 최근 1시간만 합한다. 소비·프로비저닝은 프로비저닝 대상만 읽는다.

use std::collections::HashMap;

use aws_config::SdkConfig;
use aws_sdk_cloudwatch::primitives::DateTime;
use aws_sdk_cloudwatch::types::{Dimension, Metric, MetricDataQuery, MetricStat};

use super::{Capacity, TableMetrics, UsageMetrics};
use crate::error::{from_sdk, AppError};

const NAMESPACE: &str = "AWS/DynamoDB";
/// 읽는 구간(초): 소비·프로비저닝 24시간
pub const WINDOW_SECS: i64 = 86_400;
/// 스로틀을 합하는 구간(초): 1시간
pub const THROTTLE_WINDOW_SECS: i64 = 3_600;
/// 기간(초): 분당 합을 보려고 1분이다. 스로틀 지표는 사건이 있을 때만 점이 있어 많지 않다
const PERIOD_SECS: i32 = 60;
/// `GetMetricData` 한 번의 질의 한도
const MAX_QUERIES: usize = 500;

/// 지표를 읽을 대상 하나: 테이블 또는 그 GSI
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub table: String,
    pub index: Option<String>,
    /// 프로비저닝이면 소비·프로비저닝 지표도 읽는다
    pub provisioned: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    ReadThrottle,
    WriteThrottle,
    ConsumedRead,
    ConsumedWrite,
    ProvisionedRead,
    ProvisionedWrite,
}

impl Kind {
    const THROTTLES: [Kind; 2] = [Kind::ReadThrottle, Kind::WriteThrottle];
    const CAPACITY: [Kind; 4] = [Kind::ConsumedRead, Kind::ConsumedWrite, Kind::ProvisionedRead, Kind::ProvisionedWrite];

    fn metric(self) -> &'static str {
        match self {
            Kind::ReadThrottle => "ReadThrottleEvents",
            Kind::WriteThrottle => "WriteThrottleEvents",
            Kind::ConsumedRead => "ConsumedReadCapacityUnits",
            Kind::ConsumedWrite => "ConsumedWriteCapacityUnits",
            Kind::ProvisionedRead => "ProvisionedReadCapacityUnits",
            Kind::ProvisionedWrite => "ProvisionedWriteCapacityUnits",
        }
    }

    fn stat(self) -> &'static str {
        match self {
            Kind::ProvisionedRead | Kind::ProvisionedWrite => "Average",
            _ => "Sum",
        }
    }

    fn code(self) -> &'static str {
        match self {
            Kind::ReadThrottle => "rt",
            Kind::WriteThrottle => "wt",
            Kind::ConsumedRead => "cr",
            Kind::ConsumedWrite => "cw",
            Kind::ProvisionedRead => "pr",
            Kind::ProvisionedWrite => "pw",
        }
    }
}

/// 쿼리 ID: 대상 순번과 지표 종류(소문자로 시작해야 한다)
fn query_id(target: usize, kind: Kind) -> String {
    format!("t{target}_{}", kind.code())
}

fn kinds(target: &Target) -> Vec<Kind> {
    let mut out = Kind::THROTTLES.to_vec();
    if target.provisioned {
        out.extend(Kind::CAPACITY);
    }
    out
}

fn queries(targets: &[Target]) -> Vec<MetricDataQuery> {
    let mut out = Vec::new();
    for (i, target) in targets.iter().enumerate() {
        let mut dims = vec![Dimension::builder().name("TableName").value(&target.table).build()];
        if let Some(index) = &target.index {
            dims.push(Dimension::builder().name("GlobalSecondaryIndexName").value(index).build());
        }
        for kind in kinds(target) {
            let metric = Metric::builder().namespace(NAMESPACE).metric_name(kind.metric()).set_dimensions(Some(dims.clone())).build();
            let stat = MetricStat::builder().metric(metric).period(PERIOD_SECS).stat(kind.stat()).build();
            out.push(MetricDataQuery::builder().id(query_id(i, kind)).metric_stat(stat).return_data(true).build());
        }
    }
    out
}

/// 시각(초)과 값
type Points = Vec<(i64, f64)>;

fn max_of(points: &[(i64, f64)]) -> f64 {
    points.iter().map(|(_, v)| *v).fold(0.0, f64::max)
}

/// 소비(분당 합)와 같은 분의 프로비저닝(분 평균)을 맞춰 용량 지표를 만든다. 값 없음은 사용이 없었다는 뜻이다(CloudWatch는 0을 보내지 않는다)
fn capacity(consumed: &[(i64, f64)], provisioned: &[(i64, f64)]) -> Capacity {
    let provisioned: HashMap<i64, f64> = provisioned.iter().copied().collect();
    let peak_utilization = consumed
        .iter()
        .filter_map(|(at, v)| provisioned.get(at).filter(|p| **p > 0.0).map(|p| (v / PERIOD_SECS as f64) / p))
        .fold(None, |best: Option<f64>, u| Some(best.map_or(u, |b| b.max(u))));
    Capacity { peak_consumed: max_of(consumed) / PERIOD_SECS as f64, peak_utilization }
}

fn usage(target: usize, points: &HashMap<String, Points>, provisioned: bool, now: i64) -> UsageMetrics {
    let get = |kind: Kind| points.get(&query_id(target, kind)).map(Vec::as_slice).unwrap_or_default();
    let since = now - THROTTLE_WINDOW_SECS;
    let throttle = |kind: Kind| get(kind).iter().filter(|(at, _)| *at >= since).map(|(_, v)| v).sum::<f64>();
    UsageMetrics {
        read_throttle: throttle(Kind::ReadThrottle),
        write_throttle: throttle(Kind::WriteThrottle),
        read: provisioned.then(|| capacity(get(Kind::ConsumedRead), get(Kind::ProvisionedRead))),
        write: provisioned.then(|| capacity(get(Kind::ConsumedWrite), get(Kind::ProvisionedWrite))),
    }
}

/// 질의 결과(쿼리 ID → 점들)를 테이블 이름별 지표로 묶는다
fn collect(targets: &[Target], points: &HashMap<String, Points>, now: i64) -> HashMap<String, TableMetrics> {
    let mut out: HashMap<String, TableMetrics> = HashMap::new();
    for (i, target) in targets.iter().enumerate() {
        let u = usage(i, points, target.provisioned, now);
        let entry = out.entry(target.table.clone()).or_default();
        match &target.index {
            Some(index) => {
                entry.indexes.insert(index.clone(), u);
            }
            None => entry.table = u,
        }
    }
    out
}

/// 테이블과 GSI의 지표. 대상이 많으면 질의 500개씩 나눠 읽는다
pub async fn read(cfg: &SdkConfig, targets: &[Target], now: i64) -> Result<HashMap<String, TableMetrics>, AppError> {
    let client = aws_sdk_cloudwatch::Client::new(cfg);
    // 분 경계에 맞춘다: 소비와 프로비저닝의 같은 분을 맞춰 보려면 두 지표의 점이 같은 분 시각을 가져야 한다
    let end = now - now % 60 + 60;
    let start = end - WINDOW_SECS;
    let mut points: HashMap<String, Points> = HashMap::new();
    for chunk in queries(targets).chunks(MAX_QUERIES) {
        let mut token: Option<String> = None;
        loop {
            let reply = client
                .get_metric_data()
                .set_metric_data_queries(Some(chunk.to_vec()))
                .start_time(DateTime::from_secs(start))
                .end_time(DateTime::from_secs(end))
                .set_next_token(token.take())
                .send()
                .await
                .map_err(|e| from_sdk(e, "cloudwatch:GetMetricData"))?;
            for result in reply.metric_data_results() {
                if let Some(id) = result.id() {
                    let entry = points.entry(id.to_string()).or_default();
                    entry.extend(result.timestamps().iter().map(|t| t.secs()).zip(result.values().iter().copied()));
                }
            }
            token = reply.next_token().map(str::to_string);
            if token.is_none() {
                break;
            }
        }
    }
    Ok(collect(targets, &points, now))
}

/// 테이블 하나의 지표 대상: 테이블 자체와 GSI들. 온디맨드 테이블은 소비·프로비저닝을 읽지 않는다
pub fn targets_of(table: &super::DynamoTable) -> Vec<Target> {
    let provisioned = table.billing.mode == super::BillingMode::Provisioned;
    let mut out = vec![Target { table: table.name.clone(), index: None, provisioned }];
    out.extend(table.indexes.iter().filter(|i| i.kind == super::IndexKind::Gsi).map(|i| Target { table: table.name.clone(), index: Some(i.name.clone()), provisioned: provisioned && i.read.is_some() }));
    out
}

#[cfg(test)]
mod tests;
