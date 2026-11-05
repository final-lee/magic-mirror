//! 키 훑기: 기본 노드마다 SCAN(MATCH·COUNT·TYPE)으로 읽고, 키마다 TYPE과 PTTL을 묻는다. `KEYS`는 쓰지 않는다.
//! 클러스터는 기본 노드를 하나씩 끝까지 훑고(커서가 노드 → SCAN 커서를 담는다), 서버리스와 클러스터 모드 꺼짐은 연결 하나로 훑는다.
//! 키 이름은 바이트 그대로 다룬다(UTF-8이 아닐 수 있다).

use std::collections::HashSet;
use std::time::{Duration, Instant};

use super::value::concurrently;

use super::command::cmd;
use super::connect::Connected;
use super::cursor::ScanCursor;
use super::model::{KvKeyName, KvKeyRow, KvMode, KvRole, KvScanPage, KvType};
use super::value::{bytes, int, items, text};
use crate::error::AppError;

/// SCAN 한 번의 COUNT(설계: 노드마다 500씩)
pub const SCAN_COUNT: usize = 500;
/// 키 하나의 TYPE·PTTL을 동시에 묻는 수. fred가 같은 연결에서 자동으로 파이프라인한다
const LOOKUP_CONCURRENCY: usize = 64;
/// 한 번의 호출에서 SCAN을 부르는 최대 횟수와 시간. 드문 패턴은 끝없이 돌 수 있어서 넘으면 거기까지 돌려주고 커서를 준다
const MAX_CALLS: usize = 400;
const MAX_TIME: Duration = Duration::from_secs(8);

/// 단일 연결로 훑는 곳(서버리스, 클러스터 모드 꺼짐)을 가리키는 노드 이름
const SINGLE: &str = "-";

/// SCAN을 한 번씩 부르며 나아가는 훑개. 노드 하나를 끝까지 훑은 뒤 다음 노드로 간다.
pub struct Scanner<'a> {
    conn: &'a Connected,
    pattern: Option<String>,
    type_name: Option<&'static str>,
    count: usize,
    /// 아직 끝나지 않은 노드들과 그 SCAN 커서. 앞이 지금 훑는 노드다
    nodes: Vec<(String, String)>,
    /// 지금까지 SCAN이 돌려준 키 수
    pub returned: u64,
}

impl<'a> Scanner<'a> {
    fn targets(conn: &Connected) -> Vec<String> {
        match conn.mode() {
            KvMode::Cluster => conn.nodes().iter().filter(|n| n.role == KvRole::Primary).map(|n| n.address.clone()).collect(),
            KvMode::Serverless | KvMode::Standalone => vec![SINGLE.to_string()],
        }
    }

    fn normalize(pattern: &str) -> Option<String> {
        (!pattern.is_empty() && pattern != "*").then(|| pattern.to_string())
    }

