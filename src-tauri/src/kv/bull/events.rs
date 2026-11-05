//! 상태 전이: 큐의 `<prefix>:<queue>:events` 스트림(`XADD … event <이름> jobId <id> [prev <이전 상태>]`)을 지난 몇 분 동안 읽어
//! (이전 상태, 이벤트) 쌍의 수를 센다. `active`는 `prev waiting`, `completed`·`failed`는 `prev active`를 달고 오고,
//! `added`·`stalled`·`retries-exhausted` 같은 이벤트는 `prev`가 없다. 읽기 명령(XRANGE)만 쓴다.

use std::collections::BTreeMap;

use fred::types::Value;

use super::keys::queue_key;
use super::model::{KvBullTransitionPair, KvBullTransitions};
use super::queue::now_ms;
use crate::error::AppError;
use crate::kv::command::cmd;
use crate::kv::connect::Connected;
use crate::kv::key::next_stream_id;
use crate::kv::value::{items, pairs, text};

/// XRANGE 한 쪽의 크기
pub const PAGE: usize = 1_000;
/// 읽는 최대 항목 수
pub const MAX_EVENTS: u64 = 20_000;

/// 스트림 항목 하나: (밀리초, 이벤트 이름, 이전 상태). `event` 필드가 없으면 `None`
pub fn parse_entry(entry: &Value) -> Option<(i64, Option<String>, Option<String>)> {
    let parts = items(entry);
    let id = text(parts.first()?)?;
    let at: i64 = id.split('-').next()?.parse().ok()?;
    let fields: BTreeMap<String, String> = pairs(parts.get(1)?).into_iter().filter_map(|(k, v)| Some((k, text(v)?))).collect();
    Some((at, fields.get("event").cloned(), fields.get("prev").cloned().filter(|p| !p.is_empty())))
}

/// 읽은 항목들(이전 상태, 이벤트)로 쌍을 센다: 많은 순, 같으면 이벤트·이전 상태 이름 순
pub fn summarize(from: i64, to: i64, first_at: Option<i64>, events: u64, truncated: bool, seen: &[(Option<String>, String)]) -> KvBullTransitions {
    let mut counts: BTreeMap<(Option<String>, String), u64> = BTreeMap::new();
    for (prev, event) in seen {
        *counts.entry((prev.clone(), event.clone())).or_default() += 1;
    }
    let mut pairs: Vec<KvBullTransitionPair> = counts.into_iter().map(|((prev, event), count)| KvBullTransitionPair { prev, event, count }).collect();
    pairs.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.event.cmp(&b.event)).then_with(|| a.prev.cmp(&b.prev)));
    KvBullTransitions { from, to, first_at, events, truncated, pairs }
}

/// 지난 `minutes`분의 전이. 스트림이 없으면 빈 결과다(이벤트를 안 남기는 큐). `firstAt`이 `from`보다 늦으면 스트림이 잘렸거나 창이 모자란 것이다.
pub async fn transitions(conn: &Connected, prefix: &str, queue: &str, minutes: u64) -> Result<KvBullTransitions, AppError> {
    let to = now_ms();
    let from = to - minutes.clamp(1, 1_440) as i64 * 60_000;
    let key = queue_key(prefix, queue, "events");
    let mut start = format!("{from}-0");
    let (mut events, mut first_at, mut truncated) = (0u64, None, false);
    let mut seen: Vec<(Option<String>, String)> = Vec::new();
    loop {
        let reply = conn.data(cmd("XRANGE").arg(key.as_str()).arg(start.as_str()).arg("+").arg("COUNT").arg(PAGE)).await?;
        let entries = items(&reply);
        let mut last_id = None;
        for entry in entries {
            events += 1;
            last_id = items(entry).first().and_then(text);
            if let Some((at, event, prev)) = parse_entry(entry) {
                first_at.get_or_insert(at);
                seen.extend(event.map(|e| (prev, e)));
            }
        }
        let full = entries.len() >= PAGE;
        if events >= MAX_EVENTS {
            truncated = full;
            break;
        }
        match last_id.as_deref().and_then(next_stream_id) {
            Some(next) if full => start = next,
            _ => break,
        }
    }
    Ok(summarize(from, to, first_at, events, truncated, &seen))
}

#[cfg(test)]
mod tests;
