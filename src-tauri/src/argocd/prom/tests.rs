use super::*;

const TEXT: &str = r#"# HELP argocd_app_reconcile Application reconciliation performance in seconds.
# TYPE argocd_app_reconcile histogram
argocd_app_reconcile_bucket{dest_server="https://a",namespace="argocd",le="0.25"} 6
argocd_app_reconcile_bucket{dest_server="https://a",namespace="argocd",le="1"} 9
argocd_app_reconcile_bucket{dest_server="https://a",namespace="argocd",le="+Inf"} 10
argocd_app_reconcile_bucket{dest_server="https://b",namespace="argocd",le="0.25"} 1
argocd_app_reconcile_bucket{dest_server="https://b",namespace="argocd",le="1"} 1
argocd_app_reconcile_bucket{dest_server="https://b",namespace="argocd",le="+Inf"} 2
argocd_app_reconcile_sum{dest_server="https://a",namespace="argocd"} 4.5
argocd_app_reconcile_count{dest_server="https://a",namespace="argocd"} 10
# TYPE argocd_app_sync_total counter
argocd_app_sync_total{name="one",phase="Succeeded",project="p"} 3 1700000000000
argocd_app_sync_total{name="two",phase="Succeeded",project="p"} 4
argocd_app_sync_total{name="two",phase="Failed",project="p"} 1
# TYPE workqueue_depth gauge
workqueue_depth{controller="app_reconciliation_queue",name="app_reconciliation_queue",priority=""} 7
# TYPE unrelated_thing gauge
unrelated_thing{a="b"} 1
"#;

fn sample(name: &str, labels: &[(&str, &str)], value: f64) -> Sample {
    Sample {
        name: name.into(),
        family: name.into(),
        kind: Kind::Counter,
        labels: labels.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        value,
    }
}

#[test]
fn parse_reads_families_labels_and_values() {
    let samples = parse(TEXT);
    let bucket = &samples[2];
    assert_eq!(
        (bucket.name.as_str(), bucket.family.as_str(), bucket.kind),
        ("argocd_app_reconcile_bucket", "argocd_app_reconcile", Kind::Histogram)
    );
    assert_eq!(bucket.labels["le"], "+Inf");
    assert_eq!(bucket.value, 10.0);
    // 타임스탬프 칸은 값으로 읽지 않는다
    let sync = samples.iter().find(|s| s.name == "argocd_app_sync_total").unwrap();
    assert_eq!((sync.kind, sync.value), (Kind::Counter, 3.0));
    // 빈 라벨 값도 라벨이다
    let depth = samples.iter().find(|s| s.name == "workqueue_depth").unwrap();
    assert_eq!((depth.kind, depth.labels["priority"].as_str(), depth.value), (Kind::Gauge, "", 7.0));
}

#[test]
fn parse_handles_escapes_odd_values_and_junk() {
    let text = "# TYPE m gauge\nm{path=\"a\\\"b\\\\c\\nd\",list=\"x,y}\",} 2.5e3\nm{ok=\"1\"} +Inf\nm{ok=\"2\"} NaN\nbroken line here\nm{unterminated=\"x} 1\nplain 7\n";
    let samples = parse(text);
    assert_eq!(samples.len(), 3);
    assert_eq!(samples[0].labels["path"], "a\"b\\c\nd");
    assert_eq!(samples[0].labels["list"], "x,y}");
    assert_eq!(samples[0].value, 2500.0);
    assert!(samples[1].value.is_infinite());
    assert_eq!((samples[2].name.as_str(), samples[2].kind, samples[2].value), ("plain", Kind::Untyped, 7.0));
}

#[test]
fn parse_maps_openmetrics_counter_total_to_its_family() {
    let samples = parse("# TYPE jobs counter\njobs_total{a=\"1\"} 5\n# EOF\n");
    assert_eq!((samples[0].family.as_str(), samples[0].kind), ("jobs", Kind::Counter));
}

