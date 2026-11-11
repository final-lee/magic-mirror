//! 스트림 실시간 보기. 읽기만 한다: `dynamodb:DescribeTable`·`dynamodbstreams:DescribeStream`·`GetShardIterator`·`GetRecords`.
//! 세션(`streamId`)이 샤드 반복자를 들고 있고, 화면이 2초마다 `poll`을 부른다. 반복자는 소비자와 경쟁하지 않지만 샤드당 초당 읽기 한도(5회)를 나눠 쓰므로
//! 동시에 읽는 샤드는 `MAX_SHARDS`개까지다. 샤드가 닫히면 자식 샤드로 넘어간다.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use aws_config::SdkConfig;
use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_dynamodbstreams::types::{AttributeValue as StreamValue, Record as SdkRecord, Shard, ShardIteratorType};
use aws_sdk_dynamodbstreams::Client;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;

use super::attr;
use crate::error::{from_sdk, AppError};

/// 동시에 읽는 샤드 수의 상한
const MAX_SHARDS: usize = 10;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// `streamId` → 세션
pub type Sessions = Mutex<HashMap<String, Arc<Mutex<Session>>>>;

/// 읽기 세션 하나. 읽는 중인 샤드마다 다음 반복자를, 끝까지 읽은 샤드의 id를 들고 있다
pub struct Session {
    client: Client,
    arn: String,
    /// 샤드 id → 다음 `GetRecords`에 쓸 반복자
    active: HashMap<String, String>,
    /// 끝까지 읽었거나(닫힌 샤드) 시작 때 건너뛴 샤드. 다시 열지 않는다
    completed: HashSet<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Start {
    pub stream_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Poll {
    pub records: Vec<Record>,
    /// 지금 읽는 샤드 수
    pub shards: usize,
    /// 읽을 차례를 기다리는 샤드 수(동시 상한 때문)
    pub behind: usize,
}

/// 스트림 레코드 하나. 이미지는 DynamoDB JSON이고, 스트림 뷰 타입이 담지 않는 것은 None이다
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    /// `INSERT` · `MODIFY` · `REMOVE`
    pub event: String,
    /// 변경 시각(epoch 초)
    pub time: Option<i64>,
    pub keys: Option<Value>,
    pub size: Option<i64>,
    pub old_image: Option<Value>,
    pub new_image: Option<Value>,
}

/// 읽기를 시작할 자리
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartFrom {
    /// 지금부터: 닫힌 샤드는 건너뛰고 열린 샤드의 끝에서 시작한다
    Latest,
    /// 보관 중인 처음(24시간 전)부터
    TrimHorizon,
}

impl StartFrom {
    fn parse(value: &str) -> Result<StartFrom, AppError> {
        match value {
            "LATEST" => Ok(StartFrom::Latest),
            "TRIM_HORIZON" => Ok(StartFrom::TrimHorizon),
            _ => Err(AppError::other("알 수 없는 스트림 시작 위치예요")),
        }
    }

