//! 실제 AWS 계정 시험(모두 `#[ignore]`): `scripts/sqs-live-test.sh <프로필> <흐름 큐>`로 돌린다. 프로필은 반드시 직접 넘긴다(`MM_SQS_PROFILE`), 리전은 `MM_SQS_REGION`(기본 ap-northeast-2).
//! 흐름 큐(`MM_SQS_FLOW_QUEUE`)는 EventBridge 규칙이 보내고 Lambda가 받고 DLQ가 있는 기존 큐의 이름이다. 읽기만 한다.
//! 읽기 시험은 계정의 큐를 읽기만 한다. 쓰기 시험은 임시 큐 `mm-smoke-<yyyymmdd>-<임의>`와 `-dlq`를 만들어 쓰고 실패해도 둘 다 지운다. 기존 큐에는 쓰지 않는다.

use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aws_config::SdkConfig;
use aws_sdk_sqs::types::QueueAttributeName as A;
use futures::FutureExt;

use super::change::{self, preview_change};
use super::peek::{self, PeekStore};
use super::{activity, flow, read, FlowNodeKind, SqsChange, SqsQueue};
use crate::aws::context::AwsContext;

fn flow_queue() -> String {
    std::env::var("MM_SQS_FLOW_QUEUE").expect("MM_SQS_FLOW_QUEUE가 없어요: scripts/sqs-live-test.sh <프로필> <흐름 큐>로 돌려 주세요")
}

fn profile() -> String {
    std::env::var("MM_SQS_PROFILE").expect("MM_SQS_PROFILE가 없어요: scripts/sqs-live-test.sh <프로필>로 돌려 주세요")
}

fn region() -> String {
    std::env::var("MM_SQS_REGION").unwrap_or_else(|_| "ap-northeast-2".into())
}

async fn config() -> SdkConfig {
    AwsContext::default().config(&profile(), &region()).await.expect("자격 증명")
}

async fn overview(cfg: &SdkConfig) -> Vec<SqsQueue> {
    let list = read::list_queues(cfg).await.expect("list_queues");
    let mut queues: Vec<SqsQueue> = list.items.into_iter().map(|r| r.queue).collect();
    read::link_sources(&mut queues);
    queues
}

fn now_secs() -> i64 {
    crate::iam::clock::now_secs()
}

#[tokio::test]
#[ignore]
async fn overview_reads_every_queue_with_activity_and_health() {
    let cfg = config().await;
    let mut queues = overview(&cfg).await;
    assert!(!queues.is_empty(), "이 계정·리전에 큐가 있어야 해요");
    assert!(queues.iter().all(|q| q.error.is_none() && q.arn.starts_with("arn:aws:sqs:")), "속성을 읽지 못한 큐가 있어요");

    let names: Vec<String> = queues.iter().map(|q| q.name.clone()).collect();
    let by_name = activity::read(&cfg, &names, now_secs()).await.expect("get_metric_data");
    for q in &mut queues {
        q.activity = by_name.get(&q.name).copied();
    }
    let findings: Vec<_> = queues.iter().map(|q| super::health::health(q, &queues)).collect();
    for (q, f) in queues.iter_mut().zip(findings) {
        q.findings = f;
    }

    let dlqs = queues.iter().filter(|q| q.is_dlq).count();
    let with_metrics = queues.iter().filter(|q| q.activity.is_some_and(|a| a.received15m.is_some())).count();
    println!("큐 {}개 (DLQ {dlqs}개, 지표가 있는 큐 {with_metrics}개)", queues.len());
    for q in queues.iter().take(8) {
        println!("  {} visible={} inFlight={} delayed={} retention={} dlq={:?} activity={:?}", q.name, q.visible, q.in_flight, q.delayed, read::human_duration(q.retention), q.redrive.as_ref().map(|r| read::name_of_arn(&r.dlq_arn)), q.activity);
    }
    for q in queues.iter().filter(|q| !q.findings.is_empty()).take(8) {
        println!("  진단 {}: {:?}", q.name, q.findings.iter().map(|f| (f.id, f.level)).collect::<Vec<_>>());
    }
    assert!(dlqs > 0, "원본-DLQ 묶음이 하나는 있어야 해요");
    // 원본 큐의 RedrivePolicy 대상은 모두 목록의 DLQ로 이어진다
    for q in &queues {
        if let Some(r) = &q.redrive {
            if let Some(dlq) = queues.iter().find(|d| d.arn == r.dlq_arn) {
                assert!(dlq.sources.contains(&q.arn) && dlq.is_dlq, "{} → {}", q.name, dlq.name);
            }
        }
    }
}

