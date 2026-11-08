//! 큐 목록 읽기와 속성 해석. 리소스 목록 어댑터(`adapters::sqs`)와 SQS 탭이 같은 함수를 쓴다.
//! 읽기만 한다(`sqs:ListQueues`, `GetQueueAttributes`, `ListQueueTags`, `ListDeadLetterSourceQueues`).

use std::collections::{BTreeMap, HashMap};

use aws_config::SdkConfig;
use aws_sdk_sqs::types::QueueAttributeName as A;
use serde_json::Value;

use super::{SqsQueue, SqsRedrive};
use crate::adapters::util::{last_segment, map_concurrent, region as region_of, settle, Capped};
use crate::error::{from_sdk, AppError};

/// 한 큐의 읽은 결과. `failure`가 있으면 속성을 읽지 못한 큐(수치는 0)이고, `attrs`는 비어 있다
pub struct QueueRead {
    pub queue: SqsQueue,
    pub attrs: HashMap<A, String>,
    pub failure: Option<AppError>,
}

pub struct QueueList {
    pub items: Vec<QueueRead>,
    pub truncated: bool,
}

/// 큐 URL(`https://sqs.<리전>.amazonaws.com/<계정>/<이름>`)에서 ARN을 만든다
pub fn arn_from_url(url: &str, region: &str) -> String {
    let mut parts = url.trim_end_matches('/').rsplit('/');
    let name = parts.next().unwrap_or_default();
    let account = parts.next().unwrap_or_default();
    format!("arn:aws:sqs:{region}:{account}:{name}")
}

/// 같은 계정·리전의 큐 ARN에서 URL을 만든다. 형식이 맞지 않으면 None
pub fn url_from_arn(arn: &str) -> Option<String> {
    let mut parts = arn.split(':');
    let (service, region, account, name) = (parts.nth(2)?, parts.next()?, parts.next()?, parts.next()?);
    (service == "sqs" && !name.is_empty()).then(|| format!("https://sqs.{region}.amazonaws.com/{account}/{name}"))
}

pub fn name_of_arn(arn: &str) -> String {
    last_segment(arn, ':')
}

fn int(attrs: &HashMap<A, String>, key: A) -> i64 {
    attrs.get(&key).and_then(|v| v.parse().ok()).unwrap_or(0)
}

fn text(attrs: &HashMap<A, String>, key: A) -> Option<String> {
    attrs.get(&key).filter(|v| !v.is_empty()).cloned()
}

fn secs_to_ms(attrs: &HashMap<A, String>, key: A) -> Option<i64> {
    attrs.get(&key).and_then(|v| v.parse::<i64>().ok()).map(|s| s * 1000)
}

fn redrive_of(attrs: &HashMap<A, String>) -> Option<SqsRedrive> {
    let doc: Value = serde_json::from_str(attrs.get(&A::RedrivePolicy)?).ok()?;
    let dlq_arn = doc.get("deadLetterTargetArn")?.as_str()?.to_string();
    let max = match doc.get("maxReceiveCount") {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.parse().ok(),
        _ => None,
    }
    .unwrap_or(0);
    Some(SqsRedrive { dlq_arn, max_receive_count: max })
}

