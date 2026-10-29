//! 테스트용 가짜 PostgreSQL 서버. 로컬 주소에만 열고, 시작 메시지와 `SELECT pg_backend_pid()` 하나, 그리고 트랜잭션을 여닫는 단순 질의만 흉내 낸다.
//! 단순 질의는 아무 문장이나 받아 주고 받은 문장을 적어 둔다(`simple_queries`): 읽기가 어떤 문장을 어떤 순서로 보내는지 본다.
//! 확장 질의의 문장도 적어 둔다(`prepared_statements`). `Script::Row`는 어떤 질의에든 정해 둔 문자열 한 줄로 답한다.
//! 진짜 `tokio_postgres::Client`와 진짜 접속 오류를 네트워크 없이 얻는 데 쓴다. 이 파일은 질의를 보내지 않고 서버 쪽 바이트만 다룬다.
//! TLS를 받는 서버도 만들 수 있다: `TestPki`가 그때그때 테스트 CA와 서버 인증서를 만든다(비밀 키를 저장소에 두지 않는다).

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{RootCertStore, ServerConfig};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_postgres::config::SslMode;
use tokio_postgres::NoTls;
use tokio_rustls::TlsAcceptor;

use super::connect::{spawn_connection, Connected};

/// `SELECT pg_backend_pid()`에 돌려주는 값
pub const FAKE_PID: i32 = 4242;
const SSL_REQUEST: u32 = 80_877_103;

/// 단순 질의 하나에 대한 서버의 반응. 문장에 `contains`가 들어 있으면(대소문자 구분 없이) 규칙 가운데 처음 맞는 것의 `reply`를 차례로 따른다.
/// 맞는 규칙이 없는 문장은 그냥 끝났다고 답한다. 모든 반응은 문장의 응답 안에서 일어난다: 알림은 `CommandComplete`보다 먼저 간다
#[derive(Clone, Copy)]
pub struct Rule {
    pub contains: &'static str,
    pub reply: &'static [Reply],
}

