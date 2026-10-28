//! 접속: IAM 인증 토큰, 앱에 넣은 RDS 전역 CA로 검증하는 TLS, `tokio-postgres` 연결, 접속 오류의 사용자 문구.
//! 토큰은 연결할 때마다 새로 만들어 비밀번호 자리에만 쓴다. 로그·오류·반환값 어디에도 넣지 않는다.
//! TLS는 항상 켜져 있다. 서버 인증서와 호스트 이름을 RDS CA로 검증하고, 검증을 끄거나 평문으로 이어 가는 길은 없다.

use std::error::Error as StdError;
use std::sync::Arc;
use std::time::Duration;

use aws_config::SdkConfig;
use aws_credential_types::provider::ProvideCredentials;
use aws_sdk_rds::auth_token::{AuthTokenGenerator, Config as TokenConfig};
use aws_smithy_types::error::display::DisplayErrorContext;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::CertificateDer;
use rustls::{ClientConfig, RootCertStore};
use tokio_postgres::config::SslMode;
use tokio_postgres::tls::{MakeTlsConnect, TlsConnect};
use tokio_postgres::Socket;
use tokio_postgres_rustls::MakeRustlsConnect;

use super::catalog;
use super::target::{PgTargetInfo, TargetKind};
use crate::aws::context::credentials_error;
use crate::error::AppError;

/// 연결 시간 제한: 연결을 열고 로그인해 첫 질의에 답을 받기까지
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// TCP keepalive: 1분 놀면 10초 간격으로 세 번 확인하고, 답이 없으면 끊긴 연결로 본다.
/// 기본값은 2시간이라, VPN이 끊긴 연결을 보관함이 한참 열려 있다고 믿게 된다
const KEEPALIVE_IDLE: Duration = Duration::from_secs(60);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);
const KEEPALIVE_RETRIES: u32 = 3;

/// 앱에 넣은 RDS 전역 CA 번들. AWS가 공개한 인증서만 들어 있다
/// (https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem)
const RDS_BUNDLE: &[u8] = include_bytes!("../../certs/rds-global-bundle.pem");

const IAM_OFF_CLUSTER: &str = "이 클러스터는 IAM 데이터베이스 인증이 꺼져 있어요. RDS 콘솔에서 수정해 켠 뒤 다시 열어 주세요";
const IAM_OFF_INSTANCE: &str = "이 인스턴스는 IAM 데이터베이스 인증이 꺼져 있어요. RDS 콘솔에서 수정해 켠 뒤 다시 열어 주세요";
/// 서버 인증서를 믿을 수 없을 때의 문구: TLS 검증이 실패했을 때, 그리고 앱에 넣은 CA 번들을 읽지 못했을 때
const CERTIFICATE_UNVERIFIED: &str = "서버 인증서를 확인하지 못했어요";

/// 연결 하나. 질의는 `&mut Connected`를 받아 읽기 전용 트랜잭션을 연다.
pub struct Connected {
    pub client: tokio_postgres::Client,
    pub backend_pid: i32,
}

/// 접속이 실패한 이유. 사용자 문구는 `describe_failure`가 정한다.
/// 안에 든 문자열은 진단용이라 화면에는 나가지 않는다(`Db`의 `message`만 서버 문구 그대로 보인다).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnFailure {
    Timeout,
    Io(String),
    Tls(String),
    Auth,
    NoRole,
    Db { code: String, message: String },
}

/// 오류 문구에 넣을 접속 정보
pub struct ConnCtx<'a> {
    pub host: &'a str,
    pub port: u16,
    pub user: &'a str,
    pub database: &'a str,
}

pub fn describe_failure(f: &ConnFailure, c: &ConnCtx) -> AppError {
    match f {
        ConnFailure::Timeout | ConnFailure::Io(_) => AppError::Network {
            message: format!("엔드포인트에 연결하지 못했어요({}:{}). VPN이 켜져 있는지 확인하세요", c.host, c.port),
        },
        ConnFailure::Tls(_) => AppError::other(CERTIFICATE_UNVERIFIED),
        ConnFailure::Auth => AppError::other(format!(
            "IAM 인증에 실패했어요. 프로필에 rds-db:connect 권한이 있는지, DB 사용자 {}에게 rds_iam이 있는지 확인하세요",
            c.user
        )),
        ConnFailure::NoRole => AppError::other(format!("DB 사용자 {}가 없어요", c.user)),
        ConnFailure::Db { message, .. } => AppError::other(format!("{}에 연결하지 못했어요: {}", c.database, message)),
    }
}

