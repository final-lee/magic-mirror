//! 작업 하나의 판정: 그 작업에 맞은 문장들로 허용·조건부·거부·경계 차단을 가르고, 허용하는 리소스를 적는다.
//! 대상 리소스를 정하지 않았으면 허용 범위를 조각(`Piece`)으로 나눠 따진다. 조각 하나는 신원 정책 Allow의 리소스 패턴 하나이고,
//! 권한 경계가 있으면 그것과 경계 Allow의 패턴 하나가 겹치는 부분이다.

use super::pattern::{pattern_covers, patterns_overlap};
use super::{all_star, ActionEval, Source, SourceKind, Status, Verdict};
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

/// 리소스 범위 한 조각의 모양.
#[derive(Clone, Copy)]
enum Reach<'a> {
    /// 이 패턴에 맞는 리소스
    Pattern(&'a str),
    /// 모든 리소스에서 두 목록의 패턴에 맞는 것을 뺀 나머지(NotResource). 두 번째 목록은 신원 정책과 경계가 둘 다 NotResource일 때만 찬다
    AllBut(&'a [String], &'a [String]),
}

impl Reach<'_> {
    /// 화면에 적는 모양. NotResource는 `* (제외: …)`다.
    fn label(self) -> String {
        match self {
            Reach::Pattern(pattern) => pattern.to_owned(),
            Reach::AllBut(first, second) => {
                let mut excluded: Vec<&str> = Vec::new();
                for pattern in first.iter().chain(second) {
                    if !excluded.contains(&pattern.as_str()) {
                        excluded.push(pattern);
                    }
                }
                format!("* (제외: {})", excluded.join(", "))
            }
        }
    }

    /// 모든 리소스, 또는 NotResource 목록만 뺀 모든 리소스다.
    fn everywhere(self) -> bool {
        match self {
            Reach::Pattern(pattern) => all_star(pattern),
            Reach::AllBut(..) => true,
        }
    }
}

/// 허용 범위의 한 조각.
#[derive(Clone, Copy)]
struct Piece<'a> {
    reach: Reach<'a>,
    /// 조각을 연 문장(신원 정책 Allow, 경계가 있으면 경계 Allow도) 가운데 조건이 있는 것이 있다
    conditional: bool,
}

/// 문장들의 리소스 범위를 조각으로 편다. Resource가 없는 문장(신원·경계 정책에서는 쓸 수 없다)은 모든 리소스로 본다.
/// `*`를 빼는 NotResource는 남는 리소스가 없어서 조각을 만들지 않는다(신원 정책 Allow든 경계 Allow든 아무것도 열지 않는다).
fn pieces_of<'a>(hits: &[Hit<'a>]) -> Vec<Piece<'a>> {
    let mut out = Vec::new();
    for hit in hits {
        let stmt: &'a Statement = hit.stmt;
        let conditional = hit.conditional();
        match &stmt.resources {
            Resources::Resource(patterns) => out.extend(patterns.iter().map(|pattern| Piece { reach: Reach::Pattern(pattern), conditional })),
            Resources::NotResource(excluded) if excluded.iter().any(|e| all_star(e)) => {}
            Resources::NotResource(excluded) => out.push(Piece { reach: Reach::AllBut(excluded, &[]), conditional }),
            Resources::Unspecified => out.push(Piece { reach: Reach::Pattern("*"), conditional }),
        }
    }
    out
}

/// 조각들의 라벨(중복 없음, 나온 순서).
fn labels(pieces: &[Piece]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for piece in pieces {
        let label = piece.reach.label();
        if !out.contains(&label) {
            out.push(label);
        }
    }
    out
}

/// 패턴 `pattern`에서 제외 목록이 통째로 덮는 것을 뺀 나머지. 전부 제외되면 None, 일부만 제외되면 패턴을 그대로 남긴다.
fn pattern_without<'a>(pattern: &'a str, excluded: &'a [String]) -> Option<Reach<'a>> {
    if all_star(pattern) {
        Some(Reach::AllBut(excluded, &[]))
    } else if excluded.iter().any(|e| pattern_covers(e, pattern)) {
        None
    } else {
        Some(Reach::Pattern(pattern))
    }
}

