//! 키 하나의 값: 종류별로 한 쪽씩 읽는다(문자열 1MiB, 컬렉션 200개, 스트림 100개). 읽기 명령만 쓴다.
//! 키 이름은 바이트 그대로 보낸다. 값도 바이트 그대로 받아 화면에는 글(UTF-8일 때)과 Base64를 함께 준다.

use super::command::cmd;
use super::connect::Connected;
use super::cursor::PageCursor;
use super::model::{
    KvBytes, KvField, KvKeyName, KvKeyView, KvMode, KvScored, KvStreamEntry, KvStreamSummary, KvType, KvValue,
};
use super::value::{bytes, field, float, int, items, text};
use crate::error::AppError;

/// 문자열·JSON을 읽는 최대 바이트
pub const MAX_VALUE_BYTES: usize = 1024 * 1024;
/// 해시·셋·정렬 셋·리스트의 한 쪽 크기
pub const PAGE_ITEMS: usize = 200;
/// 스트림의 한 쪽 크기
pub const PAGE_ENTRIES: usize = 100;

/// 스트림 ID 다음 ID(`밀리초-순번`). 이미 읽은 ID 다음부터 읽을 때 쓴다(`(` 배타 표기는 Redis 6.2부터라 쓰지 않는다)
pub fn next_stream_id(id: &str) -> Option<String> {
    let (ms, seq) = match id.split_once('-') {
        Some((ms, seq)) => (ms.parse::<u64>().ok()?, seq.parse::<u64>().ok()?),
        None => (id.parse::<u64>().ok()?, 0),
    };
    Some(match seq.checked_add(1) {
        Some(seq) => format!("{ms}-{seq}"),
        None => format!("{}-0", ms.checked_add(1)?),
    })
}

/// 평평한 `[이름, 값, 이름, 값…]` 답을 필드 목록으로
fn fields_of(flat: &[fred::types::Value]) -> Vec<KvField> {
    flat.chunks_exact(2)
        .filter_map(|pair| Some(KvField { field: KvBytes::from_bytes(&bytes(&pair[0])?), value: KvBytes::from_bytes(&bytes(&pair[1])?) }))
        .collect()
}

/// 글자 수가 아니라 바이트로 자르되 글자 중간에서는 자르지 않는다
fn truncate_utf8(mut text: String, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text, false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    (text, true)
}

async fn count(conn: &Connected, command: &'static str, key: &[u8]) -> Result<Option<u64>, AppError> {
    Ok(int(&conn.data(cmd(command).arg(key)).await?).and_then(|n| u64::try_from(n).ok()))
}

/// 종류별 길이 명령
pub fn length_command(kind: KvType) -> Option<&'static str> {
    match kind {
        KvType::String => Some("STRLEN"),
        KvType::Hash => Some("HLEN"),
        KvType::List => Some("LLEN"),
        KvType::Set => Some("SCARD"),
        KvType::Zset => Some("ZCARD"),
        KvType::Stream => Some("XLEN"),
        KvType::Json | KvType::Other => None,
    }
}

async fn string_value(conn: &Connected, key: &[u8], length: Option<u64>) -> Result<KvValue, AppError> {
    let reply = conn.data(cmd("GETRANGE").arg(key).arg(0i64).arg((MAX_VALUE_BYTES - 1) as i64)).await?;
    let data = bytes(&reply).unwrap_or_default();
    let truncated = length.is_some_and(|l| l > MAX_VALUE_BYTES as u64);
    Ok(KvValue::String { value: KvBytes::from_bytes(&data), truncated })
}

async fn json_value(conn: &Connected, key: &[u8]) -> Result<KvValue, AppError> {
    let reply = conn.data(cmd("JSON.GET").arg(key).arg(".")).await?;
    let (text, truncated) = truncate_utf8(String::from_utf8_lossy(&bytes(&reply).unwrap_or_default()).into_owned(), MAX_VALUE_BYTES);
    Ok(KvValue::Json { text, truncated })
}