/// `tokio-postgres` 오류를 `ConnFailure`로 가른다. 순서가 중요하다.
/// 1. 서버가 보낸 오류: 인증 오류(`28000`·`28P01`)는 역할이 없으면 `NoRole`, 아니면 `Auth`. 나머지는 코드와 문구를 그대로 `Db`에 담는다.
/// 2. 원인 사슬에 rustls 오류가 있으면 `Tls`.
/// 3. 원인 사슬에 `io::Error`가 있으면 `Io`. TLS 협상 도중 연결이 끊긴 경우도 여기라서 VPN 문구가 나간다.
/// 4. TLS 협상 단계의 오류인데 원인이 rustls도 io도 아니면 서버가 TLS를 거절한 것(SSLRequest에 'N')이라 `Tls`. tokio-postgres는 이것을
///    "error performing TLS handshake"라는 문구의 TLS 종류 오류로 올리고 종류를 밖으로 내놓지 않아서 문구로 알아본다(테스트가 문구를 지킨다).
/// 5. 그 밖에는 오류 문구로 `Io`.
pub fn failure_of(e: &tokio_postgres::Error) -> ConnFailure {
    if let Some(db) = e.as_db_error() {
        let (code, message) = (db.code().code(), db.message());
        if matches!(code, "28000" | "28P01") {
            return if message.contains("does not exist") { ConnFailure::NoRole } else { ConnFailure::Auth };
        }
        return ConnFailure::Db { code: code.to_string(), message: message.to_string() };
    }
    let (mut tls, mut io) = (None, None);
    let mut cause: Option<&(dyn StdError + 'static)> = Some(e);
    while let Some(err) = cause {
        if let Some(rustls_error) = err.downcast_ref::<rustls::Error>() {
            tls.get_or_insert_with(|| rustls_error.to_string());
        }
        if let Some(io_error) = err.downcast_ref::<std::io::Error>() {
            io.get_or_insert_with(|| io_error.to_string());
            // `io::Error::source()`는 담은 오류 자신을 건너뛰고 그 오류의 원인을 준다. tokio-rustls는 rustls 오류를 `io::Error`에 담아 올리므로 `get_ref()`로 직접 꺼내 본다
            if let Some(inner) = io_error.get_ref().and_then(|inner| inner.downcast_ref::<rustls::Error>()) {
                tls.get_or_insert_with(|| inner.to_string());
            }
        }
        cause = err.source();
    }
    match (tls, io) {
        (Some(tls), _) => ConnFailure::Tls(tls),
        (None, Some(io)) => ConnFailure::Io(io),
        (None, None) if e.to_string().starts_with(TLS_HANDSHAKE_ERROR) => ConnFailure::Tls(with_cause(e)),
        (None, None) => ConnFailure::Io(e.to_string()),
    }
}

/// `tokio_postgres::Error`의 TLS 종류 오류 문구(`Display`)
const TLS_HANDSHAKE_ERROR: &str = "error performing TLS handshake";

/// 오류 문구에 원인을 이어 붙인다(진단용)
fn with_cause(e: &tokio_postgres::Error) -> String {
    match e.source() {
        Some(cause) => format!("{e}: {cause}"),
        None => e.to_string(),
    }
}

/// 연결 전에 알 수 있는 거절: IAM 데이터베이스 인증이 꺼져 있으면 토큰을 만들거나 접속을 시도하지 않는다.
pub fn connect_check(info: &PgTargetInfo) -> Result<(), AppError> {
    if info.iam_auth {
        return Ok(());
    }
    Err(AppError::other(match info.kind {
        TargetKind::Cluster => IAM_OFF_CLUSTER,
        TargetKind::Instance => IAM_OFF_INSTANCE,
    }))
}

/// 번들에 든 RDS CA들. 번들은 앱에 들어 있는 고정된 파일이고 모든 인증서가 읽혀야 한다(테스트가 지킨다).
/// 읽을 수 없는 항목이 있으면 오류다: 일부만 믿는 저장소로 이어 가지 않는다.
pub fn rds_roots() -> Result<RootCertStore, AppError> {
    roots_from(RDS_BUNDLE)
}

/// PEM 번들에서 신뢰할 CA를 읽는다. 읽을 수 없는 항목이 하나라도 있으면 번들이 깨진 것이므로 오류를 돌려준다(패닉하지 않는다).
/// 일부만 읽은 신뢰 저장소로 조용히 이어 가지 않으려는 것이다. 앱에 넣은 번들은 정해져 있고 테스트가 읽어 보므로 실행 중에는 일어나지 않는다.
/// `add_parsable_certificates`는 PEM으로는 맞는데 인증서가 아닌 항목만 세므로, PEM 자체가 깨진 항목은 따로 센다.
fn roots_from(bundle: &[u8]) -> Result<RootCertStore, AppError> {
    let entries: Vec<_> = CertificateDer::pem_slice_iter(bundle).collect();
    let broken_pem = entries.iter().filter(|entry| entry.is_err()).count();
    let mut roots = RootCertStore::empty();
    let (_loaded, broken_certificates) = roots.add_parsable_certificates(entries.into_iter().flatten());
    if broken_pem + broken_certificates > 0 {
        return Err(AppError::other(CERTIFICATE_UNVERIFIED));
    }
    Ok(roots)
}

const INVALID_LOGIN_NAME: &str = "DB 사용자 이름이 올바르지 않아요. 공백이나 \" < > # & % + 같은 문자는 쓸 수 없어요";
const LOGIN_NAME_TOO_LONG: &str = "DB 사용자 이름은 63바이트까지 쓸 수 있어요";
/// PostgreSQL의 식별자 한도(`NAMEDATALEN - 1`). 글자 수가 아니라 바이트 수다
const MAX_LOGIN_NAME_BYTES: usize = 63;

/// 로그인 이름이 토큰을 서명해도 되는 이름인지 본다. 이름은 입력창의 자유 텍스트다.
/// 먼저 길이를 본다: 서버는 63바이트를 넘는 이름을 잘라서 읽으므로, 긴 이름으로 서명한 토큰은 잘린 이름과 맞지 않아 로그인이 엉뚱한 이유로 실패한다.
/// SDK의 토큰 서명기는 이름을 URL 쿼리에 그대로 붙인다. 공백·제어 문자·`"`·`<`·`>`는 URL로 읽히지 않아 서명기가 패닉하고
/// (명령 작업이 패닉하면 호출이 끝나지 않는다), `#`·`&`·`%`·`+`는 다른 이름으로 서명되어 로그인이 엉뚱한 이유로 실패한다.
/// 서명이나 접속보다 먼저 불러야 한다.
pub fn check_login_name(user: &str) -> Result<(), AppError> {
    if user.len() > MAX_LOGIN_NAME_BYTES {
        return Err(AppError::other(LOGIN_NAME_TOO_LONG));
    }
    let unsafe_char = |c: char| c.is_whitespace() || c.is_control() || matches!(c, '"' | '<' | '>' | '#' | '&' | '%' | '+');
    if user.is_empty() || user.chars().any(unsafe_char) {
        return Err(AppError::other(INVALID_LOGIN_NAME));
    }
    Ok(())
}

/// 접속에 쓰는 TLS 설정: RDS CA만 믿고, 서버 인증서와 호스트 이름을 검증한다.
fn tls_config() -> Result<ClientConfig, AppError> {
    tls_config_with(rds_roots()?)
}

/// 믿을 CA를 받는 꼴. 검증은 그대로 켜져 있고, 테스트가 자기 CA로 TLS 연결 전체를 시험하려고 나눴다.
/// 이 빌드에는 rustls의 `ring`과 `aws_lc_rs`가 둘 다 들어 있어서(다른 의존성이 켠다) 프로세스 기본 공급자를 고를 수 없다.
/// `ClientConfig::builder()`는 그러면 패닉이라 공급자를 직접 넘긴다.
fn tls_config_with(roots: RootCertStore) -> Result<ClientConfig, AppError> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let versions = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::other(format!("TLS 설정을 만들지 못했어요: {e}")))?;
    Ok(versions.with_root_certificates(roots).with_no_client_auth())
}

