//! 큐 정책과 KMS 키 정책 풀이(순수). 문장을 `PolicyGrant`로 풀어 화면에 보이고, 서비스(SNS·EventBridge·S3)가 큐에 보낼 수 있는지 묻는 질문에 답한다.
//! 판단할 수 없는 조건(모르는 연산자·키, 정책 변수 …)이 걸린 문장은 "모름"으로 둔다: 허용도 거부도 단정하지 않는다.

use serde_json::Value;

use super::{Effect, PolicyGrant};

const SEND: &str = "sqs:sendmessage";
/// 서비스가 암호화된 큐에 보내려면 두 작업이 모두 필요하다
const KEY_ACTIONS: [&str; 2] = ["kms:generatedatakey", "kms:decrypt"];

#[derive(Debug, Clone, PartialEq)]
struct Condition {
    operator: String,
    key: String,
    values: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
struct PrincipalSpec {
    /// `"*"` 또는 `{"AWS": "*"}`
    any: bool,
    aws: Vec<String>,
    services: Vec<String>,
    /// Federated·CanonicalUser … 서비스 호출에는 해당 없다
    other: Vec<String>,
    /// NotPrincipal
    negated: bool,
}

#[derive(Debug, Clone, PartialEq)]
struct Statement {
    sid: Option<String>,
    effect: Effect,
    principal: PrincipalSpec,
    actions: Vec<String>,
    not_action: bool,
    conditions: Vec<Condition>,
}

/// 문자열 하나 또는 배열. 숫자·불리언은 글자로 바꾼다
fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(items)) => items.iter().flat_map(|v| strings(Some(v))).collect(),
        Some(Value::Bool(b)) => vec![b.to_string()],
        Some(Value::Number(n)) => vec![n.to_string()],
        _ => vec![],
    }
}

fn principal_of(statement: &Value) -> PrincipalSpec {
    let (raw, negated) = match (statement.get("Principal"), statement.get("NotPrincipal")) {
        (Some(p), _) => (p, false),
        (None, Some(p)) => (p, true),
        _ => return PrincipalSpec::default(),
    };
    let mut spec = PrincipalSpec { negated, ..Default::default() };
    match raw {
        Value::String(s) if s == "*" => spec.any = true,
        Value::String(s) => spec.other.push(s.clone()),
        Value::Object(map) => {
            for (kind, value) in map {
                let values = strings(Some(value));
                match kind.as_str() {
                    "AWS" => {
                        if values.iter().any(|v| v == "*") {
                            spec.any = true;
                        } else {
                            spec.aws.extend(values);
                        }
                    }
                    "Service" => spec.services.extend(values),
                    other => spec.other.extend(values.into_iter().map(|v| format!("{other}: {v}"))),
                }
            }
        }
        _ => {}
    }
    spec
}

fn conditions_of(statement: &Value) -> Vec<Condition> {
    let Some(Value::Object(operators)) = statement.get("Condition") else {
        return vec![];
    };
    let mut out = Vec::new();
    for (operator, keys) in operators {
        let Value::Object(keys) = keys else { continue };
        for (key, values) in keys {
            out.push(Condition { operator: operator.clone(), key: key.clone(), values: strings(Some(values)) });
        }
    }
    out
}

/// 정책 JSON의 문장들. JSON이 아니면 None
fn statements(policy: &str) -> Option<Vec<Statement>> {
    let doc: Value = serde_json::from_str(policy).ok()?;
    let list = match doc.get("Statement") {
        Some(Value::Array(items)) => items.iter().collect::<Vec<_>>(),
        Some(single @ Value::Object(_)) => vec![single],
        _ => vec![],
    };
    Some(
        list.into_iter()
            .map(|s| {
                let (actions, not_action) = match (s.get("Action"), s.get("NotAction")) {
                    (Some(a), _) => (strings(Some(a)), false),
                    (None, Some(a)) => (strings(Some(a)), true),
                    _ => (vec![], false),
                };
                Statement {
                    sid: s.get("Sid").and_then(Value::as_str).map(str::to_string),
                    effect: if s.get("Effect").and_then(Value::as_str) == Some("Deny") { Effect::Deny } else { Effect::Allow },
                    principal: principal_of(s),
                    actions,
                    not_action,
                    conditions: conditions_of(s),
                }
            })
            .collect(),
    )
}

