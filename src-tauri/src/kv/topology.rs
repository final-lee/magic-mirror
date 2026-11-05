//! 클러스터 모드 캐시의 노드 목록(순수 함수). `CLUSTER SHARDS`(Redis 7·Valkey)를 읽고, 서버가 모르면 `CLUSTER SLOTS`로 같은 목록을 만든다.
//! 노드 주소는 서버가 알려 주는 선호 엔드포인트(`endpoint`)다: fred가 `CLUSTER SLOTS`로 아는 주소와 같아서, 그 주소로 노드를 가리켜 명령을 보낼 수 있다.

use fred::types::Value;

use super::model::{KvNode, KvRole};
use super::value::{field, int, items, text};

/// 샤드 이름: 슬롯이 작은 순서로 `0001`, `0002`…(ElastiCache의 노드 그룹 이름과 같은 꼴)
fn shard_label(index: usize) -> String {
    format!("{:04}", index + 1)
}

/// 슬롯 범위 목록을 `0-5460,10923-16383`으로. 한 칸짜리는 숫자 하나
fn slot_ranges(ranges: &[(i64, i64)]) -> Option<String> {
    if ranges.is_empty() {
        return None;
    }
    Some(ranges.iter().map(|(a, b)| if a == b { a.to_string() } else { format!("{a}-{b}") }).collect::<Vec<_>>().join(","))
}

/// 선호 주소: `endpoint`(비었거나 `?`면 `hostname`, 그것도 없으면 `ip`)
fn preferred_host(node: &Value) -> Option<String> {
    ["endpoint", "hostname", "ip"].iter().filter_map(|name| field(node, name).and_then(text)).find(|h| !h.is_empty() && h != "?")
}

fn node_port(node: &Value, tls: bool) -> Option<i64> {
    let plain = field(node, "port").and_then(int).filter(|p| *p > 0);
    let secure = field(node, "tls-port").and_then(int).filter(|p| *p > 0);
    if tls {
        secure.or(plain)
    } else {
        plain.or(secure)
    }
}

/// `CLUSTER SHARDS`의 답. 샤드마다 슬롯 범위와 노드들이 있다. 읽을 수 없는 노드(주소 없음)는 건너뛴다.
pub fn nodes_from_shards(reply: &Value, tls: bool) -> Vec<KvNode> {
    let mut shards: Vec<(i64, Vec<KvNode>)> = Vec::new();
    for shard in items(reply) {
        let ranges: Vec<(i64, i64)> = field(shard, "slots").map(|s| items(s).chunks_exact(2).filter_map(|p| Some((int(&p[0])?, int(&p[1])?))).collect()).unwrap_or_default();
        let slots = slot_ranges(&ranges);
        let first_slot = ranges.iter().map(|r| r.0).min().unwrap_or(i64::MAX);
        let mut nodes = Vec::new();
        for node in field(shard, "nodes").map(items).unwrap_or_default() {
            let (Some(host), Some(port)) = (preferred_host(node), node_port(node, tls)) else { continue };
            let role = if field(node, "role").and_then(text).as_deref() == Some("master") { KvRole::Primary } else { KvRole::Replica };
            let primary = role == KvRole::Primary;
            nodes.push(KvNode {
                id: field(node, "id").and_then(text).unwrap_or_default(),
                address: format!("{host}:{port}"),
                role,
                shard: None,
                slots: if primary { slots.clone() } else { None },
            });
        }
        shards.push((first_slot, nodes));
    }
    label(shards)
}

/// `CLUSTER SLOTS`의 답: `[시작, 끝, [호스트, 포트, id…], [복제본…]…]`의 목록. 호스트가 비어 있으면(서버가 모른다) 접속한 곳의 `seed_host`다.
/// 같은 기본 노드의 범위들은 한 샤드로 모은다.
pub fn nodes_from_slots(reply: &Value, seed_host: &str) -> Vec<KvNode> {
    let mut shards: Vec<(i64, Vec<KvNode>)> = Vec::new();
    let mut ranges: Vec<Vec<(i64, i64)>> = Vec::new();
    for entry in items(reply) {
        let parts = items(entry);
        let (Some(start), Some(end)) = (parts.first().and_then(int), parts.get(1).and_then(int)) else { continue };
        let nodes: Vec<KvNode> = parts
            .iter()
            .skip(2)
            .enumerate()
            .filter_map(|(i, node)| {
                let info = items(node);
                let host = info.first().and_then(text).filter(|h| !h.is_empty()).unwrap_or_else(|| seed_host.to_string());
                let port = info.get(1).and_then(int)?;
                Some(KvNode {
                    id: info.get(2).and_then(text).unwrap_or_default(),
                    address: format!("{host}:{port}"),
                    role: if i == 0 { KvRole::Primary } else { KvRole::Replica },
                    shard: None,
                    slots: None,
                })
            })
            .collect();
        let Some(primary) = nodes.first() else { continue };
        match shards.iter().position(|(_, existing)| existing.first().is_some_and(|p| p.address == primary.address)) {
            Some(at) => {
                shards[at].0 = shards[at].0.min(start);
                ranges[at].push((start, end));
                // 복제본이 샤드 안에 없던 것이면 더한다
                for node in nodes.into_iter().skip(1) {
                    if !shards[at].1.iter().any(|n| n.address == node.address) {
                        shards[at].1.push(node);
                    }
                }
            }
            None => {
                shards.push((start, nodes));
                ranges.push(vec![(start, end)]);
            }
        }
    }
    for ((_, nodes), ranges) in shards.iter_mut().zip(ranges) {
        if let Some(primary) = nodes.first_mut() {
            primary.slots = slot_ranges(&ranges);
        }
    }
    label(shards)
}

/// 샤드를 첫 슬롯 순서로 놓고 이름을 붙인다. 샤드 안에서는 기본 노드가 먼저, 복제본은 주소 순이다.
fn label(mut shards: Vec<(i64, Vec<KvNode>)>) -> Vec<KvNode> {
    shards.sort_by_key(|(first, _)| *first);
    let mut out = Vec::new();
    for (index, (_, mut nodes)) in shards.into_iter().enumerate() {
        nodes.sort_by(|a, b| (a.role != KvRole::Primary, &a.address).cmp(&(b.role != KvRole::Primary, &b.address)));
        for mut node in nodes {
            node.shard = Some(shard_label(index));
            out.push(node);
        }
    }
    out
}

/// 노드 주소(`호스트:포트`)를 나눈다. IPv6 `[::1]:6379` 꼴은 대괄호를 벗긴다
pub fn split_address(address: &str) -> Option<(String, u16)> {
    let (host, port) = address.rsplit_once(':')?;
    let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    Some((host.to_string(), port.parse().ok()?))
}

#[cfg(test)]
mod tests;