#[tokio::test]
#[ignore]
async fn the_flow_queue_has_a_rule_a_lambda_and_a_dlq() {
    let cfg = config().await;
    let queues = overview(&cfg).await;
    let name = flow_queue();
    let q = queues.iter().find(|q| q.name == name).unwrap_or_else(|| panic!("{name} 큐가 없어요"));
    let q = read::read_queue(&cfg, &q.url, true).await.expect("read_queue");
    let flow = flow::read_flow(&cfg, &q, &queues, None).await;

    println!("생산자: {:?}", flow.producers.iter().map(|n| (n.kind, &n.label, &n.state, n.allowed_by_policy)).collect::<Vec<_>>());
    println!("소비자: {:?}", flow.consumers.iter().map(|n| (n.kind, &n.label, &n.state)).collect::<Vec<_>>());
    println!("DLQ: {:?}", flow.dlq.as_ref().map(|n| (&n.label, &n.detail)));
    println!("정책 문장 {}개, 진단 {:?}, gaps {:?}", flow.policy.len(), flow.findings.iter().map(|f| (f.id, f.level)).collect::<Vec<_>>(), flow.gaps);

    assert!(flow.producers.iter().any(|n| n.kind == FlowNodeKind::Rule), "EventBridge 규칙 생산자가 있어야 해요");
    assert!(flow.consumers.iter().any(|n| n.kind == FlowNodeKind::Lambda), "Lambda 소비자가 있어야 해요");
    assert!(flow.dlq.is_some(), "DLQ가 있어야 해요");
    assert!(!flow.policy.is_empty());
    assert!(!flow.iam);
    assert!(flow.gaps.is_empty(), "읽지 못한 절이 있어요: {:?}", flow.gaps);
}

#[tokio::test]
#[ignore]
async fn the_region_flow_connects_queues_to_lambdas_and_dlqs() {
    let cfg = config().await;
    let queues = overview(&cfg).await;
    let map = flow::region_flow(&cfg, &region(), &queues).await;
    println!("노드 {}개, 간선 {}개, gaps {:?}", map.nodes.len(), map.edges.len(), map.gaps);
    assert!(!map.edges.is_empty());
    assert!(map.edges.iter().any(|e| e.kind == super::FlowEdgeKind::Dlq));
    assert!(map.edges.iter().any(|e| e.kind == super::FlowEdgeKind::Esm), "SQS를 소비하는 Lambda가 있어야 해요");
    for e in &map.edges {
        assert!(map.nodes.iter().any(|n| n.id == e.from) && map.nodes.iter().any(|n| n.id == e.to), "끊어진 간선 {} → {}", e.from, e.to);
    }
}

#[tokio::test]
#[ignore]
async fn the_peekable_gate_blocks_a_consumed_queue_without_touching_it() {
    let cfg = config().await;
    let queues = overview(&cfg).await;
    let name = flow_queue();
    let q = queues.iter().find(|q| q.name == name).unwrap_or_else(|| panic!("{name} 큐가 없어요"));
    // 소비 Lambda가 붙은 큐: 읽기(ListEventSourceMappings)만으로 막힌다
    let reason = peek::gate(&cfg, q, now_secs()).await.expect_err("소비자가 있는 큐는 엿볼 수 없어야 해요");
    println!("막힌 이유: {reason}");
    assert_eq!(reason, peek::CONSUMER_BLOCKED);
}

