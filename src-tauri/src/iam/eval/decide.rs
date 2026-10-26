//! 작업 하나의 판정: 그 작업에 맞은 문장들로 허용·조건부·거부·경계 차단을 가르고, 허용하는 리소스를 적는다.

use super::pattern::{pattern_covers, patterns_overlap};
use super::{all_star, ActionEval, Source, SourceKind, Status};
use crate::iam::policy::{Effect, Resources, Statement};
use crate::iam::view::GrantSource;

/// 작업에 맞은 문장 하나.
#[derive(Clone, Copy)]
pub(super) struct Hit<'a> {
    pub(super) src: &'a Source<'a>,
    pub(super) stmt: &'a Statement,
    /// 리소스가 정책 변수라 맞는지 알 수 없다. 조건이 걸린 것처럼 다룬다
    pub(super) maybe: bool,
}

impl Hit<'_> {
    fn conditional(&self) -> bool {
        self.stmt.conditional || self.maybe
    }

    fn grant_source(&self) -> GrantSource {
        GrantSource {
            policy_id: self.src.id.clone(),
            policy_name: self.src.name.clone(),
            via: self.src.via.clone(),
            effect: self.stmt.effect,
            sid: self.stmt.sid.clone(),
            statement_index: self.stmt.index,
            conditional: self.conditional(),
            boundary: self.src.kind == SourceKind::Boundary,
        }
    }
}

/// 문장이 가리키는 리소스 범위의 한 조각.
#[derive(Clone, Copy)]
enum Reach<'a> {
    /// 이 패턴에 맞는 리소스
    Pattern(&'a str),
    /// 모든 리소스에서 이 패턴들에 맞는 것만 뺀 나머지(NotResource)
    AllBut(&'a [String]),
}

impl Reach<'_> {
    /// 화면에 적는 모양. NotResource는 `* (제외: …)`다.
    fn label(self) -> String {
        match self {
            Reach::Pattern(pattern) => pattern.to_owned(),
            Reach::AllBut(excluded) => format!("* (제외: {})", excluded.join(", ")),
        }
    }
}

/// 문장들의 리소스 범위. Resource 없는 문장(신뢰 정책용)은 `unspecified_is_everything`이면 전부로, 아니면 건너뛴다.
fn reaches<'a>(hits: &[Hit<'a>], unspecified_is_everything: bool) -> Vec<Reach<'a>> {
    let mut out = Vec::new();
    for hit in hits {
        let stmt: &'a Statement = hit.stmt;
        match &stmt.resources {
            Resources::Resource(patterns) => out.extend(patterns.iter().map(|pattern| Reach::Pattern(pattern))),
            Resources::NotResource(patterns) => out.push(Reach::AllBut(patterns)),
            Resources::Unspecified if unspecified_is_everything => out.push(Reach::Pattern("*")),
            Resources::Unspecified => {}
        }
    }
    out
}

/// 허용하는 문장들의 리소스 라벨(중복 없음).
fn resource_labels(hits: &[Hit]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for reach in reaches(hits, false) {
        let label = reach.label();
        if !out.contains(&label) {
            out.push(label);
        }
    }
    out
}

/// 패턴 `pattern`에서 제외 목록이 통째로 덮는 것을 뺀 나머지. 전부 제외되면 None.
fn pattern_without(pattern: &str, excluded: &[String]) -> Option<String> {
    if all_star(pattern) {
        Some(Reach::AllBut(excluded).label())
    } else if excluded.iter().any(|e| pattern_covers(e, pattern)) {
        None
    } else {
        Some(pattern.to_owned())
    }
}

