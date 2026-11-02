//! 접속과 요청 실패를 사용자 문구로 가른다. 문구는 계획의 Global Constraints와 같다.
use std::io::ErrorKind;

use kube::client::AuthError;

use crate::error::AppError;

pub const UNREACHABLE_PRIVATE: &str = "클러스터 엔드포인트에 연결하지 못했어요. 프라이빗 엔드포인트라서 Tailscale 연결을 확인해 주세요";
pub const UNREACHABLE_PUBLIC: &str = "클러스터 엔드포인트에 연결하지 못했어요. 엔드포인트의 허용 CIDR에 이 컴퓨터의 IP가 있는지 확인해 주세요";
pub const UNREACHABLE_BOTH: &str = "클러스터 엔드포인트에 연결하지 못했어요. Tailscale 연결이나 엔드포인트의 허용 CIDR을 확인해 주세요";
pub const TLS_UNVERIFIED: &str = "클러스터 인증서를 확인하지 못했어요";
pub const UNAUTHORIZED: &str = "클러스터가 이 신원을 알아보지 못했어요. EKS access entry나 aws-auth ConfigMap에 등록돼 있는지 확인해 주세요";
pub const NOT_OPENED: &str = "먼저 연결해 주세요";
/// exec·attach·port-forward 요청이 404로 거절됐을 때(Pod가 없다)
pub const STREAM_NOT_FOUND: &str = "Pod를 찾을 수 없어요. 이미 지워졌는지 확인해 주세요";
const EXEC_LINE_MAX: usize = 300;
/// kubeconfig에서 명령 이름을 알 수 없을 때(spawn 실패 오류가 이름을 싣지 않는다) 쓰는 기본 exec 명령.
const DEFAULT_EXEC_COMMAND: &str = "aws";

/// exec 플러그인 출력(ExecCredential)을 해석하지 못했을 때의 고정 사유. 해석 오류의 글에는 출력 조각(클라이언트 키 등)이 실릴 수 있어 쓰지 않는다.
pub const EXEC_OUTPUT_UNPARSEABLE: &str = "인증 명령의 출력을 해석하지 못했어요";

/// API가 메시지 없이 돌려준 오류의 문구
pub fn api_error(code: u16) -> String {
    format!("클러스터가 오류를 돌려줬어요(HTTP {code})")
}

pub fn exec_missing(command: &str) -> String {
    format!("kubeconfig의 인증 명령({command})을 찾지 못했어요. aws CLI가 설치돼 있는지 확인해 주세요")
}
pub fn exec_failed(line: &str) -> String {
    format!("kubeconfig의 인증 명령이 실패했어요: {line}")
}

#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    ExecMissing { command: String },
    ExecFailed { stderr: String },
    SsoExpired,
    Unreachable,
    Tls,
    Unauthorized,
    Forbidden { verb: String, resource: String },
    Other(String),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Endpoint {
    pub public: bool,
    pub private: bool,
}

/// exec 플러그인의 stderr로 SSO 만료를 알아본다. 나머지는 실패 그대로.
pub fn exec_failure(stderr: &str) -> Failure {
    let lower = stderr.to_lowercase();
    let sso = lower.contains("token has expired")
        || (lower.contains("sso session") && (lower.contains("expired") || lower.contains("invalid")))
        || lower.contains("error loading sso token");
    if sso {
        Failure::SsoExpired
    } else {
        Failure::ExecFailed { stderr: stderr.to_string() }
    }
}

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '+' | '/' | '=')
}

