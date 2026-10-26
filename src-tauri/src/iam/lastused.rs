//! 권한 줄이기: AWS가 기록한 서비스별 마지막 사용 시각으로 안 쓰는 정책을 찾고, 쓴 서비스만 남긴 정책 초안을 만든다. 순수 코드다.
//! 사용 기록을 가져오는 AWS 호출은 `fetch::usage`에 있다.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use super::catalog::catalog;
use super::clock::iso;
use super::eval::{policy_sources, statement_actions, PrincipalEval, Source, Status};
use super::model::Snapshot;
use super::policy::{Effect, PolicyDocument, Resources, Statement};
use super::text::shortened;

/// AWS가 서비스 사용 기록을 남기는 기간(일).
pub const TRACKING_DAYS: u32 = 400;

/// 이유에 서비스 이름을 이 개수까지만 적는다.
const SHOWN_SERVICES: usize = 3;

const NOTE_CONDITIONS: &str = "조건(Condition)은 초안에 넣지 않았어요";
const NOTE_NO_ACTION_LEVEL: &str = "작업 단위 기록이 없는 서비스는 지금 허용된 작업을 그대로 남겼어요";
const NOTE_NO_DRAFT: &str = "사용 기록이 있는 서비스에 허용된 작업이 없어서 초안을 만들지 않았어요";

/// `GetServiceLastAccessedDetails`에서 필요한 값만 옮긴 것. 시각은 유닉스 초다.
#[derive(Clone, Debug, Default)]
pub struct LastAccessedRaw {
    pub completed_at: Option<i64>,
    pub services: Vec<RawService>,
}

#[derive(Clone, Debug, Default)]
pub struct RawService {
    /// 서비스 접두어(`s3`)
    pub prefix: String,
    pub name: String,
    /// 기록 기간 안에 쓴 적이 없으면 None
    pub last_used: Option<i64>,
    /// 작업 단위 기록. 이 서비스가 작업 단위 기록을 지원하지 않거나 기록이 없으면 None
    pub actions: Option<Vec<RawAction>>,
}

