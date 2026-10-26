//! 권한 계산: 주체의 정책 출처를 모아 작업마다 허용·조건부·거부·경계 차단을 판정한다. 순수 코드다.
//! 판정 규칙은 설계 문서의 "권한 계산 규칙"을 따른다. 작업 하나의 판정은 `decide`, 작업 패턴을 번호로 펼치는 코드는 `index`,
//! 리소스 패턴끼리 견주는 코드는 `pattern`에 있다.
//! 위험 판정은 `danger`, 신뢰 해석은 `trust`, 목록·정책 화면 값은 `summary`에 있고 이 모듈은 그것들을 다시 내보내지 않는다.
//! 여기서 다시 내보내는 것은 `Status`와, 같은 모듈 형제들이 쓰는 카탈로그 도우미(`cmp_ignore_case`, `all_star`)뿐이다.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::catalog::{catalog, AccessLevel, LEVELS};
pub(super) use super::catalog::{cmp_ignore_case, is_match_all as all_star};
use super::danger;
use super::model::{GroupRec, InlinePolicy, RoleRec, Scope, Snapshot, UserRec};
use super::policy::{action_matches, statement_resource_matches, Actions, Effect, PolicyDocument, ResMatch, Statement};
use super::summary;
use super::trust::parse_trust;
use super::view::{
    ActionGrant, AttachedKind, AttachedPolicy, Badge, BadgeKind, GrantSource, Level, LevelCell, PrincipalKind, PrincipalView,
    ServicePermissions, WhoCanHit, WhoCanResult,
};

mod decide;
mod index;
mod pattern;

use decide::{decide, Hit};
use index::{index, ActionId};

pub use super::view::Status;

/// 작업 하나의 계산 결과.
#[derive(Clone, Debug, PartialEq)]
pub struct ActionEval {
    pub status: Status,
    /// 허용하는 문장들의 리소스 패턴(중복 없음). NotResource는 `* (제외: …)`로 적는다
    pub resources: Vec<String>,
    /// 판정에 걸린 문장들. 거부면 Deny 문장이 먼저 온다
    pub sources: Vec<GrantSource>,
}

#[derive(Clone, Debug, Default)]
pub struct PrincipalEval {
    /// (서비스 접두어, 작업) → (접근 수준, 판정). 허용하는 문장이 하나도 없는 작업은 없다
    pub actions: BTreeMap<(String, String), (AccessLevel, ActionEval)>,
    /// 카탈로그에 없는 작업 패턴(Allow 문장의 Action만)
    pub unknown: Vec<String>,
    pub admin_like: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    Managed,
    Inline,
    Boundary,
}

/// 주체에 적용되는 정책 하나. 문서는 스냅숏을 빌려 쓴다.
#[derive(Clone, Debug)]
pub struct Source<'a> {
    /// 관리형은 ARN, 인라인은 `inline:<소유자 ARN>:<이름>`
    pub id: String,
    pub name: String,
    pub kind: SourceKind,
    /// 관리형·경계만
    pub scope: Option<Scope>,
    /// 그룹에서 상속됐으면 그룹 이름
    pub via: Option<String>,
    /// 읽지 못했으면 None. 계산에서는 빠진다
    pub document: Option<&'a PolicyDocument>,
}

