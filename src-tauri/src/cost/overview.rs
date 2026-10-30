//! Cost Explorer 응답을 요약과 시계열로 만든다.

use std::collections::HashMap;

use rust_decimal::{prelude::ToPrimitive, Decimal};

use super::{
    model::{Bucket, CostOverview, DateRange, Forecast},
    period::{Ranges, Ymd},
    table::{dec, out, CePeriod, CeTable},
};

pub struct OverviewParts<'a> {
    pub current: Option<&'a CeTable>,
    pub compare: Option<&'a CeTable>,
    pub forecast: Result<Option<Forecast>, String>,
}

fn period_total(period: &CePeriod) -> Decimal {
    if period.groups.is_empty() {
        period.total.as_deref().map(dec).unwrap_or_default()
    } else {
        period.groups.iter().map(|(_, amount)| dec(amount)).sum()
    }
}

fn date_range(range: (Ymd, Ymd)) -> DateRange {
    DateRange { start: range.0.to_string(), end: range.1.to_string() }
}

pub fn shape_overview(ranges: &Ranges, parts: OverviewParts<'_>) -> CostOverview {
    let current = ranges.current.and(parts.current);
    let compare = ranges.current.and(ranges.compare).and(parts.compare);
    let mut amounts = HashMap::<&str, Decimal>::new();
    if let Some(table) = current {
        for period in &table.periods {
            for (key, amount) in &period.groups {
                *amounts.entry(key).or_default() += dec(amount);
            }
        }
    }
    let mut ranked: Vec<_> = amounts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let series: Vec<String> = ranked.into_iter().take(5).map(|(key, _)| key.to_owned()).collect();
    let mut periods: Vec<_> = current.into_iter().flat_map(|table| &table.periods).collect();
    periods.sort_by(|a, b| a.start.cmp(&b.start));
    let estimated = periods.iter().any(|period| period.estimated);
    let mut total = Decimal::ZERO;
    let buckets = periods.into_iter().map(|period| {
        let bucket_total = period_total(period);
        total += bucket_total;
        let values: Vec<Decimal> = series.iter().map(|key| {
            period.groups.iter().filter(|(name, _)| name == key).map(|(_, amount)| dec(amount)).sum()
        }).collect();
        let other = bucket_total - values.iter().copied().sum::<Decimal>();
        Bucket { start: period.start.clone(), total: out(bucket_total), values: values.into_iter().map(out).collect(), other: out(other) }
    }).collect();
    let compare_total = compare.map(|table| table.periods.iter().map(period_total).sum::<Decimal>());
    let delta = compare_total.map(|previous| total - previous);
    let delta_pct = compare_total.filter(|previous| !previous.is_zero()).map(|previous| {
        delta.unwrap_or_default().to_f64().unwrap_or_default() / previous.to_f64().unwrap_or_default() * 100.0
    });
    let (forecast, forecast_note) = match parts.forecast {
        Ok(forecast) => (forecast, None),
        Err(note) => (None, Some(note)),
    };
    CostOverview {
        account_id: String::new(),
        unit: parts.current.and_then(|table| table.unit.as_ref()).or_else(|| parts.compare.and_then(|table| table.unit.as_ref())).cloned().unwrap_or_else(|| "USD".into()),
        range: ranges.current.map(date_range),
        compare_range: ranges.current.and(ranges.compare).map(date_range),
        granularity: ranges.granularity,
        total: out(total), compare_total: compare_total.map(out), delta: delta.map(out), delta_pct,
        estimated, forecast, forecast_note, series, buckets, fetched_at: String::new(), requests: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::{model::CostPeriod, period::{ranges, Ymd}};

    fn fixture() -> CeTable {
        let days = [
            ("2026-10-03", false, vec![("Tax", "1"), ("EC2 - Other", "2"), ("Amazon Relational Database Service", "3"), ("Claude Sonnet 5 (Amazon Bedrock Edition)", "1"), ("AWS Cost Explorer", "0.1"), ("Amazon Simple Storage Service", "0.2"), ("AWS Lambda", "1")]),
            ("2026-10-01", true, vec![("Tax", "1"), ("EC2 - Other", "1"), ("AWS Cost Explorer", "0.2"), ("Amazon Simple Storage Service", "0.1")]),
            ("2026-10-02", false, vec![("Claude Sonnet 5 (Amazon Bedrock Edition)", "1"), ("AWS Lambda", "1")]),
        ];
        CeTable { unit: Some("USD".into()), periods: days.into_iter().map(|(start, estimated, groups)| CePeriod { start: start.into(), estimated, groups: groups.into_iter().map(|(k, v)| (k.into(), v.into())).collect(), total: Some("999".into()) }).collect(), ..Default::default() }
    }

    #[test]
    fn top_five_ties_buckets_and_decimal_sums_are_consistent() {
        let table = fixture();
        let r = ranges(CostPeriod::ThisMonth, Ymd { y: 2026, m: 10, d: 4 });
        let result = shape_overview(&r, OverviewParts { current: Some(&table), compare: None, forecast: Ok(None) });
        assert_eq!(result.series, ["Amazon Relational Database Service", "EC2 - Other", "AWS Lambda", "Claude Sonnet 5 (Amazon Bedrock Edition)", "Tax"]);
        assert_eq!(result.total, "12.6");
        assert!(result.estimated);
        assert_eq!(result.buckets.iter().map(|b| b.start.as_str()).collect::<Vec<_>>(), ["2026-10-01", "2026-10-02", "2026-10-03"]);
        assert_eq!(result.buckets.iter().map(|b| dec(&b.total)).sum::<Decimal>(), dec(&result.total));
        for bucket in &result.buckets {
            assert_eq!(dec(&bucket.other), dec(&bucket.total) - bucket.values.iter().map(|v| dec(v)).sum::<Decimal>());
        }
        assert_eq!(result.buckets[0].other, "0.3");
    }

    #[test]
    fn zero_compare_and_forecast_error_keep_delta_and_note() {
        let table = fixture();
        let compare = CeTable { unit: Some("EUR".into()), periods: vec![CePeriod { total: Some("0".into()), ..Default::default() }], ..Default::default() };
        let r = ranges(CostPeriod::ThisMonth, Ymd { y: 2026, m: 10, d: 4 });
        let result = shape_overview(&r, OverviewParts { current: Some(&table), compare: Some(&compare), forecast: Err("예상 실패".into()) });
        assert_eq!(result.compare_total.as_deref(), Some("0"));
        assert_eq!(result.delta.as_deref(), Some("12.6"));
        assert_eq!(result.delta_pct, None);
        assert_eq!(result.forecast_note.as_deref(), Some("예상 실패"));
        assert_eq!(result.forecast, None);
        assert_eq!(result.range.unwrap().start, "2026-10-01");
        assert_eq!(result.compare_range.unwrap().start, "2026-09-01");
    }

    #[test]
    fn first_day_has_no_current_or_compare_even_if_tables_are_supplied() {
        let table = fixture();
        let r = ranges(CostPeriod::ThisMonth, Ymd { y: 2026, m: 10, d: 1 });
        let result = shape_overview(&r, OverviewParts { current: Some(&table), compare: Some(&table), forecast: Ok(None) });
        assert_eq!(result.range, None);
        assert_eq!(result.compare_range, None);
        assert_eq!(result.compare_total, None);
        assert_eq!(result.total, "0");
        assert!(result.buckets.is_empty());
        assert!(result.series.is_empty());
    }

    #[test]
    fn ungrouped_total_unit_fallback_and_forecast_are_preserved() {
        let current = CeTable { periods: vec![CePeriod { start: "2026-10-01".into(), total: Some("0.3".into()), ..Default::default() }], ..Default::default() };
        let compare = CeTable { unit: Some("EUR".into()), periods: vec![CePeriod { total: Some("0.1".into()), ..Default::default() }], ..Default::default() };
        let forecast = Forecast { mean: "4".into(), low: "3".into(), high: "5".into() };
        let r = ranges(CostPeriod::ThisMonth, Ymd { y: 2026, m: 10, d: 4 });
        let result = shape_overview(&r, OverviewParts { current: Some(&current), compare: Some(&compare), forecast: Ok(Some(forecast.clone())) });
        assert_eq!(result.unit, "EUR");
        assert_eq!(result.buckets[0].other, "0.3");
        assert_eq!(result.delta.as_deref(), Some("0.2"));
        assert!((result.delta_pct.unwrap() - 200.0).abs() < 1e-10);
        assert_eq!(result.forecast, Some(forecast));
    }
}
