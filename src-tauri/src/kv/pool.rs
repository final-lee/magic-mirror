//! 연결 보관: 대상(탭)마다 연결 하나. 같은 대상으로 다시 달라고 하면 새 TLS 연결과 새 토큰 없이 있던 것을 돌려준다.
//! 10분 동안 안 쓴 연결은 `sweep`이 닫는다(주기적으로 부르는 일은 이 모듈을 가진 쪽이 한다). 쉰 시간은 두 시계로 잰다:
//! macOS의 `Instant`는 맥이 잠자는 동안 멈추니, 밤새 자고 일어나도 몇 초 쉰 연결로 보인다. 벽시계(`SystemTime`)로도 재서 둘 중 하나가 넘기면 쉰 연결이다.
//! 쓸 수 없게 된 연결(`usable`이 거짓)도 돌려주지 않는다. 보관함에서 빠진 연결은 백그라운드에서 닫는다:
//! fred 클라이언트는 놓아 버린다고 연결이 닫히지 않으므로 `close`를 꼭 불러야 한다.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use async_trait::async_trait;

use super::model::KvTarget;
use crate::error::AppError;

/// 이 시간 동안 안 쓴 연결은 닫는다
pub const IDLE: Duration = Duration::from_secs(600);

/// 아직 열리지 않았거나 닫힌 대상에 명령이 내는 문구
pub const NOT_OPENED: &str = "먼저 연결해 주세요";

/// 보관할 연결
#[async_trait]
pub trait Pooled: Send + Sync + 'static {
    /// 더 써도 되는가(끊기거나 응답이 끊겨 표시된 연결은 아니다)
    fn usable(&self) -> bool;
    /// 서버 연결을 닫는다
    async fn close(&self);
}

struct Entry<C> {
    conn: Arc<C>,
    last_used: Instant,
    /// `last_used`와 같은 때의 벽시계. `Instant`는 맥이 자는 동안 멈추므로 쉰 시간을 이것으로도 잰다
    last_used_wall: SystemTime,
}

impl<C> Entry<C> {
    /// 쓰지 않은 지 `IDLE`을 넘겼는가. 두 시계 가운데 하나라도 넘겼다고 하면 넘긴 것이다.
    /// 벽시계가 뒤로 갔으면(시각 동기화 …) 쉰 시간을 알 수 없으니 그것만으로는 넘겼다고 하지 않는다.
    fn idle_over(&self, now: Instant, wall: SystemTime) -> bool {
        now.saturating_duration_since(self.last_used) > IDLE || wall.duration_since(self.last_used_wall).is_ok_and(|idle| idle > IDLE)
    }
}

struct State<C> {
    entries: HashMap<KvTarget, Entry<C>>,
    /// 대상마다 `close_target`이 불린 횟수. 연결을 시작할 때 읽어 두었다가 보관할 때 견주어, 그 사이 대상이 닫혔는지 안다
    epochs: HashMap<KvTarget, u64>,
}

impl<C> Default for State<C> {
    fn default() -> Self {
        State { entries: HashMap::new(), epochs: HashMap::new() }
    }
}

impl<C> State<C> {
    fn epoch(&self, target: &KvTarget) -> u64 {
        self.epochs.get(target).copied().unwrap_or(0)
    }
}

pub struct Pool<C: Pooled> {
    state: StdMutex<State<C>>,
}

impl<C: Pooled> Default for Pool<C> {
    fn default() -> Self {
        Pool { state: StdMutex::new(State::default()) }
    }
}

