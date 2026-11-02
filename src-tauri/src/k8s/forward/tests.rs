use serde_json::{json, Value};

use super::*;

fn pod(name: &str, ready: bool, ports: Value) -> Pod {
    serde_json::from_value(json!({
        "metadata": { "name": name },
        "spec": { "containers": [{ "name": "app", "image": "i", "ports": ports }] },
        "status": { "phase": "Running", "conditions": [{ "type": "Ready", "status": if ready { "True" } else { "False" } }] },
    }))
    .unwrap()
}

fn terminating(name: &str) -> Pod {
    let mut value = serde_json::to_value(pod(name, true, json!([]))).unwrap();
    value["metadata"]["deletionTimestamp"] = json!("2026-11-02T00:00:00Z");
    serde_json::from_value(value).unwrap()
}

fn service(ports: Value, selector: Value) -> Service {
    serde_json::from_value(json!({ "metadata": { "name": "web" }, "spec": { "ports": ports, "selector": selector } })).unwrap()
}

fn chosen(pod: &str, port: u16) -> Chosen {
    Chosen { pod: pod.into(), port }
}

fn request(kind: ForwardKind, remote: u16, local: Option<u16>) -> ForwardRequest {
    ForwardRequest { namespace: "dev".into(), kind, name: "web".into(), remote_port: remote, local_port: local }
}

#[test]
fn a_service_port_maps_to_its_target_port() {
    let svc = service(json!([{ "port": 80, "targetPort": 8080 }, { "port": 81, "targetPort": "metrics" }, { "port": 82 }, { "port": 83, "targetPort": 0 }]), json!({ "app": "web" }));
    assert_eq!(service_target(&svc, 80).unwrap(), TargetPort::Number(8080));
    assert_eq!(service_target(&svc, 81).unwrap(), TargetPort::Name("metrics".into()));
    // 정하지 않았거나 0이면 Service 포트 그대로
    assert_eq!(service_target(&svc, 82).unwrap(), TargetPort::Number(82));
    assert_eq!(service_target(&svc, 83).unwrap(), TargetPort::Number(83));
    assert_eq!(service_target(&svc, 9).unwrap_err(), AppError::other(NO_SERVICE_PORT));
}

#[test]
fn a_udp_service_port_is_refused() {
    let svc = service(json!([{ "port": 53, "protocol": "UDP" }]), json!({ "app": "dns" }));
    assert_eq!(service_target(&svc, 53).unwrap_err(), AppError::other(UDP_PORT));
}

#[test]
fn a_service_without_a_selector_has_no_pods_to_reach() {
    assert_eq!(selector_of(&service(json!([]), json!({}))).unwrap_err(), AppError::other(NO_SELECTOR));
    let svc: Service = serde_json::from_value(json!({ "metadata": { "name": "ext" }, "spec": { "type": "ExternalName" } })).unwrap();
    assert_eq!(selector_of(&svc).unwrap_err(), AppError::other(NO_SELECTOR));
    assert_eq!(selector_of(&service(json!([]), json!({ "tier": "fe", "app": "web" }))).unwrap(), "app=web,tier=fe");
}

#[test]
fn a_named_target_port_is_resolved_in_the_chosen_pod() {
    let p = pod("a", true, json!([{ "name": "metrics", "containerPort": 9090 }]));
    assert_eq!(container_port(&p, &TargetPort::Name("metrics".into())), Some(9090));
    assert_eq!(container_port(&p, &TargetPort::Name("http".into())), None);
    assert_eq!(container_port(&p, &TargetPort::Number(80)), Some(80));
}

#[test]
fn the_service_picks_a_ready_pod_by_name_and_skips_the_rest() {
    let pods = [pod("web-c", true, json!([])), pod("web-a", false, json!([])), terminating("web-b"), pod("web-d", true, json!([]))];
    assert_eq!(choose(&pods, None, &TargetPort::Number(80)), Some(chosen("web-c", 80)));
    assert_eq!(choose(&pods[1..3], None, &TargetPort::Number(80)), None);
    assert_eq!(choose(&[], None, &TargetPort::Number(80)), None);
}

