//! 비용 탭의 명령. Cost Explorer는 요청마다 돈이 들어서 모든 조회가 `answer` 한 길로 간다:
//! 캐시에 6시간 안의 답이 있으면 그것을 쓰고(새로 고침이 아니면), 없으면 보내고, 보낸 페이지 수를 세고, 답을 디스크에 남긴다.
//! Cost Explorer는 us-east-1에만 있어서 선택한 리전과 상관없이 `GLOBAL_REGION`으로 부른다. 이 파일의 AWS 호출은 모두 읽기 전용이다.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use tauri::State;

use crate::aws::context::GLOBAL_REGION;
use crate::commands::AppState;
use crate::cost::breakdown::shape_breakdown;
use crate::cost::cache::CostCache;
use crate::cost::client;
use crate::cost::expr::CeRequest;
use crate::cost::model::{CostBreakdown, CostGroupBy, CostOverview, CostQuery, CostUsage, Forecast, Granularity};
use crate::cost::overview::{shape_overview, OverviewParts};
use crate::cost::period::{ranges, Ymd};
use crate::cost::table::CeTable;
use crate::error::AppError;
use crate::iam::clock::{iso, now_secs};

/// 데이터가 모자라 월말 예상을 못 낼 때의 안내
const FORECAST_SHORT: &str = "예상하기엔 데이터가 부족해요";

pub struct CostState {
    path: PathBuf,
    /// 처음 쓸 때 파일에서 읽는다. 한 명령이 조회를 다 마칠 때까지 잡고 있어서, 같은 요청을 두 번 보내 두 번 돈을 내는 일이 없다.
    cache: tokio::sync::Mutex<Option<CostCache>>,
    /// 프로필 → 계정 ID
    accounts: Mutex<HashMap<String, String>>,
}

impl CostState {
    pub fn new(path: PathBuf) -> CostState {
        CostState { path, cache: tokio::sync::Mutex::new(None), accounts: Mutex::default() }
    }

    async fn account(&self, state: &AppState, profile: &str) -> Result<String, AppError> {
        if let Some(id) = self.accounts.lock().unwrap_or_else(PoisonError::into_inner).get(profile) {
            return Ok(id.clone());
        }
        let id = state.ctx.account_id(profile).await?;
        self.accounts.lock().unwrap_or_else(PoisonError::into_inner).insert(profile.to_string(), id.clone());
        Ok(id)
    }
}

/// 모든 조회가 지나는 한 길. 돌려주는 값: (답과 그 답을 받은 시각, 이번에 실제로 보낸 페이지 수)
async fn answer(ce: &aws_sdk_costexplorer::Client, cache: &mut CostCache, account: &str, req: &CeRequest, refresh: bool, now: i64) -> (Result<(CeTable, i64), AppError>, u32) {
    if !refresh {
        if let Some(hit) = cache.get(account, req, now) {
            return (Ok(hit), 0);
        }
    }
    let (result, pages) = client::fetch(ce, req).await;
    cache.count(account, &Ymd::from_unix(now).year_month(), pages);
    let result = result.map(|table| {
        cache.put(account, req, &table, now);
        (table, now)
    });
    if pages > 0 {
        // 캐시를 못 써도 조회 결과는 돌려준다. 다음에 같은 요청을 다시 보낼 뿐이다.
        let _ = cache.save(now);
    }
    (result, pages)
}

fn usage(range: (Ymd, Ymd), granularity: Granularity, q: &CostQuery, group: CostGroupBy) -> CeRequest {
    CeRequest::Usage {
        start: range.0.to_string(),
        end: range.1.to_string(),
        granularity,
        metric: q.metric,
        exclude_credits: q.exclude_credits,
        filters: q.filters.clone(),
        group: Some(group),
    }
}

/// 받은 답들의 시각과 보낸 요청 수를 모은다.
#[derive(Default)]
struct Tally {
    requests: u32,
    oldest: Option<i64>,
}

