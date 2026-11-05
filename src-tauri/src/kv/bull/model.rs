//! 🐂 Bull 큐 화면의 계약(명령이 돌려주는 값의 모양). 프런트엔드의 `src/kv/types.ts`와 필드마다 맞는다. JSON은 camelCase다.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KvBullFlavor {
    Bullmq,
    Bull,
}

/// 작업의 상태. 키 이름은 `key_name`이 정한다
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KvBullState {
    Wait,
    Active,
    Delayed,
    Prioritized,
    WaitingChildren,
    Paused,
    Completed,
    Failed,
}

impl KvBullState {
    pub const ALL: [KvBullState; 8] = [
        KvBullState::Wait,
        KvBullState::Active,
        KvBullState::Delayed,
        KvBullState::Prioritized,
        KvBullState::WaitingChildren,
        KvBullState::Paused,
        KvBullState::Completed,
        KvBullState::Failed,
    ];
}

/// 상태별 작업 수
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvBullCounts {
    pub wait: u64,
    pub active: u64,
    pub delayed: u64,
    pub prioritized: u64,
    pub waiting_children: u64,
    pub paused: u64,
    pub completed: u64,
    pub failed: u64,
}

impl KvBullCounts {
    pub fn set(&mut self, state: KvBullState, value: u64) {
        match state {
            KvBullState::Wait => self.wait = value,
            KvBullState::Active => self.active = value,
            KvBullState::Delayed => self.delayed = value,
            KvBullState::Prioritized => self.prioritized = value,
            KvBullState::WaitingChildren => self.waiting_children = value,
            KvBullState::Paused => self.paused = value,
            KvBullState::Completed => self.completed = value,
            KvBullState::Failed => self.failed = value,
        }
    }
}

/// 최근 60분 분당 끝난 작업 수(오래된 것이 앞)
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct KvBullRecent {
    pub completed: Vec<u64>,
    pub failed: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvBullQueue {
    pub prefix: String,
    pub name: String,
    pub flavor: KvBullFlavor,
    pub version: Option<String>,
    pub paused: bool,
    pub counts: KvBullCounts,
    /// `None`: CLIENT LIST를 쓸 수 없다(서버리스, 권한 없음)
    pub workers: Option<u64>,
    pub repeatables: u64,
    pub metrics: bool,
    pub recent: KvBullRecent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvBullQueuesPage {
    pub queues: Vec<KvBullQueue>,
    /// 훑어 본 키 수(근사)
    pub scanned: u64,
    /// 시간·키 수 한도에 걸려 일부만 찾았다
    pub truncated: bool,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct KvBullPercentiles {
    pub p50: u64,
    pub p95: u64,
    pub max: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvBullBucket {
    pub up_to_ms: u64,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KvBullDaily {
    /// 첫 칸의 시각(ms)
    pub start: i64,
    pub completed: Vec<u64>,
    pub failed: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvBullFailedReason {
    pub reason: String,
    pub count: u64,
    pub last_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KvBullWorker {
    pub name: String,
    pub addr: String,
    pub age: i64,
    pub idle: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvBullQueueView {
    pub queue: KvBullQueue,
    /// `queue.recent[0]`의 시각(ms)
    pub bucket_start: i64,
    pub daily: Option<KvBullDaily>,
    pub wait_ms: Option<KvBullPercentiles>,
    pub process_ms: Option<KvBullPercentiles>,
    /// 대기·처리 시간을 잰 작업 수(최근 끝난 100개 안)
    pub samples: u64,
    pub wait_histogram: Vec<KvBullBucket>,
    pub process_histogram: Vec<KvBullBucket>,
    pub oldest_waiting_at: Option<i64>,
    pub next_delayed_at: Option<i64>,
    pub failed_reasons: Vec<KvBullFailedReason>,
    pub workers: Option<Vec<KvBullWorker>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvBullJobRow {
    pub id: String,
    pub name: String,
    pub state: KvBullState,
    pub timestamp: Option<i64>,
    pub processed_on: Option<i64>,
    pub finished_on: Option<i64>,
    pub attempts_made: u64,
    pub progress: Option<String>,
    pub failed_reason: Option<String>,
    pub delay_until: Option<i64>,
    pub priority: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KvBullJobsPage {
    pub jobs: Vec<KvBullJobRow>,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvBullParent {
    pub queue_key: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KvBullChild {
    pub key: String,
    pub done: bool,
    pub result: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvBullJob {
    #[serde(flatten)]
    pub row: KvBullJobRow,
    pub data: String,
    pub data_truncated: bool,
    pub opts: Option<String>,
    pub returnvalue: Option<String>,
    pub stacktrace: Vec<String>,
    pub logs: Vec<String>,
    pub parent: Option<KvBullParent>,
    pub children: Vec<KvBullChild>,
}
