//! 줄인 정책 초안. 지금 정책 대신 써도 지금보다 넓게 허용하지 않게 만든다:
//! - 최근에 쓴 서비스에서, 지금 조건 없이 허용된(`allowed`) 작업만, 조건 없는 Allow 문장에서만 가져온다.
//!   조건부로만 허용된 작업은 빼고 안내에 적는다. 리소스는 원래 문장 그대로다.
//! - 작업 단위 기록이 있으면 AWS가 기록했는데 최근에 안 쓴 작업만 뺀다. 기록하지 않는 작업(데이터 작업 등)은 남긴다.
//! - 와일드카드(`s3:*`, `s3:Get*`)는 원래 문장이 그 와일드카드를 덮을 때만 쓴다(카탈로그에 없는 새 작업까지 넓어지지 않게).
//! - 남긴 작업에 걸리는 신원 정책의 거부(Deny) 문장을 원문 그대로 옮긴다(권한 경계는 주체에 그대로 남는다).

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::Value;

use super::{Usage, Use};
use crate::iam::catalog::catalog;
use crate::iam::eval::{find_principal, statement_actions, PrincipalEval, Source, Status};
use crate::iam::findings::STALE_DAYS;
use crate::iam::model::Snapshot;
use crate::iam::policy::{action_matches, decode_document, Actions, Effect, Resources, Statement};
use crate::iam::text::shortened;

/// 안내에 작업·서비스 이름을 이 개수까지만 적고 나머지는 "외 N개"로 줄인다.
const SHOWN_NAMES: usize = 10;

const NOTE_CONDITION_STATEMENTS: &str = "조건이 걸린 허용 문장은 초안에 옮기지 않았어요";
const NOTE_NO_ACTION_LEVEL: &str = "작업 단위 기록이 없는 서비스는 지금 허용된 작업을 그대로 남겼어요";
const NOTE_DENY_UNCOPIED: &str = "거부(Deny) 문장을 원문 그대로 옮기지 못해서 초안을 만들지 않았어요";

/// 작업 이름의 첫 단어: 첫 글자부터 다음 대문자 앞까지. `GetObject` → `Get`.
pub(super) fn verb(name: &str) -> &str {
    let mut chars = name.char_indices();
    chars.next();
    match chars.find(|(_, c)| c.is_ascii_uppercase()) {
        Some((i, _)) => &name[..i],
        None => name,
    }
}

/// 서비스 하나에서 고른 작업을 정책에 쓸 패턴으로 줄인다. 서비스 전체면 `s3:*`, 첫 단어가 같은 작업을 카탈로그에서 전부 골랐으면
/// `s3:Get*`, 아니면 작업 이름 그대로다. 와일드카드는 `covered`가 참일 때만 쓴다(카탈로그 밖의 작업까지 덮어도 되는 경우).
pub(super) fn compress(prefix: &str, chosen: &BTreeSet<String>, covered: impl Fn(&str) -> bool) -> Vec<String> {
    let all = catalog().actions(prefix);
    let whole = format!("{prefix}:*");
    if !all.is_empty() && chosen.len() == all.len() && covered(&whole) {
        return vec![whole];
    }
    let mut out = Vec::new();
    let mut wildcards: Vec<&str> = Vec::new();
    for name in chosen {
        if wildcards.iter().any(|w| name.starts_with(w)) {
            continue;
        }
        let first = verb(name);
        let total = all.iter().filter(|(n, _)| n.starts_with(first)).count();
        let picked = chosen.iter().filter(|n| n.starts_with(first)).count();
        let pattern = format!("{prefix}:{first}*");
        if total >= 2 && picked == total && covered(&pattern) {
            wildcards.push(first);
            out.push(pattern);
        } else {
            out.push(format!("{prefix}:{name}"));
        }
    }
    out
}

/// 원래 Allow 문장이 와일드카드(`s3:Get*`, `s3:*`)에 맞는 작업을 카탈로그에 없는 것까지 모두 허용하는지.
fn statement_covers(stmt: &Statement, wildcard: &str) -> bool {
    let stem = wildcard.strip_suffix('*').unwrap_or(wildcard);
    match &stmt.actions {
        // `…*`로 끝나는 패턴이 `s3:Get`에 맞으면 `s3:Get`으로 시작하는 모든 이름에도 맞는다
        Actions::Action(patterns) => patterns.iter().any(|p| p.ends_with('*') && action_matches(p, stem)),
        // 빼는 목록이 모두 다른 서비스(와일드카드 없는 접두어)를 가리키면 이 서비스의 작업은 모두 들어간다
        Actions::NotAction(excluded) => {
            let service = stem.split(':').next().unwrap_or_default();
            excluded.iter().all(|p| p.split_once(':').is_some_and(|(svc, _)| !svc.contains(['*', '?']) && !svc.eq_ignore_ascii_case(service)))
        }
    }
}