/// IAM 데이터베이스 인증 토큰(15분 유효)을 만든다. 서명은 로컬에서 하고 네트워크를 쓰지 않는다(자격 증명을 새로 받아야 할 때만 예외).
/// 자격 증명을 얻지 못하면 AWS 호출과 같은 분류를 거친다: 만료된 SSO 세션은 `SsoExpired`가 되어 자동 로그인이 이어받는다.
///
/// 자격 증명은 SdkConfig의 캐시를 거치지 않고 공급자 사슬에 바로 요청한다(SDK의 토큰 서명기도 그렇게 한다).
/// SSO나 역할 맡기 프로필은 새 연결마다 한 번 더 네트워크를 쓸 수 있고, 여러 데이터베이스를 잇따라 여는 점검이 그만큼 곱해진다.
/// 새 연결마다 한 번이라 받아들였다.
pub async fn auth_token(cfg: &SdkConfig, host: &str, port: u16, user: &str) -> Result<String, AppError> {
    check_login_name(user)?;
    let provider = cfg.credentials_provider().ok_or_else(|| AppError::other("자격 증명 공급자를 찾을 수 없어요"))?;
    let credentials = provider.provide_credentials().await.map_err(|e| credentials_error(&format!("{}", DisplayErrorContext(&e))))?;
    let signing_error = |e: &dyn StdError| AppError::other(format!("IAM 인증 토큰을 만들지 못했어요: {e}"));
    let generator = AuthTokenGenerator::new(
        TokenConfig::builder()
            .credentials(credentials)
            .hostname(host)
            .port(u64::from(port))
            .username(user)
            .build()
            .map_err(|e| signing_error(&*e))?,
    );
    let token = generator.auth_token(cfg).await.map_err(|e| signing_error(&*e))?;
    Ok(token.as_str().to_string())
}

