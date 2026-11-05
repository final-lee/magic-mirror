//! 흐름(부모·자식 작업) 그래프: 작업에서 `parentKey`를 따라 뿌리까지(10단계까지) 올라가고, 뿌리에서 의존 키를 따라 너비 우선으로 내려간다(300노드까지).
//! 부모 쪽 키: `<jobKey>:dependencies`(남은 자식, 셋), `:processed`(끝난 자식 → 반환값, 해시), `:failed`(실패한 자식 → 이유, 해시), `:unsuccessful`(무시된 실패 자식, 정렬 셋).
//! 걷는 논리(`walk`)는 읽는 곳(`FlowSource`)을 받는 꼴이라 메모리 위의 가짜 그래프로 시험한다. 읽는 쪽(`JobSource`)은 읽기 명령만 쓴다.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use async_trait::async_trait;

use super::io::{flavor_of, hmget, hscan_limited, is_set, sscan_limited, zrange_ids};
use super::keys::{queue_key, state_suffix};
use super::model::{KvBullEdgeStatus, KvBullFlavor, KvBullFlow, KvBullFlowEdge, KvBullFlowNode, KvBullFlowState, KvBullState};
use super::stats;
use crate::error::AppError;
use crate::kv::command::cmd;
use crate::kv::connect::Connected;
use crate::kv::value::{float, int};

/// 위로 올라가는 최대 단계
pub const MAX_UP: usize = 10;
/// 그래프의 최대 노드 수
pub const MAX_NODES: usize = 300;
/// 한 부모에서 읽는 자식 수(목록마다)
const CHILDREN: usize = 300;
/// 한 층의 노드를 동시에 읽는 수
const FETCH_CONCURRENCY: usize = 16;

/// 작업 키 `<prefix>:<queue>:<id>`를 (prefix, queue, id)로 나눈다. id는 마지막 `:` 뒤다.
/// prefix는 지금 보는 prefix로 시작하면 그것을 먼저 떼고, 아니면(다른 prefix의 큐) 남은 앞부분을 마지막 `:`에서 나눈다.
pub fn split_job_key(key: &str, current_prefix: &str) -> Option<(String, String, String)> {
    let (rest, id) = key.rsplit_once(':')?;
    if id.is_empty() {
        return None;
    }
    if let Some(queue) = rest.strip_prefix(current_prefix).and_then(|r| r.strip_prefix(':')).filter(|q| !q.is_empty()) {
        return Some((current_prefix.to_string(), queue.to_string(), id.to_string()));
    }
    let (prefix, queue) = rest.rsplit_once(':')?;
    (!prefix.is_empty() && !queue.is_empty()).then(|| (prefix.to_string(), queue.to_string(), id.to_string()))
}

/// 작업 하나에서 읽은 것
#[derive(Debug, Clone)]
pub struct NodeData {
    pub name: String,
    pub state: KvBullFlowState,
    pub timestamp: Option<i64>,
    pub finished_on: Option<i64>,
    pub failed_reason: Option<String>,
    pub parent_key: Option<String>,
    pub pending: Vec<String>,
    pub done: Vec<String>,
    pub failed: Vec<String>,
    pub ignored: Vec<String>,
}

impl NodeData {
    /// 작업 해시가 없다
    pub fn missing() -> NodeData {
        NodeData { name: String::new(), state: KvBullFlowState::Missing, timestamp: None, finished_on: None, failed_reason: None, parent_key: None, pending: vec![], done: vec![], failed: vec![], ignored: vec![] }
    }
}

#[async_trait]
pub trait FlowSource: Sync {
    async fn node(&self, key: &str) -> Result<NodeData, AppError>;
}

fn node_of(key: &str, prefix: &str, data: &NodeData) -> KvBullFlowNode {
    let (p, queue, id) = split_job_key(key, prefix).unwrap_or_else(|| (prefix.to_string(), String::new(), key.to_string()));
    KvBullFlowNode {
        key: key.to_string(),
        prefix: p,
        queue,
        id,
        name: data.name.clone(),
        state: data.state,
        timestamp: data.timestamp,
        finished_on: data.finished_on,
        failed_reason: data.failed_reason.clone(),
        pending: data.pending.len() as u64,
        done: data.done.len() as u64,
        failed: (data.failed.len() + data.ignored.len()) as u64,
    }
}

