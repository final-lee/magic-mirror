use super::*;

#[test]
fn parses_real_status_and_preferences_shapes() {
    let status: Status = serde_json::from_str(r#"{"BackendState":"Running","Health":null,"CurrentTailnet":{"Name":"a-ha.io","MagicDNSSuffix":"taileada8.ts.net","MagicDNSEnabled":true},"Peer":{"key":{"HostName":"ts-subnet-apne2a","DNSName":"ts-subnet-apne2a.taileada8.ts.net.","Online":true,"TailscaleIPs":["100.71.74.23"],"PrimaryRoutes":["10.0.0.0/16"],"LastSeen":"2026-11-05T00:00:00Z"},"exit":{"HostName":"exit","PrimaryRoutes":null}}}"#).unwrap();
    assert_eq!(status.current_tailnet.unwrap().magic_dns_suffix, "taileada8.ts.net");
    let peers = status.peers.unwrap();
    assert_eq!(peers["key"].primary_routes.as_ref().unwrap()[0], "10.0.0.0/16");
    assert!(peers["exit"].primary_routes.is_none());
    let prefs: Prefs = serde_json::from_str(r#"{"accept-routes":true,"accept-dns":false,"exit-node":"","extra":1}"#).unwrap();
    assert!(prefs.accept_routes && !prefs.accept_dns && prefs.exit_node.is_empty());
    assert!(!serde_json::from_str::<Netcheck>(r#"{"UDP":false,"IPv4":true}"#).unwrap().udp);
}
#[test]
fn parses_ping_even_with_error_after_pong() {
    assert_eq!(ping("pong from router (100.71.74.23) via DERP(tok) in 66ms\ndirect connection not established"), Ping::Pong { via: "DERP(tok)".into(), latency: "66ms".into() });
    assert_eq!(ping("pong from router (100.71.74.23) via 1.2.3.4:41641 in 5ms"), Ping::Pong { via: "1.2.3.4:41641".into(), latency: "5ms".into() });
    assert_eq!(ping("no matching peer"), Ping::NoPeer);
    assert_eq!(ping("ping \"x\" timed out\nno reply"), Ping::Timeout);
}
