use super::*;
use serde_json::json;

const ACCOUNT: &str = "111111111111";
const TOPIC: &str = "arn:aws:sns:ap-northeast-2:111111111111:alerts";
const RULE: &str = "arn:aws:events:ap-northeast-2:111111111111:rule/karpenter-spot";
const BUCKET: &str = "arn:aws:s3:::uploads";

fn doc(statements: serde_json::Value) -> String {
    json!({ "Version": "2012-10-17", "Statement": statements }).to_string()
}

fn sns_allow(source: &str) -> serde_json::Value {
    json!({ "Effect": "Allow", "Principal": { "Service": "sns.amazonaws.com" }, "Action": "sqs:SendMessage", "Resource": "*", "Condition": { "ArnEquals": { "aws:SourceArn": source } } })
}

fn https_only() -> serde_json::Value {
    json!({ "Sid": "DenyHttp", "Effect": "Deny", "Principal": "*", "Action": "sqs:*", "Resource": "*", "Condition": { "Bool": { "aws:SecureTransport": "false" } } })
}

fn sends(policy: &str, source: &str, service: &str) -> Option<bool> {
    allows_send(Some(policy), source, service, ACCOUNT)
}

#[test]
fn parse_explains_each_statement() {
    let policy = doc(json!([sns_allow(TOPIC), https_only(), { "Effect": "Allow", "Principal": { "AWS": ["arn:aws:iam::222222222222:root", "arn:aws:iam::333333333333:role/x"] }, "Action": ["sqs:SendMessage", "sqs:GetQueueUrl"] }]));
    let grants = parse(&policy);
    assert_eq!(grants.len(), 3);

    assert_eq!(grants[0].effect, Effect::Allow);
    assert_eq!(grants[0].principals, vec!["sns.amazonaws.com"]);
    assert_eq!(grants[0].actions, vec!["sqs:SendMessage"]);
    assert_eq!(grants[0].conditions, vec![format!("aws:SourceArn ArnEquals {TOPIC}")]);
    assert_eq!(grants[0].sources, vec![TOPIC]);
    assert!(!grants[0].public);

    assert_eq!(grants[1].sid.as_deref(), Some("DenyHttp"));
    assert_eq!(grants[1].effect, Effect::Deny);
    assert_eq!(grants[1].principals, vec!["*"]);
    assert!(grants[1].sources.is_empty(), "SecureTransport is not a source");

    assert_eq!(grants[2].principals.len(), 2);
    assert_eq!(grants[2].actions, vec!["sqs:SendMessage", "sqs:GetQueueUrl"]);
}

#[test]
fn parse_tolerates_single_statement_objects_and_garbage() {
    let single = json!({ "Statement": sns_allow(TOPIC) }).to_string();
    assert_eq!(parse(&single).len(), 1);
    assert_eq!(parse("not json"), vec![]);
    assert_eq!(parse("{}"), vec![]);
}

#[test]
fn public_means_unconditional_wildcard_allow() {
    let public = |statement: serde_json::Value| parse(&doc(json!([statement]))).iter().any(|g| g.public);
    assert!(public(json!({ "Effect": "Allow", "Principal": "*", "Action": "sqs:*" })));
    assert!(public(json!({ "Effect": "Allow", "Principal": { "AWS": "*" }, "Action": "sqs:*" })));
    assert!(public(json!({ "Effect": "Allow", "Principal": { "AWS": ["*"] }, "Action": "sqs:*" })));
    assert!(!public(json!({ "Effect": "Allow", "Principal": "*", "Action": "sqs:*", "Condition": { "StringEquals": { "aws:SourceAccount": ACCOUNT } } })));
    assert!(!public(json!({ "Effect": "Deny", "Principal": "*", "Action": "sqs:*" })));
    assert!(!public(json!({ "Effect": "Allow", "Principal": { "Service": "sns.amazonaws.com" }, "Action": "sqs:*" })));
    assert!(is_public(&doc(json!([{ "Effect": "Allow", "Principal": "*", "Action": "sqs:*" }]))));
}

#[test]
fn a_missing_policy_denies_even_same_account_services() {
    assert_eq!(allows_send(None, TOPIC, "sns.amazonaws.com", ACCOUNT), Some(false));
    assert_eq!(allows_send(Some("  "), TOPIC, "sns.amazonaws.com", ACCOUNT), Some(false));
    assert_eq!(allows_send(Some("not json"), TOPIC, "sns.amazonaws.com", ACCOUNT), None);
}