/// 신원 정책이 허용한 조각과 경계가 허용한 조각의 교집합을 라벨 하나로 근사한다. 겹치지 않으면 None.
/// 경계가 `*`면 신원 쪽, 신원이 `*`면 경계 쪽이 남고, 한쪽이 다른 쪽을 포함하면 좁은 쪽이 남는다.
/// 서로 일부만 겹치면 하나의 패턴으로 적을 수 없어 신원 쪽 패턴을 남긴다.
fn intersect(identity: Reach, limit: Reach) -> Option<String> {
    match (identity, limit) {
        (Reach::Pattern(p), Reach::Pattern(q)) => {
            if all_star(q) {
                Some(p.to_owned())
            } else if all_star(p) || pattern_covers(p, q) {
                Some(q.to_owned())
            } else if pattern_covers(q, p) || patterns_overlap(p, q) {
                Some(p.to_owned())
            } else {
                None
            }
        }
        (Reach::Pattern(p), Reach::AllBut(excluded)) | (Reach::AllBut(excluded), Reach::Pattern(p)) => pattern_without(p, excluded),
        (Reach::AllBut(x), Reach::AllBut(y)) => {
            let mut excluded: Vec<String> = Vec::new();
            for pattern in x.iter().chain(y) {
                if !excluded.contains(pattern) {
                    excluded.push(pattern.clone());
                }
            }
            Some(Reach::AllBut(&excluded).label())
        }
    }
}

/// 권한 경계가 있을 때 실제로 열리는 리소스: 신원 정책이 허용한 범위와 경계가 허용한 범위의 교집합(패턴 단위 근사).
/// 신원 정책 쪽에 리소스를 적은 문장이 없으면 None. 아무것도 안 남으면 빈 목록, 곧 경계가 이 작업을 어느 리소스에도 허용하지 않는다.
fn narrow_by_boundary(live: &[Hit], boundary_allows: &[Hit]) -> Option<Vec<String>> {
    let identity = reaches(live, false);
    if identity.is_empty() {
        return None;
    }
    let limits = reaches(boundary_allows, true);
    let mut out: Vec<String> = Vec::new();
    for reach in &identity {
        for limit in &limits {
            if let Some(label) = intersect(*reach, *limit) {
                if !out.contains(&label) {
                    out.push(label);
                }
            }
        }
    }
    Some(out)
}

/// 대상 리소스를 정하지 않았을 때, Deny 문장이 Allow 문장이 허용한 리소스를 전부 덮는지. 일부만 덮으면 그 리소스에서만
/// 막히는 것이라 "이 작업을 할 수 있는가"의 답은 바뀌지 않는다. NotResource Deny는 제외 목록 밖의 모든 리소스에 적용되니,
/// Allow가 허용한 패턴이 제외 목록과 하나도 겹치지 않을 때 전부 덮는다.
fn deny_covers(deny: &Statement, allow: &Statement) -> bool {
    let granted = match &allow.resources {
        Resources::Resource(granted) => Some(granted),
        _ => None,
    };
    match &deny.resources {
        Resources::Unspecified => true,
        Resources::Resource(patterns) => {
            patterns.iter().any(|p| all_star(p)) || granted.is_some_and(|granted| granted.iter().all(|g| patterns.iter().any(|d| pattern_covers(d, g))))
        }
        Resources::NotResource(excluded) => granted.is_some_and(|granted| granted.iter().all(|g| !excluded.iter().any(|e| patterns_overlap(e, g)))),
    }
}

/// 맞은 Allow·Deny를 판정에 쓸 모양으로 줄인 것.
struct Reduced<'a> {
    /// 살아남은 Allow. 조건 없는 Deny가 리소스를 전부 덮은 Allow는 빠진다
    live: Vec<Hit<'a>>,
    /// 판정에 걸린 Deny
    applying: Vec<Hit<'a>>,
    /// 일부 리소스만 막아 출처로만 남는 Deny
    partial: Vec<Hit<'a>>,
}