fn lock<T>(mutex: &StdMutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 보관함에서 빠진 연결들을 백그라운드에서 닫는다. 쓰는 중인 호출이 있으면 그 호출은 `Arc`로 연결을 쥐고 있어 끝까지 간다.
fn retire<C: Pooled>(conns: Vec<Arc<C>>) {
    for conn in conns {
        tokio::spawn(async move { conn.close().await });
    }
}

/// 쓸 수 있는 연결이 있으면 마지막 사용 시각(두 시계 모두)을 고쳐 돌려준다. 오래 쉬었거나 쓸 수 없는 연결은 풀에서 빼 `evicted`에 담는다.
fn reuse_in<C: Pooled>(entries: &mut HashMap<KvTarget, Entry<C>>, target: &KvTarget, now: Instant, wall: SystemTime, evicted: &mut Vec<Arc<C>>) -> Option<Arc<C>> {
    let entry = entries.get_mut(target)?;
    if entry.idle_over(now, wall) || !entry.conn.usable() {
        evicted.extend(entries.remove(target).map(|e| e.conn));
        return None;
    }
    entry.last_used = now;
    entry.last_used_wall = wall;
    Some(entry.conn.clone())
}

impl<C: Pooled> Pool<C> {
    /// 이 대상이 `close_target`으로 닫힌 횟수. 명령이 시작할 때 읽어 두었다가 `get_or_connect_at_epoch`에 넘긴다.
    pub fn epoch(&self, target: &KvTarget) -> u64 {
        lock(&self.state).epoch(target)
    }

    /// 대상의 연결을 돌려준다. 없거나 쓸 수 없으면 `connect`로 새로 연결해 보관한다. 연결에 실패하면 아무것도 보관하지 않는다.
    /// `epoch`는 명령이 시작할 때 읽어 둔 값(`epoch`)이다. 그 뒤 `close_target`이 불렸으면 연결을 시도하지도 않고,
    /// 연결하는 사이에 불렸으면 새 연결은 보관하지 않고 닫는다. 어느 쪽이든 `NOT_OPENED` 오류를 돌려준다.
    pub async fn get_or_connect_at_epoch<F, Fut>(&self, target: &KvTarget, epoch: u64, connect: F) -> Result<Arc<C>, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<C, AppError>>,
    {
        self.connect_in(target, Instant::now(), SystemTime::now(), Some(epoch), connect).await
    }

    /// 연결 보관의 알맹이. `pinned`가 Some이면 대상의 epoch가 그 값 그대로일 때만 연결한다. `now`와 `wall`은 같은 순간의 두 시계다
    /// (시험이 10분을 기다리지 않고 유휴 시간을 만든다).
    async fn connect_in<F, Fut>(&self, target: &KvTarget, now: Instant, wall: SystemTime, pinned: Option<u64>, connect: F) -> Result<Arc<C>, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<C, AppError>>,
    {
        let mut evicted = Vec::new();
        let epoch = {
            let mut state = lock(&self.state);
            let epoch = state.epoch(target);
            if pinned.is_some_and(|pinned| pinned != epoch) {
                return Err(AppError::other(NOT_OPENED));
            }
            if let Some(conn) = reuse_in(&mut state.entries, target, now, wall, &mut evicted) {
                drop(state);
                retire(evicted);
                return Ok(conn);
            }
            epoch
        };
        retire(std::mem::take(&mut evicted));
        // 연결하는 동안에는 잠금을 쥐지 않는다. 그 사이 대상이 닫혔으면 방금 만든 연결을 닫고,
        // 같은 대상으로 먼저 보관한 호출이 있으면 그 연결을 쓰고 방금 만든 연결은 닫는다
        let connected = Arc::new(connect().await?);
        let mut state = lock(&self.state);
        if state.epoch(target) != epoch {
            drop(state);
            retire(vec![connected]);
            return Err(AppError::other(NOT_OPENED));
        }
        if let Some(conn) = reuse_in(&mut state.entries, target, now, wall, &mut evicted) {
            drop(state);
            evicted.push(connected);
            retire(evicted);
            return Ok(conn);
        }
        state.entries.insert(target.clone(), Entry { conn: connected.clone(), last_used: now, last_used_wall: wall });
        drop(state);
        retire(evicted);
        Ok(connected)
    }

    /// 이 대상의 연결을 보관함에서 빼 닫고, 연결하는 중인 호출이 있으면 그 연결도 보관하지 못하게 한다(탭을 닫을 때·로그인을 바꿀 때).
    pub fn close_target(&self, target: &KvTarget) {
        let removed = {
            let mut state = lock(&self.state);
            *state.epochs.entry(target.clone()).or_insert(0) += 1;
            state.entries.remove(target).map(|e| e.conn)
        };
        retire(removed.into_iter().collect());
    }

    /// 이 대상의 연결을 지금 쓸 수 있게 보관하고 있는가(시험과 진단용)
    #[cfg(test)]
    pub fn holds(&self, target: &KvTarget) -> bool {
        lock(&self.state).entries.contains_key(target)
    }

    /// `now` 기준으로 `IDLE`을 넘겨 안 쓴 연결을 보관함에서 빼 닫는다. 벽시계로 재는 쉰 시간은 지금 시각을 쓴다
    pub fn sweep(&self, now: Instant) {
        self.sweep_at(now, SystemTime::now());
    }

    /// `sweep`에 벽시계도 주입하는 꼴: 두 시계 가운데 하나라도 `IDLE`을 넘겼으면 뺀다
    fn sweep_at(&self, now: Instant, wall: SystemTime) {
        let mut gone = Vec::new();
        lock(&self.state).entries.retain(|_, entry| {
            let keep = !entry.idle_over(now, wall);
            if !keep {
                gone.push(entry.conn.clone());
            }
            keep
        });
        retire(gone);
    }
}

#[cfg(test)]
mod tests;