    fn iterator_type(self) -> ShardIteratorType {
        match self {
            StartFrom::Latest => ShardIteratorType::Latest,
            StartFrom::TrimHorizon => ShardIteratorType::TrimHorizon,
        }
    }
}

// 레코드 해석 ----------------------------------------------------------------------------------

/// 스트림의 속성 값을 DynamoDB 클라이언트의 속성 값으로 옮긴다(둘은 다른 크레이트의 같은 모양이다)
fn to_table_value(value: &StreamValue) -> Result<AttributeValue, AppError> {
    Ok(match value {
        StreamValue::S(v) => AttributeValue::S(v.clone()),
        StreamValue::N(v) => AttributeValue::N(v.clone()),
        StreamValue::B(v) => AttributeValue::B(v.clone()),
        StreamValue::Ss(v) => AttributeValue::Ss(v.clone()),
        StreamValue::Ns(v) => AttributeValue::Ns(v.clone()),
        StreamValue::Bs(v) => AttributeValue::Bs(v.clone()),
        StreamValue::Bool(v) => AttributeValue::Bool(*v),
        StreamValue::Null(v) => AttributeValue::Null(*v),
        StreamValue::L(items) => AttributeValue::L(items.iter().map(to_table_value).collect::<Result<_, _>>()?),
        StreamValue::M(fields) => AttributeValue::M(to_table_item(fields)?),
        _ => return Err(AppError::other("알 수 없는 스트림 속성 타입이에요")),
    })
}

fn to_table_item(fields: &HashMap<String, StreamValue>) -> Result<HashMap<String, AttributeValue>, AppError> {
    fields.iter().map(|(name, value)| Ok((name.clone(), to_table_value(value)?))).collect()
}

/// 이미지 하나를 DynamoDB JSON으로. 뷰 타입이 담지 않은 이미지는 None
fn image_json(image: Option<&HashMap<String, StreamValue>>) -> Result<Option<Value>, AppError> {
    image.map(|fields| attr::item_to_json(&to_table_item(fields)?)).transpose()
}

/// `GetRecords`의 레코드를 화면 모양으로. 변경 내용(`dynamodb`)이 없는 레코드는 건너뛴다
fn parse_record(record: &SdkRecord) -> Result<Option<Record>, AppError> {
    let Some(change) = record.dynamodb() else {
        return Ok(None);
    };
    Ok(Some(Record {
        id: record.event_id().unwrap_or_default().to_string(),
        event: record.event_name().map(|event| event.as_str()).unwrap_or_default().to_string(),
        time: change.approximate_creation_date_time().map(|time| time.secs()),
        keys: image_json(change.keys())?,
        size: change.size_bytes(),
        old_image: image_json(change.old_image())?,
        new_image: image_json(change.new_image())?,
    }))
}

// 샤드 고르기 ----------------------------------------------------------------------------------

/// 끝 시퀀스 번호가 있는(닫힌) 샤드의 id
fn closed_shard_ids(shards: &[Shard]) -> HashSet<String> {
    shards
        .iter()
        .filter(|shard| shard.sequence_number_range().and_then(|range| range.ending_sequence_number()).is_some())
        .filter_map(|shard| shard.shard_id())
        .map(str::to_string)
        .collect()
}

/// 지금 열 수 있는 샤드의 id, 설명에 나온 순서대로. 이미 읽는 중이거나 끝까지 읽은 샤드는 빼고,
/// 부모가 아직 남아 있으면(설명에 있고 끝까지 읽지 않았으면) 자식은 기다린다. 부모가 설명에서 사라졌으면(24시간이 지남) 기다리지 않는다
fn ready_shard_ids(shards: &[Shard], active: &HashMap<String, String>, completed: &HashSet<String>) -> Vec<String> {
    let listed: HashSet<&str> = shards.iter().filter_map(|shard| shard.shard_id()).collect();
    shards
        .iter()
        .filter_map(|shard| {
            let id = shard.shard_id()?;
            if active.contains_key(id) || completed.contains(id) {
                return None;
            }
            let parent_pending = shard.parent_shard_id().is_some_and(|parent| listed.contains(parent) && !completed.contains(parent));
            (!parent_pending).then(|| id.to_string())
        })
        .collect()
}

/// 읽는 중인 샤드가 `reading`개일 때 열 수 있는 만큼만 앞에서 자르고, 남은 수를 센다
fn split_by_capacity(mut ready: Vec<String>, reading: usize) -> (Vec<String>, usize) {
    let free = MAX_SHARDS.saturating_sub(reading);
    let behind = ready.len().saturating_sub(free);
    ready.truncate(free);
    (ready, behind)
}

// AWS 호출 -------------------------------------------------------------------------------------

async fn describe_shards(client: &Client, arn: &str) -> Result<Vec<Shard>, AppError> {
    let mut shards = Vec::new();
    let mut start_after = None;
    loop {
        let output = client
            .describe_stream()
            .stream_arn(arn)
            .set_exclusive_start_shard_id(start_after)
            .send()
            .await
            .map_err(|e| from_sdk(e, "dynamodbstreams:DescribeStream"))?;
        let description = output.stream_description().ok_or_else(|| AppError::other("스트림 설명이 없어요"))?;
        shards.extend_from_slice(description.shards());
        start_after = description.last_evaluated_shard_id().map(str::to_string);
        if start_after.is_none() {
            return Ok(shards);
        }
    }
}

async fn shard_iterator(client: &Client, arn: &str, shard_id: &str, kind: ShardIteratorType) -> Result<String, AppError> {
    let output = client
        .get_shard_iterator()
        .stream_arn(arn)
        .shard_id(shard_id)
        .shard_iterator_type(kind)
        .send()
        .await
        .map_err(|e| from_sdk(e, "dynamodbstreams:GetShardIterator"))?;
    output.shard_iterator().map(str::to_string).ok_or_else(|| AppError::other("샤드 반복자가 없어요"))
}

async fn latest_stream_arn(cfg: &SdkConfig, table: &str) -> Result<String, AppError> {
    let output = aws_sdk_dynamodb::Client::new(cfg).describe_table().table_name(table).send().await.map_err(|e| from_sdk(e, "dynamodb:DescribeTable"))?;
    let arn = output.table().and_then(|table| table.latest_stream_arn());
    arn.map(str::to_string).ok_or_else(|| AppError::other("테이블 스트림이 켜져 있지 않아요"))
}

impl Session {
    /// 읽는 중인 샤드마다 `GetRecords`를 한 번 부른다. 하나라도 실패하면 반복자를 하나도 옮기지 않아서, 다음에 같은 자리부터 다시 읽는다
    async fn read_records(&mut self) -> Result<Vec<Record>, AppError> {
        let mut records = Vec::new();
        let mut next_iterators = Vec::with_capacity(self.active.len());
        for (shard_id, iterator) in &self.active {
            let output = self.client.get_records().shard_iterator(iterator).send().await.map_err(|e| from_sdk(e, "dynamodbstreams:GetRecords"))?;
            for record in output.records() {
                records.extend(parse_record(record)?);
            }
            next_iterators.push((shard_id.clone(), output.next_shard_iterator().map(str::to_string)));
        }
        for (shard_id, next) in next_iterators {
            match next {
                Some(iterator) => {
                    self.active.insert(shard_id, iterator);
                }
                // 다음 반복자가 없으면 샤드가 닫히고 끝까지 읽은 것이다
                None => {
                    self.active.remove(&shard_id);
                    self.completed.insert(shard_id);
                }
            }
        }
        Ok(records)
    }

