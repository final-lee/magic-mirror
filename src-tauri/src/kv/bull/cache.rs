//! 연결 하나 동안 쓰는 Bull 읽기 캐시. 다시 읽어도 같은 값만 둔다.
//! - 지나간 분의 처리량: `completed`·`failed`(점수가 끝난 시각)에서 이미 지난 1분 칸의 수. 5초마다 다시 읽을 때 아직 열린 최근 칸만 센다.
//!   그 뒤에 BullMQ가 오래된 작업을 지워도(`removeOnComplete`) 칸에는 그때 끝난 수가 남는다.
//! - 끝난 작업의 시각과 실패 이유: (작업 키, 끝난 시각 점수)가 같으면 같은 끝남이다. 다시 시도해 다시 끝나면 점수가 달라 새로 읽는다.
//!
//! 연결(`Connected`)에 붙어 있어 대상·DB·로그인이 바뀌거나 다시 연결하면 함께 버려진다.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use super::stats::RECENT_MINUTES;

/// 칸이 닫혔다고 보는 여유. 작업이 끝난 시각은 워커의 시계로 적히므로 지금보다 이만큼 지난 칸만 담는다
pub const SETTLE_MS: i64 = 2 * 60_000;
/// 끝난 작업을 담는 최대 수. 넘으면 비우고 다시 채운다(큐 상세 하나는 최근 100개씩 두 번 읽는다)
const MAX_JOBS: usize = 20_000;
const MINUTE_MS: i64 = 60_000;

/// 끝난 작업에서 큐 상세가 쓰는 필드
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinishedJob {
    pub timestamp: Option<String>,
    pub processed_on: Option<String>,
    pub finished_on: Option<String>,
    pub failed_reason: Option<String>,
}

#[derive(Default)]
pub struct BullCache {
    /// (키, 칸 시작 ms) → 그 칸에 끝난 작업 수
    buckets: Mutex<HashMap<(String, i64), u64>>,
    /// (작업 키, 끝난 시각 점수의 비트) → 필드
    jobs: Mutex<HashMap<(String, u64), FinishedJob>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl BullCache {
    /// 담아 둔 칸의 수
    pub fn bucket(&self, key: &str, from: i64) -> Option<u64> {
        lock(&self.buckets).get(&(key.to_string(), from)).copied()
    }

    /// 칸 `[from, from + 1분)`의 수를 담는다. 아직 닫히지 않은 칸(끝이 `now - SETTLE_MS`보다 늦다)은 담지 않는다.
    /// 최근 60분보다 오래된 칸은 이때 버린다.
    pub fn put_bucket(&self, key: &str, from: i64, count: u64, now: i64) {
        if from + MINUTE_MS > now - SETTLE_MS {
            return;
        }
        let oldest = now - (RECENT_MINUTES as i64 + 1) * MINUTE_MS;
        let mut buckets = lock(&self.buckets);
        buckets.retain(|(_, start), _| *start >= oldest);
        buckets.insert((key.to_string(), from), count);
    }

    pub fn job(&self, key: &str, score: f64) -> Option<FinishedJob> {
        lock(&self.jobs).get(&(key.to_string(), score.to_bits())).cloned()
    }

    pub fn put_job(&self, key: &str, score: f64, job: FinishedJob) {
        let mut jobs = lock(&self.jobs);
        if jobs.len() >= MAX_JOBS {
            jobs.clear();
        }
        jobs.insert((key.to_string(), score.to_bits()), job);
    }
}

#[cfg(test)]
mod tests;
