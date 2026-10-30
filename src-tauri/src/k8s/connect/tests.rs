use super::*;
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
