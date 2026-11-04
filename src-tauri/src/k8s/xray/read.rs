//! 관계 계산에 쓸 객체를 클러스터에서 읽는다. GET·LIST만 쓰고, 읽지 못한 종류는 실패가 아니라 `gaps`에 담는다.
use futures::future::join_all;
use kube::api::ListParams;
use kube::Client;

use super::graph::unresolved_cluster_refs;
use super::pool::{Item, Pool, Spec, CLUSTER_WIDE, NAMESPACED};
use super::refs::Ref;
use crate::error::AppError;
use crate::k8s::failure::Endpoint;
use crate::k8s::read::{api_for, bounded, list_all};
use crate::k8s::rows::KindRef;
use crate::k8s::watch::PAGE_SIZE;

/// 한 종류를 읽는 쪽 수 한도. 넘으면 그 종류는 일부만 읽은 것으로 알린다.
pub const PAGES_MAX: usize = 6;
/// 클러스터 범위 객체를 이름으로 읽으며 참조를 따라가는 단계 한도(PVC → PV → StorageClass)
const FETCH_ROUNDS: usize = 4;

/// 본문 없이 메타데이터만 쪽을 넘기며 읽는다(Secret 값을 받지 않는다)
async fn list_meta(client: &Client, kind: &KindRef, namespace: Option<&str>, endpoint: Endpoint) -> Result<(Vec<Item>, bool), AppError> {
    let api = api_for(client.clone(), kind, namespace);
    let mut items = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..PAGES_MAX {
        let mut p = ListParams::default().limit(PAGE_SIZE);
        if let Some(t) = &token {
            p = p.continue_token(t);
        }
        let page = bounded(api.list_metadata(&p), "list", &kind.plural, endpoint).await?;
        items.extend(page.items.iter().map(|i| Item::meta(kind, &i.metadata)));
        token = page.metadata.continue_.filter(|c| !c.is_empty());
        if token.is_none() {
            return Ok((items, false));
        }
    }
    Ok((items, true))
}

async fn list_spec(client: &Client, spec: &Spec, namespace: Option<&str>, pod_node: Option<&str>, endpoint: Endpoint) -> Result<(Vec<Item>, bool), AppError> {
    let kind = spec.kind_ref();
    if spec.meta_only {
        return list_meta(client, &kind, namespace, endpoint).await;
    }
    let mut lp = ListParams::default();
    if let (Some(node), "Pod") = (pod_node, spec.kind) {
        lp = lp.fields(&format!("spec.nodeName={node}"));
    }
    let api = api_for(client.clone(), &kind, namespace);
    let (objects, stopped) = list_all(&api, &lp, PAGES_MAX, spec.plural, endpoint).await?;
    Ok((objects.iter().map(|o| Item::of(&kind, o)).collect(), stopped))
}

/// 이름으로 읽는다. 없으면 `None`.
async fn fetch(client: &Client, r: &Ref, endpoint: Endpoint) -> Result<Option<Item>, AppError> {
    let api = api_for(client.clone(), &r.kind, None);
    Ok(bounded(api.get_opt(&r.name), "get", &r.kind.plural, endpoint).await?.map(|o| Item::of(&r.kind, &o)))
}

/// 지금 보는 객체를 읽고(실패하면 명령도 실패), 관계에 쓸 종류를 읽어 더미를 만든다.
/// 네임스페이스 객체는 그 네임스페이스의 종류들, 클러스터 범위 객체는 모든 네임스페이스의 Pod·워크로드·PVC·PV를 읽는다.
pub async fn gather(client: &Client, kind: &KindRef, namespace: Option<&str>, name: &str, endpoint: Endpoint) -> Result<(Item, Pool), AppError> {
    let api = api_for(client.clone(), kind, namespace);
    let root = if kind.group.is_empty() && kind.kind == "Secret" {
        Item::meta(kind, &bounded(api.get_metadata(name), "get", &kind.plural, endpoint).await?.metadata)
    } else {
        Item::of(kind, &bounded(api.get(name), "get", &kind.plural, endpoint).await?)
    };
    let (specs, scope) = if kind.namespaced { (NAMESPACED, namespace) } else { (CLUSTER_WIDE, None) };
    // 노드를 보면 그 노드에 있는 Pod만 읽는다
    let pod_node = (kind.group.is_empty() && kind.kind == "Node").then_some(name);
    let lists = join_all(specs.iter().map(|spec| async move { (spec.kind_ref(), list_spec(client, spec, scope, pod_node, endpoint).await) })).await;
    let mut pool = Pool::default();
    pool.add(root.clone());
    for (k, result) in lists {
        pool.add_list(&k, result);
    }
    for _ in 0..FETCH_ROUNDS {
        let wanted = unresolved_cluster_refs(&root, &pool);
        if wanted.is_empty() {
            break;
        }
        let got = join_all(wanted.iter().map(|r| fetch(client, r, endpoint))).await;
        for (r, result) in wanted.iter().zip(got) {
            pool.add_fetched(r.key(), &r.kind, result);
        }
    }
    Ok((root, pool))
}
