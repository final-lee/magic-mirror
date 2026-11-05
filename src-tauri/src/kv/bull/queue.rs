//! 큐 찾기와 큐 하나의 읽기: 상태별 수, 일시정지, 워커, 최근 처리량, 시간 분포, 실패 이유, 지표.
//! 읽기 명령만 쓰고 `KEYS`는 쓰지 않는다. 큐 이름은 `…:meta`와 `…:id` 키를 한 번의 SCAN으로 모은다.

use std::collections::BTreeSet;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};


use futures::future::join_all;
use crate::kv::value::concurrently;

use super::cache::FinishedJob;
use super::io::{card_any, exists, flavor_of, hmget, llen, lrange, zcard, zrange_scored};
use super::keys::{discovered_queue, discovery_pattern, queue_key, state_suffix, worker_name};
use super::model::{
    KvBullCounts, KvBullFlavor, KvBullQueue, KvBullQueueView, KvBullQueuesPage, KvBullRecent, KvBullState, KvBullWorker,
};
use super::stats;
use crate::error::AppError;
use crate::kv::clients::clients;
use crate::kv::command::cmd;
use crate::kv::connect::Connected;
use crate::kv::cursor::ScanCursor;
use crate::kv::model::KvClient;
use crate::kv::scan::{Scanner, SCAN_COUNT};
use crate::kv::value::{int, text};

/// 한 번의 찾기에서 쓰는 시간과 훑는 키 수(근사: SCAN 횟수 × COUNT)의 한도
const DISCOVERY_TIME: Duration = Duration::from_secs(20);
const DISCOVERY_KEYS: u64 = 5_000_000;
/// 큐 정보를 동시에 읽는 큐 수. 명령은 fred가 같은 연결에서 파이프라인하므로 왕복을 겹치는 만큼 빨라진다
const QUEUE_CONCURRENCY: usize = 16;
/// 분 구간 ZCOUNT를 동시에 보내는 수(한 시간 60칸을 한 번에)
const BUCKET_CONCURRENCY: usize = stats::RECENT_MINUTES;
/// 최근 끝난 작업을 읽는 수(시간 분포, 실패 이유)
const RECENT_JOBS: i64 = 100;
/// 지표(`metrics:*:data`)에서 읽는 최대 칸 수(하루)
const DAILY_POINTS: i64 = 1440;

/// 지금 시각(ms)
pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// 찾기 커서: `b2.<SCAN 커서>`
fn encode_cursor(scan: &ScanCursor) -> String {
    format!("b2.{}", scan.encode())
}

fn decode_cursor(text: &str) -> Result<ScanCursor, AppError> {
    let scan = text.strip_prefix("b2.").ok_or_else(|| AppError::other("이어 찾을 자리가 올바르지 않아요. 처음부터 다시 찾아 주세요"))?;
    ScanCursor::decode(scan)
}

/// 큐 이름을 모은다. 한도에 걸리면 `truncated`와 이어 찾을 커서를 준다.
async fn discover(conn: &Connected, prefix: &str, cursor: Option<&str>) -> Result<(BTreeSet<String>, u64, bool, Option<String>), AppError> {
    let pattern = discovery_pattern(prefix);
    let mut scanner = match cursor {
        Some(text) => Scanner::resume(conn, &pattern, None, SCAN_COUNT, decode_cursor(text)?)?,
        None => Scanner::start(conn, &pattern, None, SCAN_COUNT),
    };
    let started = Instant::now();
    let mut names = BTreeSet::new();
    let mut calls: u64 = 0;
    while let Some(batch) = scanner.step().await? {
        calls += 1;
        names.extend(batch.iter().filter_map(|key| discovered_queue(prefix, &String::from_utf8_lossy(key))));
        if calls * SCAN_COUNT as u64 >= DISCOVERY_KEYS || started.elapsed() >= DISCOVERY_TIME {
            let next = scanner.cursor().map(|scan| encode_cursor(&scan));
            return Ok((names, calls * SCAN_COUNT as u64, next.is_some(), next));
        }
    }
    Ok((names, calls * SCAN_COUNT as u64, false, None))
}

