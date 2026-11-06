//! Tailscale API 공통 기반: 키체인 자격 증명, OAuth 토큰 교환과 캐시, 요청 보내기.
//!
//! 기기·경로·정책·키·로그 화면은 [`TailscaleState::request`]나 [`TailscaleState::get_json`]만 부른다.
//! 자격 증명 종류(OAuth 클라이언트 / API 액세스 토큰)와 토큰 교환은 여기서 숨긴다.
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;

#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) mod testing;

/// Tailscale API 주소. 시험에서는 로컬 서버로 바꾼다.
pub const API_BASE: &str = "https://api.tailscale.com/api/v2";
const SERVICE: &str = "magic-mirror.tailscale";
/// OAuth 토큰을 만료 이 시간 전까지만 쓴다.
const TOKEN_MARGIN: Duration = Duration::from_secs(60);

/// 자격 증명이 만료됐거나 맞지 않을 때 안내.
pub const CREDENTIAL_INVALID: &str = "자격 증명이 만료됐거나 맞지 않아요";
/// 저장된 자격 증명이 없을 때 안내.
pub const NOT_CONNECTED: &str = "Tailscale API를 연결해 주세요";
/// 서버에 닿지 못했을 때 안내.
pub const NETWORK: &str = "Tailscale API에 닿지 못했어요. 인터넷 연결을 확인해 주세요";
/// 키체인 접근 실패 안내.
pub const KEYCHAIN_ERROR: &str = "Tailscale 자격 증명을 키체인에서 처리하지 못했어요";
/// 응답을 읽을 수 없을 때 안내.
pub const RESPONSE_ERROR: &str = "Tailscale API 응답을 읽지 못했어요";
/// `If-Match`가 맞지 않을 때(412) 안내. 정책 저장이 쓴다.
pub const CHANGED_ELSEWHERE: &str = "다른 곳에서 정책이 바뀌었어요. 다시 불러와 주세요";
/// 테일넷 이름이 비었을 때 안내.
pub const TAILNET_MISSING: &str = "테일넷 이름을 넣어 주세요";
/// 자격 증명 값이 비었을 때 안내.
pub const CREDENTIAL_MISSING: &str = "자격 증명을 빠짐없이 넣어 주세요";
/// 요금제에서 쓸 수 없는 기능을 불렀을 때(403, 서버 메시지에 `billing plan`) 안내.
pub const PLAN_UNAVAILABLE: &str = "이 테일넷의 요금제에서는 쓸 수 없는 기능이에요";

fn lacks_scope(scope: &str) -> AppError {
    AppError::other(format!("이 자격 증명에 {scope} 권한이 없어요"))
}

/// 키체인 값이자 연결 명령의 입력. 키체인에는 이 JSON 한 줄을 그대로 둔다.
/// `Debug`는 값을 가린다.
#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Credential {
    Oauth {
        #[serde(rename = "clientId")]
        client_id: String,
        #[serde(rename = "clientSecret")]
        client_secret: String,
    },
    Token {
        token: String,
    },
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Credential::{}([REDACTED])", if matches!(self, Credential::Oauth { .. }) { "Oauth" } else { "Token" })
    }
}

impl Credential {
    fn kind(&self) -> &'static str {
        match self {
            Credential::Oauth { .. } => "oauth",
            Credential::Token { .. } => "token",
        }
    }

    /// 붙여넣을 때 딸려 온 공백을 걷어낸다. 빈 값이 있으면 `None`.
    fn trimmed(self) -> Option<Credential> {
        let credential = match self {
            Credential::Oauth { client_id, client_secret } => Credential::Oauth {
                client_id: client_id.trim().to_owned(),
                client_secret: client_secret.trim().to_owned(),
            },
            Credential::Token { token } => Credential::Token { token: token.trim().to_owned() },
        };
        let complete = match &credential {
            Credential::Oauth { client_id, client_secret } => !client_id.is_empty() && !client_secret.is_empty(),
            Credential::Token { token } => !token.is_empty(),
        };
        complete.then_some(credential)
    }
}