/// `GetQueueAttributes(All)` 결과를 큐로 해석한다. 활동·원본 큐·진단·태그는 비어 있다
pub fn parse_queue(url: &str, attrs: &HashMap<A, String>) -> SqsQueue {
    let name = last_segment(url, '/');
    let fifo = name.ends_with(".fifo");
    SqsQueue {
        url: url.to_string(),
        arn: text(attrs, A::QueueArn).unwrap_or_default(),
        fifo,
        visible: int(attrs, A::ApproximateNumberOfMessages),
        in_flight: int(attrs, A::ApproximateNumberOfMessagesNotVisible),
        delayed: int(attrs, A::ApproximateNumberOfMessagesDelayed),
        visibility_timeout: int(attrs, A::VisibilityTimeout),
        retention: int(attrs, A::MessageRetentionPeriod),
        delay: int(attrs, A::DelaySeconds),
        max_size: int(attrs, A::MaximumMessageSize),
        wait_time: int(attrs, A::ReceiveMessageWaitTimeSeconds),
        redrive: redrive_of(attrs),
        redrive_allow: text(attrs, A::RedriveAllowPolicy),
        sse_managed: attrs.get(&A::SqsManagedSseEnabled).is_some_and(|v| v == "true"),
        kms_key: text(attrs, A::KmsMasterKeyId),
        content_dedup: fifo.then(|| attrs.get(&A::ContentBasedDeduplication).is_some_and(|v| v == "true")),
        dedup_scope: text(attrs, A::DeduplicationScope),
        throughput_limit: text(attrs, A::FifoThroughputLimit),
        policy: text(attrs, A::Policy),
        created_at: secs_to_ms(attrs, A::CreatedTimestamp),
        modified_at: secs_to_ms(attrs, A::LastModifiedTimestamp),
        sources: vec![],
        is_dlq: false,
        activity: None,
        tags: BTreeMap::new(),
        findings: vec![],
        error: None,
        name,
    }
}

/// 속성을 읽지 못한 큐: 수치는 0이고 이유를 `error`에 담는다
fn failed_queue(url: &str, region: &str, err: &AppError) -> SqsQueue {
    let mut q = parse_queue(url, &HashMap::new());
    q.arn = arn_from_url(url, region);
    q.error = Some(err.to_string());
    q
}

/// 목록의 큐들이 서로 DLQ인 관계를 이어 `sources`와 `is_dlq`를 채운다. DLQ가 목록에 없으면(다른 리전 불가라 잘린 목록일 때뿐) 건너뛴다
pub fn link_sources(queues: &mut [SqsQueue]) {
    let pairs: Vec<(String, String)> = queues.iter().filter_map(|q| q.redrive.as_ref().map(|r| (r.dlq_arn.clone(), q.arn.clone()))).collect();
    for q in queues.iter_mut() {
        q.sources = pairs.iter().filter(|(dlq, _)| *dlq == q.arn).map(|(_, source)| source.clone()).collect();
        q.is_dlq = !q.sources.is_empty();
    }
}

/// 리전의 큐를 모두 읽는다(최대 `MAX_ITEMS`개). 어댑터와 SQS 탭의 목록이 이 함수 하나를 쓴다.
/// 큐 하나의 속성 읽기가 실패해도 나머지는 돌려준다(`failure`). 전부 실패했거나 SSO 만료·요청 제한이면 오류다.
pub async fn list_queues(cfg: &SdkConfig) -> Result<QueueList, AppError> {
    let client = aws_sdk_sqs::Client::new(cfg);
    let region = region_of(cfg);
    let mut urls = Capped::new();
    let mut pages = client.list_queues().into_paginator().send();
    'pages: while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "sqs:ListQueues"))?;
        for u in page.queue_urls() {
            if !urls.push(u.clone()) {
                break 'pages;
            }
        }
    }
    let results = map_concurrent(urls.items.clone(), |url| {
        let client = client.clone();
        async move {
            client
                .get_queue_attributes()
                .queue_url(&url)
                .attribute_names(A::All)
                .send()
                .await
                .map(|res| res.attributes().cloned().unwrap_or_default())
                .map_err(|e| from_sdk(e, "sqs:GetQueueAttributes"))
        }
    })
    .await;
    let outcomes: Vec<Result<HashMap<A, String>, AppError>> = results;
    let failures: Vec<Option<AppError>> = outcomes.iter().map(|r| r.as_ref().err().cloned()).collect();
    let items = settle(outcomes, |_, _| HashMap::new())?;
    let items = items
        .into_iter()
        .zip(failures)
        .enumerate()
        .map(|(i, (attrs, failure))| {
            let url = &urls.items[i];
            let queue = match &failure {
                Some(e) => failed_queue(url, &region, e),
                None => parse_queue(url, &attrs),
            };
            QueueRead { queue, attrs, failure }
        })
        .collect();
    Ok(QueueList { items, truncated: urls.truncated })
}