#[test]
fn allow_needs_the_service_the_action_and_a_matching_source() {
    let policy = doc(json!([sns_allow(TOPIC)]));
    assert_eq!(sends(&policy, TOPIC, "sns.amazonaws.com"), Some(true));
    assert_eq!(sends(&policy, "arn:aws:sns:ap-northeast-2:111111111111:other", "sns.amazonaws.com"), Some(false));
    assert_eq!(sends(&policy, RULE, "events.amazonaws.com"), Some(false), "another service");
    let wrong_action = doc(json!([{ "Effect": "Allow", "Principal": { "Service": "sns.amazonaws.com" }, "Action": "sqs:ReceiveMessage" }]));
    assert_eq!(sends(&wrong_action, TOPIC, "sns.amazonaws.com"), Some(false));
}

#[test]
fn action_wildcards_cover_send_message_case_insensitively() {
    for action in ["sqs:*", "*", "sqs:Send*", "SQS:SENDMESSAGE", "sqs:S?ndMessage"] {
        let policy = doc(json!([{ "Effect": "Allow", "Principal": { "Service": "sns.amazonaws.com" }, "Action": action }]));
        assert_eq!(sends(&policy, TOPIC, "sns.amazonaws.com"), Some(true), "{action}");
    }
    let list = doc(json!([{ "Effect": "Allow", "Principal": { "Service": ["events.amazonaws.com", "sns.amazonaws.com"] }, "Action": ["sqs:GetQueueUrl", "sqs:SendMessage"] }]));
    assert_eq!(sends(&list, TOPIC, "sns.amazonaws.com"), Some(true));
    assert_eq!(sends(&list, RULE, "events.amazonaws.com"), Some(true));
}

#[test]
fn wildcard_principals_cover_services_but_account_principals_do_not() {
    let any = doc(json!([{ "Effect": "Allow", "Principal": "*", "Action": "sqs:SendMessage" }]));
    assert_eq!(sends(&any, TOPIC, "sns.amazonaws.com"), Some(true));
    let account = doc(json!([{ "Effect": "Allow", "Principal": { "AWS": format!("arn:aws:iam::{ACCOUNT}:root") }, "Action": "sqs:SendMessage" }]));
    assert_eq!(sends(&account, TOPIC, "sns.amazonaws.com"), Some(false), "a service call is not an account principal");
}

#[test]
fn source_arn_operators_match_exactly_or_by_pattern() {
    let with = |operator: &str, value: &str| doc(json!([{ "Effect": "Allow", "Principal": { "Service": "events.amazonaws.com" }, "Action": "sqs:SendMessage", "Condition": { operator: { "aws:SourceArn": value } } }]));
    let pattern = "arn:aws:events:ap-northeast-2:111111111111:rule/karpenter-*";
    assert_eq!(sends(&with("ArnLike", pattern), RULE, "events.amazonaws.com"), Some(true));
    assert_eq!(sends(&with("ArnEquals", pattern), RULE, "events.amazonaws.com"), Some(true), "ArnEquals behaves like ArnLike");
    assert_eq!(sends(&with("StringLike", pattern), RULE, "events.amazonaws.com"), Some(true));
    assert_eq!(sends(&with("StringEquals", pattern), RULE, "events.amazonaws.com"), Some(false), "StringEquals is literal");
    assert_eq!(sends(&with("StringEquals", RULE), RULE, "events.amazonaws.com"), Some(true));
    assert_eq!(sends(&with("ArnLike", "arn:aws:events:*:*:rule/other-*"), RULE, "events.amazonaws.com"), Some(false));
    // 값이 여러 개면 하나만 맞아도 된다
    let many = doc(json!([{ "Effect": "Allow", "Principal": { "Service": "sns.amazonaws.com" }, "Action": "sqs:SendMessage", "Condition": { "ArnEquals": { "aws:SourceArn": ["arn:aws:sns:ap-northeast-2:676499404107:foreign", TOPIC] } } }]));
    assert_eq!(sends(&many, TOPIC, "sns.amazonaws.com"), Some(true));
    assert_eq!(sends(&many, "arn:aws:sns:ap-northeast-2:676499404107:foreign", "sns.amazonaws.com"), Some(true));
}

