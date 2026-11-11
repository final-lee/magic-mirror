use super::*;
use serde_json::json;

const OWN: &str = "431847470565";
const TOPIC: &str = "arn:aws:sns:ap-northeast-2:431847470565:orders";

fn views(list: Vec<serde_json::Value>) -> Vec<StatementView> {
    policy::describe(
        &json!({"Version": "2012-10-17", "Statement": list}).to_string(),
        OWN,
    )
    .unwrap()
}

#[test]
fn grants_follow_iam_action_matching_and_not_action() {
    let v = views(vec![
        json!({"Effect": "Allow", "Principal": "*", "Action": ["SNS:Subscribe", "sns:Pub*"], "Resource": TOPIC}),
        json!({"Effect": "Allow", "Principal": "*", "NotAction": "sns:Publish", "Resource": TOPIC}),
        json!({"Effect": "Allow", "Principal": "*", "Action": "*", "Resource": TOPIC}),
    ]);
    assert!(
        grants(&v[0], "sns:Subscribe")
            && grants(&v[0], "sns:Publish")
            && !grants(&v[0], "sns:Receive")
    );
    assert!(!grants(&v[1], "sns:Publish") && grants(&v[1], "sns:Subscribe"));
    assert!(grants(&v[2], "sns:Receive"));
}

#[test]
fn access_rows_split_statements_by_principal() {
    let v = views(vec![
        json!({"Sid": "svc", "Effect": "Allow", "Principal": {"Service": ["events.amazonaws.com", "s3.amazonaws.com"]}, "Action": "sns:Publish", "Resource": TOPIC}),
        json!({"Effect": "Allow", "Principal": {"AWS": "arn:aws:iam::676499404107:root"}, "Action": ["sns:Subscribe", "sns:Publish"], "Resource": TOPIC, "Condition": {"StringEquals": {"aws:PrincipalOrgID": "o-1"}}}),
        json!({"Effect": "Allow", "Principal": {"AWS": "*"}, "Action": "sns:GetTopicAttributes", "Resource": TOPIC}),
        json!({"Effect": "Deny", "Principal": "*", "Action": "sns:Subscribe", "Resource": TOPIC}),
    ]);
    let rows = access_rows(&v);
    assert_eq!(rows.len(), 4);
    assert_eq!(
        (
            rows[0].principal.value.as_str(),
            rows[0].can_publish,
            rows[0].can_subscribe,
            rows[0].statement
        ),
        ("events.amazonaws.com", true, false, 0)
    );
    assert_eq!(rows[1].principal.value, "s3.amazonaws.com");
    assert_eq!(
        (
            rows[2].can_publish,
            rows[2].can_subscribe,
            rows[2].scope.clone()
        ),
        (true, true, Reach::CrossAccount)
    );
    assert_eq!(
        rows[2].conditions,
        ["aws:PrincipalOrgID · StringEquals · o-1"]
    );
    assert_eq!(
        (
            rows[3].effect.as_str(),
            rows[3].can_subscribe,
            rows[3].can_publish
        ),
        ("Deny", true, false)
    );
}

#[test]
fn analyzer_result_becomes_a_report_with_a_finding_only_on_fail() {
    let fail = public_access_report(
        TOPIC,
        Some(&CheckNoPublicAccessResult::Fail),
        Some("공개돼요".into()),
        vec!["문장 0".into()],
    );
    assert_eq!(fail.result, "fail");
    let finding = fail.finding.unwrap();
    assert_eq!(
        (
            finding.check.as_str(),
            finding.topic_arn.as_str(),
            finding.items.clone()
        ),
        ("publicPolicy", TOPIC, vec!["문장 0".to_string()])
    );
    let pass = public_access_report(
        TOPIC,
        Some(&CheckNoPublicAccessResult::Pass),
        None,
        Vec::new(),
    );
    assert_eq!(
        (pass.result.as_str(), pass.finding.is_none()),
        ("pass", true)
    );
    let unknown = public_access_report(TOPIC, None, None, Vec::new());
    assert_eq!(
        (unknown.result.as_str(), unknown.finding.is_none()),
        ("unknown", true)
    );
}

#[test]
fn validation_levels_map_from_the_analyzer() {
    assert_eq!(validation_level(&ValidatePolicyFindingType::Error), "error");
    assert_eq!(
        validation_level(&ValidatePolicyFindingType::SecurityWarning),
        "securityWarning"
    );
    assert_eq!(
        validation_level(&ValidatePolicyFindingType::Suggestion),
        "suggestion"
    );
    assert_eq!(
        validation_level(&ValidatePolicyFindingType::Warning),
        "warning"
    );
}
