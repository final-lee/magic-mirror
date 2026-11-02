//! Cost Explorer를 부르는 유일한 곳. 페이지를 이어 받고, 몇 쪽을 보냈는지 세어 주고, 오류를 `AppError`로 옮긴다.
//! 부르는 API는 `GetCostAndUsage`, `GetCostForecast`, `ListCostAllocationTags` 셋뿐이다(모두 읽기 전용).

use std::collections::BTreeSet;

use aws_sdk_costexplorer::types::{CostAllocationTagStatus, DateInterval, Granularity as CeGranularity, Metric};
use aws_sdk_costexplorer::Client;
use aws_smithy_runtime_api::client::result::SdkError;
use aws_smithy_types::error::metadata::ProvideErrorMetadata;

use super::expr::{filter_expression, group_definition, CeRequest};
use super::model::{CostFilter, CostGroupBy, CostMetric, Forecast, Granularity};
use super::table::{CePeriod, CeTable};
use crate::error::{from_sdk, AppError};

/// `DataUnavailableException`에 보여주는 문구
pub const DATA_UNAVAILABLE: &str = "이 기간의 비용 데이터가 아직 없어요";
/// Cost Explorer를 한 번도 켜지 않은 계정에 보여주는 문구
pub const NOT_ENABLED: &str = "Billing 콘솔에서 Cost Explorer를 처음 열면 켜져요(최대 24시간)";

const ACTION_USAGE: &str = "ce:GetCostAndUsage";
const ACTION_FORECAST: &str = "ce:GetCostForecast";
const ACTION_TAGS: &str = "ce:ListCostAllocationTags";

/// Cost Explorer 오류를 `AppError`로. 코드와 메시지를 먼저 보고, 나머지는 `from_sdk`가 정한다.
pub fn from_ce<E, R>(err: SdkError<E, R>, action: &str) -> AppError
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
    R: std::fmt::Debug + Send + Sync + 'static,
{
    let code = err.code().map(str::to_owned);
    let message = err.message().map(str::to_lowercase).unwrap_or_default();
    match code.as_deref() {
        Some("LimitExceededException") => AppError::Throttled,
        Some("DataUnavailableException") => AppError::other(DATA_UNAVAILABLE),
        _ if message.contains("not enabled for cost explorer") => AppError::other(NOT_ENABLED),
        _ => from_sdk(err, action),
    }
}

/// 요청 하나를 보내고 (결과, 실제로 보낸 쪽수)를 돌려준다. 오류가 나도 그때까지 보낸 쪽수를 알려 준다.
pub async fn fetch(client: &Client, req: &CeRequest) -> (Result<CeTable, AppError>, u32) {
    let mut pages = 0;
    let result = match req {
        CeRequest::Usage { start, end, granularity, metric, exclude_credits, filters, group } => {
            usage(client, &mut pages, start, end, *granularity, *metric, *exclude_credits, filters, group.as_ref()).await
        }
        CeRequest::Forecast { start, end, metric, exclude_credits, filters } => forecast(client, &mut pages, start, end, *metric, *exclude_credits, filters).await,
        CeRequest::TagKeys => tag_keys(client, &mut pages).await,
    };
    (result, pages)
}

fn interval(start: &str, end: &str) -> Result<DateInterval, AppError> {
    DateInterval::builder().start(start).end(end).build().map_err(|e| AppError::other(e.to_string()))
}

fn metric_name(metric: CostMetric) -> &'static str {
    match metric {
        CostMetric::UnblendedCost => "UnblendedCost",
        CostMetric::AmortizedCost => "AmortizedCost",
    }
}

