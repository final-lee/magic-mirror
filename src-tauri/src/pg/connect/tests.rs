use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use aws_config::{BehaviorVersion, Region, SdkConfig};
use aws_credential_types::provider::error::CredentialsError;
use aws_credential_types::provider::{future, ProvideCredentials, SharedCredentialsProvider};
use aws_credential_types::Credentials;
use tokio_postgres::config::SslMode;
use tokio_postgres::NoTls;
use tokio_postgres_rustls::MakeRustlsConnect;

use super::*;
use crate::pg::fake_server::{closed_port, plain_config, FakeServer, Script, TestPki, FAKE_PID};
use crate::pg::target::TargetKind;

fn info_at(port: u16, kind: TargetKind, iam_auth: bool) -> PgTargetInfo {
    PgTargetInfo {
        arn: "arn:aws:rds:ap-northeast-2:111111111111:cluster:aurora-1".into(),
        identifier: "aurora-1".into(),
        kind,
        engine: "aurora-postgresql".into(),
        engine_version: "16.4".into(),
        endpoint: "127.0.0.1".into(),
        port,
        default_database: "app".into(),
        iam_auth,
        read_replica: false,
    }
}

/// 고정 자격 증명과 리전을 가진 설정. 서명은 로컬에서만 하므로 네트워크를 쓰지 않는다
async fn static_config() -> SdkConfig {
    aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new("ap-northeast-2"))
        .credentials_provider(Credentials::new("AKID", "SECRET", None, None, "test"))
        .load()
        .await
}

/// 자격 증명을 만들 때마다 실패하는 공급자
#[derive(Debug)]
struct Failing(&'static str);

impl ProvideCredentials for Failing {
    fn provide_credentials<'a>(&'a self) -> future::ProvideCredentials<'a>
    where
        Self: 'a,
    {
        future::ProvideCredentials::ready(Err(CredentialsError::provider_error(self.0)))
    }
}

fn failing_config(why: &'static str) -> SdkConfig {
    SdkConfig::builder().region(Region::new("ap-northeast-2")).credentials_provider(SharedCredentialsProvider::new(Failing(why))).build()
}

const CERTIFICATE_UNVERIFIED: &str = "서버 인증서를 확인하지 못했어요";

#[test]
fn the_rds_bundle_loads() {
    // 읽지 못한 인증서가 조용히 빠지면 신뢰 저장소가 줄어든다: 번들의 인증서 블록 수와 읽은 수가 같아야 한다
    let blocks = String::from_utf8_lossy(RDS_BUNDLE).matches("-----BEGIN CERTIFICATE-----").count();
    assert!(blocks > 10, "번들에서 인증서 {blocks}개만 찾았어요");
    let roots = rds_roots().expect("앱에 넣은 번들은 읽혀야 해요");
    assert_eq!(roots.len(), blocks, "번들의 인증서 {blocks}개 중 {}개만 읽었어요", roots.len());
}

