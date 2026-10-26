//! 권한 줄이기: AWS가 기록한 서비스별 마지막 사용 시각으로 안 쓰는 정책을 찾고, 최근에 쓴 서비스만 남긴 정책 초안을 만든다. 순수 코드다.
//! "안 씀"은 기록 기간(400일) 안에 한 번도 안 썼거나, 마지막 사용이 사용 기록을 만든 시각보다 `STALE_DAYS`(90일) 넘게 앞인 것이다.
//! 초안 만들기는 `draft`에, 사용 기록을 가져오는 AWS 호출은 `fetch::usage`에 있다.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use super::clock::{days_between, iso, parse_iso};
use super::eval::{find_principal, policy_sources, statement_actions, PrincipalEval, Source};
use super::findings::STALE_DAYS;
use super::model::Snapshot;
use super::policy::{Effect, PolicyDocument};
use super::text::shortened;

mod draft;

/// AWS가 서비스 사용 기록을 남기는 기간(일).
pub const TRACKING_DAYS: u32 = 400;

/// 이유에 서비스 이름을 이 개수까지만 적는다.
const SHOWN_SERVICES: usize = 3;

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

/// 서비스(또는 작업) 하나를 쓴 정도.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Use {
    /// 기록 기간 안에 쓴 적이 없다
    Never,
    /// 마지막 사용이 사용 기록을 만든 시각보다 이 일수만큼 앞이다(`STALE_DAYS` 초과)
    Stale(i64),
    /// 최근(`STALE_DAYS` 안)에 썼다
    Recent,
}

/// 기록을 만든 시각을 모르면 오래됐는지 판단하지 않는다(안 쓴다고 말하지 않는다).
fn use_of(last_used: Option<i64>, completed_at: Option<i64>) -> Use {
    match (last_used, completed_at) {
        (None, _) => Use::Never,
        (Some(used), Some(done)) => {
            let days = days_between(used, done);
            if days > STALE_DAYS {
                Use::Stale(days)
            } else {
                Use::Recent
            }
        }
        (Some(_), None) => Use::Recent,
    }
}

/// 최근에 쓴 서비스의 작업 단위 기록.
struct Tracked {
    name: String,
    /// AWS가 기록한 작업(소문자) → 최근에 썼는지. AWS는 관리 작업만 기록하니 여기 없는 작업은 "모름"이다
    actions: BTreeMap<String, bool>,
}

/// AWS가 알려 준 서비스와 그중 최근에 쓴 서비스.
struct Usage {
    /// 접두어(소문자) → (서비스 이름, 쓴 정도). AWS가 알려 준 서비스 전부
    reported: BTreeMap<String, (String, Use)>,
    recent: BTreeMap<String, Tracked>,
}

impl Usage {
    fn new(la: &LastAccessedRaw) -> Usage {
        let mut usage = Usage { reported: BTreeMap::new(), recent: BTreeMap::new() };
        for service in &la.services {
            let prefix = service.prefix.to_ascii_lowercase();
            let used = use_of(service.last_used, la.completed_at);
            usage.reported.insert(prefix.clone(), (service.name.clone(), used));
            if used != Use::Recent {
                continue;
            }
            let mut actions: BTreeMap<String, bool> = BTreeMap::new();
            for action in service.actions.iter().flatten() {
                let recent = use_of(action.last_used, la.completed_at) == Use::Recent;
                // 같은 작업이 두 번 오면 하나라도 최근에 썼다고 하면 쓴 것이다
                *actions.entry(action.name.to_ascii_lowercase()).or_default() |= recent;
            }
            usage.recent.insert(prefix, Tracked { name: service.name.clone(), actions });
        }
        usage
    }

    /// AWS가 알려 줬고 최근에 쓰지 않았다. 알려 주지 않은 서비스는 모르는 것이라 안 쓴 것으로 치지 않는다.
    fn is_unused(&self, prefix: &str) -> bool {
        matches!(self.reported.get(prefix), Some((_, Use::Never | Use::Stale(_))))
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

/// 한 번도 안 쓴 서비스와 오래 안 쓴 서비스를 나눠 적는다. 오래 안 쓴 쪽은 그중 가장 최근 사용을 알린다.
fn unused_reason(services: &BTreeSet<String>, usage: &Usage) -> String {
    let (mut never, mut stale): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    let mut latest: Option<i64> = None;
    for prefix in services {
        let Some((name, used)) = usage.reported.get(prefix) else { continue };
        match used {
            Use::Never => never.push(name.clone()),
            Use::Stale(days) => {
                stale.push(name.clone());
                latest = Some(latest.map_or(*days, |d| d.min(*days)));
            }
            Use::Recent => {}
        }
    }
    let latest = latest.unwrap_or_default();
    match (never.is_empty(), stale.is_empty()) {
        (false, true) => format!("허용하는 서비스({})를 {TRACKING_DAYS}일 동안 한 번도 안 썼어요", shortened(&never, SHOWN_SERVICES)),
        (true, false) => format!("허용하는 서비스({})를 {STALE_DAYS}일 넘게 안 썼어요(마지막 사용 {latest}일 전)", shortened(&stale, SHOWN_SERVICES)),
        _ => format!(
            "허용하는 서비스를 모두 {STALE_DAYS}일 넘게 안 썼어요. {TRACKING_DAYS}일 동안 한 번도 안 썼어요: {}. 마지막 사용 {latest}일 전: {}",
            shortened(&never, SHOWN_SERVICES),
            shortened(&stale, SHOWN_SERVICES)
        ),
    }
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

/// 사용 기록을 만든 시각에 주체가 만들어진 지 며칠 됐는지. 둘 중 하나라도 모르면 None.
fn principal_age(s: &Snapshot, arn: &str, completed_at: Option<i64>) -> Option<i64> {
    let created = find_principal(s, arn)?.created_at().and_then(parse_iso)?;
    Some(days_between(created, completed_at?))
}

/// 만든 지 얼마 안 된 주체는 아직 써 보지 않은 권한이 많아서 "통째로 안 쓴다"고 하기 이르다.
fn too_young_note(age: Option<i64>) -> String {
    match age {
        Some(age) => format!("만든 지 {age}일밖에 안 된 주체라 통째로 안 쓰는 정책은 고르지 않았어요. 사용 기록이 {STALE_DAYS}일 넘게 쌓인 뒤에 다시 확인해 주세요"),
        None => "주체를 만든 날짜나 사용 기록을 만든 시각을 알 수 없어서 통째로 안 쓰는 정책은 고르지 않았어요".to_string(),
    }
}

/// 안 쓰는 정책, 줄인 정책 초안, 초안에 대한 안내를 만든다. `eval`은 같은 주체의 권한 계산 결과다.
/// 만든 지 `STALE_DAYS`일이 안 된 주체(또는 언제 만들었는지 모르는 주체)는 뗄 정책을 고르지 않고 그 사실을 안내한다.
pub fn least_privilege(eval: &PrincipalEval, la: &LastAccessedRaw, s: &Snapshot, arn: &str) -> (Vec<UnusedPolicy>, Option<String>, Vec<String>) {
    let (sources, _boundary) = policy_sources(s, arn);
    let usage = Usage::new(la);
    let mut notes = Vec::new();
    let unused = match principal_age(s, arn, la.completed_at) {
        Some(age) if age >= STALE_DAYS => unused_policies(&sources, &usage),
        age => {
            notes.push(too_young_note(age));
            Vec::new()
        }
    };
    let (draft, draft_notes) = draft::draft(eval, &sources, &usage, s, arn);
    notes.extend(draft_notes);
    (unused, draft, notes)
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
