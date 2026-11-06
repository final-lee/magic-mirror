use super::*;

const OWN: &str = "431847470565";
const TOPIC: &str = "arn:aws:sns:ap-northeast-2:431847470565:orders";

fn names(list: &[Publisher]) -> Vec<(&str, &str, bool)> {
    list.iter().map(|p| (p.kind.as_str(), p.name.as_str(), p.configured)).collect()
}

#[test]
fn default_topic_policy_allows_principals_of_this_account() {
    // S0에서 본 기본 주제 정책: Principal AWS * + AWS:SourceOwner
    let policy = format!(
        r#"{{"Version":"2008-10-17","Statement":[{{"Sid":"__default_statement_ID","Effect":"Allow","Principal":{{"AWS":"*"}},
        "Action":["SNS:GetTopicAttributes","SNS:Subscribe","SNS:Publish"],"Resource":"{TOPIC}",
        "Condition":{{"StringEquals":{{"AWS:SourceOwner":"{OWN}"}}}}}}]}}"#
    );
    assert_eq!(names(&policy_allowed(&policy, OWN)), vec![("policy", "이 계정 안의 주체", false)]);
}

#[test]
fn only_statements_that_allow_publish_count() {
    let policy = format!(
        r#"{{"Statement":[
        {{"Sid":"sub","Effect":"Allow","Principal":{{"AWS":"arn:aws:iam::676499404107:root"}},"Action":"SNS:Subscribe","Resource":"{TOPIC}"}},
        {{"Sid":"cw","Effect":"Allow","Principal":{{"Service":"cloudwatch.amazonaws.com"}},"Action":"sns:Publish","Resource":"{TOPIC}"}},
        {{"Sid":"x","Effect":"Allow","Principal":{{"AWS":"111122223333"}},"Action":"sns:*","Resource":"{TOPIC}"}},
        {{"Sid":"no","Effect":"Deny","Principal":"*","Action":"sns:Publish","Resource":"{TOPIC}"}}]}}"#
    );
    let got = policy_allowed(&policy, OWN);
    assert_eq!(names(&got), vec![("policy", "cloudwatch.amazonaws.com", false), ("policy", "계정 111122223333", false)]);
    assert_eq!(got[0].principal.as_deref(), Some("cloudwatch.amazonaws.com"));
    assert_eq!(got[1].principal, None);
}

#[test]
fn unreadable_policy_gives_no_publishers() {
    assert!(policy_allowed("not json", OWN).is_empty());
}

#[test]
fn rules_on_other_buses_carry_the_bus_name() {
    assert_eq!(rule_publisher("default", "nightly").name, "nightly");
    assert_eq!(rule_publisher("orders-bus", "paid").name, "orders-bus/paid");
    assert_eq!(rule_publisher("default", "x").principal.as_deref(), Some("events.amazonaws.com"));
}

#[test]
fn lambda_destination_must_be_this_topic() {
    assert!(destination_matches(Some(TOPIC), TOPIC));
    assert!(!destination_matches(Some("arn:aws:sns:ap-northeast-2:431847470565:orders-dlq"), TOPIC));
    assert!(!destination_matches(None, TOPIC));
}

#[test]
fn merge_puts_configured_first_and_drops_duplicates() {
    let p = |kind: &str, name: &str, configured: bool| Publisher {
        kind: kind.into(),
        name: name.into(),
        arn: None,
        principal: None,
        configured,
    };
    let merged = merge(vec![
        p("policy", "모든 주체(*)", false),
        p("elasticache", "cache-a", true),
        p("alarm", "cpu-high", true),
        p("elasticache", "cache-a", true),
    ]);
    assert_eq!(
        names(&merged),
        vec![("alarm", "cpu-high", true), ("elasticache", "cache-a", true), ("policy", "모든 주체(*)", false)]
    );
}
