//! 리소스 상세의 CloudWatch 지표. 무엇을 읽을지는 `catalog`가 정하고, 여기서는 `GetMetricData` 한 번(넘치면 이어서)으로 모두 읽는다.
//! 읽기만 한다(`cloudwatch:GetMetricData`). 요청한 지표 1,000개에 $0.01이라 화면이 자동으로 다시 읽지 않는다.

pub mod catalog;

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use aws_config::SdkConfig;
use aws_sdk_cloudwatch::primitives::DateTime;
use aws_sdk_cloudwatch::types::{Dimension, Metric, MetricDataQuery, MetricStat, ScanBy};
use serde::Serialize;

use catalog::{MetricRange, MetricUnit, Plan, DAILY_WINDOW};

use crate::error::{from_sdk, AppError};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricSeries {
    /// 선 이름(복제 그룹의 노드 ID). 선이 하나면 빈 글
    pub label: String,
    /// Unix ms, 오래된 것부터
    pub times: Vec<i64>,
    pub values: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricChart {
    pub metric: String,
    /// `Average`, `Sum`, `Maximum`, `p99` …
    pub stat: String,
    pub unit: MetricUnit,
    pub series: Vec<MetricSeries>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMetrics {
    pub namespace: String,
    /// 지표가 쌓이는 리전
    pub region: String,
    pub charts: Vec<MetricChart>,
    /// 점 사이 간격(초)
    pub period: i32,
    /// 읽은 구간(Unix ms)
    pub start: i64,
    pub end: i64,
    /// 하루 한 번 쌓이는 지표라 기간과 상관없이 최근 2주를 읽었다
    pub daily: bool,
    /// 지표 대신 보이는 안내(클러스터 구성원 …)
    pub note: Option<String>,
}

impl ResourceMetrics {
    pub fn note(note: String) -> ResourceMetrics {
        ResourceMetrics { namespace: String::new(), region: String::new(), charts: vec![], period: 0, start: 0, end: 0, daily: false, note: Some(note) }
    }
}

/// 쿼리 ID: 지표 순번과 선 순번(소문자로 시작해야 한다)
fn query_id(metric: usize, series: usize) -> String {
    format!("m{metric}s{series}")
}

/// 계획의 지표 × 선마다 쿼리 하나
pub fn queries(plan: &Plan, period: i32) -> Vec<MetricDataQuery> {
    let mut out = Vec::new();
    for (i, def) in plan.metrics.iter().enumerate() {
        for (j, series) in plan.series.iter().enumerate() {
            let dims = series.dims.iter().map(|(k, v)| (k.as_str(), v.as_str())).chain(def.extra.iter().copied());
            let metric = Metric::builder()
                .namespace(plan.namespace)
                .metric_name(def.name)
                .set_dimensions(Some(dims.map(|(name, value)| Dimension::builder().name(name).value(value).build()).collect()))
                .build();
            let stat = MetricStat::builder().metric(metric).period(period).stat(def.stat).build();
            out.push(MetricDataQuery::builder().id(query_id(i, j)).metric_stat(stat).return_data(true).build());
        }
    }
    out
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// 계획대로 읽는다. `region`은 계획이 따로 정하지 않았을 때 쓰는 리소스의 리전이다
pub async fn fetch(cfg: &SdkConfig, region: &str, plan: &Plan, range: MetricRange) -> Result<ResourceMetrics, AppError> {
    let (window, period) = if plan.daily { DAILY_WINDOW } else { range.window() };
    // 간격에 맞춰 끝을 자른다: 마지막 칸이 반쯤 찬 값으로 떨어져 보이지 않게
    let end = now_secs() / period as i64 * period as i64;
    let start = end - window;
    let client = aws_sdk_cloudwatch::Client::new(cfg);
    let mut values: HashMap<String, (Vec<i64>, Vec<f64>)> = HashMap::new();
    let mut token: Option<String> = None;
    loop {
        let reply = client
            .get_metric_data()
            .set_metric_data_queries(Some(queries(plan, period)))
            .start_time(DateTime::from_secs(start))
            .end_time(DateTime::from_secs(end))
            .scan_by(ScanBy::TimestampAscending)
            .set_next_token(token.take())
            .send()
            .await
            .map_err(|e| from_sdk(e, "cloudwatch:GetMetricData"))?;
        for result in reply.metric_data_results() {
            let Some(id) = result.id() else { continue };
            let entry = values.entry(id.to_string()).or_default();
            for (time, value) in result.timestamps().iter().zip(result.values()) {
                entry.0.push(time.secs() * 1000);
                entry.1.push(*value);
            }
        }
        token = reply.next_token().map(str::to_string);
        if token.is_none() {
            break;
        }
    }
    let charts = plan
        .metrics
        .iter()
        .enumerate()
        .map(|(i, def)| MetricChart {
            metric: def.name.to_string(),
            stat: def.stat.to_string(),
            unit: def.unit,
            series: plan
                .series
                .iter()
                .enumerate()
                .map(|(j, s)| {
                    let (times, values) = values.remove(&query_id(i, j)).unwrap_or_default();
                    MetricSeries { label: s.label.clone(), times, values }
                })
                .collect(),
        })
        .collect();
    Ok(ResourceMetrics {
        namespace: plan.namespace.to_string(),
        region: plan.region.clone().unwrap_or_else(|| region.to_string()),
        charts,
        period,
        start: start * 1000,
        end: end * 1000,
        daily: plan.daily,
        note: None,
    })
}

#[cfg(test)]
mod tests;