/// 화면에 보일 문장 풀이. 읽을 수 없는 정책이면 빈 목록
pub fn parse(policy: &str) -> Vec<PolicyGrant> {
    statements(policy).unwrap_or_default().into_iter().map(grant_of).collect()
}

fn grant_of(s: Statement) -> PolicyGrant {
    let mut principals: Vec<String> = Vec::new();
    if s.principal.any {
        principals.push("*".into());
    }
    principals.extend(s.principal.aws.iter().cloned());
    principals.extend(s.principal.services.iter().cloned());
    principals.extend(s.principal.other.iter().cloned());
    if s.principal.negated {
        principals = principals.into_iter().map(|p| format!("NotPrincipal {p}")).collect();
    }
    let actions = if s.not_action { s.actions.iter().map(|a| format!("NotAction {a}")).collect() } else { s.actions.clone() };
    let sources = s
        .conditions
        .iter()
        .filter(|c| {
            let key = c.key.to_ascii_lowercase();
            key == "aws:sourcearn" || key == "aws:sourceaccount"
        })
        .flat_map(|c| c.values.iter().cloned())
        .collect();
    let conditions: Vec<String> = s.conditions.iter().map(|c| format!("{} {} {}", c.key, c.operator, c.values.join(", "))).collect();
    let public = s.effect == Effect::Allow && s.principal.any && !s.principal.negated && s.conditions.is_empty();
    PolicyGrant { sid: s.sid, effect: s.effect, principals, actions, conditions, sources, public }
}

/// 조건 없는 `Principal: "*"` Allow 문장이 있는가
pub fn is_public(policy: &str) -> bool {
    parse(policy).iter().any(|g| g.public)
}

/// 정책의 `aws:SourceArn` 값 가운데 S3 버킷 ARN(`arn:aws:s3:::버킷`)의 버킷 이름. 와일드카드가 든 것은 뺀다
pub fn s3_buckets(policy: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for grant in parse(policy) {
        if grant.effect != Effect::Allow {
            continue;
        }
        for source in grant.sources {
            if let Some(bucket) = source.strip_prefix("arn:aws:s3:::") {
                let bucket = bucket.split('/').next().unwrap_or(bucket);
                if !bucket.is_empty() && !bucket.contains(['*', '?']) && !out.iter().any(|b| b == bucket) {
                    out.push(bucket.to_string());
                }
            }
        }
    }
    out
}

/// 정책의 `aws:SourceArn` 값 가운데 Allow 문장의 것(와일드카드 없는 것만, 중복 없이)
pub fn allowed_source_arns(policy: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for grant in parse(policy) {
        if grant.effect != Effect::Allow {
            continue;
        }
        for source in grant.sources {
            if source.starts_with("arn:") && !source.contains(['*', '?']) && !out.contains(&source) {
                out.push(source);
            }
        }
    }
    out
}

/// `*`(0개 이상)와 `?`(1개)만 쓰는 대조
fn wildcard(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, ti));
            pi += 1;
        } else if let Some((sp, st)) = star {
            pi = sp + 1;
            ti = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|c| *c == '*')
}

/// 조건을 평가할 때 아는 값. 모르면 그 키의 조건은 "모름"이다
#[derive(Clone, Copy, Default)]
struct Context<'a> {
    source_arn: Option<&'a str>,
    source_account: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tri {
    Yes,
    No,
    Unknown,
}

impl Tri {
    /// 둘 다 참이어야 참(AND): 거짓이 하나라도 있으면 거짓, 아니면 모름이 하나라도 있으면 모름
    fn and(self, other: Tri) -> Tri {
        match (self, other) {
            (Tri::No, _) | (_, Tri::No) => Tri::No,
            (Tri::Unknown, _) | (_, Tri::Unknown) => Tri::Unknown,
            _ => Tri::Yes,
        }
    }
}