/// 워커 후보: 이 큐의 워커로 보이는 연결들
fn workers_of(clients: &[KvClient], prefix: &str, queue: &str) -> Vec<KvBullWorker> {
    clients
        .iter()
        .filter_map(|c| worker_name(&c.name, &c.flags, &c.cmd, prefix, queue).map(|name| KvBullWorker { name, addr: c.addr.clone(), age: c.age, idle: c.idle }))
        .collect()
}

/// 상태 하나의 작업 수
async fn count_state(conn: &Connected, prefix: &str, queue: &str, state: KvBullState, flavor: KvBullFlavor) -> Result<u64, AppError> {
    let key = queue_key(prefix, queue, state_suffix(state, flavor));
    match state {
        KvBullState::Wait | KvBullState::Active | KvBullState::Paused => llen(conn, &key).await,
        KvBullState::Completed | KvBullState::Failed if flavor == KvBullFlavor::Bull => card_any(conn, &key).await,
        _ => zcard(conn, &key).await,
    }
}

/// `completed`·`failed`(BullMQ는 점수가 끝난 시각인 정렬 셋)의 최근 60분 분당 수. 가장 최근 것이 구간보다 오래됐으면 ZCOUNT를 보내지 않는다.
/// 이미 지난 분은 캐시에서 읽고, 아직 열린 최근 칸만 센다.
async fn recent_counts(conn: &Connected, key: &str, start: i64, now: i64) -> Result<Vec<u64>, AppError> {
    let zeros = vec![0; stats::RECENT_MINUTES];
    if text(&conn.data(cmd("TYPE").arg(key)).await?).as_deref() != Some("zset") {
        return Ok(zeros);
    }
    let newest = zrange_scored(conn, key, 0, 0, true).await?;
    if newest.first().is_none_or(|(_, score)| (*score as i64) < start) {
        return Ok(zeros);
    }
    let cache = conn.bull_cache();
    let mut counts = zeros;
    let mut missing = Vec::new();
    for (i, count) in counts.iter_mut().enumerate() {
        match cache.bucket(key, stats::bucket_range(start, i).0) {
            Some(cached) => *count = cached,
            None => missing.push(i),
        }
    }
    let read = concurrently(missing.iter().copied(), BUCKET_CONCURRENCY, |i| async move {
        let (from, to) = stats::bucket_range(start, i);
        let reply = conn.data(cmd("ZCOUNT").arg(key).arg(from).arg(format!("({to}"))).await?;
        Ok::<_, AppError>((i, from, int(&reply).and_then(|n| u64::try_from(n).ok()).unwrap_or(0)))
    })
    .await;
    for row in read {
        let (i, from, count) = row?;
        cache.put_bucket(key, from, count, now);
        counts[i] = count;
    }
    Ok(counts)
}

/// 큐 하나의 요약. `clients`는 CLIENT LIST(못 읽으면 `None`).
/// 종류(BullMQ·옛 Bull)에 기대지 않는 읽기는 종류를 묻는 것과 함께 보내 왕복 단계를 줄인다.
pub async fn queue_info(conn: &Connected, prefix: &str, name: &str, now: i64, clients: Option<&[KvClient]>) -> Result<KvBullQueue, AppError> {
    let start = stats::bucket_start(now);
    let ((flavor, version, paused), completed, failed, repeatables, metrics) = futures::future::try_join5(
        flavor_of(conn, prefix, name),
        recent_counts(conn, &queue_key(prefix, name, "completed"), start, now),
        recent_counts(conn, &queue_key(prefix, name, "failed"), start, now),
        zcard(conn, &queue_key(prefix, name, "repeat")),
        exists(conn, &queue_key(prefix, name, "metrics:completed")),
    )
    .await?;
    let counts_read = join_all(KvBullState::ALL.iter().map(|&state| async move { Ok::<_, AppError>((state, count_state(conn, prefix, name, state, flavor).await?)) })).await;
    let mut counts = KvBullCounts::default();
    for read in counts_read {
        let (state, count) = read?;
        counts.set(state, count);
    }
    Ok(KvBullQueue {
        prefix: prefix.to_string(),
        name: name.to_string(),
        flavor,
        version,
        paused,
        counts,
        workers: clients.map(|c| workers_of(c, prefix, name).len() as u64),
        repeatables,
        metrics,
        recent: KvBullRecent { completed, failed },
    })
}

