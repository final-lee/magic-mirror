use std::os::unix::process::ExitStatusExt;
use std::process::{ExitStatus, Output};

use kube::client::AuthError;
use kube::core::Status;

use super::*;

const SSO_STDERR: &str = "\nError when retrieving token from sso: Token has expired and refresh failed\n";
const DENIED_STDERR: &str = "An error occurred (AccessDeniedException) when calling the AssumeRole operation: denied";
const BOTH: Endpoint = Endpoint { public: true, private: true };

#[test]
fn exec_stderr_classification() {
    assert_eq!(exec_failure(SSO_STDERR), Failure::SsoExpired);
    assert_eq!(exec_failure("The SSO session associated with this profile has expired or is otherwise invalid."), Failure::SsoExpired);
    assert_eq!(exec_failure("Error loading SSO Token: Token for x does not exist"), Failure::SsoExpired);
    assert_eq!(exec_failure(DENIED_STDERR), Failure::ExecFailed { stderr: DENIED_STDERR.into() });
}

#[test]
fn describe_messages() {
    assert_eq!(describe(&Failure::SsoExpired, BOTH), AppError::SsoExpired);
    assert_eq!(describe(&Failure::Unreachable, Endpoint { public: false, private: true }), AppError::Network { message: UNREACHABLE_PRIVATE.into() });
    assert_eq!(describe(&Failure::Unreachable, Endpoint { public: true, private: false }), AppError::Network { message: UNREACHABLE_PUBLIC.into() });
    assert_eq!(describe(&Failure::Unreachable, BOTH), AppError::Network { message: UNREACHABLE_BOTH.into() });
    assert_eq!(describe(&Failure::Tls, BOTH), AppError::other(TLS_UNVERIFIED));
    assert_eq!(describe(&Failure::Unauthorized, BOTH), AppError::other(UNAUTHORIZED));
    assert_eq!(
        describe(&Failure::Forbidden { verb: "list".into(), resource: "namespaces".into() }, BOTH),
        AppError::AccessDenied { action: "list namespaces".into() }
    );
    assert_eq!(describe(&Failure::ExecMissing { command: "aws".into() }, BOTH), AppError::other(exec_missing("aws")));
    assert_eq!(describe(&Failure::ExecFailed { stderr: "\n  first line\nsecond".into() }, BOTH), AppError::other(exec_failed("first line")));
}

#[test]
fn exec_failed_takes_first_non_empty_line_redacted_and_capped() {
    let long = "x".repeat(400);
    let AppError::Other { message } = describe(&Failure::ExecFailed { stderr: long }, BOTH) else { panic!() };
    assert_eq!(message, exec_failed(&"x".repeat(300)));
    assert_eq!(redact_secrets("token k8s-aws-v1.aHR0cHM6Ly9zdHM done"), "token [가림] done");
    assert_eq!(redact_secrets("Bearer abc.def"), "Bearer [가림]");
    assert_eq!(redact_secrets("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig"), "[가림]");
}

fn api(code: u16) -> kube::Error {
    kube::Error::Api(Status::failure("boom", "Reason").with_code(code).boxed())
}

#[test]
fn api_status_codes() {
    assert_eq!(failure_of(&api(401), "list", "namespaces"), Failure::Unauthorized);
    assert_eq!(failure_of(&api(403), "list", "namespaces"), Failure::Forbidden { verb: "list".into(), resource: "namespaces".into() });
    assert_eq!(failure_of(&api(500), "list", "namespaces"), Failure::Other("boom".into()));
}

#[test]
fn exec_plugin_errors() {
    let missing = kube::Error::Auth(AuthError::AuthExecStart(std::io::Error::from(ErrorKind::NotFound)));
    assert_eq!(failure_of(&missing, "get", "version"), Failure::ExecMissing { command: "aws".into() });

    let run = |stderr: &str| {
        kube::Error::Auth(AuthError::AuthExecRun {
            cmd: "aws".into(),
            status: ExitStatus::from_raw(1 << 8),
            out: Output { status: ExitStatus::from_raw(1 << 8), stdout: b"secret-token".to_vec(), stderr: stderr.as_bytes().to_vec() },
        })
    };
    assert_eq!(failure_of(&run(SSO_STDERR), "get", "version"), Failure::SsoExpired);
    assert_eq!(failure_of(&run(DENIED_STDERR), "get", "version"), Failure::ExecFailed { stderr: DENIED_STDERR.into() });
}

