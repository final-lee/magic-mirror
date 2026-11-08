//! 메시지 엿보기. SQS에는 부작용 없는 읽기가 없어서 `ReceiveMessage`로 받아 보류 시간 동안 들고 있고, 영수증은 이 세션(메모리)에만 둔다.
//! 본문은 디스크·캐시·기록에 남기지 않는다. 엿볼 수 있는 큐인지는 `peekable`(순수)이 정하고, 미리 보기와 적용이 모두 이 결과로 막는다.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use aws_config::SdkConfig;
use aws_sdk_sqs::types::{ChangeMessageVisibilityBatchRequestEntry, Message, MessageSystemAttributeName};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;

use super::{activity, flow, SqsMessage, SqsMessageAttribute, SqsQueue, StoppedReason};
use crate::error::{from_sdk, AppError};

pub const MAX_RECEIVE: i64 = 500;
pub const MIN_HOLD_SECS: i64 = 10;
pub const MAX_HOLD_SECS: i64 = 600;
/// `ReceiveMessage` 한 번에 받는 최대 개수(SQS 한도)
const BATCH: i64 = 10;
/// 새 메시지가 없는 응답이 이만큼 이어지면 멈춘다
const EMPTY_LIMIT: u32 = 2;

pub const CONSUMER_BLOCKED: &str = "소비자가 있는 큐는 엿볼 수 없어요. 받는 순간 소비자에게서 숨겨지고 수신 횟수가 늘어요";
const DLQ_CONSUMED: &str = "이 DLQ를 Lambda가 처리하고 있어요. 받는 순간 그 Lambda에게서 숨겨지고 수신 횟수가 늘어서 엿볼 수 없어요";
const METRIC_UNKNOWN: &str = "최근 수신 지표를 읽지 못해 소비자가 없는지 알 수 없어요";

/// 활성 상태의 이벤트 소스 매핑인가. 멈췄거나 멈추는 중·지우는 중이 아니면 소비 중으로 본다(엿보기는 막는 쪽이 안전하다)
pub fn esm_active(state: &str) -> bool {
    !matches!(state.to_ascii_lowercase().as_str(), "disabled" | "disabling" | "deleting")
}

/// 실행 중인 Pipe인가
pub fn pipe_active(state: &str) -> bool {
    matches!(state.to_ascii_uppercase().as_str(), "RUNNING" | "STARTING" | "CREATING" | "UPDATING")
}

/// 엿볼 수 있는 큐인가. DLQ는 Enabled Lambda가 붙어 있지 않으면 된다. 그 밖의 큐는 소비자(Lambda·Pipe)가 없고
/// 최근 15분에 받은 메시지가 0이어야 한다. 지표를 못 읽었으면 알 수 없어서 막는다.
pub fn peekable(q: &SqsQueue, esm_enabled: bool, pipe_running: bool, received15m: Option<f64>) -> Result<(), String> {
    if q.is_dlq {
        return if esm_enabled { Err(DLQ_CONSUMED.into()) } else { Ok(()) };
    }
    if esm_enabled || pipe_running {
        return Err(CONSUMER_BLOCKED.into());
    }
    match received15m {
        None => Err(METRIC_UNKNOWN.into()),
        Some(n) if n > 0.0 => Err(format!("최근 15분 동안 이 큐에서 메시지 {}개를 받아 간 곳이 있어요. {CONSUMER_BLOCKED}", n as i64)),
        Some(_) => Ok(()),
    }
}

/// 큐의 소비자를 읽어 `peekable`로 판정한다. 읽기가 실패하면 알 수 없어서 막고 이유를 적는다.
pub async fn gate(cfg: &SdkConfig, q: &SqsQueue, now_secs: i64) -> Result<(), String> {
    let esms = flow::esms(cfg, &q.arn).await.map_err(|e| format!("Lambda 연결을 읽지 못해 소비자가 없는지 알 수 없어요 ({e})"))?;
    let esm_enabled = esms.iter().any(|m| esm_active(&m.state));
    if q.is_dlq {
        return peekable(q, esm_enabled, false, None);
    }
    let pipes = flow::pipes_from(cfg, &q.arn).await.map_err(|e| format!("Pipe를 읽지 못해 소비자가 없는지 알 수 없어요 ({e})"))?;
    let pipe_running = pipes.iter().any(|p| pipe_active(&p.state));
    let received = activity::received_15m(cfg, &q.name, now_secs).await.ok().flatten();
    peekable(q, esm_enabled, pipe_running, received)
}

