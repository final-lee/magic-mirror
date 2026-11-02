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
    let url = request_url("https://example.test/base/", &["api", "v1", "applications", "a/b"], Some("name space"), Some("hard")).unwrap();
    assert_eq!(url.as_str(), "https://example.test/base/api/v1/applications/a%2Fb?appNamespace=name+space&refresh=hard");
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
    crate::k8s::tls::install_crypto_provider();
    let state = ArgocdState {
        client: Client::new(),
        tokens: Mutex::new(HashMap::new()),
        store: Arc::new(store),
        store_lock: tokio::sync::Mutex::new(()),
    };
    assert_eq!(state.api(&url, Method::GET, &["api"], None, None, None).await.unwrap_err(), AppError::other(ARGOCD_TOKEN_MISSING));
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
    crate::k8s::tls::install_crypto_provider();
    let state = ArgocdState {
        client: Client::new(),
        tokens: Mutex::new(HashMap::new()),
        store: Arc::new(FailingStore),
        store_lock: tokio::sync::Mutex::new(()),
    };
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
