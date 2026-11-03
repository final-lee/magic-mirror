use std::io::Write;

use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::json;

use super::*;

/// helm이 저장하는 꼴: JSON → gzip → base64
fn encode(json: &Value) -> String {
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(json.to_string().as_bytes()).unwrap();
    STANDARD.encode(gz.finish().unwrap())
}

fn sample() -> Value {
    json!({
        "name": "web",
        "namespace": "apps",
        "version": 3,
        "info": {"status": "deployed", "description": "Upgrade complete", "last_deployed": "2026-01-02T03:04:05Z", "notes": "hi\n"},
        "chart": {
            "metadata": {"name": "web", "version": "1.2.3", "appVersion": "9"},
            "values": {"replicas": 1, "image": {"repo": "nginx", "tag": "1"}, "list": [1, 2]},
            "templates": [],
        },
        "config": {"replicas": 3, "image": {"tag": "2"}},
        "manifest": "---\nkind: ConfigMap\n",
        "hooks": [{"name": "migrate", "kind": "Job", "events": ["pre-upgrade"]}],
    })
}

#[test]
fn a_release_captured_from_helm_decodes_with_chart_values_and_notes() {
    // kind에서 helm v4로 설치·업그레이드한 릴리스의 Secret 데이터(쿠버네티스 base64를 한 겹 벗긴 것)
    let release = decode(include_str!("demo-v2.b64").as_bytes()).unwrap();
    assert_eq!((release.name.as_str(), release.namespace.as_str(), release.version), ("demo", "mm-helm", 2));
    assert_eq!(release.info.status, "deployed");
    assert_eq!(release.info.notes, "Installed demo\n");
    assert_eq!(release.chart.label(), "mmdemo-0.1.0");
    assert_eq!(release.chart.app_version(), "1.0");
    assert_eq!(release.user_values(), json!({"message": "yo", "replicaCount": 2}));
    assert_eq!(release.computed_values(), json!({"image": "registry.k8s.io/pause:3.10", "message": "yo", "replicaCount": 2}));
    assert!(release.manifest.contains("kind: Deployment"));
    assert_eq!(release.chart.templates.len(), 3);
    assert_eq!(release.chart.files[0].name, "extra.txt");
}

#[test]
fn a_gzipped_payload_decodes_and_whitespace_in_the_base64_is_ignored() {
    let text = encode(&sample());
    let wrapped = text.as_bytes().chunks(20).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join("\n");
    let release = decode(wrapped.as_bytes()).unwrap();
    assert_eq!(release.version, 3);
    assert_eq!(release.hooks[0].events, ["pre-upgrade"]);
}

#[test]
fn a_payload_that_was_never_gzipped_still_decodes() {
    // helm은 gzip 매직이 있을 때만 푼다
    let release = decode(STANDARD.encode(sample().to_string()).as_bytes()).unwrap();
    assert_eq!(release.name, "web");
}

#[test]
fn garbage_and_truncated_payloads_are_unreadable_without_echoing_their_content() {
    for payload in ["!!!not base64!!!", "e30=", &STANDARD.encode("{\"name\":\"x\"")] {
        let error = decode(payload.as_bytes()).unwrap_err();
        assert_eq!(error, AppError::other(UNREADABLE), "{payload}");
    }
    let mut broken = STANDARD.decode(encode(&sample())).unwrap();
    broken.truncate(broken.len() / 2);
    assert_eq!(decode(STANDARD.encode(broken).as_bytes()).unwrap_err(), AppError::other(UNREADABLE));
}

#[test]
fn a_compression_bomb_is_refused_instead_of_filling_memory() {
    let mut gz = GzEncoder::new(Vec::new(), Compression::fast());
    let zeros = vec![0u8; 1 << 20];
    for _ in 0..=(DECODED_MAX >> 20) {
        gz.write_all(&zeros).unwrap();
    }
    let bomb = STANDARD.encode(gz.finish().unwrap());
    assert_eq!(decode(bomb.as_bytes()).unwrap_err(), AppError::other(UNREADABLE));
}

#[test]
fn computed_values_overlay_user_values_on_chart_defaults_and_null_removes_a_key() {
    let release: Release = serde_json::from_value(sample()).unwrap();
    // 맵은 안쪽까지 합치고, 배열과 값은 사용자 값이 이긴다
    assert_eq!(release.computed_values(), json!({"replicas": 3, "image": {"repo": "nginx", "tag": "2"}, "list": [1, 2]}));
    let mut removing = sample();
    removing["config"] = json!({"image": null, "list": []});
    let release: Release = serde_json::from_value(removing).unwrap();
    assert_eq!(release.computed_values(), json!({"replicas": 1, "list": []}));
}

#[test]
fn a_release_without_user_values_has_an_empty_map_whether_config_is_null_or_missing() {
    for config in [Value::Null, json!({})] {
        let mut value = sample();
        value["config"] = config;
        let release: Release = serde_json::from_value(value).unwrap();
        assert_eq!(release.user_values(), json!({}));
    }
    let mut value = sample();
    value.as_object_mut().unwrap().remove("config");
    let release: Release = serde_json::from_value(value).unwrap();
    assert_eq!(release.user_values(), json!({}));
}

#[test]
fn subchart_values_are_coalesced_under_the_subchart_name() {
    let mut value = sample();
    value["chart"]["dependencies"] = json!([{"metadata": {"name": "redis"}, "values": {"port": 6379, "auth": {"on": false}}}]);
    value["config"] = json!({"redis": {"auth": {"on": true}}});
    let release: Release = serde_json::from_value(value).unwrap();
    assert_eq!(release.computed_values()["redis"], json!({"port": 6379, "auth": {"on": true}}));
}

#[test]
fn only_failed_or_unfinished_statuses_are_problems() {
    for status in ["failed", "unknown", "uninstalling", "pending-install", "pending-upgrade", "pending-rollback"] {
        assert!(is_problem(status), "{status}");
    }
    for status in ["deployed", "superseded", "uninstalled", ""] {
        assert!(!is_problem(status), "{status}");
    }
}

#[test]
fn storage_object_names_follow_each_driver() {
    assert_eq!(object_name(Driver::Secret, "web", 7), "sh.helm.release.v1.web.v7");
    assert_eq!(object_name(Driver::ConfigMap, "web", 7), "web.v7");
}

#[test]
fn go_nulls_for_empty_lists_and_texts_decode_as_empty() {
    // helm은 파일·훅·의존 차트가 없으면 빈 목록 대신 null로 저장한다(kind의 helm v4에서 확인)
    let mut value = sample();
    value["hooks"] = Value::Null;
    value["info"]["notes"] = Value::Null;
    value["chart"]["files"] = Value::Null;
    value["chart"]["dependencies"] = Value::Null;
    value["chart"]["templates"] = Value::Null;
    value["manifest"] = Value::Null;
    let release: Release = serde_json::from_value(value).unwrap();
    assert!(release.hooks.is_empty() && release.chart.files.is_empty() && release.chart.dependencies.is_empty() && release.chart.templates.is_empty());
    assert_eq!((release.info.notes.as_str(), release.manifest.as_str()), ("", ""));
}