/// 테일넷별 자격 증명의 영구 저장소. 호출은 블로킹 작업에서만 한다.
trait CredentialStore: Send + Sync {
    fn get(&self, tailnet: &str) -> Result<Option<Credential>, AppError>;
    fn set(&self, tailnet: &str, credential: &Credential) -> Result<(), AppError>;
    fn delete(&self, tailnet: &str) -> Result<(), AppError>;
}

struct Keychain;

impl CredentialStore for Keychain {
    fn get(&self, tailnet: &str) -> Result<Option<Credential>, AppError> {
        let entry = keyring::Entry::new(SERVICE, tailnet).map_err(|_| AppError::other(KEYCHAIN_ERROR))?;
        match entry.get_password() {
            Ok(text) => serde_json::from_str(&text).map(Some).map_err(|_| AppError::other(KEYCHAIN_ERROR)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(AppError::other(KEYCHAIN_ERROR)),
        }
    }

    fn set(&self, tailnet: &str, credential: &Credential) -> Result<(), AppError> {
        let text = serde_json::to_string(credential).map_err(|_| AppError::other(KEYCHAIN_ERROR))?;
        keyring::Entry::new(SERVICE, tailnet)
            .and_then(|entry| entry.set_password(&text))
            .map_err(|_| AppError::other(KEYCHAIN_ERROR))
    }

    fn delete(&self, tailnet: &str) -> Result<(), AppError> {
        let entry = keyring::Entry::new(SERVICE, tailnet).map_err(|_| AppError::other(KEYCHAIN_ERROR))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AppError::other(KEYCHAIN_ERROR)),
        }
    }
}

/// 요청에 필요한 권한. 읽기는 `all:read`, 쓰기는 그 작업의 쓰기 스코프 하나(`devices:core`, `policy_file` 등).
/// OAuth 클라이언트에서만 뜻이 있고 API 액세스 토큰은 무시한다.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Scope {
    Read,
    Write(&'static str),
}

impl Scope {
    fn name(self) -> &'static str {
        match self {
            Scope::Read => "all:read",
            Scope::Write(name) => name,
        }
    }
}

#[derive(Default)]
enum Body {
    #[default]
    None,
    Json(Value),
    Text { content_type: String, text: String },
}

impl std::fmt::Debug for Body {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}

/// API 요청 하나. `path`는 `/api/v2` 뒤부터이고 테일넷은 언제나 `-`(자격 증명의 테일넷)다:
/// `Request::get("/tailnet/-/devices?fields=all")`.
/// 경로 조각(기기 ID 등)을 퍼센트 인코딩하는 건 부르는 쪽이다.
#[derive(Debug)]
pub struct Request<'a> {
    method: Method,
    path: &'a str,
    scope: Scope,
    body: Body,
    accept: Option<&'a str>,
    if_match: Option<String>,
    not_found_ok: bool,
}

impl<'a> Request<'a> {
    pub fn new(method: Method, path: &'a str, scope: Scope) -> Self {
        Self { method, path, scope, body: Body::None, accept: None, if_match: None, not_found_ok: false }
    }

    /// 읽기 스코프로 GET.
    pub fn get(path: &'a str) -> Self {
        Self::new(Method::GET, path, Scope::Read)
    }

    /// JSON 본문. 앞서 넣은 본문은 대체한다.
    pub fn json(mut self, value: Value) -> Self {
        self.body = Body::Json(value);
        self
    }

    /// 글 본문(HuJSON 정책 등). `Content-Type`을 직접 정한다. 앞서 넣은 본문은 대체한다.
    pub fn text(mut self, content_type: impl Into<String>, text: impl Into<String>) -> Self {
        self.body = Body::Text { content_type: content_type.into(), text: text.into() };
        self
    }

    /// `Accept` 헤더(예: 정책을 HuJSON으로 받을 때 `application/hujson`).
    pub fn accept(mut self, accept: &'a str) -> Self {
        self.accept = Some(accept);
        self
    }

