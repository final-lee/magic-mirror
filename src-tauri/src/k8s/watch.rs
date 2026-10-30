//! 목록 watch. 처음 목록(Init…InitDone)은 한 번에 `Reset`으로, 그 뒤 변경은 100ms 또는 500줄마다 `Changes`로 묶어 보낸다.
//! 일시적인 오류가 나면 알리고, 기다렸다가 새 watcher로 처음 목록부터 다시 받는다. 새 목록의 `Reset`이 회복 소식이다.
use std::collections::BTreeMap;
use std::time::Duration;

use futures::stream::BoxStream;
use kube::api::DynamicObject;
use kube::runtime::watcher::{self, Event};
use tokio::time::Instant;

use super::connect::REQUEST_TIMEOUT;
use super::failure::{describe, failure_of, Endpoint, Failure};
use super::read::api_for;
use super::rows::{row_of, KindRef, Row};
use crate::error::AppError;

pub const FLUSH_EVERY: Duration = Duration::from_millis(100);
pub const FLUSH_ROWS: usize = 500;
pub const PAGE_SIZE: u32 = 500;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WatchMessage {
    Reset { rows: Vec<Row> },
    Changes { upserts: Vec<Row>, deletes: Vec<String> },
    Error { error: AppError, fatal: bool },
}

#[derive(Default)]
pub struct Batcher {
    init: Option<Vec<Row>>,
    upserts: BTreeMap<String, Row>,
    deletes: Vec<String>,
}

impl Batcher {
    pub fn on(&mut self, ev: Event<Row>) -> Option<WatchMessage> {
        match ev {
            // 다시 목록을 받기 시작하면 쌓아 둔 변경은 새 목록에 이미 반영돼 있으니 버린다
            Event::Init => {
                self.init = Some(Vec::new());
                self.upserts.clear();
                self.deletes.clear();
                None
            }
            Event::InitApply(row) => {
                self.init.get_or_insert_with(Vec::new).push(row);
                None
            }
            Event::InitDone => Some(WatchMessage::Reset { rows: self.init.take().unwrap_or_default() }),
            Event::Apply(row) => {
                self.deletes.retain(|u| *u != row.uid);
                self.upserts.insert(row.uid.clone(), row);
                None
            }
            Event::Delete(row) => {
                self.upserts.remove(&row.uid);
                if !self.deletes.contains(&row.uid) {
                    self.deletes.push(row.uid);
                }
                None
            }
        }
    }

    pub fn take(&mut self) -> Option<WatchMessage> {
        if self.upserts.is_empty() && self.deletes.is_empty() {
            return None;
        }
        Some(WatchMessage::Changes { upserts: std::mem::take(&mut self.upserts).into_values().collect(), deletes: std::mem::take(&mut self.deletes) })
    }

    pub fn full(&self) -> bool {
        self.upserts.len() + self.deletes.len() >= FLUSH_ROWS
    }
}

/// 목록 단계(시작, 다시 목록)가 `REQUEST_TIMEOUT` 안에 아무 소식 없이 멈추면 한 번 알리게 하는 시계.
/// 토큰이 만료돼 exec 플러그인이 다시 도는 동안처럼 요청이 조용히 걸려 있을 때를 위한 것이다. `InitDone` 뒤의 watch는 원래 조용할 수 있어 재지 않는다.
/// watch가 오류로 끝나면 새 watcher와 함께 새 `Stall`이 처음부터 잰다.
#[derive(Default)]
pub struct Stall {
    since: Option<Instant>,
}

impl Stall {
    /// 목록 단계를 시작한다(처음, 또는 `Init`)
    pub fn start(&mut self, now: Instant) {
        self.since = Some(now);
    }

    /// 이벤트가 오면 부른다. 목록 중이면 진행이 있었으니 다시 재고, 목록이 끝나면 멈춘다.
    pub fn on_event<K>(&mut self, ev: &Event<K>, now: Instant) {
        match ev {
            Event::Init | Event::InitApply(_) => self.since = Some(now),
            Event::InitDone => self.since = None,
            Event::Apply(_) | Event::Delete(_) => {}
        }
    }

    /// 한도를 넘었으면 true, 한 번 알린 뒤에는 다시 켜질 때까지 false
    pub fn expired(&mut self, now: Instant) -> bool {
        match self.since {
            Some(t) if now.duration_since(t) >= REQUEST_TIMEOUT => {
                self.since = None;
                true
            }
            _ => false,
        }
    }
}

/// `Event<DynamicObject>`를 줄로 바꾼다(kube 4.2의 `Event`에는 `map`이 없다).
fn rows_of(kind: &KindRef, ev: Event<DynamicObject>) -> Event<Row> {
    match ev {
        Event::Init => Event::Init,
        Event::InitApply(o) => Event::InitApply(row_of(kind, &o)),
        Event::InitDone => Event::InitDone,
        Event::Apply(o) => Event::Apply(row_of(kind, &o)),
        Event::Delete(o) => Event::Delete(row_of(kind, &o)),
    }
}

