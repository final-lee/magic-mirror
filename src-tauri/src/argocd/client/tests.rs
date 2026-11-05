use std::sync::Arc;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;

#[derive(Default)]
struct MemoryStore(Arc<Mutex<HashMap<String, Token>>>);

impl TokenStore for MemoryStore {
    fn get(&self, url: &str) -> Result<Option<Token>, AppError> {
        Ok(self.0.lock().unwrap().get(url).cloned())
    }

    fn set(&self, url: &str, token: &Token) -> Result<(), AppError> {
        self.0.lock().unwrap().insert(url.into(), token.clone());
        Ok(())
    }

    fn delete(&self, url: &str) -> Result<(), AppError> {
        self.0.lock().unwrap().remove(url);
        Ok(())
    }
}

#[test]
fn argocd_url_and_errors() {
    let url = request_url("https://example.test/base/", &["api", "v1", "applications", "a/b"], &[("appNamespace", "name space"), ("refresh", "hard")]).unwrap();
    assert_eq!(url.as_str(), "https://example.test/base/api/v1/applications/a%2Fb?appNamespace=name+space&refresh=hard");
    assert_eq!(request_url("https://example.test", &["api", "version"], &[]).unwrap().as_str(), "https://example.test/api/version");
    assert_eq!(response_error(StatusCode::UNAUTHORIZED, &json!({"message":"ignored"})), AppError::other(ARGOCD_TOKEN_INVALID));
    assert_eq!(response_error(StatusCode::CONFLICT, &json!({"message":"busy"})), AppError::other("busy"));
    assert_eq!(response_error(StatusCode::BAD_REQUEST, &Value::Null), AppError::other("400 Bad Request"));
    assert_eq!(username(&json!({"loggedIn":false})), Err(AppError::other(ARGOCD_TOKEN_INVALID)));
    assert_eq!(username(&json!({"loggedIn":true,"username":"admin"})).unwrap(), "admin");
    assert!(!format!("{:?}", Token("secret".into())).contains("secret"));
}

#[tokio::test]
async fn argocd_token_store_validates_before_saving() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        for body in [r#"{"loggedIn":false}"#, r#"{"loggedIn":true,"username":"admin"}"#, r#"{"Version":"v3"}"#] {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = [0; 4096];
            let _ = stream.read(&mut buf).await.unwrap();
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    let store = MemoryStore::default();
    let contents = store.0.clone();
    let state = ArgocdState::with_store(Arc::new(store), std::env::temp_dir());
    assert_eq!(state.api(&url, Method::GET, &["api"], &[], None).await.unwrap_err(), AppError::other(ARGOCD_TOKEN_MISSING));
    assert!(state.session(&url).await.unwrap().is_none());
    assert!(state.set_token(&url, "invalid".into()).await.is_err());
    assert!(contents.lock().unwrap().is_empty());
    let session = state.set_token(&format!("{url}/"), "secret".into()).await.unwrap();
    assert_eq!(session.version, "v3");
    assert_eq!(contents.lock().unwrap().get(&url).unwrap().0, "secret");
    state.forget_token(&url).await.unwrap();
    assert!(state.tokens.lock().unwrap().is_empty());
    assert!(contents.lock().unwrap().is_empty());
    server.await.unwrap();
}

struct FailingStore;

impl TokenStore for FailingStore {
    fn get(&self, _: &str) -> Result<Option<Token>, AppError> {
        Ok(None)
    }

    fn set(&self, _: &str, _: &Token) -> Result<(), AppError> {
        Err(AppError::other(KEYCHAIN_ERROR))
    }

    fn delete(&self, _: &str) -> Result<(), AppError> {
        Ok(())
    }
}

#[tokio::test]
async fn argocd_store_failure_does_not_cache() {
    let state = ArgocdState::with_store(Arc::new(FailingStore), std::env::temp_dir());
    assert!(state.save_token("https://example.test/", Token("secret".into())).await.is_err());
    assert!(state.tokens.lock().unwrap().is_empty());
}