#[test]
fn reduce_keeps_only_wanted_families_and_sums_over_dropped_labels() {
    let mut tracker = Tracker::default();
    let (series, interval) = tracker.reduce("controller", 1_000, &parse(TEXT));
    assert_eq!(interval, None);
    assert!(series.iter().all(|s| s.component == "controller" && s.delta.is_none()));
    assert!(series.iter().all(|s| s.name != "unrelated_thing"));
    let find = |name: &str, label: (&str, &str)| {
        series
            .iter()
            .find(|s| s.name == name && s.labels.get(label.0).map(String::as_str) == Some(label.1))
            .unwrap()
            .value
    };
    // 서버 두 곳의 버킷이 le마다 더해진다
    assert_eq!(find("argocd_app_reconcile_bucket", ("le", "0.25")), 7.0);
    assert_eq!(find("argocd_app_reconcile_bucket", ("le", "+Inf")), 12.0);
    // 앱 이름 라벨은 지워지고 phase별로 합쳐진다
    assert_eq!(find("argocd_app_sync_total", ("phase", "Succeeded")), 7.0);
    assert_eq!(find("argocd_app_sync_total", ("phase", "Failed")), 1.0);
    let sync = series.iter().find(|s| s.name == "argocd_app_sync_total" && s.labels["phase"] == "Failed").unwrap();
    assert_eq!(sync.labels.len(), 1);
}

#[test]
fn reduce_counts_increase_per_series_with_resets_and_new_series() {
    let mut tracker = Tracker::default();
    tracker.reduce(
        "controller",
        0,
        &[
            sample("argocd_app_sync_total", &[("name", "a"), ("phase", "Succeeded")], 100.0),
            sample("argocd_app_sync_total", &[("name", "b"), ("phase", "Succeeded")], 50.0),
        ]
        .map(counter),
    );
    // a는 리셋(100 → 4), b는 8 늘었고, c는 새 시리즈(처음부터 3)
    let next = [
        sample("argocd_app_sync_total", &[("name", "a"), ("phase", "Succeeded")], 4.0),
        sample("argocd_app_sync_total", &[("name", "b"), ("phase", "Succeeded")], 58.0),
        sample("argocd_app_sync_total", &[("name", "c"), ("phase", "Succeeded")], 3.0),
    ]
    .map(counter);
    let (series, interval) = tracker.reduce("controller", 30_000, &next);
    assert_eq!(interval, Some(30_000));
    let total = &series[0];
    assert_eq!((total.value, total.delta), (65.0, Some(15.0)));
}

#[test]
fn reduce_does_not_count_a_vanished_series_as_a_reset() {
    let mut tracker = Tracker::default();
    tracker.reduce(
        "controller",
        0,
        &[
            sample("argocd_app_sync_total", &[("name", "a"), ("phase", "Succeeded")], 100.0),
            sample("argocd_app_sync_total", &[("name", "b"), ("phase", "Succeeded")], 50.0),
        ]
        .map(counter),
    );
    // 앱 a가 지워져서 합은 줄었지만 늘어난 양은 b의 2뿐이다
    let (series, _) = tracker.reduce(
        "controller",
        30_000,
        &[sample("argocd_app_sync_total", &[("name", "b"), ("phase", "Succeeded")], 52.0)].map(counter),
    );
    assert_eq!((series[0].value, series[0].delta), (52.0, Some(2.0)));
}

#[test]
fn reduce_gauges_have_no_delta_and_failed_components_keep_their_baseline() {
    let mut tracker = Tracker::default();
    let gauge = |v| Sample {
        kind: Kind::Gauge,
        ..sample("workqueue_depth", &[("name", "q"), ("controller", "q")], v)
    };
    let counter_at = |v| counter(sample("argocd_git_request_total", &[("repo", "r"), ("request_type", "fetch")], v));
    tracker.reduce("repo-server", 0, &[counter_at(10.0)]);
    tracker.reduce("controller", 0, &[gauge(3.0)]);
    // repo-server 읽기가 한 번 실패해도(reduce를 부르지 않는다) 다음 읽기는 처음 값에서 이어 센다
    let (series, interval) = tracker.reduce("repo-server", 90_000, &[counter_at(25.0)]);
    assert_eq!((interval, series[0].delta), (Some(90_000), Some(15.0)));
    let (series, _) = tracker.reduce("controller", 30_000, &[gauge(5.0)]);
    assert_eq!((series[0].value, series[0].delta), (5.0, None));
}

#[test]
fn increase_treats_a_drop_as_a_restart() {
    assert_eq!(increase(10.0, 15.0), 5.0);
    assert_eq!(increase(10.0, 10.0), 0.0);
    assert_eq!(increase(10.0, 2.0), 2.0);
}

fn counter(s: Sample) -> Sample {
    Sample { kind: Kind::Counter, ..s }
}