fn condition(c: &Condition, ctx: &Context) -> Tri {
    let mut operator = c.operator.to_ascii_lowercase();
    if let Some(base) = operator.strip_suffix("ifexists") {
        operator = base.to_string();
    }
    if operator.starts_with("foranyvalue:") || operator.starts_with("forallvalues:") || c.values.iter().any(|v| v.contains("${")) {
        return Tri::Unknown;
    }
    let key = c.key.to_ascii_lowercase();
    // HTTPS로 부르는 호출이다: 전송 보안 조건은 참으로 본다
    if key == "aws:securetransport" && operator == "bool" {
        return if c.values.iter().any(|v| v.eq_ignore_ascii_case("true")) { Tri::Yes } else { Tri::No };
    }
    let actual = match key.as_str() {
        "aws:sourcearn" if matches!(operator.as_str(), "arnequals" | "arnlike" | "stringequals" | "stringlike" | "arnnotequals" | "arnnotlike" | "stringnotequals" | "stringnotlike") => ctx.source_arn,
        "aws:sourceaccount" if matches!(operator.as_str(), "stringequals" | "stringlike" | "stringnotequals" | "stringnotlike") => ctx.source_account,
        _ => return Tri::Unknown,
    };
    let Some(actual) = actual else { return Tri::Unknown };
    let exact = operator.starts_with("stringequals") || operator.starts_with("stringnotequals");
    let hit = c.values.iter().any(|pattern| if exact { pattern == actual } else { wildcard(pattern, actual) });
    if operator.contains("not") {
        if hit { Tri::No } else { Tri::Yes }
    } else if hit {
        Tri::Yes
    } else {
        Tri::No
    }
}

fn conditions_hold(s: &Statement, ctx: &Context) -> Tri {
    s.conditions.iter().fold(Tri::Yes, |acc, c| acc.and(condition(c, ctx)))
}

/// 문장이 이 서비스 주체의 이 작업에 적용되는가(조건은 따로)
fn applies(s: &Statement, service: &str, action: &str) -> bool {
    let listed = s.principal.any || s.principal.services.iter().any(|p| p.eq_ignore_ascii_case(service));
    let principal_hit = if s.principal.negated { !listed } else { listed };
    let covered = s.actions.iter().any(|a| wildcard(&a.to_ascii_lowercase(), action));
    let action_hit = if s.not_action { !covered } else { covered };
    principal_hit && action_hit
}

/// Deny 우선: 거부가 확실하면 false, 허용이 확실하고 거부 가능성이 없으면 true, 모르는 조건이 판단을 가르면 None
fn decide(statements: &[Statement], service: &str, action: &str, ctx: &Context) -> Option<bool> {
    let (mut deny, mut deny_unknown, mut allow, mut allow_unknown) = (false, false, false, false);
    for s in statements.iter().filter(|s| applies(s, service, action)) {
        match (s.effect, conditions_hold(s, ctx)) {
            (Effect::Deny, Tri::Yes) => deny = true,
            (Effect::Deny, Tri::Unknown) => deny_unknown = true,
            (Effect::Allow, Tri::Yes) => allow = true,
            (Effect::Allow, Tri::Unknown) => allow_unknown = true,
            _ => {}
        }
    }
    if deny {
        Some(false)
    } else if allow {
        if deny_unknown { None } else { Some(true) }
    } else if allow_unknown {
        None
    } else {
        Some(false)
    }
}

fn account_of(arn: &str) -> Option<&str> {
    arn.split(':').nth(4).filter(|a| !a.is_empty())
}

/// 큐 정책이 `service`(예: `sns.amazonaws.com`)가 `source_arn`에서 이 큐로 `sqs:SendMessage` 하는 것을 허용하는가.
/// 정책이 없으면 같은 계정 서비스도 거부된다. 읽을 수 없는 정책이나 판단할 수 없는 조건이면 None.
/// 출처 ARN에 계정이 없으면(S3 버킷) 큐와 같은 계정으로 본다.
pub fn allows_send(policy: Option<&str>, source_arn: &str, service: &str, account_of_queue: &str) -> Option<bool> {
    let Some(policy) = policy.filter(|p| !p.trim().is_empty()) else {
        return Some(false);
    };
    let list = statements(policy)?;
    let ctx = Context { source_arn: Some(source_arn), source_account: Some(account_of(source_arn).unwrap_or(account_of_queue)) };
    decide(&list, service, SEND, &ctx)
}

/// 키 정책이 `service` 주체에게 `kms:GenerateDataKey*`와 `kms:Decrypt`를 모두 주는가. 읽을 수 없거나 조건 때문에 판단할 수 없으면 None
pub fn key_allows_service(policy: &str, service: &str) -> Option<bool> {
    let list = statements(policy)?;
    let ctx = Context::default();
    let mut verdict = Some(true);
    for action in KEY_ACTIONS {
        match decide(&list, service, action, &ctx) {
            Some(false) => return Some(false),
            None => verdict = None,
            Some(true) => {}
        }
    }
    verdict
}

#[cfg(test)]
mod tests;
