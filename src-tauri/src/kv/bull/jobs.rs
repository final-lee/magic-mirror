//! 작업 읽기: 상태별 작업 표와 작업 하나의 상세(데이터, 옵션, 반환값, 스택, 로그, 부모·자식). 읽기 명령만 쓴다.
//! 작업 해시의 필드는 BullMQ의 `Job.fromJSON`이 읽는 것과 같다(`attemptsMade`는 BullMQ 5에서 `atm`이기도 하다).

use crate::kv::value::concurrently;

use super::io::{flavor_of, hmget, hscan_limited, llen, lrange, scard, sscan_limited, zcard, zrange_ids, zrange_scored};
use super::keys::{job_key, queue_key, state_suffix};
use super::model::{KvBullChild, KvBullFlavor, KvBullJob, KvBullJobRow, KvBullJobsPage, KvBullState};
use super::stats;
use crate::error::AppError;
use crate::kv::command::cmd;
use crate::kv::connect::Connected;
use crate::kv::key::MAX_VALUE_BYTES;
use crate::kv::value::int;

/// 작업 표 한 쪽에서 해시를 동시에 읽는 수
const ROW_CONCURRENCY: usize = 32;
/// 로그의 최근 줄 수
const LOG_LINES: i64 = 100;
/// 자식 목록에서 읽는 최대 수
const CHILDREN: usize = 200;
/// 옛 Bull의 셋(`completed`·`failed`)에서 순서 없이 읽는 최대 수
const SET_SCAN_LIMIT: usize = 10_000;

/// 표에 쓰는 필드: 이름, 시각들, 시도, 진행률, 실패 이유, 지연, 우선순위
const ROW_FIELDS: [&str; 10] = ["name", "timestamp", "processedOn", "finishedOn", "attemptsMade", "atm", "progress", "failedReason", "delay", "priority"];

fn number(value: &Option<String>) -> Option<i64> {
    value.as_deref().and_then(|v| v.trim().parse().ok())
}

fn nonempty(value: &Option<String>) -> Option<String> {
    value.clone().filter(|v| !v.is_empty())
}

/// 해시 필드들(`ROW_FIELDS` 순서)에서 표의 줄 하나를 만든다. `delay_until`은 지연 작업이 놓인 점수에서 읽은 예정 시각이다
pub fn row_of(id: &str, state: KvBullState, fields: &[Option<String>], delay_until: Option<i64>) -> KvBullJobRow {
    let get = |at: usize| fields.get(at).cloned().flatten();
    let attempts = number(&get(4)).or(number(&get(5))).and_then(|n| u64::try_from(n).ok()).unwrap_or(0);
    KvBullJobRow {
        id: id.to_string(),
        name: get(0).unwrap_or_default(),
        state,
        timestamp: number(&get(1)),
        processed_on: number(&get(2)),
        finished_on: number(&get(3)),
        attempts_made: attempts,
        progress: nonempty(&get(6)),
        failed_reason: nonempty(&get(7)),
        delay_until,
        priority: number(&get(9)).filter(|p| *p != 0),
    }
}

/// 상태 하나의 (작업 ID, 지연 예정 시각)들과 전체 수. 완료·실패는 최신순, 나머지는 줄(점수) 순서다.
async fn page_ids(conn: &Connected, key: &str, state: KvBullState, flavor: KvBullFlavor, start: i64, count: i64) -> Result<(Vec<(String, Option<i64>)>, u64), AppError> {
    let stop = start + count - 1;
    match state {
        KvBullState::Wait | KvBullState::Active | KvBullState::Paused => {
            let ids = lrange(conn, key, start, stop).await?;
            Ok((ids.into_iter().map(|id| (id, None)).collect(), llen(conn, key).await?))
        }
        KvBullState::Delayed => {
            let rows = zrange_scored(conn, key, start, stop, false).await?;
            Ok((rows.into_iter().map(|(id, score)| (id, Some(stats::delayed_at(score, flavor)))).collect(), zcard(conn, key).await?))
        }
        KvBullState::Completed | KvBullState::Failed if flavor == KvBullFlavor::Bull => {
            // 옛 Bull의 `completed`·`failed`는 순서 없는 셋이다: 앞에서부터 읽어 쪽을 자른다
            let all = sscan_limited(conn, key, SET_SCAN_LIMIT).await?;
            let total = scard(conn, key).await?;
            let page = all.into_iter().skip(start as usize).take(count as usize).map(|id| (id, None)).collect();
            Ok((page, total))
        }
        _ => {
            let reverse = matches!(state, KvBullState::Completed | KvBullState::Failed);
            let ids = zrange_ids(conn, key, start, stop, reverse).await?;
            Ok((ids.into_iter().map(|id| (id, None)).collect(), zcard(conn, key).await?))
        }
    }
}

