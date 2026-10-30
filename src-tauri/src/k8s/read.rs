//! 읽기 화면의 조회. 목록 값, 상세, 소유 관계, 이벤트, discovery, Secret 가리기, 개요. GET·LIST·WATCH만 쓴다(`hygiene`이 지킨다).
use std::future::Future;

use kube::api::{Api, ApiResource, DynamicObject, GroupVersionKind, ListParams};
use kube::Client;

use super::connect::REQUEST_TIMEOUT;
use super::failure::{describe, failure_of, Endpoint, Failure};
use super::rows::KindRef;
use super::watch::PAGE_SIZE;
use crate::error::AppError;

pub mod detail;
pub mod eks;
pub mod kinds;
pub mod nodes;
pub mod overview;
pub mod quantity;
pub mod removed;
pub mod secret;
pub mod values;
pub mod yaml;

/// 쿠버네티스 요청 하나를 `REQUEST_TIMEOUT` 안에 끝낸다. 시간이 넘으면 엔드포인트에 맞는 연결 안내, 오류는 동작·리소스 이름으로 가른다.
pub async fn bounded<T>(fut: impl Future<Output = Result<T, kube::Error>>, verb: &str, resource: &str, endpoint: Endpoint) -> Result<T, AppError> {
    tokio::time::timeout(REQUEST_TIMEOUT, fut)
        .await
        .map_err(|_| describe(&Failure::Unreachable, endpoint))?
        .map_err(|e| describe(&failure_of(&e, verb, resource), endpoint))
}

/// 쪽을 넘기며 끝까지 읽되 `max_pages` 쪽에서 멈춘다. 둘째 값은 멈췄는지(뒤에 더 있음).
pub async fn list_all(api: &Api<DynamicObject>, lp: &ListParams, max_pages: usize, resource: &str, endpoint: Endpoint) -> Result<(Vec<DynamicObject>, bool), AppError> {
    let mut items = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..max_pages {
        let mut p = lp.clone().limit(PAGE_SIZE);
        if let Some(t) = &token {
            p = p.continue_token(t);
        }
        let page = bounded(api.list(&p), "list", resource, endpoint).await?;
        items.extend(page.items);
        token = page.metadata.continue_.filter(|c| !c.is_empty());
        if token.is_none() {
            return Ok((items, false));
        }
    }
    Ok((items, true))
}

/// 종류와 네임스페이스로 동적 API를 만든다. 빈 이름이나 클러스터 범위 종류는 모든 네임스페이스로 본다(빈 경로를 만들지 않는다).
pub fn api_for(client: Client, kind: &KindRef, namespace: Option<&str>) -> Api<DynamicObject> {
    let gvk = GroupVersionKind::gvk(&kind.group, &kind.version, &kind.kind);
    let ar = ApiResource::from_gvk_with_plural(&gvk, &kind.plural);
    match (namespace.filter(|n| !n.is_empty()), kind.namespaced) {
        (Some(ns), true) => Api::namespaced_with(client, ns, &ar),
        _ => Api::all_with(client, &ar),
    }
}

#[cfg(test)]
mod tests;
