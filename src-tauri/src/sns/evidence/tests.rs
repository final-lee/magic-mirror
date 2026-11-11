use super::*;

#[test]
fn parses_sns_delivery_failure_shape() {
    let raw = r#"{"notification":{"messageId":"abc","topicArn":"arn","timestamp":"2026-11-06T01:02:03Z"},"delivery":{"destination":"https://example.test","providerResponse":"{\"error\":\"timeout\"}","statusCode":500,"attempts":3},"status":"FAILURE"}"#;
    let failure = parse_failure(raw).unwrap();
    assert_eq!(failure.destination, "https://example.test");
    assert_eq!(failure.status_code.as_deref(), Some("500"));
    assert_eq!(failure.response.as_deref(), Some(r#"{"error":"timeout"}"#));
    assert_eq!(failure.attempts, Some(3));
    assert!(parse_failure("not json").is_none());
}