/// HSCAN·SSCAN의 답: `[다음 커서, [항목…]]`
fn scan_reply(reply: &fred::types::Value) -> Result<(Option<PageCursor>, Vec<fred::types::Value>), AppError> {
    let parts = items(reply);
    let next = parts.first().and_then(text).ok_or_else(|| AppError::other("SCAN 답을 읽지 못했어요"))?;
    let rows = parts.get(1).map(items).unwrap_or_default().to_vec();
    Ok(((next != "0").then_some(PageCursor::Scan(next)), rows))
}

fn scan_start(page: &Option<PageCursor>) -> Result<String, AppError> {
    match page {
        None => Ok("0".to_string()),
        Some(PageCursor::Scan(cursor)) => Ok(cursor.clone()),
        Some(_) => Err(AppError::other("이어 읽을 자리가 이 키의 종류와 맞지 않아요")),
    }
}

fn index_start(page: &Option<PageCursor>) -> Result<u64, AppError> {
    match page {
        None => Ok(0),
        Some(PageCursor::Index(index)) => Ok(*index),
        Some(_) => Err(AppError::other("이어 읽을 자리가 이 키의 종류와 맞지 않아요")),
    }
}

fn next_index(start: u64, read: usize, total: Option<u64>) -> Option<PageCursor> {
    let end = start + read as u64;
    (read > 0 && total.is_none_or(|t| end < t)).then_some(PageCursor::Index(end))
}

async fn stream_value(conn: &Connected, key: &[u8], page: &Option<PageCursor>) -> Result<(KvValue, Option<PageCursor>), AppError> {
    let start = match page {
        None => "-".to_string(),
        Some(PageCursor::After(id)) => next_stream_id(id).ok_or_else(|| AppError::other("이어 읽을 자리가 올바르지 않아요"))?,
        Some(_) => return Err(AppError::other("이어 읽을 자리가 이 키의 종류와 맞지 않아요")),
    };
    let reply = conn.data(cmd("XRANGE").arg(key).arg(start.as_str()).arg("+").arg("COUNT").arg(PAGE_ENTRIES)).await?;
    let entries: Vec<KvStreamEntry> = items(&reply)
        .iter()
        .filter_map(|entry| {
            let parts = items(entry);
            Some(KvStreamEntry { id: text(parts.first()?)?, fields: fields_of(parts.get(1).map(items).unwrap_or_default()) })
        })
        .collect();
    let next = (entries.len() >= PAGE_ENTRIES).then(|| entries.last().map(|e| PageCursor::After(e.id.clone()))).flatten();
    // 요약은 첫 쪽에만 있으면 된다. 못 읽어도(권한 …) 값은 보인다
    let summary = if page.is_none() { stream_summary(conn, key).await } else { None };
    Ok((KvValue::Stream { summary, entries }, next))
}

async fn stream_summary(conn: &Connected, key: &[u8]) -> Option<KvStreamSummary> {
    let reply = conn.data(cmd("XINFO STREAM").arg(key)).await.ok()?;
    let entry_id = |name: &str| field(&reply, name).and_then(|e| items(e).first().and_then(text));
    Some(KvStreamSummary {
        length: field(&reply, "length").and_then(int).and_then(|n| u64::try_from(n).ok()).unwrap_or(0),
        groups: field(&reply, "groups").and_then(int).and_then(|n| u64::try_from(n).ok()).unwrap_or(0),
        first_id: entry_id("first-entry"),
        last_id: entry_id("last-entry").or_else(|| field(&reply, "last-generated-id").and_then(text)),
    })
}

