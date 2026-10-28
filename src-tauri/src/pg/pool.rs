//! 연결 보관: (대상, DB 사용자, 데이터베이스)마다 연결 하나. 같은 열쇠로 다시 달라고 하면 새 토큰과 새 TLS 연결 없이 있던 것을 돌려준다.
//! 10분 동안 안 쓴 연결은 `sweep`이 닫는다(주기적으로 부르는 일은 이 모듈을 가진 쪽이 한다). 쉰 시간은 두 시계로 잰다:
//! macOS의 `Instant`는 맥이 잠자는 동안 멈추니, 밤새 자고 일어나도 몇 초 쉰 연결로 보인다. 벽시계(`SystemTime`)로도 재서 둘 중 하나가 넘기면 쉰 연결이다.
//! 닫힌 연결과, 읽다가 응답이 끊겨 `broken`으로 표시된 연결(`catalog::read`)도 돌려주지 않는다.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use tokio::sync::Mutex;

use super::connect::Connected;
use super::target::PgTarget;
use crate::error::AppError;

/// 이 시간 동안 안 쓴 연결은 닫는다
pub const IDLE: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ConnKey {
    pub target: PgTarget,
    pub user: String,
    pub database: String,
}

struct Entry {
    conn: Arc<Mutex<Connected>>,
    last_used: Instant,
    /// `last_used`와 같은 때의 벽시계. `Instant`는 맥이 자는 동안 멈추므로 쉰 시간을 이것으로도 잰다
    last_used_wall: SystemTime,
    /// 서버 쪽 백엔드 pid. 연결이 쓰이는 중이어도(잠겨 있어도) 읽을 수 있게 따로 둔다
    pid: i32,
}

impl Entry {
    /// 쓰지 않은 지 `IDLE`을 넘겼는가. 두 시계 가운데 하나라도 넘겼다고 하면 넘긴 것이다.
    /// 벽시계가 뒤로 갔으면(시각 동기화 …) 쉰 시간을 알 수 없으니 그것만으로는 넘겼다고 하지 않는다.
    fn idle_over(&self, now: Instant, wall: SystemTime) -> bool {
        now.saturating_duration_since(self.last_used) > IDLE || wall.duration_since(self.last_used_wall).is_ok_and(|idle| idle > IDLE)
    }
}

/// 아직 열리지 않았거나 닫힌 대상에 명령이 내는 문구. 연결하는 사이에 대상이 닫혀서 새 연결을 보관하지 않고 돌려주는 오류도 같은 문구다:
/// 닫은 대상은 다시 연결해야 한다
pub const NOT_OPENED: &str = "먼저 연결해 주세요";

#[derive(Default)]
struct State {
    entries: HashMap<ConnKey, Entry>,
    /// 대상마다 `close_target`이 불린 횟수. 연결을 시작할 때 읽어 두었다가 보관할 때 견주어, 그 사이 대상이 닫혔는지 안다
    epochs: HashMap<PgTarget, u64>,
}

impl State {
    fn epoch(&self, target: &PgTarget) -> u64 {
        self.epochs.get(target).copied().unwrap_or(0)
    }
}

#[derive(Default)]
pub struct Pool {
    state: StdMutex<State>,
}

