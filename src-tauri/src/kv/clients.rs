//! 클라이언트 목록: 노드별 `CLIENT LIST`. 앱 자신의 연결은 같은 연결로 `CLIENT ID`를 물어 알아본다
//! (연결 이름은 붙이지 않는다: `CLIENT SETNAME`은 쓰기 명령이다).
//! 읽기 엔드포인트로 연 연결은 어느 복제본에 붙었는지 모르므로 `INFO server`의 `run_id`가 같은 노드에서 그 연결의 ID도 앱의 것으로 본다.

use std::collections::{HashMap, HashSet};

use futures::future::join_all;

use super::command::cmd;
use super::connect::Connected;
use super::info;
use super::model::{KvClient, KvMode};
use super::overview::gather;
use super::value::{int, text};
use crate::error::AppError;

/// `CLIENT LIST`의 한 줄(`id=3 addr=… name= …`)을 이름 → 값으로
fn line_fields(line: &str) -> HashMap<&str, &str> {
    line.split(' ').filter_map(|part| part.split_once('=')).collect()
}

fn number(fields: &HashMap<&str, &str>, name: &str) -> i64 {
    fields.get(name).and_then(|v| v.parse().ok()).unwrap_or(0)
}

/// `CLIENT LIST` 답을 읽는다. `own`은 이 노드에서 앱의 연결 ID들
pub fn parse(node: &str, text: &str, own: &HashSet<String>) -> Vec<KvClient> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|line| {
            let f = line_fields(line);
            let id = f.get("id").copied().unwrap_or_default().to_string();
            KvClient {
                node: node.to_string(),
                own: own.contains(&id),
                id,
                addr: f.get("addr").copied().unwrap_or_default().to_string(),
                name: f.get("name").copied().unwrap_or_default().to_string(),
                user: f.get("user").copied().unwrap_or_default().to_string(),
                db: number(&f, "db"),
                age: number(&f, "age"),
                idle: number(&f, "idle"),
                cmd: f.get("cmd").copied().unwrap_or_default().to_string(),
                flags: f.get("flags").copied().unwrap_or_default().to_string(),
            }
        })
        .collect()
}

/// 읽기 연결의 (연결 ID, 서버 run_id). 읽기 연결이 없거나 못 읽으면 `None`
async fn reader_identity(conn: &Connected) -> Option<(String, String)> {
    if !conn.has_reader() {
        return None;
    }
    let id = int(&conn.data(cmd("CLIENT ID")).await.ok()?)?.to_string();
    let run_id = info::run_id(&text(&conn.data(cmd("INFO").arg("server")).await.ok()?)?)?;
    Some((id, run_id))
}

async fn node_clients(conn: &Connected, address: &str, reader: &Option<(String, String)>) -> Result<Vec<KvClient>, AppError> {
    let mut own = HashSet::new();
    if let Some(id) = int(&conn.on_node(address, cmd("CLIENT ID")).await?) {
        own.insert(id.to_string());
    }
    if let Some((reader_id, reader_run)) = reader {
        let run = conn.on_node(address, cmd("INFO").arg("server")).await.ok().and_then(|v| text(&v)).and_then(|t| info::run_id(&t));
        if run.as_ref() == Some(reader_run) {
            own.insert(reader_id.clone());
        }
    }
    let list = conn.on_node(address, cmd("CLIENT LIST")).await?;
    Ok(parse(address, &text(&list).unwrap_or_default(), &own))
}

pub async fn clients(conn: &Connected) -> Result<Vec<KvClient>, AppError> {
    if conn.mode() == KvMode::Serverless {
        return Err(AppError::other("서버리스 캐시는 클라이언트 목록을 볼 수 없어요"));
    }
    let reader = reader_identity(conn).await;
    let reads = join_all(conn.nodes().iter().map(|n| node_clients(conn, &n.address, &reader))).await;
    Ok(gather(reads)?.into_iter().flatten().collect())
}

#[cfg(test)]
mod tests;
