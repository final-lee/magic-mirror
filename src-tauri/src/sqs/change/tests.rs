use super::*;
use crate::sqs::peek::HeldFacts;
use crate::sqs::SqsRedrive;

const ACCOUNT_ARN: &str = "arn:aws:sqs:ap-northeast-2:111111111111";

fn queue(name: &str) -> SqsQueue {
    SqsQueue::fixture(name)
}

fn dlq(name: &str, sources: &[&str], visible: i64) -> SqsQueue {
    let mut q = queue(name);
    q.is_dlq = true;
    q.visible = visible;
    q.sources = sources.iter().map(|s| format!("{ACCOUNT_ARN}:{s}")).collect();
    q
}

fn facts(q: SqsQueue) -> Facts {
    Facts { queue: q, peek_gate: Ok(()), tasks: vec![], destinations: vec![], session: SessionFacts::Missing, resend_destination: None }
}

fn blocked(p: &SqsPreview) -> Vec<&str> {
    blocks(p)
}

fn warns(p: &SqsPreview) -> Vec<&str> {
    p.warnings.iter().filter(|w| w.level == WarnLevel::Warn).map(|w| w.message.as_str()).collect()
}

fn task(handle: &str, status: &str, moved: i64) -> SqsMoveTask {
    SqsMoveTask { task_handle: Some(handle.into()), status: status.into(), source_arn: String::new(), destination_arn: None, max_per_second: None, moved, to_move: None, failure_reason: None, started_at: 0 }
}

// ---------- 확인 이름, 중복 제거 ID, 소비자 ----------

#[test]
fn purge_always_asks_for_the_queue_name() {
    assert_eq!(confirm_name(&SqsChange::Purge, "orders"), Some("orders".into()));
}

#[test]
fn prod_and_prd_in_a_name_ask_for_the_name_on_every_change() {
    let receive = SqsChange::Receive { max: 1, hold_secs: 10 };
    for name in ["prod-orders", "orders-prd", "my-PROD-q", "Orders-PRD", "product-feed", "reproduction", "x.prd.fifo"] {
        for change in [&receive, &SqsChange::Purge, &SqsChange::MoveTask { destination_arn: None, max_per_second: None }] {
            assert_eq!(confirm_name(change, name), Some(name.to_string()), "{name}");
        }
    }
    for name in ["stg-orders", "dev-jobs", "prd"[..2].to_string().as_str(), "pr-od"] {
        assert_eq!(confirm_name(&receive, name), None, "{name}");
    }
}

#[test]
fn previews_carry_the_confirm_name_and_the_queue_version() {
    let mut f = facts(queue("prod-orders"));
    f.queue.modified_at = Some(1_700_000_123_999);
    let p = preview(&SqsChange::Receive { max: 10, hold_secs: 30 }, &f).unwrap();
    assert_eq!(p.confirm_name.as_deref(), Some("prod-orders"));
    assert_eq!(p.expected_version.as_deref(), Some("1700000123"));
    let plain = preview(&SqsChange::Receive { max: 10, hold_secs: 30 }, &facts(queue("stg-orders"))).unwrap();
    assert_eq!(plain.confirm_name, None);
}

#[test]
fn dedup_ids_are_message_id_dash_millis_cut_to_128_chars() {
    assert_eq!(dedup_id("abc", 1700000000123), "abc-1700000000123");
    let long = "m".repeat(200);
    let id = dedup_id(&long, 5);
    assert_eq!(id.chars().count(), 128);
    assert!(id.chars().all(|c| c == 'm'), "the front is kept, the ms suffix is what gets cut");
    let exact = "x".repeat(114);
    assert_eq!(dedup_id(&exact, 1700000000123).chars().count(), 128);
    assert!(dedup_id(&exact, 1700000000123).ends_with("-1700000000123"));
    assert_ne!(dedup_id("a", 1), dedup_id("a", 2), "a later resend is never dropped as a duplicate");
}

#[test]
fn a_consumer_is_missing_only_when_all_three_signals_agree() {
    assert!(no_visible_consumer(false, false, Some(0.0)));
    assert!(!no_visible_consumer(true, false, Some(0.0)));
    assert!(!no_visible_consumer(false, true, Some(0.0)));
    assert!(!no_visible_consumer(false, false, Some(3.0)));
    assert!(!no_visible_consumer(false, false, None), "an unreadable metric proves nothing");
}