impl Tally {
    async fn take(&mut self, ce: &aws_sdk_costexplorer::Client, cache: &mut CostCache, account: &str, req: &CeRequest, refresh: bool, now: i64) -> Result<CeTable, AppError> {
        let (result, pages) = answer(ce, cache, account, req, refresh, now).await;
        self.requests += pages;
        let (table, at) = result?;
        self.oldest = Some(self.oldest.map_or(at, |o| o.min(at)));
        Ok(table)
    }

    fn fetched_at(&self, now: i64) -> String {
        iso(self.oldest.unwrap_or(now))
    }
}

/// 월말 예상을 못 얻은 이유. 데이터가 모자란 경우는 한 문구로 모은다.
fn forecast_note(e: &AppError) -> String {
    match e {
        AppError::Other { message } if message == client::DATA_UNAVAILABLE || message.to_lowercase().contains("historical data") => FORECAST_SHORT.to_string(),
        other => other.to_string(),
    }
}

async fn overview_with(ce: &aws_sdk_costexplorer::Client, cache: &mut CostCache, account: &str, q: &CostQuery, refresh: bool, now: i64) -> Result<CostOverview, AppError> {
    let r = ranges(q.period, Ymd::from_unix(now));
    let mut tally = Tally::default();
    let current = match r.current {
        Some(range) => Some(tally.take(ce, cache, account, &usage(range, r.granularity, q, CostGroupBy::Service), refresh, now).await?),
        None => None,
    };
    let compare = match (r.current, r.compare) {
        (Some(_), Some(range)) => Some(tally.take(ce, cache, account, &usage(range, Granularity::Monthly, q, CostGroupBy::Service), refresh, now).await?),
        _ => None,
    };
    let forecast: Result<Option<Forecast>, String> = match r.forecast {
        Some((start, end)) => {
            let req = CeRequest::Forecast { start: start.to_string(), end: end.to_string(), metric: q.metric, exclude_credits: q.exclude_credits, filters: q.filters.clone() };
            match tally.take(ce, cache, account, &req, refresh, now).await {
                Ok(table) => Ok(table.forecast),
                Err(e) => Err(forecast_note(&e)),
            }
        }
        None => Ok(None),
    };
    let mut o = shape_overview(&r, OverviewParts { current: current.as_ref(), compare: compare.as_ref(), forecast });
    o.account_id = account.to_string();
    o.fetched_at = tally.fetched_at(now);
    o.requests = tally.requests;
    Ok(o)
}

async fn breakdown_with(ce: &aws_sdk_costexplorer::Client, cache: &mut CostCache, account: &str, q: &CostQuery, refresh: bool, now: i64) -> Result<CostBreakdown, AppError> {
    let r = ranges(q.period, Ymd::from_unix(now));
    let mut tally = Tally::default();
    let Some(current_range) = r.current else {
        let mut b = shape_breakdown(&q.group_by, &CeTable::default(), None);
        b.fetched_at = tally.fetched_at(now);
        return Ok(b);
    };
    // 서비스별은 개요와 같은 요청이라 개요 뒤에는 캐시에서 나온다
    let granularity = if q.group_by == CostGroupBy::Service { r.granularity } else { Granularity::Monthly };
    let current = tally.take(ce, cache, account, &usage(current_range, granularity, q, q.group_by.clone()), refresh, now).await?;
    let compare = match r.compare {
        Some(range) => Some(tally.take(ce, cache, account, &usage(range, Granularity::Monthly, q, q.group_by.clone()), refresh, now).await?),
        None => None,
    };
    let mut b = shape_breakdown(&q.group_by, &current, compare.as_ref());
    b.fetched_at = tally.fetched_at(now);
    b.requests = tally.requests;
    Ok(b)
}

