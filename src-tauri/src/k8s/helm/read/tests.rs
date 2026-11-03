use std::io::Write;
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use flate2::write::GzEncoder;
use flate2::Compression;
use kube::config::Kubeconfig;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;
use crate::k8s::connect::client_for;
use crate::k8s::tls::install_crypto_provider;

const PUBLIC: Endpoint = Endpoint { public: true, private: false };

type Router = Arc<dyn Fn(&str) -> (u16, String) + Send + Sync>;

/// 요청 줄(`GET /path?query`)로 응답을 고르는 가짜 API 서버. 받은 요청 줄을 모두 모은다.
async fn api_server(router: Router) -> (Kubeconfig, Arc<Mutex<Vec<String>>>) {
    install_crypto_provider();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (log, router) = (log.clone(), router.clone());
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    request.extend_from_slice(&chunk[..n]);
                }
                let text = String::from_utf8_lossy(&request).to_string();
                let line = text.lines().next().unwrap_or("").split(" HTTP").next().unwrap_or("").to_string();
                log.lock().unwrap().push(line.clone());
                let (status, body) = router(&line);
                let response = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    let yaml = format!(
        "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {{ server: \"http://127.0.0.1:{port}\" }}\ncontexts:\n- name: ctx\n  context: {{ cluster: c, user: u }}\nusers:\n- name: u\n  user: {{ token: t }}\n"
    );
    (Kubeconfig::from_yaml(&yaml).unwrap(), seen)
}

async fn cluster(router: Router) -> (Cluster, Arc<Mutex<Vec<String>>>) {
    let (config, seen) = api_server(router).await;
    let client = client_for(&config, "ctx", PUBLIC).await.unwrap();
    (Cluster { client, endpoint: PUBLIC, context: "ctx".into(), kubeconfig_paths: Vec::new() }, seen)
}

/// 쿼리의 퍼센트 인코딩을 풀어 비교하기 쉽게 한다
fn plain(line: &str) -> String {
    line.replace("%3D", "=").replace("%2C", ",").replace("%2F", "/").replace("%21", "!")
}

fn status(code: u16, reason: &str) -> (u16, String) {
    (code, json!({"kind": "Status", "apiVersion": "v1", "status": "Failure", "message": "m", "reason": reason, "code": code}).to_string())
}

/// helm이 저장하는 `release` 값: JSON → gzip → base64
fn release_value(name: &str, namespace: &str, version: u32, status: &str, chart_version: &str) -> String {
    let body = json!({
        "name": name, "namespace": namespace, "version": version,
        "info": {"status": status, "description": format!("d{version}"), "last_deployed": format!("2026-01-0{version}T00:00:00Z")},
        "chart": {"metadata": {"name": "web", "version": chart_version, "appVersion": "9"}},
        "manifest": "",
    });
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(body.to_string().as_bytes()).unwrap();
    STANDARD.encode(gz.finish().unwrap())
}

/// 목록 응답의 메타데이터 항목(helm 저장소 객체)
fn item(object: &str, namespace: &str, release: &str, version: u32, status: &str, uid: &str) -> Value {
    json!({"apiVersion": "v1", "kind": "Secret", "metadata": {
        "name": object, "namespace": namespace, "uid": uid, "resourceVersion": "1",
        "labels": {"owner": "helm", "name": release, "version": version.to_string(), "status": status}}})
}

fn metadata_list(items: Vec<Value>, next: Option<&str>) -> (u16, String) {
    let metadata = next.map_or(json!({}), |t| json!({"continue": t}));
    (200, json!({"apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadataList", "metadata": metadata, "items": items}).to_string())
}

fn secret_get(release_value: String) -> (u16, String) {
    (200, json!({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "x"}, "type": "helm.sh/release.v1", "data": {"release": STANDARD.encode(release_value)}}).to_string())
}

