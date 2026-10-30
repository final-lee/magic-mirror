//! 이 신원에 대해 서버에 묻는 요청: 나는 누구인가(SelfSubjectReview), 이 네임스페이스에서 무엇을 할 수 있나(SelfSubjectRulesReview).
//! 둘 다 POST지만 아무것도 바꾸지 않는다. 이 앱에서 `create`를 부를 수 있는 K1의 유일한 파일이다(`hygiene`이 지킨다).
use k8s_openapi::api::authentication::v1::{SelfSubjectReview, SelfSubjectReviewStatus};
use k8s_openapi::api::authorization::v1::{SelfSubjectRulesReview, SelfSubjectRulesReviewSpec, SubjectRulesReviewStatus};
use kube::api::PostParams;
use kube::{Api, Client};
use serde::Serialize;

use super::connect::REQUEST_TIMEOUT;
use super::failure::{describe, failure_of, Endpoint, Failure};
use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IdentitySource {
    SelfSubjectReview,
    Kubeconfig,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub username: String,
    pub groups: Vec<String>,
    pub arn: Option<String>,
    pub source: IdentitySource,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRule {
    pub verbs: Vec<String>,
    pub api_groups: Vec<String>,
    pub resources: Vec<String>,
    pub resource_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NonResourceRule {
    pub verbs: Vec<String>,
    pub non_resource_urls: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rules {
    pub namespace: String,
    pub resource_rules: Vec<ResourceRule>,
    pub non_resource_rules: Vec<NonResourceRule>,
    pub incomplete: bool,
}

pub fn identity_of(status: &SelfSubjectReviewStatus) -> Identity {
    let info = status.user_info.as_ref();
    Identity {
        username: info.and_then(|u| u.username.clone()).unwrap_or_default(),
        groups: info.and_then(|u| u.groups.clone()).unwrap_or_default(),
        arn: info.and_then(|u| u.extra.as_ref()).and_then(|e| e.get("arn")).and_then(|v| v.first()).cloned(),
        source: IdentitySource::SelfSubjectReview,
    }
}

pub fn rules_of(status: &SubjectRulesReviewStatus, namespace: &str) -> Rules {
    Rules {
        namespace: namespace.to_string(),
        resource_rules: status
            .resource_rules
            .iter()
            .map(|r| ResourceRule {
                verbs: r.verbs.clone(),
                api_groups: r.api_groups.clone().unwrap_or_default(),
                resources: r.resources.clone().unwrap_or_default(),
                resource_names: r.resource_names.clone().unwrap_or_default(),
            })
            .collect(),
        non_resource_rules: status
            .non_resource_rules
            .iter()
            .map(|r| NonResourceRule { verbs: r.verbs.clone(), non_resource_urls: r.non_resource_urls.clone().unwrap_or_default() })
            .collect(),
        incomplete: status.incomplete,
    }
}

fn fallback(user: &str) -> Identity {
    Identity { username: user.to_string(), groups: vec![], arn: None, source: IdentitySource::Kubeconfig }
}

/// SelfSubjectReview(1.28+). 서버가 이 API를 모르면(404) kubeconfig 사용자 이름으로 대신한다.
/// 시간 초과는 늘 Unreachable로 알린다. 토큰이 만료돼 exec 플러그인이 요청 안에서 멈춘 경우도 여기로 온다.
pub async fn identity(client: &Client, kubeconfig_user: &str, endpoint: Endpoint) -> Result<Identity, AppError> {
    let api: Api<SelfSubjectReview> = Api::all(client.clone());
    match tokio::time::timeout(REQUEST_TIMEOUT, api.create(&PostParams::default(), &SelfSubjectReview::default())).await {
        Err(_) => Err(describe(&Failure::Unreachable, endpoint)),
        Ok(Ok(review)) => Ok(review.status.as_ref().map(identity_of).unwrap_or_else(|| fallback(kubeconfig_user))),
        Ok(Err(kube::Error::Api(status))) if status.code == 404 => Ok(fallback(kubeconfig_user)),
        Ok(Err(e)) => Err(describe(&failure_of(&e, "create", "selfsubjectreviews"), endpoint)),
    }
}

pub async fn rules(client: &Client, namespace: &str, endpoint: Endpoint) -> Result<Rules, AppError> {
    let api: Api<SelfSubjectRulesReview> = Api::all(client.clone());
    let review = SelfSubjectRulesReview { spec: SelfSubjectRulesReviewSpec { namespace: Some(namespace.to_string()) }, ..Default::default() };
    let out = tokio::time::timeout(REQUEST_TIMEOUT, api.create(&PostParams::default(), &review))
        .await
        .map_err(|_| describe(&Failure::Unreachable, endpoint))?
        .map_err(|e| describe(&failure_of(&e, "create", "selfsubjectrulesreviews"), endpoint))?;
    Ok(rules_or_incomplete(out.status.as_ref(), namespace))
}

/// 서버가 status를 비워 보내면 빈 목록을 "불완전"으로 돌려준다(화면이 버튼을 켜 두고 안내를 띄운다).
pub fn rules_or_incomplete(status: Option<&SubjectRulesReviewStatus>, namespace: &str) -> Rules {
    status.map(|s| rules_of(s, namespace)).unwrap_or(Rules { namespace: namespace.into(), resource_rules: vec![], non_resource_rules: vec![], incomplete: true })
}

#[cfg(test)]
mod tests;
