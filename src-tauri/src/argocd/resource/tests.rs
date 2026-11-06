use serde_json::json;

use super::*;

#[test]
fn events_are_newest_first_and_use_series_time_when_present() {
    let rows = event_rows(&json!({"items": [
        {"type": "Normal", "reason": "Pulled", "message": "ok", "count": 1, "firstTimestamp": "2024-05-01T10:00:00Z", "lastTimestamp": "2024-05-01T10:00:00Z", "source": {"component": "kubelet"}},
        {"type": "Warning", "reason": "BackOff", "message": "restarting", "count": 0, "firstTimestamp": "2024-05-01T09:00:00Z", "series": {"lastObservedTime": "2024-05-01T11:00:00Z"}, "reportingComponent": "kubelet"},
        {"type": "Normal", "reason": "New", "eventTime": "2024-05-01T10:30:00Z"},
    ]}));
    assert_eq!(rows.iter().map(|r| r.reason.as_str()).collect::<Vec<_>>(), ["BackOff", "New", "Pulled"]);
    assert_eq!(rows[0].count, 1);
    assert_eq!(rows[0].source.as_deref(), Some("kubelet"));
    assert!(event_rows(&json!({})).is_empty());
}

#[test]
fn links_keep_only_web_addresses() {
    let rows = link_rows(&json!({"items": [
        {"title": "Grafana", "url": "https://grafana.test/d/1", "description": "metrics", "iconClass": "fa-chart"},
        {"title": "bad", "url": "javascript:alert(1)"},
        {"title": "file", "url": "file:///etc/passwd"},
        {"url": "http://wiki.test"},
        {"title": "empty"},
    ]}));
    assert_eq!(
        rows.iter().map(|r| (r.title.as_str(), r.url.as_str())).collect::<Vec<_>>(),
        [("Grafana", "https://grafana.test/d/1"), ("http://wiki.test", "http://wiki.test")]
    );
}

#[test]
fn containers_come_from_the_pod_spec_wherever_it_sits() {
    let pod = json!({"spec": {"containers": [{"name": "app"}, {"name": "proxy"}], "initContainers": [{"name": "migrate"}]}});
    let names = |v: &Value| containers_of(v).into_iter().map(|c| (c.name, c.init)).collect::<Vec<_>>();
    assert_eq!(names(&pod), [("app".into(), false), ("proxy".into(), false), ("migrate".into(), true)]);
    let deployment = json!({"spec": {"replicas": 1, "template": {"spec": {"containers": [{"name": "web"}]}}}});
    assert_eq!(names(&deployment), [("web".into(), false)]);
    let cron = json!({"spec": {"jobTemplate": {"spec": {"template": {"spec": {"containers": [{"name": "job"}]}}}}}});
    assert_eq!(names(&cron), [("job".into(), false)]);
    assert!(names(&json!({"spec": {"ports": []}})).is_empty());
}

#[test]
fn scope_skips_an_empty_project() {
    let target = AppTarget {
        namespace: "argocd".into(),
        name: "web".into(),
        project: "team".into(),
    };
    assert_eq!(target.scope(), [("appNamespace", "argocd"), ("project", "team")]);
    assert_eq!(AppTarget { project: String::new(), ..target }.scope(), [("appNamespace", "argocd")]);
}