#[allow(clippy::too_many_arguments)]
async fn usage(
    client: &Client,
    pages: &mut u32,
    start: &str,
    end: &str,
    granularity: Granularity,
    metric: CostMetric,
    exclude_credits: bool,
    filters: &[CostFilter],
    group: Option<&CostGroupBy>,
) -> Result<CeTable, AppError> {
    let name = metric_name(metric);
    let time_period = interval(start, end)?;
    let filter = filter_expression(exclude_credits, filters);
    let mut table = CeTable::default();
    let mut token: Option<String> = None;
    loop {
        let mut call = client
            .get_cost_and_usage()
            .time_period(time_period.clone())
            .granularity(match granularity {
                Granularity::Daily => CeGranularity::Daily,
                Granularity::Monthly => CeGranularity::Monthly,
            })
            .metrics(name)
            .set_filter(filter.clone())
            .set_next_page_token(token.take());
        if let Some(group) = group {
            call = call.group_by(group_definition(group));
        }
        *pages += 1;
        let page = call.send().await.map_err(|e| from_ce(e, ACTION_USAGE))?;
        for result in page.results_by_time() {
            let period_start = result.time_period().map(|t| t.start().to_string()).unwrap_or_default();
            // 묶지 않은 조회만 합계가 있다. 묶으면 `Total`이 `{}`로 온다
            let total = result.total().and_then(|t| t.get(name));
            let total_amount = total.and_then(|m| m.amount()).map(str::to_string);
            if table.unit.is_none() {
                table.unit = total.and_then(|m| m.unit()).map(str::to_string);
            }
            let index = match table.periods.iter().position(|p| p.start == period_start) {
                Some(index) => index,
                None => {
                    table.periods.push(CePeriod { start: period_start, ..CePeriod::default() });
                    table.periods.len() - 1
                }
            };
            let entry = &mut table.periods[index];
            entry.estimated |= result.estimated();
            if entry.total.is_none() {
                entry.total = total_amount;
            }
            for g in result.groups() {
                let metric_value = g.metrics().and_then(|m| m.get(name));
                if table.unit.is_none() {
                    table.unit = metric_value.and_then(|m| m.unit()).map(str::to_string);
                }
                let key = g.keys().first().cloned().unwrap_or_default();
                let amount = metric_value.and_then(|m| m.amount()).unwrap_or("0").to_string();
                entry.groups.push((key, amount));
            }
        }
        match page.next_page_token() {
            Some(next) if !next.is_empty() => token = Some(next.to_string()),
            _ => return Ok(table),
        }
    }
}

async fn forecast(
    client: &Client,
    pages: &mut u32,
    start: &str,
    end: &str,
    metric: CostMetric,
    exclude_credits: bool,
    filters: &[CostFilter],
) -> Result<CeTable, AppError> {
    *pages += 1;
    let out = client
        .get_cost_forecast()
        .time_period(interval(start, end)?)
        .metric(match metric {
            CostMetric::UnblendedCost => Metric::UnblendedCost,
            CostMetric::AmortizedCost => Metric::AmortizedCost,
        })
        .granularity(CeGranularity::Monthly)
        .prediction_interval_level(80)
        .set_filter(filter_expression(exclude_credits, filters))
        .send()
        .await
        .map_err(|e| from_ce(e, ACTION_FORECAST))?;
    let total = out.total();
    let mean = total.and_then(|t| t.amount()).ok_or_else(|| AppError::other("Cost Explorer 예상 응답에 금액이 없어요"))?.to_string();
    let first = out.forecast_results_by_time().first();
    let bound = |value: Option<&str>| value.unwrap_or(&mean).to_string();
    let forecast = Forecast {
        low: bound(first.and_then(|f| f.prediction_interval_lower_bound())),
        high: bound(first.and_then(|f| f.prediction_interval_upper_bound())),
        mean: mean.clone(),
    };
    Ok(CeTable { unit: total.and_then(|t| t.unit()).map(str::to_string), forecast: Some(forecast), ..CeTable::default() })
}

