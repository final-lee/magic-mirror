//! Argo Server 요청과 키체인. 인증 값은 오류에 싣지 않는다.
use super::auth::{self, Auth};
use crate::error::AppError;
use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};

pub const ARGOWF_TOKEN_INVALID: &str = "Argo Server 토큰이 만료됐거나 맞지 않아요. 새 토큰을 넣어 주세요";
pub const ARGOWF_TOKEN_MISSING: &str = "이 Argo Server의 토큰을 넣어 주세요";
pub const ARGOWF_NETWORK: &str = "Argo Server에 닿지 못했어요. Tailscale·VPN 연결을 확인해 주세요";
pub const ARGOWF_CONTEXT_REJECTED: &str =
    "Argo Server가 kubeconfig context의 자격 증명을 받지 않았어요. 서버가 --auth-mode=client인지, 이 신원에 권한이 있는지 확인해 주세요";
pub const ARGOWF_FORBIDDEN: &str = "Argo Server가 이 요청을 허용하지 않았어요. 이 신원에 권한이 있는 네임스페이스를 골라 주세요";
const KEYCHAIN_ERROR: &str = "Argo Server 토큰을 키체인에서 처리하지 못했어요";
const RESPONSE_ERROR: &str = "Argo Server 응답을 읽지 못했어요";
const URL_ERROR: &str = "Argo Server 주소가 올바르지 않아요";
const SERVICE: &str = "magic-mirror.argo-workflows";
#[derive(Clone, Deserialize)]
pub struct Server {
    pub url: String,
    pub context: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    url: String,
    version: String,
    identity: String,
    auth: &'static str,
    kube: bool,
    sso_profile: Option<String>,
}

