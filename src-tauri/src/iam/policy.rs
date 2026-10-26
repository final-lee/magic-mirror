//! IAM 정책 문서 파싱과 작업·리소스 매칭.

use std::str::Chars;

use serde::de::IgnoredAny;
use serde::Serialize;
use serde_json::{Map, Value};

/// 문서에 적힌 그대로 `"Allow"` / `"Deny"`로 직렬화된다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Effect {
    Allow,
    Deny,
}

/// 문장의 `Action`(하나라도 맞으면 적용) 또는 `NotAction`(하나도 안 맞아야 적용). 패턴 원문 그대로다.
#[derive(Clone, Debug, PartialEq)]
pub enum Actions {
    Action(Vec<String>),
    NotAction(Vec<String>),
}

/// 문장의 `Resource` 또는 `NotResource`. 둘 다 없으면 Unspecified(신뢰 정책 문장).
#[derive(Clone, Debug, PartialEq)]
pub enum Resources {
    Resource(Vec<String>),
    NotResource(Vec<String>),
    Unspecified,
}

/// 정규화한 정책 문장 하나.
#[derive(Clone, Debug, PartialEq)]
pub struct Statement {
    /// 문서 안에서의 순서(0부터)
    pub index: usize,
    pub sid: Option<String>,
    pub effect: Effect,
    pub actions: Actions,
    pub resources: Resources,
    /// 신뢰 정책의 `Principal` 값(`"*"` 또는 `{"AWS": ...}` 같은 원본 JSON)
    pub principal: Option<Value>,
    /// 조건이 하나라도 있으면 true
    pub conditional: bool,
    /// "<키> · <연산자> · <값, 값>" 줄, 정렬됨
    pub conditions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PolicyDocument {
    pub statements: Vec<Statement>,
}

/// 리소스 패턴 판정. 정책 변수(`${aws:username}` 등)가 있으면 값을 몰라서 Unknown이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResMatch {
    Yes,
    No,
    Unknown,
}

/// URL 인코딩된 정책 문서를 푼다. IAM API는 문서를 RFC 3986 퍼센트 인코딩으로 돌려준다(`+`는 그대로 `+`).
/// `{`나 `[`로 시작하면 이미 평문이다. 값 안에 든 `%22` 같은 글자를 풀면 문서가 망가지기 때문이다.
pub fn decode_document(raw: &str) -> String {
    let trimmed = raw.trim_start();
    let plain = trimmed.starts_with('{') || trimmed.starts_with('[');
    if plain || !(contains_ignore_case(raw, b"%7B") || contains_ignore_case(raw, b"%22")) {
        return raw.to_string();
    }
    percent_decode(raw)
}

fn contains_ignore_case(text: &str, needle: &[u8]) -> bool {
    text.as_bytes().windows(needle.len()).any(|w| w.eq_ignore_ascii_case(needle))
}

/// `%XX`만 바이트로 바꾼다. 짝이 맞지 않는 `%`는 그대로 둔다.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = bytes.get(i + 1).and_then(|b| hex_value(*b));
            let lo = bytes.get(i + 2).and_then(|b| hex_value(*b));
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(b: u8) -> Option<u8> {
    (b as char).to_digit(16).map(|d| d as u8)
}

/// 디코드 후 JSON으로 읽어 문장 목록으로 정규화한다. `Statement`는 객체 하나여도 된다.
pub fn parse_document(raw: &str) -> Result<PolicyDocument, String> {
    let text = decode_document(raw);
    let value: Value = serde_json::from_str(&text).map_err(|e| format!("정책 문서가 올바른 JSON이 아니에요: {e}"))?;
    let root = value.as_object().ok_or("정책 문서는 JSON 객체여야 해요")?;
    let statements = match root.get("Statement") {
        Some(Value::Array(items)) => items.iter().enumerate().map(|(i, v)| parse_statement(i, v)).collect::<Result<Vec<_>, _>>()?,
        Some(one @ Value::Object(_)) => vec![parse_statement(0, one)?],
        Some(_) => return Err("Statement는 객체나 배열이어야 해요".to_string()),
        None => return Err("Statement가 없어요".to_string()),
    };
    Ok(PolicyDocument { statements })
}

fn parse_statement(index: usize, value: &Value) -> Result<Statement, String> {
    statement_fields(index, value).map_err(|e| format!("{}번째 문장: {e}", index + 1))
}