    /// 처음부터 훑는다
    pub fn start(conn: &'a Connected, pattern: &str, filter: Option<KvType>, count: usize) -> Scanner<'a> {
        let nodes = Self::targets(conn).into_iter().map(|n| (n, "0".to_string())).collect();
        Scanner { conn, pattern: Self::normalize(pattern), type_name: filter.and_then(KvType::scan_name), count, nodes, returned: 0 }
    }

    /// 커서에서 이어 훑는다
    pub fn resume(conn: &'a Connected, pattern: &str, filter: Option<KvType>, count: usize, cursor: ScanCursor) -> Result<Scanner<'a>, AppError> {
        let known = Self::targets(conn);
        // 노드 목록이 바뀐 뒤(장애 조치 …)의 커서는 이을 수 없다
        if cursor.nodes.iter().any(|(node, _)| !known.contains(node)) {
            return Err(AppError::other("노드 구성이 바뀌었어요. 처음부터 다시 읽어 주세요"));
        }
        Ok(Scanner { conn, pattern: Self::normalize(pattern), type_name: filter.and_then(KvType::scan_name), count, nodes: cursor.nodes, returned: 0 })
    }

    /// 이어 읽을 자리. 다 읽었으면 `None`
    pub fn cursor(&self) -> Option<ScanCursor> {
        (!self.nodes.is_empty()).then(|| ScanCursor { nodes: self.nodes.clone() })
    }

    /// SCAN을 한 번 부른다. 끝났으면 `None`
    pub async fn step(&mut self) -> Result<Option<Vec<Vec<u8>>>, AppError> {
        let Some((node, cursor)) = self.nodes.first().cloned() else { return Ok(None) };
        let mut command = cmd("SCAN").arg(cursor.as_str());
        if let Some(pattern) = &self.pattern {
            command = command.arg("MATCH").arg(pattern.as_str());
        }
        command = command.arg("COUNT").arg(self.count);
        if let Some(type_name) = self.type_name {
            command = command.arg("TYPE").arg(type_name);
        }
        let reply = if node == SINGLE { self.conn.data(command).await? } else { self.conn.on_node(&node, command).await? };
        let parts = items(&reply);
        let next = parts.first().and_then(text).ok_or_else(|| AppError::other("SCAN 답을 읽지 못했어요"))?;
        let keys: Vec<Vec<u8>> = parts.get(1).map(items).unwrap_or_default().iter().filter_map(bytes).collect();
        self.returned += keys.len() as u64;
        if next == "0" {
            self.nodes.remove(0);
        } else {
            self.nodes[0].1 = next;
        }
        Ok(Some(keys))
    }
}

/// 키 하나의 종류와 남은 수명. 이미 없어진 키(`none`)는 `None`
async fn describe(conn: &Connected, key: &[u8], known: Option<KvType>) -> Result<Option<KvKeyRow>, AppError> {
    let kind = match known {
        Some(kind) => kind,
        None => {
            let reply = conn.data(cmd("TYPE").arg(key)).await?;
            let name = text(&reply).unwrap_or_default();
            if name == "none" {
                return Ok(None);
            }
            KvType::from_type_name(&name)
        }
    };
    let ttl = int(&conn.data(cmd("PTTL").arg(key)).await?).filter(|ms| *ms >= 0);
    Ok(Some(KvKeyRow { name: KvKeyName::from_bytes(key), kind, ttl_ms: ttl }))
}

/// 키들의 종류와 수명을 묻는다. 순서는 그대로 둔다
pub async fn describe_all(conn: &Connected, keys: &[Vec<u8>], known: Option<KvType>) -> Result<Vec<KvKeyRow>, AppError> {
    let rows = concurrently(keys.iter(), LOOKUP_CONCURRENCY, |key| describe(conn, key, known)).await;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.extend(row?);
    }
    Ok(out)
}

/// 한 쪽을 읽는다: 키를 `count`개 모을 때까지(또는 다 읽거나 횟수·시간 한도까지) 훑고, 키마다 TYPE·PTTL을 묻는다
pub async fn scan(conn: &Connected, pattern: &str, filter: Option<KvType>, cursor: Option<&str>, count: usize) -> Result<KvScanPage, AppError> {
    let wanted = count.max(1);
    let mut scanner = match cursor {
        Some(text) => Scanner::resume(conn, pattern, filter, SCAN_COUNT, ScanCursor::decode(text)?)?,
        None => Scanner::start(conn, pattern, filter, SCAN_COUNT),
    };
    let started = Instant::now();
    let mut seen: HashSet<Vec<u8>> = HashSet::new();
    let mut keys: Vec<Vec<u8>> = Vec::new();
    for _ in 0..MAX_CALLS {
        let Some(batch) = scanner.step().await? else { break };
        for key in batch {
            if seen.insert(key.clone()) {
                keys.push(key);
            }
        }
        if keys.len() >= wanted || started.elapsed() > MAX_TIME {
            break;
        }
    }
    // 종류 필터가 있으면 SCAN이 이미 그 종류만 돌려줬다
    let known = filter.filter(|f| f.scan_name().is_some());
    let rows = describe_all(conn, &keys, known).await?;
    Ok(KvScanPage { keys: rows, cursor: scanner.cursor().map(|c| c.encode()), scanned: scanner.returned })
}
