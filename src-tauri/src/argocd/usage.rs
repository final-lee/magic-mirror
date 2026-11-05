//! 앱의 Pod 사용량: 대상 클러스터의 metrics-server 사용량과 Pod 스펙의 요청·제한.
//! 어떤 Pod가 앱의 것인지는 화면이 리소스 트리에서 골라 보낸다.
use std::collections::{BTreeSet, HashMap, HashSet};

use kube::api::{Api, DynamicObject, ListParams};
use kube::Client;
use serde::{Deserialize, Serialize};

use super::cluster::ENDPOINT;
use crate::error::AppError;
use crate::k8s::read::metrics::{bounds_of_pod, pod_usage_of, read, scoped_api, Bounds, Unavailable};
use crate::k8s::watch::PAGE_SIZE;

/// 한 번에 이름으로 따로 읽는 네임스페이스 수. 넘으면 모든 네임스페이스를 한 번에 읽고 거른다.
const NAMESPACES_MAX: usize = 8;
const PAGES_MAX: usize = 40;

#[derive(Debug, Clone, Deserialize)]
pub struct PodRef {
    pub namespace: String,
    pub name: String,
}

/// Pod 하나의 지금 사용량과 요청·제한. 사용량은 metrics-server가 아직 모으지 않은 Pod(방금 뜬 것)면 None.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodReading {
    pub namespace: String,
    pub name: String,
    pub cpu_milli: Option<i64>,
    pub memory_bytes: Option<i64>,
    pub bounds: Bounds,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUsage {
    /// metrics-server를 읽지 못하는 까닭. 있으면 사용량은 모두 비어 있다.
    pub unavailable: Option<Unavailable>,
    pub pods: Vec<PodReading>,
}

/// 사용량 목록과 Pod 목록을 합쳐, 요청한 Pod마다 한 줄을 만든다(이름 순).
pub fn readings(wanted: &[PodRef], usage: &HashMap<(String, String), (i64, i64)>, bounds: &HashMap<(String, String), Bounds>) -> Vec<PodReading> {
    let mut out: Vec<PodReading> = wanted
        .iter()
        .map(|p| (p.namespace.clone(), p.name.clone()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|key| {
            let used = usage.get(&key).copied();
            PodReading {
                cpu_milli: used.map(|u| u.0),
                memory_bytes: used.map(|u| u.1),
                bounds: bounds.get(&key).copied().unwrap_or_default(),
                namespace: key.0,
                name: key.1,
            }
        })
        .collect();
    out.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
    out
}

async fn list_pages(api: &Api<DynamicObject>, resource: &str) -> Result<Result<Vec<DynamicObject>, Unavailable>, AppError> {
    let mut items = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..PAGES_MAX {
        let mut params = ListParams::default().limit(PAGE_SIZE);
        if let Some(t) = &token {
            params = params.continue_token(t);
        }
        match read(api.list(&params), resource, ENDPOINT).await? {
            Ok(page) => {
                token = page.metadata.continue_.clone().filter(|c| !c.is_empty());
                items.extend(page.items);
            }
            Err(unavailable) => return Ok(Err(unavailable)),
        }
        if token.is_none() {
            break;
        }
    }
    Ok(Ok(items))
}

pub async fn read_usage(client: &Client, wanted: &[PodRef]) -> Result<AppUsage, AppError> {
    let keys: HashSet<(String, String)> = wanted.iter().map(|p| (p.namespace.clone(), p.name.clone())).collect();
    let namespaces: BTreeSet<&str> = wanted.iter().map(|p| p.namespace.as_str()).collect();
    let scopes: Vec<Option<&str>> = if namespaces.len() > NAMESPACES_MAX {
        vec![None]
    } else {
        namespaces.into_iter().map(Some).collect()
    };
    let mut usage = HashMap::new();
    let mut bounds = HashMap::new();
    for scope in scopes {
        let metrics_api = scoped_api(client, "metrics.k8s.io", "v1beta1", "PodMetrics", "pods", scope);
        let pods_api = scoped_api(client, "", "v1", "Pod", "pods", scope);
        let (metrics, pods) = tokio::join!(list_pages(&metrics_api, "pods.metrics.k8s.io"), list_pages(&pods_api, "pods"));
        match metrics? {
            Ok(items) => {
                for item in &items {
                    let pod = pod_usage_of(item);
                    let key = (pod.namespace, pod.name);
                    if keys.contains(&key) {
                        usage.insert(key, (pod.cpu_milli, pod.memory_bytes));
                    }
                }
            }
            Err(unavailable) => {
                return Ok(AppUsage {
                    unavailable: Some(unavailable),
                    pods: readings(wanted, &HashMap::new(), &HashMap::new()),
                })
            }
        }
        // Pod 스펙을 못 읽으면(권한) 요청·제한만 비워 둔다
        if let Ok(items) = pods? {
            for item in &items {
                let key = (item.metadata.namespace.clone().unwrap_or_default(), item.metadata.name.clone().unwrap_or_default());
                if keys.contains(&key) {
                    if let Ok(value) = serde_json::to_value(item) {
                        bounds.insert(key, bounds_of_pod(&value));
                    }
                }
            }
        }
    }
    Ok(AppUsage {
        unavailable: None,
        pods: readings(wanted, &usage, &bounds),
    })
}

#[cfg(test)]
mod tests;
