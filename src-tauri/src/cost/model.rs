//! 비용 명령의 입력과 출력(프론트엔드 `src/cost/types.ts`와 같은 모양). 금액은 모두 소수 문자열이다.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CostPeriod {
    ThisMonth,
    LastMonth,
    Last30Days,
    Last6Months,
}

/// Cost Explorer 지표 이름 그대로.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CostMetric {
    UnblendedCost,
    AmortizedCost,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CostGroupBy {
    Service,
    Region,
    UsageType,
    Tag { key: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CostDimension {
    Service,
    Region,
    UsageType,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CostFilter {
    Dimension { dimension: CostDimension, value: String },
    /// 값이 빈 문자열이면 "이 태그가 없는 비용"
    Tag { tag: String, value: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostQuery {
    pub period: CostPeriod,
    pub metric: CostMetric,
    pub exclude_credits: bool,
    pub filters: Vec<CostFilter>,
    pub group_by: CostGroupBy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Granularity {
    Daily,
    Monthly,
}

/// `[start, end)`, `YYYY-MM-DD`
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DateRange {
    pub start: String,
    pub end: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forecast {
    /// 이번 달 전체 예상(이미 쓴 금액 포함)
    pub mean: String,
    pub low: String,
    pub high: String,
}

/// 하루(일별) 또는 한 달(월별)
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub start: String,
    pub total: String,
    /// `CostOverview::series`와 같은 순서
    pub values: Vec<String>,
    /// 상위 서비스 밖의 합
    pub other: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostOverview {
    pub account_id: String,
    pub unit: String,
    /// 보여줄 범위. 이번 달 1일에는 None
    pub range: Option<DateRange>,
    pub compare_range: Option<DateRange>,
    pub granularity: Granularity,
    pub total: String,
    pub compare_total: Option<String>,
    pub delta: Option<String>,
    pub delta_pct: Option<f64>,
    pub estimated: bool,
    pub forecast: Option<Forecast>,
    /// 예상을 시도했지만 못 얻은 이유
    pub forecast_note: Option<String>,
    /// 비용 상위 서비스(최대 5개)
    pub series: Vec<String>,
    pub buckets: Vec<Bucket>,
    /// 쓴 응답 중 가장 오래된 것을 받은 시각(ISO)
    pub fetched_at: String,
    /// 이 호출에서 Cost Explorer로 실제 보낸 요청 수(0이면 모두 캐시)
    pub requests: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownRow {
    pub key: String,
    pub label: String,
    pub current: String,
    pub previous: Option<String>,
    pub delta: Option<String>,
    pub delta_pct: Option<f64>,
    /// 이번 기간 합계에서 차지하는 비율(%)
    pub share: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmallRows {
    pub count: u32,
    pub current: String,
    pub previous: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostBreakdown {
    pub unit: String,
    pub rows: Vec<BreakdownRow>,
    pub small: Option<SmallRows>,
    pub total: String,
    pub fetched_at: String,
    pub requests: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostUsage {
    pub year_month: String,
    pub requests: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn enums_use_the_contract_spelling() {
        assert_eq!(json!(CostPeriod::Last30Days), json!("last30Days"));
        assert_eq!(json!(CostPeriod::ThisMonth), json!("thisMonth"));
        assert_eq!(json!(CostMetric::UnblendedCost), json!("UnblendedCost"));
        assert_eq!(json!(CostMetric::AmortizedCost), json!("AmortizedCost"));
        assert_eq!(json!(CostGroupBy::Tag { key: "team".into() }), json!({ "kind": "tag", "key": "team" }));
        assert_eq!(json!(CostGroupBy::UsageType), json!({ "kind": "usageType" }));
        assert_eq!(json!(CostDimension::UsageType), json!("USAGE_TYPE"));
        assert_eq!(json!(Granularity::Monthly), json!("monthly"));
    }

    #[test]
    fn both_filter_forms_round_trip() {
        let dim = json!({ "dimension": "SERVICE", "value": "Tax" });
        let tag = json!({ "tag": "team", "value": "" });
        let parsed: Vec<CostFilter> = serde_json::from_value(json!([dim, tag])).unwrap();
        assert_eq!(
            parsed,
            vec![
                CostFilter::Dimension { dimension: CostDimension::Service, value: "Tax".into() },
                CostFilter::Tag { tag: "team".into(), value: String::new() },
            ]
        );
        assert_eq!(json!(parsed), json!([dim, tag]));
    }

    #[test]
    fn a_query_from_the_frontend_parses() {
        let q: CostQuery = serde_json::from_value(json!({
            "period": "lastMonth", "metric": "AmortizedCost", "excludeCredits": true,
            "filters": [{ "dimension": "REGION", "value": "ap-northeast-2" }], "groupBy": { "kind": "service" }
        }))
        .unwrap();
        assert_eq!(q.period, CostPeriod::LastMonth);
        assert_eq!(q.group_by, CostGroupBy::Service);
    }

    #[test]
    fn overview_keys_match_the_contract() {
        let o = CostOverview {
            account_id: "111111111111".into(),
            unit: "USD".into(),
            range: None,
            compare_range: None,
            granularity: Granularity::Daily,
            total: "0".into(),
            compare_total: None,
            delta: None,
            delta_pct: None,
            estimated: false,
            forecast: None,
            forecast_note: None,
            series: vec![],
            buckets: vec![],
            fetched_at: "2026-10-30T00:00:00Z".into(),
            requests: 0,
        };
        let value = json!(o);
        let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "accountId", "buckets", "compareRange", "compareTotal", "delta", "deltaPct", "estimated", "fetchedAt", "forecast", "forecastNote", "granularity",
                "range", "requests", "series", "total", "unit"
            ]
        );
    }
}