async fn load(source: &dyn FlowSource, cache: &mut HashMap<String, NodeData>, keys: &[String]) -> Result<(), AppError> {
    let todo: Vec<&String> = keys.iter().filter(|k| !cache.contains_key(*k)).collect();
    for group in todo.chunks(FETCH_CONCURRENCY) {
        let fetched = futures::future::join_all(group.iter().map(|key| source.node(key))).await;
        for (key, data) in group.iter().zip(fetched) {
            cache.insert((*key).clone(), data?);
        }
    }
    Ok(())
}

/// 흐름을 걷는다. `focus_key`는 화면이 연 작업이고, 그래프는 그 작업이 속한 흐름 전체(뿌리부터)다.
pub async fn walk(source: &dyn FlowSource, prefix: &str, focus_key: &str) -> Result<KvBullFlow, AppError> {
    let mut cache: HashMap<String, NodeData> = HashMap::new();
    // 위로: 순환하는 `parentKey`에서 멈추려고 본 키를 기억한다
    let mut root = focus_key.to_string();
    let mut seen: HashSet<String> = HashSet::from([root.clone()]);
    for _ in 0..MAX_UP {
        load(source, &mut cache, std::slice::from_ref(&root)).await?;
        match cache[&root].parent_key.clone().filter(|p| !p.is_empty()) {
            Some(parent) if seen.insert(parent.clone()) => root = parent,
            _ => break,
        }
    }
    // 아래로: 너비 우선
    let mut order = vec![root.clone()];
    let mut members: HashSet<String> = HashSet::from([root.clone()]);
    let mut edges: Vec<KvBullFlowEdge> = Vec::new();
    let mut edge_seen: HashSet<(String, String)> = HashSet::new();
    let mut truncated = false;
    let mut frontier = vec![root.clone()];
    while !frontier.is_empty() {
        load(source, &mut cache, &frontier).await?;
        let mut next = Vec::new();
        for key in &frontier {
            let data = &cache[key];
            let groups = [(&data.pending, KvBullEdgeStatus::Pending), (&data.done, KvBullEdgeStatus::Done), (&data.failed, KvBullEdgeStatus::Failed), (&data.ignored, KvBullEdgeStatus::Ignored)];
            for (children, status) in groups {
                for child in children {
                    if !members.contains(child) {
                        if order.len() >= MAX_NODES {
                            truncated = true;
                            continue;
                        }
                        members.insert(child.clone());
                        order.push(child.clone());
                        next.push(child.clone());
                    }
                    if edge_seen.insert((key.clone(), child.clone())) {
                        edges.push(KvBullFlowEdge { parent: key.clone(), child: child.clone(), status });
                    }
                }
            }
        }
        frontier = next;
    }
    // 연 작업이 부모의 목록에 없어도(이미 지워진 목록 …) 그래프에는 있어야 한다
    if !members.contains(focus_key) {
        load(source, &mut cache, &[focus_key.to_string()]).await?;
        let data = &cache[focus_key];
        if let Some(parent) = data.parent_key.as_ref().filter(|p| members.contains(*p)) {
            let status = match data.state {
                KvBullFlowState::Completed => KvBullEdgeStatus::Done,
                KvBullFlowState::Failed => KvBullEdgeStatus::Failed,
                _ => KvBullEdgeStatus::Pending,
            };
            edges.push(KvBullFlowEdge { parent: parent.clone(), child: focus_key.to_string(), status });
        }
        order.push(focus_key.to_string());
    }
    let nodes = order.iter().map(|key| node_of(key, prefix, &cache[key])).collect();
    Ok(KvBullFlow { root, focus: focus_key.to_string(), nodes, edges, truncated })
}

/// 상태를 알아보는 방법
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    /// 정렬 셋의 ZSCORE
    ZScore,
    /// 옛 Bull의 `completed`·`failed`: 셋(오래된 판)이면 SISMEMBER, 정렬 셋(Bull 3)이면 ZSCORE
    SIsMember,
    /// 리스트의 LPOS
    LPos,
}

/// 상태를 찾는 순서와 방법: 정렬 셋들(끝난 것부터), 그다음 리스트들. 옛 Bull은 `priority`를 쓰고 `completed`·`failed`는 키 종류에 따라 셋 또는 정렬 셋이다.
pub fn state_plan(flavor: KvBullFlavor) -> Vec<(KvBullState, Probe)> {
    let finished = if flavor == KvBullFlavor::Bull { Probe::SIsMember } else { Probe::ZScore };
    vec![
        (KvBullState::Completed, finished),
        (KvBullState::Failed, finished),
        (KvBullState::Delayed, Probe::ZScore),
        (KvBullState::Prioritized, Probe::ZScore),
        (KvBullState::WaitingChildren, Probe::ZScore),
        (KvBullState::Wait, Probe::LPos),
        (KvBullState::Active, Probe::LPos),
        (KvBullState::Paused, Probe::LPos),
    ]
}

