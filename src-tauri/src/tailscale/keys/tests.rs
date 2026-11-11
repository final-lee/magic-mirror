use chrono::TimeZone;
use serde_json::json;

use super::*;
use crate::tailscale::api::testing::{api_requests, reply, serve, test_state_at, TAILNET};

fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 5, 0, 0, 0).unwrap()
}

fn key(id: &str, kind: KeyKind) -> TsKey {
    TsKey {
        id: id.into(),
        kind,
        description: String::new(),
        created: Some("2026-01-01T00:00:00Z".into()),
        expires: None,
        scopes: Vec::new(),
        tags: Vec::new(),
        reusable: false,
        ephemeral: false,
        preauthorized: false,
        invalid: false,
        user_id: None,
    }
}

fn auth(id: &str, expires: &str) -> TsKey {
    TsKey { expires: Some(expires.into()), tags: vec!["tag:ci".into()], ..key(id, KeyKind::Auth) }
}

fn kinds(found: &[KeyFinding], id: &str) -> Vec<FindingKind> {
    found.iter().filter(|f| f.key_id == id).map(|f| f.kind).collect()
}

#[test]
fn expiry_findings_split_expired_expiring_and_healthy() {
    let keys = [
        auth("past", "2026-11-01T00:00:00Z"),
        auth("soon", "2026-11-20T12:00:00Z"),
        auth("edge", "2026-12-05T00:00:00Z"),
        auth("later", "2026-12-05T00:00:01Z"),
        TsKey { invalid: true, ..auth("revoked", "2027-01-01T00:00:00Z") },
    ];
    let found = findings(&keys, now());
    assert_eq!(found.iter().find(|f| f.key_id == "past").unwrap(), &KeyFinding { key_id: "past".into(), kind: FindingKind::Expired, days: Some(4) });
    // 15일 12시간 남음 → 16일로 올림
    assert_eq!(found.iter().find(|f| f.key_id == "soon").unwrap(), &KeyFinding { key_id: "soon".into(), kind: FindingKind::Expiring, days: Some(16) });
    assert_eq!(kinds(&found, "edge"), [FindingKind::Expiring]);
    assert!(kinds(&found, "later").is_empty());
    assert_eq!(kinds(&found, "revoked"), [FindingKind::Expired]);
}

#[test]
fn auth_key_risk_findings() {
    let risky = TsKey { reusable: true, preauthorized: true, tags: Vec::new(), ..key("risky", KeyKind::Auth) };
    let reusable_only = TsKey { reusable: true, tags: vec!["tag:a".into()], ..key("reusable", KeyKind::Auth) };
    let single_use = TsKey { tags: vec!["tag:a".into()], preauthorized: true, ..key("single", KeyKind::Auth) };
    let expired = TsKey { reusable: true, preauthorized: true, expires: Some("2026-01-01T00:00:00Z".into()), ..key("dead", KeyKind::Auth) };
    let found = findings(&[risky, reusable_only, single_use, expired], now());
    assert_eq!(kinds(&found, "risky"), [FindingKind::ReusablePreauthorized, FindingKind::NoTags]);
    assert!(kinds(&found, "reusable").is_empty());
    assert!(kinds(&found, "single").is_empty());
    // 만료된 키는 만료만 지적한다
    assert_eq!(kinds(&found, "dead"), [FindingKind::Expired]);
}

#[test]
fn all_scope_is_flagged_on_oauth_clients_and_federated_but_not_read_scopes_or_api_tokens() {
    let client = |id, scopes: &[&str]| TsKey { scopes: scopes.iter().map(|s| s.to_string()).collect(), ..key(id, KeyKind::Client) };
    let keys = [
        client("all-client", &["all"]),
        client("read-client", &["all:read", "devices:core"]),
        TsKey { scopes: vec!["all".into()], ..key("fed", KeyKind::Federated) },
        TsKey { scopes: vec!["all".into()], ..key("token", KeyKind::Api) },
    ];
    let found = findings(&keys, now());
    assert_eq!(kinds(&found, "all-client"), [FindingKind::AllScope]);
    assert!(kinds(&found, "read-client").is_empty());
    assert_eq!(kinds(&found, "fed"), [FindingKind::AllScope]);
    assert!(kinds(&found, "token").is_empty());
}