/// 작업 표 한 쪽: 상태 하나의 작업들(`start`부터 `count`개)과 그 상태의 전체 수
pub async fn jobs_page(conn: &Connected, prefix: &str, queue: &str, state: KvBullState, start: u64, count: u64) -> Result<KvBullJobsPage, AppError> {
    let (flavor, _, _) = flavor_of(conn, prefix, queue).await?;
    let key = queue_key(prefix, queue, state_suffix(state, flavor));
    let count = count.clamp(1, 200) as i64;
    let (ids, total) = page_ids(conn, &key, state, flavor, start as i64, count).await?;
    let rows = concurrently(ids.iter(), ROW_CONCURRENCY, |(id, delay_until)| async move {
        let fields = hmget(conn, &job_key(prefix, queue, id), &ROW_FIELDS).await?;
        Ok::<_, AppError>(row_of(id, state, &fields, *delay_until))
    })
    .await;
    Ok(KvBullJobsPage { jobs: rows.into_iter().collect::<Result<Vec<_>, _>>()?, total })
}

/// 작업이 어느 상태에 있는지: 정렬 셋들에서 ZSCORE로 찾고, 리스트는 `active`를 훑어 본다. 어디에도 없으면 대기(일시정지 중이면 일시정지)다.
async fn state_of(conn: &Connected, prefix: &str, queue: &str, id: &str, flavor: KvBullFlavor, paused: bool) -> Result<(KvBullState, Option<i64>), AppError> {
    for state in [KvBullState::Completed, KvBullState::Failed, KvBullState::Delayed, KvBullState::Prioritized, KvBullState::WaitingChildren] {
        let key = queue_key(prefix, queue, state_suffix(state, flavor));
        if flavor == KvBullFlavor::Bull && matches!(state, KvBullState::Completed | KvBullState::Failed) {
            if int(&conn.data(cmd("SISMEMBER").arg(key.as_str()).arg(id)).await?) == Some(1) {
                return Ok((state, None));
            }
            continue;
        }
        let score = conn.data(cmd("ZSCORE").arg(key.as_str()).arg(id)).await?;
        if let Some(score) = crate::kv::value::float(&score) {
            let delay_until = (state == KvBullState::Delayed).then(|| stats::delayed_at(score, flavor));
            return Ok((state, delay_until));
        }
    }
    let active = lrange(conn, &queue_key(prefix, queue, "active"), 0, 9_999).await?;
    if active.iter().any(|a| a == id) {
        return Ok((KvBullState::Active, None));
    }
    Ok((if paused { KvBullState::Paused } else { KvBullState::Wait }, None))
}

/// 작업 하나의 상세
pub async fn job(conn: &Connected, prefix: &str, queue: &str, id: &str) -> Result<KvBullJob, AppError> {
    let key = job_key(prefix, queue, id);
    let mut fields: Vec<&str> = ROW_FIELDS.to_vec();
    fields.extend(["data", "opts", "returnvalue", "stacktrace", "parentKey", "parent"]);
    let values = hmget(conn, &key, &fields).await?;
    if values.iter().all(Option::is_none) {
        return Err(AppError::other(format!("작업을 찾지 못했어요: {id}")));
    }
    let (flavor, _, paused) = flavor_of(conn, prefix, queue).await?;
    let (state, delay_until) = state_of(conn, prefix, queue, id, flavor, paused).await?;
    let row = row_of(id, state, &values, delay_until);
    let extra = |name: &str| fields.iter().position(|f| *f == name).and_then(|at| values.get(at).cloned().flatten());
    let (data, data_truncated) = {
        let raw = extra("data").unwrap_or_default();
        if raw.len() > MAX_VALUE_BYTES {
            let mut end = MAX_VALUE_BYTES;
            while !raw.is_char_boundary(end) {
                end -= 1;
            }
            (raw[..end].to_string(), true)
        } else {
            (raw, false)
        }
    };
    let logs = lrange(conn, &format!("{key}:logs"), -LOG_LINES, -1).await?;
    let pending = sscan_limited(conn, &format!("{key}:dependencies"), CHILDREN).await?;
    let processed = hscan_limited(conn, &format!("{key}:processed"), CHILDREN).await?;
    let children = pending
        .into_iter()
        .map(|key| KvBullChild { key, done: false, result: None })
        .chain(processed.into_iter().map(|(key, result)| KvBullChild { key, done: true, result: Some(result) }))
        .collect();
    Ok(KvBullJob {
        row,
        data,
        data_truncated,
        opts: extra("opts"),
        returnvalue: extra("returnvalue"),
        stacktrace: extra("stacktrace").map(|raw| stats::stacktrace(&raw)).unwrap_or_default(),
        logs,
        parent: stats::parent_of(extra("parent").as_deref(), extra("parentKey").as_deref()),
        children,
    })
}

#[cfg(test)]
mod tests;
