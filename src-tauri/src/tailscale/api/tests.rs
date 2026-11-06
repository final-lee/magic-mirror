use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;

const SECRET: &str = "s3cr3t-value";
const TAILNET: &str = "example.com";

#[derive(Default, Clone)]
struct MemoryStore(Arc<Mutex<HashMap<String, Credential>>>);

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

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: String,
}

impl Seen {
    fn form(&self) -> HashMap<String, String> {
        Url::parse(&format!("http://localhost/?{}", self.body)).unwrap().query_pairs().into_owned().collect()
    }
}

struct Reply {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: String,
}

fn reply(status: u16, body: &str) -> Reply {
    Reply { status, headers: Vec::new(), body: body.into() }
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
async fn serve(handler: impl Fn(&Seen) -> Reply + Send + Sync + 'static) -> (String, Arc<Mutex<Vec<Seen>>>) {
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
                let reply = handler(&request);
                log.lock().unwrap().push(request);
                let mut head = format!("HTTP/1.1 {} X\r\nConnection: close\r\nContent-Length: {}\r\n", reply.status, reply.body.len());
                for (name, value) in reply.headers {
                    head.push_str(&format!("{name}: {value}\r\n"));
                }
                head.push_str("\r\n");
                stream.write_all(head.as_bytes()).await.unwrap();
                stream.write_all(reply.body.as_bytes()).await.unwrap();
            });
        }
    });
    (base, seen)
}

/// `/oauth/token`은 스코프 이름을 박은 토큰을 내주고, 나머지 경로는 `other`를 돌려준다.
fn oauth_server(expires_in: u64, other: u16) -> impl Fn(&Seen) -> Reply + Send + Sync + 'static {
    move |seen| {
        if seen.path == "/api/v2/oauth/token" {
            let token = format!("tok-{}", seen.form()["scope"]);
            reply(200, &json!({"access_token": token, "token_type": "Bearer", "expires_in": expires_in}).to_string())
        } else {
            reply(other, r#"{"devices":[]}"#)
        }
    }
}

fn oauth() -> Credential {
    Credential::Oauth { client_id: "client-id".into(), client_secret: SECRET.into() }
}

fn api_token() -> Credential {
    Credential::Token { token: SECRET.into() }
}

fn state_with(base: &str, credential: Option<Credential>) -> (TailscaleState, MemoryStore) {
    crate::k8s::tls::install_crypto_provider();
    let store = MemoryStore::default();
    if let Some(credential) = credential {
        store.set(TAILNET, &credential).unwrap();
    }
    let state = TailscaleState {
        client: Client::new(),
        base: base.into(),
        store: Arc::new(store.clone()),
        credentials: Mutex::new(HashMap::new()),
        tokens: Mutex::new(HashMap::new()),
        store_lock: tokio::sync::Mutex::new(()),
        changes_path: std::path::PathBuf::new(),
    };
    (state, store)
}

fn token_requests(seen: &Mutex<Vec<Seen>>) -> Vec<Seen> {
    seen.lock().unwrap().iter().filter(|s| s.path.ends_with("/oauth/token")).cloned().collect()
}

fn api_requests(seen: &Mutex<Vec<Seen>>) -> Vec<Seen> {
    seen.lock().unwrap().iter().filter(|s| !s.path.ends_with("/oauth/token")).cloned().collect()
}

#[tokio::test]
async fn oauth_reads_request_all_read_and_writes_request_only_their_scope() {
    let (base, seen) = serve(oauth_server(3600, 200)).await;
    let (state, _) = state_with(&base, Some(oauth()));
    state.get_json(TAILNET, "/tailnet/-/devices?fields=all").await.unwrap();
    state.request(TAILNET, Request::new(Method::POST, "/device/abc/routes", Scope::Write("devices:routes")).json(json!({"routes": ["10.0.0.0/16"]}))).await.unwrap();

    let exchanges = token_requests(&seen);
    assert_eq!(exchanges.len(), 2);
    for exchange in &exchanges {
        assert_eq!(exchange.method, "POST");
        assert_eq!(exchange.headers["content-type"], "application/x-www-form-urlencoded");
        assert_eq!(exchange.form()["client_id"], "client-id");
        assert_eq!(exchange.form()["client_secret"], SECRET);
    }
    assert_eq!(exchanges[0].form()["scope"], "all:read");
    assert_eq!(exchanges[1].form()["scope"], "devices:routes");

    let calls = api_requests(&seen);
    assert_eq!(calls[0].path, "/api/v2/tailnet/-/devices?fields=all");
    assert_eq!(calls[0].headers["authorization"], "Bearer tok-all:read");
    assert_eq!(calls[1].method, "POST");
    assert_eq!(calls[1].headers["authorization"], "Bearer tok-devices:routes");
    assert_eq!(calls[1].headers["content-type"], "application/json");
    assert_eq!(serde_json::from_str::<Value>(&calls[1].body).unwrap(), json!({"routes": ["10.0.0.0/16"]}));
}

