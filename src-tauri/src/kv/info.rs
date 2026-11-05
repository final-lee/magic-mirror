//! `INFO` 답을 읽는다(순수 함수). 모르는 칸이나 빠진 섹션은 0·없음으로 둔다: 서버리스는 섹션이 줄어 있고 서버마다 칸이 조금씩 다르다.

use std::collections::HashMap;

use super::model::{KvKeyspace, KvNodeInfo};

/// `이름:값` 줄들. `# 섹션` 제목과 빈 줄은 건너뛴다
pub fn parse(text: &str) -> HashMap<&str, &str> {
    text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).filter_map(|l| l.split_once(':')).collect()
}

fn num<T: std::str::FromStr + Default>(fields: &HashMap<&str, &str>, name: &str) -> T {
    fields.get(name).and_then(|v| v.parse().ok()).unwrap_or_default()
}

/// `db0:keys=3,expires=1,avg_ttl=0` 줄들. 번호 순서로
pub fn keyspace(fields: &HashMap<&str, &str>) -> Vec<KvKeyspace> {
    let mut found: Vec<KvKeyspace> = fields
        .iter()
        .filter_map(|(name, value)| {
            let db = name.strip_prefix("db")?.parse().ok()?;
            let stats: HashMap<&str, &str> = value.split(',').filter_map(|kv| kv.split_once('=')).collect();
            Some(KvKeyspace { db, keys: num(&stats, "keys"), expires: num(&stats, "expires") })
        })
        .collect();
    found.sort_by_key(|k| k.db);
    found
}

/// 서버의 역할 이름을 화면의 이름으로: `master` → `primary`, `slave` → `replica`
fn role_of(raw: &str) -> String {
    match raw {
        "master" => "primary".to_string(),
        "slave" => "replica".to_string(),
        other => other.to_string(),
    }
}

/// 노드 하나의 INFO 요약. `node`는 `KvNode.address`다
pub fn node_info(node: &str, text: &str) -> KvNodeInfo {
    let fields = parse(text);
    let version = fields.get("valkey_version").or_else(|| fields.get("redis_version")).copied().unwrap_or_default().to_string();
    let max_memory: u64 = num(&fields, "maxmemory");
    // 복제본이 기본 노드와 마지막으로 주고받은 뒤 지난 초. 링크가 끊겼으면(-1) 알 수 없다
    let lag = fields.get("master_last_io_seconds_ago").and_then(|v| v.parse::<i64>().ok()).filter(|s| *s >= 0);
    KvNodeInfo {
        node: node.to_string(),
        version,
        role: role_of(fields.get("role").copied().unwrap_or_default()),
        used_memory: num(&fields, "used_memory"),
        used_memory_peak: num(&fields, "used_memory_peak"),
        max_memory: (max_memory > 0).then_some(max_memory),
        fragmentation: fields.get("mem_fragmentation_ratio").and_then(|v| v.parse().ok()),
        hits: num(&fields, "keyspace_hits"),
        misses: num(&fields, "keyspace_misses"),
        ops_per_sec: num(&fields, "instantaneous_ops_per_sec"),
        connected_clients: num(&fields, "connected_clients"),
        evicted_keys: num(&fields, "evicted_keys"),
        expired_keys: num(&fields, "expired_keys"),
        uptime_seconds: num(&fields, "uptime_in_seconds"),
        replication_lag_seconds: lag,
        keyspace: keyspace(&fields),
    }
}

/// `INFO server`의 `run_id`(서버를 알아보는 값). 읽기 엔드포인트가 어느 복제본에 붙었는지 가린다
pub fn run_id(text: &str) -> Option<String> {
    parse(text).get("run_id").map(|s| s.to_string())
}

#[cfg(test)]
mod tests;
