use super::*;

#[test]
fn percentiles_use_nearest_rank() {
    assert_eq!(percentiles(&[]), None);
    let p = percentiles(&[40, 10, 30, 20]).unwrap();
    assert_eq!((p.p50, p.p95, p.max), (20, 40, 40));
    let hundred: Vec<u64> = (1..=100).collect();
    let p = percentiles(&hundred).unwrap();
    assert_eq!((p.p50, p.p95, p.max), (50, 95, 100));
    let one = percentiles(&[7]).unwrap();
    assert_eq!((one.p50, one.p95, one.max), (7, 7, 7));
}

#[test]
fn histograms_count_into_the_first_bucket_that_fits_and_the_last_takes_the_rest() {
    let h = histogram(&[1, 5, 6, 100, 7_200_000, 99_999_999]);
    assert_eq!(h[0].count, 2);
    assert_eq!(h[1].count, 1);
    assert_eq!(h[3].count, 1);
    assert_eq!(h.last().unwrap().count, 2);
    assert_eq!(h.iter().map(|b| b.count).sum::<u64>(), 6);
}

#[test]
fn spans_need_both_times_in_order() {
    assert_eq!(span(Some(10), Some(25)), Some(15));
    assert_eq!(span(Some(25), Some(10)), None);
    assert_eq!(span(None, Some(1)), None);
}

#[test]
fn recent_buckets_end_at_the_current_minute() {
    let now = 1_700_000_123_456;
    let start = bucket_start(now);
    assert_eq!(start % 60_000, 0);
    assert_eq!(bucket_range(start, RECENT_MINUTES - 1).1, now - now % 60_000 + 60_000);
    assert_eq!(bucket_range(start, 0), (start, start + 60_000));
}

#[test]
fn delayed_scores_decode_per_flavor() {
    let ts: i64 = 1_700_000_000_000;
    assert_eq!(delayed_at((ts * 0x1000 + 17) as f64, KvBullFlavor::Bullmq), ts);
    assert_eq!(delayed_at(ts as f64, KvBullFlavor::Bull), ts);
}

#[test]
fn metrics_lists_are_turned_oldest_first_and_aligned() {
    let d = daily(1_000_000, &[3, 2, 1], &[9]);
    assert_eq!(d.start, 1_000_000 - 3 * 60_000);
    assert_eq!(d.completed, vec![1, 2, 3]);
    assert_eq!(d.failed, vec![0, 0, 9]);
}

#[test]
fn failure_reasons_are_grouped_most_common_first() {
    let g = group_reasons(&[("boom".into(), Some(10)), (" boom ".into(), Some(30)), ("other".into(), Some(50)), ("".into(), None)]);
    assert_eq!(g.len(), 2);
    assert_eq!((g[0].reason.as_str(), g[0].count, g[0].last_at), ("boom", 2, Some(30)));
    assert_eq!(g[1].reason, "other");
}

#[test]
fn stacktraces_and_parents_are_parsed() {
    assert_eq!(stacktrace(r#"["a","b"]"#), vec!["a".to_string(), "b".to_string()]);
    assert_eq!(stacktrace("plain"), vec!["plain".to_string()]);
    let p = parent_of(Some(r#"{"id":"7","queueKey":"bull:parent"}"#), None).unwrap();
    assert_eq!((p.id.as_str(), p.queue_key.as_str()), ("7", "bull:parent"));
    let p = parent_of(None, Some("bull:parent:9")).unwrap();
    assert_eq!((p.id.as_str(), p.queue_key.as_str()), ("9", "bull:parent"));
    assert_eq!(parent_of(None, Some("")), None);
}
