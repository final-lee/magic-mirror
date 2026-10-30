//! 대상 클러스터: 프로필·리전·이름. EKS API로 ARN, 엔드포인트, 버전, 엔드포인트 공개 범위를 읽는다(클러스터에는 연결하지 않는다).
use aws_config::SdkConfig;
use serde::{Deserialize, Serialize};

use crate::error::{from_sdk, AppError};

pub const NO_ENDPOINT: &str = "클러스터 엔드포인트가 아직 없어요. 클러스터가 만들어지는 중인지 확인해 주세요";

pub fn not_found(name: &str) -> String {
    format!("클러스터를 찾을 수 없어요: {name}")
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sTarget {
    pub profile: String,
    pub region: String,
    pub cluster: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClusterInfo {
    pub arn: String,
    pub endpoint: String,
    pub version: String,
    pub endpoint_public: bool,
    pub endpoint_private: bool,
    pub public_cidrs: Vec<String>,
}

pub fn cluster_info(c: &aws_sdk_eks::types::Cluster) -> Result<ClusterInfo, AppError> {
    let vpc = c.resources_vpc_config();
    let endpoint = c.endpoint().filter(|e| !e.is_empty()).ok_or_else(|| AppError::other(NO_ENDPOINT))?;
    Ok(ClusterInfo {
        arn: c.arn().unwrap_or_default().to_string(),
        endpoint: endpoint.to_string(),
        version: c.version().unwrap_or_default().to_string(),
        endpoint_public: vpc.is_some_and(|v| v.endpoint_public_access()),
        endpoint_private: vpc.is_some_and(|v| v.endpoint_private_access()),
        public_cidrs: vpc.map(|v| v.public_access_cidrs().to_vec()).unwrap_or_default(),
    })
}

pub async fn describe_cluster(cfg: &SdkConfig, name: &str) -> Result<ClusterInfo, AppError> {
    let out = aws_sdk_eks::Client::new(cfg).describe_cluster().name(name).send().await.map_err(|e| from_sdk(e, "eks:DescribeCluster"))?;
    let cluster = out.cluster().ok_or_else(|| AppError::other(not_found(name)))?;
    cluster_info(cluster)
}

#[cfg(test)]
mod tests;