pub struct State {
    pub settings_path: PathBuf,
    client: Client,
    auth: Auth,
    tokens: tokio::sync::Mutex<HashMap<String, String>>,
    pub streams: Mutex<HashMap<u64, tokio::task::AbortHandle>>,
    pub next_stream: AtomicU64,
    pub kube_clients: tokio::sync::Mutex<HashMap<String, kube::Client>>,
}
impl State {
    pub fn new(settings_path: PathBuf) -> Self {
        crate::k8s::tls::install_crypto_provider();
        Self {
            settings_path,
            client: Client::builder().connect_timeout(Duration::from_secs(10)).build().expect("HTTP client"),
            auth: Auth::default(),
            tokens: Default::default(),
            streams: Default::default(),
            next_stream: AtomicU64::new(1),
            kube_clients: Default::default(),
        }
    }
    pub fn next_id(&self) -> u64 {
        self.next_stream.fetch_add(1, Ordering::Relaxed)
    }
    pub async fn current_token(&self, server: &Server) -> Result<String, AppError> {
        let token = if let Some(context) = &server.context {
            let config = auth::load(&self.settings_path)?.config;
            self.auth.token(&config, context, false).await?
        } else {
            self.token(&server.url).await?.ok_or_else(|| AppError::other(ARGOWF_TOKEN_MISSING))?
        };
        Ok(header(&token))
    }
    async fn token(&self, url: &str) -> Result<Option<String>, AppError> {
        let mut tokens = self.tokens.lock().await;
        let key = account(url).to_owned();
        if let Some(t) = tokens.get(&key) {
            return Ok(Some(t.clone()));
        }
        let lookup = key.clone();
        let value = tokio::task::spawn_blocking(move || {
            let entry = keyring::Entry::new(SERVICE, &lookup).map_err(|_| AppError::other(KEYCHAIN_ERROR))?;
            match entry.get_password() {
                Ok(t) => Ok(Some(t)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(AppError::other(KEYCHAIN_ERROR)),
            }
        })
        .await
        .map_err(|_| AppError::other(KEYCHAIN_ERROR))??;
        if let Some(t) = &value {
            tokens.insert(key, t.clone());
        }
        Ok(value)
    }
    pub async fn forget_token(&self, url: &str) -> Result<(), AppError> {
        let mut tokens = self.tokens.lock().await;
        let key = account(url).to_owned();
        let stored = key.clone();
        tokio::task::spawn_blocking(move || {
            let entry = keyring::Entry::new(SERVICE, &stored).map_err(|_| AppError::other(KEYCHAIN_ERROR))?;
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(AppError::other(KEYCHAIN_ERROR)),
            }
        })
        .await
        .map_err(|_| AppError::other(KEYCHAIN_ERROR))??;
        tokens.remove(&key);
        Ok(())
    }
    pub async fn set_token(&self, url: &str, token: String) -> Result<Session, AppError> {
        let server = Server {
            url: account(url).into(),
            context: None,
        };
        let session = self.session_with(&server, Some(&token)).await?;
        let mut tokens = self.tokens.lock().await;
        let key = account(url).to_owned();
        let saved_key = key.clone();
        let saved_token = token.clone();
        tokio::task::spawn_blocking(move || {
            keyring::Entry::new(SERVICE, &saved_key)
                .and_then(|e| e.set_password(&saved_token))
                .map_err(|_| AppError::other(KEYCHAIN_ERROR))
        })
        .await
        .map_err(|_| AppError::other(KEYCHAIN_ERROR))??;
        tokens.insert(key, token);
        Ok(session)
    }
    pub async fn session(&self, server: &Server) -> Result<Option<Session>, AppError> {
        if server.context.is_none() && self.token(&server.url).await?.is_none() {
            return Ok(None);
        }
        self.session_with(server, None).await.map(Some)
    }
    async fn session_with(&self, server: &Server, token: Option<&str>) -> Result<Session, AppError> {
        let version = self.request_json(server, Method::GET, &["api", "v1", "version"], &[], None, token).await?;
        let info = self.request_json(server, Method::GET, &["api", "v1", "userinfo"], &[], None, token).await?;
        let identity = info
            .get("email")
            .and_then(Value::as_str)
            .or_else(|| info.get("subject").and_then(Value::as_str))
            .filter(|s| !s.is_empty())
            .or(server.context.as_deref())
            .unwrap_or("토큰")
            .to_owned();
        let profile = match &server.context {
            Some(c) => auth::profile(&auth::load(&self.settings_path)?.config, c),
            None => None,
        };
        Ok(Session {
            url: account(&server.url).to_owned(),
            version: version
                .get("version")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::other(RESPONSE_ERROR))?
                .to_owned(),
            identity,
            auth: if server.context.is_some() { "context" } else { "token" },
            kube: server.context.is_some(),
            sso_profile: profile,
        })
    }
    pub async fn api(&self, server: &Server, method: Method, path: &[&str], query: &[(&str, &str)], body: Option<&Value>) -> Result<Value, AppError> {
        self.request_json(server, method, path, query, body, None).await
    }
    async fn request_json(
        &self,
        server: &Server,
        method: Method,
        path: &[&str],
        query: &[(&str, &str)],
        body: Option<&Value>,
        token: Option<&str>,
    ) -> Result<Value, AppError> {
        let response = self.request(server, method, path, query, body, token, false).await?;
        let bytes = response.bytes().await.map_err(|_| network())?;
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|_| AppError::other(RESPONSE_ERROR))
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn request(
        &self,
        server: &Server,
        method: Method,
        path: &[&str],
        query: &[(&str, &str)],
        body: Option<&Value>,
        override_token: Option<&str>,
        stream: bool,
    ) -> Result<reqwest::Response, AppError> {
        let url = request_url(&server.url, path, query)?;
        let config = if server.context.is_some() {
            Some(auth::load(&self.settings_path)?.config)
        } else {
            None
        };
        let mut token = match (&server.context, &config, override_token) {
            (_, _, Some(t)) => t.to_owned(),
            (Some(c), Some(config), None) => self.auth.token(config, c, false).await?,
            _ => self.token(&server.url).await?.ok_or_else(|| AppError::other(ARGOWF_TOKEN_MISSING))?,
        };
        for attempt in 0..2 {
            let mut req = self
                .client
                .request(method.clone(), url.clone())
                .header(reqwest::header::AUTHORIZATION, header(&token));
            if !stream {
                req = req.timeout(Duration::from_secs(15));
            }
            if let Some(body) = body {
                req = req.json(body);
            }
            let response = req.send().await.map_err(|_| network())?;
            let status = response.status();
            if status == StatusCode::UNAUTHORIZED && attempt == 0 {
                if let (Some(c), Some(config)) = (&server.context, &config) {
                    token = self.auth.token(config, c, true).await?;
                    continue;
                }
            }
            if status == StatusCode::FORBIDDEN {
                return Err(AppError::other(ARGOWF_FORBIDDEN));
            }
            if status == StatusCode::UNAUTHORIZED {
                return Err(AppError::other(if server.context.is_some() {
                    ARGOWF_CONTEXT_REJECTED
                } else {
                    ARGOWF_TOKEN_INVALID
                }));
            }
            if !status.is_success() {
                let value: Value = response.json().await.unwrap_or(Value::Null);
                let secret = token.strip_prefix("Bearer ").unwrap_or(&token);
                let msg = value
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(|s| {
                        let safe = if secret.is_empty() { s.to_owned() } else { s.replace(secret, "[REDACTED]") };
                        crate::k8s::failure::redact_secrets(&safe)
                    })
                    .unwrap_or_else(|| status.to_string());
                return Err(AppError::other(msg));
            }
            return Ok(response);
        }
        Err(AppError::other(ARGOWF_CONTEXT_REJECTED))
    }
}
fn account(url: &str) -> &str {
    url.trim().trim_end_matches('/')
}
fn header(token: &str) -> String {
    if token.starts_with("Bearer ") {
        token.to_owned()
    } else {
        format!("Bearer {token}")
    }
}
fn network() -> AppError {
    AppError::Network {
        message: ARGOWF_NETWORK.into(),
    }
}
fn request_url(base: &str, path: &[&str], query: &[(&str, &str)]) -> Result<Url, AppError> {
    let mut url = Url::parse(account(base)).map_err(|_| AppError::other(URL_ERROR))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::other(URL_ERROR));
    }
    url.path_segments_mut()
        .map_err(|_| AppError::other(URL_ERROR))?
        .pop_if_empty()
        .extend(path.iter().copied());
    url.query_pairs_mut().extend_pairs(query.iter().copied());
    Ok(url)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn argowf_token_header() {
        assert_eq!(header("abc"), "Bearer abc");
        assert_eq!(header("Bearer abc"), "Bearer abc");
    }
    #[test]
    fn argowf_url_validation() {
        assert!(request_url("file:///tmp", &[], &[]).is_err());
        assert!(request_url("https://example.test", &["api", "v1"], &[]).is_ok());
    }
    #[tokio::test]
    async fn argowf_refreshes_context_once_on_401() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let dir = tempfile::tempdir().unwrap();
        let counter = dir.path().join("count");
        let script = format!(
            "echo x >> '{}'; printf '%s' '{{\"status\":{{\"token\":\"safe-token\",\"expirationTimestamp\":\"2099-01-01T00:00:00Z\"}}}}'",
            counter.display()
        );
        let config = dir.path().join("config");
        let kube = json!({"apiVersion":"v1", "kind":"Config", "clusters":[{"name":"c","cluster":{"server":"https://example.test"}}], "contexts":[{"name":"test","context":{"cluster":"c","user":"u"}}], "users":[{"name":"u","user":{"exec":{"apiVersion":"client.authentication.k8s.io/v1beta1","command":"/bin/sh","args":["-c",script]}}}]});
        std::fs::write(&config, kube.to_string()).unwrap();
        let settings = dir.path().join("settings.json");
        std::fs::write(&settings, json!({"kubeconfigPath":config}).to_string()).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let fake = tokio::spawn(async move {
            for status in ["401 Unauthorized", "401 Unauthorized"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let _ = socket.read(&mut request).await.unwrap();
                socket
                    .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes())
                    .await
                    .unwrap();
            }
        });
        let state = State::new(settings);
        let error = state
            .api(
                &Server {
                    url,
                    context: Some("test".into()),
                },
                Method::GET,
                &["test"],
                &[],
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(error, AppError::other(ARGOWF_CONTEXT_REJECTED));
        assert_eq!(std::fs::read_to_string(counter).unwrap().lines().count(), 2);
        fake.await.unwrap();
    }
    #[tokio::test]
    async fn argowf_errors_never_contain_token() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let fake = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await.unwrap();
            let body = r#"{"message":"secret-token"}"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let state = State::new(PathBuf::new());
        let error = state
            .request_json(&Server { url, context: None }, Method::GET, &["test"], &[], None, Some("secret-token"))
            .await
            .unwrap_err();
        assert!(!error.to_string().contains("secret-token"));
        fake.await.unwrap();
    }
    #[tokio::test]
    #[ignore]
    async fn argowf_live_read_only() {
        let url = std::env::var("ARGOWF_LIVE_URL").expect("ARGOWF_LIVE_URL");
        let context = std::env::var("ARGOWF_LIVE_CONTEXT").expect("ARGOWF_LIVE_CONTEXT");
        let state = State::new(PathBuf::new());
        let server = Server { url, context: Some(context) };
        let version = state.api(&server, Method::GET, &["api", "v1", "version"], &[], None).await.unwrap();
        let info = state.api(&server, Method::GET, &["api", "v1", "info"], &[], None).await.unwrap();
        let user = state.api(&server, Method::GET, &["api", "v1", "userinfo"], &[], None).await.unwrap();
        let page = state
            .api(&server, Method::GET, &["api", "v1", "workflows", ""], &[("listOptions.limit", "2")], None)
            .await
            .unwrap();
        println!(
            "info={} userinfo={} page={}",
            info.is_object(),
            user.is_object(),
            page["items"].as_array().map_or(0, Vec::len)
        );
        let continuation = page
            .pointer("/metadata/continue")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| (page["items"].as_array().map_or(0, Vec::len) == 2).then_some("2"));
        if let Some(token) = continuation {
            let next = state
                .api(
                    &server,
                    Method::GET,
                    &["api", "v1", "workflows", ""],
                    &[("listOptions.limit", "2"), ("listOptions.continue", token)],
                    None,
                )
                .await
                .unwrap();
            println!("next page={}", next["items"].as_array().map_or(0, Vec::len));
        }
        let mut watch = state
            .request(&server, Method::GET, &["api", "v1", "workflow-events", ""], &[], None, None, true)
            .await
            .unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(3), watch.chunk()).await;
        println!("watch observed for up to 3s");
        let bindings = super::super::events::bindings(&state, &server, None).await.unwrap();
        println!("event bindings={}", bindings.len());
        let sources = super::super::events::sources(&state, &server, None).await.unwrap_err();
        assert_eq!(sources, AppError::other(super::super::events::ARGO_EVENTS_MISSING));
        println!("event sources: {}", super::super::events::ARGO_EVENTS_MISSING);
        let workflows = state
            .api(
                &server,
                Method::GET,
                &["api", "v1", "workflows", ""],
                &[("fields", super::super::rows::WF_LIST_FIELDS)],
                None,
            )
            .await
            .unwrap();
        let crons = state.api(&server, Method::GET, &["api", "v1", "cron-workflows", ""], &[], None).await.unwrap();
        let rows = super::super::rows::wf_rows(&workflows, false);
        let cron_rows = super::super::rows::cron_rows(&crons, chrono::Utc::now());
        println!(
            "version={} workflows={} crons={}",
            version["version"].as_str().unwrap_or("?"),
            rows.len(),
            cron_rows.len()
        );
        for r in &rows {
            println!(
                "wf {}/{} {} cron={:?} progress={:?} archived={}",
                r.namespace, r.name, r.phase, r.cron, r.progress, r.archived
            );
        }
        for c in &cron_rows {
            println!(
                "cron {}/{} {:?} tz={:?} next={:?} missed={} template={:?}",
                c.namespace,
                c.name,
                c.schedules,
                c.timezone,
                c.next_runs.first(),
                c.missed,
                c.template
            );
        }
        if let Some(first) = rows.first() {
            let detail = state
                .api(&server, Method::GET, &["api", "v1", "workflows", &first.namespace, &first.name], &[], None)
                .await
                .unwrap();
            let d = super::super::rows::wf_detail(&detail, false).unwrap();
            for n in &d.nodes {
                println!("node {} {} {} pod={:?}", n.kind, n.display_name, n.phase, n.pod_name);
            }
            // context 연결이면 같은 신원으로 쿠버네티스 이벤트와 SA의 IAM 역할도 읽는다(오래된 실행이면 이벤트가 비어 있을 수 있다)
            let mut names = super::super::rows::pod_names_of(&detail);
            names.push(first.name.clone());
            let events = super::super::kube::events(&state, &server, &first.namespace, names).await.unwrap();
            println!("events={}", events.len());
            if let Some(sa) = d.service_account.as_deref() {
                println!("role={:?}", super::super::kube::role_arn(&state, &server, &first.namespace, sa).await.unwrap());
            }
        }
    }
}
