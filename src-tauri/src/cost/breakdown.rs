//! Cost Explorer 그룹을 기간별 분해 표로 만든다.

use std::collections::HashMap;

use rust_decimal::{prelude::ToPrimitive, Decimal};

use super::{
    model::{BreakdownRow, CostBreakdown, CostGroupBy, SmallRows},
    table::{dec, out, CeTable},
};

fn amounts(table: &CeTable) -> HashMap<&str, Decimal> {
    let mut result = HashMap::new();
    for period in &table.periods {
        for (key, amount) in &period.groups {
            *result.entry(key.as_str()).or_default() += dec(amount);
        }
    }
    result
}

pub fn shape_breakdown(group: &CostGroupBy, current: &CeTable, compare: Option<&CeTable>) -> CostBreakdown {
    let mut values: HashMap<&str, (Decimal, Decimal)> = HashMap::new();
    for (key, amount) in amounts(current) {
        values.entry(key).or_default().0 = amount;
    }
    if let Some(table) = compare {
        for (key, amount) in amounts(table) {
            values.entry(key).or_default().1 = amount;
        }
    }
    let total: Decimal = values.values().map(|(current, _)| *current).sum();
    let mut sorted: Vec<_> = values.into_iter().collect();
    sorted.sort_by(|a, b| b.1.0.cmp(&a.1.0).then_with(|| a.0.cmp(b.0)));
    let threshold = dec("0.005");
    let mut small_count = 0;
    let mut small_current = Decimal::ZERO;
    let mut small_previous = Decimal::ZERO;
    let mut rows = Vec::new();
    for (key, (amount, previous)) in sorted {
        if amount.abs() < threshold && previous.abs() < threshold {
            small_count += 1;
            small_current += amount;
            small_previous += previous;
            continue;
        }
        let label = match group {
            CostGroupBy::Tag { .. } => {
                let value = key.split_once('$').map_or(key, |(_, value)| value);
                if value.is_empty() { "(태그 없음)" } else { value }
            }
            _ => key,
        };
        let delta = amount - previous;
        rows.push(BreakdownRow {
            key: key.into(), label: label.into(), current: out(amount),
            previous: compare.map(|_| out(previous)),
            delta: compare.map(|_| out(delta)),
            delta_pct: compare.filter(|_| !previous.is_zero()).map(|_| delta.to_f64().unwrap_or_default() / previous.to_f64().unwrap_or_default() * 100.0),
            share: if total.is_zero() { 0.0 } else { amount.to_f64().unwrap_or_default() / total.to_f64().unwrap_or_default() * 100.0 },
        });
    }
    let small = (small_count > 0).then(|| SmallRows {
        count: small_count, current: out(small_current), previous: compare.map(|_| out(small_previous)),
    });
    CostBreakdown {
        unit: current.unit.as_ref().or_else(|| compare.and_then(|table| table.unit.as_ref())).cloned().unwrap_or_else(|| "USD".into()),
        rows, small, total: out(total), fetched_at: String::new(), requests: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::table::CePeriod;

    fn table(days: &[&[(&str, &str)]]) -> CeTable {
        CeTable { periods: days.iter().map(|groups| CePeriod { groups: groups.iter().map(|(key, amount)| ((*key).into(), (*amount).into())).collect(), ..Default::default() }).collect(), ..Default::default() }
    }

    #[test]
    fn previous_only_keys_sort_and_shares_use_exact_current_total() {
        let current = table(&[&[("Tax", "0.1"), ("EC2 - Other", "2"), ("Amazon Relational Database Service", "2")], &[("Tax", "0.2")]]);
        let previous = table(&[&[("Previous only", "1"), ("Tax", "0.1"), ("EC2 - Other", "0")]]);
        let result = shape_breakdown(&CostGroupBy::Service, &current, Some(&previous));
        assert_eq!(result.total, "4.3");
        assert_eq!(result.rows.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(), ["Amazon Relational Database Service", "EC2 - Other", "Tax", "Previous only"]);
        assert_eq!(result.rows[2].current, "0.3");
        assert_eq!(result.rows[2].delta.as_deref(), Some("0.2"));
        assert_eq!(result.rows[3].current, "0");
        assert_eq!(result.rows[3].delta.as_deref(), Some("-1"));
        assert_eq!(result.rows[0].delta_pct, None);
        assert!((result.rows.iter().map(|row| row.share).sum::<f64>() - 100.0).abs() < 1e-10);
        assert_eq!(result.small, None);
    }

    #[test]
    fn small_rows_fold_only_when_both_absolute_amounts_are_below_threshold() {
        let current = table(&[&[("a", "0.001"), ("b", "-0.002"), ("boundary", "0.005"), ("previous-large", "0.001")]]);
        let previous = table(&[&[("a", "0.002"), ("b", "-0.001"), ("previous-large", "-0.005")]]);
        let result = shape_breakdown(&CostGroupBy::Service, &current, Some(&previous));
        let small = result.small.unwrap();
        assert_eq!((small.count, small.current.as_str(), small.previous.as_deref()), (2, "-0.001", Some("0.001")));
        assert_eq!(result.rows.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(), ["boundary", "previous-large"]);
    }

    #[test]
    fn tags_use_values_as_labels_and_no_compare_has_no_deltas() {
        let current = table(&[&[("team$", "1"), ("team$api", "2"), ("team$a$b", "3"), ("team$tiny", "0.001")]]);
        let result = shape_breakdown(&CostGroupBy::Tag { key: "team".into() }, &current, None);
        assert_eq!(result.rows.iter().map(|r| (r.key.as_str(), r.label.as_str())).collect::<Vec<_>>(), [("team$a$b", "a$b"), ("team$api", "api"), ("team$", "(태그 없음)")]);
        assert!(result.rows.iter().all(|r| r.previous.is_none() && r.delta.is_none() && r.delta_pct.is_none()));
        assert_eq!(result.small.unwrap().previous, None);
    }

    #[test]
    fn zero_total_has_zero_shares_and_unit_falls_back_to_compare() {
        let current = table(&[&[("positive", "1"), ("negative", "-1")]]);
        let mut previous = table(&[]);
        previous.unit = Some("EUR".into());
        let result = shape_breakdown(&CostGroupBy::Region, &current, Some(&previous));
        assert_eq!(result.total, "0");
        assert_eq!(result.unit, "EUR");
        assert!(result.rows.iter().all(|row| row.share == 0.0 && row.delta_pct.is_none()));
    }
}
