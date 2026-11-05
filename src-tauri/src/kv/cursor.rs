//! 화면과 주고받는 불투명 커서(순수 함수).
//! - 키 훑기: 노드마다 남은 SCAN 커서. 클러스터는 기본 노드마다 따로 훑으므로 노드 → 커서의 목록을 하나의 글로 만든다.
//! - 값 더 읽기: 컬렉션 종류마다 이어 읽을 자리(HSCAN·SSCAN 커서, 리스트·정렬 셋의 순번, 스트림의 마지막 ID).
//!
//! 커서 안의 글은 서버에 보내는 명령의 인자가 되므로 읽을 때 모양을 검사한다.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

use crate::error::AppError;

fn invalid() -> AppError {
    AppError::other("이어 읽을 자리가 올바르지 않아요. 처음부터 다시 읽어 주세요")
}

/// SCAN 커서는 서버가 주는 부호 없는 정수다
fn is_scan_cursor(text: &str) -> bool {
    !text.is_empty() && text.len() <= 20 && text.bytes().all(|b| b.is_ascii_digit())
}

/// 키 훑기 커서: 아직 끝나지 않은 노드들과 그 노드의 SCAN 커서. 순서가 훑는 순서다
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ScanCursor {
    pub nodes: Vec<(String, String)>,
}

impl ScanCursor {
    pub fn encode(&self) -> String {
        let json = serde_json::to_vec(&self.nodes).unwrap_or_default();
        format!("s1.{}", URL_SAFE_NO_PAD.encode(json))
    }

    pub fn decode(text: &str) -> Result<ScanCursor, AppError> {
        let body = text.strip_prefix("s1.").ok_or_else(invalid)?;
        let json = URL_SAFE_NO_PAD.decode(body).map_err(|_| invalid())?;
        let nodes: Vec<(String, String)> = serde_json::from_slice(&json).map_err(|_| invalid())?;
        if nodes.is_empty() || nodes.iter().any(|(node, cursor)| node.is_empty() || !is_scan_cursor(cursor)) {
            return Err(invalid());
        }
        Ok(ScanCursor { nodes })
    }
}

/// 컬렉션 값을 이어 읽을 자리
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageCursor {
    /// HSCAN·SSCAN 커서
    Scan(String),
    /// LRANGE·ZRANGE의 다음 순번
    Index(u64),
    /// XRANGE: 이 ID는 이미 읽었다(다음은 그 뒤부터)
    After(String),
}

/// 스트림 ID: `밀리초` 또는 `밀리초-순번`
fn is_stream_id(text: &str) -> bool {
    let mut parts = text.splitn(2, '-');
    let digits = |s: &str| !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit());
    parts.next().is_some_and(digits) && parts.next().is_none_or(digits)
}

impl PageCursor {
    pub fn encode(&self) -> String {
        match self {
            PageCursor::Scan(cursor) => format!("scan:{cursor}"),
            PageCursor::Index(index) => format!("idx:{index}"),
            PageCursor::After(id) => format!("id:{id}"),
        }
    }

    pub fn decode(text: &str) -> Result<PageCursor, AppError> {
        if let Some(cursor) = text.strip_prefix("scan:") {
            return is_scan_cursor(cursor).then(|| PageCursor::Scan(cursor.to_string())).ok_or_else(invalid);
        }
        if let Some(index) = text.strip_prefix("idx:") {
            return index.parse().map(PageCursor::Index).map_err(|_| invalid());
        }
        if let Some(id) = text.strip_prefix("id:") {
            return is_stream_id(id).then(|| PageCursor::After(id.to_string())).ok_or_else(invalid);
        }
        Err(invalid())
    }
}

#[cfg(test)]
mod tests;
