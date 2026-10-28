//! 영향 계산: 변경 전후의 권한(`evaluate`)을 영향받는 주체마다 비교해 서비스·접근 수준 단위의 증감으로 모은다.
//! 작업 하나가 "허용"인지는 판정(`Status`)만 본다: 허용·조건부 허용이면 쓸 수 있는 것이고, 거부·권한 경계 차단이거나 허용 문장이 없으면 못 쓰는 것이다.
//! 허용이던 작업이 조건부가 되면(예: MFA가 없으면 거부하는 Deny) 잃은 것은 아니지만 조건에 따라 막힐 수 있으니 따로 센다(`restricted`).
//! 문서를 읽지 못한 정책은 계산에서 빠지므로, 그런 정책이 붙거나 떨어지면 증감을 다 계산하지 못한 것으로 따로 모은다(`unreadable_changed`).
//! 앱이 쓰는 자격 증명의 주체는 그런 정책이 그대로 남아도 따로 모은다(`caller_unreadable_kept`): 그 정책 위에 Deny를 더하면 그 정책이
//! 주던 권한을 잃는데, 계산에 없는 권한이라 잃는 것으로 나오지 않는다.
//! 화면으로 보내는 양은 줄인다: 증감마다 작업이 많은 줄 `MAX_ROWS`개, 주체는 `MAX_SHOWN`명까지 자세히 보내고 나머지는 수만 센다.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::Serialize;

use super::IamChange;
use crate::iam::catalog::AccessLevel;
use crate::iam::danger::privesc_reasons;
use crate::iam::eval::{evaluate, policy_sources, ActionEval, PrincipalEval, Status};
use crate::iam::model::Snapshot;
use crate::iam::summary::principal_summary;
use crate::iam::view::PrincipalSummary;

/// 한 번에 계산하는 주체 수의 한도. 넘으면 앞에서부터 이만큼만 계산한다.
pub(super) const MAX_AFFECTED: usize = 50;
/// 증감마다 보여 주는 작업 이름 수.
pub(super) const SAMPLE: usize = 5;
/// 주체 하나의 증감(얻음·잃음·조건부로 바뀜)마다 보내는 (서비스, 접근 수준) 줄 수의 한도.
pub(super) const MAX_ROWS: usize = 20;
/// 증감을 자세히 보내는 주체 수의 한도. 넘는 주체는 수만 보낸다(`ChangePreview::impacts_omitted`).
pub(super) const MAX_SHOWN: usize = 30;

/// 한 서비스(`prefix`)의 한 접근 수준에서 허용·조건부가 된(또는 안 된) 작업 수와 그 일부.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PermDelta {
    pub prefix: String,
    pub level: AccessLevel,
    pub count: usize,
    /// 작업 이름(`s3:GetObject`) 최대 5개
    pub sample: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Impact {
    pub principal: PrincipalSummary,
    /// 새로 허용(또는 조건부 허용)된 작업
    pub gained: Vec<PermDelta>,
    /// 더는 허용되지 않는 작업
    pub lost: Vec<PermDelta>,
    /// 조건 없이 허용되다가 조건부가 된 작업. 없으면 보내지 않는다(계약에 더한 선택 필드)
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub restricted: Vec<PermDelta>,
    /// 한도(`MAX_ROWS`)를 넘어 빼고 보낸 줄 수. 0이면 보내지 않는다
    #[serde(skip_serializing_if = "is_zero")]
    pub gained_omitted: usize,
    #[serde(skip_serializing_if = "is_zero")]
    pub lost_omitted: usize,
    #[serde(skip_serializing_if = "is_zero")]
    pub restricted_omitted: usize,
}

