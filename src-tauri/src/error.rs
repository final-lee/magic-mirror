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
    /// KV 탭: 로그인이 필요하다(인증 실패, 저장된 비밀번호 없음, 방식이 맞지 않음). 화면은 `message`와 함께 로그인 창을 띄운다
    #[error("{message}")]
    LoginRequired { message: String },
    #[error("변경된 상태가 있어 미리보기를 다시 만들어야 해요")]
    StalePlan,
    /// 엿보기: 시작 직전에 다시 계산한 판정에 경고가 있는데 큐 이름 확인이 없었다. 화면은 `warning`을 보여 주고 이름을 다시 받는다
    #[error("{message}")]
    PeekConfirm { warning: String, message: String },
}

impl AppError {
    pub fn other(message: impl Into<String>) -> Self {
        AppError::Other { message: message.into() }
    }
}

/// 자격 증명을 얻는 단계(역할 맡기, SSO 역할 자격 증명 받기)에서 거부된 오류. 만료가 아니라서 다시 로그인해도 풀리지 않는다.
/// SSO를 거친 역할의 ARN(`AWSReservedSSO_…`)이 오류 문자열에 들어 있어도 만료로 보지 않도록 SSO 판정보다 먼저 본다.
/// `lower`는 소문자로 바꾼 오류 체인이다.
pub(crate) fn credential_denial(lower: &str) -> Option<AppError> {
    let denied = lower.contains("accessdenied") || lower.contains("not authorized to perform") || lower.contains("forbiddenexception");
    if !denied {
        return None;
    }
    if lower.contains("assumerole") {
        return Some(AppError::AccessDenied { action: "sts:AssumeRole".into() });
    }
    if lower.contains("getrolecredentials") || lower.contains("forbiddenexception") {
        return Some(AppError::AccessDenied { action: "sso:GetRoleCredentials".into() });
    }
    None
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
    if let Some(denied) = credential_denial(&lower) {
        return denied;
    }
    // 포털의 401 문구와 지워진 토큰 캐시 파일은 "sso"가 헤더나 경로에만 있어도 알아본다
    if lower.contains("session token not found or invalid")
        || lower.contains("/.aws/sso/cache/")
        || (lower.contains("sso") && (lower.contains("token") || lower.contains("expired") || lower.contains("unauthorized")))
    {
        return AppError::SsoExpired;
    }
    // 서비스가 답한 오류(코드가 있음)는 네트워크 오류가 아니다. 응답 헤더의 "connection: keep-alive" 같은 글자에 속지 않게 코드가 없을 때만 본다
    if code.is_none()
        && (lower.contains("dispatch failure") || lower.contains("timeout") || lower.contains("timed out") || lower.contains("connection") || lower.contains("dns"))
    {
        return AppError::Network { message: chain.to_string() };
    }
    AppError::Other { message: chain.to_string() }
}

/// 서비스가 답한 오류의 한 줄: `작업: 메시지 (코드)`. 응답 전체(헤더·본문 Debug)는 화면에 싣지 않는다
fn service_message(action: &str, code: &str, message: Option<&str>) -> String {
    match message.filter(|m| !m.is_empty()) {
        Some(m) => format!("{action}: {m} ({code})"),
        None => format!("{action}: {code}"),
    }
}