fn config_get(release_value: String) -> (u16, String) {
    (200, json!({"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "x"}, "data": {"release": release_value}}).to_string())
}

fn empty_list() -> (u16, String) {
    metadata_list(vec![], None)
}

#[test]
fn a_revision_summary_comes_from_the_decoded_release() {
    let release = decode(release_value("web", "apps", 2, "deployed", "1.4.0").as_bytes()).unwrap();
    let summary = Revision::of(&release);
    assert_eq!((summary.revision, summary.status.as_str(), summary.chart.as_str(), summary.app_version.as_str()), (2, "deployed", "web-1.4.0", "9"));
    assert_eq!((summary.description.as_str(), summary.updated.as_deref(), summary.unreadable), ("d2", Some("2026-01-02T00:00:00Z"), false));
}

#[tokio::test]
async fn the_list_shows_one_row_per_release_and_downloads_only_the_highest_revision_of_each() {
    let router: Router = Arc::new(|line| {
        let line = plain(line);
        if line.starts_with("GET /api/v1/secrets?") {
            return metadata_list(
                vec![
                    item("sh.helm.release.v1.web.v1", "apps", "web", 1, "superseded", "list1-a"),
                    item("sh.helm.release.v1.web.v3", "apps", "web", 3, "deployed", "list1-c"),
                    item("sh.helm.release.v1.web.v2", "apps", "web", 2, "superseded", "list1-b"),
                    item("sh.helm.release.v1.api.v1", "zeta", "api", 1, "failed", "list1-d"),
                ],
                None,
            );
        }
        if line.starts_with("GET /api/v1/configmaps?") {
            return empty_list();
        }
        match line.as_str() {
            l if l.starts_with("GET /api/v1/namespaces/apps/secrets/sh.helm.release.v1.web.v3") => secret_get(release_value("web", "apps", 3, "deployed", "1.4.0")),
            l if l.starts_with("GET /api/v1/namespaces/zeta/secrets/sh.helm.release.v1.api.v1") => secret_get(release_value("api", "zeta", 1, "failed", "0.1.0")),
            _ => status(404, "NotFound"),
        }
    });
    let (cluster, seen) = cluster(router).await;
    let rows = list(&cluster, None).await.unwrap();
    assert_eq!(rows.iter().map(|r| (r.namespace.as_str(), r.name.as_str(), r.revision, r.revisions)).collect::<Vec<_>>(), [("apps", "web", 3, 3), ("zeta", "api", 1, 1)]);
    assert_eq!((rows[0].chart.as_str(), rows[0].status.as_str(), rows[0].problem, rows[0].driver), ("web-1.4.0", "deployed", false, Driver::Secret));
    assert!(rows[1].problem && rows[1].status == "failed");
    let gets: Vec<String> = seen.lock().unwrap().iter().filter(|l| l.contains("/secrets/")).cloned().collect();
    assert_eq!(gets.len(), 2, "{gets:?}");
    assert!(!gets.iter().any(|l| l.contains("web.v1") || l.contains("web.v2")));
    // 목록은 메타데이터만 받고(헤더로 구분) helm 소유 Secret만 고른다
    let secrets_list = seen.lock().unwrap().iter().find(|l| l.starts_with("GET /api/v1/secrets?")).cloned().unwrap();
    assert!(plain(&secrets_list).contains("owner=helm") && plain(&secrets_list).contains("type=helm.sh/release.v1"), "{secrets_list}");
}

#[tokio::test]
async fn reading_the_list_again_reuses_what_was_decoded_until_the_object_changes() {
    let version = Arc::new(Mutex::new("1".to_string()));
    let for_router = version.clone();
    let router: Router = Arc::new(move |line| {
        let line = plain(line);
        if line.starts_with("GET /api/v1/namespaces/apps/secrets?") {
            let mut item = item("sh.helm.release.v1.web.v1", "apps", "web", 1, "deployed", "cache-1");
            item["metadata"]["resourceVersion"] = json!(for_router.lock().unwrap().clone());
            return metadata_list(vec![item], None);
        }
        if line.starts_with("GET /api/v1/namespaces/apps/configmaps?") {
            return empty_list();
        }
        if line.contains("/secrets/sh.helm.release.v1.web.v1") {
            return secret_get(release_value("web", "apps", 1, "deployed", "1.0.0"));
        }
        status(404, "NotFound")
    });
    let (cluster, seen) = cluster(router).await;
    let gets = |seen: &Arc<Mutex<Vec<String>>>| seen.lock().unwrap().iter().filter(|l| l.contains("/secrets/sh.helm")).count();
    list(&cluster, Some("apps")).await.unwrap();
    list(&cluster, Some("apps")).await.unwrap();
    assert_eq!(gets(&seen), 1, "같은 uid·resourceVersion이면 데이터를 다시 받지 않아요");
    *version.lock().unwrap() = "2".into();
    list(&cluster, Some("apps")).await.unwrap();
    assert_eq!(gets(&seen), 2, "객체가 바뀌면 다시 받아요");
    assert!(seen.lock().unwrap().iter().filter(|l| l.contains("/secrets?")).all(|l| l.starts_with("GET /api/v1/namespaces/apps/secrets?")), "네임스페이스를 고르면 그 네임스페이스만 읽어요");
}

#[tokio::test]
async fn a_cluster_that_stores_releases_in_configmaps_is_read_when_secrets_are_not_allowed() {
    let router: Router = Arc::new(|line| {
        let line = plain(line);
        if line.starts_with("GET /api/v1/secrets?") {
            return status(403, "Forbidden");
        }
        if line.starts_with("GET /api/v1/configmaps?") {
            let mut cm = item("web.v2", "apps", "web", 2, "deployed", "cm-1");
            cm["kind"] = json!("ConfigMap");
            return metadata_list(vec![cm], None);
        }
        if line.contains("/configmaps/web.v2") {
            return config_get(release_value("web", "apps", 2, "deployed", "1.0.0"));
        }
        status(404, "NotFound")
    });
    let (cluster, _) = cluster(router).await;
    let rows = list(&cluster, None).await.unwrap();
    assert_eq!((rows.len(), rows[0].driver, rows[0].chart.as_str()), (1, Driver::ConfigMap, "web-1.0.0"));
}

#[tokio::test]
async fn being_denied_configmaps_does_not_hide_secret_releases_but_being_denied_both_is_an_error() {
    let only_secrets: Router = Arc::new(|line| {
        if line.starts_with("GET /api/v1/configmaps?") {
            return status(403, "Forbidden");
        }
        if plain(line).starts_with("GET /api/v1/secrets?") {
            return metadata_list(vec![item("sh.helm.release.v1.web.v1", "apps", "web", 1, "deployed", "deny-1")], None);
        }
        secret_get(release_value("web", "apps", 1, "deployed", "1.0.0"))
    });
    let (cluster_a, _) = cluster(only_secrets).await;
    assert_eq!(list(&cluster_a, None).await.unwrap().len(), 1);
    let nothing: Router = Arc::new(|_| status(403, "Forbidden"));
    let (cluster_b, _) = cluster(nothing).await;
    let error = list(&cluster_b, None).await.unwrap_err();
    assert!(matches!(&error, AppError::AccessDenied { action } if action.contains("secrets")), "{error:?}");
}

#[tokio::test]
async fn the_same_revision_in_both_stores_is_listed_once_from_the_secret() {
    let router: Router = Arc::new(|line| {
        let line = plain(line);
        if line.starts_with("GET /api/v1/secrets?") {
            return metadata_list(vec![item("sh.helm.release.v1.web.v1", "apps", "web", 1, "deployed", "dup-s")], None);
        }
        if line.starts_with("GET /api/v1/configmaps?") {
            let mut cm = item("web.v1", "apps", "web", 1, "deployed", "dup-c");
            cm["kind"] = json!("ConfigMap");
            return metadata_list(vec![cm], None);
        }
        secret_get(release_value("web", "apps", 1, "deployed", "1.0.0"))
    });
    let (cluster, _) = cluster(router).await;
    let stored = list_stored(&cluster, None, None).await.unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].driver, Driver::Secret);
}

#[tokio::test]
async fn a_release_whose_data_cannot_be_decoded_is_still_listed_with_its_label_status() {
    let router: Router = Arc::new(|line| {
        let line = plain(line);
        if line.starts_with("GET /api/v1/secrets?") {
            return metadata_list(vec![item("sh.helm.release.v1.web.v1", "apps", "web", 1, "failed", "bad-1")], None);
        }
        if line.starts_with("GET /api/v1/configmaps?") {
            return empty_list();
        }
        secret_get("not-a-release!".to_string())
    });
    let (cluster, _) = cluster(router).await;
    let rows = list(&cluster, None).await.unwrap();
    assert_eq!((rows[0].unreadable, rows[0].status.as_str(), rows[0].problem, rows[0].chart.as_str()), (true, "failed", true, ""));
}

#[tokio::test]
async fn labels_that_are_not_a_helm_release_are_skipped_and_pages_are_followed_to_the_end() {
    let router: Router = Arc::new(|line| {
        let line = plain(line);
        if line.starts_with("GET /api/v1/configmaps?") {
            return empty_list();
        }
        if line.contains("continue=p2") {
            return metadata_list(vec![item("sh.helm.release.v1.b.v1", "apps", "b", 1, "deployed", "page-b")], None);
        }
        let mut stray = item("sh.helm.release.v1.junk.vx", "apps", "junk", 1, "deployed", "page-junk");
        stray["metadata"]["labels"]["version"] = json!("x");
        metadata_list(vec![item("sh.helm.release.v1.a.v1", "apps", "a", 1, "deployed", "page-a"), stray], Some("p2"))
    });
    let (cluster, _) = cluster(router).await;
    let stored = list_stored(&cluster, Some("apps"), None).await.unwrap();
    assert_eq!(stored.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
}

#[tokio::test]
async fn one_releases_revisions_are_found_highest_first_and_summarized_for_the_history() {
    let router: Router = Arc::new(|line| {
        let line = plain(line);
        if line.starts_with("GET /api/v1/namespaces/apps/secrets?") {
            assert!(line.contains("owner=helm,name=web"), "{line}");
            return metadata_list(
                vec![
                    item("sh.helm.release.v1.web.v1", "apps", "web", 1, "superseded", "hist-1"),
                    item("sh.helm.release.v1.web.v2", "apps", "web", 2, "failed", "hist-2"),
                    // 이름 라벨이 비슷한 다른 릴리스는 서버가 걸러 주지만, 같은 이름이 아니면 쓰지 않는다
                    item("sh.helm.release.v1.web2.v1", "apps", "web2", 1, "deployed", "hist-x"),
                ],
                None,
            );
        }
        if line.starts_with("GET /api/v1/namespaces/apps/configmaps?") {
            return empty_list();
        }
        if line.contains("web.v2") {
            return secret_get(release_value("web", "apps", 2, "failed", "1.1.0"));
        }
        secret_get(release_value("web", "apps", 1, "superseded", "1.0.0"))
    });
    let (cluster, _) = cluster(router).await;
    let stored = locate(&cluster, "apps", "web").await.unwrap();
    assert_eq!(stored.iter().map(|s| s.revision).collect::<Vec<_>>(), [2, 1]);
    let revisions = history(&cluster, &stored).await.unwrap();
    assert_eq!(revisions.iter().map(|r| (r.revision, r.status.as_str(), r.chart.as_str())).collect::<Vec<_>>(), [(2, "failed", "web-1.1.0"), (1, "superseded", "web-1.0.0")]);
    let release = fetch(&cluster, &stored[0]).await.unwrap();
    assert_eq!((release.version, release.info.description.as_str()), (2, "d2"));
}

#[tokio::test]
async fn an_unknown_release_has_no_stored_objects() {
    let router: Router = Arc::new(|_| empty_list());
    let (cluster, _) = cluster(router).await;
    assert!(locate(&cluster, "apps", "nope").await.unwrap().is_empty());
}