/// 신원 정책 조각과 경계 조각의 교집합을 조각 하나로 근사한다. 겹치지 않으면 None. 두 조각은 문장 하나씩에서 나와 제외 목록이 하나씩이다.
/// 경계가 `*`면 신원 쪽, 신원이 `*`면 경계 쪽이 남고, 한쪽이 다른 쪽을 포함하면 좁은 쪽이 남는다.
/// 서로 일부만 겹치면 하나의 패턴으로 적을 수 없어 신원 쪽 패턴을 남긴다.
fn intersect<'a>(identity: Reach<'a>, limit: Reach<'a>) -> Option<Reach<'a>> {
    match (identity, limit) {
        (Reach::Pattern(p), Reach::Pattern(q)) => {
            if all_star(q) {
                Some(Reach::Pattern(p))
            } else if all_star(p) || pattern_covers(p, q) {
                Some(Reach::Pattern(q))
            } else if pattern_covers(q, p) || patterns_overlap(p, q) {
                Some(Reach::Pattern(p))
            } else {
                None
            }
        }
        (Reach::Pattern(p), Reach::AllBut(excluded, _)) | (Reach::AllBut(excluded, _), Reach::Pattern(p)) => pattern_without(p, excluded),
        (Reach::AllBut(x, _), Reach::AllBut(y, _)) => Some(Reach::AllBut(x, y)),
    }
}

/// Deny 문장이 조각 하나를 통째로 덮는지(그 조각의 모든 리소스에 적용되는지). 확실할 때만 true다.
/// NotResource Deny는 제외 목록 밖의 모든 리소스에 적용되니, 패턴 조각이 제외 목록과 하나도 겹치지 않을 때 덮는다.
/// NotResource 조각(`* (제외: …)`)은 모든 리소스를 막는 Deny만 덮는다.
fn deny_covers(deny: &Statement, reach: Reach) -> bool {
    match (&deny.resources, reach) {
        (Resources::Unspecified, _) => true,
        (Resources::Resource(patterns), Reach::Pattern(granted)) => patterns.iter().any(|d| pattern_covers(d, granted)),
        (Resources::Resource(patterns), Reach::AllBut(..)) => patterns.iter().any(|d| all_star(d)),
        (Resources::NotResource(excluded), Reach::Pattern(granted)) => !excluded.iter().any(|e| patterns_overlap(e, granted)),
        (Resources::NotResource(_), Reach::AllBut(..)) => false,
    }
}

/// 조건 없는 Deny가 통째로 덮은 조각을 뺀 나머지. 조각을 지운 Deny는 `killers`에 표시한다(`denies`와 같은 순서).
fn without_denied<'a>(pieces: &[Piece<'a>], denies: &[Hit], killers: &mut [bool]) -> Vec<Piece<'a>> {
    let mut left = Vec::new();
    for piece in pieces {
        let mut covered = false;
        for (deny, killer) in denies.iter().zip(killers.iter_mut()) {
            if !deny.conditional() && deny_covers(deny.stmt, piece.reach) {
                *killer = true;
                covered = true;
            }
        }
        if !covered {
            left.push(*piece);
        }
    }
    left
}

/// 판정의 재료.
struct Outcome {
    status: Status,
    resources: Vec<String>,
    /// `denies`와 같은 순서로, 판정에 걸린 Deny인지. 거부면 Allow를 지운 조건 없는 Deny, 조건부면 남은 조각을 덮는 조건 있는 Deny다
    applying: Vec<bool>,
    full_scope: bool,
}

/// 대상 리소스를 정했을 때. 맞은 문장이 모두 그 리소스에 적용되니 맞은 Deny는 모두 판정에 걸린다.
fn on_resource(allows: &[Hit], denies: &[Hit], boundary_allows: &[Hit], has_boundary: bool) -> Outcome {
    let status = if denies.iter().any(|d| !d.conditional()) {
        Status::Denied
    } else if has_boundary && boundary_allows.is_empty() {
        Status::Boundary
    } else if !denies.is_empty() || (has_boundary && boundary_allows.iter().all(Hit::conditional)) || allows.iter().all(Hit::conditional) {
        Status::Conditional
    } else {
        Status::Allowed
    };
    Outcome { status, resources: labels(&pieces_of(allows)), applying: vec![true; denies.len()], full_scope: false }
}

