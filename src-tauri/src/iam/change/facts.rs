//! 스냅숏 밖에서 읽어 와 미리보기에 넣는 사실들: 액세스 키의 지금 상태, 이 앱이 쓰는 액세스 키, 정책 문서 검사 결과, 붙일 정책을 읽지 못한 이유.
//! 미리보기와 적용이 같은 방법으로 읽어 넣으므로, 순수 함수인 미리보기를 적용 직전에 그대로 다시 계산할 수 있다.

use super::calls::version_to_delete;
use super::IamChange;
use crate::iam::model::Snapshot;

/// 관리형 정책의 새 버전을 만들기 전에 Access Analyzer로 문서를 검사한 결과.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum PolicyCheck {
    /// 검사하지 않았다(지울 버전이 없어서, 또는 아직)
    #[default]
    NotRun,
    /// 오류(ERROR)가 없다
    Passed,
    /// 검사기를 쓸 수 없었다(권한 없음 등)
    Unavailable,
    /// 오류(ERROR) 결과의 설명
    Errors(Vec<String>),
}

/// 미리보기의 재료 가운데 스냅숏에 없는 것.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Facts {
    /// 액세스 키 변경이면 그 키의 지금 상태(`"Active"`/`"Inactive"`)
    pub key_status: Option<String>,
    /// 이 앱이 쓰는 자격 증명의 액세스 키 ID. 읽지 못했으면 None이고, 그러면 앱이 IAM 사용자로 접근할 때 그 사용자의 키를 모두 앱의 키로 본다
    pub own_key_id: Option<String>,
    /// 버전을 먼저 지워야 하는 관리형 정책 편집이면 새 문서를 검사한 결과
    pub policy_check: PolicyCheck,
    /// 스냅숏에 문서가 없는 정책을 붙이는 변경이면 그 정책을 따로 읽다가 실패한 이유(`권한 없음 (iam:GetPolicy)` 등). 읽었거나 읽을 일이 없으면 None
    pub policy_error: Option<String>,
}

#[cfg(test)]
impl Facts {
    /// 키 상태만 아는 사실.
    pub fn with_key_status(status: Option<&str>) -> Facts {
        Facts { key_status: status.map(str::to_string), ..Facts::default() }
    }
}

/// 이 변경이 새 버전을 만들기 전에 관리형 정책의 버전 하나를 지우는지(버전이 5개 찼다).
/// 그러면 새 버전을 만드는 호출이 실패해도 지운 버전은 돌아오지 않으므로, 적용 전에 문서를 검사한다.
pub fn deletes_policy_version(s: &Snapshot, c: &IamChange) -> bool {
    matches!(c, IamChange::UpdateManagedPolicy { policy_arn, .. } if s.policies.get(policy_arn).and_then(version_to_delete).is_some())
}

/// 변경이 이 앱이 지금 쓰는 액세스 키를 건드리는지.
/// 자격 증명의 키 ID(`own_key_id`)를 읽었으면 그것과 같은 키인지만 본다: SSO·역할의 임시 키(`ASIA…`)는 어떤 IAM 사용자의 키와도 맞지 않는데,
/// 그 자격 증명은 사용자의 키를 쓰지 않으니 맞다. 읽지 못했으면 앱이 IAM 사용자(`caller_principal_arn`)로 접근할 때 그 사용자의 키인지로 본다.
pub(super) fn touches_own_key(s: &Snapshot, c: &IamChange, own_key_id: Option<&str>) -> bool {
    let (IamChange::SetAccessKeyStatus { user_name, access_key_id, .. } | IamChange::DeleteAccessKey { user_name, access_key_id }) = c else {
        return false;
    };
    match own_key_id.filter(|id| !id.is_empty()) {
        Some(own) => own == access_key_id,
        None => {
            let caller = s.caller_principal_arn.as_deref();
            s.user(user_name).is_some_and(|u| Some(u.arn.as_str()) == caller)
        }
    }
}

/// 이 앱이 쓰는 키를 끄거나 지우는 변경인지. 적용하면 이 앱은 그 자리에서 AWS에 접근하지 못한다.
pub(super) fn stops_own_key(s: &Snapshot, c: &IamChange, facts: &Facts) -> bool {
    let stops = match c {
        IamChange::SetAccessKeyStatus { status, .. } => status == "Inactive",
        IamChange::DeleteAccessKey { .. } => true,
        _ => false,
    };
    stops && touches_own_key(s, c, facts.own_key_id.as_deref())
}
