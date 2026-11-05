//! 큐 지도: 큐들(상태별 수), 큐 사이의 부모→자식 연결(표본 작업의 `parentKey`), 워커(CLIENT LIST의 연결 이름). 읽기 명령만 쓴다.

use std::collections::BTreeMap;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

use super::flow::split_job_key;
use super::io::{flavor_of, hmget, is_set, lrange, zrange_ids};
use super::keys::{job_key, queue_key, worker_name};
use super::model::{KvBullFlavor, KvBullTopology, KvBullTopologyLink, KvBullTopologyQueue, KvBullTopologyWorker};
use super::{queue, stats};
use crate::error::AppError;
use crate::kv::clients::clients;
use crate::kv::connect::Connected;
use crate::kv::model::KvClient;
use crate::kv::value::concurrently;

/// 큐마다 `parentKey`를 읽는 표본 작업의 최대 수
pub const SAMPLE_PER_QUEUE: usize = 50;
/// 표본 작업을 동시에 읽는 수
const CONCURRENCY: usize = 16;

/// 워커 연결 이름 `<prefix>:<base64(큐)>[:w:<워커 이름>]`에서 큐 이름. 이 prefix가 아니거나 base64가 아니면 `None`
pub fn decode_worker_queue(prefix: &str, client_name: &str) -> Option<String> {
    let rest = client_name.strip_prefix(prefix)?.strip_prefix(':')?;
    let encoded = rest.split(':').next()?;
    let queue = String::from_utf8(STANDARD.decode(encoded).ok()?).ok()?;
    (!queue.is_empty()).then_some(queue)
}

/// `addr`(`10.0.0.5:51234`)에서 포트를 뗀 주소
pub fn host_of(addr: &str) -> String {
    let host = addr.rsplit_once(':').map_or(addr, |(host, _)| host);
    host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host).to_string()
}

/// 워커로 보이는 연결들(큐는 연결 이름에서 읽는다: 찾지 못한 큐의 워커도 나온다)
pub fn workers_of(clients: &[KvClient], prefix: &str) -> Vec<KvBullTopologyWorker> {
    clients
        .iter()
        .filter_map(|c| {
            let queue = decode_worker_queue(prefix, &c.name)?;
            let name = worker_name(&c.name, &c.flags, &c.cmd, prefix, &queue)?;
            Some(KvBullTopologyWorker { queue, name, addr: c.addr.clone(), host: host_of(&c.addr), age: c.age, idle: c.idle })
        })
        .collect()
}

/// 여러 목록에서 번갈아 하나씩 모아 `cap`개까지(같은 작업은 한 번). 한 목록이 표본을 독차지하지 않게 한다
pub fn take_balanced(sources: Vec<Vec<String>>, cap: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let longest = sources.iter().map(Vec::len).max().unwrap_or(0);
    for at in 0..longest {
        for source in &sources {
            if let Some(id) = source.get(at).filter(|id| !out.contains(id)) {
                if out.len() >= cap {
                    return out;
                }
                out.push(id.clone());
            }
        }
    }
    out
}

/// 부모 큐 이름: 지금 prefix면 큐 이름, 다른 prefix면 `prefix:큐`
pub fn parent_queue_name(current_prefix: &str, parent_job_key: &str) -> Option<String> {
    let (prefix, queue, _) = split_job_key(parent_job_key, current_prefix)?;
    Some(if prefix == current_prefix { queue } else { format!("{prefix}:{queue}") })
}

/// (부모 큐, 자식 큐) 쌍을 세어 많은 순으로
pub fn aggregate_links(pairs: &[(String, String)]) -> Vec<KvBullTopologyLink> {
    let mut counts: BTreeMap<(String, String), u64> = BTreeMap::new();
    for pair in pairs {
        *counts.entry(pair.clone()).or_default() += 1;
    }
    let mut links: Vec<KvBullTopologyLink> = counts.into_iter().map(|((from, to), jobs)| KvBullTopologyLink { from, to, jobs }).collect();
    links.sort_by(|a, b| b.jobs.cmp(&a.jobs).then_with(|| a.from.cmp(&b.from)).then_with(|| a.to.cmp(&b.to)));
    links
}

/// 큐 하나의 표본 작업 ID: 최근 완료, 대기, 처리 중, 자식 기다림에서 번갈아
async fn sample_ids(conn: &Connected, prefix: &str, name: &str, flavor: KvBullFlavor) -> Result<Vec<String>, AppError> {
    let last = SAMPLE_PER_QUEUE as i64 - 1;
    let completed_key = queue_key(prefix, name, "completed");
    // BullMQ와 옛 Bull 3의 `completed`는 정렬 셋이다. 오래된 Bull의 셋은 순서가 없어 표본에서 뺀다
    let completed = if flavor == KvBullFlavor::Bullmq || !is_set(conn, &completed_key).await? { zrange_ids(conn, &completed_key, 0, last, true).await? } else { Vec::new() };
    let wait = lrange(conn, &queue_key(prefix, name, "wait"), 0, last).await?;
    let active = lrange(conn, &queue_key(prefix, name, "active"), 0, last).await?;
    let waiting_children = zrange_ids(conn, &queue_key(prefix, name, "waiting-children"), 0, last, false).await?;
    Ok(take_balanced(vec![completed, wait, active, waiting_children], SAMPLE_PER_QUEUE))
}

pub async fn topology(conn: &Connected, prefix: &str) -> Result<KvBullTopology, AppError> {
    let page = queue::queues(conn, prefix, None).await?;
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut sampled = 0u64;
    for q in &page.queues {
        let (flavor, _, _) = flavor_of(conn, prefix, &q.name).await?;
        let ids = sample_ids(conn, prefix, &q.name, flavor).await?;
        let reads = concurrently(ids.iter(), CONCURRENCY, |id| async move { hmget(conn, &job_key(prefix, &q.name, id), &["parentKey", "parent"]).await }).await;
        for read in reads {
            let fields = read?;
            sampled += 1;
            let parent = stats::parent_of(fields[1].as_deref(), fields[0].as_deref());
            if let Some(parent) = parent.and_then(|p| parent_queue_name(prefix, &format!("{}:{}", p.queue_key, p.id))) {
                pairs.push((parent, q.name.clone()));
            }
        }
    }
    let workers = clients(conn).await.ok().map(|list| workers_of(&list, prefix));
    let queues = page.queues.iter().map(|q| KvBullTopologyQueue { name: q.name.clone(), flavor: q.flavor, paused: q.paused, counts: q.counts }).collect();
    Ok(KvBullTopology { queues, links: aggregate_links(&pairs), workers, sampled })
}

#[cfg(test)]
mod tests;
