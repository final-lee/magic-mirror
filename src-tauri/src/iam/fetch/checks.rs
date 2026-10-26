//! AWS에 물어 확인하는 것: 정책 시뮬레이터(주체별 판정)와 정책 검사(JSON 문법 + Access Analyzer).

use aws_config::SdkConfig;
use aws_sdk_accessanalyzer::types::{Locale, PolicyType, ValidatePolicyFinding, ValidatePolicyFindingType};
use aws_sdk_iam::types::{EvaluationResult, PolicyEvaluationDecisionType};
use serde::de::IgnoredAny;
use serde::Serialize;

use crate::adapters::util::{map_concurrent, settle};
use crate::error::{from_sdk, AppError};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Allowed,
    ExplicitDeny,
    ImplicitDeny,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulateResult {
    pub principal_arn: String,
    pub decision: Decision,
    /// 판정에 걸린 정책의 이름(관리형·인라인). 같은 정책은 한 번만
    pub matched_statements: Vec<String>,
    /// 조건에 쓰이는데 시뮬레이션에 값을 주지 않은 키
    pub missing_context: Vec<String>,
}

/// 작업 하나 × 리소스 하나를 물었으니 결과는 하나다. 없으면 허용되지 않은 것으로 본다.
fn simulate_result(principal_arn: &str, results: &[EvaluationResult]) -> SimulateResult {
    let first = results.first();
    let decision = match first.map(EvaluationResult::eval_decision) {
        Some(PolicyEvaluationDecisionType::Allowed) => Decision::Allowed,
        Some(PolicyEvaluationDecisionType::ExplicitDeny) => Decision::ExplicitDeny,
        _ => Decision::ImplicitDeny,
    };
    let mut matched_statements: Vec<String> = Vec::new();
    for id in first.into_iter().flat_map(|r| r.matched_statements()).filter_map(|st| st.source_policy_id()) {
        if !matched_statements.iter().any(|seen| seen == id) {
            matched_statements.push(id.to_string());
        }
    }
    SimulateResult {
        principal_arn: principal_arn.to_string(),
        decision,
        matched_statements,
        missing_context: first.map(|r| r.missing_context_values().to_vec()).unwrap_or_default(),
    }
}

async fn simulate_one(client: &aws_sdk_iam::Client, principal_arn: &str, action: &str, resource: Option<&str>) -> Result<SimulateResult, AppError> {
    let mut request = client.simulate_principal_policy().policy_source_arn(principal_arn).action_names(action);
    if let Some(resource) = resource {
        request = request.resource_arns(resource);
    }
    let out = request.send().await.map_err(|e| from_sdk(e, "iam:SimulatePrincipalPolicy"))?;
    Ok(simulate_result(principal_arn, out.evaluation_results()))
}

