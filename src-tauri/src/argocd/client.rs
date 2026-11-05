//! ArgoCD API와 키체인 토큰 관리.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
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

#[cfg(test)]
#[derive(Default)]
struct MemoryStore(Mutex<HashMap<String, Token>>);

#[cfg(test)]
impl TokenStore for MemoryStore {
    fn get(&self, url: &str) -> Result<Option<Token>, AppError> {
        Ok(self.0.lock().unwrap().get(url).cloned())
    }
    fn set(&self, url: &str, token: &Token) -> Result<(), AppError> {
        self.0.lock().unwrap().insert(url.to_owned(), token.clone());
        Ok(())
    }
    fn delete(&self, url: &str) -> Result<(), AppError> {
        self.0.lock().unwrap().remove(url);
        Ok(())
    }
}

/// 서버별 토큰 캐시와 HTTP 클라이언트, 열린 스트림, 로컬 기록 파일 위치.
pub struct ArgocdState {
    client: Client,
    /// 스트림(감시·로그)용. 전체 시간 제한 없이 연결 시간만 제한한다.
    stream_client: Client,
    tokens: Mutex<HashMap<String, Token>>,
    store: Arc<dyn TokenStore>,
    store_lock: tokio::sync::Mutex<()>,
    streams: Mutex<HashMap<u64, tokio::task::AbortHandle>>,
    next_stream: AtomicU64,
    /// 변경 기록(`argocd-changes.jsonl`)과 상태 변화 기록(`argocd-events.jsonl`)을 두는 앱 데이터 폴더.
    data_dir: PathBuf,
    events: Mutex<super::events::Recorder>,
}

impl ArgocdState {
    /// `data_dir`은 앱 데이터 폴더.
    pub fn new(data_dir: PathBuf) -> Self {
        Self::with_store(Arc::new(Keychain), data_dir)
    }

    #[cfg(test)]
    pub(crate) fn in_memory(data_dir: PathBuf, url: &str, token: String) -> Self {
        let store = Arc::new(MemoryStore::default());
        store.set(account(url), &Token(token)).unwrap();
        Self::with_store(store, data_dir)
    }

    fn with_store(store: Arc<dyn TokenStore>, data_dir: PathBuf) -> Self {
        crate::k8s::tls::install_crypto_provider();
        Self {
            client: Client::builder().timeout(Duration::from_secs(15)).build().expect("HTTP client"),
            stream_client: Client::builder().connect_timeout(Duration::from_secs(15)).build().expect("HTTP client"),
            tokens: Mutex::new(HashMap::new()),
            store,
            store_lock: tokio::sync::Mutex::new(()),
            streams: Mutex::new(HashMap::new()),
            next_stream: AtomicU64::new(1),
            data_dir,
            events: Mutex::new(super::events::Recorder::default()),
        }
    }

    /// 앱에서 보낸 변경의 기록 파일.
    pub fn changes_path(&self) -> PathBuf {
        self.data_dir.join("argocd-changes.jsonl")
    }

    /// 감시 중 본 상태 변화의 기록 파일.
    pub fn events_path(&self) -> PathBuf {
        self.data_dir.join("argocd-events.jsonl")
    }

    pub(super) fn recorder(&self) -> &Mutex<super::events::Recorder> {
        &self.events
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

fn request_url(base: &str, segments: &[&str], query: &[(&str, &str)]) -> Result<Url, AppError> {
    let mut url = Url::parse(base).map_err(|_| AppError::other(URL_ERROR))?;
    {
        let mut path = url.path_segments_mut().map_err(|_| AppError::other(URL_ERROR))?;
        path.pop_if_empty();
        path.extend(segments.iter().copied());
    }
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query.iter().copied());
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
        self.request_optional(method, url, token, body, false).await?.ok_or_else(|| AppError::other(RESPONSE_ERROR))
    }

