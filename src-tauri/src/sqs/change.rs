//! 큐 변경의 미리 보기와 적용. 미리 보기(`preview`)는 읽어 온 사실(`Facts`)만으로 계산하는 순수 함수라서 규칙을 고정 입력으로 시험한다.
//! 적용은 미리 보기를 다시 계산해 막힘이 있으면 거부하고, 확인 이름이 규칙과 다르면 거부한 뒤에야 AWS를 부른다.

use std::collections::{BTreeMap, HashMap};
use std::time::{SystemTime, UNIX_EPOCH};

use aws_config::SdkConfig;
use aws_sdk_sqs::primitives::Blob;
use aws_sdk_sqs::types::{DeleteMessageBatchRequestEntry, MessageAttributeValue, SendMessageBatchRequestEntry};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;

use super::peek::{self, Held, Peek, PeekStore, SessionFacts};
use super::read::{self, name_of_arn, url_from_arn};
use super::{activity, flow, SqsApplyResult, SqsCall, SqsChange, SqsDiff, SqsItemResult, SqsMoveTask, SqsPreview, SqsQueue, WarnLevel, Warning};
use crate::error::{from_sdk, AppError};
use crate::iam::commit::new_log_id;

/// 한 번에 보내거나 지우는 메시지 수(SQS 배치 한도)
const BATCH: usize = 10;
/// `SendMessageBatch`의 중복 제거 ID 한도(글자)
const DEDUP_ID_MAX: usize = 128;
/// 이동 작업의 초당 메시지 수 한도
const MAX_PER_SECOND: i64 = 500;
const RESEND_PARTIAL: &str = "보냈지만 DLQ에서 지우지 못했어요. 중복될 수 있어요";
const EXPIRED: &str = "보류 시간이 지나 엿보기 세션이 끝났어요. 메시지를 다시 받아 주세요";
const MISSING: &str = "엿보기 세션을 찾을 수 없어요. 메시지를 다시 받아 주세요";

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// 이름 입력이 필요한 변경인가: 큐 비우기, 그리고 이름에 `prod`/`prd`(대소문자 무시, 단어 경계 아님)가 든 큐의 모든 변경
pub fn confirm_name(change: &SqsChange, queue_name: &str) -> Option<String> {
    let lower = queue_name.to_ascii_lowercase();
    (matches!(change, SqsChange::Purge) || lower.contains("prod") || lower.contains("prd")).then(|| queue_name.to_string())
}

/// 재전송할 때 FIFO 대상에 쓰는 새 중복 제거 ID: `<원래 messageId>-<지금 ms>`의 앞 128자
pub fn dedup_id(message_id: &str, now_ms: i64) -> String {
    format!("{message_id}-{now_ms}").chars().take(DEDUP_ID_MAX).collect()
}

/// 받아 가는 소비자가 보이지 않는가: Enabled ESM도 실행 중 Pipe도 없고 최근 15분 받은 메시지가 0이다
pub fn no_visible_consumer(esm_enabled: bool, pipe_running: bool, received15m: Option<f64>) -> bool {
    !esm_enabled && !pipe_running && received15m == Some(0.0)
}

/// 이동 작업의 대상 큐에서 읽은 사실
#[derive(Debug, Clone, PartialEq)]
pub struct Destination {
    pub name: String,
    pub visible: Option<i64>,
    pub no_consumer: bool,
    /// 큐를 읽지 못했다
    pub unreadable: bool,
}

/// 미리 보기가 쓰는 읽어 온 사실
pub struct Facts {
    pub queue: SqsQueue,
    /// receive의 엿보기 가능 조건 결과
    pub peek_gate: Result<(), String>,
    pub tasks: Vec<SqsMoveTask>,
    pub destinations: Vec<Destination>,
    pub session: SessionFacts,
    pub resend_destination: Option<SqsQueue>,
}

fn call(api: &str, params: &[(&str, String)]) -> SqsCall {
    SqsCall { api: api.into(), params: params.iter().map(|(k, v)| (k.to_string(), v.clone())).collect::<BTreeMap<_, _>>() }
}