/// 스냅숏 안의 주체 하나.
#[derive(Clone, Copy)]
pub enum Principal<'a> {
    User(&'a UserRec),
    Group(&'a GroupRec),
    Role(&'a RoleRec),
}

impl<'a> Principal<'a> {
    pub fn kind(self) -> PrincipalKind {
        match self {
            Principal::User(_) => PrincipalKind::User,
            Principal::Group(_) => PrincipalKind::Group,
            Principal::Role(_) => PrincipalKind::Role,
        }
    }

    pub fn arn(self) -> &'a str {
        match self {
            Principal::User(u) => &u.arn,
            Principal::Group(g) => &g.arn,
            Principal::Role(r) => &r.arn,
        }
    }

    pub fn name(self) -> &'a str {
        match self {
            Principal::User(u) => &u.name,
            Principal::Group(g) => &g.name,
            Principal::Role(r) => &r.name,
        }
    }

    pub fn path(self) -> &'a str {
        match self {
            Principal::User(u) => &u.path,
            Principal::Group(g) => &g.path,
            Principal::Role(r) => &r.path,
        }
    }

    pub fn created_at(self) -> Option<&'a str> {
        match self {
            Principal::User(u) => u.created_at.as_deref(),
            Principal::Group(g) => g.created_at.as_deref(),
            Principal::Role(r) => r.created_at.as_deref(),
        }
    }

    pub fn inline(self) -> &'a [InlinePolicy] {
        match self {
            Principal::User(u) => &u.inline,
            Principal::Group(g) => &g.inline,
            Principal::Role(r) => &r.inline,
        }
    }

    pub fn attached(self) -> &'a [String] {
        match self {
            Principal::User(u) => &u.attached,
            Principal::Group(g) => &g.attached,
            Principal::Role(r) => &r.attached,
        }
    }

    /// 그룹에는 권한 경계를 걸 수 없다.
    pub fn boundary_arn(self) -> Option<&'a str> {
        match self {
            Principal::User(u) => u.boundary.as_deref(),
            Principal::Group(_) => None,
            Principal::Role(r) => r.boundary.as_deref(),
        }
    }

    pub fn tags(self) -> Option<&'a BTreeMap<String, String>> {
        match self {
            Principal::User(u) => Some(&u.tags),
            Principal::Group(_) => None,
            Principal::Role(r) => Some(&r.tags),
        }
    }
}

/// ARN으로 사용자·그룹·역할을 찾는다.
pub fn find_principal<'a>(s: &'a Snapshot, arn: &str) -> Option<Principal<'a>> {
    s.users
        .iter()
        .find(|u| u.arn == arn)
        .map(Principal::User)
        .or_else(|| s.groups.iter().find(|g| g.arn == arn).map(Principal::Group))
        .or_else(|| s.roles.iter().find(|r| r.arn == arn).map(Principal::Role))
}

fn scope_of_arn(arn: &str) -> Scope {
    if arn.split(':').nth(4) == Some("aws") {
        Scope::Aws
    } else {
        Scope::Local
    }
}

fn managed_source<'a>(s: &'a Snapshot, arn: &str, via: Option<&str>, kind: SourceKind) -> Source<'a> {
    let via = via.map(str::to_owned);
    match s.policies.get(arn) {
        Some(rec) => Source { id: arn.to_owned(), name: rec.name.clone(), kind, scope: Some(rec.scope), via, document: rec.document.as_ref() },
        // 붙어 있는데 정책 본문을 못 읽은 경우: 이름은 ARN 끝에서 따온다
        None => Source { id: arn.to_owned(), name: arn.rsplit('/').next().unwrap_or(arn).to_owned(), kind, scope: Some(scope_of_arn(arn)), via, document: None },
    }
}

fn add_inline<'a>(out: &mut Vec<Source<'a>>, owner_arn: &str, inline: &'a [InlinePolicy], via: Option<&str>) {
    for p in inline {
        out.push(Source {
            id: format!("inline:{owner_arn}:{}", p.name),
            name: p.name.clone(),
            kind: SourceKind::Inline,
            scope: None,
            via: via.map(str::to_owned),
            document: p.document.as_ref(),
        });
    }
}

fn add_managed<'a>(s: &'a Snapshot, out: &mut Vec<Source<'a>>, arns: &[String], via: Option<&str>) {
    out.extend(arns.iter().map(|arn| managed_source(s, arn, via, SourceKind::Managed)));
}