/// 값 한 쪽과 다음 쪽을 가리키는 커서
async fn value_page(conn: &Connected, key: &[u8], kind: KvType, type_name: &str, length: Option<u64>, page: &Option<PageCursor>) -> Result<(KvValue, Option<PageCursor>), AppError> {
    match kind {
        KvType::String => Ok((string_value(conn, key, length).await?, None)),
        KvType::Json => Ok((json_value(conn, key).await?, None)),
        KvType::Hash => {
            let reply = conn.data(cmd("HSCAN").arg(key).arg(scan_start(page)?).arg("COUNT").arg(PAGE_ITEMS)).await?;
            let (next, rows) = scan_reply(&reply)?;
            Ok((KvValue::Hash { entries: fields_of(&rows) }, next))
        }
        KvType::Set => {
            let reply = conn.data(cmd("SSCAN").arg(key).arg(scan_start(page)?).arg("COUNT").arg(PAGE_ITEMS)).await?;
            let (next, rows) = scan_reply(&reply)?;
            Ok((KvValue::Set { members: rows.iter().filter_map(bytes).map(|m| KvBytes::from_bytes(&m)).collect() }, next))
        }
        KvType::List => {
            let start = index_start(page)?;
            let reply = conn.data(cmd("LRANGE").arg(key).arg(start).arg(start + PAGE_ITEMS as u64 - 1)).await?;
            let rows: Vec<KvBytes> = items(&reply).iter().filter_map(bytes).map(|m| KvBytes::from_bytes(&m)).collect();
            let next = next_index(start, rows.len(), length);
            Ok((KvValue::List { start, items: rows }, next))
        }
        KvType::Zset => {
            let start = index_start(page)?;
            let reply = conn.data(cmd("ZRANGE").arg(key).arg(start).arg(start + PAGE_ITEMS as u64 - 1).arg("WITHSCORES")).await?;
            let members: Vec<KvScored> = items(&reply)
                .chunks_exact(2)
                .filter_map(|pair| Some(KvScored { member: KvBytes::from_bytes(&bytes(&pair[0])?), score: float(&pair[1])? }))
                .collect();
            let next = next_index(start, members.len(), length);
            Ok((KvValue::Zset { start, members }, next))
        }
        KvType::Stream => stream_value(conn, key, page).await,
        KvType::Other => Ok((KvValue::Other { type_name: type_name.to_string() }, None)),
    }
}

/// 키 하나의 화면용 정보와 값 한 쪽
pub async fn key_view(conn: &Connected, name: &KvKeyName, page: Option<&str>) -> Result<KvKeyView, AppError> {
    let key = name.to_bytes()?;
    let page = page.map(PageCursor::decode).transpose()?;
    let type_name = text(&conn.data(cmd("TYPE").arg(&key)).await?).unwrap_or_default();
    if type_name == "none" {
        return Err(AppError::other("키가 없어요. 지워졌거나 만료됐을 수 있어요"));
    }
    let kind = KvType::from_type_name(&type_name);
    let ttl_ms = int(&conn.data(cmd("PTTL").arg(&key)).await?).filter(|ms| *ms >= 0);
    let length = match length_command(kind) {
        Some(command) => count(conn, command, &key).await?,
        None => None,
    };
    // 메모리와 인코딩은 덤이다: 서버리스는 막혀 있고, 권한이 없으면 비워 둔다
    let (memory, encoding) = if conn.mode() == KvMode::Serverless {
        (None, None)
    } else {
        let memory = conn.data(cmd("MEMORY USAGE").arg(&key).arg("SAMPLES").arg(5i64)).await.ok().and_then(|v| int(&v)).and_then(|n| u64::try_from(n).ok());
        let encoding = conn.data(cmd("OBJECT ENCODING").arg(&key)).await.ok().and_then(|v| text(&v));
        (memory, encoding)
    };
    let (value, next) = value_page(conn, &key, kind, &type_name, length, &page).await?;
    Ok(KvKeyView { name: name.clone(), kind, ttl_ms, length, memory, encoding, value, next: next.map(|c| c.encode()) })
}

#[cfg(test)]
mod tests;