/// 받은 메시지와 그 영수증
#[derive(Debug, Clone)]
pub struct Held {
    pub receipt: String,
    pub message: SqsMessage,
}

/// 엿보기 세션 하나
#[derive(Debug, Clone)]
pub struct Peek {
    pub profile: String,
    pub region: String,
    pub url: String,
    /// 보류가 끝나는 시각(Unix ms)
    pub expires_at: i64,
    pub held: HashMap<String, Held>,
}

/// 미리 보기가 보는 세션의 모습
#[derive(Debug, Clone, PartialEq)]
pub enum SessionFacts {
    /// 없거나 다른 큐·프로필의 세션
    Missing,
    /// 보류 시간이 지났다
    Expired,
    Live { messages: HashMap<String, HeldFacts> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct HeldFacts {
    pub body: String,
    pub group_id: Option<String>,
    /// `DeadLetterQueueSourceArn`
    pub source_arn: Option<String>,
}

#[derive(Default)]
pub struct PeekStore {
    sessions: Mutex<HashMap<String, Peek>>,
}

impl PeekStore {
    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Peek>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 만료된 세션을 지운다. 새 세션을 만들 때와 놓아줄 때 부른다
    pub fn sweep(&self, now_ms: i64) {
        self.sessions().retain(|_, p| p.expires_at > now_ms);
    }

    pub fn insert(&self, id: String, peek: Peek, now_ms: i64) {
        let mut sessions = self.sessions();
        sessions.retain(|_, p| p.expires_at > now_ms);
        sessions.insert(id, peek);
    }

    /// 놓아줄 세션을 꺼낸다. 다른 프로필의 세션은 건드리지 않는다
    pub fn take(&self, id: &str, profile: &str) -> Option<Peek> {
        let mut sessions = self.sessions();
        if sessions.get(id).is_some_and(|p| p.profile == profile) {
            sessions.remove(id)
        } else {
            None
        }
    }

    /// 미리 보기용: `ids`의 본문·그룹·원본을 복사해 온다
    pub fn facts(&self, id: &str, profile: &str, region: &str, url: &str, ids: &[String], now_ms: i64) -> SessionFacts {
        let sessions = self.sessions();
        let Some(peek) = sessions.get(id).filter(|p| p.profile == profile && p.region == region && p.url == url) else {
            return SessionFacts::Missing;
        };
        if peek.expires_at <= now_ms {
            return SessionFacts::Expired;
        }
        let messages = peek
            .held
            .iter()
            .filter(|(mid, _)| ids.contains(mid))
            .map(|(mid, h)| {
                let attr = |k: &str| h.message.attributes.get(k).cloned();
                (mid.clone(), HeldFacts { body: h.message.body.clone(), group_id: attr("MessageGroupId"), source_arn: attr("DeadLetterQueueSourceArn") })
            })
            .collect();
        SessionFacts::Live { messages }
    }

    /// 적용용: `ids`의 메시지와 영수증을 복사해 온다(세션 순서가 아니라 `ids` 순서). 없는 것이 있으면 None
    pub fn held(&self, id: &str, ids: &[String]) -> Option<Vec<Held>> {
        let sessions = self.sessions();
        let peek = sessions.get(id)?;
        ids.iter().map(|mid| peek.held.get(mid).cloned()).collect()
    }

    /// 처리한 메시지를 세션에서 뺀다
    pub fn forget(&self, id: &str, ids: &[String]) {
        if let Some(peek) = self.sessions().get_mut(id) {
            for mid in ids {
                peek.held.remove(mid);
            }
        }
    }
}

fn attribute_of(name: &str, value: &aws_sdk_sqs::types::MessageAttributeValue) -> SqsMessageAttribute {
    let shown = match (value.string_value(), value.binary_value()) {
        (Some(s), _) => s.to_string(),
        (None, Some(b)) => STANDARD.encode(b.as_ref()),
        _ => String::new(),
    };
    SqsMessageAttribute { name: name.to_string(), data_type: value.data_type().to_string(), value: shown }
}

/// SDK 메시지를 화면용 메시지와 영수증으로. `MessageId`나 영수증이 없는 응답은 건너뛴다
pub fn held_of(m: &Message) -> Option<Held> {
    let id = m.message_id()?.to_string();
    let receipt = m.receipt_handle()?.to_string();
    let body = m.body().unwrap_or_default().to_string();
    let attributes = m.attributes().map(|a| a.iter().map(|(k, v)| (k.as_str().to_string(), v.clone())).collect()).unwrap_or_default();
    let mut message_attributes: Vec<SqsMessageAttribute> = m.message_attributes().map(|a| a.iter().map(|(k, v)| attribute_of(k, v)).collect()).unwrap_or_default();
    message_attributes.sort_by(|a, b| a.name.cmp(&b.name));
    let size = body.len() as i64;
    Some(Held { receipt, message: SqsMessage { message_id: id, md5: m.md5_of_body().unwrap_or_default().to_string(), body, attributes, message_attributes, size } })
}

pub fn validate(max: i64, hold_secs: i64) -> Result<(), AppError> {
    if !(1..=MAX_RECEIVE).contains(&max) {
        return Err(AppError::other(format!("받을 개수는 1~{MAX_RECEIVE}개여야 해요")));
    }
    if !(MIN_HOLD_SECS..=MAX_HOLD_SECS).contains(&hold_secs) {
        return Err(AppError::other(format!("보류 시간은 {MIN_HOLD_SECS}~{MAX_HOLD_SECS}초여야 해요")));
    }
    Ok(())
}

/// 받은 메시지들(받은 순서)과 멈춘 이유
pub struct Received {
    pub held: Vec<Held>,
    pub stopped: StoppedReason,
}

/// `max`개를 채우거나 새 메시지가 없는 응답이 두 번 이어질 때까지 받는다. `MessageId`로 중복을 거른다.
/// 도중에 실패하면 이미 받은 것은 바로 놓아주고 오류를 돌려준다.
pub async fn receive(client: &aws_sdk_sqs::Client, url: &str, max: i64, hold_secs: i64) -> Result<Received, AppError> {
    validate(max, hold_secs)?;
    let mut held: Vec<Held> = Vec::new();
    let mut empty = 0;
    loop {
        let want = (max - held.len() as i64).min(BATCH);
        let reply = client
            .receive_message()
            .queue_url(url)
            .max_number_of_messages(want as i32)
            .visibility_timeout(hold_secs as i32)
            .wait_time_seconds(1)
            .message_system_attribute_names(MessageSystemAttributeName::All)
            .message_attribute_names("All")
            .send()
            .await;
        let reply = match reply {
            Ok(r) => r,
            Err(e) => {
                let err = from_sdk(e, "sqs:ReceiveMessage");
                let receipts: Vec<String> = held.iter().map(|h| h.receipt.clone()).collect();
                let _ = release_receipts(client, url, &receipts).await;
                return Err(err);
            }
        };
        let mut fresh = 0;
        for m in reply.messages() {
            let Some(h) = held_of(m) else { continue };
            if held.iter().any(|x| x.message.message_id == h.message.message_id) {
                continue;
            }
            held.push(h);
            fresh += 1;
        }
        if held.len() as i64 >= max {
            return Ok(Received { held, stopped: StoppedReason::Max });
        }
        empty = if fresh == 0 { empty + 1 } else { 0 };
        if empty >= EMPTY_LIMIT {
            return Ok(Received { held, stopped: StoppedReason::Empty });
        }
    }
}

/// 영수증들을 10개씩 `ChangeMessageVisibilityBatch(0)`으로 바로 다시 보이게 한다. 이미 무효가 된 영수증의 실패는 무시한다
pub async fn release_receipts(client: &aws_sdk_sqs::Client, url: &str, receipts: &[String]) -> Result<(), AppError> {
    for chunk in receipts.chunks(10) {
        let entries = chunk
            .iter()
            .enumerate()
            .map(|(i, r)| ChangeMessageVisibilityBatchRequestEntry::builder().id(i.to_string()).receipt_handle(r).visibility_timeout(0).build())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::other(e.to_string()))?;
        client
            .change_message_visibility_batch()
            .queue_url(url)
            .set_entries(Some(entries))
            .send()
            .await
            .map_err(|e| from_sdk(e, "sqs:ChangeMessageVisibilityBatch"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
