//! 서버 답(`fred::types::Value`)을 읽는 작은 도구들. 서버는 RESP2에서 맵을 `[이름, 값, 이름, 값…]` 배열로 보내고 RESP3에서는 맵으로 보내므로
//! 둘을 같은 모양(이름·값 쌍)으로 읽는다. 키와 값은 바이트 그대로 다룬다(UTF-8이 아닐 수 있다).

use std::future::Future;

use fred::types::Value;

/// 문자열·바이트 답의 바이트. 정수 답은 그 글자로 읽는다
pub fn bytes(value: &Value) -> Option<Vec<u8>> {
    match value {
        Value::Integer(n) => Some(n.to_string().into_bytes()),
        other => other.as_bytes().map(<[u8]>::to_vec),
    }
}

/// 문자열 답. UTF-8이 아닌 바이트는 깨진 글자로 바꾼다(화면용)
pub fn text(value: &Value) -> Option<String> {
    bytes(value).map(|b| String::from_utf8_lossy(&b).into_owned())
}

pub fn int(value: &Value) -> Option<i64> {
    match value {
        Value::Integer(n) => Some(*n),
        Value::Double(f) => Some(*f as i64),
        other => other.as_bytes().and_then(|b| std::str::from_utf8(b).ok()).and_then(|s| s.trim().parse().ok()),
    }
}

pub fn float(value: &Value) -> Option<f64> {
    match value {
        Value::Integer(n) => Some(*n as f64),
        Value::Double(f) => Some(*f),
        other => other.as_bytes().and_then(|b| std::str::from_utf8(b).ok()).and_then(|s| s.trim().parse().ok()),
    }
}

/// 배열 답의 원소들. 배열이 아니면(없음 포함) 빈 목록
pub fn items(value: &Value) -> &[Value] {
    match value {
        Value::Array(items) => items,
        _ => &[],
    }
}

/// 이름·값 쌍들. 맵이면 그대로, 배열이면 두 칸씩 짝지어 읽는다. 이름은 글자로 읽을 수 있는 것만 담는다
pub fn pairs(value: &Value) -> Vec<(String, &Value)> {
    match value {
        Value::Map(map) => map.iter().map(|(k, v)| (k.as_str_lossy().into_owned(), v)).collect(),
        Value::Array(items) => items.chunks_exact(2).filter_map(|pair| Some((text(&pair[0])?, &pair[1]))).collect(),
        _ => Vec::new(),
    }
}

/// `pairs`에서 이름으로 찾는다
pub fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    pairs(value).into_iter().find(|(key, _)| key == name).map(|(_, v)| v)
}

/// 작업들을 `limit`개씩 묶어 동시에 돌리고 결과를 순서대로 모은다(같은 연결의 명령은 fred가 자동으로 파이프라인한다)
pub async fn concurrently<I, F, Fut>(items: I, limit: usize, mut work: F) -> Vec<Fut::Output>
where
    I: IntoIterator,
    F: FnMut(I::Item) -> Fut,
    Fut: Future,
{
    let mut items = items.into_iter();
    let mut out = Vec::new();
    loop {
        let group: Vec<Fut> = items.by_ref().take(limit.max(1)).map(&mut work).collect();
        if group.is_empty() {
            return out;
        }
        out.extend(futures::future::join_all(group).await);
    }
}

#[cfg(test)]
mod tests;