/// 문장의 리소스 조건. 조건이 같은 작업은 초안에서 한 문장으로 묶는다.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum ResKey {
    Resource(Vec<String>),
    NotResource(Vec<String>),
}

fn res_key(stmt: &Statement) -> ResKey {
    let sorted = |patterns: &[String]| {
        let mut patterns = patterns.to_vec();
        patterns.sort();
        patterns.dedup();
        patterns
    };
    match &stmt.resources {
        Resources::Resource(patterns) => ResKey::Resource(sorted(patterns)),
        Resources::NotResource(patterns) => ResKey::NotResource(sorted(patterns)),
        Resources::Unspecified => ResKey::Resource(vec!["*".to_string()]),
    }
}

#[derive(Serialize)]
#[serde(untagged)]
enum OneOrMany {
    One(String),
    Many(Vec<String>),
}

impl OneOrMany {
    fn of(mut list: Vec<String>) -> OneOrMany {
        if list.len() == 1 {
            OneOrMany::One(list.remove(0))
        } else {
            OneOrMany::Many(list)
        }
    }
}

#[derive(Serialize)]
struct AllowStatement {
    #[serde(rename = "Effect")]
    effect: &'static str,
    #[serde(rename = "Action")]
    action: Vec<String>,
    #[serde(rename = "Resource", skip_serializing_if = "Option::is_none")]
    resource: Option<OneOrMany>,
    #[serde(rename = "NotResource", skip_serializing_if = "Option::is_none")]
    not_resource: Option<OneOrMany>,
}

/// 원문에서 그대로 옮긴 거부 문장. Sid는 초안 안에서 겹칠 수 있어 옮기지 않는다.
#[derive(Clone, Debug, PartialEq, Serialize)]
struct DenyStatement {
    #[serde(rename = "Effect")]
    effect: &'static str,
    #[serde(rename = "Action", skip_serializing_if = "Option::is_none")]
    action: Option<Value>,
    #[serde(rename = "NotAction", skip_serializing_if = "Option::is_none")]
    not_action: Option<Value>,
    #[serde(rename = "Resource", skip_serializing_if = "Option::is_none")]
    resource: Option<Value>,
    #[serde(rename = "NotResource", skip_serializing_if = "Option::is_none")]
    not_resource: Option<Value>,
    #[serde(rename = "Condition", skip_serializing_if = "Option::is_none")]
    condition: Option<Value>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum DraftStatement {
    Allow(AllowStatement),
    Deny(DenyStatement),
}

#[derive(Serialize)]
struct DraftDocument {
    #[serde(rename = "Version")]
    version: &'static str,
    #[serde(rename = "Statement")]
    statement: Vec<DraftStatement>,
}

/// 초안에 넣을 작업을 고른 결과.
#[derive(Default)]
struct Picked<'a> {
    /// 리소스 조건 → 서비스 → 작업
    groups: BTreeMap<ResKey, BTreeMap<String, BTreeSet<String>>>,
    /// 리소스 조건 → 그 조건을 가진 조건 없는 Allow 문장들. 와일드카드로 줄여 써도 되는지 볼 때 쓴다
    statements: BTreeMap<ResKey, Vec<&'a Statement>>,
    /// 넣은 작업 (접두어, 작업)
    kept: BTreeSet<(String, String)>,
    /// 조건부로만 허용돼 뺀 작업: 접두어 → 작업
    conditional: BTreeMap<String, BTreeSet<String>>,
    /// 조건이 걸린 Allow 문장을 옮기지 않았다(그 작업이 다른 문장으로 조건 없이 허용돼 초안에 들어갔어도)
    skipped_conditions: bool,
    /// 작업 단위 기록에서 최근에 안 쓴 작업을 뺀 서비스 이름
    narrowed: BTreeSet<String>,
    /// 작업 단위 기록이 없는 서비스를 지금 허용된 그대로 남겼다
    kept_untracked: bool,
    /// 오래 안 써서 뺀 서비스 이름
    stale: BTreeSet<String>,
}

