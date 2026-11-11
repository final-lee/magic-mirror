//! 실제 계정에 시험 주제·큐를 만들고 워크스페이스의 읽기·진단·변경·되돌리기·엿보기를 차례로 돌린 뒤 지운다.
//! `scripts/sns-live-test.sh <프로필> [리전]`으로 돌린다. 평소 `cargo test`에서는 건너뛴다.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aws_config::SdkConfig;
use futures::FutureExt;
use serde_json::json;

use super::change::{self, SnsCall, SnsChangeRequest, SnsPlan};
use super::model::{SnsSubscription, SnsTopic};
use super::{account, diagnose, evidence, fetch, peek, publishers, write};
use crate::aws::context::AwsContext;

struct Live {
    cfg: SdkConfig,
    profile: String,
    region: String,
    account: String,
    log: std::path::PathBuf,
}

impl Live {
    async fn snapshot(&self, topic: &str) -> SnsTopic {
        fetch::topic(&self.cfg, topic, &self.account, &self.region)
            .await
            .expect("주제 스냅샷")
    }

    async fn report(&self, topic: &str) -> diagnose::SnsDiagnosisReport {
        let snapshot = self.snapshot(topic).await;
        let evidence = evidence::fetch(&self.cfg, &snapshot).await;
        let (found, errors) = publishers::configured(&self.cfg, topic).await;
        println!("발행자 {found:?}, 읽기 오류 {errors:?}");
        diagnose::diagnose(&snapshot, &evidence, &found)
    }

    async fn plan(&self, request: SnsChangeRequest) -> SnsPlan {
        change::plan(
            &self.cfg,
            &self.log,
            &self.profile,
            &self.region,
            &self.account,
            request,
        )
        .await
        .expect("미리보기")
    }

    /// 미리보기를 받아 적용하고, 모든 호출이 성공했는지 본다
    async fn apply(&self, request: SnsChangeRequest) -> change::SnsApplyResult {
        let plan = self.plan(request).await;
        println!("호출: {}", serde_json::to_string(&plan.calls).unwrap());
        let result = change::apply(
            &self.cfg,
            &self.log,
            &self.profile,
            &self.region,
            &self.account,
            plan,
        )
        .await
        .expect("적용");
        assert_eq!(result.error, None, "적용 실패: {result:?}");
        assert!(result.record_id.is_some(), "변경 기록이 남아야 해요");
        result
    }
}

fn check<'a>(
    report: &'a diagnose::SnsDiagnosisReport,
    subscription: &str,
    id: &str,
) -> &'a diagnose::SnsCheck {
    report
        .subscriptions
        .iter()
        .find(|d| d.subscription == subscription)
        .and_then(|d| d.checks.iter().find(|c| c.id == id))
        .unwrap_or_else(|| panic!("{subscription}의 {id} 점검이 없어요: {report:?}"))
}

fn only_subscription(topic: &SnsTopic) -> &SnsSubscription {
    assert_eq!(
        topic.subscriptions.len(),
        1,
        "구독 하나: {:?}",
        topic.subscriptions
    );
    &topic.subscriptions[0]
}

