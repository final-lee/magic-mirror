//! API discovery로 클러스터가 내주는 종류를 나열한다. 목록과 watch가 모두 되는 것만 둔다(화면이 watch로 목록을 받는다).
//! CRD인지는 내장 API 그룹 표로 가른다(CRD 목록을 읽을 권한이 없는 신원도 많다).
use std::collections::HashMap;

use kube::core::discovery::v2::APIGroupDiscoveryList;
use kube::discovery::{ApiCapabilities, ApiResource, Discovery, Scope};
use kube::Client;
use serde::Serialize;

use super::bounded;
use crate::error::AppError;
use crate::k8s::connect::REQUEST_TIMEOUT;
use crate::k8s::failure::{describe, failure_of, Endpoint, Failure};
use crate::k8s::rows::KindRef;

/// 쿠버네티스가 직접 내주는 API 그룹(1.33 기준). 여기 없는 그룹은 사용자 정의 리소스로 본다.
pub const BUILTIN_GROUPS: &[&str] = &[
    "",
    "admissionregistration.k8s.io",
    "apiextensions.k8s.io",
    "apiregistration.k8s.io",
    "apps",
    "authentication.k8s.io",
    "authorization.k8s.io",
    "autoscaling",
    "batch",
    "certificates.k8s.io",
    "coordination.k8s.io",
    "discovery.k8s.io",
    "events.k8s.io",
    "flowcontrol.apiserver.k8s.io",
    "internal.apiserver.k8s.io",
    "metrics.k8s.io",
    "networking.k8s.io",
    "node.k8s.io",
    "policy",
    "rbac.authorization.k8s.io",
    "resource.k8s.io",
    "scheduling.k8s.io",
    "storage.k8s.io",
    "storagemigration.k8s.io",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kind {
    #[serde(flatten)]
    pub kind: KindRef,
    pub verbs: Vec<String>,
    pub custom: bool,
    /// API 서버가 알려 주는 짧은 이름(`po`, `deploy`). 알려 주지 않으면 빈 목록
    pub short_names: Vec<String>,
    /// API 서버가 알려 주는 단수 이름(`pod`). 알려 주지 않으면 빈 문자열
    pub singular_name: String,
}

/// API 서버가 종류마다 알려 주는 별칭
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Names {
    pub short_names: Vec<String>,
    pub singular: String,
}

/// (그룹, 복수형 이름) → 별칭. 그룹마다 권장(맨 앞) 버전의 값을 쓴다
pub type NameTable = HashMap<(String, String), Names>;

pub fn kind_of(ar: &ApiResource, caps: &ApiCapabilities, names: &NameTable) -> Option<Kind> {
    let listable = ["list", "watch"].iter().all(|v| caps.operations.iter().any(|o| o == v));
    if !listable {
        return None;
    }
    let named = names.get(&(ar.group.clone(), ar.plural.clone())).cloned().unwrap_or_default();
    Some(Kind {
        kind: KindRef { group: ar.group.clone(), version: ar.version.clone(), kind: ar.kind.clone(), plural: ar.plural.clone(), namespaced: caps.scope == Scope::Namespaced },
        verbs: caps.operations.clone(),
        custom: !BUILTIN_GROUPS.contains(&ar.group.as_str()),
        short_names: named.short_names,
        singular_name: named.singular,
    })
}

/// 집계 discovery 응답에서 종류별 별칭을 모은다. 그룹마다 첫 버전(권장 버전)의 값만 쓴다.
pub fn names_of(lists: &[APIGroupDiscoveryList]) -> NameTable {
    let mut table = NameTable::new();
    for group in lists.iter().flat_map(|l| &l.items) {
        let name = group.metadata.as_ref().and_then(|m| m.name.clone()).unwrap_or_default();
        let Some(version) = group.versions.first() else {
            continue;
        };
        for resource in &version.resources {
            let Some(plural) = resource.resource.clone() else {
                continue;
            };
            table.insert(
                (name.clone(), plural),
                Names { short_names: resource.short_names.clone(), singular: resource.singular_resource.clone().unwrap_or_default() },
            );
        }
    }
    table
}

/// 별칭은 있으면 좋은 정보다. 집계 discovery를 못 읽으면(오래된 서버, 권한) 빈 표로 두고 종류 목록은 그대로 낸다.
pub async fn discover_names(client: &Client) -> NameTable {
    let (core, apis) = tokio::join!(
        tokio::time::timeout(REQUEST_TIMEOUT, client.list_core_api_versions_aggregated()),
        tokio::time::timeout(REQUEST_TIMEOUT, client.list_api_groups_aggregated()),
    );
    let lists: Vec<APIGroupDiscoveryList> = [core, apis].into_iter().filter_map(|r| r.ok()?.ok()).collect();
    names_of(&lists)
}

/// 그룹마다 권장 버전의 종류. 그룹·종류 이름 순서.
pub fn kinds_of(discovery: &Discovery, names: &NameTable) -> Vec<Kind> {
    let mut out: Vec<Kind> = discovery.groups().flat_map(|g| g.recommended_resources()).filter_map(|(ar, caps)| kind_of(&ar, &caps, names)).collect();
    out.sort_by(|a, b| (&a.kind.group, &a.kind.kind).cmp(&(&b.kind.group, &b.kind.kind)));
    out
}

/// 집계 discovery가 서버에서 안 될 때(오래된 서버, 프록시)만 그룹별 discovery로 다시 묻는다. 권한·연결·인증 문제는 다시 물어도 같다.
pub fn falls_back(f: &Failure) -> bool {
    matches!(f, Failure::Other(_))
}

/// 집계 discovery(1.30부터 정식)를 먼저 쓴다. 각 시도는 `REQUEST_TIMEOUT` 안에 끝나야 한다.
pub async fn discover(client: &Client, endpoint: Endpoint) -> Result<Discovery, AppError> {
    let first = tokio::time::timeout(REQUEST_TIMEOUT, Discovery::new(client.clone()).run_aggregated()).await.map_err(|_| describe(&Failure::Unreachable, endpoint))?;
    match first {
        Ok(d) => Ok(d),
        Err(e) => {
            let failure = failure_of(&e, "get", "api");
            if !falls_back(&failure) {
                return Err(describe(&failure, endpoint));
            }
            bounded(Discovery::new(client.clone()).run(), "get", "api", endpoint).await
        }
    }
}

/// 화면이 쓰는 종류 목록: discovery와 별칭을 함께 읽는다.
pub async fn discover_kinds(client: &Client, endpoint: Endpoint) -> Result<Vec<Kind>, AppError> {
    let (discovery, names) = tokio::join!(discover(client, endpoint), discover_names(client));
    Ok(kinds_of(&discovery?, &names))
}

#[cfg(test)]
mod tests;