#[tokio::test]
async fn argocd_network_error_reports_cause() {
    crate::k8s::tls::install_crypto_provider();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let error = Client::new().get(format!("http://{address}/")).send().await.unwrap_err();
    match network_error(error) {
        AppError::Network { message } => {
            assert!(message.contains(ARGOCD_NETWORK));
            assert!(message.contains("연결 거부"));
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[tokio::test]
async fn argocd_optional_live_read_only_treats_404_as_missing() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        for (status, body) in [("404 Not Found", r#"{"message":"missing"}"#), ("403 Forbidden", r#"{"message":"denied"}"#), ("500 Internal Server Error", r#"{"message":"failed"}"#)] {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = [0; 4096];
            let _ = stream.read(&mut buf).await.unwrap();
            let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    let store = MemoryStore::default();
    store.0.lock().unwrap().insert(url.clone(), Token("token".into()));
    let state = ArgocdState::with_store(Arc::new(store), std::env::temp_dir());
    assert!(state.api_optional(&url, Method::GET, &["resource"], &[], None).await.unwrap().is_none());
    assert_eq!(state.api_optional(&url, Method::GET, &["resource"], &[], None).await.unwrap_err(), AppError::other("denied"));
    assert_eq!(state.api_optional(&url, Method::GET, &["resource"], &[], None).await.unwrap_err(), AppError::other("failed"));
    server.await.unwrap();
}

#[tokio::test]
async fn argocd_bodyless_delete_sends_json_content_type() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = [0; 4096];
        let n = stream.read(&mut buf).await.unwrap();
        let request = String::from_utf8_lossy(&buf[..n]).to_lowercase();
        let (status, body) = if request.starts_with("delete ") && request.contains("content-type: application/json") { ("200 OK", "{}") } else { ("415 Unsupported Media Type", r#"{"message":"Invalid content type"}"#) };
        let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    let store = MemoryStore::default();
    store.0.lock().unwrap().insert(url.clone(), Token("token".into()));
    let state = ArgocdState::with_store(Arc::new(store), std::env::temp_dir());
    state.api(&url, Method::DELETE, &["api", "v1", "applications", "a", "operation"], &[], None).await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn argocd_apply_checks_versions_and_confirmation_and_records_results() {
    use crate::argocd::change::{self, ArgoChange, ArgoTarget};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        for (status, body) in [
            ("200 OK", r#"{"username":"alice"}"#), ("200 OK", r#"{"metadata":{"resourceVersion":"2"}}"#),
            ("200 OK", r#"{"username":"alice"}"#), ("200 OK", r#"{"metadata":{"resourceVersion":"2"}}"#),
            ("200 OK", r#"{"username":"alice"}"#), ("200 OK", r#"{"metadata":{"resourceVersion":"2"}}"#), ("200 OK", r#"{}"#),
            ("200 OK", r#"{"username":"alice"}"#), ("200 OK", r#"{"metadata":{"resourceVersion":"2"}}"#), ("500 Error", r#"{"message":"실패"}"#),
        ] {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = [0; 8192];
            let _ = stream.read(&mut buf).await.unwrap();
            let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let store = MemoryStore::default();
    store.0.lock().unwrap().insert(url.clone(), Token("secret".into()));
    let state = ArgocdState::with_store(Arc::new(store), dir.path().to_owned());
    let target = ArgoTarget { namespace: "argocd".into(), name: "web".into(), project: "default".into(), env: None };
    let change = ArgoChange::AppDelete { cascade: false, propagation_policy: None };
    let version = change::fingerprint(&json!({"metadata":{"resourceVersion":"2"}}));
    assert!(change::apply(&state, &url, &target, &change, Some("stale".into()), Some("web".into())).await.is_err());
    assert!(change::apply(&state, &url, &target, &change, Some(version.clone()), Some("wrong".into())).await.is_err());
    assert!(change::apply(&state, &url, &target, &change, Some(version.clone()), Some("web".into())).await.is_ok());
    assert!(change::apply(&state, &url, &target, &change, Some(version), Some("web".into())).await.is_err());
    let records = change::changes(&state, &url);
    assert_eq!(records.iter().map(|r| r.ok).collect::<Vec<_>>(), vec![false, false, true, false]);
    assert_eq!(records[0].error.as_deref(), Some("요청을 완료하지 못했어요"));
    assert_eq!(records[1].error.as_deref(), Some("요청을 완료하지 못했어요"));
    assert_eq!(records[2].user.as_deref(), Some("alice"));
    server.await.unwrap();
}