async fn tag_keys_with(ce: &aws_sdk_costexplorer::Client, cache: &mut CostCache, account: &str, refresh: bool, now: i64) -> Result<Vec<String>, AppError> {
    let mut tally = Tally::default();
    Ok(tally.take(ce, cache, account, &CeRequest::TagKeys, refresh, now).await?.tag_keys)
}

async fn ce_client(state: &AppState, profile: &str) -> Result<aws_sdk_costexplorer::Client, AppError> {
    Ok(aws_sdk_costexplorer::Client::new(&state.ctx.config(profile, GLOBAL_REGION).await?))
}

#[tauri::command]
pub async fn cost_overview(state: State<'_, AppState>, cost: State<'_, CostState>, profile: String, query: CostQuery, refresh: bool) -> Result<CostOverview, AppError> {
    let account = cost.account(&state, &profile).await?;
    let ce = ce_client(&state, &profile).await?;
    let mut slot = cost.cache.lock().await;
    let cache = slot.get_or_insert_with(|| CostCache::load(cost.path.clone()));
    overview_with(&ce, cache, &account, &query, refresh, now_secs()).await
}

#[tauri::command]
pub async fn cost_breakdown(state: State<'_, AppState>, cost: State<'_, CostState>, profile: String, query: CostQuery, refresh: bool) -> Result<CostBreakdown, AppError> {
    let account = cost.account(&state, &profile).await?;
    let ce = ce_client(&state, &profile).await?;
    let mut slot = cost.cache.lock().await;
    let cache = slot.get_or_insert_with(|| CostCache::load(cost.path.clone()));
    breakdown_with(&ce, cache, &account, &query, refresh, now_secs()).await
}

#[tauri::command]
pub async fn cost_tag_keys(state: State<'_, AppState>, cost: State<'_, CostState>, profile: String, refresh: bool) -> Result<Vec<String>, AppError> {
    let account = cost.account(&state, &profile).await?;
    let ce = ce_client(&state, &profile).await?;
    let mut slot = cost.cache.lock().await;
    let cache = slot.get_or_insert_with(|| CostCache::load(cost.path.clone()));
    tag_keys_with(&ce, cache, &account, refresh, now_secs()).await
}

