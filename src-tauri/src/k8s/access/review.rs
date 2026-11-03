//! `SubjectAccessReview`: 엔진의 계산을 클러스터의 실제 판단과 맞춰 본다. POST지만 아무것도 바꾸지 않는다.
//! 이 호출이 가능한 신원(`create subjectaccessreviews`)에서만 화면이 단추를 켠다.
use k8s_openapi::api::authorization::v1::{NonResourceAttributes, ResourceAttributes, SubjectAccessReview, SubjectAccessReviewSpec};
use kube::api::PostParams;
use kube::{Api, Client};
use serde::Serialize;

use super::engine::Query;
use crate::error::AppError;
use crate::k8s::connect::REQUEST_TIMEOUT;
use crate::k8s::failure::{describe, failure_of, Endpoint, Failure};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewResult {
    pub allowed: bool,
    /// 명시적으로 거부한 인가기가 있다
    pub denied: bool,
    pub reason: Option<String>,
}

fn nonempty(text: &str) -> Option<String> {
    (!text.is_empty()).then(|| text.to_string())
}

/// 리소스 요청의 SubjectAccessReview 본문
pub fn spec_of(user: Option<&str>, groups: &[String], q: &Query) -> SubjectAccessReviewSpec {
    SubjectAccessReviewSpec {
        user: user.map(str::to_string),
        groups: if groups.is_empty() { None } else { Some(groups.to_vec()) },
        resource_attributes: Some(ResourceAttributes {
            verb: Some(q.verb.clone()),
            group: nonempty(&q.group),
            resource: Some(q.resource.clone()),
            subresource: q.subresource.clone().filter(|s| !s.is_empty()),
            namespace: q.namespace.clone().filter(|s| !s.is_empty()),
            name: q.name.clone().filter(|s| !s.is_empty()),
            ..ResourceAttributes::default()
        }),
        ..SubjectAccessReviewSpec::default()
    }
}

pub async fn review(client: &Client, user: Option<&str>, groups: &[String], q: &Query, endpoint: Endpoint) -> Result<ReviewResult, AppError> {
    ask(client, spec_of(user, groups, q), endpoint).await
}

/// 비리소스 URL(`/healthz` 등) 요청의 SubjectAccessReview
pub async fn review_non_resource(client: &Client, user: Option<&str>, groups: &[String], verb: &str, path: &str, endpoint: Endpoint) -> Result<ReviewResult, AppError> {
    let spec = SubjectAccessReviewSpec {
        user: user.map(str::to_string),
        groups: if groups.is_empty() { None } else { Some(groups.to_vec()) },
        non_resource_attributes: Some(NonResourceAttributes { path: Some(path.to_string()), verb: Some(verb.to_string()) }),
        ..SubjectAccessReviewSpec::default()
    };
    ask(client, spec, endpoint).await
}

async fn ask(client: &Client, spec: SubjectAccessReviewSpec, endpoint: Endpoint) -> Result<ReviewResult, AppError> {
    let api: Api<SubjectAccessReview> = Api::all(client.clone());
    let body = SubjectAccessReview { spec, ..SubjectAccessReview::default() };
    let out = tokio::time::timeout(REQUEST_TIMEOUT, api.create(&PostParams::default(), &body))
        .await
        .map_err(|_| describe(&Failure::Unreachable, endpoint))?
        .map_err(|e| describe(&failure_of(&e, "create", "subjectaccessreviews"), endpoint))?;
    let status = out.status.unwrap_or_default();
    Ok(ReviewResult { allowed: status.allowed, denied: status.denied.unwrap_or(false), reason: status.reason.filter(|r| !r.is_empty()) })
}
