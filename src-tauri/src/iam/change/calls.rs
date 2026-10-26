//! 변경이 부르는 IAM API와 인자. 미리보기에 그대로 보여 주고, `write`가 이 목록을 그대로 실행하므로
//! 사용자가 본 호출과 실제 호출이 달라질 수 없다. 인자 이름은 AWS API의 것(`UserName`, `PolicyArn` …)이다.

use std::collections::BTreeMap;

use serde::Serialize;

use super::IamChange;
use crate::iam::eval::find_principal;
use crate::iam::model::{ManagedPolicyRec, Snapshot, VersionRec};
use crate::iam::view::PrincipalKind;

/// 관리형 정책 하나에 둘 수 있는 버전 수의 한도.
pub const MAX_POLICY_VERSIONS: usize = 5;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ApiCall {
    /// `iam:AttachUserPolicy`
    pub api: String,
    pub params: BTreeMap<String, String>,
}

fn call(api: &str, params: &[(&str, &str)]) -> ApiCall {
    ApiCall { api: format!("iam:{api}"), params: params.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }
}

/// 사용자·그룹·역할 ARN → (`User`|`Group`|`Role`, 이름). 스냅숏에 없으면 None.
fn owner(s: &Snapshot, arn: &str) -> Option<(&'static str, String)> {
    let principal = find_principal(s, arn)?;
    let kind = match principal.kind() {
        PrincipalKind::User => "User",
        PrincipalKind::Group => "Group",
        PrincipalKind::Role => "Role",
    };
    Some((kind, principal.name().to_string()))
}

/// 버전 번호(`v7` → 7). 읽지 못하는 ID는 가장 새것으로 친다.
fn version_number(id: &str) -> u64 {
    id.strip_prefix('v').and_then(|n| n.parse().ok()).unwrap_or(u64::MAX)
}

/// 새 버전을 만들기 전에 지워야 하는 버전: 버전이 한도(5개)까지 찼을 때 가장 오래된 기본이 아닌 버전.
/// 버전 번호(`v7`)는 만든 순서대로 늘고 다시 쓰이지 않으므로 번호가 작을수록 오래된 것이다.
pub(super) fn version_to_delete(rec: &ManagedPolicyRec) -> Option<&VersionRec> {
    if rec.versions.len() < MAX_POLICY_VERSIONS {
        return None;
    }
    rec.versions.iter().filter(|v| !v.is_default).min_by_key(|v| version_number(&v.id))
}

/// 사용자·그룹·역할의 정책을 다루는 API(`Attach{Kind}Policy`, `Put{Kind}Policy` …) 하나. 대상이 스냅숏에 없으면 빈 목록이다.
fn principal_call(s: &Snapshot, target: &str, verb: &str, extra: &[(&str, &str)]) -> Vec<ApiCall> {
    let Some((kind, name)) = owner(s, target) else {
        return Vec::new();
    };
    let name_key = format!("{kind}Name");
    let mut params: Vec<(&str, &str)> = vec![(&name_key, &name)];
    params.extend_from_slice(extra);
    vec![call(&format!("{verb}{kind}Policy"), &params)]
}

/// 변경이 부르는 API를 순서대로. 대상 사용자·그룹·역할이 스냅숏에 없으면 어떤 API인지 알 수 없어 빈 목록이다.
pub fn calls(s: &Snapshot, c: &IamChange) -> Vec<ApiCall> {
    match c {
        IamChange::AttachPolicy { target, policy_arn } => principal_call(s, target, "Attach", &[("PolicyArn", policy_arn)]),
        IamChange::DetachPolicy { target, policy_arn } => principal_call(s, target, "Detach", &[("PolicyArn", policy_arn)]),
        IamChange::AddToGroup { user_name, group_name } => vec![call("AddUserToGroup", &[("UserName", user_name), ("GroupName", group_name)])],
        IamChange::RemoveFromGroup { user_name, group_name } => vec![call("RemoveUserFromGroup", &[("UserName", user_name), ("GroupName", group_name)])],
        IamChange::SetAccessKeyStatus { user_name, access_key_id, status } => {
            vec![call("UpdateAccessKey", &[("UserName", user_name), ("AccessKeyId", access_key_id), ("Status", status)])]
        }
        IamChange::DeleteAccessKey { user_name, access_key_id } => vec![call("DeleteAccessKey", &[("UserName", user_name), ("AccessKeyId", access_key_id)])],
        IamChange::PutInlinePolicy { target, name, document } => principal_call(s, target, "Put", &[("PolicyName", name), ("PolicyDocument", document)]),
        IamChange::DeleteInlinePolicy { target, name } => principal_call(s, target, "Delete", &[("PolicyName", name)]),
        IamChange::UpdateManagedPolicy { policy_arn, document } => {
            let mut plan = Vec::new();
            if let Some(version) = s.policies.get(policy_arn).and_then(version_to_delete) {
                plan.push(call("DeletePolicyVersion", &[("PolicyArn", policy_arn), ("VersionId", &version.id)]));
            }
            plan.push(call("CreatePolicyVersion", &[("PolicyArn", policy_arn), ("PolicyDocument", document), ("SetAsDefault", "true")]));
            plan
        }
    }
}
