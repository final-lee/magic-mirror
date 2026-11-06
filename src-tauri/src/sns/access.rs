//! 주제 정책 화면의 데이터: 정책 문장 풀이, 누가 발행·구독할 수 있나, Access Analyzer 검사, 주제 점검.
//! 읽기만 한다(`sns:GetTopicAttributes` 등, `access-analyzer:ValidatePolicy`·`CheckNoPublicAccess`).

use aws_config::SdkConfig;
use aws_sdk_accessanalyzer::types::{AccessCheckResourceType, CheckNoPublicAccessResult, Locale, PolicyType, ValidatePolicyFinding, ValidatePolicyFindingType};
use serde::Serialize;
use crate::error::{from_sdk, AppError};
use crate::iam::policy as iam_policy;
use super::account::existence;
use super::fetch;
use super::findings::{self, PublicAccess, SnsFinding, TopicFacts};
use super::policy::{self, PrincipalView, Reach, StatementView};

/// 문장이 이 작업을 허용(Deny면 거부)하는 대상에 드는가. `NotAction`이면 목록 밖의 작업이 대상이다.
pub fn grants(statement: &StatementView, action: &str) -> bool {
    let listed = statement.actions.iter().any(|pattern| iam_policy::action_matches(pattern, action));
    listed != statement.not_action
}

/// 정책 쪽 주체 한 줄: 누가 발행·구독할 수 있나
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessRow {
    pub principal: PrincipalView,
    /// "Allow" | "Deny"
    pub effect: String,
    pub can_publish: bool,
    pub can_subscribe: bool,
    pub statement: usize,
    pub scope: Reach,
    pub conditions: Vec<String>,
}

/// 문장을 주체별 발행·구독 줄로 편다. 둘 다 아니면 줄을 만들지 않는다.
pub fn access_rows(statements: &[StatementView]) -> Vec<AccessRow> {
    let mut rows = Vec::new();
    for s in statements {
        let (publish, subscribe) = (grants(s, "sns:Publish"), grants(s, "sns:Subscribe"));
        if !publish && !subscribe { continue; }
        for p in &s.principals {
            rows.push(AccessRow { principal: p.clone(), effect: s.effect.clone(), can_publish: publish, can_subscribe: subscribe, statement: s.index, scope: s.scope.clone(), conditions: s.conditions.clone() });
        }
    }
    rows
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyFindingView {
    /// "error" | "securityWarning" | "warning" | "suggestion"
    pub level: String,
    pub code: String,
    pub message: String,
    pub learn_more: Option<String>,
}

fn validation_level(kind: &ValidatePolicyFindingType) -> &'static str {
    match kind {
        ValidatePolicyFindingType::Error => "error",
        ValidatePolicyFindingType::SecurityWarning => "securityWarning",
        ValidatePolicyFindingType::Suggestion => "suggestion",
        _ => "warning",
    }
}

fn validation_view(f: &ValidatePolicyFinding) -> PolicyFindingView {
    PolicyFindingView { level: validation_level(f.finding_type()).into(), code: f.issue_code().into(), message: f.finding_details().into(), learn_more: Some(f.learn_more_link()).filter(|l| !l.is_empty()).map(str::to_owned) }
}