#[test]
fn a_bundle_with_an_unparsable_certificate_is_refused() {
    // PEM으로는 맞지만 인증서(DER)가 아니다. 패닉하지 않고 오류로 돌려준다
    let roots = roots_from(b"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
    assert_eq!(roots.err(), Some(AppError::other(CERTIFICATE_UNVERIFIED)));
}

#[test]
fn a_bundle_with_broken_pem_is_refused() {
    // PEM 자체가 깨졌다. `add_parsable_certificates`에는 닿지 못하는 항목이라 따로 센다
    let roots = roots_from(b"-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----\n");
    assert_eq!(roots.err(), Some(AppError::other(CERTIFICATE_UNVERIFIED)));
}

#[test]
fn a_bundle_is_never_used_partially() {
    // 읽히는 인증서 뒤에 읽히지 않는 것이 하나라도 있으면 일부만 믿는 저장소로 이어 가지 않고 통째로 거절한다
    let first_end = RDS_BUNDLE.windows(25).position(|w| w == b"-----END CERTIFICATE-----").expect("번들에 인증서가 있어야 해요") + 25;
    for (case, broken) in [
        ("DER이 아닌 항목", &b"\n-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"[..]),
        ("깨진 PEM 항목", &b"\n-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----\n"[..]),
    ] {
        let mut bundle = RDS_BUNDLE[..first_end].to_vec();
        bundle.extend_from_slice(broken);
        assert_eq!(roots_from(&bundle).err(), Some(AppError::other(CERTIFICATE_UNVERIFIED)), "{case}");
        // 같은 앞부분만이면 읽힌다: 위의 거절은 뒤에 붙인 항목 때문이다
        assert_eq!(roots_from(&bundle[..first_end]).map(|roots| roots.len()).ok(), Some(1), "{case}");
    }
}

#[test]
fn failures_read_as_the_spec_says() {
    let ctx = ConnCtx { host: "db.example", port: 5432, user: "iam_admin", database: "app" };
    let network = AppError::Network { message: "엔드포인트에 연결하지 못했어요(db.example:5432). VPN이 켜져 있는지 확인하세요".into() };
    assert_eq!(describe_failure(&ConnFailure::Timeout, &ctx), network);
    assert_eq!(describe_failure(&ConnFailure::Io("connection refused (os error 61)".into()), &ctx), network);
    assert_eq!(
        describe_failure(&ConnFailure::Auth, &ctx),
        AppError::other("IAM 인증에 실패했어요. 프로필에 rds-db:connect 권한이 있는지, DB 사용자 iam_admin에게 rds_iam이 있는지 확인하세요")
    );
    assert_eq!(describe_failure(&ConnFailure::NoRole, &ctx), AppError::other("DB 사용자 iam_admin가 없어요"));
    assert_eq!(describe_failure(&ConnFailure::Tls("invalid peer certificate: UnknownIssuer".into()), &ctx), AppError::other("서버 인증서를 확인하지 못했어요"));
    assert_eq!(
        describe_failure(&ConnFailure::Db { code: "3D000".into(), message: "database \"app\" does not exist".into() }, &ctx),
        AppError::other("app에 연결하지 못했어요: database \"app\" does not exist")
    );
}

#[test]
fn only_the_server_message_of_a_database_error_reaches_the_user() {
    let ctx = ConnCtx { host: "db.example", port: 5432, user: "iam_admin", database: "app" };
    let io = describe_failure(&ConnFailure::Io("os detail 61".into()), &ctx);
    let tls = describe_failure(&ConnFailure::Tls("rustls detail".into()), &ctx);
    let db = describe_failure(&ConnFailure::Db { code: "42501".into(), message: "permission denied".into() }, &ctx);
    assert!(!format!("{io:?}").contains("os detail") && !format!("{tls:?}").contains("rustls detail"));
    assert!(!format!("{db:?}").contains("42501"), "SQLSTATE는 문구에 넣지 않아요: {db:?}");
}

#[test]
fn iam_off_is_reported_without_connecting() {
    assert_eq!(
        connect_check(&info_at(5432, TargetKind::Cluster, false)),
        Err(AppError::other("이 클러스터는 IAM 데이터베이스 인증이 꺼져 있어요. RDS 콘솔에서 수정해 켠 뒤 다시 열어 주세요"))
    );
    assert_eq!(
        connect_check(&info_at(5432, TargetKind::Instance, false)),
        Err(AppError::other("이 인스턴스는 IAM 데이터베이스 인증이 꺼져 있어요. RDS 콘솔에서 수정해 켠 뒤 다시 열어 주세요"))
    );
    assert_eq!(connect_check(&info_at(5432, TargetKind::Cluster, true)), Ok(()));
    assert_eq!(connect_check(&info_at(5432, TargetKind::Instance, true)), Ok(()));
}

const INVALID_LOGIN: &str = "DB 사용자 이름이 올바르지 않아요. 공백이나 \" < > # & % + 같은 문자는 쓸 수 없어요";

/// 거절해야 하는 로그인 이름과 그 이유. SDK의 토큰 서명기는 앞의 다섯 종류(공백, 제어 문자, `"`, `<`, `>`)에서 패닉하고,
/// `#`·`&`·`%`·`+`는 다른 이름으로 서명한다
const UNSAFE_LOGINS: [(&str, &str); 18] = [
    ("빈 이름", ""),
    ("뒤 공백", "iam_admin "),
    ("앞 공백", " iam_admin"),
    ("가운데 공백", "iam admin"),
    ("전각 공백", "iam\u{3000}admin"),
    ("줄 바꿈", "iam_admin\n"),
    ("탭", "iam_admin\t"),
    ("NUL", "iam\u{0}admin"),
    ("DEL", "iam\u{7f}admin"),
    ("C1 제어 문자", "iam\u{9b}admin"),
    ("큰따옴표", "a\"b"),
    ("작다", "a<b"),
    ("크다", "a>b"),
    ("샵", "a#b"),
    ("앰퍼샌드", "a&b"),
    ("퍼센트", "a%b"),
    ("플러스", "a+b"),
    ("공백만", "   "),
];

#[test]
fn ordinary_login_names_pass() {
    for name in ["iam_admin", "관리자", "IAM-Admin.01", "user@corp", "a_b"] {
        assert_eq!(check_login_name(name), Ok(()), "{name}");
    }
}

#[test]
fn unsafe_login_names_are_refused() {
    for (case, name) in UNSAFE_LOGINS {
        assert_eq!(check_login_name(name), Err(AppError::other(INVALID_LOGIN)), "{case}: {name:?}");
    }
}

const TOO_LONG_LOGIN: &str = "DB 사용자 이름은 63바이트까지 쓸 수 있어요";

/// 한글 한 글자는 UTF-8로 3바이트다
fn hangul(chars: usize) -> String {
    "가".repeat(chars)
}

#[test]
fn a_login_name_of_63_bytes_passes() {
    // PostgreSQL의 식별자 한도는 글자 수가 아니라 바이트 수다. 63바이트를 이루는 서로 다른 방법들
    for name in [hangul(21), format!("{}abc", hangul(20)), "a".repeat(63), format!("{}{}", hangul(10), "a".repeat(33))] {
        assert_eq!(name.len(), 63, "{name}");
        assert_eq!(check_login_name(&name), Ok(()), "{name}");
    }
}

#[test]
fn a_login_name_over_63_bytes_is_refused() {
    // 한글 21자 + 영문 1자는 22글자지만 64바이트다. 글자 수로 세면 통과해 버린다
    for name in [format!("{}a", hangul(21)), "a".repeat(64), hangul(22), format!("{}{}", hangul(10), "a".repeat(34))] {
        assert!(name.len() >= 64, "{name}");
        assert_eq!(check_login_name(&name), Err(AppError::other(TOO_LONG_LOGIN)), "{} bytes: {name}", name.len());
    }
    assert!(format!("{}a", hangul(21)).chars().count() < 63, "글자 수로는 한도 안인 이름이어야 해요");
}

#[test]
fn the_length_is_checked_before_the_characters() {
    // 길면서 공백도 든 이름은 "너무 길다"가 먼저다
    let long_with_space = format!("{} {}", "a".repeat(40), "b".repeat(40));
    assert_eq!(check_login_name(&long_with_space), Err(AppError::other(TOO_LONG_LOGIN)));
    // 한도 안이면 공백 때문에 거절된다
    assert_eq!(check_login_name("a b"), Err(AppError::other(INVALID_LOGIN)));
}

#[tokio::test]
async fn a_login_name_that_is_too_long_is_refused_before_signing_or_dialing() {
    let name = format!("{}a", hangul(21));
    // 자격 증명이 없는 설정이다: 서명까지 갔다면 다른 오류가 났을 것이다
    let no_credentials = SdkConfig::builder().region(Region::new("ap-northeast-2")).build();
    assert_eq!(auth_token(&no_credentials, "db.example", 5432, &name).await, Err(AppError::other(TOO_LONG_LOGIN)));
    // IAM 인증이 꺼진 대상이다: 이름 검사가 맨 앞이 아니면 IAM 문구가 나온다
    let err = connect(&SdkConfig::builder().build(), &info_at(closed_port(), TargetKind::Cluster, false), &name, "app").await.err().unwrap();
    assert_eq!(err, AppError::other(TOO_LONG_LOGIN));
}

#[tokio::test]
async fn auth_token_refuses_an_unsafe_login_name_instead_of_panicking() {
    // 토큰 서명기는 `"iam_admin "`처럼 URL에 못 쓰는 이름에서 패닉한다. 서명하기 전에 걸러야 한다
    let cfg = static_config().await;
    for (case, name) in UNSAFE_LOGINS {
        assert_eq!(auth_token(&cfg, "db.example", 5432, name).await, Err(AppError::other(INVALID_LOGIN)), "{case}: {name:?}");
    }
}

#[tokio::test]
async fn the_login_name_is_checked_before_credentials_are_looked_at() {
    let no_credentials = SdkConfig::builder().region(Region::new("ap-northeast-2")).build();
    assert_eq!(auth_token(&no_credentials, "db.example", 5432, "iam_admin ").await, Err(AppError::other(INVALID_LOGIN)));
}

#[tokio::test]
async fn auth_token_signs_names_that_are_not_ascii() {
    let token = auth_token(&static_config().await, "db.example", 5432, "관리자").await.unwrap();
    assert!(token.starts_with("db.example:5432/?Action=connect&DBUser="), "토큰이 만들어졌어야 해요");
}

#[tokio::test]
async fn auth_token_is_a_signed_connect_url() {
    let token = auth_token(&static_config().await, "db.example", 5432, "iam_admin").await.unwrap();
    assert!(token.starts_with("db.example:5432/?"), "토큰은 호스트:포트/? 로 시작해야 해요");
    for part in [
        "Action=connect",
        "DBUser=iam_admin",
        "X-Amz-Algorithm=AWS4-HMAC-SHA256",
        "X-Amz-Credential=AKID%2F",
        // 서명 범위: 이 대상의 리전과 rds-db 서비스
        "%2Fap-northeast-2%2Frds-db%2Faws4_request",
        // 15분 유효
        "X-Amz-Expires=900",
        "X-Amz-Signature=",
    ] {
        assert!(token.contains(part), "토큰에 {part}가 없어요");
    }
    assert!(!token.contains("SECRET"), "비밀 키가 토큰에 들어가면 안 돼요");
}

#[tokio::test]
async fn auth_token_signs_for_the_given_host_port_and_user() {
    let cfg = static_config().await;
    let a = auth_token(&cfg, "db.example", 5432, "iam_admin").await.unwrap();
    let b = auth_token(&cfg, "other.example", 15432, "reader").await.unwrap();
    assert!(b.starts_with("other.example:15432/?") && b.contains("DBUser=reader"), "{}", b.split('&').next().unwrap());
    let signature = |token: &str| token.rsplit("X-Amz-Signature=").next().unwrap().to_string();
    assert_ne!(signature(&a), signature(&b));
}

#[tokio::test]
async fn an_expired_sso_session_asks_for_a_login() {
    // 실제로 aws-config가 내는 문구의 한 줄기: 토큰 캐시가 만료돼 새로 못 받는다
    let cfg = failing_config("an error occurred while loading an access token: the SSO token has expired and cannot be refreshed");
    assert_eq!(auth_token(&cfg, "db.example", 5432, "iam_admin").await, Err(AppError::SsoExpired));
}

#[tokio::test]
async fn other_credential_failures_keep_their_message() {
    let cfg = failing_config("Error retrieving credentials: external process exited with code exit status: 1");
    let err = auth_token(&cfg, "db.example", 5432, "iam_admin").await.unwrap_err();
    assert!(matches!(&err, AppError::Other { message } if message.contains("external process exited")), "{err:?}");
}

#[tokio::test]
async fn a_config_without_credentials_is_reported() {
    let cfg = SdkConfig::builder().region(Region::new("ap-northeast-2")).build();
    assert_eq!(auth_token(&cfg, "db.example", 5432, "iam_admin").await, Err(AppError::other("자격 증명 공급자를 찾을 수 없어요")));
}

// 아래는 `failure_of`: 가짜 서버가 진짜 `tokio_postgres::Error`를 만들어 낸다.

async fn plain_error(port: u16) -> tokio_postgres::Error {
    plain_config(port).connect(NoTls).await.err().expect("연결이 실패해야 해요")
}

async fn server_error(code: &'static str, message: &'static str) -> tokio_postgres::Error {
    let server = FakeServer::start(Script::Fatal { code, message }).await;
    plain_error(server.port).await
}

/// 서버가 TLS 협상에서 이상하게 구는 경우의 오류(실제 접속 때와 같은 TLS 설정으로)
async fn tls_error(script: Script) -> tokio_postgres::Error {
    let server = FakeServer::start(script).await;
    let mut config = plain_config(server.port);
    config.ssl_mode(SslMode::Require);
    config.connect(MakeRustlsConnect::new(tls_config().unwrap())).await.err().expect("연결이 실패해야 해요")
}

#[tokio::test]
async fn a_refused_connection_is_an_io_failure() {
    let err = plain_error(closed_port()).await;
    assert!(matches!(failure_of(&err), ConnFailure::Io(_)), "{err:?}");
}

#[tokio::test]
async fn a_failed_password_check_is_an_auth_failure() {
    let err = server_error("28P01", "password authentication failed for user \"iam_admin\"").await;
    assert_eq!(failure_of(&err), ConnFailure::Auth);
}

#[tokio::test]
async fn a_failed_pam_check_is_an_auth_failure() {
    let err = server_error("28000", "PAM authentication failed for user \"iam_admin\"").await;
    assert_eq!(failure_of(&err), ConnFailure::Auth);
}

#[tokio::test]
async fn a_missing_role_is_reported_as_one() {
    for code in ["28000", "28P01"] {
        let err = server_error(code, "role \"iam_admin\" does not exist").await;
        assert_eq!(failure_of(&err), ConnFailure::NoRole, "{code}");
    }
}

#[tokio::test]
async fn other_server_errors_keep_their_code_and_message() {
    // "does not exist"가 들어 있어도 인증 오류(28…)가 아니면 사용자가 없다는 뜻이 아니다
    let err = server_error("3D000", "database \"app\" does not exist").await;
    assert_eq!(failure_of(&err), ConnFailure::Db { code: "3D000".into(), message: "database \"app\" does not exist".into() });
    let err = server_error("53300", "too many connections for role \"iam_admin\"").await;
    assert!(matches!(failure_of(&err), ConnFailure::Db { ref code, .. } if code == "53300"));
}

#[tokio::test]
async fn a_tls_failure_is_found_even_though_io_error_hides_its_source() {
    // rustls 오류는 `io::Error`에 담겨 오고, `io::Error::source()`는 담긴 오류를 건너뛴다. 그래도 Io가 아니라 Tls여야 한다
    let err = tls_error(Script::NotTls).await;
    assert!(matches!(failure_of(&err), ConnFailure::Tls(_)), "{err:?} → {:?}", failure_of(&err));
}

#[tokio::test]
async fn a_server_that_declines_tls_is_a_tls_failure() {
    // tokio-postgres는 'N' 답을 "error performing TLS handshake"라는 TLS 종류의 오류로 올린다. 원인은 rustls도 io도 아니다
    let err = tls_error(Script::DeclinesTls).await;
    assert!(err.to_string().starts_with("error performing TLS handshake"), "{err}");
    assert!(matches!(failure_of(&err), ConnFailure::Tls(_)), "{err:?} → {:?}", failure_of(&err));
}

#[tokio::test]
async fn a_connection_lost_during_the_tls_handshake_is_still_a_network_failure() {
    // 같은 "TLS 협상 오류"라도 원인이 io 오류(연결이 끊김)면 VPN 문제다. 인증서 문구로 바꾸면 안 된다
    let err = tls_error(Script::TlsThenHangUp).await;
    assert!(err.to_string().starts_with("error performing TLS handshake"), "{err}");
    assert!(matches!(failure_of(&err), ConnFailure::Io(_)), "{err:?} → {:?}", failure_of(&err));
}

#[test]
fn the_tls_config_does_not_need_a_process_default_crypto_provider() {
    // 이 빌드에는 ring과 aws-lc-rs가 둘 다 들어 있어서 기본 공급자를 고를 수 없다. 공급자를 직접 넘겨야 패닉이 나지 않는다
    tls_config().unwrap();
}

// 아래는 TLS 검증을 진짜 핸드셰이크로 확인한다: 가짜 서버가 테스트 CA가 서명한 인증서로 TLS를 받는다.
// 접속 이름(`host`)은 인증서 검증에 쓰이고, 실제 TCP 연결은 `hostaddr`인 로컬 주소로 간다.

async fn open_tls(server: &FakeServer, host: &str, tls: ClientConfig) -> Result<Connected, ConnFailure> {
    let mut config = tokio_postgres::Config::new();
    config.host(host).hostaddr(IpAddr::V4(Ipv4Addr::LOCALHOST)).port(server.port).user("iam_admin").dbname("app").ssl_mode(SslMode::Require);
    open(&config, MakeRustlsConnect::new(tls), Duration::from_secs(5)).await
}

#[tokio::test]
async fn a_certificate_the_trusted_ca_signed_for_the_host_name_is_accepted() {
    let pki = TestPki::new(&["db.test"]);
    let server = FakeServer::start_tls(Script::Ready, &pki).await;
    let connected = open_tls(&server, "db.test", tls_config_with(pki.roots()).unwrap()).await.expect("검증을 통과해야 해요");
    // 로그인과 pid 질의까지 TLS 안에서 끝났다
    assert_eq!(connected.backend_pid, FAKE_PID);
    assert_eq!(server.plaintext_startups(), 0, "시작 메시지는 TLS 안에서 와야 해요");
}

#[tokio::test]
async fn a_certificate_the_rds_ca_did_not_sign_is_refused() {
    let pki = TestPki::new(&["db.test"]);
    let server = FakeServer::start_tls(Script::Ready, &pki).await;
    // 이름은 맞지만 접속 설정(`tls_config`)은 RDS CA만 믿는다
    let failure = open_tls(&server, "db.test", tls_config().unwrap()).await.err().expect("RDS CA가 서명하지 않은 인증서는 거절해야 해요");
    assert!(matches!(&failure, ConnFailure::Tls(reason) if reason.contains("UnknownIssuer")), "{failure:?}");
}

#[tokio::test]
async fn a_certificate_for_another_host_name_is_refused() {
    let pki = TestPki::new(&["db.test"]);
    let server = FakeServer::start_tls(Script::Ready, &pki).await;
    // CA는 믿지만 접속하려는 이름이 인증서의 이름과 다르다
    let failure = open_tls(&server, "other.test", tls_config_with(pki.roots()).unwrap()).await.err().expect("호스트 이름이 다르면 거절해야 해요");
    assert!(matches!(&failure, ConnFailure::Tls(reason) if reason.contains("not valid for name")), "{failure:?}");
}

// 아래는 `open`(연결 함수의 알맹이)과 `connect`의 실패 경로.

#[tokio::test]
async fn open_connects_spawns_the_connection_and_reads_the_backend_pid() {
    let server = FakeServer::start(Script::Ready).await;
    let connected = open(&plain_config(server.port), NoTls, Duration::from_secs(5)).await.expect("연결해야 해요");
    assert_eq!(connected.backend_pid, FAKE_PID);
    assert!(!connected.client.is_closed());
    assert_eq!(server.plaintext_startups(), 1);
    // 로그인 직후의 질의도 읽기 전용 트랜잭션 안에서 간다
    assert_eq!(
        server.simple_queries(),
        ["START TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY", "SET LOCAL statement_timeout = '30s'", "COMMIT"]
    );
}

#[tokio::test]
async fn open_gives_up_on_a_server_that_never_answers() {
    let server = FakeServer::start(Script::Silent).await;
    let failure = open(&plain_config(server.port), NoTls, Duration::from_millis(200)).await.err().expect("시간이 지나면 실패해야 해요");
    assert_eq!(failure, ConnFailure::Timeout);
}

#[tokio::test]
async fn open_gives_up_on_a_server_that_stops_answering_after_the_startup() {
    // 시작은 받아 주지만 pid 질의에는 답하지 않는다: 같은 시간 제한이 시작 뒤의 첫 질의까지 덮는다
    let server = FakeServer::start(Script::MuteAfterStartup).await;
    let failure = open(&plain_config(server.port), NoTls, Duration::from_millis(300)).await.err().expect("시간이 지나면 실패해야 해요");
    assert_eq!(failure, ConnFailure::Timeout);
    assert_eq!(server.plaintext_startups(), 1, "시작 단계는 지나갔어야 해요");
}

#[tokio::test]
async fn connect_checks_iam_auth_before_it_signs_or_dials() {
    // 자격 증명이 없고 아무도 듣지 않는 포트다. 서명이나 연결을 시도했다면 다른 오류가 났을 것이다
    let cfg = SdkConfig::builder().build();
    let err = connect(&cfg, &info_at(closed_port(), TargetKind::Cluster, false), "iam_admin", "app").await.err().unwrap();
    assert_eq!(err, AppError::other("이 클러스터는 IAM 데이터베이스 인증이 꺼져 있어요. RDS 콘솔에서 수정해 켠 뒤 다시 열어 주세요"));
}

#[tokio::test]
async fn connect_refuses_an_unsafe_login_name_before_anything_else() {
    // IAM 인증이 꺼져 있고 자격 증명도 없는 설정이다. 이름 검사가 맨 앞이 아니면 다른 오류가 나온다
    let cfg = SdkConfig::builder().build();
    for (case, name) in UNSAFE_LOGINS {
        let err = connect(&cfg, &info_at(closed_port(), TargetKind::Cluster, false), name, "app").await.err().unwrap();
        assert_eq!(err, AppError::other(INVALID_LOGIN), "{case}: {name:?}");
    }
}

#[tokio::test]
async fn connect_reports_an_unreachable_endpoint_as_a_network_error() {
    let port = closed_port();
    let err = connect(&static_config().await, &info_at(port, TargetKind::Cluster, true), "iam_admin", "app").await.err().unwrap();
    assert_eq!(err, AppError::Network { message: format!("엔드포인트에 연결하지 못했어요(127.0.0.1:{port}). VPN이 켜져 있는지 확인하세요") });
}

#[tokio::test]
async fn connect_refuses_a_server_whose_tls_cannot_be_verified() {
    let server = FakeServer::start(Script::NotTls).await;
    let err = connect(&static_config().await, &info_at(server.port, TargetKind::Cluster, true), "iam_admin", "app").await.err().unwrap();
    assert_eq!(err, AppError::other("서버 인증서를 확인하지 못했어요"));
}

#[tokio::test]
async fn connect_does_not_fall_back_to_plaintext_when_the_server_declines_tls() {
    let server = FakeServer::start(Script::DeclinesTls).await;
    let err = connect(&static_config().await, &info_at(server.port, TargetKind::Cluster, true), "iam_admin", "app").await.err().expect("TLS 없이는 연결하면 안 돼요");
    assert_eq!(err, AppError::other("서버 인증서를 확인하지 못했어요"));
    // 가짜 서버는 'N'을 보낸 뒤 평문 시작 메시지가 오는지 잠시 기다린다. 그 창이 지나도록 아무것도 오지 않아야 한다
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(server.plaintext_startups(), 0, "TLS를 거절당한 뒤 평문으로 이어 갔어요");
}

#[tokio::test]
async fn connect_logs_in_with_the_iam_token_as_the_password_over_verified_tls() {
    // 인증서가 127.0.0.1(IP 주소)에 유효하므로 엔드포인트를 그대로 접속 이름으로 쓸 수 있다
    let pki = TestPki::new(&["127.0.0.1"]);
    let server = FakeServer::start_tls(Script::AskPassword, &pki).await;
    let info = info_at(server.port, TargetKind::Cluster, true);
    let connected =
        connect_with(&static_config().await, &info, "iam_admin", "app", tls_config_with(pki.roots()).unwrap()).await.expect("연결해야 해요");
    assert_eq!(connected.backend_pid, FAKE_PID);
    // 비밀번호 자리에 간 것은 이 대상과 사용자의 IAM 토큰이다
    let passwords = server.passwords();
    assert_eq!(passwords.len(), 1);
    let expected_start = format!("127.0.0.1:{}/?Action=connect&DBUser=iam_admin&", server.port);
    assert!(passwords[0].starts_with(&expected_start) && passwords[0].contains("X-Amz-Signature="), "비밀번호가 IAM 토큰이 아니에요");
    // 로그인 사용자, 데이터베이스, 앱 이름이 시작 메시지로 갔고, 전부 TLS 안에서 갔다
    let startups = server.startups();
    assert_eq!(startups.len(), 1);
    let sent = |name: &str| startups[0][name].as_str();
    assert_eq!((sent("user"), sent("database"), sent("application_name")), ("iam_admin", "app", "magic-mirror"));
    assert_eq!(server.plaintext_startups(), 0);
}

#[tokio::test]
async fn connect_never_puts_the_token_in_an_error() {
    let cfg = static_config().await;
    let not_tls = FakeServer::start(Script::NotTls).await;
    let declines = FakeServer::start(Script::DeclinesTls).await;
    for port in [closed_port(), not_tls.port, declines.port] {
        let err = connect(&cfg, &info_at(port, TargetKind::Cluster, true), "iam_admin", "app").await.err().unwrap();
        let shown = format!("{err:?} {err}");
        for secret in ["X-Amz", "SECRET", "AKID"] {
            assert!(!shown.contains(secret), "오류에 {secret}가 들어 있어요: {shown}");
        }
    }
}