#[derive(Clone, Copy)]
pub enum Reply {
    /// `NoticeResponse`: 심각도(`WARNING` …), SQLSTATE, 문구
    Notice { severity: &'static str, code: &'static str, message: &'static str },
    /// `ErrorResponse`(`ERROR`)로 끝낸다. 연결은 이어 쓸 수 있다
    Error { code: &'static str, message: &'static str },
    /// `ErrorResponse`(`FATAL`)를 보내고 연결을 닫는다
    Fatal { code: &'static str, message: &'static str },
    /// 문자열 칸 하나로 된 줄 하나를 보낸다
    Row(&'static str),
    /// 답 없이 연결을 닫는다
    HangUp,
    /// 답하지 않고 연결을 열어 둔다
    Stall,
}

/// 클라이언트에게 어떻게 구는지
#[derive(Clone, Copy)]
pub enum Script {
    /// `Ready`처럼 굴되, 단순 질의에는 규칙대로 답한다(`Rule`). 변경을 돌리는 `exec`를 시험한다
    Writes(&'static [Rule]),
    /// 시작 메시지를 받아들이고 질의(`SELECT pg_backend_pid()`)에 답한다. 단순 질의(`START TRANSACTION …`, `SET …`, `COMMIT`)는 아무것이나 받아 준다.
    /// 연결은 클라이언트가 닫거나 `close_connections`가 불릴 때까지 열려 있다
    Ready,
    /// `Ready`처럼 굴되, 확장 질의(준비 단계)마다 연결을 끊지 않는 오류(`ERROR`)로 답한다. 단순 질의는 받아 준다.
    /// 읽기 도중에 서버가 보낸 오류와, 그 뒤에도 연결이 쓸 수 있는지를 본다
    RejectsQueries { code: &'static str, message: &'static str },
    /// `Ready`처럼 굴되, 확장 질의에는 질의가 무엇이든 문자열 칸으로만 된 한 줄로 답한다(`columns`가 열 이름, `values`가 값).
    /// 첫 질의의 답으로 읽기의 갈래가 정해지는 경우를 본다
    Row { columns: &'static [&'static str], values: &'static [&'static str] },
    /// `Ready`처럼 굴되, 먼저 비밀번호(평문)를 요구하고 받은 값을 적어 둔다. IAM 토큰이 비밀번호로 가는지 본다
    AskPassword,
    /// 시작 메시지는 받아들이지만 그 뒤의 질의에는 답하지 않는다
    MuteAfterStartup,
    /// `Ready`처럼 굴되, 첫 읽기 전용 트랜잭션이 `COMMIT`으로 끝난 뒤(로그인과 `SELECT pg_backend_pid()`까지 끝난 뒤)로는 아무것도 답하지 않는다.
    /// 연결은 열려 있다. 로그인과 첫 읽기를 마친 연결이 그 뒤로 말이 끊긴 경우(VPN이 바뀌거나 중간 장비가 연결을 버린 경우)를 본다
    SilentAfterPid,
    /// 시작 메시지에 오류(`FATAL`)로 답한다
    Fatal { code: &'static str, message: &'static str },
    /// SSLRequest에 'S'(TLS 좋아요)라고 해 놓고 TLS가 아닌 바이트를 보낸다
    NotTls,
    /// SSLRequest에 'N'(TLS 안 돼요)이라고 한다
    DeclinesTls,
    /// SSLRequest에 'S'라고 해 놓고 TLS 협상 도중에 연결을 끊는다
    TlsThenHangUp,
    /// 연결만 받고 아무 말도 하지 않는다
    Silent,
}

/// 서버가 본 것들
#[derive(Default)]
struct Seen {
    accepted: AtomicUsize,
    /// TLS 없이(SSLRequest 없이, 또는 'N'을 받은 뒤에도) 온 시작 메시지 수
    plaintext_startups: AtomicUsize,
    /// 받은 시작 메시지의 매개변수(`user`, `database`, `application_name` …). 평문과 TLS 모두
    startups: Mutex<Vec<HashMap<String, String>>>,
    passwords: Mutex<Vec<String>>,
    /// 받은 단순 질의(`Query` 메시지)의 문장, 받은 순서대로
    queries: Mutex<Vec<String>>,
    /// 준비한 확장 질의(`Parse` 메시지)의 문장, 받은 순서대로
    prepared: Mutex<Vec<String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 테스트 CA 하나와, 그 CA가 서명한 서버 인증서 하나
pub struct TestPki {
    ca: CertificateDer<'static>,
    chain: Vec<CertificateDer<'static>>,
    key: Vec<u8>,
}

impl TestPki {
    /// 새 CA를 만들고, `names`(DNS 이름이나 IP 주소)에 유효한 서버 인증서를 그 CA로 서명한다
    pub fn new(names: &[&str]) -> TestPki {
        let ca_key = KeyPair::generate().expect("CA 키를 만들지 못했어요");
        let mut ca_params = CertificateParams::new(Vec::<String>::new()).expect("CA 설정이 잘못됐어요");
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
        ca_params.distinguished_name.push(DnType::CommonName, "Magic Mirror test CA");
        let ca = ca_params.self_signed(&ca_key).expect("CA 인증서를 만들지 못했어요");
        let server_key = KeyPair::generate().expect("서버 키를 만들지 못했어요");
        let server = CertificateParams::new(names.iter().map(|name| name.to_string()).collect::<Vec<_>>())
            .expect("서버 인증서 설정이 잘못됐어요")
            .signed_by(&server_key, &Issuer::from_params(&ca_params, &ca_key))
            .expect("서버 인증서를 만들지 못했어요");
        TestPki { ca: ca.der().clone(), chain: vec![server.der().clone()], key: server_key.serialize_der() }
    }

    /// 이 CA만 믿는 뿌리 저장소
    pub fn roots(&self) -> RootCertStore {
        let mut roots = RootCertStore::empty();
        roots.add(self.ca.clone()).expect("테스트 CA를 읽지 못했어요");
        roots
    }

    fn acceptor(&self) -> TlsAcceptor {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let config = ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("TLS 버전을 고르지 못했어요")
            .with_no_client_auth()
            .with_single_cert(self.chain.clone(), PrivateKeyDer::from(PrivatePkcs8KeyDer::from(self.key.clone())))
            .expect("서버 인증서를 쓰지 못했어요");
        TlsAcceptor::from(Arc::new(config))
    }
}

pub struct FakeServer {
    pub port: u16,
    seen: Arc<Seen>,
    closing: Arc<watch::Sender<u64>>,
    task: JoinHandle<()>,
}

impl FakeServer {
    pub async fn start(script: Script) -> FakeServer {
        FakeServer::listen(script, None).await
    }

