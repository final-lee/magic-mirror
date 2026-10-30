//! 목록 watch. 처음 목록(Init…InitDone)은 한 번에 `Reset`으로, 그 뒤 변경은 100ms 또는 500줄마다 `Changes`로 묶어 보낸다.
use std::collections::BTreeMap;

use kube::api::{Api, ApiResource, DynamicObject, GroupVersionKind};
use kube::runtime::watcher::{self, Event};
use kube::runtime::WatchStreamExt;

use super::failure::{describe, failure_of, Endpoint, Failure};
use super::rows::{row_of, KindRef, Row};
use crate::error::AppError;

pub const FLUSH_EVERY: std::time::Duration = std::time::Duration::from_millis(100);
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

/// 보내기가 실패하면(프론트가 채널을 버림) 끝난다. 403·401은 치명적이라 알리고 끝낸다. 다른 오류는 알리고 watcher의 재시도(backoff)에 맡긴다.
pub async fn run<F>(client: kube::Client, kind: KindRef, namespace: Option<String>, endpoint: Endpoint, mut send: F)
where
    F: FnMut(WatchMessage) -> bool + Send,
{
    use futures::StreamExt;

    let gvk = GroupVersionKind::gvk(&kind.group, &kind.version, &kind.kind);
    let ar = ApiResource::from_gvk_with_plural(&gvk, &kind.plural);
    let api: Api<DynamicObject> = match (&namespace, kind.namespaced) {
        (Some(ns), true) => Api::namespaced_with(client, ns, &ar),
        _ => Api::all_with(client, &ar),
    };
    let mut stream = watcher::watcher(api, watcher::Config::default().page_size(PAGE_SIZE)).default_backoff().boxed();
    let mut batch = Batcher::default();
    let mut tick = tokio::time::interval(FLUSH_EVERY);
    loop {
        tokio::select! {
            next = stream.next() => match next {
                None => return,
                Some(Ok(ev)) => {
                    if let Some(msg) = batch.on(rows_of(&kind, ev)) {
                        if !send(msg) {
                            return;
                        }
                    }
                    if batch.full() {
                        if let Some(msg) = batch.take() {
                            if !send(msg) {
                                return;
                            }
                        }
                    }
                }
                Some(Err(e)) => {
                    let failure = watch_failure(&e, &kind);
                    let fatal = is_fatal(&failure);
                    if !send(WatchMessage::Error { error: describe(&failure, endpoint), fatal }) || fatal {
                        return;
                    }
                }
            },
            _ = tick.tick() => {
                if let Some(msg) = batch.take() {
                    if !send(msg) {
                        return;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