/// 주체에 적용되는 정책: (신원 기반 정책, 권한 경계). 사용자 = 사용자 인라인 + 관리형 + 소속 그룹 인라인·관리형,
/// 역할·그룹 = 자기 인라인 + 관리형. 모르는 ARN이면 비어 있다.
pub fn policy_sources<'a>(s: &'a Snapshot, arn: &str) -> (Vec<Source<'a>>, Option<Source<'a>>) {
    let Some(principal) = find_principal(s, arn) else {
        return (Vec::new(), None);
    };
    let mut sources = Vec::new();
    add_inline(&mut sources, principal.arn(), principal.inline(), None);
    add_managed(s, &mut sources, principal.attached(), None);
    if let Principal::User(user) = principal {
        for name in &user.groups {
            if let Some(group) = s.group(name) {
                add_inline(&mut sources, &group.arn, &group.inline, Some(&group.name));
                add_managed(s, &mut sources, &group.attached, Some(&group.name));
            }
        }
    }
    let boundary = principal.boundary_arn().map(|b| managed_source(s, b, None, SourceKind::Boundary));
    (sources, boundary)
}

/// `policy::statement_action_matches`와 같은 판정이다. 서비스 접두어가 다르면 glob을 돌리지 않고 바로 거른다.
fn stmt_matches_action(stmt: &Statement, action: &str) -> bool {
    match &stmt.actions {
        Actions::Action(patterns) => patterns.iter().any(|p| pattern_matches(p, action)),
        Actions::NotAction(patterns) => !patterns.iter().any(|p| pattern_matches(p, action)),
    }
}

fn pattern_matches(pattern: &str, action: &str) -> bool {
    if let (Some((pattern_service, _)), Some((action_service, _))) = (pattern.split_once(':'), action.split_once(':')) {
        let wildcard = pattern_service.bytes().any(|b| b == b'*' || b == b'?');
        if !wildcard && !pattern_service.eq_ignore_ascii_case(action_service) {
            return false;
        }
    }
    action_matches(pattern, action)
}

fn hits_for<'a>(sources: impl Iterator<Item = &'a Source<'a>>, action: &str, resource: Option<&str>) -> Vec<Hit<'a>> {
    let mut hits = Vec::new();
    for src in sources {
        let Some(doc) = src.document else { continue };
        for stmt in &doc.statements {
            if !stmt_matches_action(stmt, action) {
                continue;
            }
            match statement_resource_matches(stmt, resource) {
                ResMatch::Yes => hits.push(Hit { src, stmt, maybe: false }),
                ResMatch::Unknown => hits.push(Hit { src, stmt, maybe: true }),
                ResMatch::No => {}
            }
        }
    }
    hits
}

/// 작업 하나를 정책 출처에 대해 판정한다. 읽지 못한 경계 정책은 없는 것으로 본다.
pub(super) fn decide_action<'a>(sources: &'a [Source<'a>], boundary: Option<&'a Source<'a>>, action: &str, resource: Option<&str>) -> Option<ActionEval> {
    let boundary = boundary.filter(|b| b.document.is_some());
    let identity = hits_for(sources.iter(), action, resource);
    let boundary_hits = hits_for(boundary.into_iter(), action, resource);
    decide(&identity, &boundary_hits, boundary.is_some(), resource.is_some(), true)
}

/// 한 주체의 한 작업. `resource`가 있으면 그 ARN에 적용되는 문장만 본다. 허용하는 문장이 없으면 None.
pub fn evaluate_action(s: &Snapshot, arn: &str, action: &str, resource: Option<&str>) -> Option<ActionEval> {
    find_principal(s, arn)?;
    let (sources, boundary) = policy_sources(s, arn);
    decide_action(&sources, boundary.as_ref(), action, resource)
}

type ActionKey = (String, String, AccessLevel);

/// 문장의 Action/NotAction이 가리키는 카탈로그 작업(접두어, 작업, 수준). 중복이 없고 (접두어, 작업)의 바이트순이라 같은 접두어끼리
/// 붙어 있다. 두 번째 값은 카탈로그의 어떤 작업에도 맞지 않은 `Action` 패턴이다(NotAction은 비어 있다).
/// 작업마다 이름 문자열을 만들므로 `*`나 NotAction처럼 많은 작업을 다룰 때는 `index`의 번호를 쓴다.
pub(super) fn statement_actions(stmt: &Statement) -> (Vec<ActionKey>, Vec<&str>) {
    let ix = index();
    let (ids, unmatched) = ix.statement_ids(stmt);
    let mut found: Vec<ActionKey> = ids
        .into_iter()
        .map(|id| {
            let (prefix, action) = ix.names(id);
            (prefix.to_owned(), action.to_owned(), ix.level(id))
        })
        .collect();
    found.sort_unstable_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    (found, unmatched)
}