    /// TLS를 받아 준다: SSLRequest에 'S'로 답하고 `pki`의 서버 인증서로 핸드셰이크한 뒤 `script`대로 군다
    pub async fn start_tls(script: Script, pki: &TestPki) -> FakeServer {
        FakeServer::listen(script, Some(pki.acceptor())).await
    }

    async fn listen(script: Script, tls: Option<TlsAcceptor>) -> FakeServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("가짜 서버를 열지 못했어요");
        let port = listener.local_addr().expect("주소를 읽지 못했어요").port();
        let seen = Arc::new(Seen::default());
        let closing = Arc::new(watch::channel(0u64).0);
        let task = tokio::spawn({
            let (seen, closing) = (seen.clone(), closing.clone());
            async move {
                while let Ok((stream, _)) = listener.accept().await {
                    seen.accepted.fetch_add(1, Ordering::SeqCst);
                    tokio::spawn(serve(stream, script, tls.clone(), seen.clone(), closing.subscribe()));
                }
            }
        });
        FakeServer { port, seen, closing, task }
    }

    /// 지금까지 받은 TCP 연결 수
    pub fn accepted(&self) -> usize {
        self.seen.accepted.load(Ordering::SeqCst)
    }

    /// TLS 없이(SSLRequest 없이, 또는 'N'을 받은 뒤에도) 온 시작 메시지 수
    pub fn plaintext_startups(&self) -> usize {
        self.seen.plaintext_startups.load(Ordering::SeqCst)
    }

    /// 받은 시작 메시지의 매개변수들(`user`, `database`, `application_name` …)
    pub fn startups(&self) -> Vec<HashMap<String, String>> {
        lock(&self.seen.startups).clone()
    }

    /// `Script::AskPassword`가 받은 비밀번호들
    pub fn passwords(&self) -> Vec<String> {
        lock(&self.seen.passwords).clone()
    }

    /// 지금까지 받은 단순 질의의 문장들(받은 순서). 트랜잭션을 여닫는 문장이 여기에 보인다
    pub fn simple_queries(&self) -> Vec<String> {
        lock(&self.seen.queries).clone()
    }

    /// 지금까지 준비한 확장 질의의 문장들(받은 순서). 읽기가 어떤 SELECT를 보냈는지 본다
    pub fn prepared_statements(&self) -> Vec<String> {
        lock(&self.seen.prepared).clone()
    }

    /// 지금 열려 있는 연결을 모두 서버 쪽에서 닫는다. 그 뒤에 오는 연결은 영향이 없다
    pub fn close_connections(&self) {
        self.closing.send_modify(|generation| *generation += 1);
    }

    /// 이 서버에 TLS 없이 연결해 `Connected`를 만든다(풀 테스트용)
    pub async fn connected(&self, backend_pid: i32) -> Connected {
        let (client, connection) = plain_config(self.port).connect(NoTls).await.expect("가짜 서버에 연결하지 못했어요");
        let notices = spawn_connection(connection);
        Connected { client, backend_pid, notices, broken: false }
    }
}

impl Drop for FakeServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// 가짜 서버(또는 닫힌 포트)에 TLS 없이 붙는 설정
pub fn plain_config(port: u16) -> tokio_postgres::Config {
    let mut config = tokio_postgres::Config::new();
    config.host("127.0.0.1").port(port).user("iam_admin").dbname("app").ssl_mode(SslMode::Disable).connect_timeout(Duration::from_secs(5));
    config
}

/// 아무도 듣지 않는 로컬 포트. 연결하면 바로 거절된다
pub fn closed_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").expect("포트를 열지 못했어요").local_addr().expect("주소를 읽지 못했어요").port()
}

