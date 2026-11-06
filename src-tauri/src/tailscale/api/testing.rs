//! 다른 화면(키·로그 등)의 시험이 로컬 서버와 메모리 자격 증명 저장소로 API 클라이언트를 쓰는 도구.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;

pub const TAILNET: &str = "example.com";

#[derive(Default)]
struct MemoryStore(Mutex<HashMap<String, Credential>>);

impl CredentialStore for MemoryStore {
    fn get(&self, tailnet: &str) -> Result<Option<Credential>, AppError> {
        Ok(self.0.lock().unwrap().get(tailnet).cloned())
    }

    fn set(&self, tailnet: &str, credential: &Credential) -> Result<(), AppError> {
        self.0.lock().unwrap().insert(tailnet.into(), credential.clone());
        Ok(())
    }

    fn delete(&self, tailnet: &str) -> Result<(), AppError> {
        self.0.lock().unwrap().remove(tailnet);
        Ok(())
    }
}

/// 서버가 받은 요청 하나.
#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

/// 서버가 돌려줄 응답.
pub struct Reply {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(&'static str, String)>,
}

impl Reply {
    /// 응답 헤더 하나를 더한다(예: `ETag`).
    pub fn with_header(mut self, name: &'static str, value: &str) -> Self {
        self.headers.push((name, value.into()));
        self
    }
}

pub fn reply(status: u16, body: &str) -> Reply {
    Reply { status, body: body.into(), headers: Vec::new() }
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Seen {
    let mut data = Vec::new();
    let mut buf = [0; 4096];
    let header_end = loop {
        let n = stream.read(&mut buf).await.unwrap();
        data.extend_from_slice(&buf[..n]);
        if let Some(at) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
        assert!(n > 0, "connection closed before headers");
    };
    let head = String::from_utf8_lossy(&data[..header_end]).into_owned();
    let mut lines = head.lines();
    let mut start = lines.next().unwrap().split(' ');
    let (method, path) = (start.next().unwrap().to_owned(), start.next().unwrap().to_owned());
    let headers: HashMap<String, String> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_lowercase(), value.trim().to_owned()))
        .collect();
    let length: usize = headers.get("content-length").map_or(0, |v| v.parse().unwrap());
    while data.len() < header_end + length {
        let n = stream.read(&mut buf).await.unwrap();
        assert!(n > 0, "connection closed before body");
        data.extend_from_slice(&buf[..n]);
    }
    Seen { method, path, headers, body: String::from_utf8_lossy(&data[header_end..header_end + length]).into_owned() }
}

/// 요청을 모두 기록하고 `handler`가 정한 응답을 돌려주는 로컬 서버. 주소는 `/api/v2`까지 붙여 돌려준다.
/// `/oauth/token`은 스코프 이름을 박은 토큰(`tok-<scope>`)을 알아서 내주므로 `handler`는 API 경로만 다루면 된다.
pub async fn serve(handler: impl Fn(&Seen) -> Reply + Send + Sync + 'static) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/api/v2", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let handler = Arc::new(handler);
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let (handler, log) = (handler.clone(), log.clone());
            tokio::spawn(async move {
                let request = read_request(&mut stream).await;
                let reply = if request.path == "/api/v2/oauth/token" {
                    let form = Url::parse(&format!("http://localhost/?{}", request.body)).unwrap();
                    let scope = form.query_pairs().find(|(name, _)| name == "scope").map(|(_, value)| value.into_owned()).unwrap_or_default();
                    self::reply(200, &json!({"access_token": format!("tok-{scope}"), "token_type": "Bearer", "expires_in": 3600}).to_string())
                } else {
                    handler(&request)
                };
                log.lock().unwrap().push(request);
                let extra: String = reply.headers.iter().map(|(name, value)| format!("{name}: {value}\r\n")).collect();
                let head = format!("HTTP/1.1 {} X\r\nConnection: close\r\nContent-Length: {}\r\n{extra}\r\n", reply.status, reply.body.len());
                stream.write_all(head.as_bytes()).await.unwrap();
                stream.write_all(reply.body.as_bytes()).await.unwrap();
            });
        }
    });
    (base, seen)
}

/// `base`(서버 주소)로 요청을 보내고 테일넷 [`TAILNET`]에 OAuth 클라이언트 자격 증명이 저장된 상태. 변경 기록은 `changes_path`에 쓴다.
pub fn test_state_at(base: &str, changes_path: std::path::PathBuf) -> TailscaleState {
    crate::k8s::tls::install_crypto_provider();
    let store = MemoryStore::default();
    store.set(TAILNET, &Credential::Oauth { client_id: "client-id".into(), client_secret: "s3cr3t-value".into() }).unwrap();
    TailscaleState {
        client: Client::new(),
        base: base.into(),
        store: Arc::new(store),
        credentials: Mutex::new(HashMap::new()),
        tokens: Mutex::new(HashMap::new()),
        store_lock: tokio::sync::Mutex::new(()),
        changes_path,
    }
}

/// OAuth 토큰 교환을 뺀, API 경로로 간 요청들.
pub fn api_requests(seen: &Mutex<Vec<Seen>>) -> Vec<Seen> {
    seen.lock().unwrap().iter().filter(|s| !s.path.ends_with("/oauth/token")).cloned().collect()
}
