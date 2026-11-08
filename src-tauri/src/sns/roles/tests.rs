use super::*;

#[test]
fn only_roles_that_sns_can_assume_are_listed() {
    let sns = r#"{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"sns.amazonaws.com"},"Action":"sts:AssumeRole"}]}"#;
    assert!(trusts_sns(sns));
    assert!(trusts_sns("%7B%22Statement%22%3A%7B%22Effect%22%3A%22Allow%22%2C%22Principal%22%3A%7B%22Service%22%3A%5B%22lambda.amazonaws.com%22%2C%22sns.amazonaws.com%22%5D%7D%2C%22Action%22%3A%22sts%3AAssumeRole%22%7D%7D"));
    assert!(!trusts_sns(
        r#"{"Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}"#
    ));
    assert!(!trusts_sns(
        r#"{"Statement":[{"Effect":"Deny","Principal":{"Service":"sns.amazonaws.com"},"Action":"sts:AssumeRole"}]}"#
    ));
    assert!(!trusts_sns("not json"));
}

#[test]
fn roles_must_be_iam_roles_of_this_account() {
    assert_eq!(
        role_problem(
            "arn:aws:iam::123456789012:role/sns-feedback",
            "123456789012"
        ),
        None
    );
    assert_eq!(
        role_problem(
            "arn:aws:iam::123456789012:role/service-role/sns-feedback",
            "123456789012"
        ),
        None
    );
    assert!(role_problem("arn:aws:iam::999999999999:role/x", "123456789012").is_some());
    assert!(role_problem("arn:aws:iam::123456789012:user/x", "123456789012").is_some());
    assert!(role_problem("arn:aws:sqs:ap-northeast-2:123456789012:q", "123456789012").is_some());
    assert_eq!(
        role_name("arn:aws:iam::123456789012:role/service-role/sns-feedback"),
        "sns-feedback"
    );
}
