use super::*;

const NOW: i64 = 1_800_000_000;

fn target(table: &str, index: Option<&str>, provisioned: bool) -> Target {
    Target { table: table.into(), index: index.map(str::to_string), provisioned }
}

fn points(entries: &[(&str, Vec<(i64, f64)>)]) -> HashMap<String, Points> {
    entries.iter().map(|(id, p)| (id.to_string(), p.clone())).collect()
}

#[test]
fn throttles_only_count_the_last_hour() {
    let p = points(&[(
        "t0_rt",
        vec![(NOW - THROTTLE_WINDOW_SECS - 60, 1000.0), (NOW - THROTTLE_WINDOW_SECS, 3.0), (NOW - 600, 4.0)],
    ), ("t0_wt", vec![(NOW - 30, 2.0)])]);
    let u = usage(0, &p, false, NOW);
    // 한 시간 하고 1분 전 점은 빠지고 정확히 한 시간 전 점은 든다
    assert_eq!(u.read_throttle, 7.0);
    assert_eq!(u.write_throttle, 2.0);
    assert_eq!((u.read, u.write), (None, None));
}

#[test]
fn no_datapoints_means_no_throttles_and_no_consumption() {
    let u = usage(0, &HashMap::new(), true, NOW);
    assert_eq!((u.read_throttle, u.write_throttle), (0.0, 0.0));
    assert_eq!(u.read, Some(Capacity { peak_consumed: 0.0, peak_utilization: None }));
    assert_eq!(u.write, Some(Capacity { peak_consumed: 0.0, peak_utilization: None }));
}

#[test]
fn peak_consumption_is_the_busiest_minute_per_second() {
    let consumed = [(NOW, 600.0), (NOW + 60, 1500.0), (NOW + 120, 300.0)];
    let c = capacity(&consumed, &[]);
    assert_eq!(c.peak_consumed, 25.0);
    assert_eq!(c.peak_utilization, None);
}

#[test]
fn utilization_compares_each_minute_with_the_capacity_of_that_minute() {
    // 낮(프로비저닝 100)에는 초당 50을 썼고(50%), 밤(프로비저닝 10)에는 초당 5를 썼다(50%). 지금 프로비저닝(10)으로 보면 낮이 500%로 보이는 것이 틀린 판단이다
    let consumed = [(NOW, 3000.0), (NOW + 60, 300.0)];
    let provisioned = [(NOW, 100.0), (NOW + 60, 10.0)];
    let c = capacity(&consumed, &provisioned);
    assert_eq!(c.peak_consumed, 50.0);
    assert_eq!(c.peak_utilization, Some(0.5));
}

#[test]
fn minutes_without_a_matching_or_positive_provisioned_point_are_skipped() {
    let consumed = [(NOW, 6000.0), (NOW + 60, 600.0), (NOW + 120, 60.0)];
    // 첫 분은 프로비저닝 점이 없고, 둘째 분은 0이다
    let provisioned = [(NOW + 60, 0.0), (NOW + 120, 10.0)];
    let c = capacity(&consumed, &provisioned);
    assert_eq!(c.peak_utilization, Some(0.1));
    assert_eq!(c.peak_consumed, 100.0);
}

#[test]
fn results_are_grouped_per_table_and_index() {
    let targets = [target("orders", None, true), target("orders", Some("by-user"), true), target("logs", None, false)];
    let p = points(&[
        ("t0_cr", vec![(NOW, 60.0)]),
        ("t0_pr", vec![(NOW, 2.0)]),
        ("t1_wt", vec![(NOW - 5, 9.0)]),
        ("t2_rt", vec![(NOW - 5, 1.0)]),
    ]);
    let by_table = collect(&targets, &p, NOW);
    assert_eq!(by_table.len(), 2);
    let orders = &by_table["orders"];
    assert_eq!(orders.table.read, Some(Capacity { peak_consumed: 1.0, peak_utilization: Some(0.5) }));
    assert_eq!(orders.indexes["by-user"].write_throttle, 9.0);
    assert_eq!(by_table["logs"].table.read_throttle, 1.0);
    assert!(by_table["logs"].indexes.is_empty());
}

#[test]
fn queries_have_unique_ids_and_the_right_dimensions() {
    let targets = [target("orders", None, true), target("orders", Some("by-user"), true), target("logs", None, false)];
    let q = queries(&targets);
    // 프로비저닝 대상은 6개, 온디맨드는 스로틀 2개
    assert_eq!(q.len(), 6 + 6 + 2);
    let mut ids: Vec<_> = q.iter().map(|q| q.id().unwrap().to_string()).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), q.len());
    let index_query = q.iter().find(|q| q.id() == Some("t1_cr")).unwrap();
    let dims: Vec<_> = index_query.metric_stat().unwrap().metric().unwrap().dimensions().iter().map(|d| (d.name().unwrap(), d.value().unwrap())).collect();
    assert_eq!(dims, vec![("TableName", "orders"), ("GlobalSecondaryIndexName", "by-user")]);
    let table_query = q.iter().find(|q| q.id() == Some("t0_pw")).unwrap();
    let stat = table_query.metric_stat().unwrap();
    assert_eq!(stat.stat(), Some("Average"));
    assert_eq!(stat.metric().unwrap().metric_name(), Some("ProvisionedWriteCapacityUnits"));
    assert_eq!(stat.metric().unwrap().dimensions().len(), 1);
}

#[test]
fn a_large_region_splits_into_batches_that_fit_the_query_limit() {
    let targets: Vec<Target> = (0..200).map(|i| target(&format!("t{i}"), None, true)).collect();
    let q = queries(&targets);
    assert_eq!(q.len(), 1200);
    let sizes: Vec<_> = q.chunks(MAX_QUERIES).map(<[_]>::len).collect();
    assert_eq!(sizes, vec![500, 500, 200]);
}
