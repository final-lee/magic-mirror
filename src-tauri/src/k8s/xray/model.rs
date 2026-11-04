//! 관계 트리 응답. 프론트 `src/k8s/xray/types.ts`와 같은 모양이다.
use serde::Serialize;

use crate::error::AppError;
use crate::k8s::read::values::Problem;

/// 두 객체를 잇는 관계의 종류(화면의 묶음)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Edge {
    /// 소유: ownerReferences(위로 소유자, 아래로 자식)
    Owner,
    /// 참조: Pod 사양이나 PVC·PV가 이름으로 가리키는 것(ServiceAccount, ConfigMap, Secret, PVC, PV, StorageClass, Node, PriorityClass)
    Reference,
    /// 선택: 레이블 선택자로 Pod를 고르는 것(Service, PodDisruptionBudget, NetworkPolicy)
    Selector,
    /// 대상: 다른 객체를 대상으로 삼는 것(Ingress → Service, HPA → 워크로드, EndpointSlice → Service·Pod)
    Target,
}

/// 가리킨 객체를 읽은 결과
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Presence {
    Found,
    /// 그 종류를 끝까지 읽었는데 없다
    Missing,
    /// 그 종류를 읽지 못했거나 일부만 읽어서 알 수 없다
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XrayNode {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    /// 이 노드를 부모와 이은 관계
    pub edge: Edge,
    /// 관계의 구체적인 모습(예: `volume`, `env`, `serviceAccount`). 한글 이름은 프론트가 붙인다.
    pub roles: Vec<String>,
    /// 지금 보고 있는 객체
    pub current: bool,
    pub presence: Presence,
    pub status: Option<String>,
    pub problems: Vec<Problem>,
    pub children: Vec<XrayNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub edge: Edge,
    pub nodes: Vec<XrayNode>,
}

/// 읽지 못한 종류. 권한이 없어도(403) 실패가 아니라 빈 칸이다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub kind: String,
    pub error: AppError,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Xray {
    pub sections: Vec<Section>,
    pub gaps: Vec<Gap>,
    /// 노드 수 한도나 가지 수 한도에 걸려 일부를 줄였는가
    pub truncated: bool,
    /// 쪽 수 한도에서 읽기를 멈춘 종류. 이 종류에서 오는 관계는 빠졌을 수 있다.
    pub partial: Vec<String>,
    /// 트리의 노드 수(지금 보는 객체 포함)
    pub nodes: usize,
}