#[test]
fn source_account_comes_from_the_arn_or_the_queue_for_buckets() {
    let by_account = |account: &str| doc(json!([{ "Effect": "Allow", "Principal": { "Service": "s3.amazonaws.com" }, "Action": "sqs:SendMessage", "Condition": { "StringEquals": { "aws:SourceAccount": account }, "ArnLike": { "aws:SourceArn": BUCKET } } }]));
    assert_eq!(sends(&by_account(ACCOUNT), BUCKET, "s3.amazonaws.com"), Some(true), "a bucket ARN has no account: the queue's account");
    assert_eq!(sends(&by_account("999999999999"), BUCKET, "s3.amazonaws.com"), Some(false));
    let topic_account = doc(json!([{ "Effect": "Allow", "Principal": { "Service": "sns.amazonaws.com" }, "Action": "sqs:SendMessage", "Condition": { "StringEquals": { "aws:SourceAccount": "676499404107" } } }]));
    assert_eq!(sends(&topic_account, "arn:aws:sns:ap-northeast-2:676499404107:foreign", "sns.amazonaws.com"), Some(true));
    assert_eq!(sends(&topic_account, TOPIC, "sns.amazonaws.com"), Some(false));
}

#[test]
fn deny_wins_over_allow_in_any_order() {
    let deny = json!({ "Effect": "Deny", "Principal": { "Service": "sns.amazonaws.com" }, "Action": "sqs:SendMessage", "Condition": { "ArnEquals": { "aws:SourceArn": TOPIC } } });
    assert_eq!(sends(&doc(json!([sns_allow(TOPIC), deny])), TOPIC, "sns.amazonaws.com"), Some(false));
    assert_eq!(sends(&doc(json!([deny, sns_allow(TOPIC)])), TOPIC, "sns.amazonaws.com"), Some(false));
    // 다른 출처의 거부는 이 출처에 영향이 없다
    let other = json!({ "Effect": "Deny", "Principal": { "Service": "sns.amazonaws.com" }, "Action": "sqs:SendMessage", "Condition": { "ArnEquals": { "aws:SourceArn": "arn:aws:sns:ap-northeast-2:111111111111:other" } } });
    assert_eq!(sends(&doc(json!([sns_allow(TOPIC), other])), TOPIC, "sns.amazonaws.com"), Some(true));
}

#[test]
fn the_https_only_deny_is_ignored() {
    let policy = doc(json!([sns_allow(TOPIC), https_only()]));
    assert_eq!(sends(&policy, TOPIC, "sns.amazonaws.com"), Some(true));
    // 이 거부만 있으면 허용하는 문장이 없어서 거부다
    assert_eq!(sends(&doc(json!([https_only()])), TOPIC, "sns.amazonaws.com"), Some(false));
}

#[test]
fn unknown_condition_operators_make_the_answer_unknown() {
    let org = doc(json!([{ "Effect": "Allow", "Principal": { "Service": "sns.amazonaws.com" }, "Action": "sqs:SendMessage", "Condition": { "StringEquals": { "aws:PrincipalOrgID": "o-abc" } } }]));
    assert_eq!(sends(&org, TOPIC, "sns.amazonaws.com"), None);
    let odd_operator = doc(json!([{ "Effect": "Allow", "Principal": { "Service": "sns.amazonaws.com" }, "Action": "sqs:SendMessage", "Condition": { "IpAddress": { "aws:SourceIp": "10.0.0.0/8" } } }]));
    assert_eq!(sends(&odd_operator, TOPIC, "sns.amazonaws.com"), None);
    let variable = doc(json!([{ "Effect": "Allow", "Principal": { "Service": "sns.amazonaws.com" }, "Action": "sqs:SendMessage", "Condition": { "ArnEquals": { "aws:SourceArn": "arn:aws:sns:*:${aws:PrincipalAccount}:t" } } }]));
    assert_eq!(sends(&variable, TOPIC, "sns.amazonaws.com"), None);
}

#[test]
fn a_known_allow_beats_an_unknown_one_but_an_unknown_deny_blocks_certainty() {
    let unknown_allow = json!({ "Effect": "Allow", "Principal": "*", "Action": "sqs:SendMessage", "Condition": { "IpAddress": { "aws:SourceIp": "10.0.0.0/8" } } });
    assert_eq!(sends(&doc(json!([sns_allow(TOPIC), unknown_allow.clone()])), TOPIC, "sns.amazonaws.com"), Some(true));
    assert_eq!(sends(&doc(json!([unknown_allow])), TOPIC, "sns.amazonaws.com"), None);
    let unknown_deny = json!({ "Effect": "Deny", "Principal": "*", "Action": "sqs:SendMessage", "Condition": { "IpAddress": { "aws:SourceIp": "10.0.0.0/8" } } });
    assert_eq!(sends(&doc(json!([sns_allow(TOPIC), unknown_deny])), TOPIC, "sns.amazonaws.com"), None);
    // 확실한 거부는 모르는 허용보다 앞선다
    let sure_deny = json!({ "Effect": "Deny", "Principal": "*", "Action": "sqs:SendMessage" });
    assert_eq!(sends(&doc(json!([unknown_allow, sure_deny])), TOPIC, "sns.amazonaws.com"), Some(false));
}

