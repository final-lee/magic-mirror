use super::*;

fn pod(namespace: &str, name: &str) -> PodRef {
    PodRef {
        namespace: namespace.into(),
        name: name.into(),
    }
}

#[test]
fn readings_cover_every_requested_pod_once_with_usage_only_where_metrics_exist() {
    let usage = HashMap::from([(("web".to_string(), "api-1".to_string()), (120, 64 << 20))]);
    let bounds = HashMap::from([(
        ("web".to_string(), "api-1".to_string()),
        Bounds {
            cpu_request: Some(100),
            cpu_limit: Some(500),
            memory_request: None,
            memory_limit: Some(128 << 20),
        },
    )]);
    let rows = readings(&[pod("web", "api-2"), pod("web", "api-1"), pod("web", "api-1")], &usage, &bounds);
    assert_eq!(rows.len(), 2);
    assert_eq!(
        (rows[0].name.as_str(), rows[0].cpu_milli, rows[0].memory_bytes, rows[0].bounds.cpu_limit),
        ("api-1", Some(120), Some(64 << 20), Some(500))
    );
    // 방금 뜬 Pod는 metrics-server에 아직 없다: 사용량도 요청·제한도 비어 있다
    assert_eq!(
        (rows[1].name.as_str(), rows[1].cpu_milli, rows[1].memory_bytes, rows[1].bounds),
        ("api-2", None, None, Bounds::default())
    );
}