fn lock<T>(mutex: &StdMutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 쓸 수 있는 연결이 있으면 마지막 사용 시각(두 시계 모두)을 고쳐 돌려준다. 오래 쉬었거나 닫힌 연결은 풀에서 뺀다.
fn reuse_in(entries: &mut HashMap<ConnKey, Entry>, key: &ConnKey, now: Instant, wall: SystemTime) -> Option<Arc<Mutex<Connected>>> {
    let entry = entries.get_mut(key)?;
    if entry.idle_over(now, wall) || is_closed(&entry.conn) {
        entries.remove(key);
        return None;
    }
    entry.last_used = now;
    entry.last_used_wall = wall;
    Some(entry.conn.clone())
}

/// 이 연결을 더 쓰면 안 되는가: 클라이언트가 닫혔거나, 읽다가 응답이 끊겨 `broken`으로 표시했다.
/// 누가 쓰는 중이라 잠겨 있으면 열려 있다고 본다: 쓰다가 닫혔다면 그 사용자가 오류를 받고(`catalog::read`의 제한 시간이 끝없이 기다리지 않게 한다),
/// 다음 호출이 새로 연결한다.
fn is_closed(conn: &Mutex<Connected>) -> bool {
    conn.try_lock().is_ok_and(|connected| connected.broken || connected.client.is_closed())
}

impl Pool {
    /// 이 대상이 `close_target`으로 닫힌 횟수. 명령이 시작할 때 읽어 두었다가 `get_or_connect_at_epoch`에 넘긴다.
    pub fn epoch(&self, target: &PgTarget) -> u64 {
        lock(&self.state).epoch(target)
    }

    /// 열쇠의 연결을 돌려준다. 없거나 닫혔으면 `connect`로 새로 연결해 보관한다. 연결에 실패하면 아무것도 보관하지 않는다.
    /// `epoch`는 명령이 시작할 때 읽어 둔 값(`epoch`)이다. 그 뒤 `close_target`이 불렸으면 연결을 시도하지도 않고,
    /// 연결하는 사이에 불렸으면 새 연결은 보관하지 않고 버린다. 어느 쪽이든 `NOT_OPENED` 오류를 돌려준다.
    /// 명령 하나가 여러 연결을 잇따라 여는 동안(점검이 데이터베이스를 차례로 읽는다) 탭이 닫히면 거기서 멈추게 하려는 것이다.
    pub async fn get_or_connect_at_epoch<F, Fut>(&self, key: ConnKey, epoch: u64, connect: F) -> Result<Arc<Mutex<Connected>>, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Connected, AppError>>,
    {
        self.connect_in(key, Instant::now(), SystemTime::now(), Some(epoch), connect).await
    }

    /// `get_or_connect_at_epoch`에서 epoch를 지금 읽는 꼴: 시작할 때의 epoch를 따로 쥐지 않는 시험이 쓴다
    #[cfg(test)]
    async fn get_or_connect<F, Fut>(&self, key: ConnKey, connect: F) -> Result<Arc<Mutex<Connected>>, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Connected, AppError>>,
    {
        self.get_or_connect_at(key, Instant::now(), connect).await
    }

    /// `get_or_connect`의 시각을 주입하는 꼴: 테스트가 10분을 기다리지 않고 유휴 시간을 만든다. 벽시계는 지금의 것이다
    #[cfg(test)]
    async fn get_or_connect_at<F, Fut>(&self, key: ConnKey, now: Instant, connect: F) -> Result<Arc<Mutex<Connected>>, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Connected, AppError>>,
    {
        self.get_or_connect_at_wall(key, now, SystemTime::now(), connect).await
    }

    /// `get_or_connect_at`에 벽시계도 주입하는 꼴: 맥이 자는 동안 `Instant`는 멈추고 벽시계는 가는 일을 테스트가 만든다
    #[cfg(test)]
    async fn get_or_connect_at_wall<F, Fut>(&self, key: ConnKey, now: Instant, wall: SystemTime, connect: F) -> Result<Arc<Mutex<Connected>>, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Connected, AppError>>,
    {
        self.connect_in(key, now, wall, None, connect).await
    }

    /// 연결 보관의 알맹이. `pinned`가 Some이면 대상의 epoch가 그 값 그대로일 때만 연결한다. `now`와 `wall`은 같은 순간의 두 시계다.
    async fn connect_in<F, Fut>(&self, key: ConnKey, now: Instant, wall: SystemTime, pinned: Option<u64>, connect: F) -> Result<Arc<Mutex<Connected>>, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Connected, AppError>>,
    {
        let epoch = {
            let mut state = lock(&self.state);
            let epoch = state.epoch(&key.target);
            if pinned.is_some_and(|pinned| pinned != epoch) {
                return Err(AppError::other(NOT_OPENED));
            }
            if let Some(conn) = reuse_in(&mut state.entries, &key, now, wall) {
                return Ok(conn);
            }
            epoch
        };
        // 연결하는 동안에는 잠금을 쥐지 않는다. 그 사이 대상이 닫혔으면 방금 만든 연결을 버리고,
        // 같은 열쇠로 먼저 보관한 호출이 있으면 그 연결을 쓰고 방금 만든 연결은 버린다
        let connected = connect().await?;
        let mut state = lock(&self.state);
        if state.epoch(&key.target) != epoch {
            return Err(AppError::other(NOT_OPENED));
        }
        if let Some(conn) = reuse_in(&mut state.entries, &key, now, wall) {
            return Ok(conn);
        }
        let pid = connected.backend_pid;
        let conn = Arc::new(Mutex::new(connected));
        state.entries.insert(key, Entry { conn: conn.clone(), last_used: now, last_used_wall: wall, pid });
        Ok(conn)
    }

    /// 이 대상의 연결을 모두 보관함에서 빼고, 연결하는 중인 호출이 있으면 그 연결도 보관하지 못하게 한다(탭을 닫을 때).
    /// 쓰는 중인 호출이 있으면 그 호출이 끝나는 대로 연결이 닫힌다.
    pub fn close_target(&self, target: &PgTarget) {
        let mut state = lock(&self.state);
        *state.epochs.entry(target.clone()).or_insert(0) += 1;
        state.entries.retain(|key, _| key.target != *target);
    }

    /// `now` 기준으로 `IDLE`을 넘겨 안 쓴 연결을 보관함에서 뺀다. 벽시계로 재는 쉰 시간은 지금 시각을 쓴다
    pub fn sweep(&self, now: Instant) {
        self.sweep_at(now, SystemTime::now());
    }

    /// `sweep`에 벽시계도 주입하는 꼴: 두 시계 가운데 하나라도 `IDLE`을 넘겼으면 뺀다
    fn sweep_at(&self, now: Instant, wall: SystemTime) {
        lock(&self.state).entries.retain(|_, entry| !entry.idle_over(now, wall));
    }

    /// 이 대상에 앱이 열어 둔 연결들의 서버 쪽 pid(작은 것부터). 세션 목록에서 "앱의 연결"을 알아보는 데 쓴다.
    pub fn backend_pids(&self, target: &PgTarget) -> Vec<i32> {
        let mut pids: Vec<i32> = lock(&self.state).entries.iter().filter(|(key, _)| key.target == *target).map(|(_, entry)| entry.pid).collect();
        pids.sort_unstable();
        pids
    }
}

#[cfg(test)]
mod tests;
