//! 앱이 Cost Explorer에 보내는 요청. 캐시 키이기도 하다: 같은 조회는 같은 JSON으로 직렬화된다
//! (필드 순서는 구조체 순서, 필터는 받은 순서 그대로라서 순서가 다르면 다른 요청이다).

use serde::{Deserialize, Serialize};

use super::model::{CostFilter, CostGroupBy, CostMetric, Granularity};

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CeRequest {
    /// `GetCostAndUsage`
    Usage {
        start: String,
        end: String,
        granularity: Granularity,
        metric: CostMetric,
        exclude_credits: bool,
        filters: Vec<CostFilter>,
        group: Option<CostGroupBy>,
    },
    /// `GetCostForecast`(월별, 80% 구간)
    Forecast { start: String, end: String, metric: CostMetric, exclude_credits: bool, filters: Vec<CostFilter> },
    /// `ListCostAllocationTags(Status=Active)`
    TagKeys,
}

impl CeRequest {
    /// 캐시 키에 쓰는 정규 JSON
    pub fn canonical(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::model::CostDimension;

    fn usage(filters: Vec<CostFilter>) -> CeRequest {
        CeRequest::Usage {
            start: "2026-10-01".into(),
            end: "2026-10-30".into(),
            granularity: Granularity::Daily,
            metric: CostMetric::UnblendedCost,
            exclude_credits: true,
            filters,
            group: Some(CostGroupBy::Service),
        }
    }

    #[test]
    fn equal_requests_serialize_equally_and_filter_order_matters() {
        let a = CostFilter::Dimension { dimension: CostDimension::Service, value: "Tax".into() };
        let b = CostFilter::Tag { tag: "team".into(), value: "api".into() };
        assert_eq!(usage(vec![a.clone(), b.clone()]).canonical(), usage(vec![a.clone(), b.clone()]).canonical());
        assert_ne!(usage(vec![a.clone(), b.clone()]).canonical(), usage(vec![b, a]).canonical());
        assert_eq!(CeRequest::TagKeys.canonical(), r#"{"op":"tagKeys"}"#);
    }

    #[test]
    fn canonical_json_names_every_field() {
        let text = usage(vec![]).canonical();
        assert_eq!(
            text,
            r#"{"op":"usage","start":"2026-10-01","end":"2026-10-30","granularity":"daily","metric":"UnblendedCost","excludeCredits":true,"filters":[],"group":{"kind":"service"}}"#
        );
    }
}