fn warning(level: WarnLevel, message: impl Into<String>) -> Warning {
    Warning { level, message: message.into() }
}

fn block(message: impl Into<String>) -> Warning {
    warning(WarnLevel::Block, message)
}

/// 미리 볼 때 큐의 `LastModifiedTimestamp`(초) 문자열
fn version_of(q: &SqsQueue) -> Option<String> {
    q.modified_at.map(|ms| (ms / 1000).to_string())
}

fn blank_preview(title: String, q: &SqsQueue, change: &SqsChange) -> SqsPreview {
    SqsPreview { title, calls: vec![], diff: vec![], impact: vec![], warnings: vec![], confirm_name: confirm_name(change, &q.name), expected_version: version_of(q) }
}

fn ensure_ids(ids: &[String]) -> Result<(), AppError> {
    if ids.is_empty() {
        return Err(AppError::other("메시지를 하나 이상 골라 주세요"));
    }
    Ok(())
}

/// 미리 보기. 막힘은 `warnings`의 `block`이고, 요청이 올바르지 않으면(범위 밖 값, 빈 선택) 오류다.
pub fn preview(change: &SqsChange, f: &Facts) -> Result<SqsPreview, AppError> {
    let q = &f.queue;
    match change {
        SqsChange::Receive { max, hold_secs } => {
            peek::validate(*max, *hold_secs)?;
            let mut p = blank_preview(format!("`{}`에서 메시지 최대 {max}개 받아 보기 (보류 {hold_secs}초)", q.name), q, change);
            p.calls.push(call(
                "sqs:ReceiveMessage",
                &[
                    ("QueueUrl", q.url.clone()),
                    ("MaxNumberOfMessages", "10".into()),
                    ("VisibilityTimeout", hold_secs.to_string()),
                    ("WaitTimeSeconds", "1".into()),
                    ("MessageSystemAttributeNames", "All".into()),
                    ("MessageAttributeNames", "All".into()),
                ],
            ));
            p.impact.push(format!("최대 {max}개가 찰 때까지 되풀이해서 받아요. 새 메시지가 없는 응답이 두 번 이어지면 멈춰요"));
            p.impact.push("받은 메시지는 보류 시간 동안 소비자에게서 숨겨져요".into());
            p.impact.push("받은 메시지의 수신 횟수가 1 늘어요".into());
            if let Some(r) = &q.redrive {
                p.impact.push(format!("이미 maxReceiveCount({})에 닿은 메시지는 이 수신에서 DLQ로 옮겨질 수 있어요", r.max_receive_count));
            }
            if q.fifo {
                p.warnings.push(warning(WarnLevel::Warn, "보류 시간 동안 받은 메시지의 그룹이 멈춰요"));
            }
            if let Err(reason) = &f.peek_gate {
                p.warnings.push(block(reason.clone()));
            }
            Ok(p)
        }
        SqsChange::MoveTask { destination_arn, max_per_second } => {
            if let Some(n) = max_per_second {
                if !(1..=MAX_PER_SECOND).contains(n) {
                    return Err(AppError::other(format!("초당 개수는 1~{MAX_PER_SECOND}개여야 해요")));
                }
            }
            let mut p = blank_preview(format!("DLQ `{}`의 메시지 전체 재처리", q.name), q, change);
            let mut params = vec![("SourceArn", q.arn.clone())];
            if let Some(d) = destination_arn {
                params.push(("DestinationArn", d.clone()));
            }
            if let Some(n) = max_per_second {
                params.push(("MaxNumberOfMessagesPerSecond", n.to_string()));
            }
            p.calls.push(call("sqs:StartMessageMoveTask", &params));
            if !q.is_dlq {
                p.warnings.push(block("DLQ가 아닌 큐에서는 이동 작업을 시작할 수 없어요"));
            }
            if f.tasks.iter().any(|t| matches!(t.status.as_str(), "RUNNING" | "CANCELLING")) {
                p.warnings.push(block("이 큐에서 이미 이동 작업이 진행 중이에요. 끝나거나 중단된 뒤에 시작할 수 있어요"));
            }
            if q.is_dlq && q.visible == 0 {
                p.warnings.push(block("옮길 메시지가 없어요"));
            }
            match destination_arn {
                Some(d) => p.impact.push(format!("보이는 메시지 약 {}개를 `{}`로 옮겨요", q.visible, name_of_arn(d))),
                None => {
                    let sources: Vec<String> = q.sources.iter().map(|s| format!("`{}`", name_of_arn(s))).collect();
                    p.impact.push(format!("메시지마다 원래 원본 큐로 돌아가요: {}", sources.join(", ")));
                }
            }
            if let Some(n) = max_per_second {
                p.impact.push(format!("초당 최대 {n}개씩 옮겨요"));
            }
            p.impact.push("옮긴 메시지는 대상 큐의 소비자가 다시 처리해요".into());
            for d in &f.destinations {
                if d.unreadable {
                    p.warnings.push(warning(WarnLevel::Warn, format!("대상 큐 `{}`를 읽지 못했어요. 소비자와 쌓인 메시지를 확인하지 못했어요", d.name)));
                    continue;
                }
                if d.no_consumer {
                    p.warnings.push(warning(WarnLevel::Warn, format!("대상 큐 `{}`에서 받아 가는 소비자가 보이지 않아요", d.name)));
                }
                if d.visible.is_some_and(|v| v > 0) {
                    p.warnings.push(warning(WarnLevel::Warn, format!("대상 큐 `{}`에 이미 {}개가 쌓여 있어요", d.name, d.visible.unwrap_or_default())));
                }
            }
            Ok(p)
        }
        SqsChange::CancelMoveTask { task_handle } => {
            let mut p = blank_preview(format!("`{}`의 이동 작업 중단", q.name), q, change);
            p.calls.push(call("sqs:CancelMessageMoveTask", &[("TaskHandle", task_handle.clone())]));
            match f.tasks.iter().find(|t| t.task_handle.as_deref() == Some(task_handle)) {
                None => p.warnings.push(block("그 이동 작업을 찾지 못했어요")),
                Some(t) => {
                    if t.status != "RUNNING" {
                        p.warnings.push(block("진행 중인 작업이 아니에요. 이미 끝났거나 중단됐어요"));
                    }
                    p.impact.push(format!("이미 옮긴 {}개는 돌아오지 않아요", t.moved));
                }
            }
            Ok(p)
        }
        SqsChange::Resend { message_ids, destination_url, edits, .. } => {
            ensure_ids(message_ids)?;
            let dest = f.resend_destination.as_ref();
            let dest_name = dest.map(|d| d.name.clone()).unwrap_or_else(|| destination_url.rsplit('/').next().unwrap_or_default().to_string());
            let mut p = blank_preview(format!("메시지 {}개를 `{}`로 다시 보내기", message_ids.len(), dest_name), q, change);
            p.calls.push(call("sqs:SendMessageBatch", &[("QueueUrl", destination_url.clone()), ("Entries", format!("{}개 ({BATCH}개씩)", message_ids.len()))]));
            p.calls.push(call("sqs:DeleteMessageBatch", &[("QueueUrl", q.url.clone()), ("Entries", format!("보내는 데 성공한 메시지만 ({BATCH}개씩)"))]));
            p.impact.push(format!("고른 메시지 {}개를 `{dest_name}`로 보내요", message_ids.len()));
            p.impact.push("보내는 데 성공한 메시지만 DLQ에서 지워요".into());
            match &f.session {
                SessionFacts::Missing => p.warnings.push(block(MISSING)),
                SessionFacts::Expired => p.warnings.push(block(EXPIRED)),
                SessionFacts::Live { messages } => {
                    let missing: Vec<&String> = message_ids.iter().filter(|id| !messages.contains_key(*id)).collect();
                    if !missing.is_empty() {
                        p.warnings.push(block(format!("세션에 없는 메시지가 있어요: {}", missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "))));
                    }
                    let stray: Vec<&String> = edits.keys().filter(|id| !message_ids.contains(*id)).collect();
                    if !stray.is_empty() {
                        p.warnings.push(block("고르지 않은 메시지의 본문을 고쳤어요"));
                    }
                    for id in message_ids {
                        let Some(m) = messages.get(id) else { continue };
                        if let Some(after) = edits.get(id).filter(|after| **after != m.body) {
                            p.diff.push(SqsDiff { label: id.clone(), before: m.body.clone(), after: after.clone() });
                        }
                    }
                    if let Some(d) = dest {
                        if d.fifo {
                            p.impact.push("대상이 FIFO라서 그룹 ID는 그대로 두고 중복 제거 ID는 새로 만들어요".into());
                            let no_group = message_ids.iter().filter(|id| messages.get(*id).is_some_and(|m| m.group_id.is_none())).count();
                            if no_group > 0 {
                                p.warnings.push(block(format!("대상이 FIFO인데 그룹 ID가 없는 메시지가 {no_group}개 있어요")));
                            }
                        }
                        let elsewhere = message_ids
                            .iter()
                            .filter_map(|id| messages.get(id))
                            .filter(|m| match &m.source_arn {
                                Some(origin) => *origin != d.arn,
                                None => !q.sources.is_empty() && !q.sources.contains(&d.arn),
                            })
                            .count();
                        if elsewhere > 0 {
                            p.warnings.push(warning(WarnLevel::Warn, format!("메시지 {elsewhere}개를 원래 원본 큐가 아닌 `{}`로 보내요", d.name)));
                        }
                    }
                }
            }
            match dest {
                None => p.warnings.push(block("대상 큐를 읽지 못했어요")),
                Some(d) if d.arn == q.arn => p.warnings.push(block("DLQ 자신으로는 다시 보낼 수 없어요")),
                Some(_) => {}
            }
            Ok(p)
        }
        SqsChange::DeleteMessages { message_ids, .. } => {
            ensure_ids(message_ids)?;
            let mut p = blank_preview(format!("`{}`에서 메시지 {}개 삭제", q.name, message_ids.len()), q, change);
            p.calls.push(call("sqs:DeleteMessageBatch", &[("QueueUrl", q.url.clone()), ("Entries", format!("{}개 ({BATCH}개씩)", message_ids.len()))]));
            p.impact.push(format!("고른 메시지 {}개를 큐에서 지워요. 되돌릴 수 없어요", message_ids.len()));
            match &f.session {
                SessionFacts::Missing => p.warnings.push(block(MISSING)),
                SessionFacts::Expired => p.warnings.push(block(EXPIRED)),
                SessionFacts::Live { messages } => {
                    let missing = message_ids.iter().filter(|id| !messages.contains_key(*id)).count();
                    if missing > 0 {
                        p.warnings.push(block(format!("세션에 없는 메시지가 {missing}개 있어요")));
                    }
                }
            }
            Ok(p)
        }
        SqsChange::Purge => {
            let mut p = blank_preview(format!("`{}` 비우기", q.name), q, change);
            p.calls.push(call("sqs:PurgeQueue", &[("QueueUrl", q.url.clone())]));
            p.impact.push(format!("보이는 메시지 {}개와 처리 중 {}개가 모두 지워져요 (합계 {}개)", q.visible, q.in_flight, q.visible + q.in_flight));
            p.warnings.push(warning(WarnLevel::Warn, "되돌릴 수 없어요. 60초에 한 번만 할 수 있어요"));
            Ok(p)
        }
    }
}

/// 막힘 경고의 문구들
pub fn blocks(p: &SqsPreview) -> Vec<&str> {
    p.warnings.iter().filter(|w| w.level == WarnLevel::Block).map(|w| w.message.as_str()).collect()
}

// ---------- 읽기 ----------

/// 큐의 메시지 이동 작업(최근 것부터)
pub async fn move_tasks(cfg: &SdkConfig, source_arn: &str) -> Result<Vec<SqsMoveTask>, AppError> {
    let client = aws_sdk_sqs::Client::new(cfg);
    let out = client.list_message_move_tasks().source_arn(source_arn).max_results(10).send().await.map_err(|e| from_sdk(e, "sqs:ListMessageMoveTasks"))?;
    Ok(out
        .results()
        .iter()
        .map(|t| SqsMoveTask {
            task_handle: t.task_handle().map(str::to_string),
            status: t.status().map(|s| s.to_string()).unwrap_or_default(),
            source_arn: t.source_arn().unwrap_or_default().to_string(),
            destination_arn: t.destination_arn().map(str::to_string),
            max_per_second: t.max_number_of_messages_per_second().map(i64::from),
            moved: t.approximate_number_of_messages_moved(),
            to_move: t.approximate_number_of_messages_to_move(),
            failure_reason: t.failure_reason().map(str::to_string),
            started_at: t.started_timestamp(),
        })
        .collect())
}

async fn destination(cfg: &SdkConfig, arn: &str, now_secs: i64) -> Destination {
    let name = name_of_arn(arn);
    let unreadable = Destination { name: name.clone(), visible: None, no_consumer: false, unreadable: true };
    let Some(url) = url_from_arn(arn) else { return unreadable };
    let Ok(q) = read::read_queue(cfg, &url, false).await else { return unreadable };
    let esm = flow::esms(cfg, arn).await.map(|l| l.iter().any(|m| peek::esm_active(&m.state)));
    let pipe = flow::pipes_from(cfg, arn).await.map(|l| l.iter().any(|p| peek::pipe_active(&p.state)));
    let received = activity::received_15m(cfg, &q.name, now_secs).await.ok().flatten();
    // 소비자를 읽지 못했으면 "없다"고 단정하지 않는다
    let no_consumer = match (esm, pipe) {
        (Ok(e), Ok(p)) => no_visible_consumer(e, p, received),
        _ => false,
    };
    Destination { name, visible: Some(q.visible), no_consumer, unreadable: false }
}

/// 이 변경의 미리 보기에 필요한 것을 읽는다
pub async fn gather(cfg: &SdkConfig, store: &PeekStore, profile: &str, region: &str, url: &str, change: &SqsChange, now_ms: i64) -> Result<Facts, AppError> {
    let queue = read::read_queue(cfg, url, false).await?;
    let now_secs = now_ms / 1000;
    let mut f = Facts { queue, peek_gate: Ok(()), tasks: vec![], destinations: vec![], session: SessionFacts::Missing, resend_destination: None };
    match change {
        SqsChange::Receive { .. } => f.peek_gate = peek::gate(cfg, &f.queue, now_secs).await,
        SqsChange::MoveTask { destination_arn, .. } => {
            if f.queue.is_dlq {
                f.tasks = move_tasks(cfg, &f.queue.arn).await?;
                let arns: Vec<String> = match destination_arn {
                    Some(d) => vec![d.clone()],
                    None => f.queue.sources.clone(),
                };
                for arn in arns {
                    f.destinations.push(destination(cfg, &arn, now_secs).await);
                }
            }
        }
        SqsChange::CancelMoveTask { .. } => f.tasks = move_tasks(cfg, &f.queue.arn).await?,
        SqsChange::Resend { peek_id, message_ids, destination_url, .. } => {
            f.session = store.facts(peek_id, profile, region, url, message_ids, now_ms);
            f.resend_destination = Some(read::read_queue(cfg, destination_url, false).await?);
        }
        SqsChange::DeleteMessages { peek_id, message_ids } => f.session = store.facts(peek_id, profile, region, url, message_ids, now_ms),
        SqsChange::Purge => {}
    }
    Ok(f)
}

pub async fn preview_change(cfg: &SdkConfig, store: &PeekStore, profile: &str, region: &str, url: &str, change: &SqsChange) -> Result<SqsPreview, AppError> {
    let facts = gather(cfg, store, profile, region, url, change, now_ms()).await?;
    preview(change, &facts)
}

// ---------- 적용 ----------

/// 적용한 결과. `count`는 기록에 남는 메시지 수
pub struct Done {
    pub result: SqsApplyResult,
    pub count: Option<i64>,
}

/// 적용 시도 하나. 관문(막힘, 확인 이름)을 못 넘으면 `apply`가 오류를 돌려주고 기록하지 않는다
pub struct Applied {
    pub queue: SqsQueue,
    pub preview: SqsPreview,
    pub outcome: Result<Done, AppError>,
}

/// 미리 보기를 다시 계산해 막힘과 확인 이름을 거르고, 통과하면 변경을 보낸다
pub async fn apply(cfg: &SdkConfig, store: &PeekStore, profile: &str, region: &str, url: &str, change: &SqsChange, typed_name: Option<&str>) -> Result<Applied, AppError> {
    let now = now_ms();
    let facts = gather(cfg, store, profile, region, url, change, now).await?;
    let preview = preview(change, &facts)?;
    let blocked = blocks(&preview);
    if !blocked.is_empty() {
        return Err(AppError::other(blocked.join(" · ")));
    }
    if let Some(required) = &preview.confirm_name {
        if typed_name != Some(required.as_str()) {
            return Err(AppError::other("확인 이름이 맞지 않아요"));
        }
    }
    let q = facts.queue.clone();
    let client = aws_sdk_sqs::Client::new(cfg);
    let outcome = match change {
        SqsChange::Receive { max, hold_secs } => do_receive(&client, store, profile, region, &q, *max, *hold_secs, now).await,
        SqsChange::MoveTask { destination_arn, max_per_second } => do_move(&client, &q, destination_arn.as_deref(), *max_per_second).await,
        SqsChange::CancelMoveTask { task_handle } => do_cancel(&client, task_handle).await,
        SqsChange::Resend { peek_id, message_ids, destination_url, edits } => {
            let dest = facts.resend_destination.as_ref().ok_or_else(|| AppError::other("대상 큐를 읽지 못했어요"))?;
            do_resend(&client, store, &q, dest, destination_url, peek_id, message_ids, edits, now).await
        }
        SqsChange::DeleteMessages { peek_id, message_ids } => do_delete(&client, store, &q, peek_id, message_ids).await,
        SqsChange::Purge => do_purge(&client, &q).await,
    };
    Ok(Applied { queue: q, preview, outcome })
}

fn done(message: impl Into<String>, count: Option<i64>, items: Vec<SqsItemResult>) -> Done {
    Done { result: SqsApplyResult { message: message.into(), peek: None, items }, count }
}

#[allow(clippy::too_many_arguments)]
async fn do_receive(client: &aws_sdk_sqs::Client, store: &PeekStore, profile: &str, region: &str, q: &SqsQueue, max: i64, hold_secs: i64, now: i64) -> Result<Done, AppError> {
    let received = peek::receive(client, &q.url, max, hold_secs).await?;
    let id = new_log_id(now as u128);
    let expires_at = now + hold_secs * 1000;
    let messages: Vec<_> = received.held.iter().map(|h| h.message.clone()).collect();
    let count = messages.len() as i64;
    let held: HashMap<String, Held> = received.held.into_iter().map(|h| (h.message.message_id.clone(), h)).collect();
    store.insert(id.clone(), Peek { profile: profile.into(), region: region.into(), url: q.url.clone(), expires_at, held }, now);
    let mut out = done(format!("메시지 {count}개를 받았어요. {hold_secs}초 동안 소비자에게서 숨겨져요"), Some(count), vec![]);
    out.result.peek = Some(super::SqsPeek { peek_id: id, queue_url: q.url.clone(), expires_at, messages, stopped_reason: received.stopped });
    Ok(out)
}

async fn do_move(client: &aws_sdk_sqs::Client, q: &SqsQueue, destination_arn: Option<&str>, max_per_second: Option<i64>) -> Result<Done, AppError> {
    client
        .start_message_move_task()
        .source_arn(&q.arn)
        .set_destination_arn(destination_arn.map(str::to_string))
        .set_max_number_of_messages_per_second(max_per_second.map(|n| n as i32))
        .send()
        .await
        .map_err(|e| from_sdk(e, "sqs:StartMessageMoveTask"))?;
    Ok(done("이동 작업을 시작했어요", Some(q.visible), vec![]))
}

async fn do_cancel(client: &aws_sdk_sqs::Client, task_handle: &str) -> Result<Done, AppError> {
    let out = client.cancel_message_move_task().task_handle(task_handle).send().await.map_err(|e| from_sdk(e, "sqs:CancelMessageMoveTask"))?;
    let moved = out.approximate_number_of_messages_moved();
    Ok(done(format!("이동 작업을 중단했어요. 이미 옮긴 {moved}개는 돌아오지 않아요"), Some(moved), vec![]))
}

async fn do_purge(client: &aws_sdk_sqs::Client, q: &SqsQueue) -> Result<Done, AppError> {
    client.purge_queue().queue_url(&q.url).send().await.map_err(|e| match e.as_service_error().is_some_and(|s| s.is_purge_queue_in_progress()) {
        true => AppError::other("60초에 한 번만 비울 수 있어요. 잠시 뒤에 다시 해 주세요"),
        false => from_sdk(e, "sqs:PurgeQueue"),
    })?;
    Ok(done("큐를 비웠어요. 반영까지 최대 60초 걸릴 수 있어요", Some(q.visible + q.in_flight), vec![]))
}

fn sdk_message_attributes(h: &Held) -> Result<HashMap<String, MessageAttributeValue>, AppError> {
    let mut out = HashMap::new();
    for a in &h.message.message_attributes {
        let mut b = MessageAttributeValue::builder().data_type(&a.data_type);
        b = if a.data_type.starts_with("Binary") {
            let bytes = STANDARD.decode(&a.value).map_err(|e| AppError::other(format!("메시지 속성 {}을 읽지 못했어요: {e}", a.name)))?;
            b.binary_value(Blob::new(bytes))
        } else {
            b.string_value(&a.value)
        };
        out.insert(a.name.clone(), b.build().map_err(|e| AppError::other(e.to_string()))?);
    }
    Ok(out)
}

fn missing_in_session() -> AppError {
    AppError::other(MISSING)
}

#[allow(clippy::too_many_arguments)]
async fn do_resend(client: &aws_sdk_sqs::Client, store: &PeekStore, q: &SqsQueue, dest: &SqsQueue, destination_url: &str, peek_id: &str, message_ids: &[String], edits: &HashMap<String, String>, now: i64) -> Result<Done, AppError> {
    let held = store.held(peek_id, message_ids).ok_or_else(missing_in_session)?;
    let mut items: Vec<SqsItemResult> = Vec::new();
    let mut handled: Vec<String> = Vec::new();
    for chunk in held.chunks(BATCH) {
        let mut entries = Vec::new();
        for (i, h) in chunk.iter().enumerate() {
            let body = edits.get(&h.message.message_id).cloned().unwrap_or_else(|| h.message.body.clone());
            let mut b = SendMessageBatchRequestEntry::builder().id(i.to_string()).message_body(body).set_message_attributes(Some(sdk_message_attributes(h)?));
            if dest.fifo {
                b = b.set_message_group_id(h.message.attributes.get("MessageGroupId").cloned()).message_deduplication_id(dedup_id(&h.message.message_id, now));
            }
            entries.push(b.build().map_err(|e| AppError::other(e.to_string()))?);
        }
        let sent = client.send_message_batch().queue_url(destination_url).set_entries(Some(entries)).send().await;
        let mut sent_ok: Vec<usize> = Vec::new();
        match sent {
            Ok(out) => {
                for s in out.successful() {
                    if let Ok(i) = s.id().parse::<usize>() {
                        sent_ok.push(i);
                    }
                }
                for f in out.failed() {
                    if let Some(h) = f.id().parse::<usize>().ok().and_then(|i| chunk.get(i)) {
                        items.push(SqsItemResult { id: h.message.message_id.clone(), ok: false, error: Some(format!("보내지 못했어요: {}", f.message().unwrap_or_else(|| f.code()))) });
                    }
                }
            }
            Err(e) => {
                let err = from_sdk(e, "sqs:SendMessageBatch").to_string();
                items.extend(chunk.iter().map(|h| SqsItemResult { id: h.message.message_id.clone(), ok: false, error: Some(format!("보내지 못했어요: {err}")) }));
            }
        }
        // 보낸 것만 DLQ에서 지운다
        let sent_held: Vec<&Held> = sent_ok.iter().filter_map(|i| chunk.get(*i)).collect();
        for (h, error) in delete_receipts(client, &q.url, &sent_held).await {
            match error {
                None => {
                    handled.push(h.message.message_id.clone());
                    items.push(SqsItemResult { id: h.message.message_id.clone(), ok: true, error: None });
                }
                Some(_) => items.push(SqsItemResult { id: h.message.message_id.clone(), ok: false, error: Some(RESEND_PARTIAL.into()) }),
            }
        }
    }
    store.forget(peek_id, &handled);
    let ok = items.iter().filter(|i| i.ok).count();
    let failed = items.len() - ok;
    let message = if failed == 0 { format!("메시지 {ok}개를 `{}`로 보내고 DLQ에서 지웠어요", dest.name) } else { format!("{ok}개 처리, {failed}개는 처리하지 못했어요. 메시지별 결과를 확인해 주세요") };
    Ok(done(message, Some(ok as i64), items))
}

/// 영수증으로 메시지를 지운다. 메시지마다 (메시지, 실패 이유)를 돌려준다
async fn delete_receipts<'a>(client: &aws_sdk_sqs::Client, url: &str, held: &[&'a Held]) -> Vec<(&'a Held, Option<String>)> {
    let mut out = Vec::new();
    for chunk in held.chunks(BATCH) {
        let entries: Result<Vec<_>, _> = chunk.iter().enumerate().map(|(i, h)| DeleteMessageBatchRequestEntry::builder().id(i.to_string()).receipt_handle(&h.receipt).build()).collect();
        let reply = match entries {
            Ok(entries) => client.delete_message_batch().queue_url(url).set_entries(Some(entries)).send().await.map_err(|e| from_sdk(e, "sqs:DeleteMessageBatch").to_string()),
            Err(e) => Err(e.to_string()),
        };
        match reply {
            Ok(r) => {
                let failed: HashMap<usize, String> = r.failed().iter().filter_map(|f| Some((f.id().parse().ok()?, f.message().unwrap_or_else(|| f.code()).to_string()))).collect();
                for (i, h) in chunk.iter().enumerate() {
                    out.push((*h, failed.get(&i).cloned()));
                }
            }
            Err(e) => out.extend(chunk.iter().map(|h| (*h, Some(e.clone())))),
        }
    }
    out
}

async fn do_delete(client: &aws_sdk_sqs::Client, store: &PeekStore, q: &SqsQueue, peek_id: &str, message_ids: &[String]) -> Result<Done, AppError> {
    let held = store.held(peek_id, message_ids).ok_or_else(missing_in_session)?;
    let refs: Vec<&Held> = held.iter().collect();
    let mut items = Vec::new();
    let mut handled = Vec::new();
    for (h, error) in delete_receipts(client, &q.url, &refs).await {
        match error {
            None => {
                handled.push(h.message.message_id.clone());
                items.push(SqsItemResult { id: h.message.message_id.clone(), ok: true, error: None });
            }
            Some(e) => items.push(SqsItemResult { id: h.message.message_id.clone(), ok: false, error: Some(format!("지우지 못했어요: {e}")) }),
        }
    }
    store.forget(peek_id, &handled);
    let ok = handled.len();
    let failed = items.len() - ok;
    let message = if failed == 0 { format!("메시지 {ok}개를 지웠어요") } else { format!("{ok}개를 지웠고 {failed}개는 지우지 못했어요. 보류 시간이 지나면 영수증이 무효가 돼요") };
    Ok(done(message, Some(ok as i64), items))
}

#[cfg(test)]
mod tests;
