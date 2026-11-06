use super::*;
use crate::tailscale::api::testing::{api_requests, reply, serve, test_state_at, TAILNET};

#[tokio::test]
async fn webhook_creation_and_rotation_return_the_secret_without_persisting_it() {
    let (base, seen) = serve(|_| reply(200, r#"{"endpointId":"abc","secret":"one-time-secret"}"#)).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("changes.jsonl");
    let state = test_state_at(&base, path.clone());
    let body = json!({"endpointUrl":"https://example.test/hook","providerType":"slack","subscriptions":["nodeCreated"]});
    let result = call(&state, TAILNET, "webhookCreate", "", body.clone(), Value::Null, "").await.unwrap();
    assert_eq!(result["secret"], "one-time-secret");
    call(&state, TAILNET, "webhookRotate", "abc", Value::Null, Value::Null, "").await.unwrap();
    let requests = api_requests(&seen);
    assert_eq!(requests[0].path, "/api/v2/tailnet/-/webhooks");
    assert_eq!(requests[0].headers["authorization"], "Bearer tok-webhooks");
    assert_eq!(serde_json::from_str::<Value>(&requests[0].body).unwrap(), body);
    assert_eq!(requests[1].path, "/api/v2/webhooks/abc/rotate");
    assert!(!std::fs::read_to_string(path).unwrap_or_default().contains("one-time-secret"));
}

#[tokio::test]
async fn posture_write_redacts_client_secret_from_change_history() {
    let (base, _) = serve(|_| reply(200, "{}")).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("changes.jsonl");
    let state = test_state_at(&base, path.clone());
    call(&state, TAILNET, "postureUpdate", "pid", json!({"clientSecret":"do-not-log"}), json!({"clientId":"before"}), "").await.unwrap();
    let log = std::fs::read_to_string(path).unwrap();
    assert!(!log.contains("do-not-log"));
    assert!(log.contains("[REDACTED]"));
}
