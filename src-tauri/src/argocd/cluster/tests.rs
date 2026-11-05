use super::*;

#[test]
fn namespace_must_be_a_dns_label_before_it_goes_into_a_path() {
    assert!(valid_namespace("argocd"));
    assert!(valid_namespace("gitops-2"));
    for bad in ["", "Argo", "a/b", "..", "a b", "-a", "a-", &"a".repeat(64)] {
        assert!(!valid_namespace(bad), "{bad:?}");
    }
}

#[test]
fn proxy_path_addresses_the_service_port() {
    assert_eq!(
        proxy_path("argocd", "argocd-application-controller-metrics", 8082),
        "/api/v1/namespaces/argocd/services/argocd-application-controller-metrics:8082/proxy/metrics"
    );
}

#[test]
fn proxy_failures_name_the_missing_permission_service_or_pods() {
    assert!(proxy_failure(403, "argocd", "svc").unwrap().contains("services/proxy"));
    let missing = proxy_failure(404, "gitops", "argocd-server-metrics").unwrap();
    assert!(missing.contains("gitops") && missing.contains("argocd-server-metrics"));
    assert!(proxy_failure(503, "argocd", "svc").unwrap().contains("Pod"));
    // 인증·서버 오류는 일반 오류로 넘긴다
    assert_eq!(proxy_failure(401, "argocd", "svc"), None);
    assert_eq!(proxy_failure(500, "argocd", "svc"), None);
}
