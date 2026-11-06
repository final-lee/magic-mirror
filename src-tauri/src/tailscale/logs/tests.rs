use chrono::TimeZone;
use serde_json::json;

use super::*;
use crate::tailscale::api::testing::{api_requests, reply, serve, test_state_at, TAILNET};

fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 5, 12, 0, 0).unwrap()
}

fn state(base: &str) -> TailscaleState {
    test_state_at(base, Default::default())
}

fn audit_body() -> Value {
    json!({"version": "1.1", "tailnet": "example.com", "logs": [
        {"eventTime": "2026-11-04T10:00:00.5Z", "type": "CONFIG", "eventGroupID": "g1", "origin": "ADMIN_CONSOLE", "action": "UPDATE",
         "actor": {"id": "u1", "type": "USER", "loginName": "alice@example.com", "displayName": "Alice"},
         "target": {"id": "n1", "type": "NODE", "name": "web-1.example.ts.net", "property": "KEY_EXPIRY"},
         "old": false, "new": true},
        {"eventTime": "2026-11-05T09:00:00Z", "type": "CONFIG", "eventGroupID": "g2", "origin": "CONFIG_API", "action": "DELETE",
         "actor": {"id": "oc1", "type": "OAUTH_CLIENT", "displayName": "ci client"},
         "target": {"id": "k1", "type": "API_KEY"}, "error": "denied", "actionDetails": "cleanup"},
        {"eventTime": "2026-11-05T08:00:00.123456Z", "origin": "NODE", "action": "LOGIN", "actor": {"id": "n2", "type": "NODE"}, "target": {"id": "t1", "type": "TAILNET"}},
    ]})
}

#[test]
fn audit_events_are_newest_first_with_readable_actor_and_target() {
    let log = shape_audit(&audit_body(), "s", "e").unwrap();
    assert_eq!(log.total, 3);
    let times: Vec<_> = log.events.iter().map(|e| e.time.as_str()).collect();
    assert_eq!(times, ["2026-11-05T09:00:00Z", "2026-11-05T08:00:00.123456Z", "2026-11-04T10:00:00.5Z"]);

    let delete = &log.events[0];
    assert_eq!((delete.actor.name.as_str(), delete.actor.kind.as_str()), ("ci client", "OAUTH_CLIENT"));
    assert_eq!((delete.target.name.as_str(), delete.target.kind.as_str()), ("k1", "API_KEY"));
    assert_eq!((delete.error.as_deref(), delete.details.as_deref(), delete.origin.as_str()), (Some("denied"), Some("cleanup"), "CONFIG_API"));
    // 이름이 없으면 ID로 보인다
    assert_eq!(log.events[1].actor.name, "n2");

    let update = &log.events[2];
    assert_eq!(update.actor.name, "alice@example.com");
    assert_eq!((update.target.name.as_str(), update.target.property.as_deref()), ("web-1.example.ts.net", Some("KEY_EXPIRY")));
    assert_eq!((update.old.as_deref(), update.new.as_deref()), (Some("false"), Some("true")));
}

