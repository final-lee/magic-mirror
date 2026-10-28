//! 연결 보관: (대상, DB 사용자, 데이터베이스)마다 연결 하나. 같은 열쇠로 다시 달라고 하면 새 토큰과 새 TLS 연결 없이 있던 것을 돌려준다.
//! 10분 동안 안 쓴 연결은 `sweep`이 닫는다(주기적으로 부르는 일은 이 모듈을 가진 쪽이 한다).

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

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
    /// 서버 쪽 백엔드 pid. 연결이 쓰이는 중이어도(잠겨 있어도) 읽을 수 있게 따로 둔다
    pid: i32,
}

/// 연결하는 사이에 대상이 닫혔을 때 새 연결을 보관하지 않고 돌려주는 오류.
/// 명령이 아직 열리지 않은 대상에 내는 문구와 같다: 닫은 대상은 다시 연결해야 한다
const CLOSED_WHILE_CONNECTING: &str = "먼저 연결해 주세요";

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

/// 쓸 수 있는 연결이 있으면 마지막 사용 시각을 고쳐 돌려준다. 닫힌 연결은 풀에서 뺀다.
fn reuse_in(entries: &mut HashMap<ConnKey, Entry>, key: &ConnKey, now: Instant) -> Option<Arc<Mutex<Connected>>> {
    let entry = entries.get_mut(key)?;
    if is_closed(&entry.conn) {
        entries.remove(key);
        return None;
    }
    entry.last_used = now;
    Some(entry.conn.clone())
}

/// 클라이언트가 닫혔는지. 누가 쓰는 중이라 잠겨 있으면 열려 있다고 본다: 쓰다가 닫혔다면 그 사용자가 오류를 받고, 다음 호출이 새로 연결한다.
fn is_closed(conn: &Mutex<Connected>) -> bool {
    conn.try_lock().is_ok_and(|connected| connected.client.is_closed())
}

impl Pool {
    /// 열쇠의 연결을 돌려준다. 없거나 닫혔으면 `connect`로 새로 연결해 보관한다. 연결에 실패하면 아무것도 보관하지 않는다.
    /// 연결하는 사이에 `close_target`이 불린 대상이면 새 연결은 보관하지 않고 버리며 "먼저 연결해 주세요" 오류를 돌려준다.
    pub async fn get_or_connect<F, Fut>(&self, key: ConnKey, connect: F) -> Result<Arc<Mutex<Connected>>, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Connected, AppError>>,
    {
        self.get_or_connect_at(key, Instant::now(), connect).await
    }

    /// `get_or_connect`의 시각을 주입하는 꼴: 테스트가 10분을 기다리지 않고 유휴 시간을 만든다
    async fn get_or_connect_at<F, Fut>(&self, key: ConnKey, now: Instant, connect: F) -> Result<Arc<Mutex<Connected>>, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Connected, AppError>>,
    {
        let epoch = {
            let mut state = lock(&self.state);
            if let Some(conn) = reuse_in(&mut state.entries, &key, now) {
                return Ok(conn);
            }
            state.epoch(&key.target)
        };
        // 연결하는 동안에는 잠금을 쥐지 않는다. 그 사이 대상이 닫혔으면 방금 만든 연결을 버리고,
        // 같은 열쇠로 먼저 보관한 호출이 있으면 그 연결을 쓰고 방금 만든 연결은 버린다
        let connected = connect().await?;
        let mut state = lock(&self.state);
        if state.epoch(&key.target) != epoch {
            return Err(AppError::other(CLOSED_WHILE_CONNECTING));
        }
        if let Some(conn) = reuse_in(&mut state.entries, &key, now) {
            return Ok(conn);
        }
        let pid = connected.backend_pid;
        let conn = Arc::new(Mutex::new(connected));
        state.entries.insert(key, Entry { conn: conn.clone(), last_used: now, pid });
        Ok(conn)
    }

    /// 이 대상의 연결을 모두 보관함에서 빼고, 연결하는 중인 호출이 있으면 그 연결도 보관하지 못하게 한다(탭을 닫을 때).
    /// 쓰는 중인 호출이 있으면 그 호출이 끝나는 대로 연결이 닫힌다.
    pub fn close_target(&self, target: &PgTarget) {
        let mut state = lock(&self.state);
        *state.epochs.entry(target.clone()).or_insert(0) += 1;
        state.entries.retain(|key, _| key.target != *target);
    }

    /// `now` 기준으로 `IDLE`을 넘겨 안 쓴 연결을 보관함에서 뺀다
    pub fn sweep(&self, now: Instant) {
        lock(&self.state).entries.retain(|_, entry| now.saturating_duration_since(entry.last_used) <= IDLE);
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
