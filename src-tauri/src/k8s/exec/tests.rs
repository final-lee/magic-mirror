use std::sync::{Arc, Mutex};
use std::time::Duration;

use kube::{Client, Config};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;
use crate::k8s::connect::tune;
use crate::k8s::tls::install_crypto_provider;

const PUBLIC: Endpoint = Endpoint { public: true, private: false };

/// 요청을 모두 받아 두고 정해 둔 응답 하나를 되풀이하는 가짜 API 서버. 돌려주는 값은 클라이언트와 받은 요청 글이다.
async fn api_server(status: &'static str, headers: &'static str, body: &'static str) -> (Client, Arc<Mutex<Vec<String>>>) {
    install_crypto_provider();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let log = log.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    request.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&request).to_string();
                    let Some((head, rest)) = text.split_once("\r\n\r\n") else {
                        continue;
                    };
                    let length = head
                        .lines()
                        .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if rest.len() >= length {
                        log.lock().unwrap().push(text);
                        break;
                    }
                }
                let response = format!(
                    "HTTP/1.1 {status}\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    let mut config = Config::new(format!("http://127.0.0.1:{port}").parse().unwrap());
    tune(&mut config);
    (Client::try_from(config).unwrap(), seen)
}

async fn evict_once(status: &'static str, headers: &'static str, body: &'static str) -> (Eviction, Vec<String>) {
    let (client, seen) = api_server(status, headers, body).await;
    // 재시도가 켜져 있으면 `Retry-After`만큼 기다리다 이 시간 제한에 걸린다
    let result = tokio::time::timeout(Duration::from_secs(5), evict(client, PUBLIC, "app", "web-1", "uid-1")).await.expect("한 번만 보내고 바로 돌아와야 해요");
    let requests = seen.lock().unwrap().clone();
    (result, requests)
}

fn status_body(code: u16, reason: &str) -> &'static str {
    Box::leak(format!(r#"{{"kind":"Status","apiVersion":"v1","status":"Failure","message":"m","reason":"{reason}","code":{code}}}"#).into_boxed_str())
}

#[tokio::test]
async fn an_eviction_posts_the_eviction_with_the_uid_precondition() {
    let (result, requests) = evict_once("201 Created", "", r#"{"kind":"Status","apiVersion":"v1","status":"Success"}"#).await;
    assert_eq!(result, Eviction::Evicted);
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert!(request.starts_with("POST /api/v1/namespaces/app/pods/web-1/eviction"), "{request}");
    let body: serde_json::Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["kind"], "Eviction");
    assert_eq!(body["apiVersion"], "policy/v1");
    assert_eq!(body["metadata"]["name"], "web-1");
    assert_eq!(body["deleteOptions"]["preconditions"]["uid"], "uid-1");
}

#[tokio::test]
async fn a_budget_block_comes_back_as_blocked_without_the_client_retrying() {
    let (result, requests) = evict_once("429 Too Many Requests", "Retry-After: 10\r\n", status_body(429, "TooManyRequests")).await;
    assert_eq!(result, Eviction::Blocked);
    assert_eq!(requests.len(), 1);
}

#[tokio::test]
async fn a_missing_pod_or_a_replaced_pod_counts_as_gone() {
    assert_eq!(evict_once("404 Not Found", "", status_body(404, "NotFound")).await.0, Eviction::Gone);
    assert_eq!(evict_once("409 Conflict", "", status_body(409, "Conflict")).await.0, Eviction::Gone);
}

#[tokio::test]
async fn other_api_errors_fail_only_that_pod_with_a_fixed_message() {
    let (result, _) = evict_once("500 Internal Server Error", "", status_body(500, "InternalError")).await;
    assert_eq!(result, Eviction::Failed(AppError::other(WRITE_FAILED)));
}

#[tokio::test]
async fn a_denied_eviction_stops_the_whole_drain() {
    let (result, _) = evict_once("403 Forbidden", "", status_body(403, "Forbidden")).await;
    assert_eq!(result, Eviction::Fatal(AppError::AccessDenied { action: "create pods/eviction".into() }));
}

#[tokio::test]
async fn an_unreachable_server_stops_the_whole_drain() {
    install_crypto_provider();
    // 열려 있지 않은 포트
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().port()
    };
    let mut config = Config::new(format!("http://127.0.0.1:{port}").parse().unwrap());
    tune(&mut config);
    let client = Client::try_from(config).unwrap();
    let result = evict(client, PUBLIC, "app", "web-1", "uid-1").await;
    assert!(matches!(result, Eviction::Fatal(AppError::Network { .. })), "{result:?}");
}
