//! 자원 기반 정책(SNS 주제·SQS 큐·Lambda 함수·KMS 키) 판정.

use crate::iam::policy::{self, Actions, Effect, ResMatch};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Who {
    Anyone,
    Service(String),
    Account(String),
    Arn(String),
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ctx {
    pub source_arn: Option<String>,
    pub source_account: Option<String>,
    pub source_owner: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Verdict {
    Allow { statement: usize },
    Deny { statement: usize },
    NoMatch,
    Unknown { reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Reach {
    Public,
    CrossAccount,
    Service,
    SameAccount,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrincipalView {
    pub kind: String,
    pub value: String,
    pub account: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementView {
    pub index: usize,
    pub sid: Option<String>,
    pub effect: String,
    pub sentence: String,
    pub principals: Vec<PrincipalView>,
    pub not_action: bool,
    pub actions: Vec<String>,
    pub conditions: Vec<String>,
    pub scope: Reach,
}

fn account(value: &str) -> Option<&str> {
    if value.len() == 12 && value.bytes().all(|b| b.is_ascii_digit()) {
        return Some(value);
    }
    let mut parts = value.split(':');
    if parts.next()? != "arn" {
        return None;
    }
    parts.next()?;
    parts.next()?;
    parts.next()?;
    let id = parts.next()?;
    if id.len() == 12 && id.bytes().all(|b| b.is_ascii_digit()) {
        Some(id)
    } else {
        None
    }
}

fn strings(value: &Value) -> Option<Vec<&str>> {
    match value {
        Value::String(s) => Some(vec![s]),
        Value::Array(a) => a.iter().map(Value::as_str).collect(),
        _ => None,
    }
}

fn principal_views(value: Option<&Value>) -> Result<Vec<PrincipalView>, String> {
    let Some(value) = value else {
        return Err("Principal이 없어요".into());
    };
    if value == "*" {
        return Ok(vec![PrincipalView {
            kind: "anyone".into(),
            value: "*".into(),
            account: None,
        }]);
    }
    let obj = value.as_object().ok_or("Principal을 판정할 수 없어요")?;
    let mut result = Vec::new();
    for (kind, values) in obj {
        for v in strings(values).ok_or_else(|| format!("Principal {kind} 값을 판정할 수 없어요"))?
        {
            let id = account(v).map(str::to_owned);
            let k = match kind.as_str() {
                "AWS" if v == "*" => "anyone",
                "AWS" if id.is_some() && (!v.starts_with("arn:") || v.ends_with(":root")) => {
                    "account"
                }
                "AWS" if v.starts_with("arn:") => "arn",
                "Service" => "service",
                "Federated" => "federated",
                _ => return Err(format!("Principal {kind}을 판정할 수 없어요")),
            };
            result.push(PrincipalView {
                kind: k.into(),
                value: v.into(),
                account: id,
            });
        }
    }
    Ok(result)
}

fn principal_matches(value: Option<&Value>, who: &Who) -> Result<bool, String> {
    let views = principal_views(value)?;
    let mut unknown = None;
    for p in views {
        if p.value.contains("${") {
            unknown = Some(format!(
                "Principal 정책 변수 {}를 판정할 수 없어요",
                p.value
            ));
            continue;
        }
        let matches = match (p.kind.as_str(), who) {
            ("anyone", _) => true,
            ("service", Who::Service(s)) => p.value.eq_ignore_ascii_case(s),
            ("account", Who::Account(id)) => p.account.as_deref() == Some(id),
            ("account", Who::Arn(arn)) => p.account.as_deref() == account(arn),
            ("arn", Who::Arn(arn)) => p.value == *arn,
            ("federated", _) => {
                unknown = Some(format!("Federated 주체 {}를 판정할 수 없어요", p.value));
                false
            }
            _ => false,
        };
        if matches {
            return Ok(true);
        }
    }
    unknown.map_or(Ok(false), Err)
}

fn conditions_match(condition: Option<&Value>, ctx: &Ctx) -> Result<bool, String> {
    let Some(condition) = condition else {
        return Ok(true);
    };
    let operators = condition
        .as_object()
        .ok_or("Condition을 판정할 수 없어요")?;
    let mut unknown = None;
    for (op, keys) in operators {
        let lower = op.to_ascii_lowercase();
        let (base, if_exists) = lower
            .strip_suffix("ifexists")
            .map_or((lower.as_str(), false), |s| (s, true));
        let (negative, like) = match base {
            "stringequals" => (false, false),
            "stringnotequals" => (true, false),
            // AWS 문서: ArnEquals·ArnNotEquals는 ArnLike·ArnNotLike와 똑같이 와일드카드를 쓴다
            "stringlike" | "arnlike" | "arnequals" => (false, true),
            "stringnotlike" | "arnnotlike" | "arnnotequals" => (true, true),
            _ => {
                unknown = Some(format!("조건 연산자 {op}을 판정할 수 없어요"));
                continue;
            }
        };
        let Some(keys) = keys.as_object() else {
            unknown = Some(format!("조건 {op}을 판정할 수 없어요"));
            continue;
        };
        for (key, values) in keys {
            let actual = match key.to_ascii_lowercase().as_str() {
                "aws:sourcearn" => ctx.source_arn.as_deref(),
                "aws:sourceaccount" => ctx.source_account.as_deref(),
                "aws:sourceowner" => ctx.source_owner.as_deref(),
                _ => {
                    unknown = Some(format!("조건 키 {key}를 판정할 수 없어요"));
                    continue;
                }
            };
            let Some(values) = strings(values) else {
                unknown = Some(format!("조건 {key} 값을 판정할 수 없어요"));
                continue;
            };
            if values.iter().any(|v| v.contains("${")) {
                unknown = Some(format!("조건 {key}의 정책 변수를 판정할 수 없어요"));
                continue;
            }
            let Some(actual) = actual else {
                if !if_exists && !negative {
                    return Ok(false);
                }
                continue;
            };
            let any = values.iter().any(|v| {
                if like {
                    policy::glob(v, actual, false)
                } else {
                    *v == actual
                }
            });
            if any == negative {
                return Ok(false);
            }
        }
    }
    unknown.map_or(Ok(true), Err)
}

fn raw_statements(raw: &str) -> Result<Vec<Value>, String> {
    let value: Value = serde_json::from_str(&policy::decode_document(raw))
        .map_err(|e| format!("정책 문서가 올바른 JSON이 아니에요: {e}"))?;
    match value.get("Statement") {
        Some(Value::Array(a)) => Ok(a.clone()),
        Some(v @ Value::Object(_)) => Ok(vec![v.clone()]),
        _ => Err("Statement는 객체나 배열이어야 해요".into()),
    }
}

fn action_match(actions: &Actions, action: &str) -> ResMatch {
    let (patterns, negated) = match actions {
        Actions::Action(patterns) => (patterns, false),
        Actions::NotAction(patterns) => (patterns, true),
    };
    let mut found = ResMatch::No;
    for pattern in patterns {
        let matched = if pattern.contains("${") {
            policy::resource_matches(&pattern.to_ascii_lowercase(), &action.to_ascii_lowercase())
        } else if policy::action_matches(pattern, action) {
            ResMatch::Yes
        } else {
            ResMatch::No
        };
        if matched == ResMatch::Yes {
            found = matched;
            break;
        }
        if matched == ResMatch::Unknown {
            found = matched;
        }
    }
    if negated {
        match found {
            ResMatch::Yes => ResMatch::No,
            ResMatch::No => ResMatch::Yes,
            ResMatch::Unknown => ResMatch::Unknown,
        }
    } else {
        found
    }
}

pub fn allows(policy_json: &str, who: &Who, action: &str, resource: &str, ctx: &Ctx) -> Verdict {
    let doc = match policy::parse_document(policy_json) {
        Ok(d) => d,
        Err(reason) => return Verdict::Unknown { reason },
    };
    let raw = match raw_statements(policy_json) {
        Ok(d) => d,
        Err(reason) => return Verdict::Unknown { reason },
    };
    let mut allow = None;
    let mut unknown_deny = None;
    let mut unknown_allow = None;
    for s in &doc.statements {
        let action_match = action_match(&s.actions, action);
        if action_match == ResMatch::No {
            continue;
        }
        let resource_match = policy::statement_resource_matches(s, Some(resource));
        if resource_match == ResMatch::No {
            continue;
        }
        let principal = if raw[s.index].get("NotPrincipal").is_some() {
            Err("NotPrincipal을 판정할 수 없어요".into())
        } else {
            principal_matches(s.principal.as_ref(), who)
        };
        let condition = conditions_match(s.condition.as_ref(), ctx);
        if matches!(principal, Ok(false)) || matches!(condition, Ok(false)) {
            continue;
        }
        let uncertain = principal.err().or_else(|| condition.err()).or_else(|| {
            if resource_match == ResMatch::Unknown {
                Some("Resource 정책 변수를 판정할 수 없어요".into())
            } else if action_match == ResMatch::Unknown {
                Some("Action 정책 변수를 판정할 수 없어요".into())
            } else {
                None
            }
        });
        if let Some(reason) = uncertain {
            match s.effect {
                Effect::Deny => unknown_deny = Some(reason),
                Effect::Allow => unknown_allow = Some(reason),
            }
        } else {
            match s.effect {
                Effect::Deny => return Verdict::Deny { statement: s.index },
                Effect::Allow => {
                    if allow.is_none() {
                        allow = Some(s.index);
                    }
                }
            }
        }
    }
    if let Some(reason) = unknown_deny {
        Verdict::Unknown { reason }
    } else if let Some(statement) = allow {
        Verdict::Allow { statement }
    } else if let Some(reason) = unknown_allow {
        Verdict::Unknown { reason }
    } else {
        Verdict::NoMatch
    }
}

fn restricts_public(condition: Option<&Value>) -> bool {
    condition.and_then(Value::as_object).is_some_and(|ops| {
        ops.iter().any(|(op, keys)| {
            let op = op.to_ascii_lowercase();
            if !matches!(
                op.as_str(),
                "stringequals" | "stringlike" | "arnequals" | "arnlike"
            ) {
                return false;
            }
            keys.as_object().is_some_and(|keys| {
                keys.iter().any(|(key, value)| {
                    matches!(
                        key.to_ascii_lowercase().as_str(),
                        "aws:sourceowner"
                            | "aws:sourceaccount"
                            | "aws:sourcearn"
                            | "aws:principalorgid"
                            | "aws:sourcevpce"
                    ) && strings(value).is_some_and(|values| {
                        !values.is_empty()
                            && values
                                .iter()
                                .all(|v| !v.chars().all(|c| c == '*') && !v.contains("${"))
                    })
                })
            })
        })
    })
}

pub fn describe(policy_json: &str, own_account: &str) -> Result<Vec<StatementView>, String> {
    let doc = policy::parse_document(policy_json)?;
    let raw = raw_statements(policy_json)?;
    Ok(doc
        .statements
        .into_iter()
        .map(|s| {
            let principals = principal_views(s.principal.as_ref()).unwrap_or_default();
            let restricted = restricts_public(s.condition.as_ref());
            let owner_values = |positive: &[&str]| -> Vec<String> {
                s.condition
                    .as_ref()
                    .and_then(Value::as_object)
                    .into_iter()
                    .flatten()
                    .filter(|(op, _)| positive.contains(&op.to_ascii_lowercase().as_str()))
                    .filter_map(|(_, keys)| keys.as_object())
                    .flat_map(|keys| {
                        keys.iter()
                            .filter(|(key, _)| {
                                matches!(
                                    key.to_ascii_lowercase().as_str(),
                                    "aws:sourceowner" | "aws:sourceaccount"
                                )
                            })
                            .filter_map(|(_, value)| strings(value))
                            .flatten()
                            .map(str::to_owned)
                            .collect::<Vec<_>>()
                    })
                    .collect()
            };
            let own_owner = s
                .condition
                .as_ref()
                .and_then(Value::as_object)
                .is_some_and(|ops| {
                    ops.iter().any(|(op, values)| {
                        op.eq_ignore_ascii_case("StringEquals")
                            && values.as_object().is_some_and(|keys| {
                                keys.iter().any(|(key, value)| {
                                    key.eq_ignore_ascii_case("aws:SourceOwner")
                                        && strings(value).is_some_and(|vs| vs == vec![own_account])
                                })
                            })
                    })
                });
            // 다른 계정 번호로 못 박은 SourceOwner·SourceAccount: 그 계정에 열린 허용이다
            let foreign_owner = owner_values(&["stringequals", "stringlike"])
                .iter()
                .any(|v| {
                    v.len() == 12 && v.bytes().all(|b| b.is_ascii_digit()) && v != own_account
                });
            let scope = if raw[s.index].get("NotPrincipal").is_some() || principals.is_empty() {
                Reach::Unknown
            } else if principals.iter().any(|p| p.kind == "anyone") {
                if own_owner {
                    Reach::SameAccount
                } else if foreign_owner {
                    Reach::CrossAccount
                } else if restricted {
                    Reach::Unknown
                } else {
                    Reach::Public
                }
            } else if principals
                .iter()
                .any(|p| p.account.as_deref().is_some_and(|id| id != own_account))
            {
                Reach::CrossAccount
            } else if principals.iter().any(|p| p.kind == "service") {
                Reach::Service
            } else if principals
                .iter()
                .all(|p| p.account.as_deref() == Some(own_account))
            {
                Reach::SameAccount
            } else {
                Reach::Unknown
            };
            let subjects = principals
                .iter()
                .map(|p| match p.kind.as_str() {
                    "anyone" if own_owner => format!("이 계정({own_account}) 안의 주체"),
                    "anyone" => "모든 주체(*)".into(),
                    "account" if p.account.as_deref() == Some(own_account) => {
                        format!("이 계정({own_account}) 안의 주체")
                    }
                    "account" => format!("계정 {}", p.account.as_deref().unwrap_or(&p.value)),
                    "service" => format!("서비스 {}", p.value),
                    _ => p.value.clone(),
                })
                .collect::<Vec<_>>()
                .join(" · ");
            let actions = match &s.actions {
                Actions::Action(a) | Actions::NotAction(a) => a.clone(),
            };
            let action_text = match &s.actions {
                Actions::Action(_) => actions.join(" · "),
                Actions::NotAction(_) => format!("{} 외 작업", actions.join(" · ")),
            };
            let effect = match s.effect {
                Effect::Allow => "Allow",
                Effect::Deny => "Deny",
            };
            let sentence = format!(
                "{}가 {} {}, {}",
                if subjects.is_empty() {
                    "판정할 수 없는 주체"
                } else {
                    &subjects
                },
                action_text,
                if s.effect == Effect::Allow {
                    "가능"
                } else {
                    "거부"
                },
                if s.conditions.is_empty() {
                    "조건 없음".to_string()
                } else {
                    s.conditions.join(" · ")
                }
            );
            let not_action = matches!(s.actions, Actions::NotAction(_));
            StatementView {
                index: s.index,
                sid: s.sid,
                effect: effect.into(),
                sentence,
                principals,
                not_action,
                actions,
                conditions: s.conditions,
                scope,
            }
        })
        .collect())
}

fn editable_document(raw: &str) -> Result<Value, String> {
    policy::parse_document(raw)?;
    serde_json::from_str(&policy::decode_document(raw))
        .map_err(|e| format!("정책 문서가 올바른 JSON이 아니에요: {e}"))
}

pub fn add_statement(
    policy_json: Option<&str>,
    resource_arn: &str,
    statement: Value,
) -> Result<String, String> {
    let mut doc = match policy_json {
        Some(raw) => editable_document(raw)?,
        None => json!({"Version":"2012-10-17", "Statement": []}),
    };
    let obj = statement.as_object().ok_or("문장은 JSON 객체여야 해요")?;
    let sid = obj
        .get("Sid")
        .and_then(Value::as_str)
        .ok_or("문장에 Sid가 있어야 해요")?
        .to_owned();
    if sid.is_empty() {
        return Err("Sid가 비어 있어요".into());
    }
    let _ = resource_arn;
    let slot = doc.get_mut("Statement").ok_or("Statement가 없어요")?;
    let mut statements = match std::mem::take(slot) {
        Value::Array(a) => a,
        one @ Value::Object(_) => vec![one],
        _ => return Err("Statement는 객체나 배열이어야 해요".into()),
    };
    if let Some(index) = statements
        .iter()
        .position(|s| s.get("Sid").and_then(Value::as_str) == Some(&sid))
    {
        statements[index] = statement;
    } else {
        statements.push(statement);
    }
    *slot = Value::Array(statements);
    let output = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    policy::parse_document(&output)?;
    Ok(output)
}

pub fn remove_statement(policy_json: &str, sid: &str) -> Result<Option<String>, String> {
    let mut doc = editable_document(policy_json)?;
    let slot = doc.get_mut("Statement").ok_or("Statement가 없어요")?;
    let mut statements = match std::mem::take(slot) {
        Value::Array(a) => a,
        one @ Value::Object(_) => vec![one],
        _ => return Err("Statement는 객체나 배열이어야 해요".into()),
    };
    statements.retain(|s| s.get("Sid").and_then(Value::as_str) != Some(sid));
    if statements.is_empty() {
        return Ok(None);
    }
    *slot = Value::Array(statements);
    serde_json::to_string_pretty(&doc)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// 문서에서 이 Sid의 문장 하나(없으면 `None`)
pub fn statement_by_sid(policy_json: &str, sid: &str) -> Option<Value> {
    raw_statements(policy_json)
        .ok()?
        .into_iter()
        .find(|s| s.get("Sid").and_then(Value::as_str) == Some(sid))
}

#[cfg(test)]
mod tests;
