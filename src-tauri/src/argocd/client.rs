//! ArgoCD API와 키체인 토큰 관리.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::{Client, Method, StatusCode, Url};
use serde::Serialize;
use serde_json::Value;

use crate::error::AppError;

/// 만료됐거나 유효하지 않은 토큰 안내.
pub const ARGOCD_TOKEN_INVALID: &str = "ArgoCD 토큰이 만료됐거나 맞지 않아요. 새 토큰을 넣어 주세요";
/// 저장된 토큰이 없을 때 안내.
pub const ARGOCD_TOKEN_MISSING: &str = "이 ArgoCD 서버의 토큰을 넣어 주세요";
/// 서버 연결 실패 안내.
pub const ARGOCD_NETWORK: &str = "ArgoCD 서버에 닿지 못했어요. Tailscale·VPN 연결을 확인해 주세요";
/// 키체인 접근 실패 안내.
pub const KEYCHAIN_ERROR: &str = "ArgoCD 토큰을 키체인에서 처리하지 못했어요";
/// 서버 응답을 읽을 수 없을 때 안내.
pub const RESPONSE_ERROR: &str = "ArgoCD 서버 응답을 읽지 못했어요";
/// 서버 주소가 올바르지 않을 때 안내.
pub const URL_ERROR: &str = "ArgoCD 서버 주소가 올바르지 않아요";
const SERVICE: &str = "magic-mirror.argocd";

#[derive(Clone)]
struct Token(String);

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token([REDACTED])")
    }
}

/// 서버별 토큰의 영구 저장소. 호출은 블로킹 작업에서만 한다.
trait TokenStore: Send + Sync {
    fn get(&self, url: &str) -> Result<Option<Token>, AppError>;
    fn set(&self, url: &str, token: &Token) -> Result<(), AppError>;
    fn delete(&self, url: &str) -> Result<(), AppError>;
}

struct Keychain;

impl TokenStore for Keychain {
    fn get(&self, url: &str) -> Result<Option<Token>, AppError> {
        let entry = keyring::Entry::new(SERVICE, url).map_err(|_| AppError::other(KEYCHAIN_ERROR))?;
        match entry.get_password() {
            Ok(token) => Ok(Some(Token(token))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(AppError::other(KEYCHAIN_ERROR)),
        }
    }

    fn set(&self, url: &str, token: &Token) -> Result<(), AppError> {
        keyring::Entry::new(SERVICE, url)
            .and_then(|entry| entry.set_password(&token.0))
            .map_err(|_| AppError::other(KEYCHAIN_ERROR))
    }

    fn delete(&self, url: &str) -> Result<(), AppError> {
        let entry = keyring::Entry::new(SERVICE, url).map_err(|_| AppError::other(KEYCHAIN_ERROR))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AppError::other(KEYCHAIN_ERROR)),
        }
    }
}

/// 서버별 토큰 캐시와 HTTP 클라이언트.
pub struct ArgocdState {
    client: Client,
    tokens: Mutex<HashMap<String, Token>>,
    store: Arc<dyn TokenStore>,
    store_lock: tokio::sync::Mutex<()>,
}

impl Default for ArgocdState {
    fn default() -> Self {
        crate::k8s::tls::install_crypto_provider();
        Self {
            client: Client::builder().timeout(Duration::from_secs(15)).build().expect("HTTP client"),
            tokens: Mutex::new(HashMap::new()),
            store: Arc::new(Keychain),
            store_lock: tokio::sync::Mutex::new(()),
        }
    }
}

/// 인증된 서버 정보.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgocdSession {
    pub url: String,
    pub username: String,
    pub version: String,
}

fn account(url: &str) -> &str {
    url.trim_end_matches('/')
}

fn request_url(base: &str, segments: &[&str], namespace: Option<&str>, refresh: Option<&str>) -> Result<Url, AppError> {
    let mut url = Url::parse(base).map_err(|_| AppError::other(URL_ERROR))?;
    {
        let mut path = url.path_segments_mut().map_err(|_| AppError::other(URL_ERROR))?;
        path.pop_if_empty();
        path.extend(segments.iter().copied());
    }
    if namespace.is_some() || refresh.is_some() {
        let mut query = url.query_pairs_mut();
        if let Some(ns) = namespace {
            query.append_pair("appNamespace", ns);
        }
        if let Some(value) = refresh {
            query.append_pair("refresh", value);
        }
    }
    Ok(url)
}

fn response_error(status: StatusCode, body: &Value) -> AppError {
    if status == StatusCode::UNAUTHORIZED {
        return AppError::other(ARGOCD_TOKEN_INVALID);
    }
    AppError::other(body.get("message").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned).unwrap_or_else(|| status.to_string()))
}

