//! 개요 한 장. EKS 쪽과 쿠버네티스 쪽을 함께 읽고, 읽지 못한 부분은 `gaps`에 남긴다(나머지는 그대로 보인다).
use std::collections::HashMap;

use kube::api::{Api, DynamicObject, ListParams};
use kube::discovery::Discovery;
use kube::Client;
use serde::Serialize;

use super::eks::{self, AddonView, ClusterView, InsightView, NodegroupView};
use super::kinds::discover;
use super::nodes::{allocated_by_node, node_view, skew, usage_of, Allocated, NodeView, Skew, Usage};
use super::removed::{self, next_minor, RemovedUse};
use super::{api_for, bounded, list_all};
use crate::error::AppError;
use crate::k8s::failure::Endpoint;
use crate::k8s::rows::KindRef;

pub const LIST_PAGES_MAX: usize = 20;
pub const RUNNING_PODS: &str = "status.phase!=Succeeded,status.phase!=Failed";
const METRICS_GROUP: &str = "metrics.k8s.io";
const KARPENTER_GROUP: &str = "karpenter.sh";

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Section {
    Cluster,
    Nodes,
    Metrics,
    Nodegroups,
    Fargate,
    NodePools,
    Addons,
    Insights,
    RemovedApis,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub section: Section,
    pub error: AppError,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub cluster: Option<ClusterView>,
    pub nodes: Option<Vec<NodeView>>,
    pub requests_partial: bool,
    pub metrics: bool,
    pub nodegroups: Option<Vec<NodegroupView>>,
    pub fargate_profiles: Option<Vec<String>>,
    pub node_pools: Option<Vec<String>>,
    pub addons: Option<Vec<AddonView>>,
    pub insights: Option<Vec<InsightView>>,
    pub removed_apis: Option<Vec<RemovedUse>>,
    pub next_version: Option<String>,
    pub skew: Vec<Skew>,
    pub gaps: Vec<Gap>,
}

pub struct EksParts {
    pub cluster: Result<ClusterView, AppError>,
    pub nodegroups: Result<Vec<NodegroupView>, AppError>,
    pub fargate: Result<Vec<String>, AppError>,
    pub addons: Result<Vec<AddonView>, AppError>,
    pub insights: Result<Vec<InsightView>, AppError>,
}

pub struct K8sParts {
    pub nodes: Result<Vec<DynamicObject>, AppError>,
    /// 노드별 요청·제한 합과, Pod 목록이 잘렸는지
    pub allocated: Result<(HashMap<String, Allocated>, bool), AppError>,
    pub usage: Result<Option<HashMap<String, Usage>>, AppError>,
    pub node_pools: Result<Option<Vec<String>>, AppError>,
    pub removed: Result<Option<Vec<RemovedUse>>, AppError>,
}

fn keep<T>(r: Result<T, AppError>, section: Section, gaps: &mut Vec<Gap>) -> Option<T> {
    match r {
        Ok(v) => Some(v),
        Err(error) => {
            gaps.push(Gap { section, error });
            None
        }
    }
}

pub fn assemble(eks: EksParts, k8s: K8sParts) -> Overview {
    let mut gaps = Vec::new();
    let cluster = keep(eks.cluster, Section::Cluster, &mut gaps);
    let nodegroups = keep(eks.nodegroups, Section::Nodegroups, &mut gaps);
    let fargate_profiles = keep(eks.fargate, Section::Fargate, &mut gaps);
    let addons = keep(eks.addons, Section::Addons, &mut gaps);
    let insights = keep(eks.insights, Section::Insights, &mut gaps);
    let node_items = keep(k8s.nodes, Section::Nodes, &mut gaps);
    let (allocated, requests_partial) = keep(k8s.allocated, Section::Nodes, &mut gaps).unwrap_or_default();
    let usage = keep(k8s.usage, Section::Metrics, &mut gaps).flatten();
    let node_pools = keep(k8s.node_pools, Section::NodePools, &mut gaps).flatten();
    let removed_apis = keep(k8s.removed, Section::RemovedApis, &mut gaps).flatten();
    let nodes = node_items.map(|items| {
        let mut views: Vec<NodeView> = items
            .iter()
            .map(|n| {
                let name = n.metadata.name.clone().unwrap_or_default();
                node_view(n, allocated.get(&name).copied().unwrap_or_default(), usage.as_ref().and_then(|u| u.get(&name).copied()))
            })
            .collect();
        views.sort_by(|a, b| a.name.cmp(&b.name));
        views
    });
    let version = cluster.as_ref().map(|c| c.version.clone());
    let skew = match (&version, &nodes) {
        (Some(v), Some(n)) => skew(v, n),
        _ => vec![],
    };
    Overview {
        next_version: version.as_deref().and_then(next_minor),
        cluster,
        nodes,
        requests_partial,
        metrics: usage.is_some(),
        nodegroups,
        fargate_profiles,
        node_pools,
        addons,
        insights,
        removed_apis,
        skew,
        gaps,
    }
}