async fn serve(mut stream: TcpStream, script: Script, tls: Option<TlsAcceptor>, seen: Arc<Seen>, closing: watch::Receiver<u64>) {
    if matches!(script, Script::Silent) {
        return session(stream, closing, false, script, &seen).await;
    }
    let Ok((first, mut params)) = read_startup(&mut stream).await else { return };
    if first == SSL_REQUEST {
        match (script, tls) {
            (Script::NotTls, _) => {
                if stream.write_all(b"S").await.is_err() || stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await.is_err() {
                    return;
                }
                return session(stream, closing, false, script, &seen).await;
            }
            (Script::TlsThenHangUp, _) => {
                // 'S'만 보내고 끊는다: 클라이언트가 보낸 ClientHello에 답하지 않고 연결이 닫힌다
                let _ = stream.write_all(b"S").await;
                return;
            }
            (Script::DeclinesTls, _) => {
                if stream.write_all(b"N").await.is_err() {
                    return;
                }
                // 'N'을 받은 클라이언트가 평문으로 이어 가는지 잠시 본다
                if let Ok(Ok(_)) = tokio::time::timeout(Duration::from_millis(300), read_startup(&mut stream)).await {
                    seen.plaintext_startups.fetch_add(1, Ordering::SeqCst);
                }
                return session(stream, closing, false, script, &seen).await;
            }
            (_, Some(acceptor)) => {
                if stream.write_all(b"S").await.is_err() {
                    return;
                }
                let Ok(mut secure) = acceptor.accept(stream).await else { return };
                // 시작 메시지는 TLS 안에서 온다: 평문 시작으로 세지 않는다
                if let Ok((_, params)) = read_startup(&mut secure).await {
                    lock(&seen.startups).push(params);
                    respond(secure, script, &seen, closing).await;
                }
                return;
            }
            (_, None) => {
                match (stream.write_all(b"N").await, read_startup(&mut stream).await) {
                    (Ok(()), Ok((_, startup_params))) => params = startup_params,
                    _ => return,
                }
            }
        }
    }
    seen.plaintext_startups.fetch_add(1, Ordering::SeqCst);
    lock(&seen.startups).push(params);
    respond(stream, script, &seen, closing).await;
}

/// 시작 메시지를 받은 뒤의 답: 오류, 또는 (비밀번호를 받고) 인증 성공과 `ReadyForQuery`
async fn respond<S>(mut stream: S, script: Script, seen: &Seen, closing: watch::Receiver<u64>)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    if let Script::Fatal { code, message } = script {
        if stream.write_all(&error_response("FATAL", code, message)).await.is_ok() {
            session(stream, closing, false, script, seen).await;
        }
        return;
    }
    if matches!(script, Script::AskPassword) {
        // AuthenticationCleartextPassword를 보내고 PasswordMessage('p')를 기다린다
        if stream.write_all(&message(b'R', &3u32.to_be_bytes())).await.is_err() {
            return;
        }
        let Ok((b'p', body)) = read_message(&mut stream).await else { return };
        let password = String::from_utf8_lossy(body.strip_suffix(&[0]).unwrap_or(&body)).into_owned();
        lock(&seen.passwords).push(password);
    }
    let mut hello = message(b'R', &0u32.to_be_bytes());
    hello.extend(message(b'K', &[FAKE_PID.to_be_bytes(), 7i32.to_be_bytes()].concat()));
    hello.extend(message(b'Z', b"I"));
    if stream.write_all(&hello).await.is_ok() {
        session(stream, closing, !matches!(script, Script::MuteAfterStartup), script, seen).await;
    }
}

/// 시작 단계 패킷 하나(태그 없이 길이, 코드, 나머지)를 읽는다. 코드와, 시작 메시지면 그 매개변수(`user`, `database` …)를 돌려준다
async fn read_startup<S>(stream: &mut S) -> io::Result<(u32, HashMap<String, String>)>
where
    S: AsyncRead + Unpin,
{
    let len = stream.read_u32().await?;
    let code = stream.read_u32().await?;
    let mut rest = vec![0u8; (len as usize).saturating_sub(8)];
    stream.read_exact(&mut rest).await?;
    // 매개변수는 "이름\0값\0"이 이어지고 \0 하나로 끝난다
    let mut fields = rest.split(|byte| *byte == 0).map(|field| String::from_utf8_lossy(field).into_owned());
    let mut params = HashMap::new();
    while let (Some(name), Some(value)) = (fields.next(), fields.next()) {
        if name.is_empty() {
            break;
        }
        params.insert(name, value);
    }
    Ok((code, params))
}

/// 시작이 끝난 뒤의 메시지(태그, 길이, 본문) 하나
async fn read_message<S>(stream: &mut S) -> io::Result<(u8, Vec<u8>)>
where
    S: AsyncRead + Unpin,
{
    let tag = stream.read_u8().await?;
    let len = stream.read_u32().await?;
    let mut body = vec![0u8; (len as usize).saturating_sub(4)];
    stream.read_exact(&mut body).await?;
    Ok((tag, body))
}