    /// `If-Match` 헤더(정책 저장 때 읽어 둔 ETag).
    pub fn if_match(mut self, etag: impl Into<String>) -> Self {
        self.if_match = Some(etag.into());
        self
    }

    /// 404를 오류로 올리지 않고 `status == 404`인 응답으로 돌려준다. 아직 설정하지 않은 기능(로그 스트리밍 등)을 읽을 때 쓴다.
    pub fn allow_not_found(mut self) -> Self {
        self.not_found_ok = true;
        self
    }
}

/// 성공(2xx) 응답.

pub struct Response {
    pub status: u16,
    pub body: String,
    /// `ETag` 헤더. 정책처럼 `If-Match`로 되돌려 보낼 값.
    pub etag: Option<String>,
}

impl std::fmt::Debug for Response {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Response").field("status", &self.status).field("body", &"[REDACTED]").field("etag", &self.etag).finish()
    }
}

impl Response {
    pub fn json(&self) -> Result<Value, AppError> {
        serde_json::from_str(&self.body).map_err(|_| AppError::other(RESPONSE_ERROR))
    }
}

struct AccessToken {
    value: String,
    expires: Instant,
}

/// `연결` 확인 결과.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiConnection {
    pub devices: usize,
    /// 기기 이름(FQDN)에서 읽은 MagicDNS 접미사.
    pub magic_dns_suffix: Option<String>,
}

/// 테일넷의 키체인 자격 증명 상태.
#[derive(Debug, PartialEq, Serialize)]
pub struct ApiStatus {
    pub tailnet: Option<String>,
    pub kind: Option<&'static str>,
}

/// 테일넷별 자격 증명·OAuth 토큰 캐시와 HTTP 클라이언트.
pub struct TailscaleState {
    client: Client,
    base: String,
    store: Arc<dyn CredentialStore>,
    credentials: Mutex<HashMap<String, Credential>>,
    /// (테일넷, 스코프) → 토큰. 메모리에만 둔다.
    tokens: Mutex<HashMap<(String, String), AccessToken>>,
    store_lock: tokio::sync::Mutex<()>,
    changes_path: std::path::PathBuf,
}

impl Default for TailscaleState {
    fn default() -> Self {
        crate::k8s::tls::install_crypto_provider();
        Self {
            client: Client::builder().timeout(Duration::from_secs(20)).build().expect("HTTP client"),
            base: API_BASE.to_owned(),
            store: Arc::new(Keychain),
            credentials: Mutex::new(HashMap::new()),
            tokens: Mutex::new(HashMap::new()),
            store_lock: tokio::sync::Mutex::new(()),
            changes_path: std::path::PathBuf::new(),
        }
    }
}

/// 캐시는 잠금이 깨져도 값 자체는 멀쩡해서 그대로 이어 쓴다.
fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn account(tailnet: &str) -> &str {
    tailnet.trim()
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
    AppError::Network { message: format!("{NETWORK} ({reason})") }
}

fn body_message(body: &str, keys: &[&str]) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    keys.iter().find_map(|key| value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned))
}

fn redact_input_secrets(text: &mut String, value: &Value) {
    match value {
        Value::Object(fields) => for (key, value) in fields {
            let key = key.to_ascii_lowercase();
            if key.contains("secret") || key.contains("token") || key.contains("password") || key.contains("credentials") {
                if let Some(secret) = value.as_str().filter(|secret| !secret.is_empty()) {
                    *text = text.replace(secret, "[REDACTED]");
                }
            } else {
                redact_input_secrets(text, value);
            }
        },
        Value::Array(values) => for value in values { redact_input_secrets(text, value); },
        _ => (),
    }
}

