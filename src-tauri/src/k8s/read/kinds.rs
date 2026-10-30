//! API discovery로 클러스터가 내주는 종류를 나열한다. 목록과 watch가 모두 되는 것만 둔다(화면이 watch로 목록을 받는다).
//! CRD인지는 내장 API 그룹 표로 가른다(CRD 목록을 읽을 권한이 없는 신원도 많다).
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
}

pub fn kind_of(ar: &ApiResource, caps: &ApiCapabilities) -> Option<Kind> {
    let listable = ["list", "watch"].iter().all(|v| caps.operations.iter().any(|o| o == v));
    if !listable {
        return None;
    }
    Some(Kind {
        kind: KindRef { group: ar.group.clone(), version: ar.version.clone(), kind: ar.kind.clone(), plural: ar.plural.clone(), namespaced: caps.scope == Scope::Namespaced },
        verbs: caps.operations.clone(),
        custom: !BUILTIN_GROUPS.contains(&ar.group.as_str()),
    })
}

/// 그룹마다 권장 버전의 종류. 그룹·종류 이름 순서.
pub fn kinds_of(discovery: &Discovery) -> Vec<Kind> {
    let mut out: Vec<Kind> = discovery.groups().flat_map(|g| g.recommended_resources()).filter_map(|(ar, caps)| kind_of(&ar, &caps)).collect();
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

#[cfg(test)]
mod tests;
