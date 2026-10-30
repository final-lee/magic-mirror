//! 개요의 EKS 쪽: 클러스터 설정, 노드그룹, Fargate 프로필, 애드온(현재·최신 버전), Upgrade Insights. 읽기(Describe/List)만 한다.
//! 모든 호출은 `REQUEST_TIMEOUT` 안에 끝나야 하고, 목록은 `PAGES_MAX` 쪽까지만 넘긴다.
use std::future::Future;

use aws_sdk_eks::error::{ProvideErrorMetadata, SdkError};
use aws_sdk_eks::types::{Addon, Cluster, InsightSummary, Nodegroup};
use aws_sdk_eks::Client as Eks;
use serde::Serialize;

use crate::error::{from_sdk, AppError};
use crate::k8s::connect::REQUEST_TIMEOUT;
use crate::k8s::target::not_found;

pub const PAGES_MAX: usize = 20;

pub fn eks_timeout(action: &str) -> String {
    format!("EKS API가 30초 안에 답하지 않았어요({action})")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterView {
    pub version: String,
    pub platform_version: Option<String>,
    pub status: Option<String>,
    pub endpoint_public: bool,
    pub endpoint_private: bool,
    pub public_cidrs: Vec<String>,
    pub logging: Vec<String>,
    pub secrets_encrypted: bool,
    pub oidc_issuer: Option<String>,
    pub authentication_mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodegroupView {
    pub name: String,
    pub status: Option<String>,
    pub version: Option<String>,
    pub instance_types: Vec<String>,
    pub capacity_type: Option<String>,
    pub min: Option<i32>,
    pub max: Option<i32>,
    pub desired: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonView {
    pub name: String,
    pub version: Option<String>,
    pub latest: Option<String>,
    pub status: Option<String>,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightView {
    pub name: String,
    pub category: Option<String>,
    pub status: Option<String>,
    pub reason: Option<String>,
    pub description: Option<String>,
    pub kubernetes_version: Option<String>,
}

pub async fn call<T, E, R>(fut: impl Future<Output = Result<T, SdkError<E, R>>>, action: &str) -> Result<T, AppError>
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
    R: std::fmt::Debug + Send + Sync + 'static,
{
    match tokio::time::timeout(REQUEST_TIMEOUT, fut).await {
        Err(_) => Err(AppError::Network { message: eks_timeout(action) }),
        Ok(r) => r.map_err(|e| from_sdk(e, action)),
    }
}

/// `EncryptionConfig::resources`는 SDK에서 deprecated지만, KMS 봉투 암호화가 secrets에 켜졌는지는 이 필드로만 알 수 있다.
#[allow(deprecated)]
pub fn cluster_view(c: &Cluster) -> ClusterView {
    let vpc = c.resources_vpc_config();
    ClusterView {
        version: c.version().unwrap_or_default().to_string(),
        platform_version: c.platform_version().map(str::to_string),
        status: c.status().map(|s| s.as_str().to_string()),
        endpoint_public: vpc.is_some_and(|v| v.endpoint_public_access()),
        endpoint_private: vpc.is_some_and(|v| v.endpoint_private_access()),
        public_cidrs: vpc.map(|v| v.public_access_cidrs().to_vec()).unwrap_or_default(),
        logging: c
            .logging()
            .map(|l| l.cluster_logging().iter().filter(|s| s.enabled() == Some(true)).flat_map(|s| s.types().iter().map(|t| t.as_str().to_string())).collect())
            .unwrap_or_default(),
        secrets_encrypted: c.encryption_config().iter().any(|e| e.resources().iter().any(|r| r == "secrets")),
        oidc_issuer: c.identity().and_then(|i| i.oidc()).and_then(|o| o.issuer()).map(str::to_string),
        authentication_mode: c.access_config().and_then(|a| a.authentication_mode()).map(|m| m.as_str().to_string()),
    }
}

pub fn nodegroup_view(n: &Nodegroup) -> NodegroupView {
    let scaling = n.scaling_config();
    NodegroupView {
        name: n.nodegroup_name().unwrap_or_default().to_string(),
        status: n.status().map(|s| s.as_str().to_string()),
        version: n.version().map(str::to_string),
        instance_types: n.instance_types().to_vec(),
        capacity_type: n.capacity_type().map(|c| c.as_str().to_string()),
        min: scaling.and_then(|s| s.min_size()),
        max: scaling.and_then(|s| s.max_size()),
        desired: scaling.and_then(|s| s.desired_size()),
    }
}

pub fn addon_view(a: &Addon, latest: Option<String>) -> AddonView {
    AddonView {
        name: a.addon_name().unwrap_or_default().to_string(),
        version: a.addon_version().map(str::to_string),
        latest,
        status: a.status().map(|s| s.as_str().to_string()),
        issues: a
            .health()
            .map(|h| h.issues().iter().map(|i| format!("{}: {}", i.code().map_or("", |c| c.as_str()), i.message().unwrap_or(""))).collect())
            .unwrap_or_default(),
    }
}

pub fn insight_view(i: &InsightSummary) -> InsightView {
    let status = i.insight_status();
    InsightView {
        name: i.name().unwrap_or_default().to_string(),
        category: i.category().map(|c| c.as_str().to_string()),
        status: status.and_then(|s| s.status()).map(|s| s.as_str().to_string()),
        reason: status.and_then(|s| s.reason()).map(str::to_string),
        description: i.description().map(str::to_string),
        kubernetes_version: i.kubernetes_version().map(str::to_string),
    }
}

fn numbers(v: &str) -> Vec<u64> {
    v.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).filter_map(|s| s.parse().ok()).collect()
}

/// `v1.10.0-eksbuild.2` 같은 버전에서 숫자만 차례로 비교해 가장 큰 것
pub fn latest_version<'a>(versions: impl Iterator<Item = &'a str>) -> Option<String> {
    versions.max_by(|a, b| numbers(a).cmp(&numbers(b))).map(str::to_string)
}

pub async fn describe(eks: &Eks, cluster: &str) -> Result<ClusterView, AppError> {
    let out = call(eks.describe_cluster().name(cluster).send(), "eks:DescribeCluster").await?;
    out.cluster().map(cluster_view).ok_or_else(|| AppError::other(not_found(cluster)))
}

pub async fn nodegroups(eks: &Eks, cluster: &str) -> Result<Vec<NodegroupView>, AppError> {
    let mut names = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..PAGES_MAX {
        let out = call(eks.list_nodegroups().cluster_name(cluster).set_next_token(token.take()).send(), "eks:ListNodegroups").await?;
        names.extend(out.nodegroups().iter().cloned());
        token = out.next_token().map(str::to_string);
        if token.is_none() {
            break;
        }
    }
    let views = futures::future::try_join_all(names.iter().map(|n| async move {
        let out = call(eks.describe_nodegroup().cluster_name(cluster).nodegroup_name(n).send(), "eks:DescribeNodegroup").await?;
        Ok::<_, AppError>(out.nodegroup().map(nodegroup_view))
    }))
    .await?;
    Ok(views.into_iter().flatten().collect())
}

pub async fn fargate_profiles(eks: &Eks, cluster: &str) -> Result<Vec<String>, AppError> {
    let mut names = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..PAGES_MAX {
        let out = call(eks.list_fargate_profiles().cluster_name(cluster).set_next_token(token.take()).send(), "eks:ListFargateProfiles").await?;
        names.extend(out.fargate_profile_names().iter().cloned());
        token = out.next_token().map(str::to_string);
        if token.is_none() {
            break;
        }
    }
    Ok(names)
}

/// 이 클러스터 버전에서 쓸 수 있는 가장 새 버전. 읽지 못하면 None(애드온 목록은 그대로 보인다).
async fn latest_for(eks: &Eks, addon: &str, version: &str) -> Option<String> {
    let out = call(eks.describe_addon_versions().addon_name(addon).kubernetes_version(version).send(), "eks:DescribeAddonVersions").await.ok()?;
    latest_version(out.addons().iter().flat_map(|a| a.addon_versions()).filter_map(|v| v.addon_version()))
}

pub async fn addons(eks: &Eks, cluster: &str, version: Option<&str>) -> Result<Vec<AddonView>, AppError> {
    let mut names = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..PAGES_MAX {
        let out = call(eks.list_addons().cluster_name(cluster).set_next_token(token.take()).send(), "eks:ListAddons").await?;
        names.extend(out.addons().iter().cloned());
        token = out.next_token().map(str::to_string);
        if token.is_none() {
            break;
        }
    }
    let views = futures::future::try_join_all(names.iter().map(|n| async move {
        let out = call(eks.describe_addon().cluster_name(cluster).addon_name(n).send(), "eks:DescribeAddon").await?;
        let latest = match version {
            Some(v) => latest_for(eks, n, v).await,
            None => None,
        };
        Ok::<_, AppError>(out.addon().map(|a| addon_view(a, latest)))
    }))
    .await?;
    Ok(views.into_iter().flatten().collect())
}

pub async fn insights(eks: &Eks, cluster: &str) -> Result<Vec<InsightView>, AppError> {
    let mut out_views = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..PAGES_MAX {
        let out = call(eks.list_insights().cluster_name(cluster).set_next_token(token.take()).send(), "eks:ListInsights").await?;
        out_views.extend(out.insights().iter().map(insight_view));
        token = out.next_token().map(str::to_string);
        if token.is_none() {
            break;
        }
    }
    Ok(out_views)
}

#[cfg(test)]
mod tests;