/// 작업 번호별 판정과 부가 결과. `PrincipalEval`과 달리 작업 이름 문자열을 만들지 않는다.
struct Evaluated {
    /// 허용하는 문장이 있는 작업만, `ActionId` 오름차순으로. 두 번째 값은 `distinct`의 순번이다
    verdicts: Vec<(ActionId, usize)>,
    /// 서로 다른 판정들. 같은 문장들에 맞은 작업은 판정이 같으므로 한 번만 계산해 나눠 쓴다
    distinct: Vec<ActionEval>,
    unknown: Vec<String>,
    admin_like: bool,
}

/// 모든 문장의 작업 패턴을 한 번씩 번호로 펼쳐 작업마다 맞은 문장을 모은 뒤 판정한다.
/// `with_sources`가 false이면 판정의 근거(`sources`)를 만들지 않는다.
fn evaluate_ids<'a>(sources: &'a [Source<'a>], boundary: Option<&'a Source<'a>>, with_sources: bool) -> Evaluated {
    let ix = index();
    let boundary = boundary.filter(|b| b.document.is_some());
    // 문장마다 하나씩. 신원 정책 문장이 먼저고 경계 정책 문장이 뒤에 온다
    let mut hits: Vec<Hit<'a>> = Vec::new();
    let mut identity_len = 0;
    // (작업 번호 << 32 | 문장 번호). 정렬하면 작업별로 모이고, 한 작업 안에서는 문장 순서가 된다
    let mut pairs: Vec<u64> = Vec::new();
    let mut unknown = BTreeSet::new();
    let layers = sources.iter().map(|src| (src, false)).chain(boundary.map(|b| (b, true)));
    for (src, is_boundary) in layers {
        let Some(doc) = src.document else { continue };
        for stmt in &doc.statements {
            let (ids, unmatched) = ix.statement_ids(stmt);
            if !is_boundary && stmt.effect == Effect::Allow {
                unknown.extend(unmatched.into_iter().map(str::to_owned));
            }
            let n = hits.len() as u64;
            hits.push(Hit { src, stmt, maybe: false });
            identity_len += usize::from(!is_boundary);
            pairs.extend(ids.into_iter().map(|id| u64::from(id) << 32 | n));
        }
    }
    pairs.sort();

    let has_boundary = boundary.is_some();
    let mut verdicts = Vec::new();
    let mut distinct: Vec<ActionEval> = Vec::new();
    // 맞은 문장 번호들 → 판정(없으면 None). 이어지는 작업은 대개 같은 문장들에 맞으니 바로 앞 것과 먼저 견준다
    let mut cache: HashMap<Vec<u32>, Option<usize>> = HashMap::new();
    let (mut key, mut previous_key, mut previous): (Vec<u32>, Vec<u32>, Option<usize>) = (Vec::new(), Vec::new(), None);
    let (mut identity, mut limit): (Vec<Hit<'a>>, Vec<Hit<'a>>) = (Vec::new(), Vec::new());
    for group in pairs.chunk_by(|a, b| a >> 32 == b >> 32) {
        key.clear();
        key.extend(group.iter().map(|pair| *pair as u32));
        let verdict = if key == previous_key {
            previous
        } else if let Some(&cached) = cache.get(&key) {
            cached
        } else {
            identity.clear();
            limit.clear();
            for &n in &key {
                let hit = hits[n as usize];
                if (n as usize) < identity_len {
                    identity.push(hit);
                } else {
                    limit.push(hit);
                }
            }
            let computed = decide(&identity, &limit, has_boundary, false, with_sources).map(|eval| {
                distinct.push(eval);
                distinct.len() - 1
            });
            cache.insert(key.clone(), computed);
            computed
        };
        previous = verdict;
        std::mem::swap(&mut key, &mut previous_key);
        if let Some(verdict) = verdict {
            verdicts.push(((group[0] >> 32) as ActionId, verdict));
        }
    }
    // 관리자급: 문장 하나가 모든 작업을 모든 리소스에 열어 두었거나, 모든 리소스에서 최종적으로 허용된 작업이 카탈로그의 90% 이상.
    // 리소스를 좁혀 허용한 작업(`Resource:"arn:aws:s3:::b/*"` 위의 `Action:"*"` 등)은 세지 않는다
    let allowed_everywhere = verdicts
        .iter()
        .filter(|(_, v)| distinct[*v].status == Status::Allowed && distinct[*v].resources.iter().any(|r| all_star(r)))
        .count();
    let admin_like = danger::admin_like(sources, boundary) || (allowed_everywhere > 0 && allowed_everywhere * 100 >= ix.total() * 90);
    Evaluated { verdicts, distinct, unknown: unknown.into_iter().collect(), admin_like }
}