/// `list`는 실제 시계로 만료 임박을 가린다: 만료일을 오늘 기준으로 잡아 날짜가 지나도 깨지지 않게 한다
fn key_list() -> serde_json::Value {
    let at = |days: i64| (Utc::now() + chrono::Duration::days(days)).format("%Y-%m-%dT%H:%M:%SZ").to_string();
    json!({"keys": [
        {"id": "kAPI", "keyType": "api", "created": "2026-01-01T00:00:00Z", "expires": at(300), "scopes": ["all"], "description": "mine", "userId": "u1"},
        {"id": "kLATE", "keyType": "auth", "created": "2026-01-01T00:00:00Z", "expires": at(60),
         "capabilities": {"devices": {"create": {"reusable": true, "ephemeral": false, "preauthorized": true, "tags": ["tag:ci"]}}}, "description": "ci"},
        {"id": "kSOON", "keyType": "auth", "created": "2026-01-01T00:00:00Z", "expires": at(10), "capabilities": {"devices": {"create": {}}}},
        {"id": "kOAUTH", "keyType": "client", "created": "2026-01-01T00:00:00Z", "scopes": ["all"], "tags": ["tag:a"], "description": "ci client"},
    ]})
}

#[tokio::test]
async fn list_shapes_every_key_type_sorts_by_kind_then_expiry_and_asks_for_all_keys() {
    let (base, seen) = serve(|_| reply(200, &key_list().to_string())).await;
    let state = test_state_at(&base, Default::default());
    let result = list(&state, TAILNET).await.unwrap();

    let calls = api_requests(&seen);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].path, "/api/v2/tailnet/-/keys?all=true");
    assert_eq!(calls[0].headers["authorization"], "Bearer tok-all:read");

    let order: Vec<_> = result.keys.iter().map(|k| (k.id.as_str(), k.kind)).collect();
    assert_eq!(order, [("kSOON", KeyKind::Auth), ("kLATE", KeyKind::Auth), ("kOAUTH", KeyKind::Client), ("kAPI", KeyKind::Api)]);
    let late = result.keys.iter().find(|k| k.id == "kLATE").unwrap();
    assert_eq!((late.reusable, late.ephemeral, late.preauthorized, late.tags.clone()), (true, false, true, vec!["tag:ci".to_string()]));
    let client = result.keys.iter().find(|k| k.id == "kOAUTH").unwrap();
    assert_eq!((client.scopes.clone(), client.tags.clone(), client.description.as_str()), (vec!["all".to_string()], vec!["tag:a".to_string()], "ci client"));

    assert_eq!(kinds(&result.findings, "kSOON"), [FindingKind::Expiring, FindingKind::NoTags]);
    assert_eq!(kinds(&result.findings, "kLATE"), [FindingKind::ReusablePreauthorized]);
    assert_eq!(kinds(&result.findings, "kOAUTH"), [FindingKind::AllScope]);
}

