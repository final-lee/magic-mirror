use kube::{Client, Config};

use super::*;
use crate::k8s::tls::install_crypto_provider;

fn client() -> Client {
    install_crypto_provider();
    Client::try_from(Config::new("http://127.0.0.1:9".parse().unwrap())).unwrap()
}

fn kind(group: &str, version: &str, kind: &str, plural: &str, namespaced: bool) -> KindRef {
    KindRef { group: group.into(), version: version.into(), kind: kind.into(), plural: plural.into(), namespaced }
}

#[tokio::test]
async fn api_for_builds_namespaced_and_cluster_urls() {
    let pods = kind("", "v1", "Pod", "pods", true);
    assert_eq!(api_for(client(), &pods, Some("web")).resource_url(), "/api/v1/namespaces/web/pods");
    assert_eq!(api_for(client(), &pods, None).resource_url(), "/api/v1/pods");
    // 빈 이름은 모든 네임스페이스로 본다
    assert_eq!(api_for(client(), &pods, Some("")).resource_url(), "/api/v1/pods");
    let deploys = kind("apps", "v1", "Deployment", "deployments", true);
    assert_eq!(api_for(client(), &deploys, Some("web")).resource_url(), "/apis/apps/v1/namespaces/web/deployments");
    // 클러스터 범위 종류는 네임스페이스를 무시한다
    let nodes = kind("", "v1", "Node", "nodes", false);
    assert_eq!(api_for(client(), &nodes, Some("web")).resource_url(), "/api/v1/nodes");
}