#[test]
fn audit_old_and_new_values_are_cut_to_a_short_preview_and_the_list_is_capped() {
    let huge = "x".repeat(5000);
    let logs: Vec<_> = (0..MAX_EVENTS + 5)
        .map(|i| json!({"eventTime": format!("2026-11-04T10:{:02}:{:02}Z", i / 60 % 60, i % 60), "origin": "ADMIN_CONSOLE", "action": "UPDATE", "actor": {"id": "u"}, "target": {"id": "t"}, "old": huge, "new": ["a"]}))
        .collect();
    let log = shape_audit(&json!({"logs": logs}), "s", "e").unwrap();
    assert_eq!((log.events.len(), log.total), (MAX_EVENTS, MAX_EVENTS + 5));
    let old = log.events[0].old.as_deref().unwrap();
    assert_eq!(old.chars().count(), MAX_VALUE_CHARS + 1);
    assert!(old.ends_with('…'));
    assert_eq!(log.events[0].new.as_deref(), Some(r#"["a"]"#));
}

#[test]
fn audit_response_without_logs_is_a_response_error() {
    assert_eq!(shape_audit(&json!({}), "s", "e").unwrap_err(), AppError::other(RESPONSE_ERROR));
}

#[tokio::test]
async fn audit_asks_for_the_chosen_window_ending_now() {
    for (days, start) in [(1, "2026-11-04T12:00:00Z"), (7, "2026-10-29T12:00:00Z"), (30, "2026-10-06T12:00:00Z")] {
        let (base, seen) = serve(|_| reply(200, &audit_body().to_string())).await;
        let log = audit(&state(&base), TAILNET, days, now()).await.unwrap();
        assert_eq!((log.start.as_str(), log.end.as_str()), (start, "2026-11-05T12:00:00Z"));
        let calls = api_requests(&seen);
        assert_eq!(calls[0].path, format!("/api/v2/tailnet/-/logging/configuration?start={start}&end=2026-11-05T12:00:00Z"));
        assert_eq!(calls[0].headers["authorization"], "Bearer tok-all:read");
    }
}

#[tokio::test]
async fn audit_rejects_other_windows_without_a_request() {
    let (base, seen) = serve(|_| reply(200, "{}")).await;
    assert!(audit(&state(&base), TAILNET, 90, now()).await.is_err());
    assert!(api_requests(&seen).is_empty());
}

#[tokio::test]
async fn a_missing_scope_or_plan_fails_only_that_section() {
    let (base, _) = serve(|req| {
        if req.path.contains("/logging/configuration?") {
            reply(403, r#"{"message":"forbidden"}"#)
        } else if req.path.contains("/logging/network") {
            reply(403, r#"{"message":"feature not available on current billing plan"}"#)
        } else {
            // 웹훅이 하나도 없으면 API는 빈 배열 대신 null을 준다(실제 응답)
            reply(200, r#"{"webhooks":null}"#)
        }
    })
    .await;
    let state = state(&base);
    assert_eq!(audit(&state, TAILNET, 7, now()).await.unwrap_err(), AppError::other("이 자격 증명에 all:read 권한이 없어요 (forbidden)"));
    assert_eq!(stream(&state, TAILNET, "network").await.unwrap_err(), AppError::other(crate::tailscale::api::PLAN_UNAVAILABLE));
    assert!(webhooks(&state, TAILNET).await.unwrap().is_empty());
}

fn flow(proto: &str, src: &str, dst: &str, tx: u64, rx: u64) -> Value {
    json!({"proto": proto, "src": src, "dst": dst, "txPkts": 2, "txBytes": tx, "rxPkts": 1, "rxBytes": rx})
}

fn flow_server(enabled: Value) -> impl Fn(&crate::tailscale::api::testing::Seen) -> crate::tailscale::api::testing::Reply + Send + Sync + 'static {
    move |req| {
        if req.path == "/api/v2/tailnet/-/settings" {
            reply(200, &json!({"networkFlowLoggingOn": enabled}).to_string())
        } else if req.path.starts_with("/api/v2/tailnet/-/logging/network?") {
            reply(
                200,
                &json!({"logs": [
                    {"nodeId": "nA", "logged": "2026-11-05T11:30:00Z", "virtualTraffic": [
                        flow("tcp", "100.64.0.1:50000", "100.64.0.2:443", 100, 400),
                        flow("tcp", "100.64.0.1:50001", "100.64.0.2:443", 50, 50)],
                     "exitTraffic": [flow("udp", "100.64.0.1:1", "1.1.1.1:53", 10, 10)],
                     "physicalTraffic": [flow("udp", "1.2.3.4:1", "5.6.7.8:41641", 99999, 99999)]},
                    {"nodeId": "nA", "virtualTraffic": [flow("tcp", "100.64.0.1:50002", "100.64.0.2:443", 1, 1)]},
                    {"nodeId": "nB", "subnetTraffic": [flow("tcp", "[fd7a::1]:5", "10.0.0.5:22", 1000, 0)]},
                ]})
                .to_string(),
            )
        } else if req.path == "/api/v2/tailnet/-/devices" {
            reply(
                200,
                r#"{"devices":[{"nodeId":"nA","hostname":"laptop","name":"laptop.example.ts.net","addresses":["100.64.0.1","fd7a::1"]},{"nodeId":"nB","name":"router.example.ts.net","addresses":["100.64.0.2"]}]}"#,
            )
        } else {
            panic!("unexpected {}", req.path)
        }
    }
}

#[tokio::test]
async fn flow_logs_stay_unread_when_the_tailnet_has_them_off() {
    for enabled in [json!(false), json!(null)] {
        let (base, seen) = serve(flow_server(enabled)).await;
        let result = flows(&state(&base), TAILNET, now()).await.unwrap();
        assert_eq!((result.enabled, result.flows.len(), result.total), (false, 0, 0));
        let paths: Vec<_> = api_requests(&seen).into_iter().map(|r| r.path).collect();
        assert_eq!(paths, ["/api/v2/tailnet/-/settings"]);
    }
}

#[tokio::test]
async fn flow_logs_cover_the_last_hour_and_group_by_node_class_and_destination() {
    let (base, seen) = serve(flow_server(json!(true))).await;
    let result = flows(&state(&base), TAILNET, now()).await.unwrap();
    assert!(result.enabled);
    assert_eq!((result.start.as_str(), result.end.as_str()), ("2026-11-05T11:00:00Z", "2026-11-05T12:00:00Z"));
    assert!(api_requests(&seen).iter().any(|r| r.path == "/api/v2/tailnet/-/logging/network?start=2026-11-05T11:00:00Z&end=2026-11-05T12:00:00Z"));

    // 출발 포트가 달라도 같은 목적지는 하나로 묶고, 물리 경로 트래픽은 싣지 않는다. 바이트 많은 순.
    assert_eq!(result.total, 3);
    let subnet = &result.flows[0];
    assert_eq!((subnet.node_name.as_deref(), subnet.class, subnet.src.as_str(), subnet.src_name.as_deref()), (Some("router"), "subnet", "fd7a::1", Some("laptop")));
    assert_eq!((subnet.dst.as_str(), subnet.dst_name.clone()), ("10.0.0.5:22", None));

    let tailnet = &result.flows[1];
    assert_eq!((tailnet.node_name.as_deref(), tailnet.class, tailnet.proto.as_str()), (Some("laptop"), "tailnet", "tcp"));
    assert_eq!((tailnet.src.as_str(), tailnet.dst.as_str()), ("100.64.0.1", "100.64.0.2:443"));
    assert_eq!((tailnet.src_name.as_deref(), tailnet.dst_name.as_deref()), (Some("laptop"), Some("router")));
    assert_eq!((tailnet.tx_bytes, tailnet.rx_bytes, tailnet.tx_pkts, tailnet.rx_pkts), (151, 451, 6, 3));

    assert_eq!((result.flows[2].class, result.flows[2].dst.as_str(), result.flows[2].dst_name.clone()), ("exit", "1.1.1.1:53", None));
}

#[tokio::test]
async fn flow_logs_still_show_when_device_names_cannot_be_read() {
    let inner = flow_server(json!(true));
    let (base, _) = serve(move |req| if req.path == "/api/v2/tailnet/-/devices" { reply(403, "{}") } else { inner(req) }).await;
    let result = flows(&state(&base), TAILNET, now()).await.unwrap();
    assert_eq!(result.total, 3);
    assert!(result.flows.iter().all(|f| f.node_name.is_none()));
}

#[tokio::test]
async fn flow_logging_state_unreadable_is_an_error_not_a_silent_off() {
    let (base, _) = serve(|_| reply(403, "{}")).await;
    assert!(flows(&state(&base), TAILNET, now()).await.is_err());
}

#[tokio::test]
async fn stream_without_configuration_is_reported_as_not_configured() {
    let (base, seen) = serve(|_| reply(404, r#"{"message":"log streaming not configured"}"#)).await;
    let stream = stream(&state(&base), TAILNET, "network").await.unwrap();
    assert!(!stream.configured);
    assert_eq!(stream.log_type, "network");
    let paths: Vec<_> = api_requests(&seen).into_iter().map(|r| r.path).collect();
    assert_eq!(paths, ["/api/v2/tailnet/-/logging/network/stream"]);
}

#[tokio::test]
async fn stream_shows_destination_status_and_never_a_secret_in_the_url() {
    let (base, seen) = serve(|req| {
        if req.path.ends_with("/stream/status") {
            reply(200, r#"{"lastActivity":"2026-11-05T11:59:00Z","lastError":"timeout","numEntriesSent":8363,"numBytesSent":17238983,"numTotalRequests":10610,"numFailedRequests":5434}"#)
        } else {
            reply(200, r#"{"logType":"configuration","destinationType":"elastic","url":"https://user:pw@logs.example.com/ingest?token=abc#x","user":"myusername","uploadPeriodMinutes":5,"compressionFormat":"zstd"}"#)
        }
    })
    .await;
    let stream = stream(&state(&base), TAILNET, "configuration").await.unwrap();
    assert!(stream.configured);
    assert_eq!(stream.url.as_deref(), Some("https://logs.example.com/ingest"));
    assert_eq!((stream.destination_type.as_deref(), stream.user.as_deref(), stream.upload_period_minutes, stream.compression.as_deref()), (Some("elastic"), Some("myusername"), Some(5), Some("zstd")));
    assert_eq!(
        stream.status,
        Some(StreamStatus { last_activity: Some("2026-11-05T11:59:00Z".into()), last_error: Some("timeout".into()), entries_sent: 8363, bytes_sent: 17238983, requests: 10610, failed_requests: 5434 })
    );
    let paths: Vec<_> = api_requests(&seen).into_iter().map(|r| r.path).collect();
    assert_eq!(paths, ["/api/v2/tailnet/-/logging/configuration/stream", "/api/v2/tailnet/-/logging/configuration/stream/status"]);
}

#[tokio::test]
async fn stream_with_missing_status_still_shows_the_configuration() {
    let (base, _) = serve(|req| {
        if req.path.ends_with("/stream/status") {
            reply(404, "{}")
        } else {
            reply(200, r#"{"destinationType":"s3","url":""}"#)
        }
    })
    .await;
    let stream = stream(&state(&base), TAILNET, "configuration").await.unwrap();
    assert_eq!((stream.configured, stream.url, stream.status), (true, None, None));
}

#[tokio::test]
async fn stream_forbidden_is_an_error_and_unknown_log_types_never_reach_the_api() {
    let (base, seen) = serve(|_| reply(403, "{}")).await;
    let state = state(&base);
    assert_eq!(stream(&state, TAILNET, "configuration").await.unwrap_err(), AppError::other("이 자격 증명에 all:read 권한이 없어요"));
    assert!(stream(&state, TAILNET, "../acl").await.is_err());
    assert_eq!(api_requests(&seen).len(), 1);
}

#[tokio::test]
async fn webhooks_list_hides_paths_that_carry_secrets() {
    let (base, _) = serve(|_| {
        reply(
            200,
            r#"{"webhooks":[
                {"endpointId":"w1","endpointUrl":"https://hooks.slack.com/services/T0/B0/secretvalue","providerType":"slack","creatorLoginName":"a@example.com","created":"2026-01-01T00:00:00Z","lastModified":"2026-02-01T00:00:00Z","subscriptions":["nodeCreated","policyUpdate"]},
                {"endpointId":"w2","endpointUrl":"https://example.com:8443/","providerType":"","subscriptions":[]},
                {"endpointUrl":"https://no-id.example.com/"}]}"#,
        )
    })
    .await;
    let hooks = webhooks(&state(&base), TAILNET).await.unwrap();
    assert_eq!(hooks.len(), 2);
    assert_eq!((hooks[0].endpoint.as_str(), hooks[0].provider.as_str(), hooks[0].creator.as_deref()), ("https://hooks.slack.com/…", "slack", Some("a@example.com")));
    assert_eq!(hooks[0].subscriptions, ["nodeCreated", "policyUpdate"]);
    assert_eq!(hooks[1].endpoint, "https://example.com:8443");
    assert!(!format!("{hooks:?}").contains("secretvalue"));
}
