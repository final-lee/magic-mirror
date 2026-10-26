//! 화면에 나가는 변경 문구: 한 줄 요약과 확인 문구. 받침에 따라 달라지는 조사(을/를, 이/가)는 쓰지 않는다: 이름이 영문일 때가 많아 맞게 고를 수 없다.

use super::state::inline_policy;
use super::IamChange;
use crate::iam::eval::find_principal;
use crate::iam::model::Snapshot;
use crate::iam::view::PrincipalKind;

/// ARN의 마지막 조각(`.../role/ops/deploy` → `deploy`).
fn last_segment(arn: &str) -> &str {
    arn.rsplit('/').next().unwrap_or(arn)
}

/// 사용자는 이름만, 그룹·역할은 "admins 그룹"·"deploy 역할"처럼 종류를 붙인다. 스냅숏에 없으면 ARN의 마지막 조각.
pub(super) fn principal_label(s: &Snapshot, arn: &str) -> String {
    match find_principal(s, arn) {
        Some(p) => match p.kind() {
            PrincipalKind::User => p.name().to_string(),
            PrincipalKind::Group => format!("{} 그룹", p.name()),
            PrincipalKind::Role => format!("{} 역할", p.name()),
        },
        None => last_segment(arn).to_string(),
    }
}

/// 관리형 정책 이름. 스냅숏에 없으면 ARN의 마지막 조각.
pub(super) fn policy_name(s: &Snapshot, arn: &str) -> String {
    s.policies.get(arn).map_or_else(|| last_segment(arn).to_string(), |p| p.name.clone())
}

fn key_action(status: &str) -> String {
    match status {
        "Active" => "활성화하기".to_string(),
        "Inactive" => "비활성화하기".to_string(),
        other => format!("상태 바꾸기: {other}"),
    }
}

/// 변경 한 줄 요약(예: "alice에서 AdministratorAccess 떼기").
pub fn describe(s: &Snapshot, c: &IamChange) -> String {
    match c {
        IamChange::AttachPolicy { target, policy_arn } => format!("{}에 {} 붙이기", principal_label(s, target), policy_name(s, policy_arn)),
        IamChange::DetachPolicy { target, policy_arn } => format!("{}에서 {} 떼기", principal_label(s, target), policy_name(s, policy_arn)),
        IamChange::AddToGroup { user_name, group_name } => format!("{group_name} 그룹에 {user_name} 추가하기"),
        IamChange::RemoveFromGroup { user_name, group_name } => format!("{group_name} 그룹에서 {user_name} 빼기"),
        IamChange::SetAccessKeyStatus { user_name, access_key_id, status } => format!("{user_name}의 액세스 키 {access_key_id} {}", key_action(status)),
        IamChange::DeleteAccessKey { user_name, access_key_id } => format!("{user_name}의 액세스 키 {access_key_id} 삭제하기"),
        IamChange::PutInlinePolicy { target, name, .. } => {
            if inline_policy(s, target, name).is_some() {
                format!("{}의 인라인 정책 {name} 수정하기", principal_label(s, target))
            } else {
                format!("{}에 인라인 정책 {name} 추가하기", principal_label(s, target))
            }
        }
        IamChange::DeleteInlinePolicy { target, name } => format!("{}의 인라인 정책 {name} 삭제하기", principal_label(s, target)),
        IamChange::UpdateManagedPolicy { policy_arn, .. } => format!("관리형 정책 {} 수정하기", policy_name(s, policy_arn)),
    }
}

/// 확인 경고가 있을 때 입력해야 하는 이름: 대상 사용자·그룹·역할·정책의 이름, 그룹 구성원 변경이면 사용자 이름, 액세스 키 변경이면 키 ID.
pub(super) fn confirm_name(s: &Snapshot, c: &IamChange) -> String {
    match c {
        IamChange::AttachPolicy { target, .. }
        | IamChange::DetachPolicy { target, .. }
        | IamChange::PutInlinePolicy { target, .. }
        | IamChange::DeleteInlinePolicy { target, .. } => find_principal(s, target).map_or_else(|| last_segment(target).to_string(), |p| p.name().to_string()),
        IamChange::AddToGroup { user_name, .. } | IamChange::RemoveFromGroup { user_name, .. } => s.user(user_name).map_or_else(|| user_name.clone(), |u| u.name.clone()),
        IamChange::SetAccessKeyStatus { access_key_id, .. } | IamChange::DeleteAccessKey { access_key_id, .. } => access_key_id.clone(),
        IamChange::UpdateManagedPolicy { policy_arn, .. } => policy_name(s, policy_arn),
    }
}