/// API 응답의 오류. 401·412는 정해진 문구. 403은 요금제 제한이면 그 문구, 아니면 권한 문구에 서버가 밝힌 까닭을 붙인다.
/// 나머지는 본문의 `message`나 상태 코드.
fn response_error(status: StatusCode, body: &str, scope: &str) -> AppError {
    match status {
        StatusCode::UNAUTHORIZED => AppError::other(CREDENTIAL_INVALID),
        StatusCode::FORBIDDEN => match body_message(body, &["message"]) {
            Some(reason) if reason.to_lowercase().contains("billing plan") => AppError::other(PLAN_UNAVAILABLE),
            Some(reason) => AppError::other(format!("이 자격 증명에 {scope} 권한이 없어요 ({reason})")),
            None => lacks_scope(scope),
        },
        StatusCode::PRECONDITION_FAILED => AppError::other(CHANGED_ELSEWHERE),
        _ => AppError::other(body_message(body, &["message"]).unwrap_or_else(|| status.to_string())),
    }
}

/// OAuth 토큰 교환 오류. `invalid_client`는 자격 증명 문제, 스코프 거절은 권한 문제로 본다.
fn exchange_error(status: StatusCode, body: &str, scope: &str) -> AppError {
    let code = body_message(body, &["error"]);
    match code.as_deref() {
        Some("invalid_client") => return AppError::other(CREDENTIAL_INVALID),
        Some("invalid_scope" | "unauthorized_client" | "access_denied") => return lacks_scope(scope),
        _ => {}
    }
    match status {
        StatusCode::UNAUTHORIZED => AppError::other(CREDENTIAL_INVALID),
        StatusCode::FORBIDDEN => lacks_scope(scope),
        _ => AppError::other(body_message(body, &["error_description", "message", "error"]).unwrap_or_else(|| status.to_string())),
    }
}

fn form_body(pairs: &[(&str, &str)]) -> String {
    let mut url = Url::parse("http://localhost/").expect("static URL");
    url.query_pairs_mut().extend_pairs(pairs);
    url.query().unwrap_or_default().to_owned()
}

/// 기기 이름(FQDN)에서 호스트 이름을 뗀 나머지 중 가장 많은 것. 같으면 사전순 앞.
fn magic_dns_suffix(devices: &[Value]) -> Option<String> {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for name in devices.iter().filter_map(|device| device.get("name").and_then(Value::as_str)) {
        if let Some((_, suffix)) = name.trim_end_matches('.').split_once('.').filter(|(host, suffix)| !host.is_empty() && !suffix.is_empty()) {
            *counts.entry(suffix).or_default() += 1;
        }
    }
    counts.into_iter().max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0))).map(|(suffix, _)| suffix.to_owned())
}

impl TailscaleState {
    pub fn new(changes_path: std::path::PathBuf) -> Self {
        Self { changes_path, ..Self::default() }
    }

    pub fn changes_path(&self) -> &std::path::Path { &self.changes_path }

    async fn credential(&self, tailnet: &str) -> Result<Option<Credential>, AppError> {
        if let Some(credential) = locked(&self.credentials).get(tailnet).cloned() {
            return Ok(Some(credential));
        }
        let _guard = self.store_lock.lock().await;
        if let Some(credential) = locked(&self.credentials).get(tailnet).cloned() {
            return Ok(Some(credential));
        }
        let store = Arc::clone(&self.store);
        let key = tailnet.to_owned();
        let credential = tokio::task::spawn_blocking(move || store.get(&key)).await.map_err(|_| AppError::other(KEYCHAIN_ERROR))??;
        if let Some(credential) = &credential {
            locked(&self.credentials).insert(tailnet.to_owned(), credential.clone());
        }
        Ok(credential)
    }

    fn drop_tokens(&self, tailnet: &str) {
        locked(&self.tokens).retain(|(name, _), _| name != tailnet);
    }

