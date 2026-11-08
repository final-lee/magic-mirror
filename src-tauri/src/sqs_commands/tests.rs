use super::*;

fn state() -> SqsState {
    SqsState::new(PathBuf::from("unused.jsonl"))
}

fn activity_of(received: f64) -> SqsActivity {
    SqsActivity { oldest_age_sec: None, received15m: Some(received), empty_receives15m: None }
}

fn cache(state: &SqsState, at: i64, names: &[&str]) -> Key {
    let k = key("personal", "ap-northeast-2");
    locked(&state.activity).insert(k.clone(), (at, names.iter().map(|n| (n.to_string(), activity_of(1.0))).collect()));
    k
}

#[test]
fn cached_activity_is_reused_for_five_minutes_when_it_covers_every_queue() {
    let s = state();
    let k = cache(&s, 1_000, &["a", "b"]);
    let ttl = ACTIVITY_TTL_MS;
    assert!(fresh_activity(&s, &k, &["a", "b"], false, 1_000 + ttl - 1).is_some());
    assert!(fresh_activity(&s, &k, &["a", "b"], false, 1_000 + ttl).is_none(), "expires at exactly five minutes");
    assert_eq!(fresh_activity(&s, &k, &["a"], false, 2_000).unwrap().0, 1_000, "the read time stays the original");
}

#[test]
fn force_and_a_new_queue_both_bypass_the_cache() {
    let s = state();
    let k = cache(&s, 1_000, &["a"]);
    assert!(fresh_activity(&s, &k, &["a"], true, 1_001).is_none());
    assert!(fresh_activity(&s, &k, &["a", "created-later"], false, 1_001).is_none());
    assert!(fresh_activity(&s, &key("personal", "us-east-1"), &["a"], false, 1_001).is_none(), "another region has its own cache");
    assert!(fresh_activity(&s, &key("other", "ap-northeast-2"), &["a"], false, 1_001).is_none(), "another profile too");
}

#[test]
fn single_queue_reads_use_the_cached_activity_by_name() {
    let s = state();
    let k = cache(&s, 1_000, &["a"]);
    assert_eq!(s.cached_activity(&k, "a"), Some(activity_of(1.0)));
    assert_eq!(s.cached_activity(&k, "missing"), None);
}

#[test]
fn neighbours_come_from_the_last_overview() {
    let s = state();
    let k = key("personal", "ap-northeast-2");
    assert!(s.peers(&k).is_empty());
    locked(&s.queues).insert(k.clone(), vec![SqsQueue::fixture("a")]);
    assert_eq!(s.peers(&k).len(), 1);
}

#[test]
fn saved_names_always_end_in_jsonl() {
    assert_eq!(with_jsonl_extension("dlq-messages".into()), "dlq-messages.jsonl");
    assert_eq!(with_jsonl_extension("dlq-messages.jsonl".into()), "dlq-messages.jsonl");
    assert_eq!(with_jsonl_extension("DLQ.JSONL".into()), "DLQ.JSONL");
}
