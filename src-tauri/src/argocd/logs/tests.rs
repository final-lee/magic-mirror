use serde_json::json;

use super::*;

#[test]
fn log_lines_carry_pod_time_and_last_marker() {
    let line = r#"{"result":{"content":"hello","timeStampStr":"2024-05-01T10:00:00Z","podName":"web-1","last":false}}"#;
    assert_eq!(
        parse_line(line).unwrap(),
        Some(Entry {
            pod: "web-1".into(),
            ts: Some("2024-05-01T10:00:00Z".into()),
            text: "hello".into(),
            last: false
        })
    );
    let last = parse_line(r#"{"result":{"content":"","podName":"web-1","last":true}}"#).unwrap().unwrap();
    assert!(last.last && last.text.is_empty() && last.ts.is_none());
    assert_eq!(parse_line("  ").unwrap(), None);
}

#[test]
fn server_errors_and_garbage_fail() {
    assert_eq!(parse_line(r#"{"error":{"message":"container not found"}}"#), Err(AppError::other("container not found")));
    assert_eq!(parse_line("not json"), Err(AppError::other(LOG_UNREADABLE)));
    assert_eq!(parse_line(r#"{"unexpected":1}"#), Err(AppError::other(LOG_UNREADABLE)));
}

#[test]
fn partial_lines_wait_for_the_rest() {
    let mut pending = b"{\"a\":1}\n{\"b\"".to_vec();
    assert_eq!(take_lines(&mut pending, false), ["{\"a\":1}\n"]);
    assert_eq!(pending, b"{\"b\"");
    pending.extend_from_slice(b":2}");
    assert!(take_lines(&mut pending, false).is_empty());
    assert_eq!(take_lines(&mut pending, true), ["{\"b\":2}"]);
    assert!(pending.is_empty());
}

#[test]
fn messages_group_by_pod_and_end_a_source_on_last() {
    let entry = |pod: &str, text: &str, last: bool| Entry {
        pod: pod.into(),
        ts: None,
        text: text.into(),
        last,
    };
    let out = messages(
        vec![
            entry("a", "1", false),
            entry("a", "2", false),
            entry("b", "3", false),
            entry("a", "", true),
            entry("b", "tail", true),
        ],
        "app",
    );
    let kinds: Vec<_> = out.iter().map(|m| (m["type"].as_str().unwrap(), m["pod"].as_str().unwrap())).collect();
    assert_eq!(kinds, [("lines", "a"), ("lines", "b"), ("source", "a"), ("lines", "b"), ("source", "b")]);
    assert_eq!(out[0]["lines"], json!([{"ts": null, "text": "1"}, {"ts": null, "text": "2"}]));
    assert_eq!(out[0]["container"], "app");
    assert_eq!(out[2]["state"], "ended");
    assert_eq!(out[3]["lines"][0]["text"], "tail");
}

#[test]
fn query_names_pod_or_workload_and_skips_blank_values() {
    let target = AppTarget {
        namespace: "argocd".into(),
        name: "web".into(),
        project: String::new(),
    };
    let pod = LogOptions {
        pod_name: Some("web-1".into()),
        container: Some("app".into()),
        kind: None,
        group: None,
        resource_name: None,
        namespace: "prod".into(),
        follow: true,
        previous: false,
        tail_lines: Some(500),
        since_seconds: None,
    };
    let q = query(&target, &pod);
    let get = |k: &str| q.iter().find(|(key, _)| *key == k).map(|(_, v)| v.as_str());
    assert_eq!(
        (get("podName"), get("container"), get("follow"), get("tailLines"), get("appNamespace"), get("project")),
        (Some("web-1"), Some("app"), Some("true"), Some("500"), Some("argocd"), None)
    );
    let workload = LogOptions {
        pod_name: Some(String::new()),
        container: None,
        kind: Some("Deployment".into()),
        group: Some("apps".into()),
        resource_name: Some("web".into()),
        since_seconds: Some(60),
        previous: true,
        ..pod
    };
    let q = query(&target, &workload);
    let get = |k: &str| q.iter().find(|(key, _)| *key == k).map(|(_, v)| v.as_str());
    assert_eq!(
        (get("podName"), get("kind"), get("resourceName"), get("sinceSeconds"), get("previous")),
        (None, Some("Deployment"), Some("web"), Some("60"), Some("true"))
    );
}