fn pick<'a>(eval: &PrincipalEval, sources: &[Source<'a>], usage: &Usage) -> Picked<'a> {
    let mut p = Picked::default();
    for doc in sources.iter().filter_map(|src| src.document) {
        for stmt in doc.statements.iter().filter(|st| st.effect == Effect::Allow) {
            let key = res_key(stmt);
            if !stmt.conditional {
                p.statements.entry(key.clone()).or_default().push(stmt);
            }
            for (prefix, action, _) in statement_actions(stmt).0 {
                let status = eval.actions.get(&(prefix.clone(), action.clone())).map(|(_, result)| result.status);
                let Some(tracked) = usage.recent.get(&prefix) else {
                    if let (Some(Status::Allowed), Some((name, Use::Stale(_)))) = (status, usage.reported.get(&prefix)) {
                        p.stale.insert(name.clone());
                    }
                    continue;
                };
                // AWS가 기록했는데 최근에 안 쓴 작업만 뺀다. 기록에 없는 작업은 쓰는지 모르니 남긴다
                if tracked.actions.get(&action.to_ascii_lowercase()) == Some(&false) {
                    if status == Some(Status::Allowed) {
                        p.narrowed.insert(tracked.name.clone());
                    }
                    continue;
                }
                match status {
                    Some(Status::Allowed) if !stmt.conditional => {
                        if tracked.actions.is_empty() {
                            p.kept_untracked = true;
                        }
                        p.groups.entry(key.clone()).or_default().entry(prefix.clone()).or_default().insert(action.clone());
                        p.kept.insert((prefix, action));
                    }
                    Some(Status::Allowed) => p.skipped_conditions = true,
                    Some(Status::Conditional) => {
                        p.conditional.entry(prefix).or_default().insert(action);
                    }
                    // 거부·경계 차단은 지금도 못 하는 작업이다
                    _ => {}
                }
            }
        }
    }
    p
}

fn allow_statements(p: &Picked) -> Vec<AllowStatement> {
    p.groups
        .iter()
        .map(|(key, services)| {
            let originals = p.statements.get(key).map(Vec::as_slice).unwrap_or_default();
            let covered = |wildcard: &str| originals.iter().any(|stmt| statement_covers(stmt, wildcard));
            let action = services.iter().flat_map(|(prefix, chosen)| compress(prefix, chosen, covered)).collect();
            let (resource, not_resource) = match key {
                ResKey::Resource(list) => (Some(OneOrMany::of(list.clone())), None),
                ResKey::NotResource(list) => (None, Some(OneOrMany::of(list.clone()))),
            };
            AllowStatement { effect: "Allow", action, resource, not_resource }
        })
        .collect()
}

/// 정책 출처의 문서 원문(JSON). 관리형은 스냅숏의 정책에서, 인라인은 그 정책을 가진 사용자·그룹·역할에서 찾는다.
fn raw_document(s: &Snapshot, src: &Source) -> Option<Value> {
    let raw = match src.id.strip_prefix("inline:") {
        // 소유자 ARN에도 콜론이 있으니 이름은 마지막 콜론 뒤다
        Some(rest) => {
            let (owner, name) = rest.rsplit_once(':')?;
            find_principal(s, owner)?.inline().iter().find(|p| p.name == name)?.raw.clone()
        }
        None => s.policies.get(&src.id)?.raw.clone()?,
    };
    serde_json::from_str(&decode_document(&raw)).ok()
}

/// 문서의 `index`번째 문장 원문. `Statement`가 객체 하나면 그것이 0번이다.
fn raw_statement(doc: &Value, index: usize) -> Option<&Value> {
    match doc.get("Statement")? {
        Value::Array(items) => items.get(index),
        one @ Value::Object(_) if index == 0 => Some(one),
        _ => None,
    }
}

fn verbatim_deny(stmt: &Value) -> Option<DenyStatement> {
    let obj = stmt.as_object()?;
    if obj.get("Effect")?.as_str()? != "Deny" {
        return None;
    }
    let field = |key: &str| obj.get(key).cloned();
    Some(DenyStatement {
        effect: "Deny",
        action: field("Action"),
        not_action: field("NotAction"),
        resource: field("Resource"),
        not_resource: field("NotResource"),
        condition: field("Condition"),
    })
}

/// 이 거부 문장을 초안에 옮겨야 하는지: 초안에 넣은 작업에 걸리거나, 초안이 와일드카드로 연 서비스에서
/// 카탈로그에 없는 작업을 막을 수 있다(NotAction이거나, 카탈로그에 없는 작업 패턴이 그 서비스를 가리킨다).
fn deny_applies(stmt: &Statement, kept: &BTreeSet<(String, String)>, wildcard_services: &BTreeSet<String>) -> bool {
    let (found, unmatched) = statement_actions(stmt);
    if found.iter().any(|(prefix, action, _)| kept.contains(&(prefix.clone(), action.clone()))) {
        return true;
    }
    if wildcard_services.is_empty() {
        return false;
    }
    matches!(stmt.actions, Actions::NotAction(_))
        || unmatched.iter().any(|pattern| wildcard_services.iter().any(|svc| pattern.split_once(':').is_some_and(|(p, _)| action_matches(p, svc))))
}

