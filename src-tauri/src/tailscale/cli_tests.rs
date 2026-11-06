use super::cli::{restore_plan, share_args, ShareRequest};
use serde_json::json;

fn request(value: serde_json::Value) -> ShareRequest { serde_json::from_value(value).unwrap() }

#[test]
fn serve_and_funnel_preview_exact_background_commands() {
    let serve = request(json!({"action":"mapping","mode":"https","port":"8443","path":"/app","target":"http://localhost:3000"}));
    assert_eq!(share_args(&serve).unwrap(), ["serve", "--bg", "--https=8443", "--set-path=/app", "http://localhost:3000"]);
    let funnel = request(json!({"action":"mapping","mode":"tcp","port":"443","service":"funnel","target":"3000"}));
    assert_eq!(share_args(&funnel).unwrap(), ["funnel", "--bg", "--tcp=443", "3000"]);
    let service = request(json!({"action":"mapping","mode":"https","port":"443","service":"svc:app","target":"3000"}));
    assert_eq!(share_args(&service).unwrap(), ["serve", "--bg", "--https=443", "--service=svc:app", "3000"]);
}

#[test]
fn taildrop_and_cert_preserve_paths_as_arguments() {
    let send = request(json!({"action":"send","files":["/tmp/a b", "/tmp/c"],"target":"peer"}));
    assert_eq!(share_args(&send).unwrap(), ["file", "cp", "/tmp/a b", "/tmp/c", "peer:"]);
    let cert = request(json!({"action":"certificate","folder":"/tmp/certs", "domain":"node.example.ts.net"}));
    assert_eq!(share_args(&cert).unwrap(), ["cert", "--cert-file=/tmp/certs/node.example.ts.net.crt", "--key-file=/tmp/certs/node.example.ts.net.key", "node.example.ts.net"]);
    assert!(share_args(&request(json!({"action":"send","files":["--help"],"target":"peer"}))).is_err());
    assert!(share_args(&request(json!({"action":"certificate","folder":"/tmp", "domain":"../key"}))).is_err());
}

#[test]
fn rebuilds_captured_macos_serve_configuration() {
    let status = json!({
        "TCP": {"443": {"HTTPS": true}, "8443": {"HTTPS": true}},
        "Web": {
            "mac.example.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:5476"}}},
            "mac.example.ts.net:8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:7317"}}}
        }
    });
    let plan = restore_plan(&status).unwrap();
    assert_eq!(plan.len(), 3);
    assert_eq!(plan[0], ["serve", "reset"]);
    assert_eq!(plan[1], ["serve", "--bg", "--https=443", "--set-path=/", "http://127.0.0.1:5476"]);
    assert_eq!(plan[2], ["serve", "--bg", "--https=8443", "--set-path=/", "http://127.0.0.1:7317"]);
}

#[test]
fn rejects_unknown_handlers_before_a_reset() {
    let status = json!({"TCP":{"443":{"HTTPS":true}},"Web":{"mac.ts.net:443":{"Handlers":{"/":{"Unknown":"value"}}}}});
    assert!(restore_plan(&status).is_err());
}

#[test]
fn reconstructs_funnel_and_tcp_and_rejects_unknown_settings() {
    let status = json!({
        "TCP": {"443":{"HTTPS":true},"9000":{"TCPForward":"127.0.0.1:9001"}},
        "Web": {"mac.ts.net:443":{"Handlers":{"/demo":{"Path":"/tmp/files"}}}},
        "AllowFunnel":{"mac.ts.net:443":true}
    });
    let plan = restore_plan(&status).unwrap();
    assert_eq!(plan[1], ["funnel", "--bg", "--https=443", "--set-path=/demo", "/tmp/files"]);
    assert_eq!(plan[2], ["serve", "--bg", "--tcp=9000", "127.0.0.1:9001"]);
    assert!(restore_plan(&json!({"TCP":{"443":{"HTTPS":true,"Other":true}}})).is_err());
    assert!(restore_plan(&json!({"Other":{"active":true}})).is_err());
}