// ---------- receive ----------

#[test]
fn receive_is_blocked_with_the_peekable_reason() {
    let mut f = facts(queue("orders"));
    f.peek_gate = Err("소비자가 있는 큐는 엿볼 수 없어요".into());
    let p = preview(&SqsChange::Receive { max: 50, hold_secs: 60 }, &f).unwrap();
    assert_eq!(blocked(&p), vec!["소비자가 있는 큐는 엿볼 수 없어요"]);
    assert!(p.impact.contains(&"받은 메시지의 수신 횟수가 1 늘어요".to_string()));
}

#[test]
fn receive_on_fifo_warns_that_the_group_stalls_and_standard_does_not() {
    let fifo = preview(&SqsChange::Receive { max: 5, hold_secs: 60 }, &facts(queue("orders.fifo"))).unwrap();
    assert_eq!(warns(&fifo), vec!["보류 시간 동안 받은 메시지의 그룹이 멈춰요"]);
    assert!(blocked(&fifo).is_empty());
    let standard = preview(&SqsChange::Receive { max: 5, hold_secs: 60 }, &facts(queue("orders"))).unwrap();
    assert!(standard.warnings.is_empty());
}

#[test]
fn receive_mentions_the_dlq_move_when_a_redrive_policy_exists() {
    let mut q = queue("orders");
    q.redrive = Some(SqsRedrive { dlq_arn: format!("{ACCOUNT_ARN}:orders-dlq"), max_receive_count: 3 });
    let p = preview(&SqsChange::Receive { max: 5, hold_secs: 60 }, &facts(q)).unwrap();
    assert!(p.impact.iter().any(|i| i.contains("maxReceiveCount(3)")));
}

#[test]
fn receive_rejects_out_of_range_requests() {
    for (max, hold) in [(0, 60), (501, 60), (10, 9), (10, 601)] {
        assert!(preview(&SqsChange::Receive { max, hold_secs: hold }, &facts(queue("orders"))).is_err(), "{max} {hold}");
    }
}

// ---------- moveTask ----------

fn move_all() -> SqsChange {
    SqsChange::MoveTask { destination_arn: None, max_per_second: None }
}

#[test]
fn move_task_on_a_non_dlq_is_blocked() {
    let mut q = queue("orders");
    q.visible = 5;
    let p = preview(&move_all(), &facts(q)).unwrap();
    assert_eq!(blocked(&p), vec!["DLQ가 아닌 큐에서는 이동 작업을 시작할 수 없어요"]);
}

#[test]
fn move_task_is_blocked_when_empty_or_already_running() {
    let empty = preview(&move_all(), &facts(dlq("orders-dlq", &["orders"], 0))).unwrap();
    assert_eq!(blocked(&empty), vec!["옮길 메시지가 없어요"]);

    let mut f = facts(dlq("orders-dlq", &["orders"], 3));
    f.tasks = vec![task("old", "COMPLETED", 3), task("now", "RUNNING", 1)];
    assert!(blocked(&preview(&move_all(), &f).unwrap()).iter().any(|b| b.contains("이미 이동 작업이 진행 중")));
    f.tasks = vec![task("old", "COMPLETED", 3), task("c", "CANCELLED", 1), task("x", "FAILED", 0)];
    assert!(blocked(&preview(&move_all(), &f).unwrap()).is_empty(), "finished tasks don't block");
    f.tasks = vec![task("c", "CANCELLING", 1)];
    assert!(!blocked(&preview(&move_all(), &f).unwrap()).is_empty(), "a cancelling task still holds the queue");
}

#[test]
fn without_a_destination_the_impact_lists_every_source() {
    let p = preview(&move_all(), &facts(dlq("shared-dlq", &["a", "b"], 4))).unwrap();
    assert!(p.impact.iter().any(|i| i.contains("`a`") && i.contains("`b`")));
    assert_eq!(p.calls[0].api, "sqs:StartMessageMoveTask");
    assert_eq!(p.calls[0].params.keys().map(String::as_str).collect::<Vec<_>>(), vec!["SourceArn"]);
}