async fn tag_keys(client: &Client, pages: &mut u32) -> Result<CeTable, AppError> {
    let mut keys = BTreeSet::new();
    let mut token: Option<String> = None;
    loop {
        *pages += 1;
        let page = client
            .list_cost_allocation_tags()
            .status(CostAllocationTagStatus::Active)
            .set_next_token(token.take())
            .send()
            .await
            .map_err(|e| from_ce(e, ACTION_TAGS))?;
        keys.extend(page.cost_allocation_tags().iter().map(|t| t.tag_key().to_string()));
        match page.next_token() {
            Some(next) if !next.is_empty() => token = Some(next.to_string()),
            _ => break,
        }
    }
    Ok(CeTable { tag_keys: keys.into_iter().collect(), ..CeTable::default() })
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;
    use crate::cost::mock_aws::{error_json, Recorder};
    use crate::cost::model::CostDimension;

    const USAGE_TARGET: &str = "AWSInsightsIndexService.GetCostAndUsage";

    fn usage_req(group: Option<CostGroupBy>, exclude_credits: bool, filters: Vec<CostFilter>) -> CeRequest {
        CeRequest::Usage {
            start: "2026-10-01".into(),
            end: "2026-10-03".into(),
            granularity: Granularity::Daily,
            metric: CostMetric::UnblendedCost,
            exclude_credits,
            filters,
            group,
        }
    }

    fn group_line(key: &str, amount: &str) -> Value {
        json!({ "Keys": [key], "Metrics": { "UnblendedCost": { "Amount": amount, "Unit": "USD" } } })
    }

    fn day(start: &str, end: &str, estimated: bool, groups: Vec<Value>) -> Value {
        json!({ "TimePeriod": { "Start": start, "End": end }, "Total": {}, "Groups": groups, "Estimated": estimated })
    }

    fn ok(value: Value) -> (u16, String) {
        (200, value.to_string())
    }

    /// 보낸 `GetCostAndUsage`의 `Filter`. 필터가 없으면 None
    async fn sent_filter(req: &CeRequest) -> Option<Value> {
        let recorder = Recorder::new(|_| ok(json!({ "ResultsByTime": [] })));
        let (result, pages) = fetch(&recorder.client(), req).await;
        assert!(result.is_ok());
        assert_eq!(pages, 1);
        let sent = recorder.sent();
        assert_eq!(sent[0].target, USAGE_TARGET);
        sent[0].body.get("Filter").cloned()
    }

    fn credits_json() -> Value {
        json!({ "Not": { "Dimensions": { "Key": "RECORD_TYPE", "Values": ["Credit", "Refund"] } } })
    }

    #[tokio::test]
    async fn no_filter_parts_send_no_filter() {
        assert_eq!(sent_filter(&usage_req(None, false, vec![])).await, None);
    }

    #[tokio::test]
    async fn a_lone_filter_part_is_not_wrapped_in_and() {
        assert_eq!(sent_filter(&usage_req(None, true, vec![])).await, Some(credits_json()));
        let service = CostFilter::Dimension { dimension: CostDimension::Region, value: "ap-northeast-2".into() };
        assert_eq!(
            sent_filter(&usage_req(None, false, vec![service])).await,
            Some(json!({ "Dimensions": { "Key": "REGION", "Values": ["ap-northeast-2"] } }))
        );
        let tag = CostFilter::Tag { tag: "team".into(), value: "api".into() };
        assert_eq!(sent_filter(&usage_req(None, false, vec![tag])).await, Some(json!({ "Tags": { "Key": "team", "Values": ["api"] } })));
    }

    #[tokio::test]
    async fn credits_a_service_and_a_missing_tag_are_anded_in_order() {
        let filters = vec![
            CostFilter::Dimension { dimension: CostDimension::Service, value: "Amazon Simple Storage Service".into() },
            CostFilter::Tag { tag: "team".into(), value: String::new() },
        ];
        assert_eq!(
            sent_filter(&usage_req(None, true, filters)).await,
            Some(json!({ "And": [
                credits_json(),
                { "Dimensions": { "Key": "SERVICE", "Values": ["Amazon Simple Storage Service"] } },
                { "Tags": { "Key": "team", "MatchOptions": ["ABSENT"] } },
            ] }))
        );
    }

    #[tokio::test]
    async fn two_pages_are_merged_by_period_and_counted() {
        let recorder = Recorder::new(|sent| match sent.body.get("NextPageToken").and_then(Value::as_str) {
            None => ok(json!({
                "NextPageToken": "page-2",
                "GroupDefinitions": [{ "Type": "DIMENSION", "Key": "SERVICE" }],
                "ResultsByTime": [day("2026-10-01", "2026-10-02", true, vec![group_line("Amazon S3", "0.53168163")])],
            })),
            Some("page-2") => ok(json!({
                "GroupDefinitions": [{ "Type": "DIMENSION", "Key": "SERVICE" }],
                "ResultsByTime": [
                    day("2026-10-01", "2026-10-02", false, vec![group_line("AWS Lambda", "0.0000050000")]),
                    day("2026-10-02", "2026-10-03", false, vec![group_line("Amazon S3", "1.5")]),
                ],
            })),
            Some(other) => panic!("unexpected token {other}"),
        });
        let req = usage_req(Some(CostGroupBy::Tag { key: "team".into() }), true, vec![]);
        let (table, pages) = fetch(&recorder.client(), &req).await;
        let table = table.unwrap();
        assert_eq!(pages, 2);
        assert_eq!(table.unit.as_deref(), Some("USD"));
        assert_eq!(
            table.periods,
            vec![
                CePeriod {
                    start: "2026-10-01".into(),
                    estimated: true,
                    groups: vec![("Amazon S3".into(), "0.53168163".into()), ("AWS Lambda".into(), "0.0000050000".into())],
                    total: None,
                },
                CePeriod { start: "2026-10-02".into(), estimated: false, groups: vec![("Amazon S3".into(), "1.5".into())], total: None },
            ]
        );

        let sent = recorder.sent();
        assert_eq!(sent.len(), 2);
        let first = &sent[0].body;
        assert_eq!(sent[0].target, USAGE_TARGET);
        assert_eq!(first["TimePeriod"], json!({ "Start": "2026-10-01", "End": "2026-10-03" }));
        assert_eq!(first["Granularity"], "DAILY");
        assert_eq!(first["Metrics"], json!(["UnblendedCost"]));
        assert_eq!(first["GroupBy"], json!([{ "Type": "TAG", "Key": "team" }]));
        assert_eq!(first["Filter"], credits_json());
        assert!(first.get("NextPageToken").is_none());
        // 둘째 쪽은 같은 조건에 토큰만 붙는다
        let mut second = sent[1].body.clone();
        assert_eq!(second["NextPageToken"], "page-2");
        second.as_object_mut().unwrap().remove("NextPageToken");
        assert_eq!(&second, first);
    }

    #[tokio::test]
    async fn an_ungrouped_answer_keeps_its_total() {
        let recorder = Recorder::new(|_| {
            ok(json!({ "ResultsByTime": [{
                "TimePeriod": { "Start": "2026-10-01", "End": "2026-10-02" },
                "Total": { "AmortizedCost": { "Amount": "749.6686275704207", "Unit": "USD" } },
                "Groups": [],
                "Estimated": false,
            }] }))
        });
        let req = CeRequest::Usage {
            start: "2026-10-01".into(),
            end: "2026-10-02".into(),
            granularity: Granularity::Monthly,
            metric: CostMetric::AmortizedCost,
            exclude_credits: false,
            filters: vec![],
            group: Some(CostGroupBy::Region),
        };
        let (table, pages) = fetch(&recorder.client(), &req).await;
        let table = table.unwrap();
        assert_eq!(pages, 1);
        assert_eq!(table.unit.as_deref(), Some("USD"));
        assert_eq!(table.periods[0].total.as_deref(), Some("749.6686275704207"));
        assert!(table.periods[0].groups.is_empty());
        let body = &recorder.sent()[0].body;
        assert_eq!(body["Metrics"], json!(["AmortizedCost"]));
        assert_eq!(body["Granularity"], "MONTHLY");
        assert_eq!(body["GroupBy"], json!([{ "Type": "DIMENSION", "Key": "REGION" }]));
    }

    #[tokio::test]
    async fn no_lines_at_all_leaves_the_unit_unknown() {
        let recorder = Recorder::new(|_| ok(json!({ "ResultsByTime": [] })));
        let (table, _) = fetch(&recorder.client(), &usage_req(Some(CostGroupBy::UsageType), false, vec![])).await;
        let table = table.unwrap();
        assert_eq!(table.unit, None);
        assert!(table.periods.is_empty());
        assert_eq!(recorder.sent()[0].body["GroupBy"], json!([{ "Type": "DIMENSION", "Key": "USAGE_TYPE" }]));
    }

    fn forecast_req(metric: CostMetric) -> CeRequest {
        CeRequest::Forecast {
            start: "2026-10-30".into(),
            end: "2026-11-01".into(),
            metric,
            exclude_credits: true,
            filters: vec![CostFilter::Dimension { dimension: CostDimension::Service, value: "Tax".into() }],
        }
    }

    fn forecast_answer() -> (u16, String) {
        ok(json!({
            "Total": { "Amount": "749.6686275704207", "Unit": "USD" },
            "ForecastResultsByTime": [
                { "TimePeriod": { "Start": "2026-10-30", "End": "2026-11-01" }, "MeanValue": "749.67", "PredictionIntervalLowerBound": "700.1", "PredictionIntervalUpperBound": "800.25" },
                { "TimePeriod": { "Start": "2026-11-01", "End": "2026-12-01" }, "MeanValue": "9", "PredictionIntervalLowerBound": "8", "PredictionIntervalUpperBound": "10" },
            ],
        }))
    }

    #[tokio::test]
    async fn a_forecast_sends_the_monthly_80_percent_request_and_reads_the_first_bounds() {
        let recorder = Recorder::new(|_| forecast_answer());
        let (table, pages) = fetch(&recorder.client(), &forecast_req(CostMetric::UnblendedCost)).await;
        let table = table.unwrap();
        assert_eq!(pages, 1);
        assert_eq!(table.unit.as_deref(), Some("USD"));
        assert_eq!(table.forecast, Some(Forecast { mean: "749.6686275704207".into(), low: "700.1".into(), high: "800.25".into() }));
        assert!(table.periods.is_empty());

        let sent = recorder.sent();
        assert_eq!(sent[0].target, "AWSInsightsIndexService.GetCostForecast");
        assert_eq!(
            sent[0].body,
            json!({
                "TimePeriod": { "Start": "2026-10-30", "End": "2026-11-01" },
                "Metric": "UNBLENDED_COST",
                "Granularity": "MONTHLY",
                "PredictionIntervalLevel": 80,
                "Filter": { "And": [credits_json(), { "Dimensions": { "Key": "SERVICE", "Values": ["Tax"] } }] },
            })
        );
    }

    #[tokio::test]
    async fn an_amortized_forecast_asks_for_amortized_cost() {
        let recorder = Recorder::new(|_| forecast_answer());
        let (table, _) = fetch(&recorder.client(), &forecast_req(CostMetric::AmortizedCost)).await;
        assert!(table.is_ok());
        assert_eq!(recorder.sent()[0].body["Metric"], "AMORTIZED_COST");
    }

    #[tokio::test]
    async fn tag_keys_are_paged_sorted_and_deduplicated() {
        let tag = |key: &str, kind: &str| json!({ "TagKey": key, "Type": kind, "Status": "Active" });
        let recorder = Recorder::new(move |sent| match sent.body.get("NextToken").and_then(Value::as_str) {
            None => ok(json!({ "NextToken": "t2", "CostAllocationTags": [tag("team", "UserDefined"), tag("env", "UserDefined")] })),
            Some("t2") => ok(json!({ "CostAllocationTags": [tag("env", "UserDefined"), tag("aws:createdBy", "AWSGenerated")] })),
            Some(other) => panic!("unexpected token {other}"),
        });
        let (table, pages) = fetch(&recorder.client(), &CeRequest::TagKeys).await;
        assert_eq!(pages, 2);
        assert_eq!(table.unwrap().tag_keys, vec!["aws:createdBy", "env", "team"]);
        let sent = recorder.sent();
        assert_eq!(sent[0].target, "AWSInsightsIndexService.ListCostAllocationTags");
        assert_eq!(sent[0].body, json!({ "Status": "Active" }));
        assert_eq!(sent[1].body, json!({ "Status": "Active", "NextToken": "t2" }));
    }

    #[tokio::test]
    async fn an_error_answer_still_counts_the_page_it_used() {
        let recorder = Recorder::new(|_| (400, error_json("LimitExceededException", "Limit exceeded")));
        let (result, pages) = fetch(&recorder.client(), &usage_req(None, false, vec![])).await;
        assert_eq!(result, Err(AppError::Throttled));
        assert_eq!(pages, 1);
        assert_eq!(recorder.sent().len(), 1);
    }

    #[tokio::test]
    async fn a_failure_on_the_second_page_reports_both_pages() {
        let recorder = Recorder::new(|sent| match sent.body.get("NextPageToken") {
            None => ok(json!({ "NextPageToken": "p2", "ResultsByTime": [day("2026-10-01", "2026-10-02", false, vec![group_line("Amazon S3", "1")])] })),
            Some(_) => (400, error_json("DataUnavailableException", "no data")),
        });
        let (result, pages) = fetch(&recorder.client(), &usage_req(Some(CostGroupBy::Service), false, vec![])).await;
        assert_eq!(result, Err(AppError::other(DATA_UNAVAILABLE)));
        assert_eq!(pages, 2);
    }

    #[tokio::test]
    async fn every_request_kind_names_its_own_action_in_access_denied() {
        let recorder = Recorder::new(|_| (400, error_json("AccessDeniedException", "User is not authorized to perform: ce:Whatever")));
        let client = recorder.client();
        let cases = [
            (usage_req(None, false, vec![]), "ce:GetCostAndUsage"),
            (forecast_req(CostMetric::UnblendedCost), "ce:GetCostForecast"),
            (CeRequest::TagKeys, "ce:ListCostAllocationTags"),
        ];
        for (req, action) in cases {
            let (result, pages) = fetch(&client, &req).await;
            assert_eq!(result, Err(AppError::AccessDenied { action: action.into() }));
            assert_eq!(pages, 1);
        }
    }

    async fn mapped(status: u16, code: &str, message: &str) -> AppError {
        let (code, message) = (code.to_string(), message.to_string());
        let recorder = Recorder::new(move |_| (status, error_json(&code, &message)));
        let err = recorder.client().get_cost_and_usage().time_period(interval("2026-10-01", "2026-10-02").unwrap()).send().await.unwrap_err();
        from_ce(err, "ce:GetCostAndUsage")
    }

    #[tokio::test]
    async fn limit_exceeded_is_throttled() {
        assert_eq!(mapped(400, "LimitExceededException", "Limit exceeded").await, AppError::Throttled);
    }

    #[tokio::test]
    async fn data_unavailable_says_the_data_is_not_there_yet() {
        assert_eq!(mapped(400, "DataUnavailableException", "Data is not available").await, AppError::Other { message: "이 기간의 비용 데이터가 아직 없어요".into() });
    }

    #[tokio::test]
    async fn a_never_enabled_account_is_told_how_to_enable_cost_explorer() {
        let err = mapped(400, "AccessDeniedException", "User not enabled for cost explorer access").await;
        assert_eq!(err, AppError::Other { message: "Billing 콘솔에서 Cost Explorer를 처음 열면 켜져요(최대 24시간)".into() });
        // 대소문자는 가리지 않는다
        assert_eq!(mapped(400, "AccessDeniedException", "User Not Enabled For Cost Explorer Access").await, AppError::other(NOT_ENABLED));
    }

    #[tokio::test]
    async fn a_plain_access_denied_names_the_action() {
        let err = mapped(400, "AccessDeniedException", "User is not authorized to perform: ce:GetCostAndUsage").await;
        assert_eq!(err, AppError::AccessDenied { action: "ce:GetCostAndUsage".into() });
    }

    #[tokio::test]
    async fn other_errors_fall_back_to_the_shared_mapping() {
        let err = mapped(400, "ValidationException", "Start date must be before end date").await;
        assert!(matches!(err, AppError::Other { ref message } if message.contains("Start date must be before end date")), "{err:?}");
    }
}
