use super::*;
use serde_json::json;

fn service(name: &str, port: i32, port_name: &str) -> Service {
    serde_json::from_value(json!({"apiVersion":"v1","kind":"Service","metadata":{"name":name,"namespace":"monitoring"},"spec":{"ports":[{"port":port,"name":port_name}]}})).unwrap()
}

#[test]
fn detects_named_services_and_web_ports() {
    let found = candidates_of(&[service("prometheus-server", 9090, "metrics"), service("kube-prometheus-stack-prometheus", 80, "web"), service("grafana", 9090, "web"), service("prometheus-other", 8080, "metrics")]);
    assert_eq!(found, vec![PrometheusEndpoint { namespace: "monitoring".into(), name: "kube-prometheus-stack-prometheus".into(), port: 80 }, PrometheusEndpoint { namespace: "monitoring".into(), name: "prometheus-server".into(), port: 9090 }]);
    assert!(candidates_of(&[]).is_empty());
}

#[test]
fn expressions_select_exact_pods_and_correct_group() {
    let pods = vec!["app-1".to_owned(), "app.2".to_owned()];
    let cpu = query("demo", &pods, false, true);
    assert!(cpu.starts_with("sum by (pod) (rate(container_cpu_usage_seconds_total"));
    assert!(cpu.contains("app-1|app\\\\.2"));
    assert!(cpu.contains("namespace=\"demo\""));
    assert!(query("demo", &pods, true, false).starts_with("sum by (container) (container_memory_working_set_bytes"));
}

#[test]
fn parses_matrix_and_rejects_errors() {
    let matrix = json!({"status":"success","data":{"resultType":"matrix","result":[{"metric":{"container":"app"},"values":[[100,"1.5"],[110,"NaN"],[120,"2"]]}]}});
    assert_eq!(parse(matrix, "container").unwrap(), vec![Series { name: "app".into(), values: vec![(100.0, 1.5), (120.0, 2.0)] }]);
    assert!(parse(json!({"status":"error"}), "pod").is_err());
    assert!(parse(json!({"status":"success","data":{"resultType":"matrix","result":[]}}), "pod").unwrap().is_empty());
}

#[tokio::test]
async fn reads_only_through_the_service_proxy() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use crate::k8s::{connect::client_for, tls::install_crypto_provider};
    install_crypto_provider();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut data = [0; 8192];
        let n = socket.read(&mut data).await.unwrap();
        let request = String::from_utf8_lossy(&data[..n]).to_string();
        let body = r#"{"status":"success","data":{"resultType":"matrix","result":[]}}"#;
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        socket.write_all(response.as_bytes()).await.unwrap();
        request
    });
    let config = kube::config::Kubeconfig::from_yaml(&format!("apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {{ server: \"http://127.0.0.1:{port}\" }}\ncontexts:\n- name: ctx\n  context: {{ cluster: c, user: u }}\nusers:\n- name: u\n  user: {{ token: t }}\n")).unwrap();
    let endpoint = Endpoint { public: true, private: false };
    let client = client_for(&config, "ctx", endpoint).await.unwrap();
    let service = PrometheusEndpoint { namespace: "monitoring".into(), name: "prometheus".into(), port: 9090 };
    assert!(range(&client, endpoint, &service, "up", 1, "pod").await.unwrap().is_empty());
    let request = server.await.unwrap();
    assert!(request.starts_with("GET /api/v1/namespaces/monitoring/services/prometheus:9090/proxy/api/v1/query_range?"));
    assert!(request.contains("query=up"));
}
