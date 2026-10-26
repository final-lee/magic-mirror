//! 신뢰 정책 해석: 누가 이 역할을 맡을 수 있는지.

use serde_json::Value;

use super::eval::all_star;
use super::policy::{statement_action_matches, Effect, PolicyDocument, Statement};
use super::view::{TrustEntry, TrustKind};

/// 역할을 맡거나 세션에 태그를 붙이는 작업(`sts:AssumeRole*`, `sts:TagSession`).
const ASSUME_ACTIONS: [&str; 4] = ["sts:AssumeRole", "sts:AssumeRoleWithSAML", "sts:AssumeRoleWithWebIdentity", "sts:TagSession"];

const WARN_ANYONE: &str = "누구나 이 역할을 맡을 수 있어요. 조건이 없어서 위험해요";
const WARN_ANYONE_CONDITIONAL: &str = "누구나 맡을 수 있게 열려 있고 조건만 걸려 있어요. 조건이 충분한지 확인해 주세요";
const WARN_NO_EXTERNAL_ID: &str = "다른 계정에 열려 있는데 ExternalId 조건이 없어요";

/// 신뢰 정책의 Principal 값을 (종류 키, 값) 목록으로 푼다. `"*"`는 `AWS`로 본다.
fn principal_values(principal: &Value) -> Vec<(String, String)> {
    match principal {
        Value::String(one) => vec![("AWS".to_string(), one.clone())],
        Value::Object(map) => {
            let mut out = Vec::new();
            for (key, value) in map {
                match value {
                    Value::String(one) => out.push((key.clone(), one.clone())),
                    Value::Array(items) => out.extend(items.iter().filter_map(Value::as_str).map(|v| (key.clone(), v.to_string()))),
                    _ => {}
                }
            }
            out
        }
        _ => Vec::new(),
    }
}

/// `arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com` → `token.actions.githubusercontent.com`.
/// ARN이 아니면 그대로 돌려준다(`cognito-identity.amazonaws.com` 같은 값).
fn provider_name(value: &str) -> String {
    let resource = if value.starts_with("arn:") { value.splitn(6, ':').nth(5) } else { None };
    match resource.and_then(|r| r.split_once('/')) {
        Some((kind, name)) if kind.ends_with("-provider") => name.to_string(),
        _ => value.to_string(),
    }
}

/// AWS 주체 값의 종류와 계정. 12자리 계정 ID나 `:root` ARN은 계정, 사용자·역할 ARN은 개별 주체다.
fn classify_aws(value: &str) -> (TrustKind, Option<String>, String) {
    if value.len() == 12 && value.bytes().all(|b| b.is_ascii_digit()) {
        return (TrustKind::Account, Some(value.to_string()), value.to_string());
    }
    if value.starts_with("arn:") {
        let mut parts = value.splitn(6, ':');
        let account = parts.nth(4).filter(|a| !a.is_empty()).map(str::to_string);
        if parts.next() == Some("root") {
            if let Some(account) = account {
                return (TrustKind::Account, Some(account.clone()), account);
            }
        }
        return (TrustKind::Principal, account, value.to_string());
    }
    (TrustKind::Principal, None, value.to_string())
}

fn has_external_id(stmt: &Statement) -> bool {
    stmt.conditions.iter().any(|line| line.to_ascii_lowercase().starts_with("sts:externalid"))
}

fn entry_for(key: &str, value: &str, stmt: &Statement, actions: &[String], own_account: &str) -> TrustEntry {
    let mut entry = TrustEntry {
        kind: TrustKind::Principal,
        value: value.to_string(),
        actions: actions.to_vec(),
        conditional: stmt.conditional,
        external: false,
        warning: None,
    };
    match key {
        "Service" => entry.kind = TrustKind::Service,
        "Federated" => {
            entry.kind = TrustKind::Federated;
            entry.value = provider_name(value);
        }
        "AWS" if all_star(value) => {
            entry.kind = TrustKind::Anyone;
            entry.value = "*".to_string();
            entry.external = true;
            entry.warning = Some(if stmt.conditional { WARN_ANYONE_CONDITIONAL } else { WARN_ANYONE }.to_string());
        }
        "AWS" => {
            let (kind, account, shown) = classify_aws(value);
            entry.kind = kind;
            entry.value = shown;
            entry.external = account.is_some_and(|a| a != own_account);
            if entry.external && !has_external_id(stmt) {
                entry.warning = Some(WARN_NO_EXTERNAL_ID.to_string());
            }
        }
        _ => {}
    }
    entry
}

