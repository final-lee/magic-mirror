//! 큐 엿보기의 안전 판정과 세션. 메시지 본문은 메모리에만 둔다.
use super::{fetch, write};
use crate::error::{from_sdk, AppError};
use aws_config::SdkConfig;
use aws_smithy_types::DateTime;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeekVerdict {
    pub queue_arn: String,
    pub queue_name: String,
    pub queue_url: String,
    pub eligible: bool,
    pub dlq: bool,
    pub warning: Option<String>,
    pub reason: Option<String>,
}

pub struct Signals {
    pub subscribed: bool,
    pub subscription_dlq: bool,
    pub source_dlq: bool,
    pub has_redrive: bool,
    pub enabled_mapping: bool,
    pub received: f64,
    pub empty: f64,
    pub error: Option<String>,
}

pub fn eligibility(queue_arn: String, queue_url: String, s: Signals) -> PeekVerdict {
    let dlq = s.subscription_dlq || s.source_dlq;
    let consumer = s.enabled_mapping || s.received > 0.0 || s.empty > 0.0;
    let reason = if s.has_redrive {
        Some("큐에 RedrivePolicy가 있어 수신 횟수가 오르면 다른 큐로 이동할 수 있어요".into())
    } else if let Some(error) = s.error {
        Some(error)
    } else if !dlq && !s.subscribed {
        Some("이 주제의 구독 큐가 아니에요".into())
    } else if !dlq && consumer {
        Some("최근 소비자 활동이 있어요".into())
    } else {
        None
    };
    PeekVerdict {
        queue_name: queue_arn.rsplit(':').next().unwrap_or_default().into(),
        queue_arn,
        queue_url,
        eligible: reason.is_none(),
        dlq,
        warning: (dlq && consumer)
            .then(|| "소비자 활동이 감지됐어요. 큐 이름을 입력해 확인해 주세요".into()),
        reason,
    }
}

fn minute() -> i64 {
    chrono::Utc::now().timestamp().div_euclid(60)
}
fn prior_minutes(path: &Path, arn: &str) -> HashSet<i64> {
    crate::jsonl::read_all::<Value>(path)
        .into_iter()
        .filter(|v| {
            v.get("peek").and_then(Value::as_bool) == Some(true)
                && v.get("queueArn").and_then(Value::as_str) == Some(arn)
        })
        .filter_map(|v| v.get("minute").and_then(Value::as_i64))
        .collect()
}

async fn metrics(
    cfg: &SdkConfig,
    name: &str,
    excluded: &HashSet<i64>,
) -> Result<(f64, f64), AppError> {
    use aws_sdk_cloudwatch::types::{Dimension, Metric, MetricDataQuery, MetricStat};
    let queries: Vec<_> = ["NumberOfMessagesReceived", "NumberOfEmptyReceives"]
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let metric = Metric::builder()
                .namespace("AWS/SQS")
                .metric_name(*n)
                .dimensions(Dimension::builder().name("QueueName").value(name).build())
                .build();
            MetricDataQuery::builder()
                .id(format!("m{i}"))
                .metric_stat(
                    MetricStat::builder()
                        .metric(metric)
                        .period(60)
                        .stat("Sum")
                        .build(),
                )
                .return_data(true)
                .build()
        })
        .collect();
    let end = chrono::Utc::now().timestamp();
    let client = aws_sdk_cloudwatch::Client::new(cfg);
    let mut token = None;
    let mut sums = [0.0, 0.0];
    let mut seen = [false, false];
    loop {
        let out = client
            .get_metric_data()
            .set_metric_data_queries(Some(queries.clone()))
            .start_time(DateTime::from_secs(end - 3600))
            .end_time(DateTime::from_secs(end))
            .set_next_token(token.take())
            .send()
            .await
            .map_err(|e| from_sdk(e, "cloudwatch:GetMetricData"))?;
        for r in out.metric_data_results() {
            let Some(i) = r
                .id()
                .and_then(|id| id.strip_prefix('m'))
                .and_then(|n| n.parse::<usize>().ok())
                .filter(|i| *i < 2)
            else {
                continue;
            };
            if r.status_code().is_some_and(|s| {
                s.as_str() != "Complete"
                    && !(s.as_str() == "PartialData" && out.next_token().is_some())
            }) {
                return Err(AppError::other("지표를 모두 읽지 못했어요"));
            }
            if r.timestamps().len() != r.values().len() {
                return Err(AppError::other("지표 시각을 읽지 못했어요"));
            }
            seen[i] = true;
            for (time, value) in r.timestamps().iter().zip(r.values()) {
                if !excluded.contains(&time.secs().div_euclid(60)) {
                    sums[i] += value;
                }
            }
        }
        token = out.next_token().map(str::to_owned);
        if token.is_none() {
            break;
        }
    }
    if !seen.iter().all(|v| *v) {
        return Err(AppError::other("지표를 모두 읽지 못했어요"));
    }
    Ok((sums[0], sums[1]))
}