/// watcher 오류의 안쪽 `kube::Error`로 실패를 가른다. 서버가 watch 본문으로 돌려준 상태(`WatchError`)도 같은 길을 탄다.
pub fn watch_failure(e: &watcher::Error, kind: &KindRef) -> Failure {
    let (inner, verb) = match e {
        watcher::Error::InitialListFailed(k) => (k, "list"),
        watcher::Error::WatchStartFailed(k) | watcher::Error::WatchFailed(k) => (k, "watch"),
        watcher::Error::WatchError(status) => return failure_of(&kube::Error::Api(status.clone()), "watch", &kind.plural),
        watcher::Error::NoResourceVersion => return Failure::Other(e.to_string()),
    };
    failure_of(inner, verb, &kind.plural)
}

fn is_fatal(f: &Failure) -> bool {
    matches!(f, Failure::Forbidden { .. } | Failure::Unauthorized)
}

pub const RETRY_FIRST: Duration = Duration::from_secs(1);
pub const RETRY_MAX: Duration = Duration::from_secs(30);

/// 일시적인 오류 뒤 새 목록을 받기 전에 기다리는 시간: 1초에서 두 배씩 30초까지. 목록을 끝까지 받으면 1초로 돌아간다.
#[derive(Debug)]
pub struct Retry {
    next: Duration,
}

impl Default for Retry {
    fn default() -> Self {
        Retry { next: RETRY_FIRST }
    }
}

impl Retry {
    pub fn next_delay(&mut self) -> Duration {
        let d = self.next;
        self.next = (self.next * 2).min(RETRY_MAX);
        d
    }

    pub fn reset(&mut self) {
        self.next = RETRY_FIRST;
    }
}

pub type Events = BoxStream<'static, Result<Event<DynamicObject>, watcher::Error>>;

enum Outcome {
    Stop,
    Retry,
}

/// 보내기가 실패하면(프론트가 채널을 버림) 끝난다. 403·401은 치명적이라 알리고 끝낸다. 다른 오류는 알리고, 기다렸다가 처음 목록부터 다시 받는다.
pub async fn run<F>(client: kube::Client, kind: KindRef, namespace: Option<String>, endpoint: Endpoint, send: F)
where
    F: FnMut(WatchMessage) -> bool + Send,
{
    use futures::StreamExt;

    let api = api_for(client, &kind, namespace.as_deref());
    let config = watcher::Config::default().page_size(PAGE_SIZE);
    run_with(move || watcher::watcher(api.clone(), config.clone()).boxed(), kind, endpoint, send).await;
}

/// `open`은 부를 때마다 새 watcher(처음 목록부터)를 만든다. 시험은 가짜 스트림을 넘긴다.
pub async fn run_with<O, F>(mut open: O, kind: KindRef, endpoint: Endpoint, mut send: F)
where
    O: FnMut() -> Events + Send,
    F: FnMut(WatchMessage) -> bool + Send,
{
    let mut retry = Retry::default();
    loop {
        match once(open(), &kind, endpoint, &mut send, &mut retry).await {
            Outcome::Stop => return,
            Outcome::Retry => tokio::time::sleep(retry.next_delay()).await,
        }
    }
}

/// watcher 하나를 오류나 끝까지 돌린다
async fn once<F>(mut stream: Events, kind: &KindRef, endpoint: Endpoint, send: &mut F, retry: &mut Retry) -> Outcome
where
    F: FnMut(WatchMessage) -> bool + Send,
{
    use futures::StreamExt;

    let mut batch = Batcher::default();
    let mut tick = tokio::time::interval(FLUSH_EVERY);
    let mut stall = Stall::default();
    stall.start(Instant::now());
    loop {
        tokio::select! {
            next = stream.next() => match next {
                None => return Outcome::Stop,
                Some(Ok(ev)) => {
                    stall.on_event(&ev, Instant::now());
                    if matches!(ev, Event::InitDone) {
                        retry.reset();
                    }
                    if let Some(msg) = batch.on(rows_of(kind, ev)) {
                        if !send(msg) {
                            return Outcome::Stop;
                        }
                    }
                    if batch.full() {
                        if let Some(msg) = batch.take() {
                            if !send(msg) {
                                return Outcome::Stop;
                            }
                        }
                    }
                }
                Some(Err(e)) => {
                    let failure = watch_failure(&e, kind);
                    let fatal = is_fatal(&failure);
                    // 오류 전에 받은 변경을 먼저 보낸다(새 목록이 덮지만 그사이 화면이 낡지 않게)
                    if let Some(msg) = batch.take() {
                        if !send(msg) {
                            return Outcome::Stop;
                        }
                    }
                    if !send(WatchMessage::Error { error: describe(&failure, endpoint), fatal }) || fatal {
                        return Outcome::Stop;
                    }
                    return Outcome::Retry;
                }
            },
            _ = tick.tick() => {
                if stall.expired(Instant::now()) && !send(WatchMessage::Error { error: describe(&Failure::Unreachable, endpoint), fatal: false }) {
                    return Outcome::Stop;
                }
                if let Some(msg) = batch.take() {
                    if !send(msg) {
                        return Outcome::Stop;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
