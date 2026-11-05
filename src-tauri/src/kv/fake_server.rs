//! 가짜 RESP 서버(시험 전용): 로컬 TCP에서 명령을 받아 시험이 정한 답을 돌려준다. 서버가 받은 명령은 모두 기록해
//! "앱이 허용 목록 밖의 명령을 보내지 않았다"를 서버 쪽에서도 확인한다. AUTH 방식별 성공·실패, NOPERM, 막힌 명령의 오류를 흉내 낸다.

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

use super::command::allowed;
use super::connect::{connect_with, Auth, Connected, Plan, Secret};
use super::model::{KvKind, KvKeyName, KvNode, KvRole, KvTargetInfo, KvValue};
use super::target::Resolved;
use crate::error::AppError;

#[derive(Debug, Clone)]
pub enum Reply {
    Simple(&'static str),
    Error(String),
    Int(i64),
    Bulk(Vec<u8>),
}

impl Reply {
    fn encode(&self, out: &mut Vec<u8>) {
        match self {
            Reply::Simple(s) => out.extend_from_slice(format!("+{s}\r\n").as_bytes()),
            Reply::Error(s) => out.extend_from_slice(format!("-{s}\r\n").as_bytes()),
            Reply::Int(n) => out.extend_from_slice(format!(":{n}\r\n").as_bytes()),
            Reply::Bulk(b) => {
                out.extend_from_slice(format!("${}\r\n", b.len()).as_bytes());
                out.extend_from_slice(b);
                out.extend_from_slice(b"\r\n");
            }
        }
    }
}

pub fn bulk(text: &str) -> Reply {
    Reply::Bulk(text.as_bytes().to_vec())
}

type Handler = Arc<dyn Fn(&[String]) -> Reply + Send + Sync>;

pub struct Fake {
    pub port: u16,
    pub received: Arc<Mutex<Vec<Vec<String>>>>,
}

async fn read_command<R: AsyncBufReadExt + AsyncReadExt + Unpin>(reader: &mut R) -> Option<Vec<String>> {
    let mut line = String::new();
    if reader.read_line(&mut line).await.ok()? == 0 {
        return None;
    }
    let count: usize = line.trim().strip_prefix('*')?.parse().ok()?;
    let mut parts = Vec::with_capacity(count);
    for _ in 0..count {
        line.clear();
        reader.read_line(&mut line).await.ok()?;
        let len: usize = line.trim().strip_prefix('$')?.parse().ok()?;
        let mut data = vec![0; len + 2];
        reader.read_exact(&mut data).await.ok()?;
        data.truncate(len);
        parts.push(String::from_utf8_lossy(&data).into_owned());
    }
    Some(parts)
}

/// 서버를 띄운다. `handler`는 명령(이름과 인자)을 받아 답을 정한다.
pub async fn start(handler: impl Fn(&[String]) -> Reply + Send + Sync + 'static) -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let received = Arc::new(Mutex::new(Vec::new()));
    let handler: Handler = Arc::new(handler);
    let log = received.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let (handler, log) = (handler.clone(), log.clone());
            tokio::spawn(async move {
                let (read, mut write) = socket.into_split();
                let mut reader = BufReader::new(read);
                while let Some(command) = read_command(&mut reader).await {
                    log.lock().unwrap().push(command.clone());
                    let mut out = Vec::new();
                    handler(&command).encode(&mut out);
                    if write.write_all(&out).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    Fake { port, received }
}

/// fred가 연결하면서 보내는 명령에 대한 기본 답
fn handshake(command: &[String]) -> Option<Reply> {
    match command[0].to_uppercase().as_str() {
        "PING" => Some(Reply::Simple("PONG")),
        "SELECT" => Some(Reply::Simple("OK")),
        "CLIENT" if command.get(1).is_some_and(|s| s.eq_ignore_ascii_case("ID")) => Some(Reply::Int(11)),
        "INFO" => Some(bulk("# Server\r\nredis_version:7.2.4\r\nrun_id:fake\r\nrole:master\r\nused_memory:100\r\n# Keyspace\r\ndb0:keys=1,expires=0,avg_ttl=0\r\n")),
        _ => None,
    }
}

fn info(port: u16) -> Resolved {
    Resolved {
        info: KvTargetInfo {
            arn: "arn:aws:elasticache:ap-northeast-2:111111111111:replicationgroup:fake".into(),
            identifier: "fake".into(),
            kind: KvKind::ReplicationGroup,
            engine: "valkey".into(),
            engine_version: "8.0.2".into(),
            endpoint: "127.0.0.1".into(),
            port,
            reader_endpoint: None,
            tls: false,
            cluster_mode: false,
            serverless: false,
            auth_token_enabled: false,
            user_group_ids: vec![],
            users: None,
            iam_supported: false,
        },
        members: vec![KvNode { id: "fake-001".into(), address: format!("127.0.0.1:{port}"), role: KvRole::Primary, shard: None, slots: None }],
    }
}

fn plan(port: u16, auth: Auth) -> Plan {
    Plan { resolved: info(port), auth, database: 0 }
}

async fn open(fake: &Fake, auth: Auth) -> Result<Connected, AppError> {
    connect_with(plan(fake.port, auth), None).await
}

/// 허용 목록 검사와 fred가 연결할 때 스스로 보내는 읽기·설정 명령
const FRED_INTERNAL: [&str; 7] = ["AUTH", "PING", "SELECT", "CLIENT ID", "INFO", "CLUSTER SLOTS", "CLUSTER INFO"];

fn assert_only_reads(fake: &Fake) {
    for command in fake.received.lock().unwrap().iter() {
        let name = command[0].to_uppercase();
        let two = command.get(1).map(|s| format!("{name} {}", s.to_uppercase())).unwrap_or_default();
        assert!(allowed(&name).is_some() || allowed(&two).is_some() || FRED_INTERNAL.contains(&name.as_str()) || FRED_INTERNAL.contains(&two.as_str()), "허용 목록 밖의 명령: {command:?}");
    }
}

#[tokio::test]
async fn no_login_connects_without_sending_auth() {
    let fake = start(|c| handshake(c).unwrap_or(Reply::Error("ERR unexpected".into()))).await;
    let conn = open(&fake, Auth::None).await.unwrap();
    assert!(fake.received.lock().unwrap().iter().all(|c| c[0].to_uppercase() != "AUTH"));
    conn.close().await;
}

#[tokio::test]
async fn an_auth_token_is_sent_without_a_user_and_a_wrong_one_asks_for_the_login() {
    let fake = start(|c| match c[0].to_uppercase().as_str() {
        "AUTH" if c.len() == 2 && c[1] == "good" => Reply::Simple("OK"),
        "AUTH" => Reply::Error("WRONGPASS invalid username-password pair or user is disabled.".into()),
        _ => handshake(c).unwrap_or(Reply::Error("ERR unexpected".into())),
    })
    .await;
    open(&fake, Auth::Password(Secret::new("good"))).await.unwrap().close().await;
    let error = open(&fake, Auth::Password(Secret::new("bad"))).await.err().unwrap();
    assert_eq!(error, AppError::LoginRequired { message: "비밀번호가 맞지 않아요".into() });
}

#[tokio::test]
async fn a_user_logs_in_with_user_and_password_and_a_nopass_user_with_an_empty_one() {
    let fake = start(|c| match c[0].to_uppercase().as_str() {
        "AUTH" if c.len() == 3 && ((c[1] == "app" && c[2] == "pw") || (c[1] == "guest" && c[2].is_empty())) => Reply::Simple("OK"),
        "AUTH" => Reply::Error("WRONGPASS invalid username-password pair or user is disabled.".into()),
        _ => handshake(c).unwrap_or(Reply::Error("ERR unexpected".into())),
    })
    .await;
    open(&fake, Auth::User { name: "app".into(), password: Secret::new("pw") }).await.unwrap().close().await;
    open(&fake, Auth::User { name: "guest".into(), password: Secret::new("") }).await.unwrap().close().await;
    let error = open(&fake, Auth::User { name: "app".into(), password: Secret::new("nope") }).await.err().unwrap();
    assert!(matches!(error, AppError::LoginRequired { .. }));
}

#[tokio::test]
async fn a_cache_that_requires_auth_tells_a_login_less_client_to_log_in() {
    let fake = start(|_| Reply::Error("NOAUTH Authentication required.".into())).await;
    let error = open(&fake, Auth::None).await.err().unwrap();
    assert_eq!(error, AppError::LoginRequired { message: "이 캐시는 로그인이 필요해요".into() });
}

#[tokio::test]
async fn auth_sent_to_a_cache_without_a_password_still_connects() {
    // fred는 "비밀번호가 설정되지 않았다"는 AUTH 오류를 무시하고 이어 간다(가짜 서버로 확인). 이 오류 문구가 다른 길로 올라오면 `failure`가 방식 불일치 안내로 바꾼다
    let fake = start(|c| match c[0].to_uppercase().as_str() {
        "AUTH" => Reply::Error("ERR AUTH <password> called without any password configured for the default user.".into()),
        _ => handshake(c).unwrap_or(Reply::Error("ERR unexpected".into())),
    })
    .await;
    open(&fake, Auth::Password(Secret::new("x"))).await.unwrap().close().await;
}

#[tokio::test]
async fn an_unreachable_endpoint_points_to_the_vpn() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let error = connect_with(plan(port, Auth::None), None).await.err().unwrap();
    assert_eq!(error, AppError::Network { message: format!("엔드포인트에 연결하지 못했어요(127.0.0.1:{port}). VPN이 켜져 있는지 확인하세요") });
}

/// 키 하나(`greeting` = "abc")만 아는 서버
fn key_server(c: &[String]) -> Reply {
    match c[0].to_uppercase().as_str() {
        "TYPE" => bulk_simple("string"),
        "PTTL" => Reply::Int(-1),
        "STRLEN" => Reply::Int(3),
        "GETRANGE" => bulk("abc"),
        "MEMORY" => Reply::Error("ERR unknown command 'MEMORY'".into()),
        "OBJECT" => Reply::Error("ERR unknown command 'OBJECT'".into()),
        _ => handshake(c).unwrap_or(Reply::Error("ERR unexpected".into())),
    }
}

fn bulk_simple(text: &'static str) -> Reply {
    Reply::Simple(text)
}

#[tokio::test]
async fn a_key_view_survives_blocked_memory_and_encoding_and_sends_only_reads() {
    let fake = start(key_server).await;
    let conn = open(&fake, Auth::None).await.unwrap();
    let view = super::key::key_view(&conn, &KvKeyName { text: "greeting".into(), base64: None }, None).await.unwrap();
    assert_eq!((view.length, view.memory, view.encoding.clone(), view.ttl_ms), (Some(3), None, None, None));
    match view.value {
        KvValue::String { value, truncated } => assert_eq!((value.text.as_deref(), truncated), (Some("abc"), false)),
        other => panic!("{other:?}"),
    }
    assert_only_reads(&fake);
    conn.close().await;
}

#[tokio::test]
async fn no_permission_names_the_user_and_the_command() {
    let fake = start(|c| match c[0].to_uppercase().as_str() {
        "TYPE" => Reply::Error("NOPERM User guest has no permissions to run the 'type' command".into()),
        _ => handshake(c).unwrap_or(Reply::Error("ERR unexpected".into())),
    })
    .await;
    let conn = open(&fake, Auth::User { name: "guest".into(), password: Secret::new("") }).await;
    // 이 서버는 AUTH에 기본 답(오류)을 주므로 연결 단계에서 거절될 수 있다: 비밀번호 없는 방식으로 다시 연다
    drop(conn);
    let conn = open(&fake, Auth::None).await.unwrap();
    let error = super::key::key_view(&conn, &KvKeyName { text: "k".into(), base64: None }, None).await.unwrap_err();
    assert_eq!(error, AppError::other("사용자 default에게 TYPE 권한이 없어요"));
    conn.close().await;
}

#[tokio::test]
async fn the_gate_stops_a_write_before_it_reaches_the_server() {
    let fake = start(|c| handshake(c).unwrap_or(Reply::Error("ERR unexpected".into()))).await;
    let conn = open(&fake, Auth::None).await.unwrap();
    let error = conn.data(super::command::cmd("SET").arg("k").arg("v")).await.unwrap_err();
    assert!(matches!(error, AppError::Other { ref message } if message.contains("SET")), "{error:?}");
    assert!(fake.received.lock().unwrap().iter().all(|c| c[0].to_uppercase() != "SET"));
    conn.close().await;
}

#[tokio::test]
async fn a_closed_server_makes_the_connection_unusable_so_the_pool_reconnects() {
    use super::pool::Pooled;
    let fake = start(|c| handshake(c).unwrap_or(Reply::Error("ERR unexpected".into()))).await;
    let conn = open(&fake, Auth::None).await.unwrap();
    assert!(conn.usable());
    conn.close().await;
    // 닫은 연결은 쓸 수 없다
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(!conn.usable());
}