#[test]
fn an_explicit_destination_and_rate_appear_in_the_call() {
    let change = SqsChange::MoveTask { destination_arn: Some(format!("{ACCOUNT_ARN}:other")), max_per_second: Some(20) };
    let p = preview(&change, &facts(dlq("orders-dlq", &["orders"], 4))).unwrap();
    assert_eq!(p.calls[0].params["DestinationArn"], format!("{ACCOUNT_ARN}:other"));
    assert_eq!(p.calls[0].params["MaxNumberOfMessagesPerSecond"], "20");
    assert!(p.impact.iter().any(|i| i.contains("`other`")));
    for bad in [0, 501] {
        let change = SqsChange::MoveTask { destination_arn: None, max_per_second: Some(bad) };
        assert!(preview(&change, &facts(dlq("orders-dlq", &["orders"], 4))).is_err());
    }
}

#[test]
fn move_task_warns_about_destinations_without_consumers_and_with_backlog() {
    let mut f = facts(dlq("orders-dlq", &["orders", "jobs"], 4));
    f.destinations = vec![
        Destination { name: "orders".into(), visible: Some(0), no_consumer: true, unreadable: false },
        Destination { name: "jobs".into(), visible: Some(12), no_consumer: false, unreadable: false },
        Destination { name: "quiet".into(), visible: Some(0), no_consumer: false, unreadable: false },
        Destination { name: "hidden".into(), visible: None, no_consumer: false, unreadable: true },
    ];
    let p = preview(&move_all(), &f).unwrap();
    let w = warns(&p);
    assert!(w.contains(&"대상 큐 `orders`에서 받아 가는 소비자가 보이지 않아요"));
    assert!(w.contains(&"대상 큐 `jobs`에 이미 12개가 쌓여 있어요"));
    assert!(w.iter().any(|m| m.contains("`hidden`") && m.contains("읽지 못했어요")));
    assert!(!w.iter().any(|m| m.contains("`quiet`")));
    assert!(blocked(&p).is_empty(), "warnings don't block");
}

// ---------- cancelMoveTask ----------

#[test]
fn cancelling_a_running_task_says_moved_messages_stay_moved() {
    let mut f = facts(dlq("orders-dlq", &["orders"], 4));
    f.tasks = vec![task("h1", "RUNNING", 7)];
    let p = preview(&SqsChange::CancelMoveTask { task_handle: "h1".into() }, &f).unwrap();
    assert_eq!(p.impact, vec!["이미 옮긴 7개는 돌아오지 않아요"]);
    assert!(blocked(&p).is_empty());
    assert_eq!(p.calls[0].params["TaskHandle"], "h1");
}

#[test]
fn cancel_is_blocked_for_unknown_or_finished_tasks() {
    let mut f = facts(dlq("orders-dlq", &["orders"], 4));
    f.tasks = vec![task("h1", "COMPLETED", 7), task("h2", "CANCELLING", 2)];
    assert!(!blocked(&preview(&SqsChange::CancelMoveTask { task_handle: "h1".into() }, &f).unwrap()).is_empty());
    assert!(!blocked(&preview(&SqsChange::CancelMoveTask { task_handle: "h2".into() }, &f).unwrap()).is_empty());
    assert_eq!(blocked(&preview(&SqsChange::CancelMoveTask { task_handle: "zzz".into() }, &f).unwrap()), vec!["그 이동 작업을 찾지 못했어요"]);
}

// ---------- resend / delete ----------

fn live(messages: &[(&str, &str, Option<&str>, Option<&str>)]) -> SessionFacts {
    SessionFacts::Live {
        messages: messages.iter().map(|(id, body, group, source)| (id.to_string(), HeldFacts { body: body.to_string(), group_id: group.map(str::to_string), source_arn: source.map(str::to_string) })).collect(),
    }
}

fn resend(ids: &[&str], dest_url: &str, edits: &[(&str, &str)]) -> SqsChange {
    SqsChange::Resend { peek_id: "p".into(), message_ids: ids.iter().map(|s| s.to_string()).collect(), destination_url: dest_url.into(), edits: edits.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }
}