/// 목록이 잘렸을 때만: 목록 안 큐의 원본 큐를 `ListDeadLetterSourceQueues`로 보완한다(목록 밖의 원본도 찾는다)
pub async fn supplement_sources(cfg: &SdkConfig, queues: &mut [SqsQueue]) {
    let region = region_of(cfg);
    let client = aws_sdk_sqs::Client::new(cfg);
    let targets: Vec<(usize, String)> = queues.iter().enumerate().filter(|(_, q)| q.error.is_none()).map(|(i, q)| (i, q.url.clone())).collect();
    let found = map_concurrent(targets, |(i, url)| {
        let client = client.clone();
        let region = region.clone();
        async move { (i, dead_letter_sources(&client, &url, &region).await.unwrap_or_default()) }
    })
    .await;
    for (i, arns) in found {
        for arn in arns {
            if !queues[i].sources.contains(&arn) {
                queues[i].sources.push(arn);
            }
        }
        queues[i].is_dlq = !queues[i].sources.is_empty();
    }
}

async fn dead_letter_sources(client: &aws_sdk_sqs::Client, url: &str, region: &str) -> Result<Vec<String>, AppError> {
    let mut out = Vec::new();
    let mut pages = client.list_dead_letter_source_queues().queue_url(url).into_paginator().send();
    while let Some(page) = pages.next().await {
        let page = page.map_err(|e| from_sdk(e, "sqs:ListDeadLetterSourceQueues"))?;
        out.extend(page.queue_urls().iter().map(|u| arn_from_url(u, region)));
    }
    Ok(out)
}

/// 큐 하나를 새로 읽는다(원본 큐 포함). `with_tags`면 태그도 읽는다
pub async fn read_queue(cfg: &SdkConfig, url: &str, with_tags: bool) -> Result<SqsQueue, AppError> {
    let client = aws_sdk_sqs::Client::new(cfg);
    let region = region_of(cfg);
    let attrs = client
        .get_queue_attributes()
        .queue_url(url)
        .attribute_names(A::All)
        .send()
        .await
        .map_err(|e| from_sdk(e, "sqs:GetQueueAttributes"))?
        .attributes()
        .cloned()
        .unwrap_or_default();
    let mut q = parse_queue(url, &attrs);
    q.sources = dead_letter_sources(&client, url, &region).await?;
    q.is_dlq = !q.sources.is_empty();
    if with_tags {
        let tags = client.list_queue_tags().queue_url(url).send().await.map_err(|e| from_sdk(e, "sqs:ListQueueTags"))?;
        q.tags = tags.tags().map(|t| t.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
    }
    Ok(q)
}

/// 사람이 읽는 기간. 가장 큰 두 단위까지(`4d`, `1d 12h`, `5m`, `90s`)
pub fn human_duration(secs: i64) -> String {
    if secs <= 0 {
        return "0s".into();
    }
    let units = [("d", 86_400), ("h", 3_600), ("m", 60), ("s", 1)];
    let mut rest = secs;
    let mut parts: Vec<String> = Vec::new();
    for (name, size) in units {
        if rest >= size && parts.len() < 2 {
            parts.push(format!("{}{name}", rest / size));
            rest %= size;
        }
    }
    parts.join(" ")
}

/// 암호화 열 값: `SSE-SQS` / `KMS` / `없음`
pub fn encryption_label(q: &SqsQueue) -> &'static str {
    if q.kms_key.is_some() {
        "KMS"
    } else if q.sse_managed {
        "SSE-SQS"
    } else {
        "없음"
    }
}

#[cfg(test)]
mod tests;