/// 대상 리소스를 정하지 않았을 때. 신원 정책 Allow의 조각들에서
/// 1. 조건 없는 Deny가 통째로 덮은 조각을 지운다. 남는 것이 없으면 거부
/// 2. 권한 경계가 있으면 남은 조각을 경계 Allow의 조각과 하나씩 겹친다. 경계가 이 작업을 허용하지 않거나 겹치는 것이 없으면 경계 차단
/// 3. 겹친 조각에 조건 없는 Deny를 다시 적용한다(경계가 좁힌 범위는 Deny가 다 덮을 수 있다). 남는 것이 없으면 거부
/// 4. 조건 없는 조각 가운데 조건 있는 Deny도 덮지 않은 것이 있으면 허용, 없으면 조건부
///
/// Allow가 리소스를 하나도 적지 않았으면(`Resource: []`) 허용하는 곳이 없어 None이다.
fn on_pieces(allows: &[Hit], denies: &[Hit], boundary_allows: &[Hit], has_boundary: bool) -> Option<Outcome> {
    let granted = pieces_of(allows);
    if granted.is_empty() {
        return None;
    }
    let mut killers = vec![false; denies.len()];
    let denied = |killers: Vec<bool>| Outcome { status: Status::Denied, resources: labels(&granted), applying: killers, full_scope: false };
    let identity = without_denied(&granted, denies, &mut killers);
    if identity.is_empty() {
        return Some(denied(killers));
    }
    let left = if has_boundary {
        let limits = pieces_of(boundary_allows);
        let mut narrowed = Vec::new();
        for piece in &identity {
            for limit in &limits {
                if let Some(reach) = intersect(piece.reach, limit.reach) {
                    narrowed.push(Piece { reach, conditional: piece.conditional || limit.conditional });
                }
            }
        }
        if narrowed.is_empty() {
            return Some(Outcome { status: Status::Boundary, resources: labels(&identity), applying: vec![false; denies.len()], full_scope: false });
        }
        let left = without_denied(&narrowed, denies, &mut killers);
        if left.is_empty() {
            return Some(denied(killers));
        }
        left
    } else {
        identity
    };

    let soft_covers = |deny: &Hit, piece: &Piece| deny.conditional() && deny_covers(deny.stmt, piece.reach);
    let open: Vec<&Piece> = left.iter().filter(|piece| !piece.conditional && !denies.iter().any(|d| soft_covers(d, piece))).collect();
    let status = if open.is_empty() { Status::Conditional } else { Status::Allowed };
    let applying = denies.iter().map(|d| status == Status::Conditional && left.iter().any(|piece| soft_covers(d, piece))).collect();
    let full_scope = open.iter().any(|piece| piece.reach.everywhere());
    Some(Outcome { status, resources: labels(&left), applying, full_scope })
}

/// 판정에 걸린 문장들. 거부면 판정에 걸린 Deny가 맨 앞에, 아니면 Allow 다음에 오고, 경계 Allow는 맨 뒤다.
fn grant_sources(outcome: &Outcome, allows: &[Hit], denies: &[Hit], boundary_allows: &[Hit]) -> Vec<GrantSource> {
    let (mut applying, mut partial): (Vec<Hit>, Vec<Hit>) = (Vec::new(), Vec::new());
    for (deny, applies) in denies.iter().zip(&outcome.applying) {
        if *applies {
            applying.push(*deny);
        } else {
            partial.push(*deny);
        }
    }
    let groups: [&[Hit]; 4] =
        if outcome.status == Status::Denied { [&applying, &partial, allows, boundary_allows] } else { [allows, &applying, &partial, boundary_allows] };
    groups.iter().flat_map(|group| group.iter()).map(Hit::grant_source).collect()
}

/// 맞은 문장들로 판정한다. 우선순위: Allow 없음 → 제외(None), 조건 없는 Deny → 거부, 권한 경계, 조건 → 조건부, 그 외 허용.
/// 경계 정책의 Deny도 Deny다. `resource_given`이면 맞은 문장이 모두 그 리소스에 적용되고(`on_resource`),
/// 아니면 리소스 범위를 조각으로 나눠 따진다(`on_pieces`).
/// `with_sources`가 false이면 `sources`를 채우지 않는다(권한 표처럼 근거가 필요 없는 곳에서 문자열 복사를 아낀다).
pub(super) fn decide(identity: &[Hit], boundary: &[Hit], has_boundary: bool, resource_given: bool, with_sources: bool) -> Option<Verdict> {
    let allows: Vec<Hit> = identity.iter().filter(|h| h.stmt.effect == Effect::Allow).copied().collect();
    if allows.is_empty() {
        return None;
    }
    let denies: Vec<Hit> = identity.iter().chain(boundary).filter(|h| h.stmt.effect == Effect::Deny).copied().collect();
    let boundary_allows: Vec<Hit> = boundary.iter().filter(|h| h.stmt.effect == Effect::Allow).copied().collect();
    let outcome = if resource_given {
        on_resource(&allows, &denies, &boundary_allows, has_boundary)
    } else {
        on_pieces(&allows, &denies, &boundary_allows, has_boundary)?
    };
    let sources = if with_sources { grant_sources(&outcome, &allows, &denies, &boundary_allows) } else { Vec::new() };
    let full_scope = outcome.full_scope;
    Some(Verdict { eval: ActionEval { status: outcome.status, resources: outcome.resources, sources }, full_scope })
}