async fn mappings(cfg: &SdkConfig, arn: &str) -> Result<bool, AppError> {
    let client = aws_sdk_lambda::Client::new(cfg);
    let mut marker = None;
    loop {
        let out = client
            .list_event_source_mappings()
            .event_source_arn(arn)
            .set_marker(marker.take())
            .send()
            .await
            .map_err(|e| from_sdk(e, "lambda:ListEventSourceMappings"))?;
        for mapping in out.event_source_mappings() {
            match mapping.state() {
                Some("Disabled") => {}
                Some("Enabled" | "Enabling" | "Disabling") => return Ok(true),
                _ => {
                    return Err(AppError::other(
                        "Lambda 이벤트 소스 매핑 상태를 판단할 수 없어요",
                    ))
                }
            }
        }
        marker = out.next_marker().map(str::to_owned);
        if marker.is_none() {
            return Ok(false);
        }
    }
}

#[derive(Default, Clone)]
pub struct PeekState {
    inner: Arc<Inner>,
}
#[derive(Default)]
struct Inner {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    minutes: Mutex<HashMap<String, HashSet<i64>>>,
}
#[derive(Default)]
struct Session {
    stop: AtomicBool,
    done: AtomicBool,
    notify: Notify,
    cancel: Notify,
}
impl PeekState {
    pub async fn stop(&self, id: &str) {
        let session = self.inner.sessions.lock().unwrap().get(id).cloned();
        if let Some(s) = session {
            s.stop.store(true, Ordering::SeqCst);
            // 긴 폴링이나 로그 조회를 기다리지 말고 깨운다(허가를 남겨 두므로 잠들기 직전에 보내도 놓치지 않는다)
            s.cancel.notify_one();
            loop {
                let notified = s.notify.notified();
                if s.done.load(Ordering::SeqCst) {
                    break;
                }
                notified.await;
            }
            self.inner.sessions.lock().unwrap().remove(id);
        }
    }
    pub async fn stop_all(&self) {
        let ids: Vec<_> = self
            .inner
            .sessions
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        for id in ids {
            self.stop(&id).await;
        }
    }
}

