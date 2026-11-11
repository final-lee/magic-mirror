//! SNS 구독 필터 정책 판정(순수 함수).
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::net::IpAddr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Scope {
    MessageAttributes,
    MessageBody,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleAttr {
    pub name: String,
    pub data_type: String,
    pub value: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub attributes: Vec<SampleAttr>,
    pub body: Option<String>,
}
#[derive(Debug, Clone)]
pub struct FilterPolicy {
    root: Value,
    size: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyError {
    pub message: String,
    pub path: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterVerdict {
    pub matched: bool,
    pub key: Option<String>,
    pub reason: Option<String>,
}

fn error(message: impl Into<String>, path: Option<String>) -> PolicyError {
    PolicyError {
        message: message.into(),
        path,
    }
}
fn path(base: &str, key: &str) -> String {
    if base.is_empty() {
        key.to_owned()
    } else {
        format!("{base}.{key}")
    }
}
const RESERVED: &[&str] = &[
    "numeric",
    "prefix",
    "suffix",
    "anything-but",
    "exists",
    "equals-ignore-case",
    "wildcard",
    "cidr",
];
fn is_or(v: &Value) -> bool {
    v.as_array().is_some_and(|a| {
        a.len() >= 2
            && a.iter().all(|v| {
                v.as_object()
                    .is_some_and(|o| o.keys().all(|k| !RESERVED.contains(&k.as_str())))
            })
    })
}
fn check_operator(v: &Value, p: &str) -> Result<(), PolicyError> {
    if v.is_string() || v.is_number() || v.is_boolean() || v.is_null() {
        return Ok(());
    }
    let obj = v
        .as_object()
        .filter(|o| o.len() == 1)
        .ok_or_else(|| error("일치 조건이 올바르지 않아요", Some(p.into())))?;
    let (op, arg) = obj.iter().next().unwrap();
    let valid = match op.as_str() {
        "prefix" | "suffix" | "equals-ignore-case" | "wildcard" => arg.is_string(),
        "cidr" => arg.as_str().is_some_and(valid_cidr),
        "exists" => arg.is_boolean(),
        "numeric" => arg.as_array().is_some_and(|a| {
            !a.is_empty()
                && a.len() <= 4
                && a.len() % 2 == 0
                && a.chunks(2).all(|c| {
                    c[0].as_str()
                        .is_some_and(|s| ["=", "<", "<=", ">", ">="].contains(&s))
                        && c[1].is_number()
                })
        }),
        "anything-but" => {
            arg.is_string()
                || arg.is_number()
                || arg.as_array().is_some_and(|a| {
                    !a.is_empty()
                        && a.iter().all(|v| v.is_string() || v.is_number())
                        && a.iter().all(|v| v.is_string() == a[0].is_string())
                })
                || arg.as_object().is_some_and(|o| {
                    o.len() == 1
                        && o.iter().all(|(k, v)| {
                            ["prefix", "suffix", "wildcard", "equals-ignore-case"]
                                .contains(&k.as_str())
                                && v.is_string()
                        })
                })
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(error("지원하지 않거나 잘못된 연산자예요", Some(p.into())))
    }
}
fn check_tree(v: &Value, base: &str) -> Result<(), PolicyError> {
    let obj = v.as_object().ok_or_else(|| {
        error(
            "정책은 JSON 객체여야 해요",
            (!base.is_empty()).then(|| base.into()),
        )
    })?;
    for (k, v) in obj {
        let p = path(base, k);
        if k == "$or" && is_or(v) {
            for (i, branch) in v.as_array().unwrap().iter().enumerate() {
                check_tree(branch, &format!("{p}[{i}]"))?;
            }
        } else if let Some(a) = v.as_array() {
            if a.is_empty() {
                return Err(error("일치 조건이 비어 있어요", Some(p)));
            }
            for (i, x) in a.iter().enumerate() {
                check_operator(x, &format!("{p}[{i}]"))?;
            }
        } else if v.is_object() {
            check_tree(v, &p)?;
        } else {
            return Err(error("키에는 조건 배열 또는 중첩 객체가 필요해요", Some(p)));
        }
    }
    Ok(())
}
pub fn parse_policy(raw: &str) -> Result<FilterPolicy, PolicyError> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| error(format!("JSON 문법 오류: {e}"), None))?;
    check_tree(&root, "")?;
    Ok(FilterPolicy {
        root,
        size: raw.len(),
    })
}

// AWS subscription-filter-policy-constraints: 키 5개, 조합 150개, 크기 256KB, 숫자 ±10^9·소수 5자리.
// 같은 문서 Wildcard pattern usage guidelines: 패턴당 별표 3개, 전체 100점.
// AWS and-or-logic의 Policy constraints that include OR: 분기별 조합을 더해요.
fn stats(
    v: &Value,
    scope: Scope,
    depth: usize,
    base: &str,
    errors: &mut Vec<PolicyError>,
) -> (usize, usize, usize) {
    let mut keys: usize = 0;
    let mut complexity: usize = 1;
    let mut wild: usize = 0;
    for (k, val) in v.as_object().unwrap() {
        let p = path(base, k);
        if k == "$or" && is_or(val) {
            let mut branches: usize = 0;
            let mut branch_keys: usize = 0;
            for b in val.as_array().unwrap() {
                let (n, c, w) = stats(b, scope, depth, &p, errors);
                branches = branches.saturating_add(c);
                branch_keys = branch_keys.saturating_add(n);
                wild = wild.saturating_add(w);
            }
            keys = keys.saturating_add(branch_keys);
            complexity = complexity.saturating_mul(branches);
        } else if let Some(a) = val.as_array() {
            keys += 1;
            complexity =
                complexity
                    .saturating_mul(a.len())
                    .saturating_mul(if scope == Scope::MessageBody {
                        depth
                    } else {
                        1
                    });
            let mut points = 0usize;
            for (i, item) in a.iter().enumerate() {
                let ip = format!("{p}[{i}]");
                fn numbers(v: &Value, p: &str, errors: &mut Vec<PolicyError>) {
                    match v {
                        Value::Number(n) => {
                            let f = n.as_f64().unwrap_or(f64::INFINITY);
                            if f.abs() > 1_000_000_000.0
                                || (f * 100_000.0 - (f * 100_000.0).round()).abs() > 0.00001
                            {
                                errors.push(error(
                                    "숫자는 ±10억 범위와 소수 다섯 자리 이내여야 해요",
                                    Some(p.into()),
                                ));
                            }
                        }
                        Value::Array(a) => {
                            for x in a {
                                numbers(x, p, errors);
                            }
                        }
                        Value::Object(o) => {
                            for x in o.values() {
                                numbers(x, p, errors);
                            }
                        }
                        _ => {}
                    }
                }
                numbers(item, &ip, errors);
                if let Some(o) = item.as_object() {
                    let ab = o.get("anything-but");
                    if ab.is_some() {
                        points += 1;
                    }
                    let pattern = o
                        .get("wildcard")
                        .or_else(|| ab.and_then(|v| v.get("wildcard")))
                        .and_then(Value::as_str);
                    if let Some(s) = pattern {
                        let n = s.chars().filter(|c| *c == '*').count();
                        if n > 3 {
                            errors.push(error("패턴당 와일드카드는 세 개까지예요", Some(ip)));
                        }
                        points += if n == 1 { 1 } else { n * 3 };
                    }
                }
            }
            wild = wild.saturating_add(points.saturating_mul(a.len()));
        } else {
            if scope == Scope::MessageAttributes {
                errors.push(error(
                    "속성 범위에는 중첩 정책을 쓸 수 없어요",
                    Some(p.clone()),
                ));
            }
            let (n, c, w) = stats(val, scope, depth + 1, &p, errors);
            keys = keys.saturating_add(n);
            complexity = complexity.saturating_mul(c);
            wild = wild.saturating_add(w);
        }
    }
    (keys, complexity, wild)
}
pub fn validate(policy: &FilterPolicy, scope: Scope) -> Vec<PolicyError> {
    let mut errors = Vec::new();
    let (keys, combinations, wild) = stats(&policy.root, scope, 1, "", &mut errors);
    if policy.size > 256 * 1024 {
        errors.push(error("정책은 256KB 이하여야 해요", None));
    }
    if keys > 5 {
        errors.push(error("필터 키는 다섯 개까지예요", None));
    }
    if combinations > 150 {
        errors.push(error("조건 조합은 150개까지예요", None));
    }
    if wild > 100 {
        errors.push(error("와일드카드 복잡도는 100점까지예요", None));
    }
    errors
}
fn valid_cidr(s: &str) -> bool {
    s.split_once('/').is_some_and(|(ip, n)| {
        ip.parse::<IpAddr>()
            .ok()
            .zip(n.parse::<u32>().ok())
            .is_some_and(|(ip, n)| n <= if ip.is_ipv4() { 32 } else { 128 })
    })
}
fn cidr(s: &str, net: &str) -> bool {
    let Some((ip, bits)) = net.split_once('/') else {
        return false;
    };
    let Ok(bits) = bits.parse::<u32>() else {
        return false;
    };
    match (s.parse::<IpAddr>(), ip.parse::<IpAddr>()) {
        (Ok(IpAddr::V4(a)), Ok(IpAddr::V4(b))) if bits <= 32 => {
            let mask = u32::MAX.checked_shl(32 - bits).unwrap_or(0);
            u32::from(a) & mask == u32::from(b) & mask
        }
        (Ok(IpAddr::V6(a)), Ok(IpAddr::V6(b))) if bits <= 128 => {
            let mask = u128::MAX.checked_shl(128 - bits).unwrap_or(0);
            u128::from(a) & mask == u128::from(b) & mask
        }
        _ => false,
    }
}
fn wildcard(pattern: &str, text: &str) -> bool {
    let pieces: Vec<&str> = pattern.split('*').collect();
    if pieces.len() == 1 {
        return pattern == text;
    }
    if !text.starts_with(pieces[0]) || !text.ends_with(pieces[pieces.len() - 1]) {
        return false;
    }
    let mut rest = &text[pieces[0].len()..];
    for (i, part) in pieces.iter().enumerate().skip(1) {
        if i == pieces.len() - 1 {
            return rest.ends_with(part);
        }
        if let Some(pos) = rest.find(part) {
            rest = &rest[pos + part.len()..];
        } else {
            return false;
        }
    }
    true
}
fn matches_value(rule: &Value, value: &Value) -> bool {
    if let Some(o) = rule.as_object() {
        let Some((op, arg)) = o.iter().next() else {
            return false;
        };
        match op.as_str() {
            "prefix" => value
                .as_str()
                .zip(arg.as_str())
                .is_some_and(|(v, a)| v.starts_with(a)),
            "suffix" => value
                .as_str()
                .zip(arg.as_str())
                .is_some_and(|(v, a)| v.ends_with(a)),
            "wildcard" => value
                .as_str()
                .zip(arg.as_str())
                .is_some_and(|(v, a)| wildcard(a, v)),
            "equals-ignore-case" => value
                .as_str()
                .zip(arg.as_str())
                .is_some_and(|(v, a)| v.to_lowercase() == a.to_lowercase()),
            "cidr" => value
                .as_str()
                .zip(arg.as_str())
                .is_some_and(|(v, a)| cidr(v, a)),
            "numeric" => value.as_f64().zip(arg.as_array()).is_some_and(|(v, a)| {
                a.chunks(2).all(|c| {
                    let n = c[1].as_f64().unwrap();
                    match c[0].as_str().unwrap() {
                        "=" => v == n,
                        "<" => v < n,
                        "<=" => v <= n,
                        ">" => v > n,
                        ">=" => v >= n,
                        _ => false,
                    }
                })
            }),
            "anything-but" => {
                if let Some(a) = arg.as_array() {
                    a.first().is_some_and(|x| same_type(x, value))
                        && !a.iter().any(|x| equal(x, value))
                } else if arg.is_object() {
                    value.is_string() && !matches_value(arg, value)
                } else {
                    same_type(arg, value) && !equal(arg, value)
                }
            }
            _ => false,
        }
    } else {
        equal(rule, value)
    }
}
fn same_type(a: &Value, b: &Value) -> bool {
    (a.is_string() && b.is_string())
        || (a.is_number() && b.is_number())
        || (a.is_boolean() && b.is_boolean())
        || (a.is_null() && b.is_null())
}
fn equal(a: &Value, b: &Value) -> bool {
    if a.is_number() && b.is_number() {
        a.as_f64() == b.as_f64()
    } else {
        a == b
    }
}
fn flatten<'a>(v: &'a Value, out: &mut Vec<&'a Value>) {
    if let Some(a) = v.as_array() {
        for x in a {
            flatten(x, out);
        }
    } else {
        out.push(v);
    }
}
fn present(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
        _ => true,
    }
}
fn eval_obj(
    policy: &Map<String, Value>,
    obj: &Map<String, Value>,
    base: &str,
    nonempty: bool,
) -> Result<(), (String, String)> {
    for (key, rule) in policy {
        let p = path(base, key);
        if key == "$or" && is_or(rule) {
            let mut first = None;
            if !rule.as_array().unwrap().iter().any(|b| {
                match eval_obj(b.as_object().unwrap(), obj, base, nonempty) {
                    Ok(()) => true,
                    Err(e) => {
                        if first.is_none() {
                            first = Some(e);
                        }
                        false
                    }
                }
            }) {
                return Err(
                    first.unwrap_or((p.clone(), format!("{p}: 어느 분기도 일치하지 않아요")))
                );
            }
        } else if let Some(conditions) = rule.as_array() {
            let value = obj.get(key);
            let exists = value.is_some_and(present);
            let mut vals = Vec::new();
            if let Some(v) = value {
                flatten(v, &mut vals);
            }
            let matched = conditions.iter().any(|c| {
                if let Some(b) = c.get("exists").and_then(Value::as_bool) {
                    if b {
                        exists
                    } else {
                        !exists && nonempty
                    }
                } else {
                    vals.iter().any(|v| matches_value(c, v))
                }
            });
            if !matched {
                return Err((
                    p.clone(),
                    if value.is_none() {
                        format!("{p}: 속성이 없어요")
                    } else {
                        format!("{p}: {}는 {}에 일치하지 않아요", value.unwrap(), rule)
                    },
                ));
            }
        } else {
            let mut candidates = Vec::new();
            if let Some(v) = obj.get(key) {
                flatten(v, &mut candidates);
            }
            let mut first = None;
            if !candidates.iter().filter_map(|v| v.as_object()).any(|v| {
                match eval_obj(rule.as_object().unwrap(), v, &p, nonempty) {
                    Ok(()) => true,
                    Err(e) => {
                        if first.is_none() {
                            first = Some(e);
                        }
                        false
                    }
                }
            }) {
                return Err(first.unwrap_or((p.clone(), format!("{p}: 객체가 없어요"))));
            }
        }
    }
    Ok(())
}
pub fn evaluate(policy: &FilterPolicy, scope: Scope, sample: &Sample) -> FilterVerdict {
    let body = match scope {
        Scope::MessageBody => sample
            .body
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .filter(Value::is_object),
        Scope::MessageAttributes => {
            let mut o = Map::new();
            for a in &sample.attributes {
                let v = match a.data_type.as_str() {
                    "String" => Some(Value::String(a.value.clone())),
                    "String.Array" => serde_json::from_str::<Value>(&a.value)
                        .ok()
                        .filter(Value::is_array),
                    "Number" => serde_json::from_str::<Value>(&a.value)
                        .ok()
                        .filter(Value::is_number),
                    _ => None,
                };
                if let Some(v) = v {
                    o.insert(a.name.clone(), v);
                }
            }
            Some(Value::Object(o))
        }
    };
    let Some(Value::Object(obj)) = body else {
        return FilterVerdict {
            matched: false,
            key: None,
            reason: Some("없거나 잘못된 본문이에요".into()),
        };
    };
    match eval_obj(policy.root.as_object().unwrap(), &obj, "", !obj.is_empty()) {
        Ok(()) => FilterVerdict {
            matched: true,
            key: None,
            reason: None,
        },
        Err((key, reason)) => FilterVerdict {
            matched: false,
            key: Some(key),
            reason: Some(reason),
        },
    }
}
pub fn summarize(policy: &FilterPolicy, scope: Scope) -> String {
    fn collect(obj: &Map<String, Value>, base: &str, parts: &mut Vec<String>) {
        for (k, v) in obj {
            let p = path(base, k);
            if k == "$or" && is_or(v) {
                let branches: Vec<String> = v
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|b| {
                        let mut x = Vec::new();
                        collect(b.as_object().unwrap(), base, &mut x);
                        x.join(" · ")
                    })
                    .collect();
                parts.push(format!("({})", branches.join(" 또는 ")));
            } else if let Some(a) = v.as_array() {
                if a.len() == 1 {
                    if let Some(n) = a[0].get("numeric").and_then(Value::as_array) {
                        let pairs: Vec<String> = n
                            .chunks(2)
                            .map(|c| {
                                format!(
                                    "{} {}",
                                    match c[0].as_str().unwrap() {
                                        ">=" => "≥",
                                        "<=" => "≤",
                                        "=" => "=",
                                        ">" => ">",
                                        _ => "<",
                                    },
                                    c[1]
                                )
                            })
                            .collect();
                        parts.push(format!("{p} {}", pairs.join(" · ")));
                        continue;
                    }
                }
                let mut values: Vec<String> = a
                    .iter()
                    .take(3)
                    .map(|x| {
                        x.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| x.to_string())
                    })
                    .collect();
                if a.len() > 3 {
                    values.push(format!("외 {}개", a.len() - 3));
                }
                parts.push(format!("{p} ∈ {{{}}}", values.join(", ")));
            } else if let Some(o) = v.as_object() {
                collect(o, &p, parts);
            }
        }
    }
    let mut parts = Vec::new();
    collect(policy.root.as_object().unwrap(), "", &mut parts);
    parts.push(
        match scope {
            Scope::MessageBody => "본문 범위",
            Scope::MessageAttributes => "속성 범위",
        }
        .into(),
    );
    parts.join(" · ")
}
#[cfg(test)]
mod tests;