/// 무료 `ValidatePolicy`. SNS 주제는 `validatePolicyResourceType` 값에 없어서(S3·DynamoDB·IAM 신뢰 정책만 받는다) 종류 없이 자원 정책으로 검사한다.
async fn validate(cfg: &SdkConfig, document: &str) -> Result<Vec<PolicyFindingView>, AppError> {
    let client = aws_sdk_accessanalyzer::Client::new(cfg);
    let mut pages = client.validate_policy().policy_document(document).policy_type(PolicyType::ResourcePolicy).locale(Locale::Ko).into_paginator().send();
    let mut out = Vec::new();
    while let Some(page) = pages.next().await {
        out.extend(page.map_err(|e| from_sdk(e, "access-analyzer:ValidatePolicy"))?.findings().iter().map(validation_view));
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnsTopicPolicy {
    pub topic_arn: String,
    /// 들여쓴 정책 JSON
    pub policy: Option<String>,
    pub statements: Vec<StatementView>,
    pub statements_error: Option<String>,
    pub access: Vec<AccessRow>,
    /// `None`이면 검사하지 못한 것이다(이유는 `errors`)
    pub validation: Option<Vec<PolicyFindingView>>,
    pub findings: Vec<SnsFinding>,
    pub errors: Vec<AppError>,
}

pub async fn topic_policy(cfg: &SdkConfig, arn: &str, account: &str, region: &str) -> Result<SnsTopicPolicy, AppError> {
    let topic = fetch::topic(cfg, arn, account, region).await?;
    let mut errors = topic.errors.clone();
    let raw = topic.attributes.get("Policy").filter(|p| !p.is_empty()).cloned();
    let (statements, statements_error) = match raw.as_deref().map(|p| policy::describe(p, account)) {
        Some(Ok(s)) => (s, None),
        Some(Err(e)) => (Vec::new(), Some(e)),
        None => (Vec::new(), None),
    };
    let validation = match raw.as_deref() {
        Some(doc) => match validate(cfg, doc).await {
            Ok(v) => Some(v),
            Err(e @ (AppError::SsoExpired | AppError::Throttled)) => return Err(e),
            Err(e) => { errors.push(e); None }
        },
        None => Some(Vec::new()),
    };
    let facts = TopicFacts::from_topic(&topic);
    let protocols: Vec<&str> = facts.subscriptions.iter().map(|s| s.protocol.as_str()).collect();
    let (existence, existence_errors) = existence(cfg, &protocols, None).await;
    errors.extend(existence_errors);
    let findings = findings::topic_findings(&facts, &statements, None, account, region, &existence);
    Ok(SnsTopicPolicy { topic_arn: arn.into(), policy: raw.as_deref().map(iam_policy::pretty), access: access_rows(&statements), statements, statements_error, validation, findings, errors })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicAccessReport {
    /// "pass" | "fail" | "unknown"
    pub result: String,
    pub message: Option<String>,
    pub reasons: Vec<String>,
    /// FAIL이면 `publicPolicy` 점검 결과. 화면은 이 주제의 점검 목록에 합친다.
    pub finding: Option<SnsFinding>,
}

pub fn public_access_report(topic_arn: &str, result: Option<&CheckNoPublicAccessResult>, message: Option<String>, reasons: Vec<String>) -> PublicAccessReport {
    let (label, fail) = match result { Some(CheckNoPublicAccessResult::Pass) => ("pass", false), Some(CheckNoPublicAccessResult::Fail) => ("fail", true), _ => ("unknown", false) };
    let public = PublicAccess { fail, message: message.clone(), reasons: reasons.clone() };
    PublicAccessReport { result: label.into(), message, reasons, finding: findings::public_access_finding(topic_arn, &public) }
}

/// 유료(호출당 $0.002) `CheckNoPublicAccess`. 버튼을 눌렀을 때만 부른다.
pub async fn check_public_access(cfg: &SdkConfig, arn: &str, account: &str, region: &str) -> Result<PublicAccessReport, AppError> {
    if !findings::is_own_topic(arn, account, region) { return Err(AppError::other("현재 계정과 리전의 주제만 점검할 수 있어요")); }
    let sns = aws_sdk_sns::Client::new(cfg);
    let attrs = sns.get_topic_attributes().topic_arn(arn).send().await.map_err(|e| from_sdk(e, "sns:GetTopicAttributes"))?;
    let Some(document) = attrs.attributes().and_then(|a| a.get("Policy")).filter(|p| !p.is_empty()) else {
        return Ok(PublicAccessReport { result: "pass".into(), message: Some("주제 정책이 없어요".into()), reasons: Vec::new(), finding: None });
    };
    let client = aws_sdk_accessanalyzer::Client::new(cfg);
    let out = client.check_no_public_access().policy_document(document).resource_type(AccessCheckResourceType::SnsTopic).send().await.map_err(|e| from_sdk(e, "access-analyzer:CheckNoPublicAccess"))?;
    let reasons = out.reasons().iter().filter_map(|r| r.description().map(str::to_owned)).collect();
    Ok(public_access_report(arn, out.result(), out.message().map(str::to_owned), reasons))
}

#[cfg(test)]
mod tests;
