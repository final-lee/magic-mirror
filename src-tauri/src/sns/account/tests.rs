use super::*;

#[test]
fn four_queries_per_topic_in_batches_of_at_most_500() {
    assert!(plan_queries(0).is_empty());
    let one = plan_queries(1);
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].iter().map(|q| q.metric).collect::<Vec<_>>(), TopicMetric::ALL);
    // 125개 주제 = 정확히 500개 쿼리 → 한 번
    assert_eq!(plan_queries(125).iter().map(Vec::len).collect::<Vec<_>>(), [500]);
    // 126개 주제 = 504개 → 500 + 4
    assert_eq!(plan_queries(126).iter().map(Vec::len).collect::<Vec<_>>(), [500, 4]);
    // 1,000개 주제 = 4,000개 → 8번
    let batches = plan_queries(1000);
    assert_eq!((batches.len(), batches.iter().map(Vec::len).sum::<usize>()), (8, 4000));
    assert!(batches.iter().all(|b| b.len() <= MAX_QUERIES_PER_CALL));
}

#[test]
fn query_ids_are_unique_start_lowercase_and_map_back_to_the_topic() {
    let batches = plan_queries(300);
    let all: Vec<&QuerySpec> = batches.iter().flatten().collect();
    let ids: HashSet<&str> = all.iter().map(|q| q.id.as_str()).collect();
    assert_eq!(ids.len(), all.len());
    assert!(all.iter().all(|q| q.id.starts_with(|c: char| c.is_ascii_lowercase())));
    let last = all.last().unwrap();
    assert_eq!((last.id.as_str(), last.topic, last.metric), ("t299m3", 299, TopicMetric::FilteredOut));
}

#[test]
fn folding_adds_sums_per_topic_and_leaves_missing_metrics_at_zero() {
    let batches = plan_queries(3);
    let mut totals = vec![TopicTotals::default(); 3];
    let sums: HashMap<String, f64> = [("t0m0", 10.0), ("t0m2", 3.0), ("t1m1", 7.0), ("t2m3", 2.0), ("t9m0", 99.0)].into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    fold_totals(&batches[0], &sums, &mut totals);
    assert_eq!(totals[0], TopicTotals { published: 10.0, delivered: 0.0, failed: 3.0, filtered_out: 0.0 });
    assert_eq!(totals[1], TopicTotals { published: 0.0, delivered: 7.0, failed: 0.0, filtered_out: 0.0 });
    assert_eq!(totals[2], TopicTotals { published: 0.0, delivered: 0.0, failed: 0.0, filtered_out: 2.0 });
    // 두 번째 묶음의 값은 더해진다
    fold_totals(&batches[0], &sums, &mut totals);
    assert_eq!(totals[0].published, 20.0);
}

#[test]
fn metric_names_are_the_sns_topic_metrics() {
    assert_eq!(TopicMetric::ALL.map(TopicMetric::name), ["NumberOfMessagesPublished", "NumberOfNotificationsDelivered", "NumberOfNotificationsFailed", "NumberOfNotificationsFilteredOut"]);
}

#[test]
fn account_metric_stats_depend_on_the_metric() {
    assert_eq!(account_stat("SMSSuccessRate"), "Average");
    assert_eq!(account_stat("SMSMonthToDateSpentUSD"), "Maximum");
    assert_eq!(account_stat("NumberOfMessagesPublishedPerAccount"), "Sum");
}

#[test]
fn dlq_state_reads_the_redrive_policy() {
    let with: HashMap<String, String> = [("RedrivePolicy".to_string(), r#"{"deadLetterTargetArn":"arn:aws:sqs:ap-northeast-2:431847470565:dlq"}"#.to_string())].into();
    assert_eq!(dlq_state(&with), Dlq::Present);
    assert_eq!(dlq_state(&HashMap::new()), Dlq::Missing);
    let broken: HashMap<String, String> = [("RedrivePolicy".to_string(), "{}".to_string())].into();
    assert_eq!(dlq_state(&broken), Dlq::Missing);
}

#[test]
fn topics_sort_by_failures_then_publishes_then_name() {
    let row = |name: &str, failed: f64, published: f64| AccountTopicRow { arn: name.into(), name: name.into(), fifo: false, subscriptions: 0, pending: 0, published, delivered: 0.0, failed, filtered_out: 0.0, error: None };
    let mut rows = vec![row("c", 0.0, 5.0), row("b", 2.0, 1.0), row("a", 0.0, 5.0), row("d", 9.0, 0.0)];
    sort_rows(&mut rows);
    assert_eq!(rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["d", "b", "a", "c"]);
}
