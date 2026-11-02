//! 앱이 Cost Explorer에 보내는 요청. 캐시 키이기도 하다: 같은 조회는 같은 JSON으로 직렬화된다
//! (필드 순서는 구조체 순서, 필터는 받은 순서 그대로라서 순서가 다르면 다른 요청이다).

use serde::{Deserialize, Serialize};

use aws_sdk_costexplorer::types::{Dimension, DimensionValues, Expression, GroupDefinition, GroupDefinitionType, MatchOption, TagValues};

use super::model::{CostDimension, CostFilter, CostGroupBy, CostMetric, Granularity};

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

/// 조회에 붙이는 필터. 조각이 없으면 None, 하나면 그 조각, 둘 이상이면 `And`
/// (Cost Explorer는 원소가 하나뿐인 `And`를 거절한다).
pub fn filter_expression(exclude_credits: bool, filters: &[CostFilter]) -> Option<Expression> {
    let mut parts: Vec<Expression> = Vec::new();
    if exclude_credits {
        let credits = DimensionValues::builder().key(Dimension::RecordType).values("Credit").values("Refund").build();
        parts.push(Expression::builder().not(Expression::builder().dimensions(credits).build()).build());
    }
    for filter in filters {
        let part = match filter {
            CostFilter::Dimension { dimension, value } => {
                let key = match dimension {
                    CostDimension::Service => Dimension::Service,
                    CostDimension::Region => Dimension::Region,
                    CostDimension::UsageType => Dimension::UsageType,
                };
                Expression::builder().dimensions(DimensionValues::builder().key(key).values(value).build()).build()
            }
            // 값이 비어 있으면 "이 태그가 없는 비용"
            CostFilter::Tag { tag, value } if value.is_empty() => {
                Expression::builder().tags(TagValues::builder().key(tag).match_options(MatchOption::Absent).build()).build()
            }
            CostFilter::Tag { tag, value } => Expression::builder().tags(TagValues::builder().key(tag).values(value).build()).build(),
        };
        parts.push(part);
    }
    match parts.len() {
        0 => None,
        1 => parts.pop(),
        _ => Some(parts.into_iter().fold(Expression::builder(), |builder, part| builder.and(part)).build()),
    }
}

/// `GroupBy` 한 칸
pub fn group_definition(g: &CostGroupBy) -> GroupDefinition {
    let dimension = |d: Dimension| GroupDefinition::builder().r#type(GroupDefinitionType::Dimension).key(d.as_str()).build();
    match g {
        CostGroupBy::Service => dimension(Dimension::Service),
        CostGroupBy::Region => dimension(Dimension::Region),
        CostGroupBy::UsageType => dimension(Dimension::UsageType),
        CostGroupBy::Tag { key } => GroupDefinition::builder().r#type(GroupDefinitionType::Tag).key(key).build(),
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