#[tokio::test]
async fn list_reads_details_for_entries_that_only_carry_an_id() {
    let (base, seen) = serve(|req| match req.path.as_str() {
        "/api/v2/tailnet/-/keys?all=true" => reply(200, r#"{"keys":[{"id":"kA"},{"id":"kB"}]}"#),
        "/api/v2/tailnet/-/keys/kA" => reply(200, r#"{"id":"kA","keyType":"auth","capabilities":{"devices":{"create":{"tags":["tag:x"]}}}}"#),
        "/api/v2/tailnet/-/keys/kB" => reply(200, r#"{"id":"kB","keyType":"client","scopes":["all:read"]}"#),
        other => panic!("unexpected {other}"),
    })
    .await;
    let state = test_state_at(&base, Default::default());
    let result = list(&state, TAILNET).await.unwrap();
    assert_eq!(result.keys.iter().map(|k| (k.id.as_str(), k.kind)).collect::<Vec<_>>(), [("kA", KeyKind::Auth), ("kB", KeyKind::Client)]);
    assert_eq!(api_requests(&seen).len(), 3);
}

fn one_key_server(key: Value) -> impl Fn(&crate::tailscale::api::testing::Seen) -> crate::tailscale::api::testing::Reply + Send + Sync + 'static {
    move |req| match (req.method.as_str(), req.path.as_str()) {
        ("GET", p) if p.starts_with("/api/v2/tailnet/-/keys/") => reply(200, &key.to_string()),
        ("DELETE", _) => reply(200, ""),
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn delete_preview_shows_the_exact_call_scope_and_the_id_to_type_per_key_type() {
    for (key_type, scope) in [("auth", "auth_keys"), ("client", "oauth_keys"), ("federated", "federated_keys"), ("api", "api_access_tokens")] {
        let (base, seen) = serve(one_key_server(json!({"id": "k123", "keyType": key_type, "description": "d"}))).await;
        let state = test_state_at(&base, Default::default());
        let preview = delete_preview(&state, TAILNET, "k123").await.unwrap();
        assert_eq!(preview.calls, [KeyCall { method: "DELETE", path: "/tailnet/-/keys/k123".into(), scope }]);
        assert_eq!(preview.confirm_name, "k123");
        assert!(!preview.reversible);
        assert_eq!(preview.warnings.len(), 1);
        // 미리보기는 읽기만 한다
        assert!(api_requests(&seen).iter().all(|r| r.method == "GET"));
    }
}

#[tokio::test]
async fn delete_without_the_typed_id_sends_nothing_and_keeps_no_record() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("tailscale-changes.jsonl");
    let (base, seen) = serve(one_key_server(json!({"id": "k123", "keyType": "auth"}))).await;
    let state = test_state_at(&base, log.clone());
    for typed in ["", "K123", "k12"] {
        assert_eq!(delete(&state, TAILNET, "k123", typed).await.unwrap_err(), AppError::other(CONFIRM_MISMATCH));
    }
    assert!(api_requests(&seen).iter().all(|r| r.method == "GET"));
    assert!(changes::list(&log).is_empty());
}

#[tokio::test]
async fn delete_calls_the_api_with_the_key_type_scope_and_records_a_non_undoable_entry() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("tailscale-changes.jsonl");
    let (base, seen) = serve(one_key_server(json!({"id": "k123", "keyType": "client", "description": "ci client", "scopes": ["all"]}))).await;
    let state = test_state_at(&base, log.clone());
    assert_eq!(delete(&state, TAILNET, "k123", "k123").await.unwrap(), KeyDeleted { logged: true });

    let calls = api_requests(&seen);
    let delete_call = calls.iter().find(|r| r.method == "DELETE").unwrap();
    assert_eq!(delete_call.path, "/api/v2/tailnet/-/keys/k123");
    assert_eq!(delete_call.headers["authorization"], "Bearer tok-oauth_keys");

    let entries = changes::list(&log);
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!((entry.action.as_str(), entry.tailnet.as_str(), entry.undone, entry.undo_of.clone()), ("key_delete", TAILNET, false, None));
    assert_eq!(entry.target.name.as_deref(), Some("ci client"));
    assert_eq!(entry.before["id"], "k123");
    assert_eq!(entry.before["kind"], "client");
    assert!(entry.after.is_null());
}

#[tokio::test]
async fn delete_reports_an_unwritable_log_but_the_key_is_already_gone() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("blocker");
    std::fs::write(&blocker, "").unwrap();
    let (base, seen) = serve(one_key_server(json!({"id": "k1", "keyType": "auth"}))).await;
    let state = test_state_at(&base, blocker.join("tailscale-changes.jsonl"));
    assert_eq!(delete(&state, TAILNET, "k1", "k1").await.unwrap(), KeyDeleted { logged: false });
    assert!(api_requests(&seen).iter().any(|r| r.method == "DELETE"));
}

#[tokio::test]
async fn delete_failure_is_not_recorded() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("tailscale-changes.jsonl");
    let (base, _) = serve(|req| match req.method.as_str() {
        "GET" => reply(200, r#"{"id":"k1","keyType":"auth"}"#),
        _ => reply(403, "{}"),
    })
    .await;
    let state = test_state_at(&base, log.clone());
    assert_eq!(delete(&state, TAILNET, "k1", "k1").await.unwrap_err(), AppError::other("이 자격 증명에 auth_keys 권한이 없어요"));
    assert!(changes::list(&log).is_empty());
}

#[tokio::test]
async fn key_ids_that_could_escape_the_path_are_rejected_before_any_request() {
    let (base, seen) = serve(|_| reply(200, "{}")).await;
    let state = test_state_at(&base, Default::default());
    for id in ["", "../acl", "a/b", "a?b", "a b"] {
        assert_eq!(delete_preview(&state, TAILNET, id).await.unwrap_err(), AppError::other(KEY_ID_INVALID));
    }
    assert!(api_requests(&seen).is_empty());
}

#[test]
fn lock_enabled_reports_trust_signature_and_nodes_needing_signature() {
    let lock = shape_lock(
        r#"{"SchemaVersion":"1","Enabled":true,"PublicKey":"tlpub:me","NodeKey":"nodekey:n","NodeKeySigned":true,
            "TrustedKeys":[{"Key":"tlpub:other","Votes":1},{"Key":"tlpub:me","Votes":1}],
            "FilteredPeers":[{"Name":"build-1.example.ts.net.","NodeKey":"nodekey:abc","TailscaleIPs":["100.64.0.9"]},{"TailscaleIPs":["100.64.0.10"]}]}"#,
    )
    .unwrap();
    assert_eq!(
        lock,
        TsLock {
            enabled: true,
            public_key: Some("tlpub:me".into()),
            node_key_signed: Some(true),
            this_key_trusted: Some(true),
            trusted_keys: 2,
            needs_signature: vec![
                LockPeer { name: "build-1.example.ts.net.".into(), node_key: Some("nodekey:abc".into()) },
                LockPeer { name: "100.64.0.10".into(), node_key: None },
            ],
        }
    );
}

