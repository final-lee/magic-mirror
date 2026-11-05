//! 큰 키 찾기(표본): SCAN으로 최대 5,000개를 훑으며 키마다 `MEMORY USAGE key SAMPLES 5`를 재서 상위를 돌려준다.
//! 서버리스는 MEMORY가 막혀 있어 길이(원소 수·바이트)로 대신한다(`basis`가 밝힌다). 진행을 알리고 중단할 수 있다.
//! 명령 제한 시간은 30초다.

use std::sync::atomic::{AtomicBool, Ordering};

use super::value::concurrently;

use super::command::cmd;
use super::connect::{Connected, BIGKEYS_TIMEOUT};
use super::key::length_command;
use super::model::{KvBigKey, KvBigKeysBasis, KvBigKeysMessage, KvKeyName, KvMode, KvType};
use super::overview::dbsize;
use super::scan::{Scanner, SCAN_COUNT};
use super::value::{int, text};
use crate::error::AppError;

/// 훑을 키의 최대 수
pub const MAX_SCANNED: u64 = 5_000;
/// 키마다 크기를 재는 동시 수
const SIZE_CONCURRENCY: usize = 16;


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

/// 큰 키를 찾는다. `progress(읽은 수, 전체 약 수)`를 배치마다 부르고, `stop`이 켜지면 거기까지 모은 것으로 끝낸다(`stopped`).
pub async fn bigkeys(conn: &Connected, limit: usize, stop: &AtomicBool, mut progress: impl FnMut(u64, u64)) -> Result<KvBigKeysMessage, AppError> {
    let basis = if conn.mode() == KvMode::Serverless { KvBigKeysBasis::Length } else { KvBigKeysBasis::Memory };
    let total = dbsize(conn).await?.min(MAX_SCANNED);
    let mut scanner = Scanner::start(conn, "*", None, SCAN_COUNT);
    let mut sized: Vec<(u64, Vec<u8>, Option<KvType>)> = Vec::new();
    let mut scanned: u64 = 0;
    let mut stopped = false;
    while scanned < MAX_SCANNED {
        if stop.load(Ordering::Relaxed) {
            stopped = true;
            break;
        }
        let Some(batch) = scanner.step().await? else { break };
        let room = (MAX_SCANNED - scanned) as usize;
        let batch: Vec<Vec<u8>> = batch.into_iter().take(room).collect();
        scanned += batch.len() as u64;
        let sizes = concurrently(batch.iter(), SIZE_CONCURRENCY, |key| size_of(conn, key, basis)).await;
        for (key, size) in batch.into_iter().zip(sizes) {
            if let Some((size, kind)) = size? {
                sized.push((size, key, kind));
            }
        }
        progress(scanned, total.max(scanned));
    }
    sized.sort_by_key(|s| std::cmp::Reverse(s.0));
    sized.truncate(limit);
    let mut keys = Vec::with_capacity(sized.len());
    for (size, key, kind) in sized {
        let kind = match kind {
            Some(kind) => kind,
            None => type_of(conn, &key).await?.unwrap_or(KvType::Other),
        };
        keys.push(KvBigKey { name: KvKeyName::from_bytes(&key), kind, size });
    }
    Ok(KvBigKeysMessage::Done { basis, keys, scanned, stopped })
}
