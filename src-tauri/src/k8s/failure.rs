//! 접속과 요청 실패를 사용자 문구로 가른다. 문구는 계획의 Global Constraints와 같다.
use std::io::ErrorKind;

use crate::error::AppError;

pub const UNREACHABLE_PRIVATE: &str = "클러스터 엔드포인트에 연결하지 못했어요. 프라이빗 엔드포인트라서 Tailscale 연결을 확인해 주세요";
pub const UNREACHABLE_PUBLIC: &str = "클러스터 엔드포인트에 연결하지 못했어요. 엔드포인트의 허용 CIDR에 이 컴퓨터의 IP가 있는지 확인해 주세요";
pub const UNREACHABLE_BOTH: &str = "클러스터 엔드포인트에 연결하지 못했어요. Tailscale 연결이나 엔드포인트의 허용 CIDR을 확인해 주세요";
pub const TLS_UNVERIFIED: &str = "클러스터 인증서를 확인하지 못했어요";
pub const UNAUTHORIZED: &str = "클러스터가 이 신원을 알아보지 못했어요. EKS access entry나 aws-auth ConfigMap에 등록돼 있는지 확인해 주세요";
pub const NOT_OPENED: &str = "먼저 연결해 주세요";
const EXEC_LINE_MAX: usize = 300;
/// kubeconfig에서 명령 이름을 알 수 없을 때(spawn 실패 오류가 이름을 싣지 않는다) 쓰는 기본 exec 명령.
const DEFAULT_EXEC_COMMAND: &str = "aws";

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

/// 토큰처럼 보이는 낱말을 가린다: EKS 토큰(`k8s-aws-v1.`), JWT(`eyJ`로 시작하고 점이 둘), `Bearer` 다음 낱말.
pub fn redact_secrets(text: &str) -> String {
    let mut out = Vec::new();
    let mut bearer = false;
    for word in text.split(' ') {
        let secret = bearer || word.starts_with("k8s-aws-v1.") || (word.starts_with("eyJ") && word.matches('.').count() >= 2);
        bearer = word.eq_ignore_ascii_case("bearer");
        out.push(if secret { "[가림]" } else { word });
    }
    out.join(" ")
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
            AppError::other(exec_failed(&redact_secrets(line).chars().take(EXEC_LINE_MAX).collect::<String>()))
        }
        Failure::Other(message) => AppError::other(redact_secrets(message)),
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

pub fn failure_of(e: &kube::Error, verb: &str, resource: &str) -> Failure {
    match e {
        kube::Error::Api(status) => {
            return match status.code {
                401 => Failure::Unauthorized,
                403 => Failure::Forbidden { verb: verb.into(), resource: resource.into() },
                _ => Failure::Other(status.message.clone()),
            };
        }
        kube::Error::RustlsTls(_) => return Failure::Tls,
        kube::Error::Auth(auth) => {
            use kube::client::AuthError;
            match auth {
                AuthError::AuthExecStart(io) if io.kind() == ErrorKind::NotFound => {
                    return Failure::ExecMissing { command: DEFAULT_EXEC_COMMAND.into() };
                }
                AuthError::AuthExecRun { out, .. } => return exec_failure(&String::from_utf8_lossy(&out.stderr)),
                _ => {}
            }
        }
        _ => {}
    }
    let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(c) = cause {
        if let Some(io) = c.downcast_ref::<std::io::Error>() {
            if let Some(f) = io_kind_failure(io.kind()) {
                return f;
            }
        }
        if c.downcast_ref::<tokio::time::error::Elapsed>().is_some() {
            return Failure::Unreachable;
        }
        if let Some(f) = failure_of_chain(&c.to_string()) {
            return f;
        }
        cause = c.source();
    }
    Failure::Other(e.to_string())
}

#[cfg(test)]
mod tests;
