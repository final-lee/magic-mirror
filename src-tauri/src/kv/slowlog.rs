//! Slow log: 노드별로 `SLOWLOG GET 128`(Valkey 8.1 이상은 `COMMANDLOG GET 128 slow`를 먼저 쓰고, 안 되면 SLOWLOG).

use fred::types::Value;
use futures::future::join_all;

use super::command::cmd;
use super::connect::Connected;
use super::model::{KvMode, KvSlowEntry};
use super::overview::gather;
use super::value::{int, items, text};
use crate::error::AppError;

const ENTRIES: i64 = 128;
/// 명령 인자 하나를 화면에 보이는 최대 글자 수
const ARG_CHARS: usize = 200;

/// COMMANDLOG는 Valkey 8.1에서 생겼다
pub fn commandlog_supported(engine: &str, version: &str) -> bool {
    let mut parts = version.split('.').map(|p| p.parse::<u32>().ok());
    let (Some(Some(major)), minor) = (parts.next(), parts.next().flatten().unwrap_or(0)) else { return false };
    engine == "valkey" && (major, minor) >= (8, 1)
}

fn clip(arg: String) -> String {
    match arg.char_indices().nth(ARG_CHARS) {
        Some((end, _)) => format!("{}…", &arg[..end]),
        None => arg,
    }
}

/// `[id, 시각, 걸린 마이크로초, [인자…], 클라이언트 주소, 클라이언트 이름]`의 목록
pub fn parse(node: &str, reply: &Value) -> Vec<KvSlowEntry> {
    items(reply)
        .iter()
        .filter_map(|entry| {
            let parts = items(entry);
            Some(KvSlowEntry {
                node: node.to_string(),
                id: int(parts.first()?)?,
                time: int(parts.get(1)?)?,
                micros: int(parts.get(2)?)?,
                args: items(parts.get(3)?).iter().filter_map(text).map(clip).collect(),
                client: parts.get(4).and_then(text).unwrap_or_default(),
                name: parts.get(5).and_then(text).unwrap_or_default(),
            })
        })
        .collect()
}

async fn node_entries(conn: &Connected, address: &str, commandlog: bool) -> Result<Vec<KvSlowEntry>, AppError> {
    if commandlog {
        if let Ok(reply) = conn.on_node(address, cmd("COMMANDLOG GET").arg(ENTRIES).arg("slow")).await {
            return Ok(parse(address, &reply));
        }
    }
    Ok(parse(address, &conn.on_node(address, cmd("SLOWLOG GET").arg(ENTRIES)).await?))
}

/// 모든 노드의 Slow log를 합쳐 최근 순으로
pub async fn slowlog(conn: &Connected) -> Result<Vec<KvSlowEntry>, AppError> {
    if conn.mode() == KvMode::Serverless {
        return Err(AppError::other("서버리스 캐시는 Slow log를 볼 수 없어요"));
    }
    let info = &conn.plan().resolved.info;
    let commandlog = commandlog_supported(&info.engine, &info.engine_version);
    let reads = join_all(conn.nodes().iter().map(|n| node_entries(conn, &n.address, commandlog))).await;
    let mut all: Vec<KvSlowEntry> = gather(reads)?.into_iter().flatten().collect();
    all.sort_by_key(|e| std::cmp::Reverse((e.time, e.micros)));
    Ok(all)
}

#[cfg(test)]
mod tests;
