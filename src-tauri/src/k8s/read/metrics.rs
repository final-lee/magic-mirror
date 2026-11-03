//! 사용량: metrics-server(`metrics.k8s.io`)의 Pod·노드 사용량과, Pod마다 위로 거슬러 올라간 컨트롤러 사슬(Pod → ReplicaSet → Deployment, Job → CronJob).
//! 화면이 워크로드별로 Pod 사용량을 합산할 수 있게 한다. 서버가 없거나 권한이 없으면 오류 대신 `unavailable` 사유를 돌려준다.
//! Pod 줄의 요청·제한 합(`Bounds`)도 여기서 셈한다.
use std::collections::HashMap;
use std::future::Future;

use kube::api::{Api, ApiResource, DynamicObject, GroupVersionKind, ListParams};
use kube::core::ObjectMeta;
use kube::Client;
use serde::Serialize;
use serde_json::Value;

use super::nodes::usage_of;
use super::overview::LIST_PAGES_MAX;
use super::quantity::{bytes, cpu_milli};
use super::values::list;
use super::bounded;
use crate::error::AppError;
use crate::k8s::connect::REQUEST_TIMEOUT;
use crate::k8s::failure::{describe, failure_of, Endpoint, Failure};
use crate::k8s::watch::PAGE_SIZE;

const METRICS_GROUP: &str = "metrics.k8s.io";
const METRICS_VERSION: &str = "v1beta1";
/// 컨트롤러 사슬을 따라 올라가는 최대 단계(Pod → ReplicaSet → Deployment가 보통이고, 사용자 정의 컨트롤러가 하나 더 있을 수 있다)
const CHAIN_MAX: usize = 4;

