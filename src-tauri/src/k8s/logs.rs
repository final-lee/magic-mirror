//! Pod 컨테이너 로그. `pods/log`를 GET으로 열어(따라가기면 끝까지 열어 둔 채) 줄을 100ms 또는 500줄마다 묶어 보낸다.
//! 여는 요청은 `REQUEST_TIMEOUT` 안에 응답해야 하고, 그 뒤 흐름은 조용해도 된다(따라가기). 끊기면 오류를 알리고 끝낸다.
use std::io;

use futures::io::{AsyncBufRead, AsyncBufReadExt};
use futures::stream::{self, BoxStream, StreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, LogParams};
use serde::{Deserialize, Serialize};

use super::failure::{describe, Endpoint, Failure};
use super::read::bounded;
use super::watch::{FLUSH_EVERY, FLUSH_ROWS};
use crate::error::AppError;

/// 화면이 보관하는 최대 줄 수. 처음 받는 줄 수(`tailLines`)도 이만큼으로 자른다.
pub const KEEP_LINES: i64 = 50_000;
/// 한 줄이 이보다 길면 잘라서 `…`를 붙인다(바이트)
pub const MAX_LINE: usize = 16 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LogOptions {
    /// 없으면 서버가 고른다(컨테이너가 하나일 때만 된다)
    pub container: Option<String>,
    pub follow: bool,
    /// 마지막 몇 줄부터. 없거나 `KEEP_LINES`보다 크면 `KEEP_LINES`
    pub tail_lines: Option<i64>,
    pub since_seconds: Option<i64>,
    /// 다시 시작하기 전 컨테이너의 로그
    pub previous: bool,
    pub timestamps: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogMessage {
    Lines { lines: Vec<String> },
    /// 여기서 흐름이 끝난다
    Error { error: AppError },
    /// 따라가지 않을 때 다 읽었거나, 서버가 흐름을 닫았다(컨테이너가 끝남)
    End,
}

pub fn params(opts: &LogOptions) -> LogParams {
    LogParams {
        container: opts.container.clone(),
        follow: opts.follow,
        tail_lines: Some(opts.tail_lines.unwrap_or(KEEP_LINES).clamp(1, KEEP_LINES)),
        since_seconds: opts.since_seconds.filter(|s| *s > 0),
        previous: opts.previous,
        timestamps: opts.timestamps,
        ..LogParams::default()
    }
}

/// 한 줄의 바이트(`\n` 없이, 앞 `MAX_LINE`바이트까지)를 글로. 끝의 `\r`을 떼고, UTF-8이 아닌 바이트는 �로 바꾸고, 잘렸으면 `…`를 붙인다.
pub fn line_of(mut bytes: Vec<u8>, clipped: bool) -> String {
    if !clipped && bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    let mut s = String::from_utf8_lossy(&bytes).into_owned();
    if clipped {
        s.push('…');
    }
    s
}

/// 읽기 흐름을 줄 흐름으로. 줄마다 앞 `MAX_LINE`바이트만 모으고 나머지는 줄 끝까지 버린다(줄바꿈 없이 쏟아지는 출력도 메모리를 키우지 않는다).
/// 잘못된 UTF-8이 있어도 끊지 않는다.
pub fn lines_of<R: AsyncBufRead + Unpin + Send + 'static>(reader: R) -> BoxStream<'static, io::Result<String>> {
    stream::unfold(reader, |mut r| async move {
        let mut line: Vec<u8> = Vec::new();
        let mut clipped = false;
        loop {
            let (used, done) = match r.fill_buf().await {
                Err(e) => return Some((Err(e), r)),
                // 끝: 남은 줄이 있으면 마지막 줄로
                Ok([]) => return (!line.is_empty() || clipped).then(|| (Ok(line_of(line, clipped)), r)),
                Ok(chunk) => {
                    let newline = chunk.iter().position(|b| *b == b'\n');
                    let content = &chunk[..newline.unwrap_or(chunk.len())];
                    let room = MAX_LINE - line.len();
                    if content.len() > room {
                        clipped = true;
                    }
                    line.extend_from_slice(&content[..content.len().min(room)]);
                    (newline.map_or(chunk.len(), |i| i + 1), newline.is_some())
                }
            };
            r.consume_unpin(used);
            if done {
                return Some((Ok(line_of(line, clipped)), r));
            }
        }
    })
    .boxed()
}

/// 로그를 열어 끝까지(또는 채널이 닫힐 때까지) 보낸다
pub async fn run<F>(client: kube::Client, namespace: String, pod: String, opts: LogOptions, endpoint: Endpoint, mut send: F)
where
    F: FnMut(LogMessage) -> bool + Send,
{
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    match bounded(api.log_stream(&pod, &params(&opts)), "get", "pods/log", endpoint).await {
        Ok(reader) => run_with(lines_of(Box::pin(reader)), endpoint, send).await,
        Err(error) => {
            send(LogMessage::Error { error });
        }
    }
}

/// 줄 흐름을 묶어 보낸다. 보내기가 실패하면(프론트가 채널을 버림) 끝난다. 시험은 가짜 흐름을 넘긴다.
pub async fn run_with<F>(mut lines: BoxStream<'static, io::Result<String>>, endpoint: Endpoint, mut send: F)
where
    F: FnMut(LogMessage) -> bool + Send,
{
    let mut batch: Vec<String> = Vec::new();
    // 첫 틱도 FLUSH_EVERY 뒤에(interval은 첫 틱이 바로 오고, 그러면 처음 몇 줄만 따로 나간다)
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + FLUSH_EVERY, FLUSH_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            next = lines.next() => match next {
                Some(Ok(line)) => {
                    batch.push(line);
                    if batch.len() >= FLUSH_ROWS && !send(LogMessage::Lines { lines: std::mem::take(&mut batch) }) {
                        return;
                    }
                }
                Some(Err(_)) => {
                    if !batch.is_empty() && !send(LogMessage::Lines { lines: std::mem::take(&mut batch) }) {
                        return;
                    }
                    send(LogMessage::Error { error: describe(&Failure::Unreachable, endpoint) });
                    return;
                }
                None => {
                    if !batch.is_empty() && !send(LogMessage::Lines { lines: std::mem::take(&mut batch) }) {
                        return;
                    }
                    send(LogMessage::End);
                    return;
                }
            },
            _ = tick.tick() => {
                if !batch.is_empty() && !send(LogMessage::Lines { lines: std::mem::take(&mut batch) }) {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
