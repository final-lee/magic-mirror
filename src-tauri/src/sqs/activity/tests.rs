use super::*;

fn points(entries: &[(&str, &[f64])]) -> HashMap<String, Vec<f64>> {
    entries.iter().map(|(k, v)| (k.to_string(), v.to_vec())).collect()
}

#[test]
fn oldest_age_is_the_maximum_and_counts_are_sums() {
    let names = vec!["orders".to_string()];
    let got = collect(&names, &points(&[("a0", &[10.0, 40.0, 25.0]), ("r0", &[3.0, 4.0]), ("e0", &[100.0, 20.0])]));
    assert_eq!(got["orders"], SqsActivity { oldest_age_sec: Some(40.0), received15m: Some(7.0), empty_receives15m: Some(120.0) });
}

#[test]
fn a_metric_without_points_is_none_not_zero() {
    let names = vec!["orders".to_string()];
    let got = collect(&names, &points(&[("r0", &[0.0])]));
    assert_eq!(got["orders"], SqsActivity { oldest_age_sec: None, received15m: Some(0.0), empty_receives15m: None });
    let silent = collect(&names, &HashMap::new());
    assert_eq!(silent["orders"], SqsActivity::default());
}

#[test]
fn each_queue_reads_its_own_query_ids() {
    let names = vec!["a".to_string(), "b".to_string()];
    let got = collect(&names, &points(&[("r0", &[1.0]), ("r1", &[2.0]), ("a1", &[99.0])]));
    assert_eq!(got["a"].received15m, Some(1.0));
    assert_eq!(got["b"].received15m, Some(2.0));
    assert_eq!(got["a"].oldest_age_sec, None);
    assert_eq!(got["b"].oldest_age_sec, Some(99.0));
}

#[test]
fn queries_ask_three_metrics_per_queue_within_the_call_limit() {
    let names: Vec<String> = (0..QUEUES_PER_CALL).map(|i| format!("q{i}")).collect();
    let q = queries(&names);
    assert_eq!(q.len(), 498);
    assert!(q.len() <= MAX_QUERIES);
    // 한 큐 더하면 한도를 넘어서 호출을 나눠야 한다
    const { assert!((QUEUES_PER_CALL + 1) * QUERIES_PER_QUEUE > MAX_QUERIES) };
    let ids: std::collections::HashSet<&str> = q.iter().map(|x| x.id().unwrap()).collect();
    assert_eq!(ids.len(), q.len(), "query ids are unique");
    let first = &q[0];
    let stat = first.metric_stat().unwrap();
    assert_eq!(stat.period(), Some(900));
    assert_eq!(stat.metric().unwrap().namespace(), Some("AWS/SQS"));
    assert_eq!(stat.metric().unwrap().dimensions()[0].name(), Some("QueueName"));
    let by_metric: Vec<(&str, &str)> = q.iter().take(3).map(|x| (x.metric_stat().unwrap().metric().unwrap().metric_name().unwrap(), x.metric_stat().unwrap().stat().unwrap())).collect();
    assert_eq!(by_metric, vec![("ApproximateAgeOfOldestMessage", "Maximum"), ("NumberOfMessagesReceived", "Sum"), ("NumberOfEmptyReceives", "Sum")]);
}
