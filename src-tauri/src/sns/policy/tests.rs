use super::*;
use serde_json::json;

const TOPIC: &str = "arn:aws:sns:ap-northeast-2:431847470565:orders";
const QUEUE: &str = "arn:aws:sqs:ap-northeast-2:431847470565:queue";
const OWN: &str = "431847470565";

fn evaluate(statement: Value, who: Who, action: &str, resource: &str, ctx: Ctx) -> Verdict {
    allows(&json!({"Statement": statement}).to_string(), &who, action, resource, &ctx)
}
fn service() -> Who { Who::Service("sns.amazonaws.com".into()) }
fn ctx() -> Ctx { Ctx { source_arn: Some(TOPIC.into()), source_account: Some(OWN.into()), source_owner: Some(OWN.into()) } }

#[test]
fn delivery_policies_match_queue_lambda_and_kms() {
    for (action, resource, condition) in [
        ("sqs:SendMessage", QUEUE, json!({"ArnEquals":{"aws:SourceArn": TOPIC}})),
        ("sqs:SendMessage", QUEUE, json!({"ArnLike":{"aws:SourceArn":"arn:aws:sns:*:431847470565:*"}})),
        ("lambda:InvokeFunction", "arn:aws:lambda:ap-northeast-2:431847470565:function:f", json!({"ArnLike":{"AWS:SourceArn": TOPIC}})),
        ("kms:GenerateDataKeyWithoutPlaintext", "arn:aws:kms:ap-northeast-2:431847470565:key/k", json!({})),
        ("kms:Decrypt", "arn:aws:kms:ap-northeast-2:431847470565:key/k", json!({})),
    ] {
        let principal = if condition.get("ArnLike").and_then(|v| v.get("aws:SourceArn")).is_some() { json!("*") } else { json!({"Service":"sns.amazonaws.com"}) };
        let actions = if action.starts_with("kms:") { json!(["kms:GenerateDataKey*", "kms:Decrypt"]) } else { json!(action) };
        let stmt = json!({"Effect":"Allow", "Principal":principal, "Action":actions, "Resource":resource, "Condition":condition});
        assert_eq!(evaluate(stmt.clone(), service(), action, resource, ctx()), Verdict::Allow { statement: 0 });
        if action.starts_with("sqs:") || action.starts_with("lambda:") {
            let other = Ctx { source_arn: Some("arn:aws:sns:ap-northeast-2:999999999999:other".into()), ..ctx() };
            assert_eq!(evaluate(stmt, service(), action, resource, other), Verdict::NoMatch);
        }
    }
}

#[test]
fn owner_and_account_principals() {
    let default = json!({"Effect":"Allow", "Principal":{"AWS":"*"}, "Action":["sns:Publish", "sns:Subscribe"], "Resource":TOPIC, "Condition":{"StringEquals":{"AWS:SourceOwner":OWN}}});
    assert_eq!(evaluate(default.clone(), Who::Account(OWN.into()), "SNS:PUBLISH", TOPIC, ctx()), Verdict::Allow { statement: 0 });
    let view = describe(&json!({"Statement":default}).to_string(), OWN).unwrap();
    assert_eq!(view[0].scope, Reach::SameAccount);
    assert!(view[0].sentence.contains("이 계정(431847470565) 안의 주체"));
    for principal in [OWN.to_string(), format!("arn:aws:iam::{OWN}:root")] {
        let stmt = json!({"Effect":"Allow", "Principal":{"AWS":principal}, "Action":"sns:*", "Resource":"*"});
        assert_eq!(evaluate(stmt, Who::Arn(format!("arn:aws:iam::{OWN}:role/test")), "sns:Publish", TOPIC, ctx()), Verdict::Allow { statement: 0 });
    }
}

