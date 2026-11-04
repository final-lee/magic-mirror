//! EKS access entry에 쓰는 요청을 보내는 유일한 곳(생성·삭제·그룹 변경·정책 연결과 해제). 미리보기가 보여 준 호출을 그대로 보낸다.
//! EKS API에는 dry-run이 없다. 테스트는 `iam::mock_aws`처럼 SDK의 HTTP 연결을 가짜로 바꿔 보낸 요청을 확인한다(실제 AWS는 부르지 않는다).
use aws_sdk_eks::types::{AccessScope, AccessScopeType};
use aws_sdk_eks::Client as Eks;

use crate::error::AppError;
use crate::k8s::change::{Change, Operation, INVALID_CHANGE};
use crate::k8s::rbac::eks::{clean_groups, INVALID_GROUP};
use crate::k8s::rbac::{PolicySpec, ScopeSpec};
use crate::k8s::read::eks::call;

fn scope_of(scope: &ScopeSpec) -> AccessScope {
    match scope {
        ScopeSpec::Cluster => AccessScope::builder().r#type(AccessScopeType::Cluster).build(),
        ScopeSpec::Namespaces { namespaces } => AccessScope::builder().r#type(AccessScopeType::Namespace).set_namespaces(Some(namespaces.clone())).build(),
    }
}

async fn associate(eks: &Eks, cluster: &str, principal: &str, policy: &PolicySpec) -> Result<(), AppError> {
    call(
        eks.associate_access_policy().cluster_name(cluster).principal_arn(principal).policy_arn(&policy.policy_arn).access_scope(scope_of(&policy.scope)).send(),
        "eks:AssociateAccessPolicy",
    )
    .await
    .map(|_| ())
}

/// 정책 연결에 실패해 방금 만든 entry를 되돌린 사실을 오류에 덧붙인다(만료된 로그인은 그대로 둔다: 다시 로그인해서 이어 가야 한다).
fn with_note(error: AppError, note: &str) -> AppError {
    match error {
        AppError::SsoExpired => AppError::SsoExpired,
        other => AppError::other(format!("{other} ({note})")),
    }
}

/// access entry를 만들고 정책을 하나씩 연결한다. 정책 연결이 실패하면 방금 만든 entry를 지워 처음 상태로 돌린다(이 호출이 만든 것이라 지워도 안전하다).
async fn create(eks: &Eks, cluster: &str, principal: &str, username: &Option<String>, groups: &[String], policies: &[PolicySpec], entry_type: &Option<String>) -> Result<(), AppError> {
    let groups = clean_groups(groups)?;
    let username = username.as_deref().map(str::trim).filter(|u| !u.is_empty()).map(str::to_string);
    let kind = entry_type.clone().filter(|t| t != "STANDARD");
    call(
        eks.create_access_entry()
            .cluster_name(cluster)
            .principal_arn(principal)
            .set_kubernetes_groups((!groups.is_empty()).then_some(groups))
            .set_username(username)
            .set_type(kind)
            .send(),
        "eks:CreateAccessEntry",
    )
    .await?;
    for policy in policies {
        if let Err(error) = associate(eks, cluster, principal, policy).await {
            let removed = call(eks.delete_access_entry().cluster_name(cluster).principal_arn(principal).send(), "eks:DeleteAccessEntry").await;
            let note = if removed.is_ok() { "정책을 연결하지 못해 만든 access entry를 다시 지웠어요" } else { "정책을 연결하지 못했고 만든 access entry를 지우지도 못했어요. 접근 화면에서 확인해 주세요" };
            return Err(with_note(error, note));
        }
    }
    Ok(())
}

/// 변경 하나를 EKS에 보낸다. `change.target.name`이 IAM 주체 ARN이다.
pub async fn run(eks: &Eks, cluster: &str, change: &Change) -> Result<(), AppError> {
    let principal = change.target.name.as_str();
    match &change.operation {
        Operation::AccessEntryCreate { username, groups, policies, entry_type } => create(eks, cluster, principal, username, groups, policies, entry_type).await,
        Operation::AccessEntryDelete => call(eks.delete_access_entry().cluster_name(cluster).principal_arn(principal).send(), "eks:DeleteAccessEntry").await.map(|_| ()),
        Operation::AccessEntryGroups { groups } => {
            let groups = clean_groups(groups).map_err(|_| AppError::other(INVALID_GROUP))?;
            call(eks.update_access_entry().cluster_name(cluster).principal_arn(principal).set_kubernetes_groups(Some(groups)).send(), "eks:UpdateAccessEntry").await.map(|_| ())
        }
        Operation::AccessPolicyAssociate { policy_arn, scope } => associate(eks, cluster, principal, &PolicySpec { policy_arn: policy_arn.clone(), scope: scope.clone() }).await,
        Operation::AccessPolicyDisassociate { policy_arn } => {
            call(eks.disassociate_access_policy().cluster_name(cluster).principal_arn(principal).policy_arn(policy_arn).send(), "eks:DisassociateAccessPolicy").await.map(|_| ())
        }
        _ => Err(AppError::other(INVALID_CHANGE)),
    }
}