    async fn request_optional(&self, method: Method, url: Url, token: Option<&Token>, body: Option<&Value>, allow_not_found: bool) -> Result<Option<Value>, AppError> {
        // ArgoCD 서버는 GET이 아닌 요청에 Content-Type이 없으면 본문이 없어도 415로 거절한다(DELETE 포함).
        let needs_type = method != Method::GET;
        let mut request = self.client.request(method, url);
        if let Some(token) = token {
            request = request.bearer_auth(&token.0);
        }
        if let Some(body) = body {
            request = request.json(body);
        } else if needs_type {
            request = request.header(reqwest::header::CONTENT_TYPE, "application/json");
        }
        let response = request.send().await.map_err(network_error)?;
        let status = response.status();
        if allow_not_found && status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let bytes = response.bytes().await.map_err(network_error)?;
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(response_error(status, &value));
        }
        if value.is_null() {
            return Err(AppError::other(RESPONSE_ERROR));
        }
        Ok(Some(value))
    }

    async fn session_for(&self, url: &str, token: &Token) -> Result<ArgocdSession, AppError> {
        let info = self.request(Method::GET, request_url(url, &["api", "v1", "session", "userinfo"], &[])?, Some(token), None).await?;
        let username = username(&info)?;
        let version = self.request(Method::GET, request_url(url, &["api", "version"], &[])?, None, None).await?;
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

    /// 저장된 토큰으로 API 요청을 보낸다. `query`는 순서대로 붙는다(같은 키를 여러 번 넣어도 된다).
    pub async fn api(&self, url: &str, method: Method, segments: &[&str], query: &[(&str, &str)], body: Option<&Value>) -> Result<Value, AppError> {
        let token = self.token(url).await?.ok_or_else(|| AppError::other(ARGOCD_TOKEN_MISSING))?;
        self.request(method, request_url(url, segments, query)?, Some(&token), body).await
    }

    pub async fn api_optional(&self, url: &str, method: Method, segments: &[&str], query: &[(&str, &str)], body: Option<&Value>) -> Result<Option<Value>, AppError> {
        let token = self.token(url).await?.ok_or_else(|| AppError::other(ARGOCD_TOKEN_MISSING))?;
        self.request_optional(method, request_url(url, segments, query)?, Some(&token), body, true).await
    }

    /// 저장된 토큰으로 스트림 응답(서버 전송 이벤트·로그)을 연다. 성공 상태가 아니면 본문의 메시지로 실패한다.
    pub async fn open_stream(&self, url: &str, segments: &[&str], query: &[(&str, &str)]) -> Result<reqwest::Response, AppError> {
        let token = self.token(url).await?.ok_or_else(|| AppError::other(ARGOCD_TOKEN_MISSING))?;
        let response = self.stream_client.get(request_url(url, segments, query)?).bearer_auth(&token.0).send().await.map_err(network_error)?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let bytes = response.bytes().await.map_err(network_error)?;
        Err(response_error(status, &serde_json::from_slice(&bytes).unwrap_or(Value::Null)))
    }

    /// 새 스트림 번호.
    pub fn next_stream_id(&self) -> u64 {
        self.next_stream.fetch_add(1, Ordering::Relaxed)
    }

    /// 스트림 작업을 등록해 `stop_stream`으로 멈출 수 있게 한다.
    pub fn track_stream(&self, id: u64, handle: tokio::task::AbortHandle) {
        self.streams.lock().unwrap_or_else(|e| e.into_inner()).insert(id, handle);
    }

    /// 끝난 스트림을 목록에서 뺀다.
    pub fn untrack_stream(&self, id: u64) {
        self.streams.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }

    /// 스트림 작업을 멈춘다. 이미 끝났으면 아무것도 하지 않는다.
    pub fn stop_stream(&self, id: u64) {
        if let Some(handle) = self.streams.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
            handle.abort();
        }
    }
}

#[cfg(test)]
mod tests;
