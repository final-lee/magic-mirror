//! Bull 화면이 키를 읽는 얇은 도구들. 모두 읽기 허용 목록 안의 명령이고 `Connected::data`(키의 슬롯으로 보낸다)로 보낸다.

use super::model::KvBullFlavor;
use crate::error::AppError;
use crate::kv::command::cmd;
use crate::kv::connect::Connected;
use crate::kv::value::{bytes, float, int, items, text};

fn count_of(value: &fred::types::Value) -> u64 {
    int(value).and_then(|n| u64::try_from(n).ok()).unwrap_or(0)
}

pub async fn llen(conn: &Connected, key: &str) -> Result<u64, AppError> {
    Ok(count_of(&conn.data(cmd("LLEN").arg(key)).await?))
}

pub async fn zcard(conn: &Connected, key: &str) -> Result<u64, AppError> {
    Ok(count_of(&conn.data(cmd("ZCARD").arg(key)).await?))
}

pub async fn scard(conn: &Connected, key: &str) -> Result<u64, AppError> {
    Ok(count_of(&conn.data(cmd("SCARD").arg(key)).await?))
}

pub async fn exists(conn: &Connected, key: &str) -> Result<bool, AppError> {
    Ok(count_of(&conn.data(cmd("EXISTS").arg(key)).await?) > 0)
}

/// 종류를 보고 개수를 센다(옛 Bull의 `completed`·`failed`는 셋이고 BullMQ는 정렬 셋이다). 없는 키는 0
pub async fn card_any(conn: &Connected, key: &str) -> Result<u64, AppError> {
    match text(&conn.data(cmd("TYPE").arg(key)).await?).as_deref() {
        Some("zset") => zcard(conn, key).await,
        Some("set") => scard(conn, key).await,
        Some("list") => llen(conn, key).await,
        _ => Ok(0),
    }
}

/// 해시의 필드들(없는 필드는 `None`). 글은 깨진 글자로 바꿔 읽는다
pub async fn hmget(conn: &Connected, key: &str, fields: &[&str]) -> Result<Vec<Option<String>>, AppError> {
    let mut command = cmd("HMGET").arg(key);
    for field in fields {
        command = command.arg(*field);
    }
    let reply = conn.data(command).await?;
    let mut values: Vec<Option<String>> = items(&reply).iter().map(text).collect();
    values.resize(fields.len(), None);
    Ok(values)
}

/// 정렬 셋의 `[시작, 끝]` 순번(점수 포함). `reverse`면 점수가 큰 쪽부터
pub async fn zrange_scored(conn: &Connected, key: &str, start: i64, stop: i64, reverse: bool) -> Result<Vec<(String, f64)>, AppError> {
    let command = if reverse { cmd("ZREVRANGE") } else { cmd("ZRANGE") };
    let reply = conn.data(command.arg(key).arg(start).arg(stop).arg("WITHSCORES")).await?;
    Ok(items(&reply).chunks_exact(2).filter_map(|pair| Some((text(&pair[0])?, float(&pair[1])?))).collect())
}

pub async fn zrange_ids(conn: &Connected, key: &str, start: i64, stop: i64, reverse: bool) -> Result<Vec<String>, AppError> {
    let command = if reverse { cmd("ZREVRANGE") } else { cmd("ZRANGE") };
    let reply = conn.data(command.arg(key).arg(start).arg(stop)).await?;
    Ok(items(&reply).iter().filter_map(text).collect())
}

pub async fn lrange(conn: &Connected, key: &str, start: i64, stop: i64) -> Result<Vec<String>, AppError> {
    let reply = conn.data(cmd("LRANGE").arg(key).arg(start).arg(stop)).await?;
    Ok(items(&reply).iter().filter_map(bytes).map(|b| String::from_utf8_lossy(&b).into_owned()).collect())
}

/// 셋의 원소를 SSCAN으로 `limit`개까지(한 번에 다 읽지 않는다)
pub async fn sscan_limited(conn: &Connected, key: &str, limit: usize) -> Result<Vec<String>, AppError> {
    let mut out = Vec::new();
    let mut cursor = "0".to_string();
    loop {
        let reply = conn.data(cmd("SSCAN").arg(key).arg(cursor.as_str()).arg("COUNT").arg(limit)).await?;
        let parts = items(&reply);
        out.extend(parts.get(1).map(items).unwrap_or_default().iter().filter_map(text));
        cursor = parts.first().and_then(text).unwrap_or_else(|| "0".to_string());
        if cursor == "0" || out.len() >= limit {
            out.truncate(limit);
            return Ok(out);
        }
    }
}

/// 해시의 (필드, 값)을 HSCAN으로 `limit`개까지
pub async fn hscan_limited(conn: &Connected, key: &str, limit: usize) -> Result<Vec<(String, String)>, AppError> {
    let mut out = Vec::new();
    let mut cursor = "0".to_string();
    loop {
        let reply = conn.data(cmd("HSCAN").arg(key).arg(cursor.as_str()).arg("COUNT").arg(limit)).await?;
        let parts = items(&reply);
        out.extend(parts.get(1).map(items).unwrap_or_default().chunks_exact(2).filter_map(|p| Some((text(&p[0])?, text(&p[1])?))));
        cursor = parts.first().and_then(text).unwrap_or_else(|| "0".to_string());
        if cursor == "0" || out.len() >= limit {
            out.truncate(limit);
            return Ok(out);
        }
    }
}

/// 큐의 종류와 일시정지 여부: `meta`에 `version`이 있으면 BullMQ, 없으면 옛 Bull. 일시정지는 BullMQ는 `meta.paused`, 옛 Bull은 `meta-paused` 키가 있는지다.
/// BullMQ의 버전은 `bullmq:5.12.0`처럼 오므로 앞의 `bullmq:`는 뗀다.
pub async fn flavor_of(conn: &Connected, prefix: &str, queue: &str) -> Result<(KvBullFlavor, Option<String>, bool), AppError> {
    use super::keys::queue_key;
    let meta = hmget(conn, &queue_key(prefix, queue, "meta"), &["version", "paused"]).await?;
    match meta.first().cloned().flatten() {
        Some(version) => {
            let paused = meta.get(1).cloned().flatten().as_deref() == Some("1");
            Ok((KvBullFlavor::Bullmq, Some(version.strip_prefix("bullmq:").unwrap_or(&version).to_string()), paused))
        }
        None => Ok((KvBullFlavor::Bull, None, exists(conn, &queue_key(prefix, queue, "meta-paused")).await?)),
    }
}