pub fn from_sdk<E, R>(err: SdkError<E, R>, action: &str) -> AppError
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
    R: std::fmt::Debug + Send + Sync + 'static,
{
    let code = err.code().map(str::to_owned);
    let chain = format!("{}", DisplayErrorContext(&err));
    match (classify(code.as_deref(), &chain, action), code.as_deref()) {
        (AppError::Other { .. }, Some(code)) => AppError::Other { message: service_message(action, code, err.message()) },
        (other, _) => other,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    // 실제 aws-config 오류 체인의 모양(Debug 꼬리는 줄였다). 손으로 꾸민 문자열에 기대지 않으려고 실제와 같은 문구를 쓴다.
    const SSO_ROLE_DENIED: &str = "dispatch failure: other: an error occurred while loading credentials: an error occurred while loading credentials: \
        service error: unhandled error (AccessDenied): Error { code: \"AccessDenied\", message: \"User: arn:aws:sts::111111111111:assumed-role/\
        AWSReservedSSO_Admin_0123abcd/jane is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::222222222222:role/Deploy\", \
        aws_request_id: \"x\" }";
    pub(crate) const PORTAL_FORBIDDEN: &str = "an error occurred while loading credentials: an error occurred while loading credentials: service error: \
        unhandled error (ForbiddenException): Error { code: \"ForbiddenException\", message: \"No access\", aws_request_id: \"x\" } \
        (raw: Response { status: StatusCode(403), headers: {\"content-type\": \"application/json\", \"server\": \"AWS SSO\"} })";
    const PORTAL_UNAUTHORIZED: &str = "dispatch failure: other: an error occurred while loading credentials: an error occurred while loading credentials: \
        service error: unhandled error (UnauthorizedException): Error { code: \"UnauthorizedException\", message: \"Session token not found or invalid\", \
        aws_request_id: \"x\" }";
    const TOKEN_FILE_MISSING: &str = "dispatch failure: other: an error occurred while loading credentials: failed to read \
        `/Users/jane/.aws/sso/cache/0123456789abcdef0123456789abcdef01234567.json`: No such file or directory (os error 2)";

    #[test]
    fn a_denied_assume_role_through_an_sso_role_is_not_an_expired_session() {
        assert_eq!(classify(None, SSO_ROLE_DENIED, "ec2:DescribeInstances"), AppError::AccessDenied { action: "sts:AssumeRole".into() });
        assert_eq!(credential_denial(&SSO_ROLE_DENIED.to_lowercase()), Some(AppError::AccessDenied { action: "sts:AssumeRole".into() }));
    }

    #[test]
    fn a_forbidden_sso_role_assignment_is_access_denied() {
        // 실제 체인에는 작업 이름이 없고 "server": "AWS SSO" 헤더만 있다
        assert_eq!(classify(None, PORTAL_FORBIDDEN, "x"), AppError::AccessDenied { action: "sso:GetRoleCredentials".into() });
    }

    #[test]
    fn expired_or_missing_sso_tokens_are_still_expired() {
        assert_eq!(credential_denial("the sso session token has expired"), None);
        // 포털의 401에는 "sso"가 헤더에만 있을 수 있다: 문구로 직접 알아본다
        assert_eq!(classify(None, PORTAL_UNAUTHORIZED, "x"), AppError::SsoExpired);
        // aws sso logout이 토큰 캐시 파일을 지운 경우
        assert_eq!(classify(None, TOKEN_FILE_MISSING, "x"), AppError::SsoExpired);
    }

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
    fn a_service_error_whose_raw_response_mentions_connection_is_not_a_network_error() {
        // 실제 SNS 응답(FIFO 주제의 GetDataProtectionPolicy): 헤더에 "connection": "keep-alive"가 있다
        let chain = "service error: unhandled error (InvalidAction): Error { code: \"InvalidAction\", message: \"Operation (GetDataProtectionPolicy) \
            is not supported on FIFO topics\" } (raw: Response { status: StatusCode(400), headers: {\"content-type\": \"text/xml\", \
            \"connection\": \"keep-alive\"} })";
        assert!(matches!(classify(Some("InvalidAction"), chain, "sns:GetDataProtectionPolicy"), AppError::Other { .. }));
        // 코드가 없으면 예전처럼 연결 문제로 본다
        assert!(matches!(classify(None, "io error: connection reset by peer", "x"), AppError::Network { .. }));
    }

    #[test]
    fn service_errors_are_one_line() {
        assert_eq!(
            service_message("sns:GetDataProtectionPolicy", "InvalidAction", Some("Operation (GetDataProtectionPolicy) is not supported on FIFO topics")),
            "sns:GetDataProtectionPolicy: Operation (GetDataProtectionPolicy) is not supported on FIFO topics (InvalidAction)"
        );
        assert_eq!(service_message("sqs:GetQueueUrl", "QueueDoesNotExist", None), "sqs:GetQueueUrl: QueueDoesNotExist");
    }

    #[test]
    fn serializes_with_kind_tag() {
        let v = serde_json::to_value(AppError::AccessDenied { action: "iam:ListUsers".into() }).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "accessDenied", "action": "iam:ListUsers" }));
        let v = serde_json::to_value(AppError::SsoExpired).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "ssoExpired" }));
    }
}