    /// 요청 하나를 보내고 본문을 글로 읽는다. 전송 실패만 오류로 바꾼다.
    async fn send(&self, request: reqwest::RequestBuilder) -> Result<(StatusCode, Option<String>, String), AppError> {
        let response = request.send().await.map_err(network_error)?;
        let status = response.status();
        let etag = response.headers().get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_owned);
        let body = response.text().await.map_err(network_error)?;
        Ok((status, etag, body))
    }

    async fn exchange(&self, client_id: &str, client_secret: &str, scope: &str, target: Option<&str>) -> Result<AccessToken, AppError> {
        let body = match target {
            Some(target) => form_body(&[("client_id", client_id), ("client_secret", client_secret), ("scope", scope), ("tailnet", target)]),
            None => form_body(&[("client_id", client_id), ("client_secret", client_secret), ("scope", scope)]),
        };
        let request = self
            .client
            .post(format!("{}/oauth/token", self.base))
            .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(body);
        let (status, _, body) = self.send(request).await?;
        if !status.is_success() {
            return Err(exchange_error(status, &body.replace(client_secret, "[REDACTED]"), scope));
        }
        let value: Value = serde_json::from_str(&body).map_err(|_| AppError::other(RESPONSE_ERROR))?;
        let token = value.get("access_token").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| AppError::other(RESPONSE_ERROR))?;
        let lifetime = Duration::from_secs(value.get("expires_in").and_then(Value::as_u64).unwrap_or(0));
        Ok(AccessToken { value: token.to_owned(), expires: Instant::now() + lifetime.saturating_sub(TOKEN_MARGIN) })
    }

    /// 요청에 실을 Bearer 값. OAuth는 스코프별 토큰을 교환하고, `cache`가 테일넷이면 그 이름으로 캐시에 둔다.
    async fn bearer(&self, credential: &Credential, cache: Option<&str>, scope: &str) -> Result<String, AppError> {
        let (client_id, client_secret) = match credential {
            Credential::Token { token } => return Ok(token.clone()),
            Credential::Oauth { client_id, client_secret } => (client_id, client_secret),
        };
        let key = cache.map(|tailnet| (tailnet.to_owned(), scope.to_owned()));
        if let Some(key) = &key {
            if let Some(token) = locked(&self.tokens).get(key).filter(|t| Instant::now() < t.expires) {
                return Ok(token.value.clone());
            }
        }
        let token = self.exchange(client_id, client_secret, scope, None).await?;
        let value = token.value.clone();
        if let Some(key) = key {
            locked(&self.tokens).insert(key, token);
        }
        Ok(value)
    }

    async fn call(&self, credential: &Credential, cache: Option<&str>, request: &Request<'_>) -> Result<Response, AppError> {
        let scope = request.scope.name();
        let bearer = self.bearer(credential, cache, scope).await?;
        let mut builder = self.client.request(request.method.clone(), format!("{}{}", self.base, request.path)).bearer_auth(&bearer);
        if let Some(accept) = request.accept {
            builder = builder.header(reqwest::header::ACCEPT, accept);
        }
        if let Some(etag) = &request.if_match {
            builder = builder.header(reqwest::header::IF_MATCH, etag);
        }
        builder = match &request.body {
            Body::None => builder,
            Body::Json(value) => builder.json(value),
            Body::Text { content_type, text } => builder.header(reqwest::header::CONTENT_TYPE, content_type).body(text.clone()),
        };
        let (status, etag, body) = self.send(builder).await?;
        if !status.is_success() && !(request.not_found_ok && status == StatusCode::NOT_FOUND) {
            if status == StatusCode::UNAUTHORIZED {
                if let Some(tailnet) = cache {
                    locked(&self.tokens).remove(&(tailnet.to_owned(), scope.to_owned()));
                }
            }
            let mut safe_body = body.replace(&bearer, "[REDACTED]");
            if let Body::Json(value) = &request.body { redact_input_secrets(&mut safe_body, value); }
            return Err(response_error(status, &safe_body, scope));
        }
        Ok(Response { status: status.as_u16(), body, etag })
    }

    /// 키체인에 저장된 이 테일넷의 자격 증명으로 요청을 보낸다. 자격 증명이 없으면 부르지 않고 연결 안내 오류를 낸다.
    /// 오류: 401과 OAuth `invalid_client`는 자격 증명 오류, 403과 스코프 거절은 `request`의 스코프를 넣은 권한 오류,
    /// 전송 실패는 `AppError::Network`, 나머지 2xx 아닌 응답은 본문 `message`나 상태 코드.
    pub async fn request(&self, tailnet: &str, request: Request<'_>) -> Result<Response, AppError> {
        let tailnet = account(tailnet);
        let credential = self.credential(tailnet).await?.ok_or_else(|| AppError::other(NOT_CONNECTED))?;
        self.call(&credential, Some(tailnet), &request).await
    }

    /// 조직에서 만든 테일넷에 접근할 때는 해당 테일넷용 OAuth 토큰으로 교환한다.
    pub async fn request_for_tailnet(&self, source: &str, target: &str, request: Request<'_>) -> Result<Response, AppError> {
        let credential = self.credential(account(source)).await?.ok_or_else(|| AppError::other(NOT_CONNECTED))?;
        match &credential {
            Credential::Oauth { client_id, client_secret } => {
                let token = self.exchange(client_id, client_secret, request.scope.name(), Some(target)).await?;
                self.call(&Credential::Token { token: token.value }, None, &request).await
            }
            Credential::Token { .. } => self.call(&credential, None, &request).await,
        }
    }

    /// 읽기 스코프로 GET을 보내 JSON으로 읽는다.
    pub async fn get_json(&self, tailnet: &str, path: &str) -> Result<Value, AppError> {
        self.request(tailnet, Request::get(path)).await?.json()
    }

    /// 키체인에 이 테일넷의 자격 증명이 있는지와 종류.
    pub async fn status(&self, tailnet: Option<&str>) -> Result<ApiStatus, AppError> {
        let Some(tailnet) = tailnet.map(account).filter(|t| !t.is_empty()) else {
            return Ok(ApiStatus { tailnet: None, kind: None });
        };
        let kind = self.credential(tailnet).await?.map(|c| c.kind());
        Ok(ApiStatus { tailnet: Some(tailnet.to_owned()), kind })
    }

    /// 자격 증명으로 기기 목록을 한 번 읽어 확인한 뒤에만 키체인과 캐시에 저장한다.
    pub async fn connect(&self, tailnet: &str, credential: Credential) -> Result<ApiConnection, AppError> {
        let tailnet = account(tailnet);
        if tailnet.is_empty() {
            return Err(AppError::other(TAILNET_MISSING));
        }
        let credential = credential.trimmed().ok_or_else(|| AppError::other(CREDENTIAL_MISSING))?;
        let devices = self.call(&credential, None, &Request::get("/tailnet/-/devices")).await?.json()?;
        let devices = devices.get("devices").and_then(Value::as_array).ok_or_else(|| AppError::other(RESPONSE_ERROR))?;
        let connection = ApiConnection { devices: devices.len(), magic_dns_suffix: magic_dns_suffix(devices) };
        self.save(tailnet, credential).await?;
        Ok(connection)
    }

    async fn save(&self, tailnet: &str, credential: Credential) -> Result<(), AppError> {
        let _guard = self.store_lock.lock().await;
        let store = Arc::clone(&self.store);
        let key = tailnet.to_owned();
        let stored = credential.clone();
        tokio::task::spawn_blocking(move || store.set(&key, &stored)).await.map_err(|_| AppError::other(KEYCHAIN_ERROR))??;
        self.drop_tokens(tailnet);
        locked(&self.credentials).insert(tailnet.to_owned(), credential);
        Ok(())
    }

    /// 키체인 항목과 이 테일넷의 자격 증명·토큰 캐시를 지운다.
    pub async fn forget(&self, tailnet: &str) -> Result<(), AppError> {
        let tailnet = account(tailnet);
        let _guard = self.store_lock.lock().await;
        let store = Arc::clone(&self.store);
        let key = tailnet.to_owned();
        tokio::task::spawn_blocking(move || store.delete(&key)).await.map_err(|_| AppError::other(KEYCHAIN_ERROR))??;
        self.drop_tokens(tailnet);
        locked(&self.credentials).remove(tailnet);
        Ok(())
    }
}