/// CLIENT LIST. 서버리스나 권한이 없으면 `None`(워커 수는 "알 수 없음")
async fn client_list(conn: &Connected) -> Option<Vec<KvClient>> {
    clients(conn).await.ok()
}

/// 큐들의 요약(이름 순서대로)
async fn infos(conn: &Connected, prefix: &str, names: impl IntoIterator<Item = &String>, clients: Option<&[KvClient]>) -> Result<Vec<KvBullQueue>, AppError> {
    let now = now_ms();
    let reads = concurrently(names, QUEUE_CONCURRENCY, |name| queue_info(conn, prefix, name, now, clients)).await;
    reads.into_iter().collect()
}

/// 큐 목록의 한 쪽: 큐를 찾고(한도 안에서) 큐마다 요약을 읽는다
pub async fn queues(conn: &Connected, prefix: &str, cursor: Option<&str>) -> Result<KvBullQueuesPage, AppError> {
    let (found, clients) = futures::future::join(discover(conn, prefix, cursor), client_list(conn)).await;
    let (names, scanned, truncated, next) = found?;
    let queues = infos(conn, prefix, &names, clients.as_deref()).await?;
    Ok(KvBullQueuesPage { queues, scanned, truncated, cursor: next })
}

/// 이미 찾은 큐들의 요약만 다시 읽는다. 키 공간을 훑지 않아 키가 많은 서버에서도 자동으로 다시 읽을 수 있다
pub async fn summaries(conn: &Connected, prefix: &str, names: &[String]) -> Result<Vec<KvBullQueue>, AppError> {
    let clients = client_list(conn).await;
    infos(conn, prefix, names, clients.as_deref()).await
}

fn ms_of(value: &Option<String>) -> Option<i64> {
    value.as_deref().and_then(|v| v.trim().parse().ok())
}

/// 가장 오래 기다린 작업의 시각: `wait`(없으면 `paused`)의 꼬리 작업의 `timestamp`. BullMQ는 앞에 넣고 꼬리에서 꺼낸다
async fn oldest_waiting(conn: &Connected, prefix: &str, queue: &str) -> Result<Option<i64>, AppError> {
    for suffix in ["wait", "paused"] {
        let tail = lrange(conn, &queue_key(prefix, queue, suffix), -1, -1).await?;
        if let Some(id) = tail.first() {
            return Ok(ms_of(&hmget(conn, &queue_key(prefix, queue, id), &["timestamp"]).await?[0]));
        }
    }
    Ok(None)
}

async fn next_delayed(conn: &Connected, prefix: &str, queue: &str, flavor: KvBullFlavor) -> Result<Option<i64>, AppError> {
    let first = zrange_scored(conn, &queue_key(prefix, queue, "delayed"), 0, 0, false).await?;
    Ok(first.first().map(|(_, score)| stats::delayed_at(*score, flavor)))
}

/// 끝난 작업들(`(ID, 끝난 시각 점수)`)의 시각과 실패 이유. 이미 읽은 끝남은 캐시에서 꺼낸다
async fn finished_jobs(conn: &Connected, prefix: &str, queue: &str, entries: &[(String, f64)]) -> Result<Vec<FinishedJob>, AppError> {
    let cache = conn.bull_cache();
    let rows = concurrently(entries.iter(), QUEUE_CONCURRENCY * 4, |(id, score)| async move {
        let key = queue_key(prefix, queue, id);
        if let Some(job) = cache.job(&key, *score) {
            return Ok::<_, AppError>(job);
        }
        let mut fields = hmget(conn, &key, &["timestamp", "processedOn", "finishedOn", "failedReason"]).await?.into_iter();
        let job = FinishedJob { timestamp: fields.next().flatten(), processed_on: fields.next().flatten(), finished_on: fields.next().flatten(), failed_reason: fields.next().flatten() };
        cache.put_job(&key, *score, job.clone());
        Ok(job)
    })
    .await;
    rows.into_iter().collect()
}