/// 연결을 열어 둔다. `answer`면 `SELECT pg_backend_pid()`의 확장 질의 흐름과 단순 질의에 답하고, 아니면 들어오는 바이트를 버린다.
/// 클라이언트가 닫거나 `close_connections`가 불리면 끝나고, 그때 연결이 닫힌다
async fn session<S>(mut stream: S, mut closing: watch::Receiver<u64>, answer: bool, script: Script, seen: &Seen)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    if !answer {
        let mut sink = [0u8; 1024];
        loop {
            tokio::select! {
                _ = closing.changed() => return,
                read = stream.read(&mut sink) => if matches!(read, Ok(0) | Err(_)) { return },
            }
        }
    }
    // 다음 Sync까지 받은 메시지에 대한 답
    let mut pending: Vec<u8> = Vec::new();
    // 확장 질의가 오류가 나면 서버는 다음 Sync까지 오는 메시지를 버린다
    let mut failed = false;
    // `Script::SilentAfterPid`가 첫 `COMMIT`에 답한 뒤: 받는 것을 모두 버리고 답하지 않는다(클라이언트의 종료 메시지만 본다)
    let mut quiet = false;
    loop {
        tokio::select! {
            _ = closing.changed() => return,
            received = read_message(&mut stream) => {
                let Ok((tag, body)) = received else { return };
                if quiet && tag != b'X' {
                    continue;
                }
                if failed && !matches!(tag, b'S' | b'X') {
                    continue;
                }
                match tag {
                    b'X' => return,
                    b'Q' => {
                        // 단순 질의: 문장을 적어 두고 바로 끝났다고 답한다. 명령 태그는 문장의 첫 낱말이면 된다
                        let sql = String::from_utf8_lossy(body.strip_suffix(&[0]).unwrap_or(&body)).into_owned();
                        let command = sql.split_whitespace().next().unwrap_or_default().to_uppercase();
                        let rule = match script {
                            Script::Writes(rules) => rules.iter().find(|rule| sql.to_uppercase().contains(&rule.contains.to_uppercase())),
                            _ => None,
                        };
                        lock(&seen.queries).push(sql);
                        let mut reply = Vec::new();
                        let mut errored = false;
                        for step in rule.map_or(&[][..], |rule| rule.reply) {
                            match *step {
                                Reply::Notice { severity, code, message: text } => reply.extend(notice_response(severity, code, text)),
                                Reply::Error { code, message: text } => {
                                    reply.extend(error_response("ERROR", code, text));
                                    errored = true;
                                }
                                Reply::Fatal { code, message: text } => {
                                    reply.extend(error_response("FATAL", code, text));
                                    let _ = stream.write_all(&reply).await;
                                    return;
                                }
                                Reply::Row(value) => reply.extend(text_row(value)),
                                Reply::HangUp => return,
                                Reply::Stall => {
                                    // 지금까지의 답은 보내고(알림 …) 그다음은 말이 없다. 서버가 닫을 때까지 열어 둔다
                                    let _ = stream.write_all(&reply).await;
                                    let _ = closing.changed().await;
                                    return;
                                }
                            }
                        }
                        if !errored {
                            reply.extend(message(b'C', format!("{command}\0").as_bytes()));
                        }
                        reply.extend(message(b'Z', b"I"));
                        if stream.write_all(&reply).await.is_err() {
                            return;
                        }
                        quiet |= matches!(script, Script::SilentAfterPid) && command == "COMMIT";
                    }
                    b'P' => {
                        // Parse: 문장 이름 \0, 질의 \0, 매개변수 타입
                        let sql = body.split(|byte| *byte == 0).nth(1).map(|query| String::from_utf8_lossy(query).into_owned()).unwrap_or_default();
                        lock(&seen.prepared).push(sql);
                        match script {
                            Script::RejectsQueries { code, message: text } => {
                                pending.clear();
                                pending.extend(error_response("ERROR", code, text));
                                failed = true;
                            }
                            _ => pending.extend(message(b'1', &[])),
                        }
                    }
                    b'D' => {
                        if body.first() == Some(&b'S') {
                            pending.extend(message(b't', &0u16.to_be_bytes()));
                        }
                        pending.extend(row_description(script));
                    }
                    b'B' => pending.extend(message(b'2', &[])),
                    b'E' => {
                        pending.extend(data_row(script));
                        pending.extend(message(b'C', b"SELECT 1\0"));
                    }
                    b'C' => pending.extend(message(b'3', &[])),
                    b'S' => {
                        pending.extend(message(b'Z', b"I"));
                        if stream.write_all(&pending).await.is_err() {
                            return;
                        }
                        pending.clear();
                        failed = false;
                    }
                    _ => {}
                }
            }
        }
    }
}