#[tauri::command]
pub async fn cost_usage(state: State<'_, AppState>, cost: State<'_, CostState>, profile: String) -> Result<CostUsage, AppError> {
    let account = cost.account(&state, &profile).await?;
    let mut slot = cost.cache.lock().await;
    let cache = slot.get_or_insert_with(|| CostCache::load(cost.path.clone()));
    let year_month = Ymd::from_unix(now_secs()).year_month();
    Ok(CostUsage { requests: cache.requests(&account, &year_month), year_month })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::mock_aws::{error_json, Recorder, Sent};
    use crate::cost::model::{CostMetric, CostPeriod};
    use serde_json::{json, Value};

    /// 2026-10-30T12:00:00Z
    const OCT_30: i64 = 1_793_361_600;
    /// 2026-10-01T12:00:00Z
    const OCT_1: i64 = 1_790_856_000;
    const ACCOUNT: &str = "111111111111";

    fn ok(body: Value) -> (u16, String) {
        (200, body.to_string())
    }

    fn op(sent: &Sent) -> &str {
        sent.target.rsplit('.').next().unwrap_or_default()
    }

    fn line(key: &str, amount: &str) -> Value {
        json!({ "Keys": [key], "Metrics": { "UnblendedCost": { "Amount": amount, "Unit": "USD" } } })
    }

    /// C0에서 본 모양: 묶은 조회는 `Total`이 비어 있다
    fn usage_answer() -> (u16, String) {
        ok(json!({
            "GroupDefinitions": [{ "Type": "DIMENSION", "Key": "SERVICE" }],
            "ResultsByTime": [
                { "TimePeriod": { "Start": "2026-10-01", "End": "2026-10-02" }, "Total": {}, "Estimated": true,
                  "Groups": [line("Tax", "63.95"), line("Amazon Relational Database Service", "5.5")] },
                { "TimePeriod": { "Start": "2026-10-02", "End": "2026-10-03" }, "Total": {}, "Estimated": true,
                  "Groups": [line("Amazon Relational Database Service", "5.51"), line("EC2 - Other", "2.64")] }
            ]
        }))
    }

    fn forecast_answer() -> (u16, String) {
        ok(json!({
            "Total": { "Amount": "749.6686275704207", "Unit": "USD" },
            "ForecastResultsByTime": [{ "TimePeriod": { "Start": "2026-10-01", "End": "2026-11-01" },
              "MeanValue": "749.6686275704207", "PredictionIntervalLowerBound": "746.4854055203974", "PredictionIntervalUpperBound": "752.8518496204438" }]
        }))
    }

    fn answering() -> Recorder {
        Recorder::new(|sent| match op(sent) {
            "GetCostAndUsage" => usage_answer(),
            "GetCostForecast" => forecast_answer(),
            other => panic!("unexpected call {other}"),
        })
    }

    fn query(period: CostPeriod, group_by: CostGroupBy) -> CostQuery {
        CostQuery { period, metric: CostMetric::UnblendedCost, exclude_credits: true, filters: vec![], group_by }
    }

    fn cache_in(dir: &tempfile::TempDir) -> CostCache {
        CostCache::load(dir.path().join("cost-cache.json"))
    }

    #[tokio::test]
    async fn the_first_screen_costs_three_requests_and_the_same_screen_again_costs_none() {
        let recorder = answering();
        let ce = recorder.client();
        let dir = tempfile::tempdir().unwrap();
        let mut cache = cache_in(&dir);
        let q = query(CostPeriod::ThisMonth, CostGroupBy::Service);

        let first = overview_with(&ce, &mut cache, ACCOUNT, &q, false, OCT_30).await.unwrap();
        let ops: Vec<String> = recorder.sent().iter().map(|s| op(s).to_string()).collect();
        assert_eq!(ops, vec!["GetCostAndUsage", "GetCostAndUsage", "GetCostForecast"]);
        // 이번 기간은 일별, 비교 기간은 월별
        let sent = recorder.sent();
        assert_eq!((sent[0].body["Granularity"].as_str(), sent[1].body["Granularity"].as_str()), (Some("DAILY"), Some("MONTHLY")));
        assert_eq!(first.requests, 3);
        assert_eq!(first.account_id, ACCOUNT);
        assert_eq!(first.fetched_at, iso(OCT_30));
        assert_eq!(first.forecast.as_ref().map(|f| f.mean.as_str()), Some("749.6686275704207"));

        // 한 시간 뒤 같은 화면: 보내지 않고, 데이터 시각은 처음 받은 때
        let again = overview_with(&ce, &mut cache, ACCOUNT, &q, false, OCT_30 + 3600).await.unwrap();
        assert_eq!(recorder.sent().len(), 3);
        assert_eq!(again.requests, 0);
        assert_eq!(again.fetched_at, iso(OCT_30));
        assert_eq!(again.total, first.total);

        let refreshed = overview_with(&ce, &mut cache, ACCOUNT, &q, true, OCT_30 + 3600).await.unwrap();
        assert_eq!(refreshed.requests, 3);
        assert_eq!(recorder.sent().len(), 6);
        assert_eq!(cache.requests(ACCOUNT, "2026-10"), 6);
    }

    #[tokio::test]
    async fn the_service_breakdown_reuses_the_overview_answers_and_other_groupings_cost_two() {
        let recorder = answering();
        let ce = recorder.client();
        let dir = tempfile::tempdir().unwrap();
        let mut cache = cache_in(&dir);
        overview_with(&ce, &mut cache, ACCOUNT, &query(CostPeriod::ThisMonth, CostGroupBy::Service), false, OCT_30).await.unwrap();
        let before = recorder.sent().len();

        let by_service = breakdown_with(&ce, &mut cache, ACCOUNT, &query(CostPeriod::ThisMonth, CostGroupBy::Service), false, OCT_30).await.unwrap();
        assert_eq!((by_service.requests, recorder.sent().len()), (0, before));
        assert_eq!(by_service.rows[0].key, "Tax");

        let by_region = breakdown_with(&ce, &mut cache, ACCOUNT, &query(CostPeriod::ThisMonth, CostGroupBy::Region), false, OCT_30).await.unwrap();
        assert_eq!(by_region.requests, 2);
        let sent = recorder.sent();
        assert_eq!(sent.len(), before + 2);
        for s in &sent[before..] {
            assert_eq!(s.body["Granularity"], "MONTHLY");
            assert_eq!(s.body["GroupBy"], json!([{ "Type": "DIMENSION", "Key": "REGION" }]));
        }
    }

    #[tokio::test]
    async fn on_the_first_of_the_month_only_the_forecast_is_asked() {
        let recorder = answering();
        let dir = tempfile::tempdir().unwrap();
        let mut cache = cache_in(&dir);
        let o = overview_with(&recorder.client(), &mut cache, ACCOUNT, &query(CostPeriod::ThisMonth, CostGroupBy::Service), false, OCT_1).await.unwrap();
        let ops: Vec<String> = recorder.sent().iter().map(|s| op(s).to_string()).collect();
        assert_eq!(ops, vec!["GetCostForecast"]);
        assert_eq!((o.range, o.total.as_str(), o.requests), (None, "0", 1));
        assert!(o.forecast.is_some());

        let b = breakdown_with(&recorder.client(), &mut cache, ACCOUNT, &query(CostPeriod::ThisMonth, CostGroupBy::Region), false, OCT_1).await.unwrap();
        assert_eq!((b.requests, b.rows.len()), (0, 0));
    }

    #[tokio::test]
    async fn a_forecast_without_enough_data_leaves_a_note_and_the_overview_stands() {
        let recorder = Recorder::new(|sent| match op(sent) {
            "GetCostAndUsage" => usage_answer(),
            _ => (400, error_json("DataUnavailableException", "Insufficient amount of historical data")),
        });
        let dir = tempfile::tempdir().unwrap();
        let mut cache = cache_in(&dir);
        let o = overview_with(&recorder.client(), &mut cache, ACCOUNT, &query(CostPeriod::ThisMonth, CostGroupBy::Service), false, OCT_30).await.unwrap();
        assert_eq!(o.forecast, None);
        assert_eq!(o.forecast_note.as_deref(), Some(FORECAST_SHORT));
        assert_eq!(o.requests, 3);
    }

    #[tokio::test]
    async fn other_forecast_errors_are_shown_as_they_are() {
        let recorder = Recorder::new(|sent| match op(sent) {
            "GetCostAndUsage" => usage_answer(),
            _ => (400, error_json("AccessDeniedException", "not authorized")),
        });
        let dir = tempfile::tempdir().unwrap();
        let mut cache = cache_in(&dir);
        let o = overview_with(&recorder.client(), &mut cache, ACCOUNT, &query(CostPeriod::ThisMonth, CostGroupBy::Service), false, OCT_30).await.unwrap();
        assert_eq!(o.forecast_note, Some(AppError::AccessDenied { action: "ce:GetCostForecast".into() }.to_string()));
    }

    #[tokio::test]
    async fn a_denied_overview_fails_but_its_request_is_still_counted() {
        let recorder = Recorder::new(|_| (400, error_json("AccessDeniedException", "not authorized")));
        let dir = tempfile::tempdir().unwrap();
        let mut cache = cache_in(&dir);
        let err = overview_with(&recorder.client(), &mut cache, ACCOUNT, &query(CostPeriod::LastMonth, CostGroupBy::Service), false, OCT_30).await.unwrap_err();
        assert_eq!(err, AppError::AccessDenied { action: "ce:GetCostAndUsage".into() });
        assert_eq!(recorder.sent().len(), 1);
        // 다시 읽은 파일에도 남아 있다
        assert_eq!(cache_in(&dir).requests(ACCOUNT, "2026-10"), 1);
    }

    #[tokio::test]
    async fn failed_answers_are_not_cached() {
        let recorder = Recorder::new(|_| (400, error_json("LimitExceededException", "slow down")));
        let dir = tempfile::tempdir().unwrap();
        let mut cache = cache_in(&dir);
        let q = query(CostPeriod::LastMonth, CostGroupBy::Service);
        assert_eq!(overview_with(&recorder.client(), &mut cache, ACCOUNT, &q, false, OCT_30).await.unwrap_err(), AppError::Throttled);
        assert_eq!(overview_with(&recorder.client(), &mut cache, ACCOUNT, &q, false, OCT_30).await.unwrap_err(), AppError::Throttled);
        assert_eq!(recorder.sent().len(), 2);
    }

    #[tokio::test]
    async fn tag_keys_are_cached_like_any_other_answer() {
        let recorder = Recorder::new(|_| ok(json!({ "CostAllocationTags": [{ "TagKey": "team", "Type": "UserDefined", "Status": "Active" }] })));
        let dir = tempfile::tempdir().unwrap();
        let mut cache = cache_in(&dir);
        assert_eq!(tag_keys_with(&recorder.client(), &mut cache, ACCOUNT, false, OCT_30).await.unwrap(), vec!["team".to_string()]);
        assert_eq!(tag_keys_with(&recorder.client(), &mut cache, ACCOUNT, false, OCT_30).await.unwrap(), vec!["team".to_string()]);
        assert_eq!(recorder.sent().len(), 1);
    }
}

