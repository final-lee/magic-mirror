use serde_json::json;
use super::*;
use crate::tailscale::api::testing::{api_requests, reply, serve, test_state_at, TAILNET};

#[tokio::test]
async fn writes_service_and_sends_approval_with_both_required_scopes() {
    let (base, seen) = serve(|request| {
        if request.method == "GET" { reply(200, r#"{"approved":false,"autoApproved":false}"#) } else { reply(200, "{}") }
    }).await;
    let dir = tempfile::tempdir().unwrap();
    let state = test_state_at(&base, dir.path().join("changes.jsonl"));
    let body = json!({"name":"svc:web","addrs":[],"ports":["tcp:443"],"tags":["tag:web"],"comment":"web"});
    put(&state, TAILNET, "svc:web", body.clone(), None).await.unwrap();
    set_approval(&state, TAILNET, "svc:web", "node1", true).await.unwrap();
    let requests = api_requests(&seen);
    assert_eq!(requests[0].method, "PUT");
    assert_eq!(requests[0].path, "/api/v2/tailnet/-/services/svc%3Aweb");
    assert_eq!(requests[0].headers["authorization"], "Bearer tok-services");
    assert_eq!(serde_json::from_str::<Value>(&requests[0].body).unwrap(), body);
    assert_eq!(requests[2].path, "/api/v2/tailnet/-/services/svc%3Aweb/device/node1/approved");
    assert_eq!(requests[2].headers["authorization"], "Bearer tok-services devices:core");
    assert_eq!(serde_json::from_str::<Value>(&requests[2].body).unwrap(), json!({"approved":true}));
    assert_eq!(changes::list(state.changes_path()).len(), 2);
}

#[tokio::test]
async fn delete_requires_the_exact_name_before_request() {
    let (base, seen) = serve(|_| reply(200, "{}")).await;
    let dir = tempfile::tempdir().unwrap();
    let state = test_state_at(&base, dir.path().join("changes.jsonl"));
    assert!(delete(&state, TAILNET, "svc:web", "web", json!({})).await.is_err());
    assert!(api_requests(&seen).is_empty());
}