/// 대상 엔드포인트에 IAM 인증으로 연결한다. 토큰은 연결할 때마다 새로 만든다.
pub async fn connect(cfg: &SdkConfig, info: &PgTargetInfo, user: &str, database: &str) -> Result<Connected, AppError> {
    check_login_name(user)?;
    connect_check(info)?;
    connect_with(cfg, info, user, database, tls_config()?).await
}

/// `connect`의 알맹이. TLS 설정을 받는 꼴이라 테스트가 자기 CA로 로그인 전체를 시험한다.
async fn connect_with(cfg: &SdkConfig, info: &PgTargetInfo, user: &str, database: &str, tls: ClientConfig) -> Result<Connected, AppError> {
    let token = auth_token(cfg, &info.endpoint, info.port, user).await?;
    let mut config = tokio_postgres::Config::new();
    config
        .host(&info.endpoint)
        .port(info.port)
        .user(user)
        .password(token)
        .dbname(database)
        .ssl_mode(SslMode::Require)
        .connect_timeout(CONNECT_TIMEOUT)
        .application_name("magic-mirror")
        .keepalives(true)
        .keepalives_idle(KEEPALIVE_IDLE)
        .keepalives_interval(KEEPALIVE_INTERVAL)
        .keepalives_retries(KEEPALIVE_RETRIES);
    let ctx = ConnCtx { host: &info.endpoint, port: info.port, user, database };
    open(&config, MakeRustlsConnect::new(tls), CONNECT_TIMEOUT).await.map_err(|failure| describe_failure(&failure, &ctx))
}

/// 연결을 열고 로그인해 서버 쪽 pid까지 읽는다. 전체에 `limit`을 건다: 넘기면 `Timeout`.
async fn open<T>(config: &tokio_postgres::Config, tls: T, limit: Duration) -> Result<Connected, ConnFailure>
where
    T: MakeTlsConnect<Socket> + 'static + Send,
    T::TlsConnect: Send,
    T::Stream: Send + 'static,
    <T::TlsConnect as TlsConnect<Socket>>::Future: Send,
{
    let attempt = async {
        let (mut client, connection) = config.connect(tls).await.map_err(|e| failure_of(&e))?;
        tokio::spawn(async move {
            // 클라이언트를 놓거나 서버가 닫으면 끝난다. 끝난 연결은 `client.is_closed()`로 알 수 있고, 오류는 다음 질의가 받는다
            let _ = connection.await;
        });
        // 질의와 트랜잭션은 `catalog`에만 둔다. 서버 쪽 pid도 거기서 읽기 전용 트랜잭션으로 읽는다
        let backend_pid = catalog::backend_pid(&mut client).await.map_err(|e| failure_of(&e))?;
        Ok(Connected { client, backend_pid })
    };
    tokio::time::timeout(limit, attempt).await.unwrap_or(Err(ConnFailure::Timeout))
}

#[cfg(test)]
mod tests;