/// 사용량을 읽지 못하는 까닭
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Unavailable {
    /// metrics.k8s.io가 없다(metrics-server가 설치되지 않았다)
    NotInstalled,
    /// 이 신원에는 metrics.k8s.io를 읽을 권한이 없다
    Forbidden,
    /// API는 등록돼 있지만 metrics-server가 답하지 않는다(503)
    NotReady,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerUsage {
    pub name: String,
    pub cpu_milli: i64,
    pub memory_bytes: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodUsage {
    pub namespace: String,
    pub name: String,
    pub cpu_milli: i64,
    pub memory_bytes: i64,
    pub containers: Vec<ContainerUsage>,
    /// 컨트롤러 사슬: 가까운 것부터 맨 위까지(ReplicaSet, Deployment). 컨트롤러가 없으면 비어 있다.
    pub owners: Vec<Owner>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeUsage {
    pub name: String,
    pub cpu_milli: i64,
    pub memory_bytes: i64,
}

/// Pod와 노드는 따로 읽는다: 노드 권한이 없어도 Pod 사용량은 보인다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub pods_unavailable: Option<Unavailable>,
    pub nodes_unavailable: Option<Unavailable>,
    pub pods: Vec<PodUsage>,
    pub nodes: Vec<NodeUsage>,
}

/// 요청·제한. 값이 없거나 0이면 None(설정하지 않은 것). CPU는 밀리코어, 메모리는 바이트.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub cpu_request: Option<i64>,
    pub cpu_limit: Option<i64>,
    pub memory_request: Option<i64>,
    pub memory_limit: Option<i64>,
}

fn quantity_at(c: &Value, path: &str, parse: fn(&str) -> Option<i64>) -> Option<i64> {
    c.pointer(path).and_then(Value::as_str).and_then(parse).filter(|n| *n > 0)
}

/// 컨테이너 하나의 요청·제한
pub fn bounds_of_container(c: &Value) -> Bounds {
    Bounds {
        cpu_request: quantity_at(c, "/resources/requests/cpu", cpu_milli),
        cpu_limit: quantity_at(c, "/resources/limits/cpu", cpu_milli),
        memory_request: quantity_at(c, "/resources/requests/memory", bytes),
        memory_limit: quantity_at(c, "/resources/limits/memory", bytes),
    }
}

/// 컨테이너가 모두 값을 가졌을 때만 합한다. 하나라도 비어 있으면 일부만의 합이라 사용량과 견줄 수 없어 None.
fn sum_all(parts: &[Bounds], pick: fn(&Bounds) -> Option<i64>) -> Option<i64> {
    if parts.is_empty() {
        return None;
    }
    parts.iter().try_fold(0_i64, |sum, b| pick(b).map(|n| sum.saturating_add(n)))
}

/// Pod의 요청·제한: init 컨테이너와 overhead는 빼고 `spec.containers`만 더한다(`kubectl top`·k9s의 사용량과 견주는 값)
pub fn bounds_of_pod(pod: &Value) -> Bounds {
    let parts: Vec<Bounds> = list(pod, "/spec/containers").iter().map(bounds_of_container).collect();
    Bounds {
        cpu_request: sum_all(&parts, |b| b.cpu_request),
        cpu_limit: sum_all(&parts, |b| b.cpu_limit),
        memory_request: sum_all(&parts, |b| b.memory_request),
        memory_limit: sum_all(&parts, |b| b.memory_limit),
    }
}

/// 사용량 / 기준 × 100. 기준이 없거나 0이면 None
pub fn percent_of(used: i64, base: Option<i64>) -> Option<f64> {
    base.filter(|b| *b > 0).map(|b| used as f64 * 100.0 / b as f64)
}

/// 이 비율을 넘으면 화면이 눈에 띄게 표시한다(프론트 `usage.ts`의 `HOT_PCT`와 같다)
pub const HOT_PERCENT: f64 = 90.0;

pub fn is_hot(pct: Option<f64>) -> bool {
    pct.is_some_and(|p| p > HOT_PERCENT)
}

/// PodMetrics 한 개. 컨테이너 사용량의 합이 Pod 사용량이다.
pub fn pod_usage_of(metrics: &DynamicObject) -> PodUsage {
    let containers: Vec<ContainerUsage> = list(&metrics.data, "/containers")
        .iter()
        .map(|c| ContainerUsage {
            name: c["name"].as_str().unwrap_or("").to_string(),
            cpu_milli: c.pointer("/usage/cpu").and_then(Value::as_str).and_then(cpu_milli).unwrap_or(0),
            memory_bytes: c.pointer("/usage/memory").and_then(Value::as_str).and_then(bytes).unwrap_or(0),
        })
        .collect();
    PodUsage {
        namespace: metrics.metadata.namespace.clone().unwrap_or_default(),
        name: metrics.metadata.name.clone().unwrap_or_default(),
        cpu_milli: containers.iter().map(|c| c.cpu_milli).fold(0, i64::saturating_add),
        memory_bytes: containers.iter().map(|c| c.memory_bytes).fold(0, i64::saturating_add),
        containers,
        owners: vec![],
    }
}

/// `controller: true`인 소유자, 없으면 첫 소유자
pub fn controller_of(meta: &ObjectMeta) -> Option<Owner> {
    let refs = meta.owner_references.as_deref().unwrap_or(&[]);
    refs.iter().find(|r| r.controller == Some(true)).or_else(|| refs.first()).map(|r| Owner { kind: r.kind.clone(), name: r.name.clone() })
}

/// (네임스페이스, 종류, 이름) → 그 객체의 컨트롤러. ReplicaSet과 Job만 담는다.
pub type Parents = HashMap<(String, String, String), Owner>;

/// Pod의 첫 컨트롤러에서 위로 올라간 사슬. 노드가 소유한 정적 Pod는 컨트롤러가 없는 것으로 본다.
pub fn owner_chain(namespace: &str, first: Option<Owner>, parents: &Parents) -> Vec<Owner> {
    let mut chain = Vec::new();
    let mut next = first.filter(|o| o.kind != "Node");
    while let Some(owner) = next {
        next = parents.get(&(namespace.to_string(), owner.kind.clone(), owner.name.clone())).cloned();
        chain.push(owner);
        if chain.len() >= CHAIN_MAX {
            break;
        }
    }
    chain
}

/// 사용량 읽기 한 번의 결과: 읽었거나, 읽지 못하는 까닭(`Unavailable`), 아니면 오류(연결·SSO 만료 등)
async fn read<T>(fut: impl Future<Output = Result<T, kube::Error>>, resource: &str, endpoint: Endpoint) -> Result<Result<T, Unavailable>, AppError> {
    let result = tokio::time::timeout(REQUEST_TIMEOUT, fut).await.map_err(|_| describe(&Failure::Unreachable, endpoint))?;
    match result {
        Ok(v) => Ok(Ok(v)),
        Err(e) => match unavailable_of(&e) {
            Some(u) => Ok(Err(u)),
            None => Err(describe(&failure_of(&e, "list", resource), endpoint)),
        },
    }
}

pub fn unavailable_of(e: &kube::Error) -> Option<Unavailable> {
    match e {
        kube::Error::Api(status) => match status.code {
            404 => Some(Unavailable::NotInstalled),
            403 => Some(Unavailable::Forbidden),
            503 => Some(Unavailable::NotReady),
            _ => None,
        },
        _ => None,
    }
}

/// 메타데이터만 쪽을 넘기며 읽는다(소유 관계만 필요하니 본문은 받지 않는다)
async fn list_meta(api: &Api<DynamicObject>, lp: &ListParams, resource: &str, endpoint: Endpoint) -> Result<Vec<ObjectMeta>, AppError> {
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..LIST_PAGES_MAX {
        let mut p = lp.clone().limit(PAGE_SIZE);
        if let Some(t) = &token {
            p = p.continue_token(t);
        }
        let page = bounded(api.list_metadata(&p), "list", resource, endpoint).await?;
        out.extend(page.items.into_iter().map(|i| i.metadata));
        token = page.metadata.continue_.filter(|c| !c.is_empty());
        if token.is_none() {
            break;
        }
    }
    Ok(out)
}

fn scoped_api(client: &Client, group: &str, version: &str, kind: &str, plural: &str, namespace: Option<&str>) -> Api<DynamicObject> {
    let ar = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(group, version, kind), plural);
    match namespace.filter(|n| !n.is_empty()) {
        Some(ns) => Api::namespaced_with(client.clone(), ns, &ar),
        None => Api::all_with(client.clone(), &ar),
    }
}