/// 모든 작업의 판정을 (접두어, 작업) 이름으로 묶는다. 이름 문자열은 판정이 있는 작업에만 만든다.
pub(super) fn evaluate_sources<'a>(sources: &'a [Source<'a>], boundary: Option<&'a Source<'a>>) -> PrincipalEval {
    let ix = index();
    let Evaluated { verdicts, distinct, unknown, admin_like } = evaluate_ids(sources, boundary, true);
    let actions = verdicts
        .into_iter()
        .map(|(id, verdict)| {
            let (prefix, action) = ix.names(id);
            ((prefix.to_owned(), action.to_owned()), (ix.level(id), distinct[verdict].clone()))
        })
        .collect();
    PrincipalEval { actions, unknown, admin_like }
}

/// 한 주체의 모든 작업을 계산한다. 카탈로그 전체를 펼치므로 주체 하나씩 쓴다. 모르는 ARN이면 None.
pub fn evaluate(s: &Snapshot, arn: &str) -> Option<PrincipalEval> {
    find_principal(s, arn)?;
    let (sources, boundary) = policy_sources(s, arn);
    Some(evaluate_sources(&sources, boundary.as_ref()))
}

/// 서비스 하나의 한 접근 수준에 속한 작업을 하나씩 판정해 돌려준다(권한 표에서 칸을 눌렀을 때). 접두어는 대소문자를 구분하지 않는다.
pub fn principal_actions(s: &Snapshot, arn: &str, prefix: &str, level: AccessLevel) -> Vec<ActionGrant> {
    let cat = catalog();
    let Some((service, _)) = cat.services().find(|(p, _)| p.eq_ignore_ascii_case(prefix)) else {
        return Vec::new();
    };
    if find_principal(s, arn).is_none() {
        return Vec::new();
    }
    let (sources, boundary) = policy_sources(s, arn);
    let admin_statement = danger::has_admin_statement(&sources);
    cat.actions(service)
        .iter()
        .filter(|(_, l)| *l == level)
        .filter_map(|(name, _)| {
            let action = format!("{service}:{name}");
            let eval = decide_action(&sources, boundary.as_ref(), &action, None)?;
            let danger = danger::danger_reason(service, name, level, &eval, admin_statement).map(str::to_owned);
            Some(ActionGrant { action, status: eval.status, resources: eval.resources, sources: eval.sources, danger })
        })
        .collect()
}

/// 소속 그룹(사용자), 구성원 사용자(그룹), 없음(역할). 이름순이다.
fn related_groups(s: &Snapshot, principal: Principal) -> Vec<String> {
    let mut names = match principal {
        Principal::User(u) => u.groups.clone(),
        Principal::Group(g) => s.users.iter().filter(|u| u.groups.contains(&g.name)).map(|u| u.name.clone()).collect(),
        Principal::Role(_) => Vec::new(),
    };
    names.sort_by(|a, b| cmp_ignore_case(a, b).then_with(|| a.cmp(b)));
    names
}