fn core(kind: &str, plural: &str, namespaced: bool) -> KindRef {
    KindRef { group: String::new(), version: "v1".into(), kind: kind.into(), plural: plural.into(), namespaced }
}

async fn node_usage(client: &Client, d: &Discovery, endpoint: Endpoint) -> Result<Option<HashMap<String, Usage>>, AppError> {
    let Some((ar, _)) = d.get(METRICS_GROUP).and_then(|g| g.recommended_kind("NodeMetrics")) else { return Ok(None) };
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
    let page = bounded(api.list(&ListParams::default()), "list", "nodes.metrics.k8s.io", endpoint).await?;
    Ok(Some(page.items.iter().map(usage_of).collect()))
}

async fn node_pools(client: &Client, d: &Discovery, endpoint: Endpoint) -> Result<Option<Vec<String>>, AppError> {
    let Some((ar, _)) = d.get(KARPENTER_GROUP).and_then(|g| g.recommended_kind("NodePool")) else { return Ok(None) };
    let (items, _) = list_all(&Api::all_with(client.clone(), &ar), &ListParams::default(), 1, "nodepools", endpoint).await?;
    let mut names: Vec<String> = items.into_iter().filter_map(|o| o.metadata.name).collect();
    names.sort();
    Ok(Some(names))
}

/// 다음 버전에서 제거되는 표 항목마다, 서버가 목록용 버전을 내줄 때만 한 쪽(500개)을 읽어 옛 API로 쓴 것을 고른다
async fn removed_uses(client: &Client, d: &Discovery, version: Option<&str>, endpoint: Endpoint) -> Result<Option<Vec<RemovedUse>>, AppError> {
    let Some(version) = version else { return Ok(None) };
    let mut out = Vec::new();
    for r in removed::due(version) {
        if !d.get(r.list_group).is_some_and(|g| g.versions().any(|v| v == r.list_version)) {
            continue;
        }
        let kind = KindRef { group: r.list_group.into(), version: r.list_version.into(), kind: r.kind.into(), plural: r.plural.into(), namespaced: r.namespaced };
        let (items, _) = list_all(&api_for(client.clone(), &kind, None), &ListParams::default(), 1, r.plural, endpoint).await?;
        out.extend(removed::uses_of(r, &items));
    }
    Ok(Some(out))
}

pub async fn k8s_parts(client: &Client, version: Option<&str>, endpoint: Endpoint) -> K8sParts {
    let nodes_api = api_for(client.clone(), &core("Node", "nodes", false), None);
    let pods_api = api_for(client.clone(), &core("Pod", "pods", true), None);
    let pods_lp = ListParams::default().fields(RUNNING_PODS);
    let (discovery, nodes, allocated) = tokio::join!(
        discover(client, endpoint),
        async { list_all(&nodes_api, &ListParams::default(), LIST_PAGES_MAX, "nodes", endpoint).await.map(|(items, _)| items) },
        async { list_all(&pods_api, &pods_lp, LIST_PAGES_MAX, "pods", endpoint).await.map(|(items, partial)| (allocated_by_node(&items), partial)) },
    );
    let (usage, node_pools, removed) = match discovery {
        Err(e) => (Err(e.clone()), Err(e.clone()), Err(e)),
        Ok(d) => tokio::join!(node_usage(client, &d, endpoint), node_pools(client, &d, endpoint), removed_uses(client, &d, version, endpoint)),
    };
    K8sParts { nodes, allocated, usage, node_pools, removed }
}

/// 클러스터 버전을 먼저 읽고(애드온 최신 버전, 제거되는 API, 버전 차이에 쓴다) 나머지는 함께 읽는다
pub async fn overview(eks_client: &aws_sdk_eks::Client, cluster: &str, client: &Client, endpoint: Endpoint) -> Overview {
    let described = eks::describe(eks_client, cluster).await;
    let version = described.as_ref().ok().map(|c| c.version.clone());
    let v = version.as_deref();
    let (nodegroups, fargate, addons, insights, k8s) = tokio::join!(
        eks::nodegroups(eks_client, cluster),
        eks::fargate_profiles(eks_client, cluster),
        eks::addons(eks_client, cluster, v),
        eks::insights(eks_client, cluster),
        k8s_parts(client, v, endpoint),
    );
    assemble(EksParts { cluster: described, nodegroups, fargate, addons, insights }, k8s)
}

#[cfg(test)]
mod tests;