pub(super) fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// 영향 계산 결과. 경고 규칙이 쓰는 값을 함께 모았다.
#[derive(Debug, Default)]
pub(super) struct Analysis {
    /// 권한이 달라진 주체만, 영향받는 순서대로
    pub impacts: Vec<Impact>,
    /// 새로 관리자급이 된 주체(ARN)
    pub newly_admin: Vec<String>,
    /// 새로 권한 상승 위험이 생긴 주체(ARN). 관리자급이 된 주체는 제외
    pub newly_privesc: Vec<String>,
    /// 변경 때문에 새로 생긴, 카탈로그에 없는 작업 패턴
    pub new_unknown: Vec<String>,
    /// 앱이 쓰는 자격 증명의 주체가 권한을 잃는다
    pub caller_lost: bool,
    /// 앱이 쓰는 자격 증명의 주체가 조건 없이 쓰던 작업이 조건부가 된다
    pub caller_restricted: bool,
    /// 그 밖에 조건 없이 쓰던 작업이 조건부가 되는 사용자·역할 수. 그룹은 세지 않는다(로그인하지 않고, 구성원이 따로 세어진다)
    pub restricted_others: usize,
    /// 문서를 읽지 못해 계산에서 빠지는 정책(`unreadable_of`) 가운데 이 변경으로 영향받는 주체에게 새로 적용되거나 더는 적용되지 않는 것의 이름.
    /// 그 정책이 주던(또는 줄) 권한을 몰라서 증감을 다 계산하지 못했다
    pub unreadable_changed: Vec<String>,
    /// 앱이 쓰는 자격 증명의 주체가 영향받는데, 문서를 읽지 못한 정책이 그 주체에게 변경 전후에 그대로 적용된다: 그 이름
    /// (`unreadable_changed`에 든 것은 뺀다). 그 정책이 주는 권한을 몰라서 이 앱이 무엇을 잃는지 다 계산하지 못한다
    pub caller_unreadable_kept: Vec<String>,
    /// 앱이 쓰는 자격 증명의 주체가 영향받는데 그 주체에게 문서를 읽지 못한 정책이 있다(새로 붙거나, 떨어지거나, 그대로 남거나).
    /// 그 정책이 되돌리는 데 필요한 권한을 주는지(또는 막는지) 몰라서 되돌릴 수 있다고 말하지 않는다
    pub caller_unreadable: bool,
    /// 문서를 읽지 못해 계산에서 빠지는데 변경 전후에 그대로 적용되는 정책의 이름(`unreadable_changed`·`caller_unreadable_kept`에 든 것은 뺀다)
    pub unreadable_kept: Vec<String>,
    /// 영향받는 주체가 한도를 넘어 일부만 계산했다
    pub truncated: bool,
}

/// 순서를 지키면서 중복 없이 ARN을 모은다.
#[derive(Default)]
pub(super) struct Ordered {
    pub(super) list: Vec<String>,
    seen: HashSet<String>,
}

impl Ordered {
    pub(super) fn push(&mut self, arn: &str) {
        if self.seen.insert(arn.to_string()) {
            self.list.push(arn.to_string());
        }
    }

    /// 사용자·역할은 자기 자신, 그룹은 그룹과 구성원. 스냅숏에 없으면 아무것도 넣지 않는다.
    fn principal_with_members(&mut self, s: &Snapshot, arn: &str) {
        if let Some(group) = s.groups.iter().find(|g| g.arn == arn) {
            self.push(&group.arn);
            for user in s.users.iter().filter(|u| u.groups.contains(&group.name)) {
                self.push(&user.arn);
            }
        } else if s.principal_kind(arn).is_some() {
            self.push(arn);
        }
    }

    /// 관리형 정책을 붙였거나 권한 경계로 쓰는 사용자·그룹·역할(이 순서), 그리고 그것을 붙인 그룹의 구성원.
    fn holders(&mut self, s: &Snapshot, policy_arn: &str) {
        let uses = |attached: &[String], boundary: Option<&str>| attached.iter().any(|a| a == policy_arn) || boundary == Some(policy_arn);
        for user in s.users.iter().filter(|u| uses(&u.attached, u.boundary.as_deref())) {
            self.push(&user.arn);
        }
        for group in s.groups.iter().filter(|g| uses(&g.attached, None)) {
            self.push(&group.arn);
        }
        for role in s.roles.iter().filter(|r| uses(&r.attached, r.boundary.as_deref())) {
            self.push(&role.arn);
        }
        for group in s.groups.iter().filter(|g| uses(&g.attached, None)) {
            for user in s.users.iter().filter(|u| u.groups.contains(&group.name)) {
                self.push(&user.arn);
            }
        }
    }
}

