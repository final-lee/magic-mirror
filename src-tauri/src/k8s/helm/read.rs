//! helm 저장소(Secret `helm.sh/release.v1`와 ConfigMap)를 읽어 릴리스 목록과 이력을 만든다. GET·LIST만 쓴다.
//! 목록은 먼저 메타데이터만 받아(라벨에 이름·리비전·상태가 있다) 릴리스마다 가장 높은 리비전을 고르고, 그 리비전의 데이터만 가져와 푼다.
//! 푼 요약은 저장소 객체의 uid·resourceVersion을 키로 기억해 다시 읽을 때 데이터를 다시 받지 않는다.
use std::collections::{BTreeMap, HashMap};
use std::fmt::Debug;
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};

use futures::stream::{self, StreamExt};
use k8s_openapi::api::core::v1::{ConfigMap, Secret};
use kube::api::{Api, ListParams, PartialObjectMeta};
use serde::de::DeserializeOwned;
use serde::Serialize;

use super::release::{decode, is_problem, Driver, Release, OWNER_SELECTOR, SECRET_TYPE, UNREADABLE};
use super::Cluster;
use crate::error::AppError;
use crate::k8s::failure::Endpoint;
use crate::k8s::read::bounded;

pub const NOT_FOUND: &str = "릴리스를 찾지 못했어요";
pub const REVISION_NOT_FOUND: &str = "그 리비전을 찾지 못했어요";
const PAGE: u32 = 500;
/// 릴리스 데이터를 동시에 가져오는 수
const FETCH_PARALLEL: usize = 8;
/// 기억해 둘 요약의 한도. 넘으면 모두 버리고 다시 쌓는다
const CACHE_MAX: usize = 4000;

/// 저장소 객체 하나의 메타데이터(데이터는 아직 읽지 않았다)
#[derive(Clone, Debug, PartialEq)]
pub struct Stored {
    pub driver: Driver,
    pub namespace: String,
    /// 릴리스 이름(`name` 라벨)
    pub name: String,
    pub revision: u32,
    /// `status` 라벨
    pub status: String,
    /// 저장소 객체 이름
    pub object: String,
    pub uid: String,
    pub resource_version: String,
}

/// 리비전 하나의 요약(이력 표와 목록 줄이 쓴다)
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub revision: u32,
    pub status: String,
    pub updated: Option<String>,
    /// `이름-버전`
    pub chart: String,
    pub chart_name: String,
    pub chart_version: String,
    pub app_version: String,
    pub description: String,
    /// 데이터를 풀지 못해 라벨의 값만 있다
    pub unreadable: bool,
}

impl Revision {
    pub fn of(release: &Release) -> Revision {
        Revision {
            revision: release.version,
            status: release.info.status.clone(),
            updated: release.info.last_deployed.clone(),
            chart: release.chart.label(),
            chart_name: release.chart.name(),
            chart_version: release.chart.version(),
            app_version: release.chart.app_version(),
            description: release.info.description.clone(),
            unreadable: false,
        }
    }

    fn unreadable(stored: &Stored) -> Revision {
        Revision {
            revision: stored.revision,
            status: stored.status.clone(),
            updated: None,
            chart: String::new(),
            chart_name: String::new(),
            chart_version: String::new(),
            app_version: String::new(),
            description: String::new(),
            unreadable: true,
        }
    }
}

/// 목록의 한 줄: 릴리스의 가장 높은 리비전
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseRow {
    pub name: String,
    pub namespace: String,
    pub revision: u32,
    pub status: String,
    /// 실패했거나 끝나지 않은 작업이 걸려 있다
    pub problem: bool,
    pub chart: String,
    pub chart_name: String,
    pub chart_version: String,
    pub app_version: String,
    pub updated: Option<String>,
    pub description: String,
    /// 저장돼 있는 리비전 수
    pub revisions: usize,
    pub driver: Driver,
    pub unreadable: bool,
}

static CACHE: LazyLock<Mutex<HashMap<String, Revision>>> = LazyLock::new(Mutex::default);

fn cache() -> MutexGuard<'static, HashMap<String, Revision>> {
    CACHE.lock().unwrap_or_else(PoisonError::into_inner)
}

fn cache_key(stored: &Stored) -> String {
    format!("{}/{}", stored.uid, stored.resource_version)
}