#[tokio::test]
#[ignore]
async fn the_iam_flow_lists_principals_that_can_send_or_receive() {
    let cfg = config().await;
    let queues = overview(&cfg).await;
    let name = flow_queue();
    let q = queues.iter().find(|q| q.name == name).unwrap_or_else(|| panic!("{name} 큐가 없어요"));
    let q = read::read_queue(&cfg, &q.url, false).await.expect("read_queue");
    // 앱이 쓰는 IAM 스냅숏과 같은 것(IAM은 글로벌 서비스라 us-east-1)
    let iam_cfg = AwsContext::default().config(&profile(), crate::aws::context::GLOBAL_REGION).await.expect("iam cfg");
    let snapshot = crate::iam::fetch::fetch_snapshot(&iam_cfg).await.expect("snapshot");
    let flow = flow::read_flow(&cfg, &q, &queues, Some(Ok(std::sync::Arc::new(snapshot)))).await;
    println!("IAM 생산자 {:?}", flow.producers.iter().filter(|n| matches!(n.kind, FlowNodeKind::Principal | FlowNodeKind::ServiceAccount)).map(|n| (&n.label, &n.state)).take(10).collect::<Vec<_>>());
    println!("IAM 소비자 {:?}", flow.consumers.iter().filter(|n| matches!(n.kind, FlowNodeKind::Principal | FlowNodeKind::ServiceAccount)).map(|n| (&n.label, &n.state)).take(10).collect::<Vec<_>>());
    for (side, nodes) in [("생산자", &flow.producers), ("소비자", &flow.consumers)] {
        for n in nodes.iter().filter(|n| n.kind == FlowNodeKind::ServiceAccount) {
            println!("서비스 어카운트({side}) {} {:?} jump={:?}", n.label, n.detail.iter().map(|d| format!("{}={}", d.label, d.value)).collect::<Vec<_>>(), n.jump);
        }
    }
    println!("gaps {:?}", flow.gaps);
    assert!(flow.iam);
    assert!(flow.gaps.iter().all(|g| matches!(g.section.as_str(), "IAM" | "EKS 클러스터" | "EKS Pod Identity")), "{:?}", flow.gaps);
}

// ---------- 쓰기 시험 ----------

async fn eventually<F, Fut>(what: &str, secs: u64, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    loop {
        if check().await {
            return;
        }
        assert!(std::time::Instant::now() < deadline, "{secs}초 안에 이뤄지지 않았어요: {what}");
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn counts(client: &aws_sdk_sqs::Client, url: &str) -> (i64, i64) {
    let attrs = client.get_queue_attributes().queue_url(url).attribute_names(A::All).send().await.expect("attrs").attributes().cloned().unwrap_or_default();
    let get = |k: A| attrs.get(&k).and_then(|v| v.parse().ok()).unwrap_or(0);
    (get(A::ApproximateNumberOfMessages), get(A::ApproximateNumberOfMessagesNotVisible))
}

fn suffix() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos() ^ (d.as_secs() as u32)).unwrap_or(0);
    format!("{}-{:06x}", chrono::Utc::now().format("%Y%m%d"), nanos & 0xff_ffff)
}

/// 시험이 만든 큐를 어떤 경우에도 지운다
async fn delete_queue(client: &aws_sdk_sqs::Client, url: &str) {
    match client.delete_queue().queue_url(url).send().await {
        Ok(_) => println!("지웠어요: {url}"),
        Err(e) => println!("지우지 못했어요(직접 지워 주세요): {url}: {e}"),
    }
}

