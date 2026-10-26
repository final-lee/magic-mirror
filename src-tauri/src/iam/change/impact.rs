//! 영향 계산: 변경 전후의 권한(`evaluate`)을 영향받는 주체마다 비교해 서비스·접근 수준 단위의 증감으로 모은다.
//! 작업 하나가 "허용"인지는 판정(`Status`)만 본다: 허용·조건부 허용이면 쓸 수 있는 것이고, 거부·권한 경계 차단이거나 허용 문장이 없으면 못 쓰는 것이다.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::Serialize;

use super::IamChange;
use crate::iam::catalog::AccessLevel;
use crate::iam::danger::privesc_reasons;
use crate::iam::eval::{evaluate, ActionEval, PrincipalEval, Status};
use crate::iam::model::Snapshot;
use crate::iam::summary::principal_summary;
use crate::iam::view::PrincipalSummary;

/// 한 번에 계산하는 주체 수의 한도. 넘으면 앞에서부터 이만큼만 계산한다.
pub(super) const MAX_AFFECTED: usize = 50;
/// 증감마다 보여 주는 작업 이름 수.
pub(super) const SAMPLE: usize = 5;

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
pub struct Impact {
    pub principal: PrincipalSummary,
    /// 새로 허용(또는 조건부 허용)된 작업
    pub gained: Vec<PermDelta>,
    /// 더는 허용되지 않는 작업
    pub lost: Vec<PermDelta>,
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
    /// 영향받는 주체가 한도를 넘어 일부만 계산했다
    pub truncated: bool,
}

/// 순서를 지키면서 중복 없이 ARN을 모은다.
#[derive(Default)]
struct Ordered {
    list: Vec<String>,
    seen: HashSet<String>,
}

impl Ordered {
    fn push(&mut self, arn: &str) {
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

/// (얻은 것, 잃은 것). 작업 이름은 `evaluate`의 순서(접두어, 작업)대로 훑으므로 `sample`은 이름순 앞쪽이다.
fn deltas(before: &PrincipalEval, after: &PrincipalEval) -> (Vec<PermDelta>, Vec<PermDelta>) {
    let (mut gained, mut lost) = (Buckets::default(), Buckets::default());
    for (key, entry) in &before.actions {
        if usable(Some(entry)) && !usable(after.actions.get(key)) {
            lost.add(key, entry.0);
        }
    }
    for (key, entry) in &after.actions {
        if usable(Some(entry)) && !usable(before.actions.get(key)) {
            gained.add(key, entry.0);
        }
    }
    (gained.finish(), lost.finish())
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
    for arn in &affected {
        let (Some(was), Some(now)) = (evaluate(before, arn), evaluate(after, arn)) else {
            continue;
        };
        let (gained, lost) = deltas(&was, &now);
        // 관리자급은 `evaluate`가 최종 판정까지 본 값이다. 관리자급이 되면 권한 상승은 따로 말하지 않는다
        if !was.admin_like && now.admin_like {
            out.newly_admin.push(arn.clone());
        } else if !was.admin_like && !now.admin_like && !privesc_reasons(after, arn).is_empty() && privesc_reasons(before, arn).is_empty() {
            out.newly_privesc.push(arn.clone());
        }
        unknown.extend(now.unknown.iter().filter(|pattern| !was.unknown.contains(pattern)).cloned());
        if caller == Some(arn.as_str()) && !lost.is_empty() {
            out.caller_lost = true;
        }
        if gained.is_empty() && lost.is_empty() {
            continue;
        }
        if let Some(principal) = principal_summary(before, arn) {
            out.impacts.push(Impact { principal, gained, lost });
        }
    }
    out.new_unknown = unknown.into_iter().collect();
    out
}
