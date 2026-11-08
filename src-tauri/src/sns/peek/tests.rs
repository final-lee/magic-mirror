use super::*;
use serde_json::json;

fn signals() -> Signals {
    Signals {
        subscribed: true,
        subscription_dlq: false,
        source_dlq: false,
        has_redrive: false,
        enabled_mapping: false,
        received: 0.0,
        empty: 0.0,
        error: None,
    }
}
fn decide(s: Signals) -> PeekVerdict {
    eligibility("arn:aws:sqs:r:a:queue".into(), "url".into(), s)
}

#[test]
fn only_safe_queues_are_eligible() {
    assert!(decide(signals()).eligible);
    let mut s = signals();
    s.empty = 1.0;
    assert!(!decide(s).eligible);
    let mut s = signals();
    s.enabled_mapping = true;
    assert!(!decide(s).eligible);
    let mut s = signals();
    s.subscription_dlq = true;
    s.received = 1.0;
    let v = decide(s);
    assert!(v.eligible && v.dlq && v.warning.is_some());
    let mut s = signals();
    s.source_dlq = true;
    s.has_redrive = true;
    assert!(!decide(s).eligible);
    let mut s = signals();
    s.source_dlq = true;
    s.error = Some("권한 없음".into());
    assert!(!decide(s).eligible);
    let mut s = signals();
    s.subscribed = false;
    assert!(!decide(s).eligible);
}

#[test]
fn parses_sns_envelope_and_preserves_raw_delivery() {
    let msg = envelope(
        "sqs-id",
        r#"{"Type":"Notification","Message":"hello","MessageId":"sns-id","TopicArn":"arn","Timestamp":"time","MessageAttributes":{"a":{"Type":"String","Value":"x"}}}"#,
        json!({}),
    );
    assert_eq!(msg.body, "hello");
    assert_eq!(msg.sns_message_id.as_deref(), Some("sns-id"));
    assert_eq!(msg.attributes["a"]["Value"], "x");
    let raw = envelope("id", "{\"hello\":true}", json!({"attr":"value"}));
    assert_eq!(raw.body, "{\"hello\":true}");
    assert_eq!(raw.attributes["attr"], "value");
    assert!(raw.sns_message_id.is_none());
}

#[test]
fn reads_only_matching_peek_minutes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("changes.jsonl");
    crate::jsonl::append(
        &path,
        &json!({"peek":true,"profile":"p","region":"r","queueArn":"a","minute":10}),
    )
    .unwrap();
    crate::jsonl::append(
        &path,
        &json!({"peek":true,"profile":"other","region":"r","queueArn":"a","minute":11}),
    )
    .unwrap();
    assert_eq!(prior_minutes(&path, "a"), HashSet::from([10, 11]));
}

#[test]
fn a_fresh_warning_needs_the_queue_name_before_start() {
    let mut s = signals();
    s.subscription_dlq = true;
    s.received = 1.0;
    let warned = decide(s);
    // 화면이 경고 없이 받았더라도(이름 없음) 새 판정에 경고가 있으면 시작하지 않는다
    let err = start_check(&warned, None).unwrap_err();
    assert_eq!(serde_json::to_value(&err).unwrap()["kind"], "peekConfirm");
    assert_eq!(
        serde_json::to_value(&err).unwrap()["warning"],
        warned.warning.clone().unwrap()
    );
    assert!(matches!(
        start_check(&warned, Some("other")),
        Err(AppError::PeekConfirm { .. })
    ));
    assert!(start_check(&warned, Some("queue")).is_ok());
    // 경고가 없으면 이름 없이 시작한다
    let mut s = signals();
    s.subscription_dlq = true;
    assert!(start_check(&decide(s), None).is_ok());
    // 엿볼 수 없는 큐는 이름이 맞아도 시작하지 않는다
    let mut s = signals();
    s.empty = 1.0;
    assert!(matches!(
        start_check(&decide(s), Some("queue")),
        Err(AppError::Other { .. })
    ));
}

#[tokio::test]
async fn stop_wakes_a_long_poll_and_late_results_are_handed_to_the_release() {
    use std::time::Duration;
    let state = PeekState::default();
    let session = Arc::new(Session::default());
    state
        .inner
        .sessions
        .lock()
        .unwrap()
        .insert("s".into(), session.clone());
    let (late_tx, late_rx) = tokio::sync::oneshot::channel();
    let worker = {
        let session = session.clone();
        tokio::spawn(async move {
            // 300ms짜리 폴링: 멈춤이 깨우지 못하면 stop이 폴링이 끝나길 기다려서 아래 시간 제한을 넘는다
            let polled = until_cancelled(
                &session.cancel,
                async {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    vec!["handle"]
                },
                move |late: Vec<&'static str>| async move {
                    let _ = late_tx.send(late);
                },
            )
            .await;
            assert!(polled.is_none(), "멈춤이 폴링을 깨워야 해요");
            session.done.store(true, Ordering::SeqCst);
            session.notify.notify_waiters();
        })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    let started = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(2), state.stop("s"))
        .await
        .expect("stop은 폴링이 끝나길 기다리면 안 돼요");
    assert!(
        started.elapsed() < Duration::from_millis(250),
        "{:?}",
        started.elapsed()
    );
    worker.await.unwrap();
    // 멈춘 뒤에 도착한 결과는 바로 되돌려 놓는 쪽으로 넘어간다
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), late_rx)
            .await
            .unwrap()
            .unwrap(),
        vec!["handle"]
    );
}

#[tokio::test]
async fn a_stop_sent_before_the_poll_starts_is_not_lost() {
    let cancel = Notify::new();
    cancel.notify_one();
    let polled = until_cancelled(
        &cancel,
        async {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            1
        },
        |_| async {},
    )
    .await;
    assert_eq!(polled, None);
    let cancel = Notify::new();
    assert_eq!(
        until_cancelled(&cancel, async { 7 }, |_| async {}).await,
        Some(7)
    );
}
