//! 되돌리기용 역변경. 변경을 적용하기 전의 스냅숏으로 구하고, 변경 기록에 함께 남긴다.

use super::state::{inline_policy, is_attached, is_member};
use super::IamChange;
use crate::iam::eval::find_principal;
use crate::iam::model::{InlinePolicy, Snapshot};
use crate::iam::policy::pretty;

/// 지금 상태의 반대 키 상태. `Active`/`Inactive`가 아니면 None.
fn opposite(status: &str) -> Option<&'static str> {
    match status {
        "Active" => Some("Inactive"),
        "Inactive" => Some("Active"),
        _ => None,
    }
}

/// 지워지거나 덮어써진 인라인 정책을 이전 문서로 다시 만드는 변경. 문서를 읽지 못했으면 다시 만들 수 없다.
fn restore(target: &str, old: &InlinePolicy) -> Option<IamChange> {
    old.document.as_ref()?;
    Some(IamChange::PutInlinePolicy { target: target.to_string(), name: old.name.clone(), document: pretty(&old.raw) })
}

/// 변경을 되돌리는 변경. 되돌릴 수 없으면 None이다.
/// - 붙이기 ↔ 떼기, 그룹에 넣기 ↔ 빼기. 이미 그 상태라 바뀐 것이 없으면 되돌릴 것도 없다(None)
/// - 키 상태: `key_status`(지금 상태)로 되돌린다. 모르면 반대 상태로 본다
/// - 인라인 정책: 덮어썼으면 이전 문서로, 새로 만들었으면 삭제, 삭제했으면 이전 문서로 다시 만든다
/// - 관리형 정책 편집: 이전 기본 버전 문서로 다시 편집한다
/// - 액세스 키 삭제는 되돌릴 수 없다
pub fn inverse(s: &Snapshot, c: &IamChange, key_status: Option<&str>) -> Option<IamChange> {
    match c {
        IamChange::AttachPolicy { target, policy_arn } => {
            let attachable = find_principal(s, target).is_some() && !is_attached(s, target, policy_arn);
            attachable.then(|| IamChange::DetachPolicy { target: target.clone(), policy_arn: policy_arn.clone() })
        }
        IamChange::DetachPolicy { target, policy_arn } => {
            is_attached(s, target, policy_arn).then(|| IamChange::AttachPolicy { target: target.clone(), policy_arn: policy_arn.clone() })
        }
        IamChange::AddToGroup { user_name, group_name } => {
            let addable = s.user(user_name).is_some() && s.group(group_name).is_some() && !is_member(s, user_name, group_name);
            addable.then(|| IamChange::RemoveFromGroup { user_name: user_name.clone(), group_name: group_name.clone() })
        }
        IamChange::RemoveFromGroup { user_name, group_name } => {
            is_member(s, user_name, group_name).then(|| IamChange::AddToGroup { user_name: user_name.clone(), group_name: group_name.clone() })
        }
        IamChange::SetAccessKeyStatus { user_name, access_key_id, status } => {
            let previous = match key_status {
                Some(current) if current == status => return None,
                Some(current) => opposite(current).map(|_| current),
                None => opposite(status),
            }?;
            Some(IamChange::SetAccessKeyStatus { user_name: user_name.clone(), access_key_id: access_key_id.clone(), status: previous.to_string() })
        }
        IamChange::DeleteAccessKey { .. } => None,
        IamChange::PutInlinePolicy { target, name, .. } => {
            find_principal(s, target)?;
            match inline_policy(s, target, name) {
                Some(old) => restore(target, old),
                None => Some(IamChange::DeleteInlinePolicy { target: target.clone(), name: name.clone() }),
            }
        }
        IamChange::DeleteInlinePolicy { target, name } => restore(target, inline_policy(s, target, name)?),
        IamChange::UpdateManagedPolicy { policy_arn, .. } => {
            let rec = s.policies.get(policy_arn)?;
            rec.document.as_ref()?;
            Some(IamChange::UpdateManagedPolicy { policy_arn: policy_arn.clone(), document: pretty(rec.raw.as_deref()?) })
        }
    }
}