/// 각 Pod의 컨트롤러 사슬을 채운다. Pod 목록을 읽지 못하면 사슬 없이 둔다(사용량 자체는 그대로 보인다).
async fn attach_owners(client: &Client, namespace: Option<&str>, pods: &mut [PodUsage], endpoint: Endpoint) -> Result<(), AppError> {
    let pods_api = scoped_api(client, "", "v1", "Pod", "pods", namespace);
    let metas = list_meta(&pods_api, &ListParams::default().fields("status.phase=Running"), "pods", endpoint).await?;
    let first: HashMap<(String, String), Owner> = metas
        .iter()
        .filter_map(|m| Some(((m.namespace.clone()?, m.name.clone()?), controller_of(m)?)))
        .collect();
    let wants = |kind: &str| pods.iter().any(|p| first.get(&(p.namespace.clone(), p.name.clone())).is_some_and(|o| o.kind == kind));
    let mut parents = Parents::new();
    for (kind, group, plural) in [("ReplicaSet", "apps", "replicasets"), ("Job", "batch", "jobs")] {
        if !wants(kind) {
            continue;
        }
        let api = scoped_api(client, group, "v1", kind, plural, namespace);
        // 읽지 못하면 그 종류에서 멈춘다: Pod는 ReplicaSet이나 Job까지만 묶인다
        let Ok(items) = list_meta(&api, &ListParams::default(), plural, endpoint).await else { continue };
        for m in items {
            if let (Some(ns), Some(name), Some(owner)) = (m.namespace.clone(), m.name.clone(), controller_of(&m)) {
                parents.insert((ns, kind.to_string(), name), owner);
            }
        }
    }
    for p in pods.iter_mut() {
        p.owners = owner_chain(&p.namespace, first.get(&(p.namespace.clone(), p.name.clone())).cloned(), &parents);
    }
    Ok(())
}

/// 네임스페이스(없으면 모든 네임스페이스)의 Pod 사용량과 노드 사용량. 읽을 수 없는 쪽은 비우고 까닭을 남긴다.
pub async fn metrics(client: &Client, namespace: Option<&str>, endpoint: Endpoint) -> Result<Metrics, AppError> {
    let pods_api = scoped_api(client, METRICS_GROUP, METRICS_VERSION, "PodMetrics", "pods", namespace);
    let nodes_api = scoped_api(client, METRICS_GROUP, METRICS_VERSION, "NodeMetrics", "nodes", None);
    let lp = ListParams::default();
    let (pods, nodes) = tokio::join!(
        read(pods_api.list(&lp), "pods.metrics.k8s.io", endpoint),
        read(nodes_api.list(&lp), "nodes.metrics.k8s.io", endpoint),
    );
    let (pods, nodes) = (pods?, nodes?);
    let (pods_unavailable, mut pods) = match pods {
        Ok(page) => (None, page.items.iter().map(pod_usage_of).collect::<Vec<_>>()),
        Err(u) => (Some(u), vec![]),
    };
    let (nodes_unavailable, nodes) = match nodes {
        Ok(page) => {
            let mut v: Vec<NodeUsage> = page.items.iter().map(usage_of).map(|(name, u)| NodeUsage { name, cpu_milli: u.cpu_milli, memory_bytes: u.memory_bytes }).collect();
            v.sort_by(|a, b| a.name.cmp(&b.name));
            (None, v)
        }
        Err(u) => (Some(u), vec![]),
    };
    pods.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
    if !pods.is_empty() {
        // 소유 관계를 읽지 못해도 사용량은 그대로 보인다(워크로드 합계만 빈다). 연결 오류는 위의 읽기에서 이미 났을 것이다.
        let _ = attach_owners(client, namespace, &mut pods, endpoint).await;
    }
    Ok(Metrics { pods_unavailable, nodes_unavailable, pods, nodes })
}

#[cfg(test)]
mod tests;