/// 초안에 옮길 거부 문장(신원 정책의 것, 원문 그대로, 중복 없이). 옮겨야 하는 문장의 원문을 하나라도 찾지 못하면 None.
fn copied_denies(s: &Snapshot, sources: &[Source], kept: &BTreeSet<(String, String)>, wildcard_services: &BTreeSet<String>) -> Option<Vec<DenyStatement>> {
    let mut out: Vec<DenyStatement> = Vec::new();
    for src in sources {
        let Some(doc) = src.document else { continue };
        let mut raw: Option<Value> = None;
        for stmt in doc.statements.iter().filter(|st| st.effect == Effect::Deny) {
            if !deny_applies(stmt, kept, wildcard_services) {
                continue;
            }
            if raw.is_none() {
                raw = Some(raw_document(s, src)?);
            }
            let copied = verbatim_deny(raw_statement(raw.as_ref()?, stmt.index)?)?;
            if !out.contains(&copied) {
                out.push(copied);
            }
        }
    }
    Some(out)
}

/// 고른 결과에 대한 안내(초안을 만들었든 아니든).
fn pick_notes(p: &Picked) -> Vec<String> {
    let mut notes = Vec::new();
    if !p.conditional.is_empty() {
        let names: Vec<String> = p.conditional.iter().flat_map(|(prefix, actions)| compress(prefix, actions, |_| true)).collect();
        notes.push(format!("조건부로만 허용된 작업은 초안에서 뺐어요: {}", shortened(&names, SHOWN_NAMES)));
    }
    if p.skipped_conditions {
        notes.push(NOTE_CONDITION_STATEMENTS.to_string());
    }
    if !p.stale.is_empty() {
        let names: Vec<String> = p.stale.iter().cloned().collect();
        notes.push(format!("마지막 사용이 {STALE_DAYS}일 넘게 지난 서비스는 안 쓰는 것으로 보고 초안에서 뺐어요: {}", shortened(&names, SHOWN_NAMES)));
    }
    if !p.narrowed.is_empty() {
        let names = p.narrowed.iter().cloned().collect::<Vec<_>>().join(", ");
        notes.push(format!(
            "{names}: 작업 단위 기록에서 최근에 안 쓴 것으로 나온 작업만 뺐어요. AWS가 기록하지 않는 작업(객체 읽기·쓰기 같은 데이터 작업)은 그대로 남겼어요"
        ));
    }
    if p.kept_untracked {
        notes.push(NOTE_NO_ACTION_LEVEL.to_string());
    }
    notes
}

/// 줄인 정책 초안(JSON)과 안내. 넣을 작업이 없거나 옮겨야 할 거부 문장을 원문 그대로 옮기지 못하면 초안은 None이다.
pub(super) fn draft(eval: &PrincipalEval, sources: &[Source], usage: &Usage, s: &Snapshot) -> (Option<String>, Vec<String>) {
    let picked = pick(eval, sources, usage);
    let mut notes = pick_notes(&picked);
    if picked.groups.is_empty() {
        notes.insert(0, format!("최근 {STALE_DAYS}일 안에 쓴 서비스에 조건 없이 허용된 작업이 없어서 초안을 만들지 않았어요"));
        return (None, notes);
    }
    let allows = allow_statements(&picked);
    let wildcard_services: BTreeSet<String> = allows
        .iter()
        .flat_map(|st| st.action.iter())
        .filter(|pattern| pattern.ends_with('*'))
        .filter_map(|pattern| pattern.split_once(':').map(|(svc, _)| svc.to_string()))
        .collect();
    let Some(denies) = copied_denies(s, sources, &picked.kept, &wildcard_services) else {
        notes.push(NOTE_DENY_UNCOPIED.to_string());
        return (None, notes);
    };
    if !denies.is_empty() {
        notes.push(format!("지금 걸려 있는 거부(Deny) 문장 {}개를 초안에 그대로 옮겼어요. 초안으로 바꿔 써도 지금 막힌 작업은 계속 막혀요", denies.len()));
    }
    let statement = allows.into_iter().map(DraftStatement::Allow).chain(denies.into_iter().map(DraftStatement::Deny)).collect();
    (serde_json::to_string(&DraftDocument { version: "2012-10-17", statement }).ok(), notes)
}