#[tokio::test]
#[ignore]
async fn dlq_workflow_on_temporary_queues() {
    assert_eq!(profile(), "personal", "쓰기 시험은 personal 프로필에서만 돌려요");
    let cfg = config().await;
    let client = aws_sdk_sqs::Client::new(&cfg);
    let name = format!("mm-smoke-{}", suffix());
    let dlq_name = format!("{name}-dlq");

    let dlq_url = client.create_queue().queue_name(&dlq_name).send().await.expect("create dlq").queue_url().expect("url").to_string();
    let mut source_url: Option<String> = None;
    let outcome = AssertUnwindSafe(scenario(&cfg, &client, &name, &dlq_name, &dlq_url, &mut source_url)).catch_unwind().await;
    if let Some(url) = &source_url {
        delete_queue(&client, url).await;
    }
    delete_queue(&client, &dlq_url).await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

async fn scenario(cfg: &SdkConfig, client: &aws_sdk_sqs::Client, name: &str, dlq_name: &str, dlq_url: &str, source_url: &mut Option<String>) {
    let region = region();
    let profile = profile();
    let store = PeekStore::default();

    // 큐 만들기: 원본은 maxReceiveCount 1로 DLQ에 이어 둔다
    let dlq_arn = read::arn_from_url(dlq_url, &region);
    let redrive = format!(r#"{{"deadLetterTargetArn":"{dlq_arn}","maxReceiveCount":"1"}}"#);
    let url = client
        .create_queue()
        .queue_name(name)
        .attributes(A::RedrivePolicy, redrive)
        .attributes(A::VisibilityTimeout, "1")
        .send()
        .await
        .expect("create source")
        .queue_url()
        .expect("url")
        .to_string();
    *source_url = Some(url.clone());

    // 메시지 3개를 보내고 한 번씩 받았다가 보이게 두면, 다음 수신에서 DLQ로 옮겨진다
    for i in 1..=3 {
        client.send_message().queue_url(&url).message_body(format!(r#"{{"order":{i},"smoke":true}}"#)).send().await.expect("send");
    }
    let mut seen = 0;
    for _ in 0..10 {
        let got = client.receive_message().queue_url(&url).max_number_of_messages(10).wait_time_seconds(1).send().await.expect("receive");
        seen += got.messages().len();
        if seen >= 3 {
            break;
        }
    }
    assert_eq!(seen, 3, "메시지 3개를 한 번씩 받아야 해요");
    tokio::time::sleep(Duration::from_secs(3)).await;
    eventually("메시지 3개가 DLQ로 옮겨짐", 120, || async {
        // 옮기는 일은 다음 수신 때 일어난다
        let _ = client.receive_message().queue_url(&url).max_number_of_messages(10).wait_time_seconds(1).send().await;
        counts(client, dlq_url).await.0 >= 3
    })
    .await;
    println!("DLQ에 3개가 쌓였어요");

    // 원본 큐 연결과 DLQ 판정(ListDeadLetterSourceQueues는 잠시 뒤에 반영된다)
    let mut dlq = read::read_queue(cfg, dlq_url, false).await.expect("read dlq");
    for _ in 0..15 {
        if dlq.is_dlq {
            break;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
        dlq = read::read_queue(cfg, dlq_url, false).await.expect("read dlq");
    }
    assert!(dlq.is_dlq && dlq.sources == vec![read::arn_from_url(&url, &region)], "{:?}", dlq.sources);
    assert!(peek::gate(cfg, &dlq, change::now_ms() / 1000).await.is_ok(), "소비자 없는 DLQ는 엿볼 수 있어야 해요");

    // 엿보기: 미리 보기 → 적용 → DLQ 메시지 3개
    let receive = SqsChange::Receive { max: 10, hold_secs: 120 };
    let p = preview_change(cfg, &store, &profile, &region, dlq_url, &receive).await.expect("preview receive");
    assert!(change::blocks(&p).is_empty(), "{:?}", p.warnings);
    assert_eq!(p.confirm_name, None);
    let applied = change::apply(cfg, &store, &profile, &region, dlq_url, &receive, None).await.expect("apply receive");
    let peeked = applied.outcome.expect("receive outcome").result.peek.expect("peek");
    assert_eq!(peeked.messages.len(), 3, "{:?}", peeked.messages);
    assert_eq!(peeked.stopped_reason, super::StoppedReason::Empty);
    assert!(peeked.messages.iter().all(|m| m.attributes.get("DeadLetterQueueSourceArn").is_some_and(|a| a.ends_with(name))));
    let mut ids: Vec<String> = peeked.messages.iter().map(|m| m.message_id.clone()).collect();
    ids.sort();
    println!("엿보기 세션 {} 메시지 {:?}", peeked.peek_id, ids);

    // 다시 보내기: 한 개를 원본으로 보내면 DLQ에서 지워지고 세션에서도 빠진다
    let resend = SqsChange::Resend { peek_id: peeked.peek_id.clone(), message_ids: vec![ids[0].clone()], destination_url: url.clone(), edits: HashMap::from([(ids[0].clone(), r#"{"order":1,"smoke":true,"edited":true}"#.to_string())]) };
    let p = preview_change(cfg, &store, &profile, &region, dlq_url, &resend).await.expect("preview resend");
    assert!(change::blocks(&p).is_empty(), "{:?}", p.warnings);
    assert_eq!(p.diff.len(), 1, "수정한 본문의 diff");
    let done = change::apply(cfg, &store, &profile, &region, dlq_url, &resend, None).await.expect("apply resend").outcome.expect("resend outcome");
    assert_eq!(done.result.items.iter().filter(|i| i.ok).count(), 1, "{:?}", done.result.items);
    eventually("원본 큐에 다시 보낸 메시지가 보임", 60, || async { counts(client, &url).await.0 >= 1 }).await;
    let resent = client.receive_message().queue_url(&url).wait_time_seconds(2).send().await.expect("receive resent");
    assert_eq!(resent.messages().first().and_then(|m| m.body()), Some(r#"{"order":1,"smoke":true,"edited":true}"#), "수정한 본문이 전달돼야 해요");
    // 세션에서 빠졌다: 같은 메시지를 다시 보내려면 막힌다
    let again = preview_change(cfg, &store, &profile, &region, dlq_url, &resend).await.expect("preview again");
    assert!(!change::blocks(&again).is_empty());

    // 삭제: 한 개
    let delete = SqsChange::DeleteMessages { peek_id: peeked.peek_id.clone(), message_ids: vec![ids[1].clone()] };
    let p = preview_change(cfg, &store, &profile, &region, dlq_url, &delete).await.expect("preview delete");
    assert!(change::blocks(&p).is_empty(), "{:?}", p.warnings);
    let done = change::apply(cfg, &store, &profile, &region, dlq_url, &delete, None).await.expect("apply delete").outcome.expect("delete outcome");
    assert!(done.result.items.iter().all(|i| i.ok), "{:?}", done.result.items);

    // 놓아주기: 남은 한 개를 바로 다시 보이게
    let session = store.take(&peeked.peek_id, &profile).expect("session");
    assert_eq!(session.held.len(), 1);
    let receipts: Vec<String> = session.held.values().map(|h| h.receipt.clone()).collect();
    peek::release_receipts(client, dlq_url, &receipts).await.expect("release");
    eventually("놓아준 메시지가 DLQ에서 다시 보임", 60, || async { counts(client, dlq_url).await.0 >= 1 }).await;

    // 비우지 않은 채 소비자 없는 원본에서 이동 작업: 남은 DLQ 메시지가 원본으로 돌아간다
    let move_all = SqsChange::MoveTask { destination_arn: None, max_per_second: Some(10) };
    // 큐 수치는 근사값이라 잠시 0으로 보일 수 있다: 미리 보기가 열릴 때까지 기다린다
    let preview_slot = std::sync::Mutex::new(None);
    eventually("이동 작업 미리 보기가 열림", 90, || async {
        let p = preview_change(cfg, &store, &profile, &region, dlq_url, &move_all).await.expect("preview move");
        let open = change::blocks(&p).is_empty();
        *preview_slot.lock().unwrap() = Some(p);
        open
    })
    .await;
    let p = preview_slot.into_inner().unwrap().unwrap();
    // 이 시험이 방금 원본에서 받았으니 최근 15분 수신 지표가 있을 수 있어서 소비자 경고는 단정하지 않는다
    println!("이동 작업 경고: {:?}", p.warnings);
    assert!(p.warnings.iter().all(|w| w.message.starts_with("대상 큐 `")), "{:?}", p.warnings);
    change::apply(cfg, &store, &profile, &region, dlq_url, &move_all, None).await.expect("apply move").outcome.expect("move outcome");
    let last = std::sync::Mutex::new(None);
    eventually("이동 작업이 끝남", 120, || async {
        let tasks = change::move_tasks(cfg, &dlq.arn).await.expect("tasks");
        let done = tasks.first().is_some_and(|t| t.status == "COMPLETED");
        *last.lock().unwrap() = tasks.first().cloned();
        done
    })
    .await;
    let last = last.into_inner().unwrap();
    println!("이동 작업: {last:?}");
    // 끝난 작업에는 핸들이 없어서(실행 중일 때만 있다) 중단할 수 없다
    let last = last.expect("task");
    assert_eq!(last.task_handle, None, "COMPLETED 작업에는 핸들이 없어요");
    let handle = "finished".to_string();
    let cancel = preview_change(cfg, &store, &profile, &region, dlq_url, &SqsChange::CancelMoveTask { task_handle: handle }).await.expect("preview cancel");
    assert!(!change::blocks(&cancel).is_empty());

    // 비우기: 이름을 입력해야 하고, 곧바로 다시 비우면 60초 제한 안내가 나온다
    let purge = SqsChange::Purge;
    let wrong = change::apply(cfg, &store, &profile, &region, &url, &purge, Some("other")).await;
    assert!(wrong.is_err(), "다른 이름으로는 비울 수 없어요");
    let ok = change::apply(cfg, &store, &profile, &region, &url, &purge, Some(name)).await.expect("apply purge").outcome.expect("purge outcome");
    println!("비우기: {}", ok.result.message);
    let second = change::apply(cfg, &store, &profile, &region, &url, &purge, Some(name)).await.expect("second purge attempt");
    match second.outcome {
        Err(e) => {
            println!("두 번째 비우기: {e}");
            assert!(e.to_string().contains("60초"), "{e}");
        }
        Ok(_) => println!("두 번째 비우기가 받아들여졌어요(AWS가 60초 제한을 걸지 않았어요)"),
    }
    let _ = dlq_name;
}
