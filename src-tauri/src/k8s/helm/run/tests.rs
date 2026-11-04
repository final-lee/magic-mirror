use std::os::unix::fs::PermissionsExt;

use super::*;

const PRIVATE: Endpoint = Endpoint { public: false, private: true };

/// 정해 둔 셸 스크립트로 helm을 흉내 낸다
fn fake_helm(dir: &Path, script: &str) -> PathBuf {
    let path = dir.join("helm");
    std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[test]
fn versions_parse_from_helm_output_and_serverside_dry_run_needs_3_13() {
    assert_eq!(parse_version("v4.3.1+gc0d08d0\n"), Some((4, 3)));
    assert_eq!(parse_version("v3.13.0"), Some((3, 13)));
    assert_eq!(parse_version("v3.19.0-rc.1"), Some((3, 19)));
    assert_eq!(parse_version("3.13.0"), None);
    assert_eq!(parse_version("garbage"), None);
    for ok in [(4, 0), (3, 13), (3, 20)] {
        assert!(supported(ok), "{ok:?}");
    }
    for old in [(3, 12), (2, 17), (3, 0)] {
        assert!(!supported(old), "{old:?}");
    }
}

#[test]
fn helm_is_found_only_as_an_executable_file_in_a_path_folder() {
    let missing = tempfile::tempdir().unwrap();
    let present = tempfile::tempdir().unwrap();
    let helm = fake_helm(present.path(), "true");
    let path = format!("{}::{}", missing.path().display(), present.path().display());
    assert_eq!(find(&path), Some(helm.clone()));
    assert_eq!(find(&missing.path().display().to_string()), None);
    assert_eq!(find(""), None);
    // 실행 권한이 없는 파일과 같은 이름의 폴더는 helm이 아니다
    std::fs::set_permissions(&helm, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(find(&present.path().display().to_string()), None);
    let folder = tempfile::tempdir().unwrap();
    std::fs::create_dir(folder.path().join("helm")).unwrap();
    assert_eq!(find(&folder.path().display().to_string()), None);
}

#[tokio::test]
async fn a_missing_helm_is_reported_with_the_install_hint_and_never_available() {
    let tool = tool_at(None).await;
    assert_eq!(tool, Tool { available: false, path: None, version: None, reason: Some(HELM_MISSING.to_string()) });
}

#[tokio::test]
async fn the_tool_reports_the_version_and_refuses_one_without_server_dry_run() {
    let dir = tempfile::tempdir().unwrap();
    let helm = fake_helm(dir.path(), "echo v4.3.1+gabc");
    let tool = tool_at(Some(helm.clone())).await;
    assert!(tool.available && tool.reason.is_none());
    assert_eq!(tool.version.as_deref(), Some("v4.3.1+gabc"));
    let old = fake_helm(dir.path(), "echo v3.12.3");
    let tool = tool_at(Some(old)).await;
    assert!(!tool.available);
    assert_eq!(tool.reason, Some(too_old("v3.12.3")));
    let broken = fake_helm(dir.path(), "echo boom >&2; exit 3");
    let tool = tool_at(Some(broken)).await;
    assert_eq!((tool.available, tool.reason.as_deref()), (false, Some(HELM_UNSTARTABLE)));
}

#[tokio::test]
async fn exec_returns_stdout_and_passes_only_the_given_environment_without_leaking_the_shells() {
    let dir = tempfile::tempdir().unwrap();
    // 사용자의 셸에 남은 HELM_KUBE* 값은 helm에 닿으면 안 되고, 우리가 준 HELM_DRIVER가 이긴다
    std::env::set_var("HELM_KUBEAPISERVER", "https://elsewhere.invalid");
    std::env::set_var("HELM_NAMESPACE", "elsewhere");
    let helm = fake_helm(dir.path(), "echo \"api=[$HELM_KUBEAPISERVER] ns=[$HELM_NAMESPACE] driver=[$HELM_DRIVER] args=$*\"");
    let args = vec!["list".to_string(), "--kube-context".to_string(), "kind".to_string()];
    let out = exec(&helm, &args, &[("HELM_DRIVER".into(), "configmap".into())], PRIVATE, Duration::from_secs(10)).await.unwrap();
    assert_eq!(out.trim(), "api=[] ns=[] driver=[configmap] args=list --kube-context kind");
}

#[tokio::test]
async fn a_helm_that_does_not_finish_in_time_is_stopped_with_a_timeout_message() {
    let dir = tempfile::tempdir().unwrap();
    let helm = fake_helm(dir.path(), "exec sleep 30");
    let started = std::time::Instant::now();
    let error = exec(&helm, &[], &[], PRIVATE, Duration::from_millis(200)).await.unwrap_err();
    assert_eq!(error, AppError::other(HELM_TIMEOUT));
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn a_nonzero_exit_becomes_the_error_built_from_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let helm = fake_helm(dir.path(), "echo 'Error: UPGRADE FAILED: boom' >&2; exit 1");
    let error = exec(&helm, &[], &[], PRIVATE, Duration::from_secs(10)).await.unwrap_err();
    assert_eq!(error, AppError::other("helm이 실패했어요: Error: UPGRADE FAILED: boom"));
}

#[test]
fn an_expired_sso_token_in_the_exec_plugin_is_the_apps_sso_error() {
    let stderr = "Error: Kubernetes cluster unreachable: getting credentials: exec: executable aws failed with exit code 255\nToken has expired and refresh failed";
    assert_eq!(failure(stderr, PRIVATE), AppError::SsoExpired);
}

#[test]
fn an_unreachable_cluster_gets_the_endpoint_specific_hint() {
    let stderr = "Error: Kubernetes cluster unreachable: Get \"https://x.eks.amazonaws.com/version\": dial tcp 10.0.0.1:443: i/o timeout";
    let AppError::Network { message } = failure(stderr, PRIVATE) else { panic!("연결 오류가 아니에요") };
    assert!(message.contains("Tailscale"), "{message}");
}

#[test]
fn certificate_words_in_a_chart_error_are_not_mistaken_for_a_tls_failure() {
    let error = failure("Error: template: web/templates/tls.yaml:3:5: executing: error calling genCA: certificate request failed", PRIVATE);
    assert!(matches!(&error, AppError::Other { message } if message.contains("genCA")), "{error:?}");
}

#[test]
fn failure_text_keeps_the_first_lines_hides_tokens_and_is_bounded() {
    let noisy = "level=WARN msg=\"deprecated\"\nWARNING: x\nError: first\nerror: second Bearer abc.def\nthird\nfourth\n";
    let AppError::Other { message } = failure(noisy, PRIVATE) else { panic!() };
    assert_eq!(message, "helm이 실패했어요: Error: first error: second Bearer [가림] third");
    let long = format!("Error: {}", "x".repeat(2000));
    let AppError::Other { message } = failure(&long, PRIVATE) else { panic!() };
    assert!(message.chars().count() <= HELM_FAILED.chars().count() + 2 + 400);
    assert_eq!(failure("", PRIVATE), AppError::other(HELM_FAILED));
    assert_eq!(failure("level=WARN only\n", PRIVATE), AppError::other(HELM_FAILED));
}
