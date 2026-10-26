//! 변경을 적용한 뒤의 가상 스냅숏. 영향 계산(적용 전후의 권한 비교)에만 쓰고, 실제 IAM에는 아무것도 하지 않는다.
//! 권한 계산에 쓰이지 않는 값(정책의 `attachment_count`, `versions` 등)은 갱신하지 않는다.

use super::text::{policy_name, principal_label};
use super::IamChange;
use crate::iam::eval::find_principal;
use crate::iam::model::{InlinePolicy, Snapshot};
use crate::iam::policy::parse_document;

/// 이 사용자·그룹·역할에 직접 붙은 관리형 정책인지(그룹에서 상속한 것은 아니다).
pub(super) fn is_attached(s: &Snapshot, target: &str, policy_arn: &str) -> bool {
    find_principal(s, target).is_some_and(|p| p.attached().iter().any(|a| a == policy_arn))
}

/// 사용자가 그룹의 구성원인지. 이름으로 찾는다(IAM 사용자·그룹 이름은 계정 안에서 유일하다).
pub(super) fn is_member(s: &Snapshot, user_name: &str, group_name: &str) -> bool {
    let group = s.group(group_name).map_or(group_name, |g| g.name.as_str());
    s.user(user_name).is_some_and(|u| u.groups.iter().any(|g| g == group))
}

/// 인라인 정책 이름은 대소문자를 구분하지 않는다(IAM의 다른 이름들과 같다).
fn same_name(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// 사용자·그룹·역할(ARN)에 붙은 인라인 정책.
pub(super) fn inline_policy<'a>(s: &'a Snapshot, target: &str, name: &str) -> Option<&'a InlinePolicy> {
    find_principal(s, target)?.inline().iter().find(|p| same_name(&p.name, name))
}

/// 사용자·그룹·역할(ARN)의 (붙은 관리형 정책, 인라인 정책) 목록.
fn lists<'a>(s: &'a mut Snapshot, arn: &str) -> Option<(&'a mut Vec<String>, &'a mut Vec<InlinePolicy>)> {
    if let Some(u) = s.users.iter_mut().find(|u| u.arn == arn) {
        return Some((&mut u.attached, &mut u.inline));
    }
    if let Some(g) = s.groups.iter_mut().find(|g| g.arn == arn) {
        return Some((&mut g.attached, &mut g.inline));
    }
    if let Some(r) = s.roles.iter_mut().find(|r| r.arn == arn) {
        return Some((&mut r.attached, &mut r.inline));
    }
    None
}

/// 변경이 붙이려는 관리형 정책의 문서를 스냅숏에서 얻을 수 없으면 그 ARN(스냅숏에 없거나 문서를 읽지 못한 정책).
/// 스냅숏에는 어딘가에 붙은 정책만 있으므로, 영향을 계산하려면 이 정책의 문서를 따로 읽어 스냅숏에 넣어야 한다.
pub fn missing_policy<'a>(s: &Snapshot, c: &'a IamChange) -> Option<&'a str> {
    match c {
        IamChange::AttachPolicy { policy_arn, .. } if s.policies.get(policy_arn).and_then(|rec| rec.document.as_ref()).is_none() => Some(policy_arn),
        _ => None,
    }
}

fn unknown_principal(arn: &str) -> String {
    format!("알 수 없는 사용자·그룹·역할이에요: {arn}")
}

fn unknown_user(name: &str) -> String {
    format!("알 수 없는 사용자예요: {name}")
}

/// 변경을 적용한 뒤의 스냅숏. 이 변경이 지금 상태에서 성립하지 않으면(없는 대상, 붙어 있지 않은 정책을 떼기, 구성원이 아닌 사용자를 빼기,
/// 없는 인라인 정책 삭제, 읽을 수 없는 정책 문서) 이유(한국어)를 오류로 돌려준다. 이미 그렇게 돼 있는 변경(이미 붙은 정책을 붙이기)은 그대로 성공한다.
pub fn apply_to_snapshot(s: &Snapshot, c: &IamChange) -> Result<Snapshot, String> {
    let mut next = s.clone();
    match c {
        IamChange::AttachPolicy { target, policy_arn } => {
            let (attached, _) = lists(&mut next, target).ok_or_else(|| unknown_principal(target))?;
            if !attached.contains(policy_arn) {
                attached.push(policy_arn.clone());
            }
        }
        IamChange::DetachPolicy { target, policy_arn } => {
            let (attached, _) = lists(&mut next, target).ok_or_else(|| unknown_principal(target))?;
            let before = attached.len();
            attached.retain(|a| a != policy_arn);
            if attached.len() == before {
                return Err(format!("{}에 직접 붙어 있지 않은 정책이에요: {}", principal_label(s, target), policy_name(s, policy_arn)));
            }
        }
        IamChange::AddToGroup { user_name, group_name } => {
            let user = next.users.iter_mut().find(|u| u.name == *user_name || u.arn == *user_name).ok_or_else(|| unknown_user(user_name))?;
            let group = s.group(group_name).ok_or_else(|| format!("알 수 없는 그룹이에요: {group_name}"))?;
            if !user.groups.contains(&group.name) {
                user.groups.push(group.name.clone());
            }
        }
        IamChange::RemoveFromGroup { user_name, group_name } => {
            let user = next.users.iter_mut().find(|u| u.name == *user_name || u.arn == *user_name).ok_or_else(|| unknown_user(user_name))?;
            let group = s.group(group_name).map_or(group_name.as_str(), |g| g.name.as_str());
            let before = user.groups.len();
            user.groups.retain(|g| g != group);
            if user.groups.len() == before {
                return Err(format!("그룹 {group_name}의 구성원이 아닌 사용자예요: {user_name}"));
            }
        }
        IamChange::SetAccessKeyStatus { user_name, .. } | IamChange::DeleteAccessKey { user_name, .. } => {
            // 액세스 키는 스냅숏에 없고 권한에도 영향이 없다. 사용자만 확인한다
            s.user(user_name).ok_or_else(|| unknown_user(user_name))?;
        }
        IamChange::PutInlinePolicy { target, name, document } => {
            let parsed = parse_document(document)?;
            let (_, inline) = lists(&mut next, target).ok_or_else(|| unknown_principal(target))?;
            let policy = InlinePolicy { name: name.clone(), raw: document.clone(), document: Some(parsed) };
            match inline.iter_mut().find(|p| same_name(&p.name, name)) {
                Some(existing) => *existing = policy,
                None => inline.push(policy),
            }
        }
        IamChange::DeleteInlinePolicy { target, name } => {
            let (_, inline) = lists(&mut next, target).ok_or_else(|| unknown_principal(target))?;
            let before = inline.len();
            inline.retain(|p| !same_name(&p.name, name));
            if inline.len() == before {
                return Err(format!("인라인 정책을 찾을 수 없어요: {name}"));
            }
        }
        IamChange::UpdateManagedPolicy { policy_arn, document } => {
            let parsed = parse_document(document)?;
            let rec = next.policies.get_mut(policy_arn).ok_or_else(|| format!("정책을 찾을 수 없어요: {policy_arn}"))?;
            rec.raw = Some(document.clone());
            rec.document = Some(parsed);
        }
    }
    Ok(next)
}
