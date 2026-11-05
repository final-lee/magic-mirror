//! 대상 확인: 탭이 여는 복제 그룹·서버리스 캐시·단일 노드 클러스터를 ElastiCache API로 읽어 접속에 필요한 값만 뽑는다. 캐시에는 연결하지 않는다.
//! 읽기 호출만 한다(`DescribeReplicationGroups`, `DescribeCacheClusters`, `DescribeServerlessCaches`, `DescribeUserGroups`, `DescribeUsers`).
//! 사용자 그룹과 사용자는 로그인 화면을 돕는 덤이라서, 못 읽어도(권한 없음 …) 그 부분만 비우고 나머지는 그대로 돌려준다.

use aws_config::SdkConfig;
use aws_sdk_elasticache::types::{AuthenticationType, CacheCluster, ClusterMode, Endpoint, NodeGroup, ReplicationGroup, ServerlessCache, User};
use aws_smithy_runtime_api::client::result::SdkError;
use aws_smithy_types::error::metadata::ProvideErrorMetadata;
use futures::future::join_all;

use super::model::{KvKind, KvNode, KvRole, KvTarget, KvTargetInfo, KvUser};
use crate::error::{from_sdk, AppError};

const DEFAULT_PORT: u16 = 6379;

/// API로 읽은 대상: 화면에 내놓는 정보와, 접속에 쓰는 노드 목록(클러스터 모드 꺼짐·단일 노드만. 나머지는 비어 있다)
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub info: KvTargetInfo,
    pub members: Vec<KvNode>,
}

const NOT_KV: &str = "Valkey·Redis OSS 캐시만 열 수 있어요";

fn endpoint_missing() -> AppError {
    AppError::other("엔드포인트가 아직 없어요")
}

/// 열 수 있는 엔진 이름(`valkey`·`redis`). Memcached는 키 목록을 볼 방법이 없어 거절한다.
pub fn engine_of(engine: Option<&str>) -> Result<&'static str, AppError> {
    match engine.map(str::to_ascii_lowercase).as_deref() {
        Some("valkey") => Ok("valkey"),
        Some("redis") => Ok("redis"),
        _ => Err(AppError::other(NOT_KV)),
    }
}

/// `7.2.6` → (7, 2). 숫자가 아닌 앞부분이면 `None`
fn major_minor(version: &str) -> Option<(u32, u32)> {
    let mut parts = version.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|m| m.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

/// IAM 인증을 쓸 수 있는가: Valkey 7.2 이상, Redis OSS 7.0 이상, 그리고 TLS가 켜져 있어야 한다
pub fn iam_supported(engine: &str, version: &str, tls: bool) -> bool {
    let Some(found) = major_minor(version) else { return false };
    let minimum = if engine == "valkey" { (7, 2) } else { (7, 0) };
    tls && found >= minimum
}

fn port_of(endpoint: Option<&Endpoint>) -> u16 {
    endpoint.and_then(|e| e.port()).and_then(|p| u16::try_from(p).ok()).unwrap_or(DEFAULT_PORT)
}

fn address_of(endpoint: Option<&Endpoint>) -> Option<String> {
    endpoint.and_then(|e| e.address()).filter(|a| !a.is_empty()).map(str::to_string)
}

fn auth_of(user: &User) -> &'static str {
    match user.authentication().and_then(|a| a.r#type()) {
        Some(AuthenticationType::Iam) => "iam",
        Some(AuthenticationType::Password) => "password",
        _ => "no-password",
    }
}

pub fn kv_user(user: &User) -> KvUser {
    KvUser {
        id: user.user_id().unwrap_or_default().to_string(),
        name: user.user_name().unwrap_or_default().to_string(),
        auth: auth_of(user).to_string(),
        status: user.status().unwrap_or_default().to_string(),
        access: user.access_string().unwrap_or_default().to_string(),
    }
}