#[derive(Clone, Debug)]
pub struct RawAction {
    /// 접두어 없는 작업 이름(`GetObject`)
    pub name: String,
    pub last_used: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnusedPolicy {
    /// 관리형은 ARN, 인라인은 `inline:<소유자 ARN>:<이름>`
    pub policy_id: String,
    /// 정책 이름만(인라인도 인라인 이름만)
    pub name: String,
    /// 그룹에서 상속받았으면 그룹 이름. 그 정책은 그룹에서 떼야 한다
    pub via: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastAction {
    /// `s3:GetObject`
    pub action: String,
    pub last_used: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastService {
    pub prefix: String,
    pub name: String,
    pub last_used: Option<String>,
    pub actions: Option<Vec<LastAction>>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastAccessed {
    pub completed_at: Option<String>,
    pub tracking_days: u32,
    pub services: Vec<LastService>,
    pub unused_policies: Vec<UnusedPolicy>,
    /// 줄인 정책 초안(JSON 문서). 만들 수 없으면 None
    pub draft: Option<String>,
    pub draft_notes: Vec<String>,
}

/// AWS가 알려 준 서비스와 그중 쓴 서비스.
struct Usage {
    /// 접두어(소문자) → 서비스 이름. AWS가 알려 준 서비스 전부
    reported: BTreeMap<String, String>,
    used: BTreeMap<String, UsedService>,
}

struct UsedService {
    name: String,
    /// 쓴 기록이 있는 작업(소문자). 작업 단위 기록이 없거나 쓴 작업이 하나도 없으면 None
    actions: Option<BTreeSet<String>>,
}

impl Usage {
    fn new(la: &LastAccessedRaw) -> Usage {
        let mut usage = Usage { reported: BTreeMap::new(), used: BTreeMap::new() };
        for service in &la.services {
            let prefix = service.prefix.to_ascii_lowercase();
            usage.reported.insert(prefix.clone(), service.name.clone());
            if service.last_used.is_some() {
                let tracked: BTreeSet<String> =
                    service.actions.iter().flatten().filter(|a| a.last_used.is_some()).map(|a| a.name.to_ascii_lowercase()).collect();
                usage.used.insert(prefix, UsedService { name: service.name.clone(), actions: (!tracked.is_empty()).then_some(tracked) });
            }
        }
        usage
    }

    /// AWS가 알려 줬고 기록 기간 안에 쓴 적이 없다. 알려 주지 않은 서비스는 모르는 것이라 안 쓴 것으로 치지 않는다.
    fn is_unused(&self, prefix: &str) -> bool {
        self.reported.contains_key(prefix) && !self.used.contains_key(prefix)
    }
}

/// Allow 문장이 여는 서비스. 카탈로그에 없는 작업이 있으면 어떤 서비스를 여는지 알 수 없어서 None이다.
fn allowed_services(doc: &PolicyDocument) -> Option<BTreeSet<String>> {
    let mut services = BTreeSet::new();
    for stmt in doc.statements.iter().filter(|st| st.effect == Effect::Allow) {
        let (found, unmatched) = statement_actions(stmt);
        if !unmatched.is_empty() {
            return None;
        }
        services.extend(found.into_iter().map(|(prefix, _, _)| prefix));
    }
    Some(services)
}

fn unused_reason(services: &BTreeSet<String>, usage: &Usage) -> String {
    let names: Vec<String> = services.iter().map(|prefix| usage.reported.get(prefix).cloned().unwrap_or_else(|| prefix.clone())).collect();
    format!("허용하는 서비스({})를 {TRACKING_DAYS}일 동안 하나도 안 썼어요", shortened(&names, SHOWN_SERVICES))
}

/// 허용하는 서비스를 전부 안 쓴 정책. Deny만 있는 정책, 알 수 없는 작업이나 AWS가 알려 주지 않은 서비스가 걸린 정책은 판단하지 않는다.
fn unused_policies(sources: &[Source], usage: &Usage) -> Vec<UnusedPolicy> {
    sources
        .iter()
        .filter_map(|src| {
            let services = allowed_services(src.document?)?;
            if services.is_empty() || !services.iter().all(|prefix| usage.is_unused(prefix)) {
                return None;
            }
            Some(UnusedPolicy { policy_id: src.id.clone(), name: src.name.clone(), via: src.via.clone(), reason: unused_reason(&services, usage) })
        })
        .collect()
}

/// 작업 이름의 첫 단어: 첫 글자부터 다음 대문자 앞까지. `GetObject` → `Get`.
fn verb(name: &str) -> &str {
    let mut chars = name.char_indices();
    chars.next();
    match chars.find(|(_, c)| c.is_ascii_uppercase()) {
        Some((i, _)) => &name[..i],
        None => name,
    }
}

/// 서비스 하나에서 고른 작업을 정책에 쓸 패턴으로 줄인다. 서비스 전체면 `s3:*`, 첫 단어가 같은 작업을 카탈로그에서 전부 골랐으면
/// `s3:Get*`, 아니면 작업 이름 그대로다. 고른 것보다 넓게 쓰지 않는다.
fn compress(prefix: &str, chosen: &BTreeSet<String>) -> Vec<String> {
    let all = catalog().actions(prefix);
    if !all.is_empty() && chosen.len() == all.len() {
        return vec![format!("{prefix}:*")];
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
        if total >= 2 && picked == total {
            wildcards.push(first);
            out.push(format!("{prefix}:{first}*"));
        } else {
            out.push(format!("{prefix}:{name}"));
        }
    }
    out
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
struct DraftStatement {
    #[serde(rename = "Effect")]
    effect: &'static str,
    #[serde(rename = "Action")]
    action: Vec<String>,
    #[serde(rename = "Resource", skip_serializing_if = "Option::is_none")]
    resource: Option<OneOrMany>,
    #[serde(rename = "NotResource", skip_serializing_if = "Option::is_none")]
    not_resource: Option<OneOrMany>,
}

#[derive(Serialize)]
struct DraftDocument {
    #[serde(rename = "Version")]
    version: &'static str,
    #[serde(rename = "Statement")]
    statement: Vec<DraftStatement>,
}

/// 쓴 서비스만 남긴 Allow 문서. 작업 단위 기록이 있는 서비스는 쓴 작업만, 없으면 지금 허용된 작업 그대로(서비스 전체면 `s3:*`).
/// 거부·경계로 막힌 작업은 빼고, 리소스는 원래 문장 그대로, 조건은 버린다.
fn draft(eval: &PrincipalEval, sources: &[Source], usage: &Usage) -> (Option<String>, Vec<String>) {
    // 리소스 조건 → 서비스 → 작업
    let mut groups: BTreeMap<ResKey, BTreeMap<String, BTreeSet<String>>> = BTreeMap::new();
    for doc in sources.iter().filter_map(|src| src.document) {
        for stmt in doc.statements.iter().filter(|st| st.effect == Effect::Allow) {
            let key = res_key(stmt);
            for (prefix, action, _) in statement_actions(stmt).0 {
                let Some(used) = usage.used.get(&prefix) else { continue };
                if used.actions.as_ref().is_some_and(|tracked| !tracked.contains(&action.to_ascii_lowercase())) {
                    continue;
                }
                let in_effect = eval.actions.get(&(prefix.clone(), action.clone())).is_some_and(|(_, result)| matches!(result.status, Status::Allowed | Status::Conditional));
                if in_effect {
                    groups.entry(key.clone()).or_default().entry(prefix).or_default().insert(action);
                }
            }
        }
    }

    let mut narrowed: BTreeSet<&str> = BTreeSet::new();
    let mut kept_as_is = false;
    let mut statement = Vec::new();
    for (key, services) in &groups {
        let mut action = Vec::new();
        for (prefix, chosen) in services {
            action.extend(compress(prefix, chosen));
            match usage.used.get(prefix) {
                Some(UsedService { name, actions: Some(_) }) => {
                    narrowed.insert(name.as_str());
                }
                _ => kept_as_is = true,
            }
        }
        let (resource, not_resource) = match key {
            ResKey::Resource(list) => (Some(OneOrMany::of(list.clone())), None),
            ResKey::NotResource(list) => (None, Some(OneOrMany::of(list.clone()))),
        };
        statement.push(DraftStatement { effect: "Allow", action, resource, not_resource });
    }
    if statement.is_empty() {
        return (None, vec![NOTE_NO_DRAFT.to_string()]);
    }

    let mut notes = vec![NOTE_CONDITIONS.to_string()];
    if !narrowed.is_empty() {
        let names = narrowed.into_iter().collect::<Vec<_>>().join(", ");
        notes.push(format!("{names}은(는) 관리 작업만 작업 단위로 기록돼요. 객체 읽기·쓰기 같은 데이터 작업은 기록에 없어서 초안에서 빠졌을 수 있어요"));
    }
    if kept_as_is {
        notes.push(NOTE_NO_ACTION_LEVEL.to_string());
    }
    let document = DraftDocument { version: "2012-10-17", statement };
    (serde_json::to_string(&document).ok(), notes)
}

/// 안 쓰는 정책, 줄인 정책 초안, 초안에 대한 안내를 만든다. `eval`은 같은 주체의 권한 계산 결과다.
pub fn least_privilege(eval: &PrincipalEval, la: &LastAccessedRaw, s: &Snapshot, arn: &str) -> (Vec<UnusedPolicy>, Option<String>, Vec<String>) {
    let (sources, _boundary) = policy_sources(s, arn);
    let usage = Usage::new(la);
    let (draft, notes) = draft(eval, &sources, &usage);
    (unused_policies(&sources, &usage), draft, notes)
}

/// 화면에 나가는 값: 서비스별 마지막 사용 + `least_privilege` 결과.
pub fn last_accessed(eval: &PrincipalEval, raw: &LastAccessedRaw, s: &Snapshot, arn: &str) -> LastAccessed {
    let (unused_policies, draft, draft_notes) = least_privilege(eval, raw, s, arn);
    let mut services: Vec<LastService> = raw
        .services
        .iter()
        .map(|svc| LastService {
            prefix: svc.prefix.clone(),
            name: svc.name.clone(),
            last_used: svc.last_used.map(iso),
            actions: svc.actions.as_ref().map(|list| {
                list.iter().map(|a| LastAction { action: format!("{}:{}", svc.prefix, a.name), last_used: a.last_used.map(iso) }).collect()
            }),
        })
        .collect();
    services.sort_by(|a, b| a.prefix.cmp(&b.prefix));
    LastAccessed { completed_at: raw.completed_at.map(iso), tracking_days: TRACKING_DAYS, services, unused_policies, draft, draft_notes }
}

#[cfg(test)]
mod tests;