fn message(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    out.extend_from_slice(&(body.len() as u32 + 4).to_be_bytes());
    out.extend_from_slice(body);
    out
}

/// `RowDescription`: 기본은 int4 열 하나(`pg_backend_pid`)고, `Script::Row`는 문자열(text) 열들이다
fn row_description(script: Script) -> Vec<u8> {
    let columns: Vec<(&str, u32, i16)> = match script {
        Script::Row { columns, .. } => columns.iter().map(|name| (*name, 25, -1)).collect(),
        _ => vec![("pg_backend_pid", 23, 4)],
    };
    let mut body = (columns.len() as u16).to_be_bytes().to_vec();
    for (name, type_oid, type_size) in columns {
        body.extend_from_slice(name.as_bytes());
        body.push(0);
        body.extend_from_slice(&0u32.to_be_bytes()); // 테이블 OID
        body.extend_from_slice(&0u16.to_be_bytes()); // 열 번호
        body.extend_from_slice(&type_oid.to_be_bytes()); // 타입 OID: int4(23), text(25)
        body.extend_from_slice(&type_size.to_be_bytes()); // 타입 크기
        body.extend_from_slice(&(-1i32).to_be_bytes()); // 타입 변경자
        body.extend_from_slice(&0u16.to_be_bytes()); // 형식: 문 설명에서는 아직 정해지지 않아 0이다
    }
    message(b'T', &body)
}

/// `DataRow` 한 줄: 기본은 `FAKE_PID` 하나고, `Script::Row`는 값들이다(문자열은 바이너리 형식으로도 UTF-8 바이트 그대로다)
fn data_row(script: Script) -> Vec<u8> {
    let values: Vec<Vec<u8>> = match script {
        Script::Row { values, .. } => values.iter().map(|value| value.as_bytes().to_vec()).collect(),
        _ => vec![FAKE_PID.to_be_bytes().to_vec()],
    };
    let mut body = (values.len() as u16).to_be_bytes().to_vec();
    for value in values {
        body.extend_from_slice(&(value.len() as i32).to_be_bytes());
        body.extend_from_slice(&value);
    }
    message(b'D', &body)
}

/// 문자열 칸 하나(`value`)로 된 줄 하나: `RowDescription`과 `DataRow`
fn text_row(value: &str) -> Vec<u8> {
    let mut description = 1u16.to_be_bytes().to_vec();
    description.extend_from_slice(b"value\0");
    description.extend_from_slice(&0u32.to_be_bytes());
    description.extend_from_slice(&0u16.to_be_bytes());
    description.extend_from_slice(&25u32.to_be_bytes());
    description.extend_from_slice(&(-1i16).to_be_bytes());
    description.extend_from_slice(&(-1i32).to_be_bytes());
    description.extend_from_slice(&0u16.to_be_bytes());
    let mut out = message(b'T', &description);
    let mut row = 1u16.to_be_bytes().to_vec();
    row.extend_from_slice(&(value.len() as i32).to_be_bytes());
    row.extend_from_slice(value.as_bytes());
    out.extend(message(b'D', &row));
    out
}

/// `NoticeResponse`: `ErrorResponse`와 같은 칸들이고 태그만 다르다
fn notice_response(severity: &str, code: &str, text: &str) -> Vec<u8> {
    let mut body = Vec::new();
    for (field, value) in [(b'S', severity), (b'V', severity), (b'C', code), (b'M', text)] {
        body.push(field);
        body.extend_from_slice(value.as_bytes());
        body.push(0);
    }
    body.push(0);
    message(b'N', &body)
}

/// `ErrorResponse`: 심각도(`FATAL`이면 서버가 연결을 끊는 오류, `ERROR`면 이어 쓸 수 있는 오류), 오류 코드, 문구
fn error_response(severity: &str, code: &str, text: &str) -> Vec<u8> {
    let mut body = Vec::new();
    for (field, value) in [(b'S', severity), (b'V', severity), (b'C', code), (b'M', text)] {
        body.push(field);
        body.extend_from_slice(value.as_bytes());
        body.push(0);
    }
    body.push(0);
    message(b'E', &body)
}