fn resend_facts(session: SessionFacts, dest: SqsQueue) -> Facts {
    let mut f = facts(dlq("orders-dlq", &["orders"], 3));
    f.session = session;
    f.resend_destination = Some(dest);
    f
}

#[test]
fn resend_is_blocked_for_missing_and_expired_sessions() {
    let change = resend(&["m1"], &queue("orders").url, &[]);
    assert_eq!(blocked(&preview(&change, &resend_facts(SessionFacts::Missing, queue("orders"))).unwrap()), vec![MISSING]);
    assert_eq!(blocked(&preview(&change, &resend_facts(SessionFacts::Expired, queue("orders"))).unwrap()), vec![EXPIRED]);
}

#[test]
fn resend_is_blocked_for_messages_the_session_does_not_have() {
    let change = resend(&["m1", "gone"], &queue("orders").url, &[]);
    let p = preview(&change, &resend_facts(live(&[("m1", "a", None, None)]), queue("orders"))).unwrap();
    assert_eq!(blocked(&p), vec!["세션에 없는 메시지가 있어요: gone"]);
}

#[test]
fn resend_needs_at_least_one_message() {
    assert!(preview(&resend(&[], "u", &[]), &resend_facts(live(&[]), queue("orders"))).is_err());
}

#[test]
fn resend_to_the_original_source_is_clean_and_lists_the_calls() {
    let source_arn = format!("{ACCOUNT_ARN}:orders");
    let change = resend(&["m1", "m2"], &queue("orders").url, &[]);
    let session = live(&[("m1", "a", None, Some(&source_arn)), ("m2", "b", None, Some(&source_arn))]);
    let p = preview(&change, &resend_facts(session, queue("orders"))).unwrap();
    assert!(p.warnings.is_empty(), "{:?}", p.warnings);
    assert!(p.diff.is_empty());
    assert_eq!(p.calls.iter().map(|c| c.api.as_str()).collect::<Vec<_>>(), vec!["sqs:SendMessageBatch", "sqs:DeleteMessageBatch"]);
    assert!(p.impact.iter().any(|i| i.contains("성공한 메시지만 DLQ에서 지워요")));
}

#[test]
fn resend_elsewhere_warns_by_message_origin_or_by_the_dlq_sources() {
    let other = queue("other");
    let source_arn = format!("{ACCOUNT_ARN}:orders");
    let by_attr = live(&[("m1", "a", None, Some(&source_arn)), ("m2", "b", None, Some(&format!("{ACCOUNT_ARN}:other")))]);
    let p = preview(&resend(&["m1", "m2"], &other.url, &[]), &resend_facts(by_attr, other.clone())).unwrap();
    assert_eq!(warns(&p), vec!["메시지 1개를 원래 원본 큐가 아닌 `other`로 보내요"]);

    // 속성이 없으면 이 DLQ의 원본 목록과 견준다
    let no_attr = live(&[("m1", "a", None, None)]);
    let p = preview(&resend(&["m1"], &other.url, &[]), &resend_facts(no_attr.clone(), other.clone())).unwrap();
    assert_eq!(warns(&p).len(), 1);
    let p = preview(&resend(&["m1"], &queue("orders").url, &[]), &resend_facts(no_attr, queue("orders"))).unwrap();
    assert!(warns(&p).is_empty());
}

#[test]
fn resend_to_a_fifo_destination_keeps_groups_and_blocks_groupless_messages() {
    let fifo = queue("orders.fifo");
    let ok = preview(&resend(&["m1"], &fifo.url, &[]), &resend_facts(live(&[("m1", "a", Some("g"), None)]), fifo.clone())).unwrap();
    assert!(ok.impact.iter().any(|i| i.contains("그룹 ID는 그대로") && i.contains("중복 제거 ID는 새로")));
    assert!(blocked(&ok).is_empty());
    let bad = preview(&resend(&["m1", "m2"], &fifo.url, &[]), &resend_facts(live(&[("m1", "a", Some("g"), None), ("m2", "b", None, None)]), fifo)).unwrap();
    assert_eq!(blocked(&bad), vec!["대상이 FIFO인데 그룹 ID가 없는 메시지가 1개 있어요"]);
    // 표준 큐 대상이면 그룹 ID가 없어도 된다
    let std_ok = preview(&resend(&["m2"], &queue("orders").url, &[]), &resend_facts(live(&[("m2", "b", None, None)]), queue("orders"))).unwrap();
    assert!(blocked(&std_ok).is_empty());
}

