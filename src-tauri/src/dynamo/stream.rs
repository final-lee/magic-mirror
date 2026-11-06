use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use aws_config::SdkConfig;
use aws_sdk_dynamodbstreams::{Client, types::{AttributeValue as StreamValue, Shard, ShardIteratorType}};
use aws_sdk_dynamodb::types::AttributeValue;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;
use crate::error::{AppError, from_sdk};
use super::attr;

const MAX_SHARDS: usize = 10;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
pub type Sessions = Mutex<HashMap<String, Arc<Mutex<Session>>>>;

pub struct Session {
    client: Client,
    arn: String,
    active: HashMap<String, String>,
    completed: HashSet<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Start { pub stream_id: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Poll { pub records: Vec<Record>, pub shards: usize, pub behind: usize }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String, pub event: String, pub time: Option<i64>, pub keys: Option<Value>,
    pub size: Option<i64>, pub old_image: Option<Value>, pub new_image: Option<Value>,
}

fn convert(v: &StreamValue) -> Result<AttributeValue, AppError> {
    Ok(match v {
        StreamValue::S(v) => AttributeValue::S(v.clone()), StreamValue::N(v) => AttributeValue::N(v.clone()),
        StreamValue::B(v) => AttributeValue::B(v.clone()), StreamValue::Ss(v) => AttributeValue::Ss(v.clone()),
        StreamValue::Ns(v) => AttributeValue::Ns(v.clone()), StreamValue::Bs(v) => AttributeValue::Bs(v.clone()),
        StreamValue::Bool(v) => AttributeValue::Bool(*v), StreamValue::Null(v) => AttributeValue::Null(*v),
        StreamValue::L(v) => AttributeValue::L(v.iter().map(convert).collect::<Result<_, _>>()?),
        StreamValue::M(v) => AttributeValue::M(v.iter().map(|(k,v)| Ok((k.clone(), convert(v)?))).collect::<Result<_, AppError>>()?),
        _ => return Err(AppError::other("알 수 없는 스트림 속성 타입이에요")),
    })
}
fn image(v: Option<&HashMap<String, StreamValue>>) -> Result<Option<Value>, AppError> {
    v.map(|v| { let item = v.iter().map(|(k,v)| Ok((k.clone(), convert(v)?))).collect::<Result<_, AppError>>()?; attr::item_to_json(&item) }).transpose()
}
async fn shards(client: &Client, arn: &str) -> Result<Vec<Shard>, AppError> {
    let mut result = Vec::new(); let mut next = None;
    loop {
        let output = client.describe_stream().stream_arn(arn).set_exclusive_start_shard_id(next).send().await.map_err(|e| from_sdk(e, "dynamodb:DescribeStream"))?;
        let d = output.stream_description().ok_or_else(|| AppError::other("스트림 설명이 없어요"))?;
        result.extend_from_slice(d.shards());
        next = d.last_evaluated_shard_id().map(str::to_string);
        if next.is_none() { break; }
    }
    Ok(result)
}
fn ready<'a>(shards: &'a [Shard], active: &HashMap<String, String>, completed: &HashSet<String>) -> Vec<&'a Shard> {
    let ids: HashSet<&str> = shards.iter().filter_map(|s| s.shard_id()).collect();
    shards.iter().filter(|s| s.shard_id().is_some_and(|id| !active.contains_key(id) && !completed.contains(id)) && s.parent_shard_id().is_none_or(|p| completed.contains(p) || !ids.contains(p))).collect()
}
async fn iterator(client: &Client, arn: &str, id: &str, kind: ShardIteratorType) -> Result<String, AppError> {
    client.get_shard_iterator().stream_arn(arn).shard_id(id).shard_iterator_type(kind).send().await.map_err(|e| from_sdk(e, "dynamodb:GetShardIterator"))?.shard_iterator().map(str::to_string).ok_or_else(|| AppError::other("샤드 반복자가 없어요"))
}
pub async fn start(cfg: &SdkConfig, table: &str, from: &str, sessions: &Sessions) -> Result<Start, AppError> {
    if from != "LATEST" && from != "TRIM_HORIZON" { return Err(AppError::other("알 수 없는 스트림 시작 위치예요")); }
    let table = aws_sdk_dynamodb::Client::new(cfg).describe_table().table_name(table).send().await.map_err(|e| from_sdk(e, "dynamodb:DescribeTable"))?;
    let arn = table.table().and_then(|t| t.latest_stream_arn()).ok_or_else(|| AppError::other("테이블 스트림이 켜져 있지 않아요"))?.to_string();
    let client = Client::new(cfg); let all = shards(&client, &arn).await?;
    let mut session = Session { client, arn, active: HashMap::new(), completed: HashSet::new() };
    if from == "LATEST" {
        for s in &all { if s.sequence_number_range().and_then(|r| r.ending_sequence_number()).is_some() { if let Some(id) = s.shard_id() { session.completed.insert(id.to_string()); } } }
    }
    let candidates = ready(&all, &session.active, &session.completed);
    if from == "LATEST" && candidates.len() > MAX_SHARDS { return Err(AppError::other("열린 샤드가 10개를 넘어 실시간 보기를 시작할 수 없어요")); }
    for s in candidates.into_iter().take(MAX_SHARDS) { if let Some(id) = s.shard_id() {
        let kind = if from == "LATEST" { ShardIteratorType::Latest } else { ShardIteratorType::TrimHorizon };
        let iter = iterator(&session.client, &session.arn, id, kind).await?; session.active.insert(id.to_string(), iter);
    }}
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string();
    sessions.lock().await.insert(id.clone(), Arc::new(Mutex::new(session)));
    Ok(Start { stream_id: id })
}
pub async fn poll(id: &str, sessions: &Sessions) -> Result<Poll, AppError> {
    let session = sessions.lock().await.get(id).cloned().ok_or_else(|| AppError::other("스트림 세션이 끝났어요"))?;
    let mut s = session.lock().await; let mut records = Vec::new();
    let active: Vec<_> = s.active.iter().map(|(k,v)| (k.clone(),v.clone())).collect();
    for (shard, iter) in active {
        let result = s.client.get_records().shard_iterator(iter).send().await.map_err(|e| from_sdk(e, "dynamodb:GetRecords"))?;
        for record in result.records() { if let Some(d) = record.dynamodb() {
            records.push(Record { id: record.event_id().unwrap_or_default().into(), event: record.event_name().map(|e| e.as_str()).unwrap_or_default().into(), time: d.approximate_creation_date_time().map(|t| t.secs()), keys: image(d.keys())?, size: d.size_bytes(), old_image: image(d.old_image())?, new_image: image(d.new_image())? });
        }}
        if let Some(next) = result.next_shard_iterator() { s.active.insert(shard, next.into()); } else { s.active.remove(&shard); s.completed.insert(shard); }
    }
    let all = shards(&s.client, &s.arn).await?;
    let candidates: Vec<String> = ready(&all, &s.active, &s.completed).iter().filter_map(|s| s.shard_id().map(str::to_string)).collect();
    let available = MAX_SHARDS.saturating_sub(s.active.len());
    for id in candidates.iter().take(available) { let iter = iterator(&s.client, &s.arn, id, ShardIteratorType::TrimHorizon).await?; s.active.insert(id.clone(), iter); }
    Ok(Poll { records, shards: s.active.len(), behind: candidates.len().saturating_sub(available) })
}
pub async fn stop(id: &str, sessions: &Sessions) { sessions.lock().await.remove(id); }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn children_wait_for_parent() {
        let root = Shard::builder().shard_id("a").build();
        let child = Shard::builder().shard_id("b").parent_shard_id("a").build();
        let shards = vec![root, child]; let active = HashMap::new(); let mut done = HashSet::new();
        assert_eq!(ready(&shards, &active, &done)[0].shard_id(), Some("a"));
        done.insert("a".into());
        assert_eq!(ready(&shards, &active, &done)[0].shard_id(), Some("b"));
    }
}