/// 순서를 지키면서 키마다 처음 나온 (키, 이름) 하나만 모은다.
#[derive(Default)]
struct Labels {
    items: Vec<(String, String)>,
    keys: HashSet<String>,
}

impl Labels {
    fn push(&mut self, key: &str, label: &str) {
        if self.keys.insert(key.to_string()) {
            self.items.push((key.to_string(), label.to_string()));
        }
    }

    /// `except`에 든 키를 뺀 이름들.
    fn names_except(self, except: &HashSet<String>) -> Vec<String> {
        self.items.into_iter().filter(|(key, _)| !except.contains(key)).map(|(_, label)| label).collect()
    }
}

/// 주체에게 적용되는데 문서를 읽지 못해 계산에서 빠지는 것: 문서가 없는 신원 정책과 권한 경계, 그리고 스냅숏에 없는 소속 그룹(그 그룹의
/// 정책을 모른다). (구별 키, 화면 이름) 목록이다. 같은 정책이 직접과 그룹으로 겹쳐 적용돼도 키는 하나다(같은 문서라 하나만 빠져도 같다).
fn unreadable_of(s: &Snapshot, arn: &str) -> Vec<(String, String)> {
    let (sources, boundary) = policy_sources(s, arn);
    let mut out: Vec<(String, String)> = Vec::new();
    let mut add = |key: String, label: String| {
        if !out.iter().any(|(seen, _)| *seen == key) {
            out.push((key, label));
        }
    };
    for src in sources.iter().filter(|src| src.document.is_none()) {
        let label = match &src.via {
            Some(group) => format!("{} ({group} 그룹)", src.name),
            None => src.name.clone(),
        };
        add(src.id.clone(), label);
    }
    if let Some(b) = boundary.filter(|b| b.document.is_none()) {
        add(format!("boundary:{}", b.id), format!("{} (권한 경계)", b.name));
    }
    if let Some(user) = s.users.iter().find(|u| u.arn == arn) {
        for name in user.groups.iter().filter(|name| s.group(name).is_none()) {
            add(format!("group:{name}"), format!("{name} 그룹의 정책"));
        }
    }
    out
}

/// 변경으로 권한이 달라질 수 있는 주체(ARN)를 직접 영향받는 것부터 순서대로.
/// 사용자·역할은 자기 자신, 그룹은 그룹과 구성원, 관리형 정책은 그것을 붙였거나 권한 경계로 쓰는 주체와 그 그룹의 구성원이다.
/// 액세스 키 변경은 권한을 바꾸지 않는다.
pub(super) fn affected(s: &Snapshot, c: &IamChange) -> Vec<String> {
    let mut out = Ordered::default();
    match c {
        IamChange::AttachPolicy { target, .. }
        | IamChange::DetachPolicy { target, .. }
        | IamChange::PutInlinePolicy { target, .. }
        | IamChange::DeleteInlinePolicy { target, .. } => out.principal_with_members(s, target),
        IamChange::AddToGroup { user_name, .. } | IamChange::RemoveFromGroup { user_name, .. } => {
            if let Some(user) = s.user(user_name) {
                out.push(&user.arn);
            }
        }
        IamChange::SetAccessKeyStatus { .. } | IamChange::DeleteAccessKey { .. } => {}
        IamChange::UpdateManagedPolicy { policy_arn, .. } => out.holders(s, policy_arn),
    }
    out.list
}

/// 증감을 (서비스 접두어, 접근 수준)별로 센다. 계산 결과에서 이름을 빌려 쓰고, 보여 줄 작업 이름은 앞의 `SAMPLE`개만 만든다.
#[derive(Default)]
struct Buckets<'a> {
    map: BTreeMap<(&'a str, AccessLevel), (usize, Vec<String>)>,
}

impl<'a> Buckets<'a> {
    fn add(&mut self, key: &'a (String, String), level: AccessLevel) {
        let (count, sample) = self.map.entry((key.0.as_str(), level)).or_default();
        *count += 1;
        if sample.len() < SAMPLE {
            sample.push(format!("{}:{}", key.0, key.1));
        }
    }