/// 토큰처럼 보이는 부분을 가린다: EKS 토큰(`k8s-aws-v1.`), JWT(`eyJ`로 시작하고 점이 둘 이상), `Bearer` 다음 낱말.
/// 낱말 경계에 기대지 않고 글 어디서든 찾는다(따옴표 안, JSON 안, `=`/`:` 뒤, `Bearer` 뒤의 탭이나 겹 공백).
pub fn redact_secrets(text: &str) -> String {
    const MASK: &str = "[가림]";
    let chars: Vec<char> = text.chars().collect();
    let starts = |i: usize, p: &str| chars[i..].iter().zip(p.chars()).filter(|(c, q)| c.eq_ignore_ascii_case(q)).count() == p.chars().count();
    let token_end = |i: usize| i + chars[i..].iter().take_while(|c| is_token_char(**c)).count();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i..].starts_with(&['k', '8', 's', '-', 'a', 'w', 's', '-', 'v', '1', '.']) {
            out.push_str(MASK);
            i = token_end(i);
        } else if chars[i..].starts_with(&['e', 'y', 'J']) {
            let end = token_end(i);
            if chars[i..end].iter().filter(|c| **c == '.').count() >= 2 {
                out.push_str(MASK);
            } else {
                out.extend(&chars[i..end]);
            }
            i = end;
        } else if starts(i, "bearer") {
            out.extend(&chars[i..i + 6]);
            i += 6;
            let ws = chars[i..].iter().take_while(|c| c.is_whitespace()).count();
            out.extend(&chars[i..i + ws]);
            i += ws;
            let end = i + chars[i..].iter().take_while(|c| !c.is_whitespace() && !matches!(**c, '"' | '\'' | ',' | '}' | ']')).count();
            if end > i {
                out.push_str(MASK);
            }
            i = end;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn capped(text: &str) -> String {
    redact_secrets(text).chars().take(EXEC_LINE_MAX).collect()
}

/// 해석 오류의 사유: 첫 줄만(YAML 오류는 이어서 원문 조각을 그린다), 토큰을 가리고 300자로 자른다.
pub fn short_reason(err: &impl std::fmt::Display) -> String {
    let text = err.to_string();
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    capped(line)
}

pub fn describe(f: &Failure, endpoint: Endpoint) -> AppError {
    match f {
        Failure::SsoExpired => AppError::SsoExpired,
        Failure::Unreachable => AppError::Network {
            message: match (endpoint.public, endpoint.private) {
                (false, true) => UNREACHABLE_PRIVATE,
                (true, false) => UNREACHABLE_PUBLIC,
                _ => UNREACHABLE_BOTH,
            }
            .into(),
        },
        Failure::Tls => AppError::other(TLS_UNVERIFIED),
        Failure::Unauthorized => AppError::other(UNAUTHORIZED),
        Failure::Forbidden { verb, resource } => AppError::AccessDenied { action: format!("{verb} {resource}") },
        Failure::ExecMissing { command } => AppError::other(exec_missing(command)),
        Failure::ExecFailed { stderr } => {
            let line = stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
            AppError::other(exec_failed(&capped(line)))
        }
        Failure::Other(message) => AppError::other(capped(message)),
    }
}

/// 오류 체인의 한 토막 글에서 인증서 문제와 연결 문제를 알아본다. 인증서가 먼저다(핸드셰이크 오류 글에 연결 낱말이 섞일 수 있다).
pub fn failure_of_chain(chain: &str) -> Option<Failure> {
    let lower = chain.to_lowercase();
    if ["certificate", "unknownissuer", "unknown issuer"].iter().any(|k| lower.contains(k)) {
        return Some(Failure::Tls);
    }
    let unreachable = [
        "connection refused",
        "connection reset",
        "timed out",
        "deadline has elapsed",
        "no route to host",
        "network is unreachable",
        "dns error",
        "failed to lookup address",
        "name or service not known",
        "nodename nor servname",
    ];
    unreachable.iter().any(|k| lower.contains(k)).then_some(Failure::Unreachable)
}

fn io_kind_failure(kind: ErrorKind) -> Option<Failure> {
    // HostUnreachable, NetworkUnreachable는 안정화된 ErrorKind라 바로 쓴다.
    matches!(
        kind,
        ErrorKind::ConnectionRefused | ErrorKind::TimedOut | ErrorKind::ConnectionReset | ErrorKind::HostUnreachable | ErrorKind::NetworkUnreachable
    )
    .then_some(Failure::Unreachable)
}

/// exec 플러그인 오류만 가른다. `AuthExecRun`의 Display는 플러그인 stdout까지 담으니 그 글은 절대 쓰지 않는다.
fn auth_failure(auth: &AuthError) -> Option<Failure> {
    match auth {
        AuthError::AuthExecStart(io) if io.kind() == ErrorKind::NotFound => Some(Failure::ExecMissing { command: DEFAULT_EXEC_COMMAND.into() }),
        AuthError::AuthExecParse(_) => Some(Failure::ExecFailed { stderr: EXEC_OUTPUT_UNPARSEABLE.into() }),
        AuthError::AuthExecRun { out, .. } => Some(exec_failure(&String::from_utf8_lossy(&out.stderr))),
        _ => None,
    }
}

pub fn failure_of(e: &kube::Error, verb: &str, resource: &str) -> Failure {
    match e {
        kube::Error::Api(status) => {
            return match status.code {
                401 => Failure::Unauthorized,
                403 => Failure::Forbidden { verb: verb.into(), resource: resource.into() },
                _ if status.message.is_empty() => Failure::Other(api_error(status.code)),
                _ => Failure::Other(status.message.clone()),
            };
        }
        kube::Error::RustlsTls(_) => return Failure::Tls,
        kube::Error::Auth(auth) => {
            if let Some(f) = auth_failure(auth) {
                return f;
            }
        }
        _ => {}
    }
    // 먼저 종류로 알아볼 수 있는 것(exec 플러그인 오류, io, 시간 초과)을 체인 전체에서 찾고, 그다음에 글로 가른다.
    // 바깥 `Error::Service`의 글에는 플러그인 stderr가 섞여 있어, 글을 먼저 보면 exec 실패가 인증서나 연결 문제로 잘못 가려진다.
    // 토큰 갱신 중의 exec 실패는 `Error::Service(Box<AuthError>)`로 온다.
    let chain = || std::iter::successors(Some(e as &(dyn std::error::Error + 'static)), |c| c.source());
    for c in chain() {
        if let Some(f) = c.downcast_ref::<AuthError>().and_then(auth_failure) {
            return f;
        }
        if let Some(io) = c.downcast_ref::<std::io::Error>() {
            if let Some(f) = io_kind_failure(io.kind()) {
                return f;
            }
        }
        if c.downcast_ref::<tokio::time::error::Elapsed>().is_some() {
            return Failure::Unreachable;
        }
    }
    for c in chain() {
        if let Some(f) = failure_of_chain(&c.to_string()) {
            return f;
        }
    }
    Failure::Other(e.to_string())
}

/// 웹소켓으로 여는 요청(exec, attach, port-forward)의 실패. 업그레이드가 거절되면 상태 코드만 남아서(본문의 메시지는 버려진다) 코드로 가르고, 나머지는 `failure_of`와 같다.
pub fn stream_failure_of(e: &kube::Error, verb: &str, resource: &str) -> Failure {
    if let kube::Error::UpgradeConnection(kube::client::UpgradeConnectionError::ProtocolSwitch(code)) = e {
        return match code.as_u16() {
            401 => Failure::Unauthorized,
            403 => Failure::Forbidden { verb: verb.into(), resource: resource.into() },
            404 => Failure::Other(STREAM_NOT_FOUND.into()),
            other => Failure::Other(api_error(other)),
        };
    }
    failure_of(e, verb, resource)
}

#[cfg(test)]
mod tests;
