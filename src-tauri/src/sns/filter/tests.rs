use super::*;
use serde_json::json;

fn body(policy: &str, message: &str) -> FilterVerdict {
    evaluate(
        &parse_policy(policy).unwrap(),
        Scope::MessageBody,
        &Sample {
            attributes: vec![],
            body: Some(message.into()),
        },
    )
}
fn attr(policy: &str, kind: &str, value: &str) -> bool {
    evaluate(
        &parse_policy(policy).unwrap(),
        Scope::MessageAttributes,
        &Sample {
            attributes: vec![SampleAttr {
                name: "x".into(),
                data_type: kind.into(),
                value: value.into(),
            }],
            body: None,
        },
    )
    .matched
}
#[test]
fn documented_operators() {
    let cases = [
        (r#"{"x":["rugby","tennis"]}"#, r#"{"x":"rugby"}"#, true),
        (r#"{"x":["rugby","tennis"]}"#, r#"{"x":"baseball"}"#, false),
        (
            r#"{"x":[{"anything-but":["rugby","tennis"]}]}"#,
            r#"{"x":["rugby","baseball"]}"#,
            true,
        ),
        (
            r#"{"x":[{"anything-but":["rugby","tennis"]}]}"#,
            r#"{"x":["rugby"]}"#,
            false,
        ),
        (
            r#"{"x":[{"anything-but":{"prefix":"order-"}}]}"#,
            r#"{"x":"data-entry"}"#,
            true,
        ),
        (
            r#"{"x":[{"anything-but":{"prefix":"order-"}}]}"#,
            r#"{"x":"order-cancelled"}"#,
            false,
        ),
        (
            r#"{"x":[{"anything-but":{"suffix":"ball"}}]}"#,
            r#"{"x":"hockey"}"#,
            true,
        ),
        (
            r#"{"x":[{"anything-but":{"suffix":"ball"}}]}"#,
            r#"{"x":"baseball"}"#,
            false,
        ),
        (
            r#"{"x":[{"anything-but":{"wildcard":"*ball"}}]}"#,
            r#"{"x":"rugby"}"#,
            true,
        ),
        (
            r#"{"x":[{"anything-but":{"wildcard":"*ball"}}]}"#,
            r#"{"x":"basketball"}"#,
            false,
        ),
        (
            r#"{"x":[{"equals-ignore-case":"tennis"}]}"#,
            r#"{"x":"TENNIS"}"#,
            true,
        ),
        (
            r#"{"x":[{"equals-ignore-case":"tennis"}]}"#,
            r#"{"x":"rugby"}"#,
            false,
        ),
        (r#"{"x":[{"prefix":"bas"}]}"#, r#"{"x":"baseball"}"#, true),
        (r#"{"x":[{"prefix":"bas"}]}"#, r#"{"x":"rugby"}"#, false),
        (
            r#"{"x":[{"suffix":"ball"}]}"#,
            r#"{"x":"basketball"}"#,
            true,
        ),
        (r#"{"x":[{"suffix":"ball"}]}"#, r#"{"x":"rugby"}"#, false),
        (
            r#"{"x":[{"wildcard":"*ball"}]}"#,
            r#"{"x":"baseball"}"#,
            true,
        ),
        (r#"{"x":[{"wildcard":"*ball"}]}"#, r#"{"x":"rugby"}"#, false),
        (
            r#"{"x":[{"cidr":"10.0.0.0/24"}]}"#,
            r#"{"x":"10.0.0.255"}"#,
            true,
        ),
        (
            r#"{"x":[{"cidr":"10.0.0.0/24"}]}"#,
            r#"{"x":"10.1.1.0"}"#,
            false,
        ),
        (
            r#"{"x":[{"numeric":["=",301.5]}]}"#,
            r#"{"x":3.015e2}"#,
            true,
        ),
        (r#"{"x":[{"numeric":["=",301.5]}]}"#, r#"{"x":301}"#, false),
        (
            r#"{"x":[{"numeric":[">",0,"<=",150]}]}"#,
            r#"{"x":150}"#,
            true,
        ),
        (
            r#"{"x":[{"numeric":[">",0,"<=",150]}]}"#,
            r#"{"x":0}"#,
            false,
        ),
        (
            r#"{"x":[{"anything-but":[100,500]}]}"#,
            r#"{"x":100.1}"#,
            true,
        ),
        (
            r#"{"x":[{"anything-but":[100,500]}]}"#,
            r#"{"x":100}"#,
            false,
        ),
        (r#"{"x":[{"exists":true}]}"#, r#"{"x":"fans"}"#, true),
        (r#"{"x":[{"exists":true}]}"#, r#"{"other":"fans"}"#, false),
        (r#"{"x":[{"exists":false}]}"#, r#"{"other":"fans"}"#, true),
        (r#"{"x":[{"exists":false}]}"#, r#"{"x":"fans"}"#, false),
        (
            r#"{"source":["aws.cloudwatch"],"$or":[{"metricName":["CPUUtilization"]},{"namespace":["AWS/EC2"]}]}"#,
            r#"{"source":"aws.cloudwatch","namespace":"AWS/EC2"}"#,
            true,
        ),
        (
            r#"{"source":["aws.cloudwatch"],"$or":[{"metricName":["CPUUtilization"]},{"namespace":["AWS/EC2"]}]}"#,
            r#"{"source":"other","namespace":"AWS/EC2"}"#,
            false,
        ),
        (
            r#"{"detail":{"event":["created"]}}"#,
            r#"{"detail":[{"event":"paid"},{"event":"created"}]}"#,
            true,
        ),
        (
            r#"{"detail":{"event":["created"]}}"#,
            r#"{"detail":{"event":"paid"}}"#,
            false,
        ),
    ];
    for (policy, message, expected) in cases {
        assert_eq!(
            body(policy, message).matched,
            expected,
            "{policy} {message}"
        );
    }
}
#[test]
fn scope_types_and_invalid_body() {
    assert!(attr(
        r#"{"x":["tennis"]}"#,
        "String.Array",
        r#"["rugby","tennis"]"#
    ));
    assert!(!attr(r#"{"x":["tennis"]}"#, "String.Array", r#"["rugby"]"#));
    assert!(!attr(r#"{"x":["10"]}"#, "Number", "10"));
    assert!(!attr(r#"{"x":[10]}"#, "String", "10"));
    assert!(!attr(r#"{"x":["a"]}"#, "Binary", "a"));
    assert!(attr(
        r#"{"x":[{"numeric":["=",301.5]}]}"#,
        "Number",
        "3.015e2"
    ));
    assert!(!body(r#"{"x":[1]}"#, "bad json").matched);
    assert!(!body(r#"{"x":[1]}"#, "[]").matched);
    assert!(!body(r#"{"x":[{"exists":false}]}"#, "{}").matched);
}
#[test]
fn constraints_and_summaries() {
    let p = parse_policy(r#"{"a":{"b":{"c":[1,2,3,4]}},"d":{"e":[1,2,3]}}"#).unwrap();
    assert!(validate(&p, Scope::MessageBody).is_empty());
    assert!(!validate(&p, Scope::MessageAttributes).is_empty());
    let p = parse_policy(&json!({"a": vec![1; 151]}).to_string()).unwrap();
    assert!(!validate(&p, Scope::MessageAttributes).is_empty());
    let p = parse_policy(r#"{"a":[1],"b":[1],"c":[1],"d":[1],"e":[1],"f":[1]}"#).unwrap();
    assert!(!validate(&p, Scope::MessageBody).is_empty());
    let p = parse_policy(r#"{"x":[{"wildcard":"****"}]}"#).unwrap();
    assert!(!validate(&p, Scope::MessageBody).is_empty());
    let p = parse_policy(r#"{"x":[{"numeric":[">",1000000001]}]}"#).unwrap();
    assert!(!validate(&p, Scope::MessageBody).is_empty());
    let p =
        parse_policy(r#"{"event":["created","paid"],"price":[{"numeric":[">=",100]}]}"#).unwrap();
    assert_eq!(
        summarize(&p, Scope::MessageBody),
        "event ∈ {created, paid} · price ≥ 100 · 본문 범위"
    );
    assert!(parse_policy(r#"{"x":[{"numeric":["bad",3]}]}"#).is_err());
}