#[test]
fn edits_show_as_a_diff_only_where_the_body_changes() {
    let session = live(&[("m1", "{\"a\":1}", None, None), ("m2", "same", None, None)]);
    let change = resend(&["m1", "m2"], &queue("orders").url, &[("m1", "{\"a\":2}"), ("m2", "same")]);
    let p = preview(&change, &resend_facts(session, queue("orders"))).unwrap();
    assert_eq!(p.diff, vec![SqsDiff { label: "m1".into(), before: "{\"a\":1}".into(), after: "{\"a\":2}".into() }]);
}

#[test]
fn editing_an_unselected_message_is_blocked() {
    let session = live(&[("m1", "a", None, None), ("m2", "b", None, None)]);
    let change = resend(&["m1"], &queue("orders").url, &[("m2", "changed")]);
    let p = preview(&change, &resend_facts(session, queue("orders"))).unwrap();
    assert_eq!(blocked(&p), vec!["고르지 않은 메시지의 본문을 고쳤어요"]);
}

#[test]
fn resend_cannot_target_the_dlq_itself_or_an_unreadable_queue() {
    let f = resend_facts(live(&[("m1", "a", None, None)]), dlq("orders-dlq", &["orders"], 3));
    let p = preview(&resend(&["m1"], &f.queue.url, &[]), &f).unwrap();
    assert!(blocked(&p).contains(&"DLQ 자신으로는 다시 보낼 수 없어요"));
    let mut g = resend_facts(live(&[("m1", "a", None, None)]), queue("orders"));
    g.resend_destination = None;
    assert!(blocked(&preview(&resend(&["m1"], "u", &[]), &g).unwrap()).contains(&"대상 큐를 읽지 못했어요"));
}

#[test]
fn delete_is_blocked_without_a_live_session_and_lists_the_call_otherwise() {
    let change = SqsChange::DeleteMessages { peek_id: "p".into(), message_ids: vec!["m1".into(), "m2".into()] };
    let mut f = facts(dlq("orders-dlq", &["orders"], 3));
    assert_eq!(blocked(&preview(&change, &f).unwrap()), vec![MISSING]);
    f.session = SessionFacts::Expired;
    assert_eq!(blocked(&preview(&change, &f).unwrap()), vec![EXPIRED]);
    f.session = live(&[("m1", "a", None, None)]);
    assert_eq!(blocked(&preview(&change, &f).unwrap()), vec!["세션에 없는 메시지가 1개 있어요"]);
    f.session = live(&[("m1", "a", None, None), ("m2", "b", None, None)]);
    let p = preview(&change, &f).unwrap();
    assert!(blocked(&p).is_empty());
    assert_eq!(p.calls[0].api, "sqs:DeleteMessageBatch");
    assert!(preview(&SqsChange::DeleteMessages { peek_id: "p".into(), message_ids: vec![] }, &f).is_err());
}

// ---------- purge ----------

#[test]
fn purge_counts_visible_and_in_flight_and_warns_it_is_irreversible() {
    let mut q = queue("orders");
    q.visible = 12;
    q.in_flight = 3;
    let p = preview(&SqsChange::Purge, &facts(q)).unwrap();
    assert_eq!(p.confirm_name.as_deref(), Some("orders"));
    assert!(p.impact[0].contains("12개") && p.impact[0].contains("3개") && p.impact[0].contains("15개"));
    assert_eq!(warns(&p), vec!["되돌릴 수 없어요. 60초에 한 번만 할 수 있어요"]);
    assert_eq!(p.calls[0].api, "sqs:PurgeQueue");
    assert!(blocked(&p).is_empty());
}

#[test]
fn blocks_collects_only_block_level_warnings() {
    let mut f = facts(queue("orders.fifo"));
    f.peek_gate = Err("막힘".into());
    let p = preview(&SqsChange::Receive { max: 5, hold_secs: 60 }, &f).unwrap();
    assert_eq!(p.warnings.len(), 2);
    assert_eq!(blocks(&p), vec!["막힘"]);
}
