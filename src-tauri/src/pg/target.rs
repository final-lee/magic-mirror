//! 대상 확인: 탭이 여는 RDS 클러스터·인스턴스를 RDS API로 읽어 접속에 필요한 값(엔드포인트, 포트, 기본 데이터베이스, IAM 인증 여부)만 뽑는다.
//! DB에는 연결하지 않는다.

use aws_config::SdkConfig;
use aws_sdk_rds::types::{DbCluster, DbInstance};
use serde::{Deserialize, Serialize};

use crate::error::{from_sdk, AppError};

/// 탭이 여는 대상: 프로필과 리전 안의 클러스터 또는 인스턴스 하나
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PgTarget {
    pub profile: String,
    pub region: String,
    pub kind: TargetKind,
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetKind {
    Cluster,
    Instance,
}

/// RDS API로 읽은 대상 정보(화면과 맞춘 `PgTargetInfo` 계약)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgTargetInfo {
    pub arn: String,
    pub identifier: String,
    pub kind: TargetKind,
    pub engine: String,
    pub engine_version: String,
    pub endpoint: String,
    pub port: u16,
    pub default_database: String,
    pub iam_auth: bool,
    pub read_replica: bool,
}

/// 열 수 있는 엔진: Aurora PostgreSQL, RDS for PostgreSQL(Multi-AZ DB 클러스터 포함)
const POSTGRES_ENGINES: [&str; 2] = ["aurora-postgresql", "postgres"];
/// RDS가 `DBName`을 안 돌려줄 때 연결할 데이터베이스
const DEFAULT_DATABASE: &str = "postgres";
const DEFAULT_PORT: u16 = 5432;

fn not_postgres() -> AppError {
    AppError::other("PostgreSQL 엔진만 열 수 있어요")
}

fn endpoint_missing() -> AppError {
    AppError::other("엔드포인트가 아직 없어요")
}

/// 엔진이 PostgreSQL이어야 한다. 엔드포인트보다 먼저 본다: MySQL이 만드는 중이어도 "엔드포인트가 없다"가 아니라 "PostgreSQL이 아니다"가 맞다.
fn postgres_engine(engine: Option<&str>) -> Result<&str, AppError> {
    engine.filter(|e| POSTGRES_ENGINES.contains(e)).ok_or_else(not_postgres)
}

fn port_of(port: Option<i32>) -> u16 {
    port.and_then(|p| u16::try_from(p).ok()).unwrap_or(DEFAULT_PORT)
}

fn database_of(name: Option<&str>) -> String {
    name.filter(|n| !n.is_empty()).unwrap_or(DEFAULT_DATABASE).to_string()
}

fn has(value: Option<&str>) -> bool {
    value.is_some_and(|v| !v.is_empty())
}

/// Aurora 클러스터(또는 Multi-AZ DB 클러스터)의 쓰기 엔드포인트로 가는 대상 정보
pub fn info_of_cluster(cluster: &DbCluster) -> Result<PgTargetInfo, AppError> {
    let engine = postgres_engine(cluster.engine())?;
    let endpoint = cluster.endpoint().filter(|e| !e.is_empty()).ok_or_else(endpoint_missing)?;
    Ok(PgTargetInfo {
        arn: cluster.db_cluster_arn().unwrap_or_default().to_string(),
        identifier: cluster.db_cluster_identifier().unwrap_or_default().to_string(),
        kind: TargetKind::Cluster,
        engine: engine.to_string(),
        engine_version: cluster.engine_version().unwrap_or_default().to_string(),
        endpoint: endpoint.to_string(),
        port: port_of(cluster.port()),
        default_database: database_of(cluster.database_name()),
        iam_auth: cluster.iam_database_authentication_enabled().unwrap_or(false),
        read_replica: has(cluster.replication_source_identifier()),
    })
}

/// 인스턴스 엔드포인트로 가는 대상 정보
pub fn info_of_instance(instance: &DbInstance) -> Result<PgTargetInfo, AppError> {
    let engine = postgres_engine(instance.engine())?;
    let endpoint = instance.endpoint();
    let address = endpoint.and_then(|e| e.address()).filter(|a| !a.is_empty()).ok_or_else(endpoint_missing)?;
    Ok(PgTargetInfo {
        arn: instance.db_instance_arn().unwrap_or_default().to_string(),
        identifier: instance.db_instance_identifier().unwrap_or_default().to_string(),
        kind: TargetKind::Instance,
        engine: engine.to_string(),
        engine_version: instance.engine_version().unwrap_or_default().to_string(),
        endpoint: address.to_string(),
        port: port_of(endpoint.and_then(|e| e.port())),
        default_database: database_of(instance.db_name()),
        iam_auth: instance.iam_database_authentication_enabled().unwrap_or(false),
        read_replica: has(instance.read_replica_source_db_instance_identifier()),
    })
}

/// RDS API로 대상을 찾아 접속 정보를 읽는다. 읽기 호출만 한다(`DescribeDBClusters`, `DescribeDBInstances`).
pub async fn resolve(cfg: &SdkConfig, target: &PgTarget) -> Result<PgTargetInfo, AppError> {
    let client = aws_sdk_rds::Client::new(cfg);
    match target.kind {
        TargetKind::Cluster => {
            let out = client
                .describe_db_clusters()
                .db_cluster_identifier(&target.id)
                .send()
                .await
                .map_err(|e| from_sdk(e, "rds:DescribeDBClusters"))?;
            info_of_cluster(out.db_clusters().first().ok_or_else(|| not_found(target))?)
        }
        TargetKind::Instance => {
            let out = client
                .describe_db_instances()
                .db_instance_identifier(&target.id)
                .send()
                .await
                .map_err(|e| from_sdk(e, "rds:DescribeDBInstances"))?;
            info_of_instance(out.db_instances().first().ok_or_else(|| not_found(target))?)
        }
    }
}

fn not_found(target: &PgTarget) -> AppError {
    AppError::other(format!("RDS에서 대상을 찾지 못했어요: {}", target.id))
}

#[cfg(test)]
mod tests;