fn network_error(error: reqwest::Error) -> AppError {
    use std::error::Error;

    let mut cause: Option<&(dyn Error + 'static)> = Some(&error);
    let mut detail = String::new();
    while let Some(current) = cause {
        detail.push_str(&current.to_string().to_lowercase());
        detail.push(' ');
        cause = current.source();
    }
    let reason = if error.is_timeout() || detail.contains("timed out") {
        "시간 초과"
    } else if detail.contains("dns") || detail.contains("resolve") || detail.contains("name or service") {
        "DNS 오류"
    } else if detail.contains("tls") || detail.contains("certificate") || detail.contains("ssl") {
        "TLS 오류"
    } else if detail.contains("refused") {
        "연결 거부"
    } else {
        "연결 오류"
    };
    AppError::Network {
        message: format!("{ARGOCD_NETWORK} ({reason})"),
    }
}

fn username(body: &Value) -> Result<String, AppError> {
    if body.get("loggedIn").and_then(Value::as_bool) != Some(true) {
        return Err(AppError::other(ARGOCD_TOKEN_INVALID));
    }
    body.get("username").and_then(Value::as_str).map(str::to_owned).ok_or_else(|| AppError::other(RESPONSE_ERROR))
}

impl ArgocdState {
    async fn token(&self, url: &str) -> Result<Option<Token>, AppError> {
        let url = account(url);
        if let Some(token) = self.tokens.lock().map_err(|_| AppError::other(KEYCHAIN_ERROR))?.get(url).cloned() {
            return Ok(Some(token));
        }
        let _guard = self.store_lock.lock().await;
        if let Some(token) = self.tokens.lock().map_err(|_| AppError::other(KEYCHAIN_ERROR))?.get(url).cloned() {
            return Ok(Some(token));
        }
        let store = Arc::clone(&self.store);
        let key = url.to_owned();
        let token = tokio::task::spawn_blocking(move || store.get(&key)).await.map_err(|_| AppError::other(KEYCHAIN_ERROR))??;
        if let Some(token) = &token {
            self.tokens.lock().map_err(|_| AppError::other(KEYCHAIN_ERROR))?.insert(url.to_owned(), token.clone());
        }
        Ok(token)
    }

    async fn request(&self, method: Method, url: Url, token: Option<&Token>, body: Option<&Value>) -> Result<Value, AppError> {
        let mut request = self.client.request(method, url);
        if let Some(token) = token {
            request = request.bearer_auth(&token.0);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(network_error)?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(network_error)?;
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(response_error(status, &value));
        }
        if value.is_null() {
            return Err(AppError::other(RESPONSE_ERROR));
        }
        Ok(value)
    }

    async fn session_for(&self, url: &str, token: &Token) -> Result<ArgocdSession, AppError> {
        let info = self.request(Method::GET, request_url(url, &["api", "v1", "session", "userinfo"], None, None)?, Some(token), None).await?;
        let username = username(&info)?;
        let version = self.request(Method::GET, request_url(url, &["api", "version"], None, None)?, None, None).await?;
        let version = version.get("Version").and_then(Value::as_str).ok_or_else(|| AppError::other(RESPONSE_ERROR))?.to_owned();
        Ok(ArgocdSession {
            url: account(url).to_owned(),
            username,
            version,
        })
    }

    /// 토큰을 서버에서 검증한 뒤 키체인과 캐시에 저장한다.
    pub async fn set_token(&self, url: &str, token: String) -> Result<ArgocdSession, AppError> {
        let token = Token(token);
        let session = self.session_for(url, &token).await?;
        self.save_token(url, token).await?;
        Ok(session)
    }

    async fn save_token(&self, url: &str, token: Token) -> Result<(), AppError> {
        let _guard = self.store_lock.lock().await;
        let store = Arc::clone(&self.store);
        let key = account(url).to_owned();
        let saved_token = token.clone();
        let saved_key = key.clone();
        tokio::task::spawn_blocking(move || store.set(&saved_key, &saved_token)).await.map_err(|_| AppError::other(KEYCHAIN_ERROR))??;
        self.tokens.lock().map_err(|_| AppError::other(KEYCHAIN_ERROR))?.insert(key, token);
        Ok(())
    }

    /// 키체인과 캐시에서 서버 토큰을 지운다.
    pub async fn forget_token(&self, url: &str) -> Result<(), AppError> {
        let _guard = self.store_lock.lock().await;
        let store = Arc::clone(&self.store);
        let key = account(url).to_owned();
        let stored_key = key.clone();
        tokio::task::spawn_blocking(move || store.delete(&stored_key)).await.map_err(|_| AppError::other(KEYCHAIN_ERROR))??;
        self.tokens.lock().map_err(|_| AppError::other(KEYCHAIN_ERROR))?.remove(&key);
        Ok(())
    }

    /// 저장된 토큰이 있으면 서버에서 세션을 확인한다.
    pub async fn session(&self, url: &str) -> Result<Option<ArgocdSession>, AppError> {
        match self.token(url).await? {
            Some(token) => self.session_for(url, &token).await.map(Some),
            None => Ok(None),
        }
    }

    /// 저장된 토큰으로 API 요청을 보낸다.
    pub async fn api(&self, url: &str, method: Method, segments: &[&str], namespace: Option<&str>, refresh: Option<&str>, body: Option<&Value>) -> Result<Value, AppError> {
        let token = self.token(url).await?.ok_or_else(|| AppError::other(ARGOCD_TOKEN_MISSING))?;
        self.request(method, request_url(url, segments, namespace, refresh)?, Some(&token), body).await
    }
}

#[cfg(test)]
mod tests;
