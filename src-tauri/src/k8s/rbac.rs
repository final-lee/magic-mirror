//! 권한 변경(K8 D): RBAC 바인딩 추가·제거·주체 편집과 EKS access entry 변경.
//! 모두 변경 공통 틀(미리보기 → 이름 입력 → 재확인 → 적용 → 기록 → 되돌리기)을 거친다.
//!
//! - `plan`: 바인딩 변경의 요청·차이·역변경(순수).
//! - `eks`: access entry 변경의 EKS API 호출·차이·역변경(순수).
//! - `world`: 계획에 쓰는 한 시점의 상태(RBAC 객체, 신원 매핑)와, 변경 하나를 그 상태에 적용해 보는 `Planner`(순수).
//! - `assess`: 실효 권한 엔진(`access::engine`·`access::diff`)으로 "누가 무엇을 얻고 잃는지"와 위험 판단(순수).
//! - `commit`: 상태를 읽고 서버 dry-run·재확인·적용을 하는 입출력.
//!
//! 쿠버네티스에 쓰는 요청은 `exec::run`, EKS에 쓰는 요청은 `exec::eks`만 보낸다.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::change::{Change, ChangeObject, Operation};
use super::rows::KindRef;
use crate::error::AppError;

pub mod assess;
pub mod commit;
pub mod eks;
pub mod plan;
pub mod world;

pub const RBAC_GROUP: &str = "rbac.authorization.k8s.io";
pub const RBAC_API_VERSION: &str = "rbac.authorization.k8s.io/v1";
/// 주체 종류(바인딩 `subjects[].kind`)
pub const SUBJECT_KINDS: [&str; 3] = ["User", "Group", "ServiceAccount"];
/// 장바구니와 한 번의 일괄 미리보기에 담는 변경의 최대 수
pub const BATCH_MAX: usize = 50;

pub const INVALID_SUBJECT: &str = "주체는 종류(User·Group·ServiceAccount)와 이름이 있어야 하고, ServiceAccount는 네임스페이스도 있어야 해요";
pub const INVALID_BINDING: &str = "바인딩 객체가 올바르지 않아요(이름·roleRef·subjects를 확인해 주세요)";
pub const BINDING_EXISTS: &str = "같은 이름의 바인딩이 이미 있어요";
pub const BINDING_MISSING: &str = "바인딩을 찾을 수 없어요";
pub const BATCH_TOO_LARGE: &str = "한 번에 미리보기할 수 있는 변경은 50개까지예요";
pub const BATCH_DUPLICATE: &str = "같은 변경이 두 번 들어 있어요";
pub const BATCH_NO_EKS: &str = "access entry 변경은 장바구니에 담지 않고 하나씩 미리보기해요";

/// 바인딩 주체 하나(`subjects[]`). User·Group은 `apiGroup`을 채워 만들고, ServiceAccount는 `namespace`가 필요하다.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubjectSpec {
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub namespace: Option<String>,
}

impl SubjectSpec {
    /// 바인딩 안에서 같은 주체인지 비교하는 값. ServiceAccount가 아니면 네임스페이스는 보지 않는다.
    pub fn key(&self) -> (String, String, String) {
        let namespace = if self.kind == "ServiceAccount" { self.namespace.clone().unwrap_or_default() } else { String::new() };
        (self.kind.clone(), self.name.clone(), namespace)
    }

    pub fn validate(&self) -> Result<(), AppError> {
        let known = SUBJECT_KINDS.contains(&self.kind.as_str());
        let named = !self.name.trim().is_empty() && self.name == self.name.trim();
        let namespaced = self.kind != "ServiceAccount" || self.namespace.as_deref().is_some_and(|ns| !ns.trim().is_empty());
        if known && named && namespaced {
            Ok(())
        } else {
            Err(AppError::other(INVALID_SUBJECT))
        }
    }

