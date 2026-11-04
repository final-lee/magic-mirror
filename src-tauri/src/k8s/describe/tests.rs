use super::*;

fn deployment() -> KindRef {
    KindRef { group: "apps".into(), version: "v1".into(), kind: "Deployment".into(), plural: "deployments".into(), namespaced: true }
}

#[test]
fn builds_read_only_arguments() {
    let args = arguments("kind-test", &deployment(), Some("default"), "web").unwrap();
    assert_eq!(args, ["--context", "kind-test", "describe", "deployments.apps", "web", "-n", "default"]);
    assert!(arguments("kind-test", &deployment(), None, "--help").is_err());
    let secret = KindRef { group: "".into(), kind: "Secret".into(), plural: "secrets".into(), ..deployment() };
    assert!(arguments("kind-test", &secret, Some("default"), "token").is_err());
}

#[test]
fn rejects_ambiguous_resources_and_secret_aliases() {
    for plural in ["pods,secrets", "Secrets", "secret", "secrets", "pods.secrets", "-pods"] {
        let kind = KindRef { plural: plural.into(), ..deployment() };
        assert!(arguments("ctx", &kind, None, "name").is_err(), "{plural}");
    }
    let kind = KindRef { kind: "sEcReT".into(), ..deployment() };
    assert!(arguments("ctx", &kind, None, "name").is_err());
    let kind = KindRef { group: "apps,core".into(), ..deployment() };
    assert!(arguments("ctx", &kind, None, "name").is_err());
}

#[test]
fn failure_reports_reason_and_sso_expiry() {
    assert_eq!(failure(b""), AppError::other("kubectl이 실패했어요"));
    assert!(failure(b"permission denied").to_string().contains("permission denied"));
    assert_eq!(failure(b"The SSO session associated with this profile has expired"), AppError::SsoExpired);
}
#[tokio::test]
async fn caps_output() {
    assert_eq!(bounded(&b"ok"[..]).await.unwrap(), b"ok");
    let oversized = vec![b'x'; LIMIT as usize + 1];
    assert!(bounded(oversized.as_slice()).await.is_err());
}
