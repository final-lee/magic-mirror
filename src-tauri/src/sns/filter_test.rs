use serde::{Deserialize, Serialize};
use super::filter::{self, FilterVerdict, PolicyError, Sample, Scope};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterInput { pub key: String, pub policy: Option<String>, pub scope: Scope }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterResult { pub key: String, pub verdict: Option<FilterVerdict>, pub errors: Vec<PolicyError>, pub summary: Option<String> }

pub fn test(policies: Vec<FilterInput>, sample: Sample) -> Vec<FilterResult> {
    policies.into_iter().map(|input| {
        let Some(raw) = input.policy else { return FilterResult { key: input.key, verdict: Some(FilterVerdict { matched: true, key: None, reason: None }), errors: vec![], summary: None }; };
        match filter::parse_policy(&raw) {
            Err(error) => FilterResult { key: input.key, verdict: None, errors: vec![error], summary: None },
            Ok(policy) => {
                let errors = filter::validate(&policy, input.scope);
                let summary = Some(filter::summarize(&policy, input.scope));
                let verdict = errors.is_empty().then(|| filter::evaluate(&policy, input.scope, &sample));
                FilterResult { key: input.key, verdict, errors, summary }
            }
        }
    }).collect()
}

#[cfg(test)]
mod tests;
