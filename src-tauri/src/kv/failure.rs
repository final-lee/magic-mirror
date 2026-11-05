//! 접속·명령 오류를 사용자 문구로 바꾼다(순수 함수). 문구는 설계 문서의 "오류 문구"와 같다.
//! 서버가 준 오류 글에는 비밀이 없지만(`WRONGPASS invalid username-password pair`), 토큰·비밀번호는 어느 오류에도 넣지 않는다.

use fred::error::{Error as FredError, ErrorKind};

use super::command::KvCallError;
use super::model::KvAuthMode;
use crate::error::AppError;

/// 오류 문구에 넣을 접속 정보
#[derive(Debug, Clone)]
pub struct Ctx {
    pub host: String,
    pub port: u16,
    pub mode: KvAuthMode,
    pub user: String,
    pub serverless: bool,
}

pub const CERTIFICATE_UNVERIFIED: &str = "서버 인증서를 확인하지 못했어요";

pub fn unreachable_message(ctx: &Ctx) -> String {
    format!("엔드포인트에 연결하지 못했어요({}:{}). VPN이 켜져 있는지 확인하세요", ctx.host, ctx.port)
}

/// 로그인이 필요하다는 오류. 문구는 방식별이다
pub fn login_required(ctx: &Ctx) -> AppError {
    let message = match ctx.mode {
        KvAuthMode::None => "이 캐시는 로그인이 필요해요".to_string(),
        KvAuthMode::Password | KvAuthMode::User => "비밀번호가 맞지 않아요".to_string(),
        KvAuthMode::Iam => format!("IAM 인증에 실패했어요. elasticache:Connect 권한과 사용자 {}를 확인하세요", ctx.user),
    };
    AppError::LoginRequired { message }
}

/// `NOPERM User x has no permissions to run the 'get' command`에서 명령 이름
fn denied_command(details: &str) -> Option<String> {
    let start = details.find('\'')? + 1;
    let len = details[start..].find('\'')?;
    Some(details[start..start + len].to_uppercase())
}

fn is_certificate_problem(details: &str) -> bool {
    let lower = details.to_lowercase();
    ["invalidcertificate", "invalid peer certificate", "unknownissuer", "notvalidforname", "certificate verify", "badsignature"].iter().any(|m| lower.contains(m))
}

/// 서버가 인증을 요구하지 않는데 우리가 `AUTH`를 보냈다(`AUTH <password> called without any password configured for the default user`)
fn auth_not_needed(details: &str) -> bool {
    let lower = details.to_lowercase();
    lower.contains("without any password configured") || lower.contains("but no password is set") || lower.contains("no password is set")
}

/// fred 오류를 앱 오류로. `command`는 실패한 명령(권한 오류 문구에 쓴다)
pub fn map_fred(e: &FredError, ctx: &Ctx, command: &str) -> AppError {
    let details = e.details();
    let upper = details.trim_start();
    if matches!(e.kind(), ErrorKind::Tls) || is_certificate_problem(details) {
        return AppError::Network { message: CERTIFICATE_UNVERIFIED.to_string() };
    }
    if upper.starts_with("NOPERM") {
        let user = if ctx.user.is_empty() { "default" } else { ctx.user.as_str() };
        let message = match denied_command(details) {
            Some(denied) => format!("사용자 {user}에게 {denied} 권한이 없어요"),
            None if upper.contains("access a key") => format!("사용자 {user}에게 이 키를 읽을 권한이 없어요"),
            None => format!("사용자 {user}에게 {command} 권한이 없어요"),
        };
        return AppError::other(message);
    }
    if auth_not_needed(details) {
        return AppError::LoginRequired { message: "이 캐시는 비밀번호가 필요 없어요. 로그인 방식을 \"없음\"으로 바꿔 주세요".to_string() };
    }
    if matches!(e.kind(), ErrorKind::Auth) || upper.starts_with("WRONGPASS") || upper.starts_with("NOAUTH") {
        return login_required(ctx);
    }
    if matches!(e.kind(), ErrorKind::IO | ErrorKind::Timeout | ErrorKind::Canceled | ErrorKind::Routing | ErrorKind::Backpressure) {
        return AppError::Network { message: unreachable_message(ctx) };
    }
    if matches!(e.kind(), ErrorKind::Config) && details.contains("cluster support disabled") {
        return AppError::other("이 캐시는 클러스터 모드가 꺼져 있어요");
    }
    let lower = details.to_lowercase();
    if ctx.serverless && (lower.contains("unknown command") || lower.contains("not supported") || lower.contains("not allowed") || lower.contains("restricted")) {
        return AppError::other(format!("서버리스 캐시는 {command} 명령을 쓸 수 없어요"));
    }
    AppError::other(format!("서버가 오류로 답했어요: {details}"))
}

pub fn map_call(e: &KvCallError, ctx: &Ctx, command: &str) -> AppError {
    match e {
        KvCallError::Refused(app) => app.clone(),
        KvCallError::Server(fred) => map_fred(fred, ctx, command),
    }
}

/// 연결이 끊겼거나 응답이 없어 이 연결을 더 쓰면 안 되는 오류인가
pub fn is_connection_loss(e: &KvCallError) -> bool {
    matches!(e, KvCallError::Server(f) if matches!(f.kind(), ErrorKind::IO | ErrorKind::Timeout | ErrorKind::Canceled))
}

#[cfg(test)]
mod tests;
