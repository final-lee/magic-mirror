use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;
use crate::k8s::connect::{client_for, eviction_client};
use kube::config::Kubeconfig;
use crate::k8s::tls::install_crypto_provider;

const PUBLIC: Endpoint = Endpoint { public: true, private: false };

/// 요청을 모두 받아 두고 정해 둔 응답 하나를 되풀이하는 가짜 API 서버. 돌려주는 값은 클라이언트와 받은 요청 글이다.
async fn api_server(status: &'static str, headers: &'static str, body: &'static str) -> (Kubeconfig, Arc<Mutex<Vec<String>>>) {
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
    (kubeconfig(port), seen)
}

/// 가짜 서버를 가리키는 kubeconfig
fn kubeconfig(port: u16) -> Kubeconfig {
    Kubeconfig::from_yaml(&format!(
        "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {{ server: \"http://127.0.0.1:{port}\" }}\ncontexts:\n- name: ctx\n  context: {{ cluster: c, user: u }}\nusers:\n- name: u\n  user: {{ token: t }}\n"
    ))
    .unwrap()
}

async fn evict_once(status: &'static str, headers: &'static str, body: &'static str) -> (Eviction, Vec<String>) {
    let (config, seen) = api_server(status, headers, body).await;
    let client = eviction_client(&config, "ctx", PUBLIC).await.unwrap();
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
    let client = eviction_client(&kubeconfig(port), "ctx", PUBLIC).await.unwrap();
    let result = evict(client, PUBLIC, "app", "web-1", "uid-1").await;
    assert!(matches!(result, Eviction::Fatal(AppError::Network { .. })), "{result:?}");
}

/// 429에 `Retry-After: 1`을 붙이는 서버에서, 어느 클라이언트가 스스로 다시 보내는지 본다.
#[tokio::test]
async fn only_the_eviction_client_skips_the_library_retry() {
    let (config, seen) = api_server("429 Too Many Requests", "Retry-After: 1\r\n", status_body(429, "TooManyRequests")).await;
    let ordinary = client_for(&config, "ctx", PUBLIC).await.unwrap();
    // 일반 클라이언트는 1초 뒤에 같은 요청을 다시 보낸다(이 시간 안에 끝나지 않는다)
    let waited = tokio::time::timeout(Duration::from_millis(1800), evict(ordinary, PUBLIC, "app", "web-1", "uid-1")).await;
    assert!(waited.is_err(), "일반 클라이언트는 429를 기다려 다시 시도해야 해요: {waited:?}");
    assert!(seen.lock().unwrap().len() >= 2, "다시 보낸 요청이 있어야 해요");

    seen.lock().unwrap().clear();
    let eviction = eviction_client(&config, "ctx", PUBLIC).await.unwrap();
    assert_eq!(evict(eviction, PUBLIC, "app", "web-1", "uid-1").await, Eviction::Blocked);
    assert_eq!(seen.lock().unwrap().len(), 1);
}
