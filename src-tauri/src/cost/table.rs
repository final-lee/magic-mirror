//! Cost Explorer 응답을 앱이 쓰는 모양으로 옮긴 것. SDK 타입은 직렬화되지 않으므로 캐시에는 이것을 담는다.

use std::str::FromStr;

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::model::Forecast;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CeTable {
    /// 응답에서 처음 본 통화 단위. 줄이 하나도 없으면 None
    pub unit: Option<String>,
    pub periods: Vec<CePeriod>,
    pub forecast: Option<Forecast>,
    pub tag_keys: Vec<String>,
}

/// 응답의 한 기간(하루나 한 달)
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CePeriod {
    pub start: String,
    pub estimated: bool,
    /// (그룹 키, 금액). 태그 그룹 키는 `"<태그 키>$<값>"` 그대로
    pub groups: Vec<(String, String)>,
    /// 묶지 않은 조회의 합계. 묶은 조회에서는 Cost Explorer가 빈 값을 보내서 None
    pub total: Option<String>,
}

/// Cost Explorer 금액 문자열 → 소수. 읽지 못하면 0(Cost Explorer는 늘 숫자를 보낸다).
pub fn dec(s: &str) -> Decimal {
    Decimal::from_str(s.trim()).unwrap_or(Decimal::ZERO)
}

/// 소수 → 응답 문자열(뒤의 0을 뗀다: `"0.30"` → `"0.3"`, `"0.000"` → `"0"`).
pub fn out(d: Decimal) -> String {
    d.normalize().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_strings_add_exactly_and_print_without_trailing_zeros() {
        assert_eq!(out(dec("0.1") + dec("0.2")), "0.3");
        assert_eq!(out(dec("0.53168163") + dec("0.0000050000")), "0.53168663");
        assert_eq!(out(dec("0.000")), "0");
        assert_eq!(out(dec("-1.50")), "-1.5");
        assert_eq!(out(dec("749.6686275704207")), "749.6686275704207");
    }

    #[test]
    fn unreadable_amounts_are_zero() {
        assert_eq!(dec(""), Decimal::ZERO);
        assert_eq!(dec("n/a"), Decimal::ZERO);
        assert_eq!(dec(" 2.5 "), dec("2.5"));
    }

    #[test]
    fn tables_round_trip_through_json() {
        let t = CeTable {
            unit: Some("USD".into()),
            periods: vec![CePeriod { start: "2026-10-01".into(), estimated: true, groups: vec![("Tax".into(), "63.95".into())], total: None }],
            forecast: Some(Forecast { mean: "1".into(), low: "0.5".into(), high: "1.5".into() }),
            tag_keys: vec!["team".into()],
        };
        let back: CeTable = serde_json::from_str(&serde_json::to_string(&t).unwrap()).unwrap();
        assert_eq!(back, t);
    }
}