pub async fn verdicts(
    cfg: &SdkConfig,
    path: &Path,
    state: &PeekState,
    _profile: &str,
    region: &str,
    account: &str,
    topic_arn: &str,
) -> Result<Vec<PeekVerdict>, AppError> {
    let topic = fetch::topic(cfg, topic_arn, account, region).await?;
    let mut queues: HashMap<String, (bool, bool)> = HashMap::new();
    for sub in &topic.subscriptions {
        if sub.protocol == "sqs" {
            queues.entry(sub.endpoint.clone()).or_default().0 = true;
        }
        if let Some(arn) = &sub.dlq_arn {
            queues.entry(arn.clone()).or_default().1 = true;
        }
    }
    let incomplete =
        !topic.errors.is_empty() || topic.subscriptions.iter().any(|s| s.error.is_some());
    let sqs = aws_sdk_sqs::Client::new(cfg);
    let mut result = Vec::new();
    for (arn, (subscribed, subscription_dlq)) in queues {
        let parts: Vec<_> = arn.splitn(6, ':').collect();
        let mut signals = Signals {
            subscribed,
            subscription_dlq,
            source_dlq: false,
            has_redrive: false,
            enabled_mapping: false,
            received: 0.0,
            empty: 0.0,
            error: incomplete.then(|| "구독 정보를 모두 읽지 못했어요".into()),
        };
        let mut url = String::new();
        if parts.len() != 6 || parts[2] != "sqs" || parts[3] != region || parts[4] != account {
            signals.error = Some("현재 계정과 리전의 큐만 읽을 수 있어요".into());
        } else {
            match sqs.get_queue_url().queue_name(parts[5]).send().await {
                Err(e) => signals.error = Some(from_sdk(e, "sqs:GetQueueUrl").to_string()),
                Ok(out) => {
                    if let Some(found) = out.queue_url() {
                        url = found.into();
                        match sqs
                            .get_queue_attributes()
                            .queue_url(&url)
                            .attribute_names(aws_sdk_sqs::types::QueueAttributeName::All)
                            .send()
                            .await
                        {
                            Err(e) => {
                                signals.error =
                                    Some(from_sdk(e, "sqs:GetQueueAttributes").to_string())
                            }
                            Ok(out) => {
                                let attrs = out.attributes();
                                if attrs
                                    .and_then(|a| {
                                        a.get(&aws_sdk_sqs::types::QueueAttributeName::QueueArn)
                                    })
                                    .map(String::as_str)
                                    != Some(arn.as_str())
                                {
                                    signals.error = Some("큐 ARN이 일치하지 않아요".into());
                                }
                                signals.has_redrive = attrs
                                    .and_then(|a| {
                                        a.get(
                                            &aws_sdk_sqs::types::QueueAttributeName::RedrivePolicy,
                                        )
                                    })
                                    .is_some_and(|v| !v.is_empty() && v != "{}");
                            }
                        }
                        match sqs
                            .list_dead_letter_source_queues()
                            .queue_url(&url)
                            .send()
                            .await
                        {
                            Ok(out) => signals.source_dlq = !out.queue_urls().is_empty(),
                            Err(e) => {
                                signals.error =
                                    Some(from_sdk(e, "sqs:ListDeadLetterSourceQueues").to_string())
                            }
                        }
                        match mappings(cfg, &arn).await {
                            Ok(v) => signals.enabled_mapping = v,
                            Err(e) => signals.error = Some(e.to_string()),
                        }
                        let mut excluded = prior_minutes(path, &arn);
                        if let Some(m) = state.inner.minutes.lock().unwrap().get(&arn) {
                            excluded.extend(m);
                        }
                        match metrics(cfg, parts[5], &excluded).await {
                            Ok((r, e)) => {
                                signals.received = r;
                                signals.empty = e;
                            }
                            Err(e) => signals.error = Some(e.to_string()),
                        }
                    } else {
                        signals.error = Some("큐 URL을 읽지 못했어요".into());
                    }
                }
            }
        }
        result.push(eligibility(arn, url, signals));
    }
    result.sort_by(|a, b| a.queue_arn.cmp(&b.queue_arn));
    Ok(result)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeekMessage {
    pub message_id: String,
    pub body: String,
    pub attributes: Value,
    pub topic_arn: Option<String>,
    pub timestamp: Option<String>,
    pub sns_message_id: Option<String>,
    pub failure_lines: Vec<String>,
}

pub fn envelope(id: &str, body: &str, attributes: Value) -> PeekMessage {
    let v = serde_json::from_str::<Value>(body)
        .ok()
        .filter(|v| v.get("Type").and_then(Value::as_str) == Some("Notification"));
    let get = |key: &str| {
        v.as_ref()
            .and_then(|v| v.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    PeekMessage {
        message_id: id.into(),
        body: get("Message").unwrap_or_else(|| body.into()),
        attributes: v
            .as_ref()
            .and_then(|v| v.get("MessageAttributes"))
            .cloned()
            .unwrap_or(attributes),
        topic_arn: get("TopicArn"),
        timestamp: get("Timestamp"),
        sns_message_id: get("MessageId"),
        failure_lines: Vec::new(),
    }
}

async fn failure_lines(
    cfg: &SdkConfig,
    region: &str,
    account: &str,
    topic: &str,
    message_id: &str,
) -> Vec<String> {
    let group = format!(
        "sns/{region}/{account}/{}/Failure",
        topic.rsplit(':').next().unwrap_or_default()
    );
    let pattern = format!(
        "{{ $.notification.messageId = {} }}",
        serde_json::to_string(message_id).unwrap_or_default()
    );
    let client = aws_sdk_cloudwatchlogs::Client::new(cfg);
    let mut token = None;
    let mut lines = Vec::new();
    loop {
        let Ok(out) = client
            .filter_log_events()
            .log_group_name(&group)
            .filter_pattern(&pattern)
            .set_next_token(token.clone())
            .send()
            .await
        else {
            break;
        };
        lines.extend(
            out.events()
                .iter()
                .filter_map(|e| e.message())
                .filter(|line| {
                    super::evidence::failure_message_id(line).as_deref() == Some(message_id)
                })
                .map(str::to_owned),
        );
        let next = out.next_token().map(str::to_owned);
        if next.is_none() || next == token {
            break;
        }
        token = next;
    }
    lines
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    session: String,
    kind: &'static str,
    message: Option<PeekMessage>,
    error: Option<String>,
}
fn emit(
    app: &AppHandle,
    id: &str,
    kind: &'static str,
    message: Option<PeekMessage>,
    error: Option<String>,
) {
    let _ = app.emit(
        "sns-peek",
        Event {
            session: id.into(),
            kind,
            message,
            error,
        },
    );
}

/// 시작 직전에 다시 계산한 판정으로 시작해도 되는지 정한다. 경고가 있으면 화면이 받은 큐 이름이 맞아야 한다
pub fn start_check(verdict: &PeekVerdict, confirmed_name: Option<&str>) -> Result<(), AppError> {
    if !verdict.eligible {
        return Err(AppError::other(
            verdict
                .reason
                .clone()
                .unwrap_or_else(|| "엿볼 수 없는 큐예요".into()),
        ));
    }
    match &verdict.warning {
        Some(warning) if confirmed_name != Some(verdict.queue_name.as_str()) => {
            Err(AppError::PeekConfirm {
                warning: warning.clone(),
                message: "큐 상태가 바뀌었어요. 경고를 확인하고 큐 이름을 입력해 주세요".into(),
            })
        }
        _ => Ok(()),
    }
}

/// 오래 걸리는 작업을 취소 신호와 겨룬다. 취소가 이기면 바로 `None`을 돌려주고, 작업은 따로 끝까지 돌게 두었다가 그 결과를 `late`가 처리한다
/// (이미 AWS가 넘긴 메시지를 기다리지 않고 바로 되돌려 놓는 데 쓴다)
async fn until_cancelled<T, F, L, LF>(cancel: &Notify, work: F, late: L) -> Option<T>
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
    L: FnOnce(T) -> LF + Send + 'static,
    LF: Future<Output = ()> + Send + 'static,
{
    let mut task = tokio::spawn(work);
    tokio::select! {
        out = &mut task => out.ok(),
        _ = cancel.notified() => { tokio::spawn(async move { if let Ok(out) = task.await { late(out).await; } }); None }
    }
}

pub async fn start(
    app: AppHandle,
    cfg: SdkConfig,
    path: PathBuf,
    state: PeekState,
    profile: String,
    region: String,
    account: String,
    topic_arn: String,
    queue_arn: String,
    follow: bool,
    confirmed_name: Option<String>,
) -> Result<String, AppError> {
    let verdict = verdicts(&cfg, &path, &state, &profile, &region, &account, &topic_arn)
        .await?
        .into_iter()
        .find(|v| v.queue_arn == queue_arn)
        .ok_or_else(|| AppError::other("큐를 찾을 수 없어요"))?;
    start_check(&verdict, confirmed_name.as_deref())?;
    let id = format!(
        "{}-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        rand::random::<u64>()
    );
    let session = Arc::new(Session::default());
    state
        .inner
        .sessions
        .lock()
        .unwrap()
        .insert(id.clone(), session.clone());
    let start = json!({"peek":true,"event":"start","profile":profile,"region":region,"topicArn":topic_arn,"queueArn":queue_arn,"minute":minute(),"at":chrono::Utc::now().to_rfc3339()});
    if let Err(e) = crate::jsonl::append(&path, &start) {
        state.inner.sessions.lock().unwrap().remove(&id);
        return Err(AppError::other(format!(
            "엿보기 기록을 저장하지 못했어요: {e}"
        )));
    }
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let client = aws_sdk_sqs::Client::new(&cfg);
        let mut handles = HashMap::new();
        let mut seen = HashSet::new();
        let key = queue_arn.clone();
        let mut recorded = HashSet::new();
        'poll: loop {
            if session.stop.load(Ordering::SeqCst) || seen.len() >= 100 {
                break;
            }
            let m = minute();
            if recorded.insert(m) {
                state
                    .inner
                    .minutes
                    .lock()
                    .unwrap()
                    .entry(key.clone())
                    .or_default()
                    .insert(m);
                let entry = json!({"peek":true,"event":"minute","profile":profile,"region":region,"queueArn":queue_arn,"minute":m});
                if let Err(e) = crate::jsonl::append(&path, &entry) {
                    emit(
                        &app,
                        &task_id,
                        "error",
                        None,
                        Some(format!("엿보기 기록을 저장하지 못했어요: {e}")),
                    );
                    break;
                }
            }
            let (poll_client, poll_url, max) = (
                client.clone(),
                verdict.queue_url.clone(),
                (100 - seen.len()).min(10) as i32,
            );
            let (late_client, late_url) = (client.clone(), verdict.queue_url.clone());
            let polled = until_cancelled(
                &session.cancel,
                async move { write::receive(&poll_client, &poll_url, follow, max).await },
                move |response| async move {
                    // 멈춘 뒤에 도착한 메시지는 다음 가시성 시간까지 숨지 않게 바로 되돌려 놓는다
                    if let Ok(messages) = response {
                        let handles: Vec<String> = messages
                            .iter()
                            .filter_map(|m| m.receipt_handle().map(str::to_owned))
                            .collect();
                        let _ = write::release(&late_client, &late_url, &handles).await;
                    }
                },
            )
            .await;
            let end_minute = minute();
            let mut log_failed = false;
            if recorded.insert(end_minute) {
                state
                    .inner
                    .minutes
                    .lock()
                    .unwrap()
                    .entry(key.clone())
                    .or_default()
                    .insert(end_minute);
                let entry = json!({"peek":true,"event":"minute","profile":profile,"region":region,"queueArn":queue_arn,"minute":end_minute});
                if let Err(e) = crate::jsonl::append(&path, &entry) {
                    emit(
                        &app,
                        &task_id,
                        "error",
                        None,
                        Some(format!("엿보기 기록을 저장하지 못했어요: {e}")),
                    );
                    log_failed = true;
                }
            }
            let Some(response) = polled else { break };
            match response {
                Err(e) => {
                    emit(&app, &task_id, "error", None, Some(e.to_string()));
                    break;
                }
                Ok(messages) => {
                    if messages.is_empty() && !follow {
                        break;
                    }
                    // 한 묶음의 핸들은 처리 도중 멈춰도 모두 되돌려 놓도록 먼저 모두 담는다
                    for m in &messages {
                        if let Some(handle) = m.receipt_handle() {
                            handles.insert(
                                m.message_id().unwrap_or(handle).to_owned(),
                                handle.to_owned(),
                            );
                        }
                    }
                    for m in messages {
                        let Some(mid) = m.message_id() else { continue };
                        if !seen.insert(mid.to_owned()) {
                            continue;
                        }
                        let attrs = m.message_attributes().into_iter().flat_map(|a| a.iter()).map(|(k,v)| {
                            use base64::Engine;
                            (k.clone(), json!({"dataType":v.data_type(),"stringValue":v.string_value(),"binaryValue":v.binary_value().map(|v| base64::engine::general_purpose::STANDARD.encode(v.as_ref()))}))
                        }).collect();
                        let mut msg =
                            envelope(mid, m.body().unwrap_or_default(), Value::Object(attrs));
                        if verdict.dlq {
                            if let Some(sns_id) = &msg.sns_message_id {
                                let lines = until_cancelled(
                                    &session.cancel,
                                    {
                                        let (cfg, region, account, topic_arn, sns_id) = (
                                            cfg.clone(),
                                            region.clone(),
                                            account.clone(),
                                            topic_arn.clone(),
                                            sns_id.clone(),
                                        );
                                        async move {
                                            failure_lines(
                                                &cfg, &region, &account, &topic_arn, &sns_id,
                                            )
                                            .await
                                        }
                                    },
                                    |_| async {},
                                )
                                .await;
                                let Some(lines) = lines else { break 'poll };
                                msg.failure_lines = lines;
                            }
                        }
                        emit(&app, &task_id, "message", Some(msg), None);
                    }
                }
            }
            if log_failed {
                break;
            }
        }
        let handles: Vec<_> = handles.into_values().collect();
        if let Err(e) = write::release(&client, &verdict.queue_url, &handles).await {
            emit(&app, &task_id, "error", None, Some(e.to_string()));
        }
        let end = json!({"peek":true,"event":"stop","profile":profile,"region":region,"topicArn":topic_arn,"queueArn":queue_arn,"at":chrono::Utc::now().to_rfc3339(),"count":seen.len()});
        if let Err(e) = crate::jsonl::append(&path, &end) {
            emit(
                &app,
                &task_id,
                "error",
                None,
                Some(format!("엿보기 기록을 저장하지 못했어요: {e}")),
            );
        }
        emit(&app, &task_id, "done", None, None);
        session.done.store(true, Ordering::SeqCst);
        session.notify.notify_waiters();
        state.inner.sessions.lock().unwrap().remove(&task_id);
    });
    Ok(id)
}

#[cfg(test)]
mod tests;