fn statement_fields(index: usize, value: &Value) -> Result<Statement, String> {
    let obj = value.as_object().ok_or("문장은 JSON 객체여야 해요")?;
    let effect = match obj.get("Effect").and_then(Value::as_str) {
        Some("Allow") => Effect::Allow,
        Some("Deny") => Effect::Deny,
        _ => return Err("Effect는 Allow나 Deny여야 해요".to_string()),
    };
    let actions = match (string_list(obj, "Action")?, string_list(obj, "NotAction")?) {
        (Some(list), None) => Actions::Action(list),
        (None, Some(list)) => Actions::NotAction(list),
        (Some(_), Some(_)) => return Err("Action과 NotAction을 함께 쓸 수 없어요".to_string()),
        (None, None) => return Err("Action이나 NotAction이 있어야 해요".to_string()),
    };
    let resources = match (string_list(obj, "Resource")?, string_list(obj, "NotResource")?) {
        (Some(list), None) => Resources::Resource(list),
        (None, Some(list)) => Resources::NotResource(list),
        (None, None) => Resources::Unspecified,
        (Some(_), Some(_)) => return Err("Resource와 NotResource를 함께 쓸 수 없어요".to_string()),
    };
    let conditions = condition_lines(obj.get("Condition"))?;
    Ok(Statement {
        index,
        sid: obj.get("Sid").and_then(Value::as_str).map(str::to_owned),
        effect,
        actions,
        resources,
        principal: obj.get("Principal").cloned(),
        // 비어 있는 Condition 블록은 아무것도 제한하지 않는다
        conditional: !conditions.is_empty(),
        conditions,
    })
}

/// 문자열 하나 또는 문자열 배열을 목록으로 읽는다. 필드가 없으면 None.
fn string_list(obj: &Map<String, Value>, key: &str) -> Result<Option<Vec<String>>, String> {
    match obj.get(key) {
        None => Ok(None),
        Some(Value::String(one)) => Ok(Some(vec![one.clone()])),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| format!("{key}에는 문자열만 쓸 수 있어요")))
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Some(_) => Err(format!("{key} 값은 문자열이나 문자열 배열이어야 해요")),
    }
}

/// `Condition`을 "<키> · <연산자> · <값, 값>" 줄로 풀어 정렬한다.
fn condition_lines(condition: Option<&Value>) -> Result<Vec<String>, String> {
    let Some(condition) = condition else {
        return Ok(Vec::new());
    };
    let operators = condition.as_object().ok_or("Condition은 JSON 객체여야 해요")?;
    let mut lines = Vec::new();
    for (operator, keys) in operators {
        let keys = keys.as_object().ok_or_else(|| format!("Condition의 {operator} 값은 JSON 객체여야 해요"))?;
        for (key, values) in keys {
            lines.push(format!("{key} · {operator} · {}", condition_values(values)));
        }
    }
    lines.sort();
    Ok(lines)
}

fn condition_values(values: &Value) -> String {
    match values {
        Value::Array(items) => items.iter().map(scalar_text).collect::<Vec<_>>().join(", "),
        one => scalar_text(one),
    }
}

fn scalar_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// 디코드한 뒤 2칸 들여쓰기로 보기 좋게 만든다. JSON이 아니면 디코드한 텍스트를 그대로 돌려준다.
pub fn pretty(raw: &str) -> String {
    let text = decode_document(raw);
    if serde_json::from_str::<IgnoredAny>(&text).is_err() {
        return text;
    }
    reindent(&text)
}

/// 올바른 JSON 텍스트를 키 순서와 값 표기를 그대로 둔 채 다시 들여쓴다.
/// (`serde_json::Value`를 거치면 키가 알파벳순으로 바뀌어 `Version`이 `Statement` 뒤로 가 버린다.)
fn reindent(json: &str) -> String {
    fn line_break(out: &mut String, depth: usize) {
        out.push('\n');
        for _ in 0..depth {
            out.push_str("  ");
        }
    }

    let mut out = String::with_capacity(json.len() * 2);
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    let mut chars = json.chars().peekable();
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '{' | '[' => {
                out.push(c);
                while chars.next_if(|n| n.is_whitespace()).is_some() {}
                // 비어 있는 객체·배열은 한 줄로 둔다
                match chars.next_if(|n| matches!(n, '}' | ']')) {
                    Some(close) => out.push(close),
                    None => {
                        depth += 1;
                        line_break(&mut out, depth);
                    }
                }
            }
            '}' | ']' => {
                depth = depth.saturating_sub(1);
                line_break(&mut out, depth);
                out.push(c);
            }
            ',' => {
                out.push(c);
                line_break(&mut out, depth);
            }
            ':' => out.push_str(": "),
            c if c.is_whitespace() => {}
            c => out.push(c),
        }
    }
    out
}