/// 최근 끝난 작업 100개의 (대기 시간, 처리 시간)들. BullMQ의 `completed`는 정렬 셋이라 최신순으로 읽는다
async fn timing_samples(conn: &Connected, prefix: &str, queue: &str) -> Result<(Vec<u64>, Vec<u64>), AppError> {
    let key = queue_key(prefix, queue, "completed");
    if text(&conn.data(cmd("TYPE").arg(key.as_str())).await?).as_deref() != Some("zset") {
        return Ok((Vec::new(), Vec::new()));
    }
    let recent = zrange_scored(conn, &key, 0, RECENT_JOBS - 1, true).await?;
    let (mut waits, mut processes) = (Vec::new(), Vec::new());
    for job in finished_jobs(conn, prefix, queue, &recent).await? {
        let (created, started, finished) = (ms_of(&job.timestamp), ms_of(&job.processed_on), ms_of(&job.finished_on));
        waits.extend(stats::span(created, started));
        processes.extend(stats::span(started, finished));
    }
    Ok((waits, processes))
}

/// 최근 실패 100개의 (이유, 시각)
async fn failures(conn: &Connected, prefix: &str, queue: &str) -> Result<Vec<(String, Option<i64>)>, AppError> {
    let key = queue_key(prefix, queue, "failed");
    if text(&conn.data(cmd("TYPE").arg(key.as_str())).await?).as_deref() != Some("zset") {
        return Ok(Vec::new());
    }
    let recent = zrange_scored(conn, &key, 0, RECENT_JOBS - 1, true).await?;
    let jobs = finished_jobs(conn, prefix, queue, &recent).await?;
    Ok(jobs.into_iter().zip(&recent).filter_map(|(job, (_, score))| job.failed_reason.map(|r| (r, Some(*score as i64)))).collect())
}

/// 지표 목록 하나(`metrics:<종류>:data`, 최근이 앞)
async fn metric_data(conn: &Connected, prefix: &str, queue: &str, kind: &str) -> Result<Vec<u64>, AppError> {
    let data = lrange(conn, &queue_key(prefix, queue, &format!("metrics:{kind}:data")), 0, DAILY_POINTS - 1).await?;
    Ok(data.iter().map(|v| v.trim().parse().unwrap_or(0)).collect())
}

/// 지표가 켜져 있으면 최근 24시간의 분당 수
async fn daily(conn: &Connected, prefix: &str, queue: &str) -> Result<Option<super::model::KvBullDaily>, AppError> {
    let prev = hmget(conn, &queue_key(prefix, queue, "metrics:completed"), &["prevTS"]).await?.remove(0);
    let Some(prev_ts) = ms_of(&prev) else { return Ok(None) };
    let (completed, failed) = futures::future::try_join(metric_data(conn, prefix, queue, "completed"), metric_data(conn, prefix, queue, "failed")).await?;
    Ok(Some(stats::daily(prev_ts, &completed, &failed)))
}

/// 큐 하나의 상세
pub async fn queue_view(conn: &Connected, prefix: &str, name: &str) -> Result<KvBullQueueView, AppError> {
    let now = now_ms();
    let clients = client_list(conn).await;
    let queue = queue_info(conn, prefix, name, now, clients.as_deref()).await?;
    let known = exists(conn, &queue_key(prefix, name, "meta")).await? || exists(conn, &queue_key(prefix, name, "id")).await?;
    if !known && queue.counts == KvBullCounts::default() && !queue.metrics && queue.repeatables == 0 {
        return Err(AppError::other(format!("큐를 찾지 못했어요: {name}")));
    }
    let flavor = queue.flavor;
    let (oldest, delayed, (waits, processes), failed, daily) = futures::future::try_join5(
        oldest_waiting(conn, prefix, name),
        next_delayed(conn, prefix, name, flavor),
        timing_samples(conn, prefix, name),
        failures(conn, prefix, name),
        daily(conn, prefix, name),
    )
    .await?;
    Ok(KvBullQueueView {
        bucket_start: stats::bucket_start(now),
        daily,
        wait_ms: stats::percentiles(&waits),
        process_ms: stats::percentiles(&processes),
        samples: waits.len().max(processes.len()) as u64,
        wait_histogram: stats::histogram(&waits),
        process_histogram: stats::histogram(&processes),
        oldest_waiting_at: oldest,
        next_delayed_at: delayed,
        failed_reasons: stats::group_reasons(&failed),
        workers: clients.as_deref().map(|c| workers_of(c, prefix, name)),
        queue,
    })
}


#[cfg(test)]
mod tests;
