//! Bull 화면의 계산(순수 함수): 백분위, 분포, 분 단위 구간, 지연 작업의 점수 읽기, 실패 이유 묶기, 흐름의 부모.

use super::model::{KvBullBucket, KvBullDaily, KvBullFailedReason, KvBullFlavor, KvBullParent, KvBullPercentiles};

const MINUTE_MS: i64 = 60_000;
/// 최근 구간의 칸 수(분)
pub const RECENT_MINUTES: usize = 60;

/// 분포의 칸 경계(ms). 마지막 칸은 그보다 오래 걸린 것도 모두 센다
pub const HISTOGRAM_BOUNDS_MS: [u64; 11] = [5, 10, 50, 100, 500, 1_000, 5_000, 10_000, 60_000, 600_000, 3_600_000];

/// 가까운 순위(nearest-rank) 백분위: 정렬한 `n`개에서 `ceil(p·n)`번째. 표본이 없으면 `None`
pub fn percentiles(samples: &[u64]) -> Option<KvBullPercentiles> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let rank = |p: usize| sorted[(sorted.len() * p).div_ceil(100).clamp(1, sorted.len()) - 1];
    Some(KvBullPercentiles { p50: rank(50), p95: rank(95), max: *sorted.last()? })
}

/// 분포: 각 칸은 `up_to_ms` 이하(앞 칸 경계 초과)의 수. 마지막 칸은 그보다 큰 것도 담는다
pub fn histogram(samples: &[u64]) -> Vec<KvBullBucket> {
    let mut buckets: Vec<KvBullBucket> = HISTOGRAM_BOUNDS_MS.iter().map(|&up_to_ms| KvBullBucket { up_to_ms, count: 0 }).collect();
    let last = buckets.len() - 1;
    for &sample in samples {
        let at = HISTOGRAM_BOUNDS_MS.iter().position(|&bound| sample <= bound).unwrap_or(last);
        buckets[at].count += 1;
    }
    buckets
}

/// 대기·처리 시간: 두 시각이 모두 있고 순서가 맞을 때만 잰다
pub fn span(from: Option<i64>, to: Option<i64>) -> Option<u64> {
    u64::try_from(to? - from?).ok()
}

/// 최근 60분의 첫 칸 시각(ms): 지금이 속한 분의 59분 전
pub fn bucket_start(now_ms: i64) -> i64 {
    now_ms - now_ms.rem_euclid(MINUTE_MS) - (RECENT_MINUTES as i64 - 1) * MINUTE_MS
}

/// 칸 하나의 범위 `[시작, 끝)`
pub fn bucket_range(start: i64, index: usize) -> (i64, i64) {
    let from = start + index as i64 * MINUTE_MS;
    (from, from + MINUTE_MS)
}

/// 지연 작업의 예정 시각(ms). BullMQ는 점수가 `시각 * 0x1000 + 순번`이고, 옛 Bull은 점수가 시각이다.
pub fn delayed_at(score: f64, flavor: KvBullFlavor) -> i64 {
    match flavor {
        KvBullFlavor::Bullmq => (score as i64) >> 12,
        KvBullFlavor::Bull => score as i64,
    }
}

/// 지표 목록(`metrics:completed:data`, 최근이 앞)을 시각이 흐르는 쪽으로 놓는다.
/// `prev_ts`는 마지막으로 닫힌 분 다음 경계(ms)라서 첫 원소는 `prev_ts - 1분`의 수다(BullMQ `collectMetrics`).
pub fn daily(prev_ts: i64, completed_newest_first: &[u64], failed_newest_first: &[u64]) -> KvBullDaily {
    let len = completed_newest_first.len().max(failed_newest_first.len());
    let pad = |data: &[u64]| -> Vec<u64> {
        let mut oldest_first: Vec<u64> = data.iter().rev().copied().collect();
        // 짧은 쪽은 앞(오래된 쪽)을 0으로 채워 두 줄의 시각을 맞춘다
        let missing = len - oldest_first.len();
        let mut padded = vec![0; missing];
        padded.append(&mut oldest_first);
        padded
    };
    KvBullDaily { start: prev_ts - len as i64 * MINUTE_MS, completed: pad(completed_newest_first), failed: pad(failed_newest_first) }
}

/// 실패 이유 묶기: 같은 이유(앞뒤 공백 없이)를 합쳐 많은 순으로. 같으면 최근에 난 것이 먼저다.
/// 이유가 길면 앞 200자만 보인다.
pub fn group_reasons(failures: &[(String, Option<i64>)]) -> Vec<KvBullFailedReason> {
    let mut groups: Vec<KvBullFailedReason> = Vec::new();
    for (raw, at) in failures {
        let reason = clip(raw.trim(), 200);
        if reason.is_empty() {
            continue;
        }
        match groups.iter_mut().find(|g| g.reason == reason) {
            Some(group) => {
                group.count += 1;
                group.last_at = group.last_at.max(*at);
            }
            None => groups.push(KvBullFailedReason { reason, count: 1, last_at: *at }),
        }
    }
    groups.sort_by(|a, b| b.count.cmp(&a.count).then(b.last_at.cmp(&a.last_at)));
    groups
}

fn clip(text: &str, chars: usize) -> String {
    match text.char_indices().nth(chars) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_string(),
    }
}

/// 스택(`stacktrace` 필드)은 시도마다 한 줄인 JSON 배열이다. 배열이 아니면 글 하나로 본다
pub fn stacktrace(raw: &str) -> Vec<String> {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Array(items)) => items.into_iter().map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).collect(),
        _ => vec![raw.to_string()],
    }
}

/// 흐름의 부모. `parent` 필드는 `{"id":"…","queueKey":"bull:q"}`(BullMQ), 없으면 `parentKey`(`bull:q:id`)에서 읽는다
pub fn parent_of(parent: Option<&str>, parent_key: Option<&str>) -> Option<KvBullParent> {
    if let Some(parsed) = parent.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok()) {
        let id = parsed.get("id").and_then(|v| v.as_str().map(str::to_string).or_else(|| v.as_i64().map(|n| n.to_string())));
        let queue_key = parsed.get("queueKey").and_then(|v| v.as_str());
        if let (Some(id), Some(queue_key)) = (id, queue_key) {
            return Some(KvBullParent { queue_key: queue_key.to_string(), id });
        }
    }
    let key = parent_key.filter(|k| !k.is_empty())?;
    let (queue_key, id) = key.rsplit_once(':')?;
    Some(KvBullParent { queue_key: queue_key.to_string(), id: id.to_string() })
}

#[cfg(test)]
mod tests;