#[test]
fn the_service_stays_on_its_pod_while_that_pod_is_ready() {
    let pods = [pod("web-a", true, json!([])), pod("web-b", true, json!([]))];
    assert_eq!(choose(&pods, Some(&chosen("web-b", 80)), &TargetPort::Number(80)), Some(chosen("web-b", 80)));
}

#[test]
fn the_service_moves_to_another_pod_when_its_pod_goes_away_or_stops_being_ready() {
    let target = TargetPort::Number(80);
    let current = chosen("web-a", 80);
    let gone = [pod("web-b", true, json!([]))];
    assert_eq!(choose(&gone, Some(&current), &target), Some(chosen("web-b", 80)));
    let unready = [pod("web-a", false, json!([])), pod("web-b", true, json!([]))];
    assert_eq!(choose(&unready, Some(&current), &target), Some(chosen("web-b", 80)));
    let dying = [terminating("web-a"), pod("web-b", true, json!([]))];
    assert_eq!(choose(&dying, Some(&current), &target), Some(chosen("web-b", 80)));
}

#[test]
fn a_pod_whose_named_port_does_not_exist_is_not_a_candidate() {
    let pods = [pod("web-a", true, json!([])), pod("web-b", true, json!([{ "name": "http", "containerPort": 8080 }]))];
    assert_eq!(choose(&pods, None, &TargetPort::Name("http".into())), Some(chosen("web-b", 8080)));
}

#[test]
fn requests_with_a_zero_port_or_empty_name_are_refused() {
    assert!(check_request(&request(ForwardKind::Pod, 80, None)).is_ok());
    assert!(check_request(&request(ForwardKind::Pod, 80, Some(8080))).is_ok());
    assert!(check_request(&request(ForwardKind::Pod, 0, None)).is_err());
    assert!(check_request(&request(ForwardKind::Pod, 80, Some(0))).is_err());
    assert!(check_request(&ForwardRequest { name: String::new(), ..request(ForwardKind::Pod, 80, None) }).is_err());
}

/// 지금 비어 있는 포트 하나. 닫은 뒤 다시 쓰는 사이에 다른 프로세스가 가져갈 수 있어 시험이 드물게 어긋날 수 있다.
async fn free_port() -> u16 {
    let l = TcpListener::bind((LOCAL_ADDR, 0)).await.unwrap();
    l.local_addr().unwrap().port()
}

#[tokio::test]
async fn an_unset_local_port_follows_the_remote_port_when_it_is_free() {
    let port = free_port().await;
    let l = bind_local(None, port.max(1024)).await.unwrap();
    // 1024 미만이면 따라가지 않고 자동이니, 자유 포트(보통 1024 이상)로만 확인한다
    if port >= 1024 {
        assert_eq!(l.local_addr().unwrap().port(), port);
    }
    assert_eq!(l.local_addr().unwrap().ip(), std::net::IpAddr::V4(LOCAL_ADDR));
}

#[tokio::test]
async fn an_unset_local_port_falls_back_to_a_free_one_when_the_remote_number_is_taken() {
    let taken = bind_local(Some(free_port().await), 80).await.unwrap();
    let busy = taken.local_addr().unwrap().port();
    let auto = bind_local(None, busy).await.unwrap();
    assert_ne!(auto.local_addr().unwrap().port(), busy);
}

#[tokio::test]
async fn a_low_remote_port_is_not_copied_to_the_local_side() {
    let l = bind_local(None, 80).await.unwrap();
    assert_ne!(l.local_addr().unwrap().port(), 80);
}

#[tokio::test]
async fn a_chosen_local_port_that_is_taken_is_refused_with_its_number() {
    let first = bind_local(None, 80).await.unwrap();
    let port = first.local_addr().unwrap().port();
    assert_eq!(bind_local(Some(port), 80).await.unwrap_err(), AppError::other(local_port_unavailable(port)));
}