    fn finish(self) -> Vec<PermDelta> {
        self.map.into_iter().map(|((prefix, level), (count, sample))| PermDelta { prefix: prefix.to_string(), level, count, sample }).collect()
    }
}

fn usable(entry: Option<&(AccessLevel, ActionEval)>) -> bool {
    entry.is_some_and(|(_, eval)| matches!(eval.status, Status::Allowed | Status::Conditional))
}

fn status_of(entry: Option<&(AccessLevel, ActionEval)>) -> Option<Status> {
    entry.map(|(_, eval)| eval.status)
}

/// 주체 하나의 증감. 줄은 (접두어, 접근 수준) 순서다.
struct Deltas {
    gained: Vec<PermDelta>,
    lost: Vec<PermDelta>,
    restricted: Vec<PermDelta>,
}

impl Deltas {
    fn is_empty(&self) -> bool {
        self.gained.is_empty() && self.lost.is_empty() && self.restricted.is_empty()
    }
}

/// 얻은 것, 잃은 것, 허용에서 조건부로 바뀐 것. 작업 이름은 `evaluate`의 순서(접두어, 작업)대로 훑으므로 `sample`은 이름순 앞쪽이다.
fn deltas(before: &PrincipalEval, after: &PrincipalEval) -> Deltas {
    let (mut gained, mut lost, mut restricted) = (Buckets::default(), Buckets::default(), Buckets::default());
    for (key, entry) in &before.actions {
        let now = after.actions.get(key);
        if usable(Some(entry)) && !usable(now) {
            lost.add(key, entry.0);
        } else if entry.1.status == Status::Allowed && status_of(now) == Some(Status::Conditional) {
            restricted.add(key, entry.0);
        }
    }
    for (key, entry) in &after.actions {
        if usable(Some(entry)) && !usable(before.actions.get(key)) {
            gained.add(key, entry.0);
        }
    }
    Deltas { gained: gained.finish(), lost: lost.finish(), restricted: restricted.finish() }
}

/// 줄이 한도(`MAX_ROWS`)를 넘으면 작업이 많은 줄만 남기고(같으면 앞선 줄) 뺀 줄 수를 센다. 남긴 줄은 원래 순서를 지킨다.
pub(super) fn capped(rows: Vec<PermDelta>) -> (Vec<PermDelta>, usize) {
    if rows.len() <= MAX_ROWS {
        return (rows, 0);
    }
    let omitted = rows.len() - MAX_ROWS;
    let mut ranked: Vec<(usize, PermDelta)> = rows.into_iter().enumerate().collect();
    ranked.sort_by(|(i, a), (j, b)| b.count.cmp(&a.count).then(i.cmp(j)));
    ranked.truncate(MAX_ROWS);
    ranked.sort_by_key(|(i, _)| *i);
    (ranked.into_iter().map(|(_, row)| row).collect(), omitted)
}

/// 화면으로 보낼 영향: 앞에서부터 `MAX_SHOWN`명. 앱이 쓰는 주체가 그 뒤에 있으면 맨 앞으로 옮긴다. (보낼 것, 뺀 주체 수)
pub(super) fn shown(mut impacts: Vec<Impact>, caller: Option<&str>) -> (Vec<Impact>, usize) {
    if impacts.len() <= MAX_SHOWN {
        return (impacts, 0);
    }
    if let Some(at) = caller.and_then(|c| impacts.iter().position(|i| i.principal.arn == c)).filter(|at| *at >= MAX_SHOWN) {
        let first = impacts.remove(at);
        impacts.insert(0, first);
    }
    let omitted = impacts.len() - MAX_SHOWN;
    impacts.truncate(MAX_SHOWN);
    (impacts, omitted)
}

fn impact(principal: PrincipalSummary, d: Deltas) -> Impact {
    let (gained, gained_omitted) = capped(d.gained);
    let (lost, lost_omitted) = capped(d.lost);
    let (restricted, restricted_omitted) = capped(d.restricted);
    Impact { principal, gained, lost, restricted, gained_omitted, lost_omitted, restricted_omitted }
}