fn remember(stored: &Stored, revision: &Revision) {
    let mut cache = cache();
    if cache.len() >= CACHE_MAX {
        cache.clear();
    }
    cache.insert(cache_key(stored), revision.clone());
}

fn stored_of<K>(driver: Driver, item: &PartialObjectMeta<K>) -> Option<Stored> {
    let meta = &item.metadata;
    let labels = meta.labels.as_ref()?;
    Some(Stored {
        driver,
        namespace: meta.namespace.clone()?,
        name: labels.get("name")?.clone(),
        revision: labels.get("version")?.parse().ok()?,
        status: labels.get("status").cloned().unwrap_or_default(),
        object: meta.name.clone()?,
        uid: meta.uid.clone().unwrap_or_default(),
        resource_version: meta.resource_version.clone().unwrap_or_default(),
    })
}

async fn metadata_pages<K>(api: &Api<K>, base: &ListParams, resource: &str, endpoint: Endpoint) -> Result<Vec<PartialObjectMeta<K>>, AppError>
where
    K: kube::Resource + Clone + DeserializeOwned + Debug,
{
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut params = base.clone().limit(PAGE);
        if let Some(t) = &token {
            params = params.continue_token(t);
        }
        let page = bounded(api.list_metadata(&params), "list", resource, endpoint).await?;
        out.extend(page.items);
        token = page.metadata.continue_.filter(|c| !c.is_empty());
        if token.is_none() {
            return Ok(out);
        }
    }
}

fn denied(result: &Result<Vec<Stored>, AppError>) -> bool {
    matches!(result, Err(AppError::AccessDenied { .. }))
}

/// helm이 만든 저장소 객체의 메타데이터. Secret이 기본이고 ConfigMap 드라이버도 함께 본다(권한이 없는 쪽은 건너뛴다).
/// 같은 (네임스페이스, 이름, 리비전)이 둘 다 있으면 Secret을 쓴다.
pub async fn list_stored(cluster: &Cluster, namespace: Option<&str>, release: Option<&str>) -> Result<Vec<Stored>, AppError> {
    let selector = match release {
        Some(name) => format!("{OWNER_SELECTOR},name={name}"),
        None => OWNER_SELECTOR.to_string(),
    };
    let secrets: Api<Secret> = match namespace {
        Some(ns) => Api::namespaced(cluster.client.clone(), ns),
        None => Api::all(cluster.client.clone()),
    };
    let configs: Api<ConfigMap> = match namespace {
        Some(ns) => Api::namespaced(cluster.client.clone(), ns),
        None => Api::all(cluster.client.clone()),
    };
    let secret_params = ListParams::default().labels(&selector).fields(&format!("type={SECRET_TYPE}"));
    let config_params = ListParams::default().labels(&selector);
    let (secret_items, config_items) = tokio::join!(
        metadata_pages(&secrets, &secret_params, "secrets", cluster.endpoint),
        metadata_pages(&configs, &config_params, "configmaps", cluster.endpoint),
    );
    let from_secrets = secret_items.map(|items| items.iter().filter_map(|i| stored_of(Driver::Secret, i)).collect::<Vec<_>>());
    let from_configs = config_items.map(|items| items.iter().filter_map(|i| stored_of(Driver::ConfigMap, i)).collect::<Vec<_>>());
    let (mut out, extra) = match (from_secrets, from_configs) {
        (Ok(s), Ok(c)) => (s, c),
        (Ok(s), c) if denied(&c) => (s, Vec::new()),
        (s, Ok(c)) if denied(&s) => (Vec::new(), c),
        (Err(e), _) | (_, Err(e)) => return Err(e),
    };
    for item in extra {
        if !out.iter().any(|s| s.namespace == item.namespace && s.name == item.name && s.revision == item.revision) {
            out.push(item);
        }
    }
    Ok(out)
}

/// 릴리스 하나의 저장소 객체들, 높은 리비전부터. 없으면 빈 목록.
pub async fn locate(cluster: &Cluster, namespace: &str, name: &str) -> Result<Vec<Stored>, AppError> {
    let mut stored: Vec<Stored> = list_stored(cluster, Some(namespace), Some(name)).await?.into_iter().filter(|s| s.name == name).collect();
    stored.sort_by_key(|s| std::cmp::Reverse(s.revision));
    Ok(stored)
}

