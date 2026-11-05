use super::*;

fn inputs() -> Inputs {
    Inputs {
        host: "service.example".into(), port: 443, cli: true,
        status: Ok(serde_json::from_str(r#"{"BackendState":"Running","CurrentTailnet":{"Name":"example","MagicDNSSuffix":"example.ts.net"},"Peer":{"a":{"HostName":"router","Online":true,"TailscaleIPs":["100.71.74.23"],"PrimaryRoutes":["10.0.0.0/16"]}}}"#).unwrap()),
        prefs: Ok(Prefs { accept_routes: true, accept_dns: true, exit_node: String::new() }),
        address: Ok("10.0.0.1".parse().unwrap()), ping: Ok("pong from router (100.71.74.23) via DERP(tok) in 66ms".into()),
        tcp: Some(Tcp::Connected), udp: Some(true),
    }
}
#[test]
fn subnet_and_longest_prefix() {
    let mut i = inputs();
    let status = i.status.as_mut().unwrap();
    status.peers.as_mut().unwrap().insert("b".into(), serde_json::from_str(r#"{"HostName":"specific","Online":true,"PrimaryRoutes":["10.0.0.0/24"]}"#).unwrap());
    let d = decide(i);
    assert!(d.checks[3].summary.contains("specific"));
    assert_eq!(d.checks[4].status, "ok");
    assert_eq!(d.verdict, "지금은 연결돼요. 다시 시도해 보세요");
}
#[test]
fn route_setting_and_offline_peer() {
    let mut i = inputs(); i.prefs.as_mut().unwrap().accept_routes = false;
    i.status.as_mut().unwrap().peers.as_mut().unwrap().get_mut("a").unwrap().online = false;
    i.status.as_mut().unwrap().peers.as_mut().unwrap().get_mut("a").unwrap().last_seen = Some("yesterday".into());
    let d = decide(i);
    assert_eq!(d.fix, Some("acceptRoutes")); assert_eq!(d.checks[4].status, "fail");
    assert!(d.checks[5].detail.as_ref().unwrap().contains("yesterday"));
    assert_eq!(d.verdict, d.checks[4].summary);
}
#[test]
fn external_routes_and_tcp_verdict() {
    let mut i = inputs(); i.address = Ok("192.168.1.1".parse().unwrap()); i.tcp = Some(Tcp::Refused);
    let d = decide(i); assert_eq!(d.checks[3].status, "warn"); assert_eq!(d.checks[6].status, "skip"); assert_eq!(d.verdict, d.checks[7].summary);
    let mut i = inputs(); i.address = Ok("192.168.1.1".parse().unwrap()); i.prefs.as_mut().unwrap().exit_node = "100.1.2.3".into();
    let d = decide(i); assert_eq!(d.checks[3].status, "ok"); assert_eq!(d.checks[5].status, "skip");
}
#[test]
fn missing_peer_dns_hint_and_login() {
    let mut i = inputs(); i.address = Ok("100.100.100.100".parse().unwrap());
    assert_eq!(decide(i).checks[3].status, "fail");
    let mut i = inputs(); i.host = "app.example.ts.net".into(); i.address = Err("not found".into()); i.prefs.as_mut().unwrap().accept_dns = false;
    let d = decide(i); assert!(d.checks[2].summary.contains("DNS")); assert_eq!(d.checks[7].status, "skip");
    let mut i = inputs(); i.status.as_mut().unwrap().backend_state = "NeedsLogin".into();
    let d = decide(i); assert_eq!(d.checks[1].status, "fail"); assert!(d.checks[2..].iter().all(|c| c.status == "skip"));
}
#[test]
fn ping_transport_tcp_and_warning_precedence() {
    let d = decide(inputs()); assert!(d.checks[6].summary.contains("DERP(tok)"));
    let mut i = inputs(); i.ping = Ok("pong from router (100.71.74.23) via 1.2.3.4:41641 in 5ms".into()); i.tcp = Some(Tcp::Timeout); i.udp = Some(false);
    let d = decide(i); assert!(d.checks[6].summary.contains("직접")); assert!(d.checks[7].summary.contains("초과")); assert_eq!(d.verdict, d.checks[7].summary);
    // TCP가 지금 붙으면 주의가 있어도 결론은 "지금은 연결돼요"이고, TCP를 못 봤으면 첫 주의가 결론이다
    let mut i = inputs(); i.udp = Some(false); let d = decide(i); assert_eq!(d.verdict, "지금은 연결돼요. 다시 시도해 보세요"); assert_eq!(d.checks[8].status, "warn");
    let mut i = inputs(); i.udp = Some(false); i.tcp = None; let d = decide(i); assert_eq!(d.verdict, d.checks[8].summary);
}
#[test]
fn serialized_contract() {
    let json = serde_json::to_value(decide(inputs())).unwrap();
    let object = json.as_object().unwrap();
    assert_eq!(object.keys().map(String::as_str).collect::<Vec<_>>(), vec!["address", "checks", "fix", "host", "port", "tailnet", "verdict"]);
    let checks = json["checks"].as_array().unwrap();
    assert_eq!(checks.iter().map(|c| c["id"].as_str().unwrap()).collect::<Vec<_>>(), vec!["cli", "backend", "dns", "route", "acceptRoutes", "peer", "ping", "tcp", "udp"]);
    assert_eq!(checks[0].as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(), vec!["detail", "id", "status", "summary"]);
}