#[test]
fn io_errors_in_the_source_chain() {
    // hyper 연결 오류는 io::Error를 source로 달고 온다. kube::Error::Service로 같은 모양을 만든다.
    for kind in [ErrorKind::ConnectionRefused, ErrorKind::TimedOut, ErrorKind::ConnectionReset, ErrorKind::HostUnreachable, ErrorKind::NetworkUnreachable] {
        let e = kube::Error::Service(Box::new(std::io::Error::from(kind)));
        assert_eq!(failure_of(&e, "get", "version"), Failure::Unreachable, "{kind:?}");
    }
    let other = kube::Error::Service(Box::new(std::io::Error::other("weird")));
    assert_eq!(failure_of(&other, "get", "version"), Failure::Other("ServiceError: weird".into()));
}

#[test]
fn chain_text_rules() {
    assert_eq!(failure_of_chain("invalid peer certificate: UnknownIssuer"), Some(Failure::Tls));
    assert_eq!(failure_of_chain("error trying to connect: dns error: failed to lookup address information"), Some(Failure::Unreachable));
    assert_eq!(failure_of_chain("Connection refused (os error 61)"), Some(Failure::Unreachable));
    assert_eq!(failure_of_chain("operation timed out"), Some(Failure::Unreachable));
    assert_eq!(failure_of_chain("deadline has elapsed"), Some(Failure::Unreachable));
    assert_eq!(failure_of_chain("something else"), None);
}

#[test]
fn text_in_the_chain_is_walked() {
    let e = kube::Error::Service("error trying to connect: invalid peer certificate: UnknownIssuer".into());
    assert_eq!(failure_of(&e, "get", "version"), Failure::Tls);
    let e = kube::Error::Service("tcp connect error: Connection refused (os error 61)".into());
    assert_eq!(failure_of(&e, "get", "version"), Failure::Unreachable);
}

fn exec_run(stderr: &str) -> AuthError {
    AuthError::AuthExecRun {
        cmd: "aws".into(),
        status: ExitStatus::from_raw(1 << 8),
        out: Output { status: ExitStatus::from_raw(1 << 8), stdout: b"k8s-aws-v1.stdoutsecret".to_vec(), stderr: stderr.as_bytes().to_vec() },
    }
}

#[test]
fn token_refresh_errors_arrive_wrapped_in_service() {
    let sso = kube::Error::Service(Box::new(exec_run(SSO_STDERR)));
    assert_eq!(failure_of(&sso, "list", "pods"), Failure::SsoExpired);
    let denied = kube::Error::Service(Box::new(exec_run(DENIED_STDERR)));
    assert_eq!(failure_of(&denied, "list", "pods"), Failure::ExecFailed { stderr: DENIED_STDERR.into() });
    let missing = kube::Error::Service(Box::new(AuthError::AuthExecStart(std::io::Error::from(ErrorKind::NotFound))));
    assert_eq!(failure_of(&missing, "list", "pods"), Failure::ExecMissing { command: "aws".into() });
}

#[test]
fn redaction_finds_tokens_anywhere() {
    assert_eq!(redact_secrets("got \"k8s-aws-v1.aHR0\" back"), "got \"[가림]\" back");
    assert_eq!(redact_secrets("{\"token\":\"k8s-aws-v1.aHR0\",\"x\":1}"), "{\"token\":\"[가림]\",\"x\":1}");
    assert_eq!(redact_secrets("token=k8s-aws-v1.aHR0&x"), "token=[가림]&x");
    assert_eq!(redact_secrets("authorization: eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig"), "authorization: [가림]");
    assert_eq!(redact_secrets("Bearer\tabc.def"), "Bearer\t[가림]");
    assert_eq!(redact_secrets("bearer   abc.def ok"), "bearer   [가림] ok");
    assert_eq!(redact_secrets("\"Authorization\":\"Bearer abc.def\""), "\"Authorization\":\"Bearer [가림]\"");
    assert_eq!(redact_secrets("eyJ is not a jwt"), "eyJ is not a jwt");
}

#[test]
fn other_is_redacted_and_capped() {
    let message = format!("{} k8s-aws-v1.secret {}", "y".repeat(280), "z".repeat(100));
    let AppError::Other { message } = describe(&Failure::Other(message), BOTH) else { panic!() };
    assert!(!message.contains("secret"));
    assert_eq!(message.chars().count(), 300);
}