#[test]
fn conditions_and_unknown_denies() {
    for (op, actual, expected) in [
        ("StringEquals", Some("x"), true), ("StringNotEquals", Some("y"), true),
        ("ArnLike", Some("xyz"), true), ("ArnNotLike", Some("abc"), true),
        ("StringEquals", None, false), ("StringEqualsIfExists", None, true),
        ("StringNotEquals", None, true),
    ] {
        let value = if op.contains("Like") { "x*" } else { "x" };
        let stmt = json!({"Effect":"Allow", "Principal":"*", "Action":"*", "Resource":"*", "Condition":{op:{"AWS:SourceAccount":value}}});
        let context = Ctx { source_account: actual.map(str::to_owned), ..Ctx::default() };
        assert_eq!(matches!(evaluate(stmt, service(), "x", "r", context), Verdict::Allow { .. }), expected, "{op}");
    }
    let allow = json!({"Effect":"Allow", "Principal":"*", "Action":"*", "Resource":"*"});
    for condition in [json!({"Bool":{"aws:SecureTransport":"true"}}), json!({"StringEquals":{"aws:Other":"x"}}), json!({"StringEquals":{"aws:SourceAccount":"${aws:userid}"}}), json!({"ForAnyValue:StringEquals":{"aws:SourceAccount":"x"}})] {
        let deny = json!({"Effect":"Deny", "Principal":"*", "Action":"*", "Resource":"*", "Condition":condition});
        assert!(matches!(evaluate(json!([allow.clone(), deny]), service(), "x", "r", ctx()), Verdict::Unknown { .. }));
    }
    let deny = json!({"Effect":"Deny", "NotPrincipal":{"AWS":OWN}, "Action":"*", "Resource":"*"});
    assert!(matches!(evaluate(json!([allow.clone(), deny]), service(), "x", "r", ctx()), Verdict::Unknown { .. }));
    let deny = json!({"Effect":"Deny", "Principal":"*", "Action":"*", "Resource":"*"});
    assert_eq!(evaluate(json!([allow, deny]), service(), "x", "r", ctx()), Verdict::Deny { statement: 1 });
}

#[test]
fn not_action_resource_and_principal_arns() {
    let stmt = json!({"Effect":"Allow", "Principal":{"AWS":format!("arn:aws:iam::{OWN}:role/a")}, "NotAction":"sns:Delete*", "NotResource":"arn:aws:sns:*:431847470565:blocked"});
    let who = Who::Arn(format!("arn:aws:iam::{OWN}:role/a"));
    assert_eq!(evaluate(stmt.clone(), who.clone(), "sns:Publish", TOPIC, ctx()), Verdict::Allow { statement: 0 });
    assert_eq!(evaluate(stmt.clone(), who.clone(), "sns:DeleteTopic", TOPIC, ctx()), Verdict::NoMatch);
    assert_eq!(evaluate(stmt.clone(), who, "sns:Publish", "arn:aws:sns:us-east-1:431847470565:blocked", ctx()), Verdict::NoMatch);
    assert_eq!(evaluate(stmt, Who::Arn(format!("arn:aws:iam::{OWN}:role/b")), "sns:Publish", TOPIC, ctx()), Verdict::NoMatch);
}

#[test]
fn descriptions_and_sid_edits() {
    let public = json!({"Sid":"public", "Effect":"Allow", "Principal":"*", "Action":"sns:Subscribe", "Resource":TOPIC});
    let cross = json!({"Sid":"cross", "Effect":"Allow", "Principal":{"AWS":"676499404107"}, "Action":"sns:Subscribe", "Resource":TOPIC});
    let raw = json!({"Version":"2008-10-17", "Id":"keep", "Statement":[public.clone(), cross.clone()]}).to_string();
    let views = describe(&raw, OWN).unwrap();
    assert_eq!(views[0].scope, Reach::Public);
    assert!(views[0].sentence.contains("모든 주체(*)가 sns:Subscribe 가능, 조건 없음"));
    assert_eq!(views[1].scope, Reach::CrossAccount);
    assert!(views[1].sentence.contains("계정 676499404107가 sns:Subscribe"));
    let replacement = json!({"Sid":"cross", "Effect":"Deny", "Principal":"*", "Action":"sns:Publish", "Resource":TOPIC});
    let edited = add_statement(Some(&raw), TOPIC, replacement.clone()).unwrap();
    let value: Value = serde_json::from_str(&edited).unwrap();
    assert_eq!(value["Id"], "keep");
    assert_eq!(value["Statement"], json!([public, replacement]));
    let edited = remove_statement(&edited, "cross").unwrap().unwrap();
    assert_eq!(remove_statement(&edited, "public").unwrap(), None);
    let created = add_statement(None, TOPIC, cross).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&created).unwrap()["Version"], "2012-10-17");
}