/// 신뢰 정책에서 "누가 이 역할을 맡을 수 있나"를 뽑는다. Allow이면서 `sts:AssumeRole*`/`sts:TagSession`을 여는 문장의
/// Principal마다 한 줄이다. `*`나 `{"AWS":"*"}`는 누구나, 다른 계정은 외부(ExternalId 조건이 없으면 경고),
/// `Service`는 서비스, `Federated`는 연동(OIDC·SAML 공급자 이름)이다.
pub fn parse_trust(doc: &PolicyDocument, own_account: &str) -> Vec<TrustEntry> {
    let mut entries = Vec::new();
    for stmt in &doc.statements {
        if stmt.effect != Effect::Allow {
            continue;
        }
        let actions: Vec<String> = ASSUME_ACTIONS.iter().filter(|action| statement_action_matches(stmt, action)).map(|a| a.to_string()).collect();
        let Some(principal) = stmt.principal.as_ref().filter(|_| !actions.is_empty()) else {
            continue;
        };
        for (key, value) in principal_values(principal) {
            entries.push(entry_for(&key, &value, stmt, &actions, own_account));
        }
    }
    entries
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::iam::fixtures::*;

    fn trust_of(arn: &str) -> Vec<TrustEntry> {
        let s = snapshot();
        parse_trust(s.role(arn).unwrap().trust.as_ref().unwrap(), &s.account_id)
    }

    /// 문장 하나짜리 신뢰 정책을 풀어 본다.
    fn parse(principal: Value, action: &str, condition: Option<Value>) -> Vec<TrustEntry> {
        parse_trust(&doc(trust(principal, action, condition)), ACCOUNT)
    }

    #[test]
    fn github_actions_oidc_is_federated_and_conditional() {
        let entries = trust_of(CI);
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!((entry.kind, entry.value.as_str()), (TrustKind::Federated, "token.actions.githubusercontent.com"));
        assert_eq!(entry.actions, vec!["sts:AssumeRoleWithWebIdentity".to_string()]);
        assert!(entry.conditional && !entry.external);
        assert_eq!(entry.warning, None);
    }

    #[test]
    fn another_account_without_an_external_id_is_warned() {
        let entries = trust_of(VENDOR);
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!((entry.kind, entry.value.as_str()), (TrustKind::Account, "999999999999"));
        assert!(entry.external && !entry.conditional);
        assert!(entry.warning.as_deref().is_some_and(|w| w.contains("ExternalId")), "{entry:?}");

        let guarded = parse(
            json!({ "AWS": "arn:aws:iam::999999999999:root" }),
            "sts:AssumeRole",
            Some(json!({ "StringEquals": { "sts:ExternalId": "abc-123" } })),
        );
        assert!(guarded[0].external && guarded[0].conditional);
        assert_eq!(guarded[0].warning, None);
        // 다른 조건만 있으면 여전히 경고
        let other = parse(json!({ "AWS": "999999999999" }), "sts:AssumeRole", Some(json!({ "Bool": { "aws:MultiFactorAuthPresent": "true" } })));
        assert_eq!((other[0].kind, other[0].value.as_str()), (TrustKind::Account, "999999999999"));
        assert!(other[0].warning.is_some());
    }

    #[test]
    fn anyone_is_flagged_with_or_without_conditions() {
        for entries in [trust_of(OPEN), parse(json!("*"), "sts:AssumeRole", None), parse(json!({ "AWS": ["*"] }), "sts:AssumeRole", None)] {
            assert_eq!(entries.len(), 1);
            let entry = &entries[0];
            assert_eq!((entry.kind, entry.value.as_str()), (TrustKind::Anyone, "*"));
            assert!(entry.external && !entry.conditional);
            assert!(entry.warning.as_deref().is_some_and(|w| w.contains("누구나") && w.contains("위험")), "{entry:?}");
        }
        let guarded = parse(json!({ "AWS": "*" }), "sts:AssumeRole", Some(json!({ "StringEquals": { "aws:PrincipalOrgID": "o-abc" } })));
        assert_eq!(guarded[0].kind, TrustKind::Anyone);
        assert!(guarded[0].external && guarded[0].conditional);
        assert!(guarded[0].warning.as_deref().is_some_and(|w| !w.contains("위험")), "{:?}", guarded[0]);
    }

    #[test]
    fn the_own_account_is_not_external() {
        let own_root = parse(json!({ "AWS": format!("arn:aws:iam::{ACCOUNT}:root") }), "sts:AssumeRole", None);
        assert_eq!((own_root[0].kind, own_root[0].value.as_str()), (TrustKind::Account, ACCOUNT));
        assert!(!own_root[0].external);
        assert_eq!(own_root[0].warning, None);
        let own_id = parse(json!({ "AWS": ACCOUNT }), "sts:AssumeRole", None);
        assert!(!own_id[0].external && own_id[0].kind == TrustKind::Account);

        let own_role = parse(json!({ "AWS": format!("arn:aws:iam::{ACCOUNT}:role/deploy") }), "sts:AssumeRole", None);
        assert_eq!(own_role[0].kind, TrustKind::Principal);
        assert!(!own_role[0].external && own_role[0].warning.is_none());

        let foreign_role = parse(json!({ "AWS": "arn:aws:iam::222222222222:role/ops" }), "sts:AssumeRole", None);
        assert_eq!((foreign_role[0].kind, foreign_role[0].value.as_str()), (TrustKind::Principal, "arn:aws:iam::222222222222:role/ops"));
        assert!(foreign_role[0].external && foreign_role[0].warning.is_some());
        // 이미 지워진 주체의 ID처럼 계정을 알 수 없는 값은 외부로 세지 않는다
        let gone = parse(json!({ "AWS": "AROAEXAMPLEEXAMPLE" }), "sts:AssumeRole", None);
        assert_eq!((gone[0].kind, gone[0].external), (TrustKind::Principal, false));
    }

    #[test]
    fn services_and_providers_are_named_by_value() {
        let service = parse(json!({ "Service": ["lambda.amazonaws.com", "edgelambda.amazonaws.com"] }), "sts:AssumeRole", None);
        let values: Vec<&str> = service.iter().map(|e| e.value.as_str()).collect();
        assert_eq!(values, vec!["lambda.amazonaws.com", "edgelambda.amazonaws.com"]);
        assert!(service.iter().all(|e| e.kind == TrustKind::Service && !e.external && e.warning.is_none()));

        let saml = trust_of(SSO);
        assert_eq!((saml[0].kind, saml[0].value.as_str()), (TrustKind::Federated, "AWSSSO_abc_DO_NOT_DELETE"));
        assert_eq!(saml[0].actions, vec!["sts:AssumeRoleWithSAML".to_string()]);

        let eks = parse(json!({ "Federated": "arn:aws:iam::111111111111:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE" }), "sts:AssumeRoleWithWebIdentity", None);
        assert_eq!(eks[0].value, "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE");
        let cognito = parse(json!({ "Federated": "cognito-identity.amazonaws.com" }), "sts:AssumeRoleWithWebIdentity", None);
        assert_eq!((cognito[0].kind, cognito[0].value.as_str()), (TrustKind::Federated, "cognito-identity.amazonaws.com"));
    }

    #[test]
    fn one_statement_with_several_principals_gives_several_entries() {
        let entries = parse(json!({ "AWS": ["arn:aws:iam::999999999999:root", "222222222222"], "Service": "ec2.amazonaws.com" }), "sts:AssumeRole", None);
        let mut shown: Vec<(TrustKind, &str)> = entries.iter().map(|e| (e.kind, e.value.as_str())).collect();
        shown.sort_by_key(|(_, value)| value.to_string());
        assert_eq!(shown, vec![(TrustKind::Account, "222222222222"), (TrustKind::Account, "999999999999"), (TrustKind::Service, "ec2.amazonaws.com")]);
    }

    #[test]
    fn only_allow_statements_that_open_assume_actions_count() {
        let document = doc(policy(json!([
            { "Effect": "Deny", "Principal": "*", "Action": "sts:AssumeRole" },
            { "Effect": "Allow", "Principal": { "Service": "a.amazonaws.com" }, "Action": "sts:GetCallerIdentity" },
            { "Effect": "Allow", "Action": "sts:AssumeRole" },
            { "Effect": "Allow", "Principal": { "Service": "b.amazonaws.com" }, "Action": "sts:AssumeRole" }
        ])));
        let entries = parse_trust(&document, ACCOUNT);
        assert_eq!(entries.iter().map(|e| e.value.as_str()).collect::<Vec<_>>(), vec!["b.amazonaws.com"]);
        assert!(parse_trust(&doc(policy(json!([]))), ACCOUNT).is_empty());
    }

    #[test]
    fn assume_actions_are_matched_by_pattern() {
        let actions = |pattern: Value| parse(json!({ "Service": "x.amazonaws.com" }), pattern.as_str().unwrap(), None).into_iter().next().map(|e| e.actions);
        assert_eq!(actions(json!("sts:TagSession")), Some(vec!["sts:TagSession".to_string()]));
        assert_eq!(
            actions(json!("sts:AssumeRole*")),
            Some(vec!["sts:AssumeRole".to_string(), "sts:AssumeRoleWithSAML".to_string(), "sts:AssumeRoleWithWebIdentity".to_string()])
        );
        assert_eq!(actions(json!("sts:*")).map(|a| a.len()), Some(4));
        assert_eq!(actions(json!("*")).map(|a| a.len()), Some(4));
        assert_eq!(actions(json!("sts:GetSessionToken")), None);
        // NotAction도 같은 기준으로 본다
        let not_action = doc(policy(json!([{ "Effect": "Allow", "Principal": { "Service": "x.amazonaws.com" }, "NotAction": "sts:TagSession" }])));
        let entries = parse_trust(&not_action, ACCOUNT);
        assert_eq!(entries[0].actions.len(), 3);
    }
}
