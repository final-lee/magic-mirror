use aws_smithy_runtime_api::client::result::SdkError;
use aws_smithy_types::error::display::DisplayErrorContext;
use aws_smithy_types::error::metadata::ProvideErrorMetadata;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppError {
    #[error("SSO 세션이 만료됐어요")]
    SsoExpired,
    #[error("권한 없음 ({action})")]
    AccessDenied { action: String },
    #[error("요청이 너무 많아요")]
    Throttled,
    #[error("네트워크 오류: {message}")]
    Network { message: String },
    #[error("{message}")]
    Other { message: String },
}

impl AppError {
    pub fn other(message: impl Into<String>) -> Self {
        AppError::Other { message: message.into() }
    }
}

/// AWS 오류 코드와 오류 체인 문자열로 사용자에게 보여줄 오류 종류를 정한다.
pub fn classify(code: Option<&str>, chain: &str, action: &str) -> AppError {
    if let Some(c) = code {
        if c.contains("AccessDenied") || c == "UnauthorizedOperation" || c == "AuthorizationError" {
            return AppError::AccessDenied { action: action.to_string() };
        }
        if c.contains("Throttl") || c == "RequestLimitExceeded" || c == "TooManyRequestsException" || c == "SlowDown" {
            return AppError::Throttled;
        }
        if c == "ExpiredToken" || c == "ExpiredTokenException" {
            return AppError::SsoExpired;
        }
    }
    let lower = chain.to_lowercase();
    if lower.contains("sso") && (lower.contains("token") || lower.contains("expired") || lower.contains("unauthorized")) {
        return AppError::SsoExpired;
    }
    if lower.contains("dispatch failure") || lower.contains("timeout") || lower.contains("timed out") || lower.contains("connection") || lower.contains("dns") {
        return AppError::Network { message: chain.to_string() };
    }
    AppError::Other { message: chain.to_string() }
}

pub fn from_sdk<E, R>(err: SdkError<E, R>, action: &str) -> AppError
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
    R: std::fmt::Debug + Send + Sync + 'static,
{
    let code = err.code().map(str::to_owned);
    let chain = format!("{}", DisplayErrorContext(&err));
    classify(code.as_deref(), &chain, action)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_denied_codes() {
        for code in ["AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "AuthorizationError"] {
            assert_eq!(
                classify(Some(code), "", "ec2:DescribeInstances"),
                AppError::AccessDenied { action: "ec2:DescribeInstances".into() },
                "code {code}"
            );
        }
    }

    #[test]
    fn throttling_codes() {
        for code in ["Throttling", "ThrottlingException", "RequestLimitExceeded", "TooManyRequestsException", "SlowDown"] {
            assert_eq!(classify(Some(code), "", "x"), AppError::Throttled, "code {code}");
        }
    }

    #[test]
    fn expired_credentials() {
        assert_eq!(classify(Some("ExpiredToken"), "", "x"), AppError::SsoExpired);
        assert_eq!(classify(Some("ExpiredTokenException"), "", "x"), AppError::SsoExpired);
        assert_eq!(
            classify(None, "failed to load credentials: the SSO session token has expired", "x"),
            AppError::SsoExpired
        );
    }

    #[test]
    fn network_errors() {
        let e = classify(None, "dispatch failure: io error: connection refused", "x");
        assert!(matches!(e, AppError::Network { .. }), "{e:?}");
    }

    #[test]
    fn other_errors_keep_message() {
        assert_eq!(
            classify(Some("ValidationException"), "ValidationException: bad input", "x"),
            AppError::Other { message: "ValidationException: bad input".into() }
        );
    }

    #[test]
    fn serializes_with_kind_tag() {
        let v = serde_json::to_value(AppError::AccessDenied { action: "iam:ListUsers".into() }).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "accessDenied", "action": "iam:ListUsers" }));
        let v = serde_json::to_value(AppError::SsoExpired).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "ssoExpired" }));
    }
}
