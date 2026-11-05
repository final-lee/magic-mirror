use fred::types::Value;

use super::*;

fn entry(id: &str, fields: &[&str]) -> Value {
    Value::Array(vec![Value::from(id), Value::Array(fields.iter().map(|f| Value::from(*f)).collect())])
}

#[test]
fn an_entry_gives_its_time_event_and_previous_state() {
    let e = entry("1700000000123-4", &["event", "active", "jobId", "7", "prev", "waiting"]);
    assert_eq!(parse_entry(&e), Some((1_700_000_000_123, Some("active".into()), Some("waiting".into()))));
    // `prev`가 없는 이벤트(added …)
    let added = entry("1700000000200-0", &["event", "added", "jobId", "8", "name", "send"]);
    assert_eq!(parse_entry(&added), Some((1_700_000_000_200, Some("added".into()), None)));
    // 이벤트 필드가 없는 항목은 이벤트 없음
    assert_eq!(parse_entry(&entry("1-0", &["jobId", "1"])), Some((1, None, None)));
    assert_eq!(parse_entry(&Value::Null), None);
}

fn seen(list: &[(Option<&str>, &str)]) -> Vec<(Option<String>, String)> {
    list.iter().map(|(p, e)| (p.map(str::to_string), e.to_string())).collect()
}

#[test]
fn pairs_are_counted_with_and_without_prev_and_sorted_by_count() {
    let list = seen(&[(Some("waiting"), "active"), (Some("active"), "completed"), (Some("waiting"), "active"), (None, "added"), (None, "stalled"), (Some("active"), "failed"), (Some("active"), "completed"), (Some("waiting"), "active")]);
    let t = summarize(10, 20, Some(12), 9, false, &list);
    assert_eq!((t.from, t.to, t.first_at, t.events, t.truncated), (10, 20, Some(12), 9, false));
    let flat: Vec<(Option<&str>, &str, u64)> = t.pairs.iter().map(|p| (p.prev.as_deref(), p.event.as_str(), p.count)).collect();
    assert_eq!(
        flat,
        vec![(Some("waiting"), "active", 3), (Some("active"), "completed", 2), (None, "added", 1), (Some("active"), "failed", 1), (None, "stalled", 1)]
    );
}

#[test]
fn a_trimmed_stream_shows_in_first_at_and_the_read_cap_in_truncated() {
    // 스트림이 잘려 가장 오래된 항목이 창의 시작보다 늦다
    let trimmed = summarize(1_000, 2_000, Some(1_500), 3, false, &seen(&[(None, "added")]));
    assert!(trimmed.first_at.unwrap() > trimmed.from);
    let capped = summarize(0, 1, Some(0), MAX_EVENTS, true, &[]);
    assert!(capped.truncated && capped.pairs.is_empty());
    assert_eq!(summarize(0, 1, None, 0, false, &[]).first_at, None);
}

#[test]
fn pages_and_the_cap_follow_the_design() {
    assert_eq!((PAGE, MAX_EVENTS), (1_000, 20_000));
}