/// 실제 계정 대조(돈이 든다: Cost Explorer 요청 약 3건). `scripts/cost-live-test.sh <프로필>`로 돌린다.
#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::aws::context::AwsContext;
    use crate::cost::model::{CostMetric, CostPeriod};
    use crate::cost::table::{dec, out};

    #[tokio::test]
    #[ignore]
    async fn this_month_overview_from_a_real_account_then_from_the_cache() {
        let profile = std::env::var("MM_COST_PROFILE").expect("MM_COST_PROFILE");
        let ctx = AwsContext::default();
        let account = ctx.account_id(&profile).await.unwrap();
        let ce = aws_sdk_costexplorer::Client::new(&ctx.config(&profile, GLOBAL_REGION).await.unwrap());
        let dir = tempfile::tempdir().unwrap();
        let mut cache = CostCache::load(dir.path().join("cost-cache.json"));
        let q = CostQuery { period: CostPeriod::ThisMonth, metric: CostMetric::UnblendedCost, exclude_credits: true, filters: vec![], group_by: CostGroupBy::Service };

        let first = overview_with(&ce, &mut cache, &account, &q, false, now_secs()).await.unwrap();
        println!("{}", serde_json::to_string_pretty(&first).unwrap());
        assert_eq!(first.unit, "USD");
        let bucket_sum = first.buckets.iter().fold(dec("0"), |acc, b| acc + dec(&b.total));
        assert_eq!(out(bucket_sum), first.total);
        assert!(first.requests >= 1);

        let again = overview_with(&ce, &mut cache, &account, &q, false, now_secs()).await.unwrap();
        assert_eq!(again.requests, 0);
        assert_eq!(again.fetched_at, first.fetched_at);
        let breakdown = breakdown_with(&ce, &mut cache, &account, &q, false, now_secs()).await.unwrap();
        assert_eq!(breakdown.requests, 0, "service breakdown reuses the overview's answers");
        println!("rows: {:?}", breakdown.rows.iter().take(5).map(|r| (&r.label, &r.current)).collect::<Vec<_>>());
        println!("Cost Explorer requests sent: {}", first.requests);
    }
}