async fn lookup_state(conn: &Connected, prefix: &str, queue: &str, id: &str, flavor: KvBullFlavor) -> Result<KvBullFlowState, AppError> {
    for (state, probe) in state_plan(flavor) {
        let key = queue_key(prefix, queue, state_suffix(state, flavor));
        let found = match probe {
            Probe::ZScore => float(&conn.data(cmd("ZSCORE").arg(key.as_str()).arg(id)).await?).is_some(),
            Probe::SIsMember if is_set(conn, &key).await? => int(&conn.data(cmd("SISMEMBER").arg(key.as_str()).arg(id)).await?) == Some(1),
            Probe::SIsMember => float(&conn.data(cmd("ZSCORE").arg(key.as_str()).arg(id)).await?).is_some(),
            Probe::LPos => int(&conn.data(cmd("LPOS").arg(key.as_str()).arg(id)).await?).is_some(),
        };
        if found {
            return Ok(state.into());
        }
    }
    Ok(KvBullFlowState::Unknown)
}

/// 연결로 읽는 `FlowSource`. 큐의 종류(BullMQ·옛 Bull)는 큐마다 한 번만 읽는다
pub struct JobSource<'a> {
    pub conn: &'a Connected,
    pub prefix: &'a str,
    flavors: Mutex<HashMap<(String, String), KvBullFlavor>>,
}

impl<'a> JobSource<'a> {
    pub fn new(conn: &'a Connected, prefix: &'a str) -> JobSource<'a> {
        JobSource { conn, prefix, flavors: Mutex::new(HashMap::new()) }
    }

    async fn flavor(&self, prefix: &str, queue: &str) -> Result<KvBullFlavor, AppError> {
        let key = (prefix.to_string(), queue.to_string());
        if let Some(flavor) = self.flavors.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
            return Ok(*flavor);
        }
        let (flavor, _, _) = flavor_of(self.conn, prefix, queue).await?;
        self.flavors.lock().unwrap_or_else(|e| e.into_inner()).insert(key, flavor);
        Ok(flavor)
    }
}

#[async_trait]
impl FlowSource for JobSource<'_> {
    async fn node(&self, key: &str) -> Result<NodeData, AppError> {
        let Some((prefix, queue, id)) = split_job_key(key, self.prefix) else { return Ok(NodeData::missing()) };
        let fields = hmget(self.conn, key, &["name", "timestamp", "finishedOn", "failedReason", "parentKey", "parent"]).await?;
        if fields.iter().all(Option::is_none) {
            return Ok(NodeData::missing());
        }
        let flavor = self.flavor(&prefix, &queue).await?;
        let conn = self.conn;
        let (state, pending, processed, failed, ignored) = futures::future::try_join5(
            lookup_state(conn, &prefix, &queue, &id, flavor),
            sscan_limited(conn, &format!("{key}:dependencies"), CHILDREN),
            hscan_limited(conn, &format!("{key}:processed"), CHILDREN),
            hscan_limited(conn, &format!("{key}:failed"), CHILDREN),
            zrange_ids(conn, &format!("{key}:unsuccessful"), 0, CHILDREN as i64 - 1, false),
        )
        .await?;
        let parent = stats::parent_of(fields[5].as_deref(), fields[4].as_deref()).map(|p| format!("{}:{}", p.queue_key, p.id));
        let number = |at: usize| fields[at].as_deref().and_then(|v| v.trim().parse().ok());
        Ok(NodeData {
            name: fields[0].clone().unwrap_or_default(),
            state,
            timestamp: number(1),
            finished_on: number(2),
            failed_reason: fields[3].clone().filter(|r| !r.is_empty()),
            parent_key: parent,
            pending,
            done: processed.into_iter().map(|(k, _)| k).collect(),
            failed: failed.into_iter().map(|(k, _)| k).collect(),
            ignored,
        })
    }
}

/// 작업의 흐름 그래프
pub async fn flow(conn: &Connected, prefix: &str, queue: &str, id: &str) -> Result<KvBullFlow, AppError> {
    let source = JobSource::new(conn, prefix);
    let focus = super::keys::job_key(prefix, queue, id);
    let flow = walk(&source, prefix, &focus).await?;
    if flow.nodes.iter().any(|n| n.key == focus && n.state == KvBullFlowState::Missing) && flow.nodes.len() == 1 {
        return Err(AppError::other(format!("작업을 찾지 못했어요: {id}")));
    }
    Ok(flow)
}

#[cfg(test)]
mod tests;