/// 주체마다 `SimulatePrincipalPolicy`로 AWS의 판정을 받는다(8개씩 동시에). 조직 SCP·리소스 기반 정책은 반영되지 않는다.
/// 한두 주체만 실패하면 그 주체만 결과에서 빠지고, 전부 실패하거나 SSO 만료·요청 제한이면 오류다.
pub(crate) async fn simulate(client: &aws_sdk_iam::Client, principal_arns: Vec<String>, action: &str, resource: Option<&str>) -> Result<Vec<SimulateResult>, AppError> {
    if action.contains(['*', '?']) {
        return Err(AppError::other("정책 시뮬레이터는 와일드카드(*, ?)가 든 작업 이름을 지원하지 않아요"));
    }
    let results = map_concurrent(principal_arns, |arn| async move { simulate_one(client, &arn, action, resource).await.map(Some) }).await;
    Ok(settle(results, |_, _| None)?.into_iter().flatten().collect())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FindingLevel {
    Error,
    SecurityWarning,
    Warning,
    Suggestion,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ValidationFinding {
    pub level: FindingLevel,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub syntax_error: Option<String>,
    /// Access Analyzer로 검사했는지. 권한이 없거나 호출이 실패하면 거짓이고, 문법 검사 결과만 있다
    pub analyzer_available: bool,
    pub findings: Vec<ValidationFinding>,
}

/// JSON 문법만 본다. 정책 구조(Effect·Action 등)는 Access Analyzer가 본다.
pub fn syntax_error(document: &str) -> Option<String> {
    serde_json::from_str::<IgnoredAny>(document).err().map(|e| format!("JSON 형식이 올바르지 않아요: {e}"))
}

fn finding(f: &ValidatePolicyFinding) -> ValidationFinding {
    let level = match f.finding_type() {
        ValidatePolicyFindingType::Error => FindingLevel::Error,
        ValidatePolicyFindingType::SecurityWarning => FindingLevel::SecurityWarning,
        ValidatePolicyFindingType::Suggestion => FindingLevel::Suggestion,
        // 모르는 종류는 경고로 보여 준다
        _ => FindingLevel::Warning,
    };
    ValidationFinding { level, code: f.issue_code().to_string(), message: f.finding_details().to_string() }
}

async fn analyze(cfg: &SdkConfig, document: &str) -> Result<Vec<ValidationFinding>, AppError> {
    let client = aws_sdk_accessanalyzer::Client::new(cfg);
    let mut pages = client.validate_policy().policy_document(document).policy_type(PolicyType::IdentityPolicy).locale(Locale::Ko).into_paginator().send();
    let mut findings = Vec::new();
    while let Some(page) = pages.next().await {
        findings.extend(page.map_err(|e| from_sdk(e, "access-analyzer:ValidatePolicy"))?.findings().iter().map(finding));
    }
    Ok(findings)
}

/// JSON 문법이 틀렸을 때의 결과. 검사기는 부르지 않았으니 못 쓴다고 말하지 않으려고 `analyzer_available`은 참으로 둔다.
pub(crate) fn syntax_failure(document: &str) -> Option<ValidationResult> {
    syntax_error(document).map(|error| ValidationResult { syntax_error: Some(error), analyzer_available: true, findings: Vec::new() })
}

/// 검사기 결과를 화면 값으로. 검사기를 못 쓰면(권한 없음 등) 문법 결과만 남긴다.
fn analyzer_outcome(result: Result<Vec<ValidationFinding>, AppError>) -> Result<ValidationResult, AppError> {
    match result {
        Ok(findings) => Ok(ValidationResult { syntax_error: None, analyzer_available: true, findings }),
        // 다시 로그인하거나 잠시 뒤에 하면 되는 오류라 "검사기를 쓸 수 없다"로 바꾸지 않는다
        Err(e @ (AppError::SsoExpired | AppError::Throttled)) => Err(e),
        Err(_) => Ok(ValidationResult { syntax_error: None, analyzer_available: false, findings: Vec::new() }),
    }
}

/// 정책 문서를 검사한다. JSON 문법이 틀리면 거기서 멈춘다. 맞으면 Access Analyzer(`IDENTITY_POLICY`)로 검사하고,
/// 검사기를 못 쓰면(권한 없음 등) 문법 결과만 남긴다. SSO 만료·요청 제한은 오류다.
pub(crate) async fn validate(cfg: &SdkConfig, document: &str) -> Result<ValidationResult, AppError> {
    if let Some(failure) = syntax_failure(document) {
        return Ok(failure);
    }
    analyzer_outcome(analyze(cfg, document).await)
}

#[cfg(test)]
mod tests {
    use aws_sdk_iam::types::Statement;
    use serde_json::json;

    use super::*;

    fn evaluation(decision: PolicyEvaluationDecisionType, matched: &[&str], missing: &[&str]) -> EvaluationResult {
        let mut b = EvaluationResult::builder().eval_action_name("s3:GetObject").eval_decision(decision);
        for id in matched {
            b = b.matched_statements(Statement::builder().source_policy_id(*id).build());
        }
        for key in missing {
            b = b.missing_context_values(*key);
        }
        b.build().unwrap()
    }

    #[test]
    fn decisions_map_to_the_contract_names() {
        let arn = "arn:aws:iam::1:user/a";
        let allowed = simulate_result(arn, &[evaluation(PolicyEvaluationDecisionType::Allowed, &["app-deploy"], &[])]);
        assert_eq!((allowed.principal_arn.as_str(), allowed.decision), (arn, Decision::Allowed));
        assert_eq!(allowed.matched_statements, vec!["app-deploy".to_string()]);
        assert_eq!(simulate_result(arn, &[evaluation(PolicyEvaluationDecisionType::ExplicitDeny, &["guard"], &[])]).decision, Decision::ExplicitDeny);
        assert_eq!(simulate_result(arn, &[evaluation(PolicyEvaluationDecisionType::ImplicitDeny, &[], &[])]).decision, Decision::ImplicitDeny);
        assert_eq!(simulate_result(arn, &[]).decision, Decision::ImplicitDeny);
    }

    #[test]
    fn matched_policies_are_listed_once_and_missing_context_is_kept() {
        let result = simulate_result(
            "arn:aws:iam::1:role/r",
            &[evaluation(PolicyEvaluationDecisionType::Allowed, &["p1", "p2", "p1"], &["aws:SourceIp", "aws:UserAgent"])],
        );
        assert_eq!(result.matched_statements, vec!["p1".to_string(), "p2".to_string()]);
        assert_eq!(result.missing_context, vec!["aws:SourceIp".to_string(), "aws:UserAgent".to_string()]);
        let empty = simulate_result("arn:aws:iam::1:role/r", &[]);
        assert!(empty.matched_statements.is_empty() && empty.missing_context.is_empty());
    }

    #[test]
    fn simulate_result_json_shape() {
        let result = simulate_result("arn:aws:iam::1:user/a", &[evaluation(PolicyEvaluationDecisionType::ExplicitDeny, &["guard"], &[])]);
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({ "principalArn": "arn:aws:iam::1:user/a", "decision": "explicitDeny", "matchedStatements": ["guard"], "missingContext": [] })
        );
    }

    #[test]
    fn syntax_errors_are_reported_in_korean() {
        assert_eq!(syntax_error("{\"Version\": \"2012-10-17\", \"Statement\": []}"), None);
        assert_eq!(syntax_error("  [1, 2]  "), None);
        for bad in ["", "{", "{\"a\": }", "{} {}", "not json"] {
            let error = syntax_error(bad).unwrap_or_else(|| panic!("{bad:?}는 오류여야 해요"));
            assert!(error.starts_with("JSON 형식이 올바르지 않아요: "), "{error}");
        }
    }

    #[test]
    fn a_syntax_failure_stops_before_the_analyzer_and_does_not_blame_it() {
        let failure = syntax_failure("{ nope").unwrap();
        assert!(failure.syntax_error.as_deref().unwrap().starts_with("JSON 형식이 올바르지 않아요: "));
        assert!(failure.analyzer_available && failure.findings.is_empty());
        assert_eq!(syntax_failure("{\"Statement\": []}"), None);
    }

    fn analyzer_finding(kind: ValidatePolicyFindingType) -> ValidatePolicyFinding {
        ValidatePolicyFinding::builder()
            .finding_details("Resource가 필요해요")
            .finding_type(kind)
            .issue_code("MISSING_RESOURCE")
            .learn_more_link("https://docs.aws.amazon.com/")
            .set_locations(Some(Vec::new()))
            .build()
            .unwrap()
    }

    #[test]
    fn analyzer_finding_levels() {
        let level = |kind| finding(&analyzer_finding(kind)).level;
        assert_eq!(level(ValidatePolicyFindingType::Error), FindingLevel::Error);
        assert_eq!(level(ValidatePolicyFindingType::SecurityWarning), FindingLevel::SecurityWarning);
        assert_eq!(level(ValidatePolicyFindingType::Warning), FindingLevel::Warning);
        assert_eq!(level(ValidatePolicyFindingType::Suggestion), FindingLevel::Suggestion);
        assert_eq!(level(ValidatePolicyFindingType::from("SOMETHING_NEW")), FindingLevel::Warning);
        let f = finding(&analyzer_finding(ValidatePolicyFindingType::Error));
        assert_eq!((f.code.as_str(), f.message.as_str()), ("MISSING_RESOURCE", "Resource가 필요해요"));
    }

    #[test]
    fn analyzer_failures_turn_it_off_but_sso_expiry_and_throttling_are_errors() {
        let found = vec![finding(&analyzer_finding(ValidatePolicyFindingType::Error))];
        assert_eq!(analyzer_outcome(Ok(found.clone())), Ok(ValidationResult { syntax_error: None, analyzer_available: true, findings: found }));
        // 권한이 없거나 다른 이유로 못 쓰면 문법 결과만 남는다
        for unavailable in [AppError::AccessDenied { action: "access-analyzer:ValidatePolicy".into() }, AppError::other("x"), AppError::Network { message: "n".into() }] {
            assert_eq!(analyzer_outcome(Err(unavailable)), Ok(ValidationResult { syntax_error: None, analyzer_available: false, findings: Vec::new() }));
        }
        // 다시 로그인하거나 잠시 뒤에 하면 되는 오류는 검사기가 없다고 말하지 않고 그대로 알린다
        for retry in [AppError::SsoExpired, AppError::Throttled] {
            assert_eq!(analyzer_outcome(Err(retry.clone())), Err(retry));
        }
    }

    #[test]
    fn validation_result_json_shape() {
        let result = ValidationResult {
            syntax_error: None,
            analyzer_available: true,
            findings: vec![finding(&analyzer_finding(ValidatePolicyFindingType::SecurityWarning))],
        };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "syntaxError": null, "analyzerAvailable": true,
                "findings": [{ "level": "securityWarning", "code": "MISSING_RESOURCE", "message": "Resource가 필요해요" }]
            })
        );
    }
}