#[test]
fn lock_enabled_without_this_key_in_the_trusted_set_is_not_a_signing_node() {
    let lock = shape_lock(r#"{"Enabled":true,"PublicKey":"tlpub:me","TrustedKeys":[{"Key":"tlpub:other"}]}"#).unwrap();
    assert_eq!((lock.this_key_trusted, lock.node_key_signed, lock.trusted_keys), (Some(false), Some(false), 1));
}

#[test]
fn lock_disabled_has_no_trust_judgement() {
    let lock = shape_lock(r#"{"SchemaVersion":"1","Enabled":false,"PublicKey":"tlpub:me","NodeKey":"nodekey:n"}"#).unwrap();
    assert_eq!(lock, TsLock { enabled: false, public_key: Some("tlpub:me".into()), node_key_signed: None, this_key_trusted: None, trusted_keys: 0, needs_signature: Vec::new() });
}

#[test]
fn lock_status_that_is_not_json_is_an_error() {
    assert_eq!(shape_lock("not json").unwrap_err(), AppError::other(LOCK_PARSE));
}

#[tokio::test]
async fn create_returns_secret_once_without_debug_or_change_log_leakage() {
    let (base, seen) = serve(|_| reply(200, r#"{"id":"key1","key":"one-time-secret"}"#)).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("changes.jsonl");
    let state = test_state_at(&base, path.clone());
    let body = json!({"keyType":"auth","capabilities":{"devices":{"create":{"reusable":true}}}});
    let response = create_or_update(&state, TAILNET, None, body.clone()).await.unwrap();
    assert_eq!(response["key"], "one-time-secret");
    let requests = api_requests(&seen);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].path, "/api/v2/tailnet/-/keys");
    assert_eq!(requests[0].headers["authorization"], "Bearer tok-auth_keys");
    assert_eq!(serde_json::from_str::<Value>(&requests[0].body).unwrap(), body);
    assert!(!std::fs::read_to_string(path).unwrap_or_default().contains("one-time-secret"));
    let response = super::super::api::Response { status: 200, body: r#"{"key":"one-time-secret"}"#.into(), etag: None };
    assert!(!format!("{response:?}").contains("one-time-secret"));
    let request = Request::new(Method::POST, "/tailnet/-/keys", Scope::Write("auth_keys")).json(json!({"clientSecret":"one-time-secret"}));
    assert!(!format!("{request:?}").contains("one-time-secret"));
}
