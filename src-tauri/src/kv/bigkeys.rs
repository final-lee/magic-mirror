//! 큰 키 찾기(전수): SCAN으로 모든 키를 훑으며 키마다 `MEMORY USAGE key SAMPLES 5`를 재서 상위를 돌려준다.
//! 서버리스는 MEMORY가 막혀 있어 길이(원소 수·바이트)로 대신한다(`basis`가 밝힌다). 진행을 알리고 중단할 수 있다.
//! 명령 제한 시간은 30초다.
//!
//! Valkey·Redis는 명령을 한 스레드에서 하나씩 처리한다. 수십만 키를 재는 동안 운영 명령이 밀리지 않게 나눠서 간다.
//! - SCAN 한 번에 5만 개를 받아 한꺼번에(파이프라인) 잰다. 서버는 받은 요청을 16KB씩 읽어 처리하고 그 사이에 다른 클라이언트를 받으므로,
//!   5만 개를 한꺼번에 보내도 한 번에 붙잡는 시간은 짧다. 길게 붙잡는 것은 `SCAN … COUNT 50000` 한 번(운영 ElastiCache에서 약 44ms)뿐이다.
//! - 5만 개를 재고 나면 걸린 시간만큼(최소 0.5초) 쉬고, 그때까지의 상위 키를 중간 결과로 보낸다. 이 작업이 서버 시간을 절반 넘게 쓰지 않는다.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::value::concurrently;

use super::command::cmd;
use super::connect::{Connected, BIGKEYS_TIMEOUT};
use super::key::length_command;
use super::model::{KvBigKey, KvBigKeysBasis, KvBigKeysMessage, KvBigKeysReport, KvKeyName, KvMode, KvType};
use super::overview::dbsize;
use super::scan::Scanner;
use super::value::{int, text};
use crate::error::AppError;

/// SCAN 한 번의 COUNT이자 한꺼번에 재는 키 수. fred가 한 연결에서 파이프라인하므로 왕복 한 번으로 잰다
pub const BATCH: usize = 50_000;
/// 한 번 재고 나서 쉬는 가장 짧은 시간
const MIN_GAP: Duration = Duration::from_millis(500);

/// 한 번 재는 데 `spent`가 걸렸을 때 다음까지 쉬는 시간: 걸린 만큼, 최소 0.5초
pub fn gap_after(spent: Duration) -> Duration {
    spent.max(MIN_GAP)
}

/// 크기 순 상위 `limit`개만 남긴다(같은 크기는 먼저 잰 것이 앞)
fn keep_top(sized: &mut Vec<(u64, Vec<u8>, Option<KvType>)>, limit: usize) {
    sized.sort_by_key(|s| std::cmp::Reverse(s.0));
    sized.truncate(limit);
}

async fn type_of(conn: &Connected, key: &[u8]) -> Result<Option<KvType>, AppError> {
    let reply = conn.data_within(BIGKEYS_TIMEOUT, cmd("TYPE").arg(key)).await?;
    let name = text(&reply).unwrap_or_default();
    Ok((name != "none").then(|| KvType::from_type_name(&name)))
}

/// 키 하나의 크기. 이미 없어진 키는 `None`
async fn size_of(conn: &Connected, key: &[u8], basis: KvBigKeysBasis) -> Result<Option<(u64, Option<KvType>)>, AppError> {
    match basis {
        KvBigKeysBasis::Memory => {
            let reply = conn.data_within(BIGKEYS_TIMEOUT, cmd("MEMORY USAGE").arg(key).arg("SAMPLES").arg(5i64)).await?;
            Ok(int(&reply).and_then(|n| u64::try_from(n).ok()).map(|size| (size, None)))
        }
        KvBigKeysBasis::Length => {
            let Some(kind) = type_of(conn, key).await? else { return Ok(None) };
            let Some(command) = length_command(kind) else { return Ok(None) };
            let reply = conn.data_within(BIGKEYS_TIMEOUT, cmd(command).arg(key)).await?;
            Ok(int(&reply).and_then(|n| u64::try_from(n).ok()).map(|size| (size, Some(kind))))
        }
    }
}

/// 상위 키에 종류를 붙인다(메모리 기준은 종류를 따로 묻는다)
async fn typed(conn: &Connected, top: &[(u64, Vec<u8>, Option<KvType>)]) -> Result<Vec<KvBigKey>, AppError> {
    let types = concurrently(top.iter(), BATCH, |(_, key, kind)| async move {
        Ok::<_, AppError>(match kind {
            Some(kind) => *kind,
            None => type_of(conn, key).await?.unwrap_or(KvType::Other),
        })
    })
    .await;
    top.iter().zip(types).map(|((size, key, _), kind)| Ok(KvBigKey { name: KvKeyName::from_bytes(key), kind: kind?, size: *size })).collect()
}

/// 큰 키를 찾는다. 5만 개를 잴 때마다 `progress`로 진행과 그때까지의 상위 키를 보낸다.
/// `stop`이 켜지면 거기까지 모은 것으로 끝낸다(`stopped`).
pub async fn bigkeys(conn: &Connected, limit: usize, stop: &AtomicBool, mut progress: impl FnMut(KvBigKeysMessage)) -> Result<KvBigKeysReport, AppError> {
    let basis = if conn.mode() == KvMode::Serverless { KvBigKeysBasis::Length } else { KvBigKeysBasis::Memory };
    let total = dbsize(conn).await?;
    let mut scanner = Scanner::start(conn, "*", None, BATCH);
    let mut top: Vec<(u64, Vec<u8>, Option<KvType>)> = Vec::new();
    let mut scanned: u64 = 0;
    let mut stopped = false;
    loop {
        if stop.load(Ordering::Relaxed) {
            stopped = true;
            break;
        }
        let started = Instant::now();
        let Some(batch) = scanner.step().await? else { break };
        scanned += batch.len() as u64;
        let sizes = concurrently(batch.iter(), BATCH, |key| size_of(conn, key, basis)).await;
        for (key, size) in batch.into_iter().zip(sizes) {
            if let Some((size, kind)) = size? {
                top.push((size, key, kind));
            }
        }
        keep_top(&mut top, limit);
        let spent = started.elapsed();
        if scanner.cursor().is_none() {
            break;
        }
        progress(KvBigKeysMessage::Progress { scanned, total: total.max(scanned), keys: Some(typed(conn, &top).await?) });
        tokio::time::sleep(gap_after(spent)).await;
    }
    keep_top(&mut top, limit);
    let keys = typed(conn, &top).await?;
    let generated_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    Ok(KvBigKeysReport { basis, keys, scanned, stopped, generated_at })
}