#[tokio::test]
async fn oauth_tokens_are_cached_per_scope_until_a_minute_before_expiry() {
    let (base, seen) = serve(oauth_server(3600, 200)).await;
    let (state, _) = state_with(&base, Some(oauth()));
    for _ in 0..3 {
        state.get_json(TAILNET, "/tailnet/-/devices").await.unwrap();
    }
    let write = || Request::new(Method::POST, "/tailnet/-/acl", Scope::Write("policy_file")).text("application/hujson", "{}");
    state.request(TAILNET, write()).await.unwrap();
    state.request(TAILNET, write()).await.unwrap();
    let scopes: Vec<_> = token_requests(&seen).iter().map(|s| s.form()["scope"].clone()).collect();
    assert_eq!(scopes, ["all:read", "policy_file"]);

    // expires_in이 1분 안이면 받자마자 만료로 보고 매번 다시 교환한다
    let (base, seen) = serve(oauth_server(45, 200)).await;
    let (state, _) = state_with(&base, Some(oauth()));
    state.get_json(TAILNET, "/tailnet/-/devices").await.unwrap();
    state.get_json(TAILNET, "/tailnet/-/devices").await.unwrap();
    assert_eq!(token_requests(&seen).len(), 2);
}

#[tokio::test]
async fn api_token_is_bearer_for_every_scope_without_exchange() {
    let (base, seen) = serve(oauth_server(3600, 200)).await;
    let (state, _) = state_with(&base, Some(api_token()));
    state.get_json(TAILNET, "/tailnet/-/devices").await.unwrap();
    state.request(TAILNET, Request::new(Method::DELETE, "/device/abc", Scope::Write("devices:core"))).await.unwrap();
    assert!(token_requests(&seen).is_empty());
    let calls = api_requests(&seen);
    assert_eq!(calls.len(), 2);
    assert!(calls.iter().all(|c| c.headers["authorization"] == format!("Bearer {SECRET}")));
}

#[tokio::test]
async fn raw_text_accept_if_match_and_etag_pass_through() {
    let (base, seen) = serve(|seen| {
        let mut r = reply(200, "// policy\n{}");
        if seen.method == "GET" {
            r.headers.push(("ETag", "\"abc123\"".into()));
        }
        r
    })
    .await;
    let (state, _) = state_with(&base, Some(api_token()));
    let read = state.request(TAILNET, Request::get("/tailnet/-/acl").accept("application/hujson")).await.unwrap();
    assert_eq!((read.status, read.body.as_str(), read.etag.as_deref()), (200, "// policy\n{}", Some("\"abc123\"")));
    let write = state
        .request(TAILNET, Request::new(Method::POST, "/tailnet/-/acl", Scope::Write("policy_file")).text("application/hujson", "// edited\n{}").if_match(read.etag.unwrap()))
        .await
        .unwrap();
    assert_eq!(write.etag, None);
    let calls = api_requests(&seen);
    assert_eq!(calls[0].headers["accept"], "application/hujson");
    assert_eq!(calls[1].headers["content-type"], "application/hujson");
    assert_eq!(calls[1].headers["if-match"], "\"abc123\"");
    assert_eq!(calls[1].body, "// edited\n{}");
}