#[test]
fn conditions_must_all_hold() {
    let both = doc(json!([{ "Effect": "Allow", "Principal": { "Service": "sns.amazonaws.com" }, "Action": "sqs:SendMessage", "Condition": { "ArnEquals": { "aws:SourceArn": TOPIC }, "StringEquals": { "aws:SourceAccount": "999999999999" } } }]));
    assert_eq!(sends(&both, TOPIC, "sns.amazonaws.com"), Some(false));
}

#[test]
fn s3_buckets_and_allowed_arns_come_from_allow_statements_only() {
    let policy = doc(json!([
        sns_allow(TOPIC),
        { "Effect": "Allow", "Principal": { "Service": "s3.amazonaws.com" }, "Action": "sqs:SendMessage", "Condition": { "ArnLike": { "aws:SourceArn": ["arn:aws:s3:::uploads", "arn:aws:s3:::logs-*"] }, "StringEquals": { "aws:SourceAccount": ACCOUNT } } },
        { "Effect": "Deny", "Principal": "*", "Action": "sqs:*", "Condition": { "ArnLike": { "aws:SourceArn": "arn:aws:s3:::denied" } } },
    ]));
    assert_eq!(s3_buckets(&policy), vec!["uploads"]);
    assert_eq!(allowed_source_arns(&policy), vec![TOPIC.to_string(), BUCKET.to_string()]);
}

#[test]
fn key_policy_needs_both_data_key_and_decrypt_for_the_service() {
    let key = |actions: serde_json::Value| doc(json!([{ "Effect": "Allow", "Principal": { "Service": "sns.amazonaws.com" }, "Action": actions, "Resource": "*" }]));
    let root = json!({ "Effect": "Allow", "Principal": { "AWS": format!("arn:aws:iam::{ACCOUNT}:root") }, "Action": "kms:*", "Resource": "*" });
    assert_eq!(key_allows_service(&key(json!(["kms:GenerateDataKey*", "kms:Decrypt"])), "sns.amazonaws.com"), Some(true));
    assert_eq!(key_allows_service(&key(json!(["kms:*"])), "sns.amazonaws.com"), Some(true));
    assert_eq!(key_allows_service(&key(json!(["kms:Decrypt"])), "sns.amazonaws.com"), Some(false), "no data key");
    assert_eq!(key_allows_service(&key(json!(["kms:GenerateDataKey*", "kms:Decrypt"])), "events.amazonaws.com"), Some(false), "other service");
    assert_eq!(key_allows_service(&doc(json!([root])), "sns.amazonaws.com"), Some(false), "the account root is not the service");
    assert_eq!(key_allows_service("garbage", "sns.amazonaws.com"), None);
}

#[test]
fn key_policy_with_conditions_is_unknown_and_a_deny_is_final() {
    let conditional = doc(json!([{ "Effect": "Allow", "Principal": { "Service": "sns.amazonaws.com" }, "Action": ["kms:GenerateDataKey*", "kms:Decrypt"], "Resource": "*", "Condition": { "StringEquals": { "kms:EncryptionContext:aws:sns:topicArn": TOPIC } } }]));
    assert_eq!(key_allows_service(&conditional, "sns.amazonaws.com"), None);
    let denied = doc(json!([
        { "Effect": "Allow", "Principal": { "Service": "sns.amazonaws.com" }, "Action": ["kms:GenerateDataKey*", "kms:Decrypt"], "Resource": "*" },
        { "Effect": "Deny", "Principal": { "Service": "sns.amazonaws.com" }, "Action": "kms:Decrypt", "Resource": "*" },
    ]));
    assert_eq!(key_allows_service(&denied, "sns.amazonaws.com"), Some(false));
}

#[test]
fn wildcard_matching_handles_star_and_question_mark() {
    assert!(wildcard("a*c", "abbbc"));
    assert!(wildcard("*", ""));
    assert!(wildcard("a?c", "abc"));
    assert!(!wildcard("a?c", "ac"));
    assert!(wildcard("*b*", "abc"));
    assert!(!wildcard("a*b", "acd"));
    assert!(wildcard("a**", "a"));
}