/// 사용자 그룹들의 사용자. 하나라도 못 읽으면 `None`(로그인 화면은 사용자 이름을 직접 받는다)
async fn read_users(client: &aws_sdk_elasticache::Client, group_ids: &[String]) -> Option<Vec<KvUser>> {
    if group_ids.is_empty() {
        return None;
    }
    let mut ids: Vec<String> = Vec::new();
    for group in group_ids {
        let out = client.describe_user_groups().user_group_id(group).send().await.ok()?;
        for g in out.user_groups() {
            for id in g.user_ids() {
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
        }
    }
    let reads = join_all(ids.iter().map(|id| async move { client.describe_users().user_id(id).send().await })).await;
    let mut users = Vec::new();
    for read in reads {
        users.extend(read.ok()?.users().iter().map(kv_user));
    }
    users.sort_by(|a, b| a.name.cmp(&b.name));
    Some(users)
}

fn node_role(role: Option<&str>) -> KvRole {
    if role == Some("primary") {
        KvRole::Primary
    } else {
        KvRole::Replica
    }
}

/// 클러스터 모드 꺼짐 복제 그룹의 노드들: 멤버마다 읽기 엔드포인트가 그 노드의 주소다
fn members_of(group: &NodeGroup, shard: &str) -> Vec<KvNode> {
    group
        .node_group_members()
        .iter()
        .filter_map(|m| {
            let endpoint = m.read_endpoint();
            let host = address_of(endpoint)?;
            Some(KvNode {
                id: m.cache_cluster_id().unwrap_or_default().to_string(),
                address: format!("{host}:{}", port_of(endpoint)),
                role: node_role(m.current_role()),
                shard: Some(shard.to_string()),
                slots: None,
            })
        })
        .collect()
}

fn cluster_mode_enabled(group: &ReplicationGroup) -> bool {
    group.cluster_enabled() == Some(true) || group.cluster_mode() == Some(&ClusterMode::Enabled)
}

/// 복제 그룹의 대상 정보. `member`는 첫 멤버 클러스터(엔진 버전을 거기서 읽는다)
pub fn info_of_group(group: &ReplicationGroup, member: Option<&CacheCluster>, users: Option<Vec<KvUser>>) -> Result<Resolved, AppError> {
    let engine = engine_of(member.and_then(|m| m.engine()).or(group.engine()))?;
    let cluster_mode = cluster_mode_enabled(group);
    let first = group.node_groups().first();
    let primary = first.and_then(|n| n.primary_endpoint());
    let (endpoint, port) = if cluster_mode {
        let configuration = group.configuration_endpoint();
        (address_of(configuration), port_of(configuration))
    } else {
        (address_of(primary), port_of(primary))
    };
    let endpoint = endpoint.ok_or_else(endpoint_missing)?;
    let tls = group.transit_encryption_enabled() == Some(true);
    let engine_version = member.and_then(|m| m.engine_version()).unwrap_or_default().to_string();
    let members = if cluster_mode { Vec::new() } else { first.map(|n| members_of(n, "0001")).unwrap_or_default() };
    Ok(Resolved {
        info: KvTargetInfo {
            arn: group.arn().unwrap_or_default().to_string(),
            identifier: group.replication_group_id().unwrap_or_default().to_string(),
            kind: KvKind::ReplicationGroup,
            engine: engine.to_string(),
            iam_supported: iam_supported(engine, &engine_version, tls),
            engine_version,
            endpoint,
            port,
            reader_endpoint: if cluster_mode { None } else { address_of(first.and_then(|n| n.reader_endpoint())) },
            tls,
            cluster_mode,
            serverless: false,
            auth_token_enabled: group.auth_token_enabled() == Some(true),
            user_group_ids: group.user_group_ids().to_vec(),
            users,
        },
        members,
    })
}

/// 서버리스 캐시의 대상 정보. TLS는 늘 켜져 있고 클러스터 모드로 붙는다
pub fn info_of_serverless(cache: &ServerlessCache, users: Option<Vec<KvUser>>) -> Result<Resolved, AppError> {
    let engine = engine_of(cache.engine())?;
    let endpoint = address_of(cache.endpoint()).ok_or_else(endpoint_missing)?;
    let engine_version = cache.full_engine_version().or(cache.major_engine_version()).unwrap_or_default().to_string();
    Ok(Resolved {
        info: KvTargetInfo {
            arn: cache.arn().unwrap_or_default().to_string(),
            identifier: cache.serverless_cache_name().unwrap_or_default().to_string(),
            kind: KvKind::ServerlessCache,
            engine: engine.to_string(),
            iam_supported: iam_supported(engine, &engine_version, true),
            engine_version,
            endpoint,
            port: port_of(cache.endpoint()),
            reader_endpoint: address_of(cache.reader_endpoint()),
            tls: true,
            cluster_mode: true,
            serverless: true,
            auth_token_enabled: false,
            user_group_ids: cache.user_group_id().filter(|g| !g.is_empty()).map(str::to_string).into_iter().collect(),
            users,
        },
        members: Vec::new(),
    })
}

/// 그룹이 없는 단일 노드 클러스터(Redis OSS)의 대상 정보. 복제 그룹에 속한 노드는 그 그룹을 열어야 하므로 거절한다.
pub fn info_of_cache_cluster(cluster: &CacheCluster) -> Result<Resolved, AppError> {
    let engine = engine_of(cluster.engine())?;
    if let Some(group) = cluster.replication_group_id().filter(|g| !g.is_empty()) {
        return Err(AppError::other(format!("이 노드는 복제 그룹 {group}에 속해요. 그 그룹을 열어 주세요")));
    }
    let endpoint = cluster.cache_nodes().first().and_then(|n| n.endpoint());
    let host = address_of(endpoint).ok_or_else(endpoint_missing)?;
    let port = port_of(endpoint);
    let id = cluster.cache_cluster_id().unwrap_or_default().to_string();
    let engine_version = cluster.engine_version().unwrap_or_default().to_string();
    let tls = cluster.transit_encryption_enabled() == Some(true);
    Ok(Resolved {
        members: vec![KvNode { id: id.clone(), address: format!("{host}:{port}"), role: KvRole::Primary, shard: None, slots: None }],
        info: KvTargetInfo {
            arn: cluster.arn().unwrap_or_default().to_string(),
            identifier: id,
            kind: KvKind::CacheCluster,
            engine: engine.to_string(),
            iam_supported: iam_supported(engine, &engine_version, tls),
            engine_version,
            endpoint: host,
            port,
            reader_endpoint: None,
            tls,
            cluster_mode: false,
            serverless: false,
            auth_token_enabled: cluster.auth_token_enabled() == Some(true),
            user_group_ids: Vec::new(),
            users: None,
        },
    })
}

fn not_found(target: &KvTarget) -> AppError {
    AppError::other(format!("ElastiCache에서 대상을 찾지 못했어요: {}", target.id))
}

/// 조회 오류를 앱 오류로 바꾼다. 없는 대상을 가리키는 코드만 "찾지 못했어요"로 읽고, 나머지는 작업 이름이 붙은 일반 분류를 그대로 탄다.
fn lookup_error<E, R>(err: SdkError<E, R>, not_found_code: &str, action: &str, target: &KvTarget) -> AppError
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
    R: std::fmt::Debug + Send + Sync + 'static,
{
    if err.code() == Some(not_found_code) {
        return not_found(target);
    }
    from_sdk(err, action)
}

/// ElastiCache API로 대상을 찾아 접속 정보를 읽는다
pub async fn resolve(cfg: &SdkConfig, target: &KvTarget) -> Result<Resolved, AppError> {
    let client = aws_sdk_elasticache::Client::new(cfg);
    match target.kind {
        KvKind::ReplicationGroup => {
            let out = client
                .describe_replication_groups()
                .replication_group_id(&target.id)
                .send()
                .await
                .map_err(|e| lookup_error(e, "ReplicationGroupNotFoundFault", "elasticache:DescribeReplicationGroups", target))?;
            let group = out.replication_groups().first().ok_or_else(|| not_found(target))?;
            // 엔진 버전은 첫 멤버 클러스터에 있다
            let member = match group.member_clusters().first() {
                Some(id) => {
                    let out = client
                        .describe_cache_clusters()
                        .cache_cluster_id(id)
                        .show_cache_node_info(true)
                        .send()
                        .await
                        .map_err(|e| from_sdk(e, "elasticache:DescribeCacheClusters"))?;
                    out.cache_clusters().first().cloned()
                }
                None => None,
            };
            let users = read_users(&client, group.user_group_ids()).await;
            info_of_group(group, member.as_ref(), users)
        }
        KvKind::ServerlessCache => {
            let out = client
                .describe_serverless_caches()
                .serverless_cache_name(&target.id)
                .send()
                .await
                .map_err(|e| lookup_error(e, "ServerlessCacheNotFoundFault", "elasticache:DescribeServerlessCaches", target))?;
            let cache = out.serverless_caches().first().ok_or_else(|| not_found(target))?;
            let groups: Vec<String> = cache.user_group_id().filter(|g| !g.is_empty()).map(str::to_string).into_iter().collect();
            let users = read_users(&client, &groups).await;
            info_of_serverless(cache, users)
        }
        KvKind::CacheCluster => {
            let out = client
                .describe_cache_clusters()
                .cache_cluster_id(&target.id)
                .show_cache_node_info(true)
                .send()
                .await
                .map_err(|e| lookup_error(e, "CacheClusterNotFound", "elasticache:DescribeCacheClusters", target))?;
            info_of_cache_cluster(out.cache_clusters().first().ok_or_else(|| not_found(target))?)
        }
    }
}

#[cfg(test)]
mod tests;
