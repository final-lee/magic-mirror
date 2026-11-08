use super::*;
use crate::sns::filter::SampleAttr;

#[test]
fn evaluates_each_subscription_and_reports_invalid_policies() {
    let input = |key: &str, policy: Option<&str>| FilterInput {
        key: key.into(),
        policy: policy.map(str::to_owned),
        scope: Scope::MessageAttributes,
    };
    let results = test(
        vec![
            input("none", None),
            input("yes", Some(r#"{"event":["created"]}"#)),
            input("bad", Some("{")),
        ],
        Sample {
            attributes: vec![SampleAttr {
                name: "event".into(),
                data_type: "String".into(),
                value: "created".into(),
            }],
            body: None,
        },
    );
    assert!(results[0].verdict.as_ref().unwrap().matched);
    assert!(results[1].verdict.as_ref().unwrap().matched);
    assert!(results[1].summary.is_some());
    assert!(results[2].verdict.is_none());
    assert!(!results[2].errors.is_empty());
}

#[test]
fn rejects_limit_violations_and_reports_first_mismatch() {
    let policies = vec![
        FilterInput {
            key: "mismatch".into(),
            policy: Some(r#"{"event":["created"]}"#.into()),
            scope: Scope::MessageAttributes,
        },
        FilterInput {
            key: "invalid".into(),
            policy: Some(r#"{"a":[1],"b":[1],"c":[1],"d":[1],"e":[1],"f":[1]}"#.into()),
            scope: Scope::MessageAttributes,
        },
    ];
    let results = test(
        policies,
        Sample {
            attributes: vec![SampleAttr {
                name: "event".into(),
                data_type: "String".into(),
                value: "paid".into(),
            }],
            body: None,
        },
    );
    let verdict = results[0].verdict.as_ref().unwrap();
    assert!(!verdict.matched);
    assert_eq!(verdict.key.as_deref(), Some("event"));
    assert!(results[1].verdict.is_none());
    assert!(!results[1].errors.is_empty());
}