/// `*`는 아무 글자 몇 개(0개 포함), `?`는 정확히 한 글자. 글자 단위로 비교하므로 한글 같은 멀티바이트 문자도 한 글자로 센다.
/// `case_insensitive`는 ASCII 대소문자만 무시한다(IAM 작업 이름은 ASCII).
pub fn glob(pattern: &str, text: &str, case_insensitive: bool) -> bool {
    let same = |p: char, t: char| p == t || (case_insensitive && p.eq_ignore_ascii_case(&t));
    let mut p = pattern.chars();
    let mut t = text.chars();
    // 마지막 `*` 바로 뒤의 패턴 위치와, 그 `*`가 지금까지 삼킨 텍스트 바로 뒤의 위치
    let mut retry: Option<(Chars<'_>, Chars<'_>)> = None;
    loop {
        let mut next_p = p.clone();
        match next_p.next() {
            Some('*') => {
                if next_p.as_str().is_empty() {
                    return true;
                }
                retry = Some((next_p.clone(), t.clone()));
                p = next_p;
                continue;
            }
            Some(pc) => {
                let mut next_t = t.clone();
                if let Some(tc) = next_t.next() {
                    if pc == '?' || same(pc, tc) {
                        p = next_p;
                        t = next_t;
                        continue;
                    }
                }
            }
            None => {
                if t.as_str().is_empty() {
                    return true;
                }
            }
        }
        // 맞지 않으면 마지막 `*`가 글자를 하나 더 삼키도록 되돌려 다시 맞춰 본다
        let Some((retry_p, retry_t)) = retry.as_mut() else {
            return false;
        };
        if retry_t.next().is_none() {
            return false;
        }
        p = retry_p.clone();
        t = retry_t.clone();
    }
}

/// 작업 이름 매칭: 대소문자를 무시하는 glob. `*`는 모든 작업.
pub fn action_matches(pattern: &str, action: &str) -> bool {
    glob(pattern, action, true)
}

/// 리소스 ARN 매칭: 대소문자를 구분하는 glob. `${...}` 정책 변수는 값을 알 수 없으니 `*`로 바꿔 맞춰 본다.
/// 그래도 안 맞으면 어떤 값이어도 안 맞으므로 No, 맞으면 값에 따라 달라지므로 Unknown이다.
pub fn resource_matches(pattern: &str, arn: &str) -> ResMatch {
    if pattern.contains("${") {
        return if glob(&variables_as_wildcards(pattern), arn, false) { ResMatch::Unknown } else { ResMatch::No };
    }
    if glob(pattern, arn, false) {
        ResMatch::Yes
    } else {
        ResMatch::No
    }
}

/// `${aws:username}` 같은 정책 변수를 각각 `*`로 바꾼다. 닫히지 않은 `${`는 그대로 둔다.
fn variables_as_wildcards(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len());
    let mut rest = pattern;
    while let Some(start) = rest.find("${") {
        let Some(len) = rest[start..].find('}') else { break };
        out.push_str(&rest[..start]);
        out.push('*');
        rest = &rest[start + len + 1..];
    }
    out.push_str(rest);
    out
}

/// 문장의 Resource/NotResource가 `arn`에 적용되는지. `arn`이 없으면(대상 지정 안 함) 항상 Yes,
/// Resource가 없는 문장(신뢰 정책)도 리소스로 거르지 않는다.
pub fn statement_resource_matches(s: &Statement, arn: Option<&str>) -> ResMatch {
    let Some(arn) = arn else {
        return ResMatch::Yes;
    };
    match &s.resources {
        Resources::Unspecified => ResMatch::Yes,
        Resources::Resource(patterns) => any_resource_matches(patterns, arn),
        Resources::NotResource(patterns) => match any_resource_matches(patterns, arn) {
            ResMatch::Yes => ResMatch::No,
            ResMatch::No => ResMatch::Yes,
            ResMatch::Unknown => ResMatch::Unknown,
        },
    }
}

/// 확실히 맞는 패턴이 하나라도 있으면 Yes, 없고 판단 못 하는 패턴이 있으면 Unknown, 아니면 No.
fn any_resource_matches(patterns: &[String], arn: &str) -> ResMatch {
    let mut result = ResMatch::No;
    for pattern in patterns {
        match resource_matches(pattern, arn) {
            ResMatch::Yes => return ResMatch::Yes,
            ResMatch::Unknown => result = ResMatch::Unknown,
            ResMatch::No => {}
        }
    }
    result
}