/// 대상 리소스를 정했으면 맞은 Deny가 모두 그 리소스에 적용된다. 정하지 않았으면 조건 없는 Deny는 자기가 덮는 Allow를 지우고
/// (Deny가 여럿이어도 된다), 조건 있는 Deny는 남은 Allow를 모두 덮을 때만 판정에 걸린다.
fn reduce<'a>(allows: &[Hit<'a>], denies: Vec<Hit<'a>>, resource_given: bool) -> Reduced<'a> {
    if resource_given {
        return Reduced { live: allows.to_vec(), applying: denies, partial: Vec::new() };
    }
    let kills = |deny: &Hit, allow: &Hit| !deny.conditional() && deny_covers(deny.stmt, allow.stmt);
    let live: Vec<Hit> = allows.iter().filter(|a| !denies.iter().any(|d| kills(d, a))).copied().collect();
    let (applying, partial): (Vec<Hit>, Vec<Hit>) = if live.is_empty() {
        denies.into_iter().partition(|d| allows.iter().any(|a| kills(d, a)))
    } else {
        denies.into_iter().partition(|d| d.conditional() && live.iter().all(|a| deny_covers(d.stmt, a.stmt)))
    };
    Reduced { live, applying, partial }
}

/// 판정에 걸린 문장들. 거부면 Deny 문장이 먼저 온다.
fn grant_sources(denied: bool, allows: &[Hit], applying: &[Hit], partial: &[Hit], boundary_allows: &[Hit]) -> Vec<GrantSource> {
    let groups: [&[Hit]; 4] = if denied { [applying, partial, allows, boundary_allows] } else { [allows, applying, partial, boundary_allows] };
    groups.iter().flat_map(|group| group.iter()).map(Hit::grant_source).collect()
}

/// 맞은 문장들로 판정한다. 우선순위: Allow 없음 → 제외(None), 조건 없는 Deny → 거부, 권한 경계, 조건 → 조건부, 그 외 허용.
/// 경계 정책의 Deny도 Deny다. `resource_given`이 false이면 조건 없는 Deny는 자기가 덮는 Allow만 지우고(남은 Allow가 없을 때만 거부),
/// 권한 경계가 있으면 허용하는 리소스를 경계가 허용하는 범위로 좁힌다(좁힌 결과가 없으면 경계 차단).
/// `with_sources`가 false이면 `sources`를 채우지 않는다(권한 표처럼 근거가 필요 없는 곳에서 문자열 복사를 아낀다).
pub(super) fn decide(identity: &[Hit], boundary: &[Hit], has_boundary: bool, resource_given: bool, with_sources: bool) -> Option<ActionEval> {
    let allows: Vec<Hit> = identity.iter().filter(|h| h.stmt.effect == Effect::Allow).copied().collect();
    if allows.is_empty() {
        return None;
    }
    let denies: Vec<Hit> = identity.iter().chain(boundary).filter(|h| h.stmt.effect == Effect::Deny).copied().collect();
    let boundary_allows: Vec<Hit> = boundary.iter().filter(|h| h.stmt.effect == Effect::Allow).copied().collect();
    let Reduced { live, applying, partial } = reduce(&allows, denies, resource_given);

    let denied = if resource_given { applying.iter().any(|d| !d.conditional()) } else { live.is_empty() };
    let mut resources = resource_labels(if denied { &allows } else { &live });
    let mut blocked = has_boundary && boundary_allows.is_empty();
    if has_boundary && !blocked && !resource_given && !denied {
        if let Some(narrowed) = narrow_by_boundary(&live, &boundary_allows) {
            blocked = narrowed.is_empty();
            if !blocked {
                resources = narrowed;
            }
        }
    }

    let status = if denied {
        Status::Denied
    } else if blocked {
        Status::Boundary
    } else if !applying.is_empty() || (has_boundary && boundary_allows.iter().all(Hit::conditional)) || live.iter().all(Hit::conditional) {
        Status::Conditional
    } else {
        Status::Allowed
    };
    let sources = if with_sources { grant_sources(denied, &allows, &applying, &partial, &boundary_allows) } else { Vec::new() };
    Some(ActionEval { status, resources, sources })
}
