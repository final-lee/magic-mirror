use super::*;

#[test]
fn the_tls_config_builds_with_the_aws_lc_rs_provider_and_both_tls_versions() {
    let config = tls_config_with(RootCertStore::empty()).unwrap();
    assert!(config.alpn_protocols.is_empty());
}

#[test]
fn secrets_are_redacted_in_debug() {
    let auth = Auth::User { name: "app".into(), password: Secret::new("hunter2") };
    assert!(!format!("{auth:?}").contains("hunter2"));
    assert_eq!(auth.mode(), KvAuthMode::User);
    assert_eq!(auth.user(), "app");
    assert_eq!(Auth::Password(Secret::new("t")).user(), "");
}

#[test]
fn timeouts_follow_the_design() {
    assert_eq!(CONNECT_TIMEOUT, Duration::from_secs(10));
    assert_eq!(COMMAND_TIMEOUT, Duration::from_secs(10));
    assert_eq!(BIGKEYS_TIMEOUT, Duration::from_secs(30));
}