#[tokio::test]
#[ignore]
async fn workspace_against_a_real_account() {
    let profile = std::env::var("MM_SNS_PROFILE").expect("MM_SNS_PROFILE");
    let region = std::env::var("MM_SNS_REGION").unwrap_or_else(|_| "ap-northeast-2".into());
    let ctx = AwsContext::default();
    let cfg = ctx.config(&profile, &region).await.unwrap();
    let account = ctx.account_id(&profile).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let live = Live {
        cfg,
        profile,
        region,
        account,
        log: dir.path().join("sns-changes.jsonl"),
    };

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let name = format!("mm-live-{stamp}");
    let sns = aws_sdk_sns::Client::new(&live.cfg);
    let sqs = aws_sdk_sqs::Client::new(&live.cfg);
    let topic = sns
        .create_topic()
        .name(&name)
        .send()
        .await
        .unwrap()
        .topic_arn()
        .unwrap()
        .to_string();
    let queue_url = sqs
        .create_queue()
        .queue_name(format!("{name}-q"))
        .send()
        .await
        .unwrap()
        .queue_url()
        .unwrap()
        .to_string();
    let dlq_url = sqs
        .create_queue()
        .queue_name(format!("{name}-dlq"))
        .send()
        .await
        .unwrap()
        .queue_url()
        .unwrap()
        .to_string();
    let queue_arn = format!("arn:aws:sqs:{}:{}:{name}-q", live.region, live.account);
    let dlq_arn = format!("arn:aws:sqs:{}:{}:{name}-dlq", live.region, live.account);
    let fresh_url = sqs
        .create_queue()
        .queue_name(format!("{name}-new"))
        .send()
        .await
        .unwrap()
        .queue_url()
        .unwrap()
        .to_string();
    let fresh_arn = format!("arn:aws:sqs:{}:{}:{name}-new", live.region, live.account);
    println!("시험 자원: {topic}, {queue_url}, {dlq_url}, {fresh_url}");

    let scenario = async {
        // 1. 큐 정책 없이 구독을 만들면(앱 밖에서 만든 구독처럼) 진단이 큐 정책을 실패로 짚는다
        let created = write::run(
            &live.cfg,
            &SnsCall {
                api: "sns:Subscribe".into(),
                target: topic.clone(),
                body: json!({"Protocol": "sqs", "Endpoint": queue_arn}),
            },
        )
        .await
        .unwrap();
        let sub = created["subscriptionArn"].as_str().unwrap().to_string();
        let snapshot = live.snapshot(&topic).await;
        let s = only_subscription(&snapshot);
        assert_eq!(s.state, "confirmed");
        assert!(
            matches!(
                &s.target,
                Some(super::model::SnsTarget::Sqs { policy: None, .. })
            ),
            "큐 정책 없음: {:?}",
            s.target
        );
        let report = live.report(&topic).await;
        let queue_policy = check(&report, &sub, "queuePolicy");
        assert_eq!(queue_policy.status, "fail", "{queue_policy:?}");
        assert!(queue_policy.fix.is_some(), "고칠 길이 있어야 해요");

        // 2. 고치기: 큐 정책 문장을 더하면 진단이 정상으로 바뀐다
        live.apply(SnsChangeRequest::QueuePolicy {
            topic_arn: topic.clone(),
            queue_url: queue_url.clone(),
            queue_arn: queue_arn.clone(),
        })
        .await;
        assert_eq!(
            check(&live.report(&topic).await, &sub, "queuePolicy").status,
            "ok"
        );

        // 3. DLQ 붙이기(DLQ 큐 정책도 함께), 필터 정책
        live.apply(SnsChangeRequest::AddDlq {
            subscription_arn: sub.clone(),
            dlq_arn: dlq_arn.clone(),
        })
        .await;
        let filter = live
            .apply(SnsChangeRequest::FilterPolicy {
                subscription_arn: sub.clone(),
                filter_policy: Some(r#"{"event":["order.created"]}"#.into()),
                scope: "MessageAttributes".into(),
            })
            .await;
        let snapshot = live.snapshot(&topic).await;
        let s = only_subscription(&snapshot);
        assert_eq!(s.dlq_arn.as_deref(), Some(dlq_arn.as_str()));
        assert!(s.filter.is_some(), "필터 정책: {:?}", s.attributes);

        // 4. 시험 발행: 필터에 맞는 것과 안 맞는 것
        for event in ["order.created", "order.paid"] {
            let published = live
                .apply(SnsChangeRequest::Publish {
                    topic_arn: topic.clone(),
                    message: json!({"event": event}).to_string(),
                    subject: None,
                    message_structure_json: false,
                    attributes: vec![change::PublishAttribute {
                        name: "event".into(),
                        data_type: "String".into(),
                        value: event.into(),
                    }],
                    message_group_id: None,
                    deduplication_id: None,
                })
                .await;
            assert!(
                published
                    .outputs
                    .iter()
                    .any(|o| o.get("messageId").is_some()),
                "MessageId: {published:?}"
            );
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
        let received = write::receive(&sqs, &queue_url, false, 10).await.unwrap();
        let bodies: Vec<String> = received
            .iter()
            .filter_map(|m| m.body().map(String::from))
            .collect();
        println!("받은 본문: {bodies:?}");
        assert!(
            bodies.iter().any(|b| b.contains("order.created")),
            "필터에 맞는 메시지가 와야 해요"
        );
        assert!(
            !bodies.iter().any(|b| b.contains("order.paid")),
            "걸러진 메시지는 오지 않아요"
        );
        let handles: Vec<String> = received
            .iter()
            .filter_map(|m| m.receipt_handle().map(String::from))
            .collect();
        write::release(&sqs, &queue_url, &handles).await.unwrap();

        // 5. 엿보기 판정: 구독의 DLQ는 엿볼 수 있다
        let verdicts = peek::verdicts(
            &live.cfg,
            &live.log,
            &peek::PeekState::default(),
            &live.profile,
            &live.region,
            &live.account,
            &topic,
        )
        .await
        .unwrap();
        println!("엿보기 판정: {verdicts:?}");
        let dlq_verdict = verdicts
            .iter()
            .find(|v| v.queue_arn == dlq_arn)
            .expect("DLQ 판정");
        assert!(dlq_verdict.dlq && dlq_verdict.eligible, "{dlq_verdict:?}");

        // 6. 되돌리기: 필터 정책을 지운다
        live.apply(SnsChangeRequest::Undo {
            id: filter.record_id.unwrap(),
        })
        .await;
        assert!(
            only_subscription(&live.snapshot(&topic).await)
                .filter
                .is_none(),
            "필터가 없어져야 해요"
        );
        let records = change::changes(&live.log, &live.profile);
        println!("변경 기록 {}건", records.len());
        assert!(
            records.iter().any(|r| r.undone),
            "되돌린 기록이 표시돼야 해요"
        );
        let text = std::fs::read_to_string(&live.log).unwrap();
        assert!(
            !text.contains("order.created\\\"}\""),
            "발행한 본문은 기록하지 않아요"
        );

        // 7. 계정 개요와 정책 읽기
        let overview = account::overview(&live.cfg, &live.account, &live.region)
            .await
            .unwrap();
        assert!(
            serde_json::to_string(&overview).unwrap().contains(&name),
            "개요에 시험 주제가 있어야 해요"
        );
        let policy = super::access::topic_policy(&live.cfg, &topic, &live.account, &live.region)
            .await
            .unwrap();
        println!("정책: {}", serde_json::to_string(&policy).unwrap());

        // 8. 구독 해지
        live.apply(SnsChangeRequest::Unsubscribe {
            subscription_arn: sub.clone(),
        })
        .await;
        assert!(live.snapshot(&topic).await.subscriptions.is_empty());

        // 9. 앱으로 구독 만들기: 정책 없는 새 큐면 큐 정책 문장과 구독을 함께 보내고, 진단은 정상이다
        let plan = live
            .plan(SnsChangeRequest::Subscribe {
                topic_arn: topic.clone(),
                protocol: "sqs".into(),
                endpoint: fresh_arn.clone(),
                filter_policy: None,
                filter_policy_scope: None,
                raw_message_delivery: true,
                dlq_arn: None,
            })
            .await;
        let apis: Vec<&str> = plan.calls.iter().map(|c| c.api.as_str()).collect();
        assert!(
            apis.contains(&"sqs:SetQueueAttributes") && apis.contains(&"sns:Subscribe"),
            "{apis:?}"
        );
        live.apply(plan.request.clone()).await;
        let snapshot = live.snapshot(&topic).await;
        let s = only_subscription(&snapshot);
        assert!(s.raw, "raw 전달");
        let key = s.key.clone();
        assert_eq!(
            check(&live.report(&topic).await, &key, "queuePolicy").status,
            "ok"
        );
        live.apply(SnsChangeRequest::Unsubscribe {
            subscription_arn: key,
        })
        .await;
    };
    let outcome = std::panic::AssertUnwindSafe(scenario).catch_unwind().await;

    // 성공하든 실패하든 시험 자원을 지운다
    let _ = sns.delete_topic().topic_arn(&topic).send().await;
    let _ = sqs.delete_queue().queue_url(&queue_url).send().await;
    let _ = sqs.delete_queue().queue_url(&dlq_url).send().await;
    let _ = sqs.delete_queue().queue_url(&fresh_url).send().await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

async fn live_from_env() -> (Live, tempfile::TempDir) {
    let profile = std::env::var("MM_SNS_PROFILE").expect("MM_SNS_PROFILE");
    let region = std::env::var("MM_SNS_REGION").unwrap_or_else(|_| "ap-northeast-2".into());
    let ctx = AwsContext::default();
    let cfg = ctx.config(&profile, &region).await.unwrap();
    let account = ctx.account_id(&profile).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("sns-changes.jsonl");
    (
        Live {
            cfg,
            profile,
            region,
            account,
            log,
        },
        dir,
    )
}

/// 아카이브를 켠 FIFO 주제에서 이미 받은 메시지를 다시 보내고, 아카이브를 끈다
#[tokio::test]
#[ignore]
async fn fifo_replay_against_a_real_account() {
    let (live, _dir) = live_from_env().await;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let name = format!("mm-live-{stamp}-replay");
    let sns = aws_sdk_sns::Client::new(&live.cfg);
    let sqs = aws_sdk_sqs::Client::new(&live.cfg);
    let topic = sns
        .create_topic()
        .name(format!("{name}.fifo"))
        .attributes("FifoTopic", "true")
        .attributes("ContentBasedDeduplication", "true")
        .attributes("ArchivePolicy", r#"{"MessageRetentionPeriod":1}"#)
        .send()
        .await
        .unwrap()
        .topic_arn()
        .unwrap()
        .to_string();
    // 표준 큐로 받는다: FIFO 큐는 5분 안에 같은 중복 제거 ID를 버려서 바로 다시 보낸 메시지가 오지 않는다
    let queue_url = sqs
        .create_queue()
        .queue_name(format!("{name}-q"))
        .send()
        .await
        .unwrap()
        .queue_url()
        .unwrap()
        .to_string();
    let queue_arn = format!("arn:aws:sqs:{}:{}:{name}-q", live.region, live.account);
    println!("시험 자원: {topic}, {queue_url}");

    let scenario = async {
        live.apply(SnsChangeRequest::Subscribe {
            topic_arn: topic.clone(),
            protocol: "sqs".into(),
            endpoint: queue_arn.clone(),
            filter_policy: None,
            filter_policy_scope: None,
            raw_message_delivery: true,
            dlq_arn: None,
        })
        .await;
        let sub = only_subscription(&live.snapshot(&topic).await).key.clone();
        // 아카이브 시작 시각이 정해질 때까지 조금 기다린 뒤 발행한다
        tokio::time::sleep(Duration::from_secs(5)).await;
        let start = (chrono::Utc::now() - chrono::Duration::seconds(2))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        live.apply(SnsChangeRequest::Publish {
            topic_arn: topic.clone(),
            message: "replay-me".into(),
            subject: None,
            message_structure_json: false,
            attributes: vec![],
            message_group_id: Some("g1".into()),
            deduplication_id: None,
        })
        .await;
        let first = drain(&sqs, &queue_url, 1).await;
        assert_eq!(first, vec!["replay-me".to_string()], "처음 배달");

        // 다시 보내기: 끝 시각 없이(밀린 것을 보낸 뒤 평소대로 받는다)
        live.apply(SnsChangeRequest::Replay {
            subscription_arn: sub.clone(),
            start,
            end: None,
        })
        .await;
        let again = drain(&sqs, &queue_url, 1).await;
        assert_eq!(again, vec!["replay-me".to_string()], "다시 보낸 메시지");
        let status = live.snapshot(&topic).await.subscriptions[0]
            .attributes
            .get("ReplayStatus")
            .cloned();
        println!("ReplayStatus: {status:?}");

        // 아카이브 끄기(되돌리면 이전 보관 기간으로 다시 켠다)
        let off = live
            .plan(SnsChangeRequest::ArchivePolicy {
                topic_arn: topic.clone(),
                retention_days: None,
            })
            .await;
        assert!(
            off.confirm.is_some(),
            "아카이브를 끌 때는 주제 이름을 입력해야 해요"
        );
        live.apply(off.request.clone()).await;
        let attrs = live.snapshot(&topic).await.attributes;
        println!("끈 뒤 ArchivePolicy: {:?}", attrs.get("ArchivePolicy"));
        assert!(
            attrs
                .get("ArchivePolicy")
                .is_none_or(|v| v == "{}" || v.is_empty()),
            "{attrs:?}"
        );
        live.apply(SnsChangeRequest::Unsubscribe {
            subscription_arn: sub,
        })
        .await;
    };
    let outcome = std::panic::AssertUnwindSafe(scenario).catch_unwind().await;
    // 아카이브가 켜진 주제는 지울 수 없어서(InvalidState) 먼저 끈다. 시나리오가 중간에 실패해도 남지 않게
    let _ = write::execute(
        &live.cfg,
        &SnsCall {
            api: "sns:SetTopicAttributes".into(),
            target: topic.clone(),
            body: json!({"ArchivePolicy": "{}"}),
        },
    )
    .await;
    let deleted = sns.delete_topic().topic_arn(&topic).send().await;
    let _ = sqs.delete_queue().queue_url(&queue_url).send().await;
    assert!(deleted.is_ok(), "시험 주제를 지우지 못했어요: {topic}: {deleted:?}");
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

/// 메시지를 `want`개 받을 때까지(최대 약 60초) 받아서 지운다. 본문 목록을 돌려준다
async fn drain(sqs: &aws_sdk_sqs::Client, url: &str, want: usize) -> Vec<String> {
    let mut bodies = Vec::new();
    for _ in 0..3 {
        for m in write::receive(sqs, url, true, 10).await.unwrap() {
            bodies.push(m.body().unwrap_or_default().to_string());
            sqs.delete_message()
                .queue_url(url)
                .receipt_handle(m.receipt_handle().unwrap())
                .send()
                .await
                .unwrap();
        }
        if bodies.len() >= want {
            break;
        }
    }
    bodies
}
