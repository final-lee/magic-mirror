//! 개요: 노드 목록, 노드별 INFO 요약, 기본 노드들의 DBSIZE 합, 데이터베이스 목록, 서버리스에서 막힌 기능.

use futures::future::join_all;

use super::command::cmd;
use super::connect::Connected;
use super::info;
use super::model::{KvFeature, KvLoginSaved, KvMode, KvNode, KvNodeInfo, KvOverview, KvRole};
use super::value::{int, text};
use crate::error::AppError;

/// 서버리스에서 볼 수 없는 기능(설계: 화면을 아예 끈다)
pub const SERVERLESS_UNSUPPORTED: [KvFeature; 4] = [KvFeature::Slowlog, KvFeature::Clients, KvFeature::Memory, KvFeature::Encoding];

/// 노드마다 한 일을 돌려 모은다. 일부 노드가 실패해도(복제본이 안 열린다 …) 나머지는 돌려주고, 모두 실패했을 때만 첫 오류를 돌려준다.
pub fn gather<T>(results: Vec<Result<T, AppError>>) -> Result<Vec<T>, AppError> {
    let mut oks = Vec::new();
    let mut first_error = None;
    for result in results {
        match result {
            Ok(value) => oks.push(value),
            Err(e) => {
                first_error.get_or_insert(e);
            }
        }
    }
    match (oks.is_empty(), first_error) {
        (true, Some(e)) => Err(e),
        _ => Ok(oks),
    }
}

/// 노드 하나의 INFO 요약
pub async fn node_info(conn: &Connected, node: &KvNode) -> Result<KvNodeInfo, AppError> {
    let reply = conn.on_node(&node.address, cmd("INFO")).await?;
    Ok(info::node_info(&node.address, &text(&reply).unwrap_or_default()))
}

/// 고른 데이터베이스의 키 수: 기본 노드마다 DBSIZE를 물어 더한다
pub async fn dbsize(conn: &Connected) -> Result<u64, AppError> {
    let primaries: Vec<&KvNode> = conn.nodes().iter().filter(|n| n.role == KvRole::Primary).collect();
    let sizes = join_all(primaries.iter().map(|node| async { Ok::<_, AppError>(int(&conn.on_node(&node.address, cmd("DBSIZE")).await?).unwrap_or(0).max(0) as u64) })).await;
    Ok(gather(sizes.into_iter().collect())?.into_iter().sum())
}

/// 데이터베이스 고르기에 내놓을 번호: 키스페이스에 있는 번호와 지금 고른 번호, 0
fn databases_of(info: &[KvNodeInfo], selected: u32) -> Vec<u32> {
    let mut dbs: Vec<u32> = info.iter().flat_map(|i| i.keyspace.iter().map(|k| k.db)).chain([0, selected]).collect();
    dbs.sort_unstable();
    dbs.dedup();
    dbs
}

pub async fn overview(conn: &Connected, login: KvLoginSaved) -> Result<KvOverview, AppError> {
    let nodes = conn.nodes().to_vec();
    let reads = join_all(nodes.iter().map(|node| node_info(conn, node))).await;
    let infos = gather(reads)?;
    let dbsize = dbsize(conn).await?;
    let resolved = &conn.plan().resolved.info;
    let mode = conn.mode();
    let version = if resolved.engine_version.is_empty() { infos.first().map(|i| i.version.clone()).unwrap_or_default() } else { resolved.engine_version.clone() };
    // 데이터베이스 고르기는 클러스터 모드 꺼짐만(클러스터 모드·서버리스는 데이터베이스 0 하나다)
    let databases = if mode == KvMode::Standalone { databases_of(&infos, login.database) } else { vec![0] };
    Ok(KvOverview {
        mode,
        engine: resolved.engine.clone(),
        version,
        database: if mode == KvMode::Standalone { login.database } else { 0 },
        databases,
        dbsize,
        nodes,
        info: infos,
        unsupported: if mode == KvMode::Serverless { SERVERLESS_UNSUPPORTED.to_vec() } else { Vec::new() },
        login,
    })
}

#[cfg(test)]
mod tests;