#[tokio::test]
async fn api_errors_map_to_korean_messages_without_secrets() {
    let (base, _) = serve(|seen| match seen.path.as_str() {
        "/api/v2/a" => reply(401, r#"{"message":"bad token"}"#),
        "/api/v2/b" => reply(403, r#"{"message":"forbidden"}"#),
        "/api/v2/c" => reply(404, r#"{"message":"device not found"}"#),
        "/api/v2/d" => reply(412, r#"{"message":"precondition failed"}"#),
        "/api/v2/e" => reply(500, ""),
        _ => reply(200, "not json"),
    })
    .await;
    let (state, _) = state_with(&base, Some(api_token()));
    let read = |path: &'static str| state.request(TAILNET, Request::get(path));
    assert_eq!(read("/a").await.unwrap_err(), AppError::other("자격 증명이 만료됐거나 맞지 않아요"));
    assert_eq!(read("/b").await.unwrap_err(), AppError::other("이 자격 증명에 all:read 권한이 없어요 (forbidden)"));
    let write = Request::new(Method::POST, "/b", Scope::Write("policy_file"));
    assert_eq!(state.request(TAILNET, write).await.unwrap_err(), AppError::other("이 자격 증명에 policy_file 권한이 없어요 (forbidden)"));
    assert_eq!(read("/c").await.unwrap_err(), AppError::other("device not found"));
    assert_eq!(read("/d").await.unwrap_err(), AppError::other(CHANGED_ELSEWHERE));
    assert_eq!(read("/e").await.unwrap_err(), AppError::other("500 Internal Server Error"));
    assert_eq!(state.get_json(TAILNET, "/f").await.unwrap_err(), AppError::other(RESPONSE_ERROR));
    for path in ["/a", "/b", "/c", "/d", "/e"] {
        assert!(!format!("{:?}", read(path).await.unwrap_err()).contains(SECRET));
    }
}

#[tokio::test]
async fn oauth_exchange_failures_map_to_credential_and_scope_errors() {
    let (base, _) = serve(|seen| match seen.form()["scope"].as_str() {
        "all:read" => reply(401, r#"{"error":"invalid_client","error_description":"unknown client"}"#),
        "policy_file" => reply(400, r#"{"error":"invalid_scope","error_description":"scope not allowed"}"#),
        "users" => reply(403, "{}"),
        _ => reply(400, r#"{"error":"invalid_request","error_description":"missing field"}"#),
    })
    .await;
    let (state, _) = state_with(&base, Some(oauth()));
    assert_eq!(state.get_json(TAILNET, "/x").await.unwrap_err(), AppError::other(CREDENTIAL_INVALID));
    let write = |scope| state.request(TAILNET, Request::new(Method::POST, "/x", Scope::Write(scope)));
    assert_eq!(write("policy_file").await.unwrap_err(), AppError::other("이 자격 증명에 policy_file 권한이 없어요"));
    assert_eq!(write("users").await.unwrap_err(), AppError::other("이 자격 증명에 users 권한이 없어요"));
    assert_eq!(write("auth_keys").await.unwrap_err(), AppError::other("missing field"));
}

#[tokio::test]
async fn unauthorized_response_drops_the_cached_oauth_token() {
    let calls = Arc::new(Mutex::new(0));
    let counter = calls.clone();
    let token = oauth_server(3600, 200);
    let (base, seen) = serve(move |seen| {
        if seen.path != "/api/v2/oauth/token" {
            let mut n = counter.lock().unwrap();
            *n += 1;
            if *n == 1 {
                return reply(401, "{}");
            }
        }
        token(seen)
    })
    .await;
    let (state, _) = state_with(&base, Some(oauth()));
    assert_eq!(state.get_json(TAILNET, "/x").await.unwrap_err(), AppError::other(CREDENTIAL_INVALID));
    state.get_json(TAILNET, "/x").await.unwrap();
    assert_eq!(token_requests(&seen).len(), 2);
}

#[tokio::test]
async fn missing_credential_and_unreachable_server_are_distinct_errors() {
    let (state, _) = state_with("http://127.0.0.1:9", None);
    assert_eq!(state.get_json(TAILNET, "/x").await.unwrap_err(), AppError::other("Tailscale API를 연결해 주세요"));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let (state, _) = state_with(&base, Some(api_token()));
    match state.get_json(TAILNET, "/x").await.unwrap_err() {
        AppError::Network { message } => {
            assert!(message.contains(NETWORK));
            assert!(message.contains("연결 거부"));
            assert!(!message.contains(SECRET));
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

fn devices_reply(seen: &Seen) -> Reply {
    if seen.headers.get("authorization").is_some_and(|v| *v == format!("Bearer {SECRET}")) {
        reply(
            200,
            &json!({"devices": [{"name": "mac.example.ts.net"}, {"name": "pi.example.ts.net"}, {"name": "odd.other.ts.net"}]}).to_string(),
        )
    } else {
        reply(401, r#"{"message":"API token invalid"}"#)
    }
}

#[tokio::test]
async fn connect_validates_before_storing_and_forget_clears() {
    let (base, seen) = serve(devices_reply).await;
    let (state, store) = state_with(&base, None);

    let wrong = Credential::Token { token: "nope".into() };
    assert_eq!(state.connect(TAILNET, wrong).await.unwrap_err(), AppError::other(CREDENTIAL_INVALID));
    assert!(store.0.lock().unwrap().is_empty());
    assert_eq!(state.status(Some(TAILNET)).await.unwrap(), ApiStatus { tailnet: Some(TAILNET.into()), kind: None });

    let connection = state.connect(&format!(" {TAILNET} "), Credential::Token { token: format!(" {SECRET}\n") }).await.unwrap();
    assert_eq!(connection, ApiConnection { devices: 3, magic_dns_suffix: Some("example.ts.net".into()) });
    assert_eq!(seen.lock().unwrap().last().unwrap().path, "/api/v2/tailnet/-/devices");
    assert_eq!(store.0.lock().unwrap().get(TAILNET), Some(&api_token()));
    assert_eq!(state.status(Some(TAILNET)).await.unwrap().kind, Some("token"));

    // 저장한 자격 증명을 곧바로 쓴다
    state.get_json(TAILNET, "/tailnet/-/devices").await.unwrap();

    state.forget(TAILNET).await.unwrap();
    assert!(store.0.lock().unwrap().is_empty());
    assert!(locked(&state.credentials).is_empty());
    assert_eq!(state.get_json(TAILNET, "/tailnet/-/devices").await.unwrap_err(), AppError::other(NOT_CONNECTED));
}

#[tokio::test]
async fn connect_with_oauth_does_not_cache_tokens_for_an_unsaved_credential() {
    let (base, seen) = serve(|seen| {
        if seen.path.ends_with("/oauth/token") {
            if seen.form()["client_secret"] == SECRET {
                reply(200, r#"{"access_token":"tok","expires_in":3600}"#)
            } else {
                reply(401, r#"{"error":"invalid_client"}"#)
            }
        } else {
            reply(200, r#"{"devices":[]}"#)
        }
    })
    .await;
    let (state, store) = state_with(&base, None);
    let wrong = Credential::Oauth { client_id: "client-id".into(), client_secret: "wrong".into() };
    assert_eq!(state.connect(TAILNET, wrong).await.unwrap_err(), AppError::other(CREDENTIAL_INVALID));
    assert!(store.0.lock().unwrap().is_empty());
    assert!(locked(&state.tokens).is_empty());

    let connection = state.connect(TAILNET, oauth()).await.unwrap();
    assert_eq!(connection, ApiConnection { devices: 0, magic_dns_suffix: None });
    assert_eq!(store.0.lock().unwrap().get(TAILNET), Some(&oauth()));
    assert_eq!(token_requests(&seen).last().unwrap().form()["scope"], "all:read");
    assert_eq!(state.status(Some(TAILNET)).await.unwrap().kind, Some("oauth"));
}

#[tokio::test]
async fn connect_rejects_blank_input_without_calling_the_api() {
    let (base, seen) = serve(devices_reply).await;
    let (state, store) = state_with(&base, None);
    assert_eq!(state.connect("  ", api_token()).await.unwrap_err(), AppError::other(TAILNET_MISSING));
    let blanks = [Credential::Token { token: " ".into() }, Credential::Oauth { client_id: "id".into(), client_secret: "".into() }];
    for credential in blanks {
        assert_eq!(state.connect(TAILNET, credential).await.unwrap_err(), AppError::other(CREDENTIAL_MISSING));
    }
    assert!(seen.lock().unwrap().is_empty());
    assert!(store.0.lock().unwrap().is_empty());
    assert_eq!(state.status(None).await.unwrap(), ApiStatus { tailnet: None, kind: None });
}

#[test]
fn credential_serializes_to_the_keychain_json_line_and_never_debug_prints_secrets() {
    assert_eq!(
        serde_json::to_string(&oauth()).unwrap(),
        format!(r#"{{"kind":"oauth","clientId":"client-id","clientSecret":"{SECRET}"}}"#)
    );
    assert_eq!(serde_json::to_string(&api_token()).unwrap(), format!(r#"{{"kind":"token","token":"{SECRET}"}}"#));
    let parsed: Credential = serde_json::from_str(&format!(r#"{{"kind":"oauth","clientId":"client-id","clientSecret":"{SECRET}"}}"#)).unwrap();
    assert_eq!(parsed, oauth());
    assert_eq!(serde_json::from_str::<Credential>(&format!(r#"{{"kind":"token","token":"{SECRET}"}}"#)).unwrap(), api_token());
    assert!(serde_json::from_str::<Credential>(r#"{"kind":"basic","token":"x"}"#).is_err());
    for credential in [oauth(), api_token()] {
        let text = format!("{credential:?} {:?}", Some(&credential));
        assert!(!text.contains(SECRET) && !text.contains("client-id"), "{text}");
        assert!(text.contains("[REDACTED]"));
    }
}

#[test]
fn magic_dns_suffix_is_the_most_common_fqdn_tail() {
    let names = |names: &[&str]| names.iter().map(|n| json!({ "name": n })).collect::<Vec<_>>();
    assert_eq!(magic_dns_suffix(&names(&["a.x.ts.net", "b.y.ts.net", "c.y.ts.net"])).as_deref(), Some("y.ts.net"));
    assert_eq!(magic_dns_suffix(&names(&["a.y.ts.net.", "b.x.ts.net"])).as_deref(), Some("x.ts.net"));
    assert_eq!(magic_dns_suffix(&names(&["lonely", ".x.ts.net"])), None);
    assert_eq!(magic_dns_suffix(&[]), None);
}
