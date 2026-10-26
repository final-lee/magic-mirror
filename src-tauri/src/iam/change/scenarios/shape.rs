//! 화면으로 나가는 JSON 모양(계약의 `ChangePreview`).

use super::*;
use crate::iam::catalog::AccessLevel;

fn to_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}

fn keys(value: &Value) -> Vec<&str> {
    let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    keys
}

#[test]
fn a_preview_has_the_contract_fields() {
    let s = snapshot();
    let value = to_json(&preview(&s, &attach(BOB, S3_FULL), None));
    assert_eq!(keys(&value), vec!["calls", "change", "confirmText", "impacts", "reversible", "summary", "warnings"]);
    assert_eq!(value["change"], json!({ "op": "attachPolicy", "target": BOB, "policyArn": S3_FULL }));
    assert_eq!(value["summary"], json!("bob에 AmazonS3FullAccess 붙이기"));
    assert_eq!(value["calls"], json!([{ "api": "iam:AttachUserPolicy", "params": { "PolicyArn": S3_FULL, "UserName": "bob" } }]));
    assert_eq!(value["warnings"], json!([]));
    assert_eq!(value["confirmText"], Value::Null);
    assert_eq!(value["reversible"], json!(true));
}

#[test]
fn impacts_carry_the_principal_and_lowercase_levels() {
    let s = snapshot();
    let value = to_json(&preview(&s, &attach(BOB, S3_FULL), None));
    let impact = &value["impacts"][0];
    assert_eq!(keys(impact), vec!["gained", "lost", "principal"]);
    assert_eq!(impact["principal"]["name"], json!("bob"));
    assert_eq!(impact["principal"]["kind"], json!("user"));
    let write = impact["gained"].as_array().unwrap().iter().find(|d| d["level"] == json!("write")).unwrap();
    assert_eq!(keys(write), vec!["count", "level", "prefix", "sample"]);
    assert_eq!(write["prefix"], json!("s3"));
    assert!(write["sample"].as_array().unwrap().len() <= 5);
    assert_eq!(impact["lost"], json!([]));
}

#[test]
fn warning_levels_use_the_contract_names() {
    let s = snapshot();
    let value = to_json(&preview(&s, &delete_key("bob", "AKIA1"), Some("Active")));
    assert_eq!(value["warnings"][0]["level"], json!("confirm"));
    assert!(value["warnings"][0]["message"].is_string());
    assert_eq!(value["confirmText"], json!("AKIA1"));
    assert_eq!(value["reversible"], json!(false));
    assert_eq!(to_json(&WarnLevel::Block), json!("block"));
    assert_eq!(to_json(&WarnLevel::Warn), json!("warn"));

    let value = to_json(&preview(&s, &attach(SLR, S3_FULL), None));
    assert_eq!(value["warnings"][0]["level"], json!("block"));
}

#[test]
fn a_perm_delta_serializes_the_access_level_in_lowercase() {
    let delta = PermDelta { prefix: "iam".into(), level: AccessLevel::Permissions, count: 2, sample: vec!["iam:PutRolePolicy".into()] };
    assert_eq!(to_json(&delta), json!({ "prefix": "iam", "level": "permissions", "count": 2, "sample": ["iam:PutRolePolicy"] }));
}

#[test]
fn every_change_kind_previews_without_panicking_even_for_nonsense_targets() {
    let s = snapshot();
    let nobody = account_arn("user/nobody");
    let changes = [
        attach(&nobody, "not-an-arn"),
        detach("", ""),
        add_to_group("", ""),
        remove_from_group("x", "y"),
        set_status("", "", ""),
        delete_key("", ""),
        put_inline("", "", String::new()),
        drop_inline("", ""),
        update_managed("", String::new()),
    ];
    for change in changes {
        let p = preview(&s, &change, None);
        assert!(has_level(&p, WarnLevel::Block), "{change:?}: {:?}", p.warnings);
        assert_eq!(p.change, change);
        assert!(!p.summary.is_empty());
        assert!(!p.reversible);
    }
}