/// `affected` 주체마다 `before`와 `after`의 권한을 비교한다. 앱이 쓰는 주체(`caller`)는 한도를 넘어도 반드시 계산한다.
pub(super) fn analyze(before: &Snapshot, after: &Snapshot, mut affected: Vec<String>, caller: Option<&str>) -> Analysis {
    let truncated = affected.len() > MAX_AFFECTED;
    if truncated {
        if let Some(at) = caller.and_then(|c| affected.iter().position(|a| a == c)) {
            let first = affected.remove(at);
            affected.insert(0, first);
        }
        affected.truncate(MAX_AFFECTED);
    }

    let mut out = Analysis { truncated, ..Default::default() };
    let mut unknown = BTreeSet::new();
    let (mut unreadable_changed, mut unreadable_kept, mut caller_kept) = (Labels::default(), Labels::default(), Labels::default());
    for arn in &affected {
        let is_caller = caller == Some(arn.as_str());
        // 읽지 못한 정책은 아래 권한 계산에서 빠진다. 그런 정책이 붙거나 떨어지면 계산한 증감이 전부가 아니다
        let (was_unreadable, now_unreadable) = (unreadable_of(before, arn), unreadable_of(after, arn));
        if is_caller && !(was_unreadable.is_empty() && now_unreadable.is_empty()) {
            out.caller_unreadable = true;
        }
        for (key, label) in &was_unreadable {
            if !now_unreadable.iter().any(|(other, _)| other == key) {
                unreadable_changed.push(key, label);
                continue;
            }
            unreadable_kept.push(key, label);
            // 앱의 자격 증명에게는 그대로 남는 것도 따로 센다: 그 정책 위에 Deny를 더하면 그 정책이 주던 권한을 잃는데 계산에는 나오지 않는다
            if is_caller {
                caller_kept.push(key, label);
            }
        }
        for (key, label) in now_unreadable.iter().filter(|(key, _)| !was_unreadable.iter().any(|(other, _)| other == key)) {
            unreadable_changed.push(key, label);
        }
        let (Some(was), Some(now)) = (evaluate(before, arn), evaluate(after, arn)) else {
            continue;
        };
        let d = deltas(&was, &now);
        // 관리자급은 `evaluate`가 최종 판정까지 본 값이다. 관리자급이 되면 권한 상승은 따로 말하지 않는다
        if !was.admin_like && now.admin_like {
            out.newly_admin.push(arn.clone());
        } else if !was.admin_like && !now.admin_like && !privesc_reasons(after, arn).is_empty() && privesc_reasons(before, arn).is_empty() {
            out.newly_privesc.push(arn.clone());
        }
        unknown.extend(now.unknown.iter().filter(|pattern| !was.unknown.contains(pattern)).cloned());
        if is_caller && !d.lost.is_empty() {
            out.caller_lost = true;
        }
        if !d.restricted.is_empty() {
            if is_caller {
                out.caller_restricted = true;
            } else if before.principal_kind(arn) != Some("group") {
                out.restricted_others += 1;
            }
        }
        if d.is_empty() {
            continue;
        }
        if let Some(principal) = principal_summary(before, arn) {
            out.impacts.push(impact(principal, d));
        }
    }
    out.new_unknown = unknown.into_iter().collect();
    // 정책 하나는 한 번만 말한다. 어떤 주체에게는 그대로이고 다른 주체에게는 새로 붙는 정책(그룹에 붙이는데 구성원 하나는 이미 직접
    // 받았다 등)은 바뀐 쪽으로만, 앱의 자격 증명에게 그대로 남는 정책은 그쪽으로만 센다
    let mut told = unreadable_changed.keys.clone();
    told.extend(caller_kept.keys.iter().cloned());
    out.unreadable_kept = unreadable_kept.names_except(&told);
    out.caller_unreadable_kept = caller_kept.names_except(&unreadable_changed.keys);
    out.unreadable_changed = unreadable_changed.names_except(&HashSet::new());
    out
}