/// 저장소 객체의 `release` 데이터를 풀어 릴리스로 만든다
pub async fn fetch(cluster: &Cluster, stored: &Stored) -> Result<Release, AppError> {
    let payload: Option<Vec<u8>> = match stored.driver {
        Driver::Secret => {
            let api: Api<Secret> = Api::namespaced(cluster.client.clone(), &stored.namespace);
            let secret = bounded(api.get(&stored.object), "get", "secrets", cluster.endpoint).await?;
            secret.data.and_then(|mut data| data.remove("release")).map(|bytes| bytes.0)
        }
        Driver::ConfigMap => {
            let api: Api<ConfigMap> = Api::namespaced(cluster.client.clone(), &stored.namespace);
            let config = bounded(api.get(&stored.object), "get", "configmaps", cluster.endpoint).await?;
            config.data.and_then(|mut data| data.remove("release")).map(String::into_bytes)
        }
    };
    let release = decode(&payload.ok_or_else(|| AppError::other(UNREADABLE))?)?;
    remember(stored, &Revision::of(&release));
    Ok(release)
}

/// 리비전 하나의 요약. 기억해 둔 것이 있으면 데이터를 받지 않는다. 풀지 못하는 데이터는 라벨 값만 담은 요약이 된다.
async fn summarize(cluster: &Cluster, stored: &Stored) -> Result<Revision, AppError> {
    if let Some(known) = cache().get(&cache_key(stored)) {
        return Ok(known.clone());
    }
    match fetch(cluster, stored).await {
        Ok(release) => Ok(Revision::of(&release)),
        Err(AppError::Other { message }) if message == UNREADABLE => {
            let revision = Revision::unreadable(stored);
            remember(stored, &revision);
            Ok(revision)
        }
        Err(error) => Err(error),
    }
}

async fn summarize_all(cluster: &Cluster, stored: &[Stored]) -> Result<Vec<Revision>, AppError> {
    stream::iter(stored.iter().cloned()).map(|s| async move { summarize(cluster, &s).await }).buffered(FETCH_PARALLEL).collect::<Vec<_>>().await.into_iter().collect()
}

/// 릴리스의 모든 리비전 요약, 높은 리비전부터
pub async fn history(cluster: &Cluster, stored: &[Stored]) -> Result<Vec<Revision>, AppError> {
    summarize_all(cluster, stored).await
}

/// 선택한 네임스페이스(없으면 전체)의 릴리스 목록. 릴리스마다 가장 높은 리비전 한 줄, 네임스페이스·이름 순.
pub async fn list(cluster: &Cluster, namespace: Option<&str>) -> Result<Vec<ReleaseRow>, AppError> {
    let mut groups: BTreeMap<(String, String), Vec<Stored>> = BTreeMap::new();
    for item in list_stored(cluster, namespace, None).await? {
        groups.entry((item.namespace.clone(), item.name.clone())).or_default().push(item);
    }
    let latest: Vec<(Stored, usize)> = groups
        .into_values()
        .filter_map(|items| {
            let count = items.len();
            items.into_iter().max_by_key(|s| s.revision).map(|s| (s, count))
        })
        .collect();
    let heads: Vec<Stored> = latest.iter().map(|(s, _)| s.clone()).collect();
    let summaries = summarize_all(cluster, &heads).await?;
    Ok(latest.into_iter().zip(summaries).map(|((stored, count), summary)| row(&stored, count, summary)).collect())
}

fn row(stored: &Stored, count: usize, summary: Revision) -> ReleaseRow {
    // 상태는 데이터 안의 값이 정확하다(풀지 못하면 라벨)
    let status = if summary.status.is_empty() { stored.status.clone() } else { summary.status.clone() };
    ReleaseRow {
        name: stored.name.clone(),
        namespace: stored.namespace.clone(),
        revision: stored.revision,
        problem: is_problem(&status),
        status,
        chart: summary.chart,
        chart_name: summary.chart_name,
        chart_version: summary.chart_version,
        app_version: summary.app_version,
        updated: summary.updated,
        description: summary.description,
        revisions: count,
        driver: stored.driver,
        unreadable: summary.unreadable,
    }
}

#[cfg(test)]
mod tests;