    /// 새로 열 수 있는 샤드(방금 닫힌 샤드의 자식 등)를 빈자리만큼 열고, 자리가 없어 기다리는 샤드 수를 돌려준다.
    /// 시작 뒤에 나타난 샤드는 모두 읽기 시작할 샤드의 자식이라 처음(`TRIM_HORIZON`)부터 읽는다
    async fn open_ready_shards(&mut self) -> Result<usize, AppError> {
        let shards = describe_shards(&self.client, &self.arn).await?;
        let ready = ready_shard_ids(&shards, &self.active, &self.completed);
        let (open, behind) = split_by_capacity(ready, self.active.len());
        for shard_id in open {
            let iterator = shard_iterator(&self.client, &self.arn, &shard_id, ShardIteratorType::TrimHorizon).await?;
            self.active.insert(shard_id, iterator);
        }
        Ok(behind)
    }
}

// 명령 -----------------------------------------------------------------------------------------

/// 테이블 스트림의 읽기 세션을 연다. `from`은 `LATEST`(기본) 또는 `TRIM_HORIZON`.
/// `LATEST`는 열린 샤드가 `MAX_SHARDS`개를 넘으면 시작하지 않는다: 일부만 읽으면 레코드를 놓치기 때문이다
pub async fn start(cfg: &SdkConfig, table: &str, from: &str, sessions: &Sessions) -> Result<Start, AppError> {
    let from = StartFrom::parse(from)?;
    let arn = latest_stream_arn(cfg, table).await?;
    let client = Client::new(cfg);
    let shards = describe_shards(&client, &arn).await?;
    let completed = match from {
        StartFrom::Latest => closed_shard_ids(&shards),
        StartFrom::TrimHorizon => HashSet::new(),
    };
    let ready = ready_shard_ids(&shards, &HashMap::new(), &completed);
    let (open, behind) = split_by_capacity(ready, 0);
    if from == StartFrom::Latest && behind > 0 {
        return Err(AppError::other("열린 샤드가 10개를 넘어 실시간 보기를 시작할 수 없어요"));
    }
    let mut active = HashMap::new();
    for shard_id in open {
        let iterator = shard_iterator(&client, &arn, &shard_id, from.iterator_type()).await?;
        active.insert(shard_id, iterator);
    }
    let stream_id = NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string();
    let session = Session { client, arn, active, completed };
    sessions.lock().await.insert(stream_id.clone(), Arc::new(Mutex::new(session)));
    Ok(Start { stream_id })
}

/// 읽는 샤드마다 한 번 읽고, 닫힌 샤드의 자식을 연다
pub async fn poll(id: &str, sessions: &Sessions) -> Result<Poll, AppError> {
    let session = sessions.lock().await.get(id).cloned().ok_or_else(|| AppError::other("스트림 세션이 끝났어요"))?;
    let mut session = session.lock().await;
    let records = session.read_records().await?;
    let behind = session.open_ready_shards().await?;
    Ok(Poll { records, shards: session.active.len(), behind })
}

pub async fn stop(id: &str, sessions: &Sessions) {
    sessions.lock().await.remove(id);
}

#[cfg(test)]
mod tests;