fn attached_policies(s: &Snapshot, principal: Principal, sources: &[Source], boundary: Option<&Source>) -> Vec<AttachedPolicy> {
    // 서비스 연결 역할·Identity Center 역할에 붙은 정책은 떼지 못한다
    let locked = danger::is_locked_role(principal);
    sources
        .iter()
        .chain(boundary)
        .map(|src| {
            let kind = match src.kind {
                SourceKind::Managed => AttachedKind::Managed,
                SourceKind::Inline => AttachedKind::Inline,
                SourceKind::Boundary => AttachedKind::Boundary,
            };
            let mut badges = match src.kind {
                SourceKind::Inline => src.document.map(danger::document_badges).unwrap_or_default(),
                _ => s.policies.get(&src.id).map(|policy| summary::managed_badges_in(s, policy)).unwrap_or_default(),
            };
            if src.kind == SourceKind::Boundary {
                badges.push(Badge::new(BadgeKind::Boundary, "권한 경계", Level::Info));
            }
            AttachedPolicy {
                id: src.id.clone(),
                name: src.name.clone(),
                kind,
                scope: src.scope,
                via: src.via.clone(),
                badges,
                detachable: !locked && src.kind == SourceKind::Managed && src.via.is_none(),
            }
        })
        .collect()
}

/// 서비스별 권한 표. 판정이 하나라도 있는 서비스만 이름순으로 담고, 다섯 수준은 항상 모두 채운다.
/// 거부 칸은 거부와 경계 차단을 합친 수다.
fn service_permissions(done: &Evaluated, admin_statement: bool) -> Vec<ServicePermissions> {
    let (cat, ix) = (catalog(), index());
    // 판정은 작업 번호순이라 같은 서비스끼리 붙어 있다
    let mut services: Vec<ServicePermissions> = done
        .verdicts
        .chunk_by(|a, b| ix.service_of(a.0) == ix.service_of(b.0))
        .map(|group| {
            let prefix = ix.prefix(ix.service_of(group[0].0));
            let mut cells = [LevelCell::default(); LEVELS.len()];
            let mut dangerous = false;
            for (id, verdict) in group {
                let result = &done.distinct[*verdict];
                let level = ix.level(*id);
                let cell = &mut cells[level as usize];
                match result.status {
                    Status::Allowed => cell.allowed += 1,
                    Status::Conditional => cell.conditional += 1,
                    Status::Denied | Status::Boundary => cell.denied += 1,
                }
                if result.status == Status::Allowed && !dangerous && danger::danger_reason(prefix, ix.names(*id).1, level, result, admin_statement).is_some() {
                    dangerous = true;
                }
            }
            let levels = LEVELS
                .iter()
                .map(|level| {
                    let mut cell = cells[*level as usize];
                    cell.total = cat.total(prefix, *level);
                    (*level, cell)
                })
                .collect();
            ServicePermissions { prefix: prefix.to_owned(), name: cat.service_name(prefix).unwrap_or(prefix).to_owned(), levels, danger: dangerous }
        })
        .collect();
    services.sort_by(|a, b| cmp_ignore_case(&a.name, &b.name).then_with(|| a.prefix.cmp(&b.prefix)));
    services
}

fn view_notes(principal: Principal, sources: &[Source], boundary: Option<&Source>) -> Vec<String> {
    let mut notes = Vec::new();
    for src in sources.iter().chain(boundary).filter(|src| src.document.is_none()) {
        notes.push(format!("문서를 읽지 못한 정책은 계산에서 뺐어요: {}", src.name));
    }
    if let Some(b) = boundary.filter(|b| b.document.is_some()) {
        notes.push(format!("권한 경계 정책이 걸려 있어요: {}. 경계가 허용하지 않는 작업은 거부 칸에 세었어요", b.name));
    }
    match principal {
        Principal::Group(_) => notes.push("이 그룹에 붙은 정책만 계산했어요. 구성원이 따로 받은 권한은 포함하지 않아요".to_string()),
        Principal::Role(r) if r.trust_raw.is_some() && r.trust.is_none() => notes.push("신뢰 정책을 읽지 못해 신뢰 관계를 보여 주지 못해요".to_string()),
        _ => {}
    }
    notes
}

