use super::*;
use crate::tailscale::api::testing::{self, TAILNET};
use std::sync::{Arc, Mutex};

#[test]
fn findings_use_the_supplied_clock() {
    let now = DateTime::parse_from_rfc3339("2026-11-05T00:00:00Z").unwrap().with_timezone(&Utc);
    let d = json!({"expires":"2026-11-20T00:00:00Z","lastSeen":"2026-09-01T00:00:00Z","os":"linux","tags":[],"keyExpiryDisabled":true,"updateAvailable":true,"authorized":false});
    assert_eq!(findings(&d, now), vec!["expiring", "expiryDisabled", "stale", "untaggedLinux", "update", "unauthorized"]);
    assert_eq!(findings(&json!({"expires":"2026-11-05T00:00:00Z"}), now), vec!["expired"]);
}

#[tokio::test]
async fn preview_apply_and_undo_tags() {
    let device = Arc::new(Mutex::new(json!({"id":"d1","name":"host.example.ts.net","tags":["tag:old"]})));
    let shared = device.clone();
    let (base, seen) = testing::serve(move |req| {
        if req.method == "POST" && req.path.ends_with("/tags") {
            let body: Value = serde_json::from_str(&req.body).unwrap();
            shared.lock().unwrap()["tags"] = body["tags"].clone();
            testing::reply(200, "{}")
        } else { testing::reply(200, &shared.lock().unwrap().to_string()) }
    }).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("changes.jsonl");
    let state = testing::test_state_at(&base, path.clone());
    let plan = preview(&state, TAILNET, vec!["d1".into()], "tags".into(), json!(["tag:new"])).await.unwrap();
    assert_eq!(plan.items[0].path, "/device/d1/tags");
    assert_eq!(plan.items[0].body, json!({"tags":["tag:new"]}));
    assert!(apply(&state, TAILNET, plan, None, &path).await.unwrap()[0].ok);
    let log = changes::list(&path);
    assert_eq!(log[0].before, json!(["tag:old"]));
    undo(&state, TAILNET, &log[0].id, &path).await.unwrap();
    assert_eq!(device.lock().unwrap()["tags"], json!(["tag:old"]));
    assert!(changes::list(&path)[0].undone);
    let calls = testing::api_requests(&seen);
    assert!(calls.iter().any(|r| r.method == "POST" && r.headers.get("authorization").is_some_and(|v| v.contains("devices:core"))));
}

#[tokio::test]
async fn stale_preview_refuses_write_and_routes_use_their_own_scope() {
    let device = Arc::new(Mutex::new(json!({"id":"d1","name":"router","enabledRoutes":["10.0.0.0/16"],"advertisedRoutes":["10.0.0.0/16","10.1.0.0/16"]})));
    let shared = device.clone();
    let (base, seen) = testing::serve(move |req| {
        if req.method == "POST" { testing::reply(200, "{}") }
        else { testing::reply(200, &shared.lock().unwrap().to_string()) }
    }).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("changes.jsonl");
    let state = testing::test_state_at(&base, path.clone());
    let plan = preview(&state, TAILNET, vec!["d1".into()], "routes".into(), json!(["10.0.0.0/16","10.1.0.0/16"])).await.unwrap();
    device.lock().unwrap()["name"] = json!("changed");
    let result = apply(&state, TAILNET, plan, None, &path).await.unwrap();
    assert!(!result[0].ok);
    assert!(!testing::api_requests(&seen).iter().any(|r| r.method == "POST"));
    let plan = preview(&state, TAILNET, vec!["d1".into()], "routes".into(), json!(["10.0.0.0/16","10.1.0.0/16"])).await.unwrap();
    assert!(apply(&state, TAILNET, plan, None, &path).await.unwrap()[0].ok);
    let calls = testing::api_requests(&seen);
    let write = calls.iter().find(|r| r.method == "POST").unwrap();
    assert!(write.path.ends_with("/device/d1/routes"));
    assert_eq!(serde_json::from_str::<Value>(&write.body).unwrap(), json!({"routes":["10.0.0.0/16","10.1.0.0/16"]}));
    assert!(write.headers.get("authorization").is_some_and(|v| v.contains("devices:routes")));
}

#[tokio::test]
async fn deletion_requires_the_device_name() {
    let (base, seen) = testing::serve(|_| testing::reply(200, r#"{"id":"d1","name":"router.example.ts.net"}"#)).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("changes.jsonl");
    let state = testing::test_state_at(&base, path.clone());
    let plan = preview(&state, TAILNET, vec!["d1".into()], "delete".into(), Value::Null).await.unwrap();
    assert!(apply(&state, TAILNET, plan.clone(), Some("router".into()), &path).await.is_err());
    assert!(!testing::api_requests(&seen).iter().any(|r| r.method == "DELETE"));
    assert!(apply(&state, TAILNET, plan, Some("router.example.ts.net".into()), &path).await.unwrap()[0].ok);
}

#[test]
fn ipv4_request_rejects_addresses_outside_tailscale_range() {
    assert!(request_shape("d1", "ip", &json!("100.63.255.255")).is_err());
    assert!(request_shape("d1", "ip", &json!("100.128.0.0")).is_err());
    assert!(request_shape("d1", "ip", &json!("fd7a:115c:a1e0::1")).is_err());
    let (_, path, body) = request_shape("d1", "ip", &json!("100.64.0.1")).unwrap();
    assert_eq!(path, "/device/d1/ip");
    assert_eq!(body, json!({"ipv4":"100.64.0.1"}));
}