    /// 바인딩에 넣는 모양
    pub fn to_value(&self) -> Value {
        if self.kind == "ServiceAccount" {
            json!({"kind": self.kind, "name": self.name, "namespace": self.namespace})
        } else {
            json!({"apiGroup": RBAC_GROUP, "kind": self.kind, "name": self.name})
        }
    }

    /// 바인딩의 `subjects[]` 항목에서 읽는다. 알 수 없는 종류면 None.
    pub fn from_value(value: &Value) -> Option<SubjectSpec> {
        let kind = value.get("kind")?.as_str()?;
        if !SUBJECT_KINDS.contains(&kind) {
            return None;
        }
        Some(SubjectSpec {
            kind: kind.to_string(),
            name: value.get("name")?.as_str()?.to_string(),
            namespace: value.get("namespace").and_then(Value::as_str).map(str::to_string),
        })
    }
}

/// access policy를 적용하는 범위
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScopeSpec {
    Cluster,
    Namespaces { namespaces: Vec<String> },
}

impl ScopeSpec {
    pub fn validate(&self) -> Result<(), AppError> {
        match self {
            ScopeSpec::Cluster => Ok(()),
            ScopeSpec::Namespaces { namespaces } if !namespaces.is_empty() && namespaces.iter().all(|ns| !ns.trim().is_empty()) => Ok(()),
            ScopeSpec::Namespaces { .. } => Err(AppError::other(eks::INVALID_SCOPE)),
        }
    }
}

/// 연결할 access policy 하나
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicySpec {
    pub policy_arn: String,
    pub scope: ScopeSpec,
}

/// 변경 틀에서 RoleBinding·ClusterRoleBinding을 가리키는 종류
pub fn binding_kind(cluster: bool) -> KindRef {
    KindRef {
        group: RBAC_GROUP.into(),
        version: "v1".into(),
        kind: if cluster { "ClusterRoleBinding" } else { "RoleBinding" }.into(),
        plural: if cluster { "clusterrolebindings" } else { "rolebindings" }.into(),
        namespaced: !cluster,
    }
}

/// 변경 틀에서 access entry를 가리키는 종류. 클러스터의 API 종류가 아니라 앱 안의 이름표이고, 대상 이름은 IAM 주체 ARN이다.
pub fn access_entry_kind() -> KindRef {
    KindRef { group: "eks.amazonaws.com".into(), version: "v1".into(), kind: "AccessEntry".into(), plural: "accessentries".into(), namespaced: false }
}

pub fn is_binding(kind: &KindRef) -> bool {
    kind.group == RBAC_GROUP && matches!(kind.kind.as_str(), "RoleBinding" | "ClusterRoleBinding")
}

pub fn is_access_entry(target: &ChangeObject) -> bool {
    target.kind.group == "eks.amazonaws.com" && target.kind.kind == "AccessEntry"
}

/// 이 변경은 권한 변경 모듈이 계획하고 적용하는가. 바인딩 삭제는 공통 삭제 단추가 보내므로 여기서 받는다.
pub fn handles(change: &Change) -> bool {
    match &change.operation {
        Operation::BindingCreate { .. }
        | Operation::BindingSubjects { .. }
        | Operation::AccessEntryCreate { .. }
        | Operation::AccessEntryDelete
        | Operation::AccessEntryGroups { .. }
        | Operation::AccessPolicyAssociate { .. }
        | Operation::AccessPolicyDisassociate { .. } => true,
        Operation::Delete => is_binding(&change.target.kind),
        _ => false,
    }
}

/// 이 변경은 EKS API로 하는가(아니면 쿠버네티스 API)
pub fn is_eks(change: &Change) -> bool {
    matches!(
        change.operation,
        Operation::AccessEntryCreate { .. } | Operation::AccessEntryDelete | Operation::AccessEntryGroups { .. } | Operation::AccessPolicyAssociate { .. } | Operation::AccessPolicyDisassociate { .. }
    )
}

#[cfg(test)]
mod mock_eks;
#[cfg(test)]
mod mock_kube;
#[cfg(test)]
mod tests;
