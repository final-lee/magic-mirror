use super::*;
use crate::k8s::failure::exec_missing;
use crate::k8s::tls::install_crypto_provider;

const KUBECONFIG: &str = r#"
apiVersion: v1
kind: Config
clusters:
- name: c1
  cluster: { server: "https://127.0.0.1:9" }
contexts:
- name: ctx
  context: { cluster: c1, user: u1 }
users:
- name: u1
  user: { token: "not-a-real-token" }
"#;

const ENDPOINT: Endpoint = Endpoint { public: true, private: false };

#[tokio::test]
async fn builds_a_client_for_a_known_context_without_sending_anything() {
    install_crypto_provider();
    let config = Kubeconfig::from_yaml(KUBECONFIG).unwrap();
    assert!(client_for(&config, "ctx", ENDPOINT).await.is_ok());
}

#[tokio::test]
async fn unknown_context_is_an_error() {
    install_crypto_provider();
    let config = Kubeconfig::from_yaml(KUBECONFIG).unwrap();
    assert!(client_for(&config, "nope", ENDPOINT).await.is_err());
}

#[tokio::test]
async fn a_slow_exec_plugin_ends_in_the_exec_failed_message() {
    install_crypto_provider();
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("slow.sh");
    std::fs::write(&script, "#!/bin/sh\nsleep 5\n").unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let yaml = KUBECONFIG.replace(r#"user: { token: "not-a-real-token" }"#, &format!("user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: {}\n      interactiveMode: Never", script.display()));
    let config = Kubeconfig::from_yaml(&yaml).unwrap();
    let started = std::time::Instant::now();
    let err = client_for_with_timeout(&config, "ctx", ENDPOINT, Duration::from_millis(200)).await.err().unwrap();
    assert_eq!(err, AppError::other(exec_failed(EXEC_TIMEOUT_REASON)));
    assert!(started.elapsed() < Duration::from_secs(3));
}

fn exec_config(command: &str) -> Kubeconfig {
    let yaml = KUBECONFIG.replace(
        r#"user: { token: "not-a-real-token" }"#,
        &format!("user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: {command}\n      interactiveMode: Never"),
    );
    Kubeconfig::from_yaml(&yaml).unwrap()
}

#[test]
fn exec_command_is_read_from_the_contexts_user() {
    assert_eq!(exec_command(&exec_config("my-token-tool"), "ctx"), Some("my-token-tool".to_string()));
    assert_eq!(exec_command(&exec_config("my-token-tool"), "nope"), None);
    assert_eq!(exec_command(&Kubeconfig::from_yaml(KUBECONFIG).unwrap(), "ctx"), None);
}

#[tokio::test]
async fn a_missing_exec_command_is_named_in_the_message() {
    install_crypto_provider();
    let config = exec_config("mm-no-such-command");
    let err = client_for(&config, "ctx", ENDPOINT).await.err().unwrap();
    assert_eq!(err, AppError::other(exec_missing("mm-no-such-command")));
}