/// 문장의 Action은 하나라도 맞으면, NotAction은 하나도 안 맞아야 이 작업에 적용된다.
pub fn statement_action_matches(s: &Statement, action: &str) -> bool {
    match &s.actions {
        Actions::Action(patterns) => patterns.iter().any(|p| action_matches(p, action)),
        Actions::NotAction(patterns) => !patterns.iter().any(|p| action_matches(p, action)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ENCODED: &str = "%7B%22Version%22%3A%222012-10-17%22%2C%22Statement%22%3A%7B%22Effect%22%3A%22Allow%22%2C%22Action%22%3A%22s3%3AGetObject%22%2C%22Resource%22%3A%22*%22%7D%7D";

    fn parse(v: Value) -> PolicyDocument {
        parse_document(&v.to_string()).unwrap()
    }

    fn stmt(actions: Actions, resources: Resources) -> Statement {
        Statement {
            index: 0,
            sid: None,
            effect: Effect::Allow,
            actions,
            resources,
            principal: None,
            conditional: false,
            conditions: Vec::new(),
        }
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    // ---- glob ----

    #[test]
    fn glob_basics() {
        assert!(glob("s3:Get*", "s3:GetObject", true));
        assert!(glob("s3:?etObject", "s3:GetObject", true));
        assert!(!glob("s3:Put*", "s3:GetObject", true));
        assert!(glob("*", "anything", false));
        assert!(glob("", "", false));
        assert!(!glob("", "a", false));
        assert!(!glob("a", "", false));
        assert!(glob("exact", "exact", false));
        assert!(!glob("exact", "exacts", false));
    }

    #[test]
    fn glob_case_sensitivity_is_a_flag() {
        assert!(glob("S3:GET*", "s3:GetObject", true));
        assert!(!glob("S3:GET*", "s3:GetObject", false));
        assert!(!glob("arn:aws:s3:::Bucket", "arn:aws:s3:::bucket", false));
        assert!(glob("arn:aws:s3:::Bucket", "arn:aws:s3:::bucket", true));
    }

    #[test]
    fn glob_star_backtracks() {
        assert!(glob("a*b*c", "aXXbYYc", false));
        assert!(!glob("a*b*c", "aXXbYY", false));
        assert!(glob("*a", "ba", false));
        assert!(!glob("*a", "bab", false));
        assert!(glob("*aab", "aaab", false));
        assert!(glob("a*a*a", "aaa", false));
        assert!(!glob("a*a*a", "aa", false));
        assert!(glob("*ab*ab", "abab", false));
        assert!(glob("**", "", false));
        assert!(glob("a**b", "ab", false));
        assert!(glob("arn:aws:s3:::*/*", "arn:aws:s3:::bucket/a/b/c.txt", false));
        assert!(!glob("arn:aws:s3:::*/*", "arn:aws:s3:::bucket", false));
    }

    #[test]
    fn glob_question_mark_matches_one_character_not_one_byte() {
        assert!(glob("?", "a", false));
        assert!(!glob("?", "", false));
        assert!(!glob("?", "ab", false));
        assert!(glob("?", "한", false));
        assert!(!glob("??", "한", false));
        assert!(glob("a?c", "a한c", false));
        assert!(glob("*한", "가나한", false));
        assert!(!glob("*??", "한", false));
        assert!(glob("arn:aws:s3:::b/?.txt", "arn:aws:s3:::b/가.txt", false));
    }

    #[test]
    fn action_matches_uses_case_insensitive_glob() {
        assert!(action_matches("s3:Get*", "s3:GetObject"));
        assert!(action_matches("S3:get*", "s3:GetObject"));
        assert!(action_matches("*", "s3:GetObject"));
        assert!(action_matches("*:*", "s3:GetObject"));
        assert!(action_matches("s3:GetObject", "S3:GETOBJECT"));
        assert!(!action_matches("s3:Put*", "s3:GetObject"));
        assert!(!action_matches("iam:*", "s3:GetObject"));
    }

    // ---- resources ----

    #[test]
    fn resource_matching() {
        assert_eq!(resource_matches("arn:aws:s3:::prod-*/*", "arn:aws:s3:::prod-assets/a.txt"), ResMatch::Yes);
        assert_eq!(resource_matches("arn:aws:s3:::prod-*/*", "arn:aws:s3:::dev-assets/a.txt"), ResMatch::No);
        assert_eq!(resource_matches("*", "arn:aws:s3:::anything"), ResMatch::Yes);
        assert_eq!(resource_matches("arn:aws:s3:::bucket/?", "arn:aws:s3:::bucket/x"), ResMatch::Yes);
    }

    #[test]
    fn resource_matching_is_case_sensitive() {
        assert_eq!(resource_matches("arn:aws:s3:::Bucket", "arn:aws:s3:::bucket"), ResMatch::No);
        assert_eq!(resource_matches("arn:aws:s3:::bucket", "arn:aws:s3:::bucket"), ResMatch::Yes);
    }

    #[test]
    fn resource_with_policy_variable_is_unknown_only_when_the_rest_can_match() {
        let var = "arn:aws:s3:::${aws:username}/*";
        assert_eq!(resource_matches(var, "arn:aws:s3:::alice/a.txt"), ResMatch::Unknown);
        // 변수를 무엇으로 바꿔도 변수 밖의 글자가 다르면 맞을 수 없다
        assert_eq!(resource_matches(var, "arn:aws:ec2:::x"), ResMatch::No);
        assert_eq!(resource_matches("home/${aws:username}/*", "payroll/x"), ResMatch::No);
        assert_eq!(resource_matches("home/${aws:username}/*", "home/alice/x"), ResMatch::Unknown);
        // 변수가 여러 개여도 같다
        assert_eq!(resource_matches("a/${aws:userid}-${aws:username}/z", "a/1-bob/z"), ResMatch::Unknown);
        assert_eq!(resource_matches("a/${aws:userid}-${aws:username}/z", "a/1-bob/y"), ResMatch::No);
        // 대소문자는 구분한다
        assert_eq!(resource_matches("Home/${aws:username}", "home/alice"), ResMatch::No);
        // 닫히지 않은 `${`는 변수로 보지 않고 글자 그대로 맞춘다
        assert_eq!(resource_matches("a/${unclosed", "a/x"), ResMatch::No);
    }

    #[test]
    fn variables_become_wildcards() {
        assert_eq!(variables_as_wildcards("a/${aws:username}/b"), "a/*/b");
        assert_eq!(variables_as_wildcards("${a}${b}"), "**");
        assert_eq!(variables_as_wildcards("no variables"), "no variables");
        assert_eq!(variables_as_wildcards("x${open"), "x${open");
        assert_eq!(variables_as_wildcards("${a}x${open"), "*x${open");
    }

    // ---- decode / parse ----

    #[test]
    fn decode_percent_encoded_document() {
        let decoded = decode_document(ENCODED);
        assert_eq!(decoded, r#"{"Version":"2012-10-17","Statement":{"Effect":"Allow","Action":"s3:GetObject","Resource":"*"}}"#);
        assert_eq!(decode_document("%7b%22a%22%3a1%7d"), r#"{"a":1}"#);
        assert_eq!(decode_document("%7B%22k%22%3A%22%ED%95%9C%EA%B8%80%22%7D"), r#"{"k":"한글"}"#);
    }

    #[test]
    fn decode_leaves_plain_json_alone() {
        let plain = r#"{"Resource":"arn:aws:s3:::b/%22x%7B","Sid":"100%"}"#;
        assert_eq!(decode_document(plain), plain);
        assert_eq!(decode_document("  \n{\"a\":1}"), "  \n{\"a\":1}");
        assert_eq!(decode_document(""), "");
        assert_eq!(decode_document("not json at all 100%"), "not json at all 100%");
    }

    #[test]
    fn decode_keeps_plus_and_malformed_sequences() {
        assert_eq!(decode_document("%7B%22a%22%3A%22x+y%22%7D"), r#"{"a":"x+y"}"#);
        assert_eq!(decode_document("%7B%22a%22%3A%22100%25%22%7D"), r#"{"a":"100%"}"#);
        assert_eq!(decode_document("%7B%22a%22%3A%22%ZZ%22%7D%"), r#"{"a":"%ZZ"}%"#);
        assert_eq!(decode_document("%7B%22a%22%7D%2"), r#"{"a"}%2"#);
    }

    #[test]
    fn parse_url_encoded_document() {
        let d = parse_document(ENCODED).unwrap();
        assert_eq!(d.statements.len(), 1);
        let s = &d.statements[0];
        assert_eq!(s.index, 0);
        assert_eq!(s.sid, None);
        assert_eq!(s.effect, Effect::Allow);
        assert_eq!(s.actions, Actions::Action(strings(&["s3:GetObject"])));
        assert_eq!(s.resources, Resources::Resource(strings(&["*"])));
        assert_eq!(s.principal, None);
        assert!(!s.conditional);
        assert!(s.conditions.is_empty());
    }

    #[test]
    fn statement_may_be_a_single_object_or_an_array() {
        let one = json!({"Version": "2012-10-17", "Statement": {"Effect": "Allow", "Action": "s3:GetObject", "Resource": "*"}});
        let many = json!({"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:GetObject", "Resource": "*"}]});
        assert_eq!(parse(one), parse(many));
    }

    #[test]
    fn fields_accept_string_or_array() {
        let d = parse(json!({"Statement": [
            {"Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::a/*"},
            {"Effect": "Deny", "Action": ["s3:Put*", "s3:Delete*"], "Resource": ["arn:aws:s3:::a/*", "arn:aws:s3:::b/*"]},
        ]}));
        assert_eq!(d.statements[0].actions, Actions::Action(strings(&["s3:GetObject"])));
        assert_eq!(d.statements[0].resources, Resources::Resource(strings(&["arn:aws:s3:::a/*"])));
        assert_eq!(d.statements[1].effect, Effect::Deny);
        assert_eq!(d.statements[1].actions, Actions::Action(strings(&["s3:Put*", "s3:Delete*"])));
        assert_eq!(d.statements[1].resources, Resources::Resource(strings(&["arn:aws:s3:::a/*", "arn:aws:s3:::b/*"])));
    }

    #[test]
    fn not_action_and_not_resource() {
        let d = parse(json!({"Statement": [
            {"Effect": "Allow", "NotAction": "iam:*", "Resource": "*"},
            {"Effect": "Deny", "Action": "s3:*", "NotResource": ["arn:aws:s3:::public/*"]},
            {"Effect": "Allow", "NotAction": ["iam:*", "sts:*"], "NotResource": "arn:aws:s3:::x"},
        ]}));
        assert_eq!(d.statements[0].actions, Actions::NotAction(strings(&["iam:*"])));
        assert_eq!(d.statements[1].resources, Resources::NotResource(strings(&["arn:aws:s3:::public/*"])));
        assert_eq!(d.statements[2].actions, Actions::NotAction(strings(&["iam:*", "sts:*"])));
        assert_eq!(d.statements[2].resources, Resources::NotResource(strings(&["arn:aws:s3:::x"])));
    }

    #[test]
    fn missing_resource_is_unspecified_and_principal_is_kept() {
        let d = parse(json!({"Version": "2012-10-17", "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "lambda.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }]}));
        let s = &d.statements[0];
        assert_eq!(s.resources, Resources::Unspecified);
        assert_eq!(s.principal, Some(json!({"Service": "lambda.amazonaws.com"})));
        let star = parse(json!({"Statement": [{"Effect": "Allow", "Principal": "*", "Action": "sts:AssumeRole"}]}));
        assert_eq!(star.statements[0].principal, Some(json!("*")));
    }

    #[test]
    fn condition_becomes_a_readable_line() {
        let d = parse(json!({"Statement": [{
            "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*",
            "Condition": {"IpAddress": {"aws:SourceIp": "10.0.0.0/8"}},
        }]}));
        let s = &d.statements[0];
        assert!(s.conditional);
        assert_eq!(s.conditions, vec!["aws:SourceIp · IpAddress · 10.0.0.0/8".to_string()]);
    }

    #[test]
    fn condition_lines_are_sorted_and_list_values() {
        let d = parse(json!({"Statement": [{
            "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "*",
            "Condition": {
                "StringEquals": {"sts:ExternalId": "abc", "aws:PrincipalOrgID": ["o-b", "o-a"]},
                "Bool": {"aws:MultiFactorAuthPresent": true},
                "NumericLessThan": {"aws:MultiFactorAuthAge": 3600},
            },
        }]}));
        assert_eq!(
            d.statements[0].conditions,
            vec![
                "aws:MultiFactorAuthAge · NumericLessThan · 3600".to_string(),
                "aws:MultiFactorAuthPresent · Bool · true".to_string(),
                "aws:PrincipalOrgID · StringEquals · o-b, o-a".to_string(),
                "sts:ExternalId · StringEquals · abc".to_string(),
            ]
        );
    }

    #[test]
    fn empty_condition_block_is_not_conditional() {
        let d = parse(json!({"Statement": [{"Effect": "Allow", "Action": "s3:*", "Resource": "*", "Condition": {}}]}));
        assert!(!d.statements[0].conditional);
        assert!(d.statements[0].conditions.is_empty());
    }

    #[test]
    fn statement_index_and_sid_follow_document_order() {
        let d = parse(json!({"Statement": [
            {"Sid": "First", "Effect": "Allow", "Action": "a:A", "Resource": "*"},
            {"Effect": "Deny", "Action": "b:B", "Resource": "*"},
            {"Sid": "Third", "Effect": "Allow", "Action": "c:C", "Resource": "*"},
        ]}));
        let seen: Vec<(usize, Option<&str>)> = d.statements.iter().map(|s| (s.index, s.sid.as_deref())).collect();
        assert_eq!(seen, vec![(0, Some("First")), (1, None), (2, Some("Third"))]);
    }

    #[test]
    fn invalid_documents_are_errors_with_a_message() {
        let bad = [
            "",
            "{not json",
            "[]",
            "\"text\"",
            "{}",
            r#"{"Statement": 5}"#,
            r#"{"Statement": [5]}"#,
            r#"{"Statement": [{"Action": "s3:*", "Resource": "*"}]}"#,
            r#"{"Statement": [{"Effect": "allow", "Action": "s3:*", "Resource": "*"}]}"#,
            r#"{"Statement": [{"Effect": "Allow", "Resource": "*"}]}"#,
            r#"{"Statement": [{"Effect": "Allow", "Action": "s3:*", "NotAction": "iam:*", "Resource": "*"}]}"#,
            r#"{"Statement": [{"Effect": "Allow", "Action": "s3:*", "Resource": "*", "NotResource": "x"}]}"#,
            r#"{"Statement": [{"Effect": "Allow", "Action": 5, "Resource": "*"}]}"#,
            r#"{"Statement": [{"Effect": "Allow", "Action": ["s3:*", 5], "Resource": "*"}]}"#,
            r#"{"Statement": [{"Effect": "Allow", "Action": "s3:*", "Resource": "*", "Condition": "x"}]}"#,
            r#"{"Statement": [{"Effect": "Allow", "Action": "s3:*", "Resource": "*", "Condition": {"StringEquals": "x"}}]}"#,
        ];
        for raw in bad {
            let err = parse_document(raw).expect_err(raw);
            assert!(!err.is_empty(), "empty message for {raw}");
        }
    }

    #[test]
    fn error_message_names_the_statement() {
        let err = parse_document(r#"{"Statement": [{"Effect":"Allow","Action":"a:A","Resource":"*"}, {"Effect":"Maybe","Action":"a:A","Resource":"*"}]}"#).unwrap_err();
        assert!(err.contains("2번째"), "{err}");
    }

    // ---- pretty ----

    #[test]
    fn pretty_decodes_and_keeps_key_order() {
        let raw = r#"{"Version":"2012-10-17","Statement":[{"Sid":"x","Effect":"Allow","Action":["a:B","c:D"],"Resource":"*"}]}"#;
        let expected = "{\n  \"Version\": \"2012-10-17\",\n  \"Statement\": [\n    {\n      \"Sid\": \"x\",\n      \"Effect\": \"Allow\",\n      \"Action\": [\n        \"a:B\",\n        \"c:D\"\n      ],\n      \"Resource\": \"*\"\n    }\n  ]\n}";
        assert_eq!(pretty(raw), expected);
        let encoded: String = raw
            .bytes()
            .map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") })
            .collect();
        assert_eq!(pretty(&encoded), expected);
    }

    #[test]
    fn pretty_matches_serde_for_sorted_documents() {
        // 키가 이미 알파벳순이면 serde_json의 pretty 출력과 같아야 한다 (공백만 다른 입력)
        let raw = "{ \"A\" : [ { \"Action\" : \"s3:GetObject\" , \"Effect\":\"Allow\",\"Resource\":[\"*\"] } ] ,\n \"B\":1,\"C\":true,\"D\":null,\"E\":{},\"F\":[] }";
        let value: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(pretty(raw), serde_json::to_string_pretty(&value).unwrap());
    }

    #[test]
    fn pretty_handles_empty_containers_and_tricky_strings() {
        assert_eq!(pretty(r#"{"a":{},"b":[],"c":[ ],"d":{ }}"#), "{\n  \"a\": {},\n  \"b\": [],\n  \"c\": [],\n  \"d\": {}\n}");
        assert_eq!(pretty("[1,[2,3],{}]"), "[\n  1,\n  [\n    2,\n    3\n  ],\n  {}\n]");
        // 문자열 안의 괄호·쉼표·콜론·이스케이프는 건드리지 않는다
        let tricky = r#"{"k":"a,b:{c}[d] \"q\" \\ é 한"}"#;
        let expected = r#"{
  "k": "a,b:{c}[d] \"q\" \\ é 한"
}"#;
        assert_eq!(pretty(tricky), expected);
        // 숫자는 원문 그대로 둔다
        assert_eq!(pretty(r#"{"n":1.0,"e":1e3}"#), "{\n  \"n\": 1.0,\n  \"e\": 1e3\n}");
    }

    #[test]
    fn pretty_output_parses_back_to_the_same_value() {
        let raw = r#"{"Statement":[{"Effect":"Allow","Action":["s3:Get*"],"Resource":"arn:aws:s3:::b/${aws:username}/*","Condition":{"StringLike":{"s3:prefix":["a/","b/"]}}}],"Version":"2012-10-17"}"#;
        let a: Value = serde_json::from_str(raw).unwrap();
        let b: Value = serde_json::from_str(&pretty(raw)).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn pretty_falls_back_to_the_decoded_text() {
        assert_eq!(pretty("not json"), "not json");
        assert_eq!(pretty("%7Bbroken"), "{broken");
        assert_eq!(pretty(""), "");
    }

    // ---- statement matching ----

    #[test]
    fn statement_action_matching() {
        let allow = stmt(Actions::Action(strings(&["s3:Get*", "ec2:DescribeInstances"])), Resources::Resource(strings(&["*"])));
        assert!(statement_action_matches(&allow, "s3:GetObject"));
        assert!(statement_action_matches(&allow, "S3:getobject"));
        assert!(statement_action_matches(&allow, "ec2:DescribeInstances"));
        assert!(!statement_action_matches(&allow, "s3:PutObject"));
        assert!(!statement_action_matches(&stmt(Actions::Action(Vec::new()), Resources::Unspecified), "s3:GetObject"));
    }

    #[test]
    fn statement_not_action_matching() {
        let not_iam = stmt(Actions::NotAction(strings(&["iam:*", "sts:Assume*"])), Resources::Resource(strings(&["*"])));
        assert!(statement_action_matches(&not_iam, "s3:GetObject"));
        assert!(!statement_action_matches(&not_iam, "iam:GetUser"));
        assert!(!statement_action_matches(&not_iam, "IAM:getuser"));
        assert!(!statement_action_matches(&not_iam, "sts:AssumeRole"));
        assert!(statement_action_matches(&not_iam, "sts:GetCallerIdentity"));
        assert!(statement_action_matches(&stmt(Actions::NotAction(Vec::new()), Resources::Unspecified), "s3:GetObject"));
    }

    #[test]
    fn statement_resource_matching() {
        let s = stmt(Actions::Action(strings(&["s3:*"])), Resources::Resource(strings(&["arn:aws:s3:::a/*", "arn:aws:s3:::b/*"])));
        assert_eq!(statement_resource_matches(&s, Some("arn:aws:s3:::b/x")), ResMatch::Yes);
        assert_eq!(statement_resource_matches(&s, Some("arn:aws:s3:::c/x")), ResMatch::No);
        assert_eq!(statement_resource_matches(&s, None), ResMatch::Yes);
        let empty = stmt(Actions::Action(strings(&["s3:*"])), Resources::Resource(Vec::new()));
        assert_eq!(statement_resource_matches(&empty, Some("arn:aws:s3:::a/x")), ResMatch::No);
        assert_eq!(statement_resource_matches(&empty, None), ResMatch::Yes);
    }

    #[test]
    fn statement_not_resource_matching() {
        let s = stmt(Actions::Action(strings(&["s3:*"])), Resources::NotResource(strings(&["arn:aws:s3:::secret/*"])));
        assert_eq!(statement_resource_matches(&s, Some("arn:aws:s3:::secret/x")), ResMatch::No);
        assert_eq!(statement_resource_matches(&s, Some("arn:aws:s3:::open/x")), ResMatch::Yes);
        assert_eq!(statement_resource_matches(&s, None), ResMatch::Yes);
        let none = stmt(Actions::Action(strings(&["s3:*"])), Resources::NotResource(Vec::new()));
        assert_eq!(statement_resource_matches(&none, Some("arn:aws:s3:::a/x")), ResMatch::Yes);
    }

    #[test]
    fn statement_resource_with_policy_variable() {
        let var = "arn:aws:s3:::${aws:username}/*";
        let only = stmt(Actions::Action(strings(&["s3:*"])), Resources::Resource(strings(&[var])));
        assert_eq!(statement_resource_matches(&only, Some("arn:aws:s3:::alice/x")), ResMatch::Unknown);
        assert_eq!(statement_resource_matches(&only, None), ResMatch::Yes);
        // 확실히 맞는 패턴이 하나라도 있으면 Yes, 맞는 게 없고 변수 패턴만 있으면 Unknown
        let both = stmt(Actions::Action(strings(&["s3:*"])), Resources::Resource(strings(&[var, "arn:aws:s3:::open/*"])));
        assert_eq!(statement_resource_matches(&both, Some("arn:aws:s3:::open/x")), ResMatch::Yes);
        assert_eq!(statement_resource_matches(&both, Some("arn:aws:s3:::alice/x")), ResMatch::Unknown);
        let not = stmt(Actions::Action(strings(&["s3:*"])), Resources::NotResource(strings(&[var, "arn:aws:s3:::secret/*"])));
        assert_eq!(statement_resource_matches(&not, Some("arn:aws:s3:::secret/x")), ResMatch::No);
        assert_eq!(statement_resource_matches(&not, Some("arn:aws:s3:::alice/x")), ResMatch::Unknown);
    }

    #[test]
    fn unspecified_resource_applies_everywhere() {
        let s = stmt(Actions::Action(strings(&["sts:AssumeRole"])), Resources::Unspecified);
        assert_eq!(statement_resource_matches(&s, Some("arn:aws:s3:::any")), ResMatch::Yes);
        assert_eq!(statement_resource_matches(&s, None), ResMatch::Yes);
    }
}