/// 사용자·그룹·역할 상세 화면의 값. 카탈로그 전체를 펼쳐 계산한다.
pub fn principal_view(s: &Snapshot, arn: &str) -> Option<PrincipalView> {
    let principal = find_principal(s, arn)?;
    let (sources, boundary) = policy_sources(s, arn);
    let done = evaluate_ids(&sources, boundary.as_ref(), false);
    let admin_statement = danger::has_admin_statement(&sources);
    let trust = match principal {
        Principal::Role(role) => role.trust.as_ref().map(|doc| parse_trust(doc, &s.account_id)).unwrap_or_default(),
        _ => Vec::new(),
    };
    // 목록 배지는 문장만 보고 정한 값이다. 전체 계산에서 관리자급으로 나왔으면 상세 화면 배지도 관리자급으로 맞춘다
    let mut summary = summary::summary_of(s, principal, &sources, boundary.as_ref());
    if done.admin_like {
        danger::mark_admin(&mut summary.badges);
    }
    Some(PrincipalView {
        summary,
        policies: attached_policies(s, principal, &sources, boundary.as_ref()),
        groups: related_groups(s, principal),
        trust,
        services: service_permissions(&done, admin_statement),
        admin_like: done.admin_like,
        unknown_actions: done.unknown,
        tags: principal.tags().cloned().unwrap_or_default(),
        notes: view_notes(principal, &sources, boundary.as_ref()),
    })
}

fn status_rank(status: Status) -> u8 {
    match status {
        Status::Allowed => 0,
        Status::Conditional => 1,
        Status::Boundary => 2,
        Status::Denied => 3,
    }
}

/// 이 작업(과 리소스)을 할 수 있는 사용자와 역할. 허용하는 문장이 있는 주체만 담고,
/// 허용 → 조건부 → 경계 차단 → 거부 순, 같으면 이름순이다. 그룹 권한은 구성원에게 합쳐 계산한다.
pub fn who_can(s: &Snapshot, action: &str, resource: Option<&str>) -> WhoCanResult {
    let candidates = s.users.iter().map(Principal::User).chain(s.roles.iter().map(Principal::Role));
    let mut hits: Vec<WhoCanHit> = Vec::new();
    // 정책을 읽지 못해 계산에서 뺀 정책이 있는데 결과에도 못 든 대상: 그 정책이 허용했을 수 있다
    let mut unreadable: Vec<&str> = Vec::new();
    for principal in candidates {
        let (sources, boundary) = policy_sources(s, principal.arn());
        match decide_action(&sources, boundary.as_ref(), action, resource) {
            Some(eval) => {
                hits.push(WhoCanHit { principal: summary::summary_of(s, principal, &sources, boundary.as_ref()), status: eval.status, sources: eval.sources });
            }
            None if sources.iter().any(|src| src.document.is_none()) => unreadable.push(principal.name()),
            None => {}
        }
    }
    hits.sort_by(|a, b| {
        status_rank(a.status)
            .cmp(&status_rank(b.status))
            .then_with(|| cmp_ignore_case(&a.principal.name, &b.principal.name))
            .then_with(|| a.principal.arn.cmp(&b.principal.arn))
    });

    let mut notes = Vec::new();
    let known = action.split_once(':').is_some_and(|(prefix, name)| catalog().level(prefix, name).is_some());
    if !known {
        notes.push("카탈로그에 없는 작업이에요. 정책에 적힌 패턴과만 비교했어요".to_string());
    }
    if hits.iter().any(|hit| hit.sources.iter().any(|source| source.via.is_some())) {
        notes.push("그룹에서 받은 권한도 사용자에게 합쳐서 계산했어요".to_string());
    }
    if !unreadable.is_empty() {
        const SHOWN: usize = 5;
        unreadable.sort_by(|a, b| cmp_ignore_case(a, b).then_with(|| a.cmp(b)));
        let names = unreadable.iter().take(SHOWN).copied().collect::<Vec<_>>().join(", ");
        let rest = if unreadable.len() > SHOWN { format!(" 외 {}개", unreadable.len() - SHOWN) } else { String::new() };
        notes.push(format!("정책을 해석하지 못한 대상 {}개는 결과에서 빠졌어요: {names}{rest}", unreadable.len()));
    }
    WhoCanResult { action: action.to_string(), resource: resource.map(str::to_owned), hits, notes }
}

#[cfg(test)]
mod tests;
