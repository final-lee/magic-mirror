use super::*;
use crate::tailscale::api::testing::{api_requests, reply, serve, test_state_at, TAILNET};

#[tokio::test]
async fn lists_all_pages_and_creates_with_tailnets_scope() {
    let (base, seen) = serve(|request| {
        if request.method == "POST" { reply(200, r#"{"id":"T3","oauthClient":{"secret":"once"}}"#) }
        else if request.path.contains("cursor=") { reply(200, r#"{"tailnets":[{"id":"T2"}]}"#) }
        else { reply(200, r#"{"tailnets":[{"id":"T1"}],"cursor":"next/="}"#) }
    }).await;
    let dir = tempfile::tempdir().unwrap();
    let state = test_state_at(&base, dir.path().join("changes.jsonl"));
    assert_eq!(list(&state, TAILNET).await.unwrap().len(), 2);
    let created = create(&state, TAILNET, "Staging").await.unwrap();
    assert_eq!(created["oauthClient"]["secret"], "once");
    let requests = api_requests(&seen);
    assert_eq!(requests[0].path, "/api/v2/organizations/-/tailnets");
    assert_eq!(requests[1].path, "/api/v2/organizations/-/tailnets?cursor=next%2F%3D");
    assert_eq!(requests[2].headers["authorization"], "Bearer tok-tailnets");
    assert_eq!(serde_json::from_str::<Value>(&requests[2].body).unwrap(), json!({"displayName":"Staging"}));
}

#[tokio::test]
async fn deletion_exchanges_a_target_tailnet_token_and_requires_the_name() {
    let (base, seen) = serve(|_| reply(200, "{}")).await;
    let dir = tempfile::tempdir().unwrap();
    let state = test_state_at(&base, dir.path().join("changes.jsonl"));
    assert!(delete(&state, TAILNET, "T123", "Staging", "wrong").await.is_err());
    assert!(seen.lock().unwrap().is_empty());
    delete(&state, TAILNET, "T123", "Staging", "Staging").await.unwrap();
    let requests = seen.lock().unwrap();
    let exchange = requests.iter().find(|request| request.path.ends_with("/oauth/token")).unwrap();
    let url = reqwest::Url::parse(&format!("http://localhost/?{}", exchange.body)).unwrap();
    let fields: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(fields.get("tailnet").map(String::as_str), Some("T123"));
    assert_eq!(fields.get("scope").map(String::as_str), Some("all"));
    let delete = requests.iter().find(|request| request.method == "DELETE").unwrap();
    assert_eq!(delete.path, "/api/v2/tailnet/T123");
}
