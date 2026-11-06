use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::findings::{analyze, Severity};
use super::*;
use crate::tailscale::api::testing::{api_requests, reply, serve, test_state_at, Reply, Seen, TAILNET};

fn tags(list: &[&str]) -> BTreeSet<String> {
    list.iter().map(|t| t.to_string()).collect()
}

fn paths(found: &[super::Finding], severity: Severity) -> Vec<&str> {
    found.iter().filter(|f| f.severity == severity).map(|f| f.path.as_str()).collect()
}

/// 손으로 키운 테일넷 정책: 기본 "전부 허용" 규칙이 남아 있고, 시험이 없다.
fn sloppy() -> Value {
    json!({
        "groups": {
            "group:ops": ["alice@example.com", "bob@example.com"],
            "group:interns": [],
            "group:nested": ["group:interns"],
            "group:loop-a": ["group:loop-b"],
            "group:loop-b": ["group:loop-a"],
        },
        "tagOwners": { "tag:prod": ["group:ops"], "tag:retired": ["group:ops"] },
        "acls": [
            { "action": "accept", "src": ["*"], "dst": ["*:*"] },
            { "action": "accept", "src": ["group:ops"], "dst": ["*:22"] },
            { "action": "accept", "src": ["*"], "dst": ["tag:prod:443"] },
            { "action": "accept", "src": ["group:ops"], "dst": ["tag:prod:*"] },
        ],
        "ssh": [
            { "action": "accept", "src": ["group:ops"], "dst": ["tag:prod"], "users": ["root", "autogroup:nonroot"] },
            { "action": "check", "src": ["group:ops"], "dst": ["tag:prod"], "users": ["root"], "checkPeriod": "12h" },
            { "action": "accept", "src": ["group:ops"], "dst": ["tag:prod"], "users": ["autogroup:nonroot"] },
        ],
        "autoApprovers": {
            "routes": {
                "10.0.0.0/8": ["tag:router"],
                "172.16.0.0/12": ["group:ops"],
                "192.168.1.0/24": ["tag:router"],
                "0.0.0.0/0": ["tag:router"],
                "fd00::/8": ["tag:router"],
                "10.9.0.0/16": [],
            },
            "exitNode": ["tag:router"],
        },
    })
}

#[test]
fn a_sloppy_policy_is_flagged_most_dangerous_first_with_a_path_for_each() {
    let found = analyze(&sloppy(), Some(&tags(&["tag:prod", "tag:router"])));
    let severities: Vec<Severity> = found.iter().map(|f| f.severity).collect();
    assert!(severities.windows(2).all(|w| w[0] <= w[1]), "위험한 순서가 아니에요: {severities:?}");

    // 출발지·목적지가 모두 `*`이면 규칙 하나로 묶고, 한쪽만이면 그 칸을 가리킨다
    assert_eq!(paths(&found, Severity::High), vec!["acls[0]", "acls[2].src[0]", "autoApprovers.routes[\"0.0.0.0/0\"]", "ssh[0].users[0]"]);
    assert_eq!(paths(&found, Severity::Low).len(), 6, "빈 그룹 넷(순환 둘 포함), 쓰지 않는 태그 하나, sshTests: {found:#?}");
    assert!(found.iter().all(|f| !f.title.is_empty() && !f.detail.is_empty()));
}

#[test]
fn wildcard_rules_name_the_side_that_is_open() {
    let policy = json!({
        "acls": [
            { "action": "accept", "src": ["*"], "dst": ["*:*"] },
            { "action": "accept", "src": ["group:ops"], "dst": ["*:22"] },
            { "action": "accept", "src": ["*"], "dst": ["tag:prod:443"] },
            { "action": "accept", "src": ["group:ops"], "dst": ["tag:prod:*", "*"] },
            { "action": "accept", "users": ["*"], "ports": ["10.0.0.1:80"] },
        ],
        "grants": [
            { "src": ["*"], "dst": ["*"], "ip": ["*"] },
            { "src": ["group:ops"], "dst": ["tag:prod"], "ip": ["tcp:443"] },
        ],
    });
    let found = analyze(&policy, None);
    let at = |path: &str| found.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("{path}가 없어요: {found:#?}"));
    assert_eq!(at("acls[0]").severity, Severity::High);
    assert!(at("acls[0]").title.contains("모든 출발지"));
    assert_eq!(at("acls[1].dst[0]").severity, Severity::Medium, "포트가 정해진 `*:22`는 한 단계 낮아요");
    assert_eq!(at("acls[2].src[0]").severity, Severity::High);
    assert_eq!(at("acls[3].dst[1]").severity, Severity::High, "`*` 목적지는 모든 포트예요");
    assert_eq!(at("acls[4].users[0]").severity, Severity::High, "예전 이름(users·ports)도 읽어요");
    assert_eq!(at("grants[0]").severity, Severity::High);
    assert!(found.iter().all(|f| !f.path.starts_with("grants[1]")), "좁은 grant는 지적하지 않아요");
    assert!(found.iter().all(|f| f.path != "acls[1].src[0]" && f.path != "acls[3].dst[0]"));
}

#[test]
fn auto_approvers_flag_wide_routes_exit_nodes_and_skip_narrow_or_empty_ones() {
    let found = analyze(&sloppy(), None);
    let at = |path: &str| found.iter().find(|f| f.path == path);
    assert_eq!(at("autoApprovers.routes[\"0.0.0.0/0\"]").unwrap().severity, Severity::High);
    assert_eq!(at("autoApprovers.routes[\"10.0.0.0/8\"]").unwrap().severity, Severity::Medium);
    assert_eq!(at("autoApprovers.routes[\"172.16.0.0/12\"]").unwrap().severity, Severity::Medium);
    assert_eq!(at("autoApprovers.routes[\"fd00::/8\"]").unwrap().severity, Severity::Medium);
    assert!(at("autoApprovers.routes[\"192.168.1.0/24\"]").is_none());
    assert!(at("autoApprovers.routes[\"10.9.0.0/16\"]").is_none(), "승인자가 없으면 아무것도 열리지 않아요");
    assert_eq!(at("autoApprovers.exitNode").unwrap().severity, Severity::Medium);
    assert!(at("autoApprovers.routes[\"10.0.0.0/8\"]").unwrap().detail.contains("tag:router"));
}

#[test]
fn only_accept_ssh_rules_that_allow_root_are_flagged() {
    let found = analyze(&sloppy(), None);
    let ssh: Vec<&str> = found.iter().filter(|f| f.path.starts_with("ssh[")).map(|f| f.path.as_str()).collect();
    assert_eq!(ssh, vec!["ssh[0].users[0]"], "check로 묶인 root와 nonroot만 있는 accept는 괜찮아요");
}

#[test]
fn groups_with_no_resolvable_members_are_flagged_and_cycles_do_not_hang() {
    let found = analyze(&sloppy(), None);
    let mut empty: Vec<&str> = found.iter().filter(|f| f.path.starts_with("groups")).map(|f| f.path.as_str()).collect();
    empty.sort();
    assert_eq!(empty, vec!["groups[\"group:interns\"]", "groups[\"group:loop-a\"]", "groups[\"group:loop-b\"]", "groups[\"group:nested\"]"]);
    assert!(found.iter().all(|f| f.path != "groups[\"group:ops\"]"));
}

#[test]
fn tags_are_unused_only_when_the_device_list_was_read_and_no_device_has_them() {
    let used = analyze(&sloppy(), Some(&tags(&["tag:prod"])));
    assert!(used.iter().any(|f| f.path == "tagOwners[\"tag:retired\"]" && f.severity == Severity::Low));
    assert!(used.iter().all(|f| f.path != "tagOwners[\"tag:prod\"]"));
    let unknown = analyze(&sloppy(), None);
    assert!(unknown.iter().all(|f| !f.path.starts_with("tagOwners")), "기기를 못 읽었으면 말하지 않아요");
}

#[test]
fn missing_tests_are_flagged_and_present_ones_are_not() {
    let missing = analyze(&sloppy(), None);
    assert!(missing.iter().any(|f| f.path == "tests" && f.severity == Severity::Medium));
    assert!(missing.iter().any(|f| f.path == "sshTests" && f.severity == Severity::Low));

    let mut tested = sloppy();
    tested["tests"] = json!([{ "src": "alice@example.com", "accept": ["tag:prod:22"] }]);
    tested["sshTests"] = json!([{ "src": "alice@example.com", "dst": ["tag:prod"], "accept": ["alice"] }]);
    let found = analyze(&tested, None);
    assert!(found.iter().all(|f| f.path != "tests" && f.path != "sshTests"));

    // SSH 규칙이 없으면 sshTests가 없어도 괜찮다
    let found = analyze(&json!({ "acls": [], "tests": [{ "src": "a@b.c", "accept": ["x:1"] }] }), None);
    assert!(found.is_empty(), "{found:#?}");
}

#[test]
fn a_tight_policy_has_no_findings() {
    let policy = json!({
        "groups": { "group:ops": ["alice@example.com"] },
        "tagOwners": { "tag:prod": ["group:ops"] },
        "grants": [{ "src": ["group:ops"], "dst": ["tag:prod"], "ip": ["tcp:22"] }],
        "ssh": [{ "action": "check", "src": ["group:ops"], "dst": ["tag:prod"], "users": ["root", "autogroup:nonroot"] }],
        "autoApprovers": { "routes": { "10.20.0.0/16": ["tag:prod"] } },
        "tests": [{ "src": "alice@example.com", "accept": ["tag:prod:22"] }],
        "sshTests": [{ "src": "alice@example.com", "dst": ["tag:prod"], "accept": ["root"] }],
    });
    assert_eq!(analyze(&policy, Some(&tags(&["tag:prod"]))), vec![]);
}

const HUJSON_TEXT: &str = "// 정책\n{\n  \"acls\": [{\"action\": \"accept\", \"src\": [\"*\"], \"dst\": [\"*:*\"]}], // 기본값\n}\n";
const ETAG: &str = "\"e0b2816b418\"";

struct Fixture {
    external: bool,
    settings_status: u16,
    devices_status: u16,
}

impl Default for Fixture {
    fn default() -> Self {
        Self { external: false, settings_status: 200, devices_status: 200 }
    }
}

fn tailnet_reply(fixture: &Fixture, seen: &Seen) -> Reply {
    let accept = seen.headers.get("accept").map(String::as_str).unwrap_or_default();
    let path = seen.path.trim_start_matches("/api/v2");
    match (seen.method.as_str(), path) {
        ("GET", "/tailnet/-/acl") if accept == "application/hujson" => reply(200, HUJSON_TEXT).with_header("ETag", ETAG),
        ("GET", "/tailnet/-/acl") => reply(200, &sloppy().to_string()).with_header("ETag", ETAG),
        ("GET", "/tailnet/-/settings") if fixture.settings_status == 200 => {
            reply(200, &json!({ "aclsExternallyManagedOn": fixture.external, "aclsExternalLink": if fixture.external { "https://github.com/acme/tailnet-policy" } else { "" } }).to_string())
        }
        ("GET", "/tailnet/-/settings") => reply(fixture.settings_status, r#"{"message":"nope"}"#),
        ("GET", "/tailnet/-/devices") if fixture.devices_status == 200 => reply(200, &json!({ "devices": [{ "tags": ["tag:prod"] }, { "tags": [] }, {}] }).to_string()),
        ("GET", "/tailnet/-/devices") => reply(fixture.devices_status, r#"{"message":"nope"}"#),
        _ => reply(404, r#"{"message":"unexpected"}"#),
    }
}

async fn loaded(fixture: Fixture) -> (PolicyView, Arc<Mutex<Vec<Seen>>>) {
    let (base, seen) = serve(move |s| tailnet_reply(&fixture, s)).await;
    let state = test_state_at(&base, std::path::PathBuf::new());
    (load(&state, TAILNET).await.unwrap(), seen)
}

#[tokio::test]
async fn load_returns_the_hujson_text_with_its_etag_and_findings_from_the_json_form() {
    let (view, seen) = loaded(Fixture::default()).await;
    assert_eq!(view.text, HUJSON_TEXT, "주석이 든 원문 그대로");
    assert_eq!(view.etag.as_deref(), Some(ETAG));
    assert!(!view.externally_managed && view.external_link.is_none());
    assert!(view.findings.iter().any(|f| f.path == "acls[0]"));
    assert!(view.findings.iter().any(|f| f.path == "tagOwners[\"tag:retired\"]"), "기기가 쓰는 태그만 빼요");
    assert!(view.findings.iter().all(|f| f.path != "tagOwners[\"tag:prod\"]"));

    let requests = api_requests(&seen);
    let accepts: BTreeSet<(String, String)> = requests.iter().map(|r| (r.path.clone(), r.headers.get("accept").cloned().unwrap_or_default())).collect();
    assert!(accepts.contains(&("/api/v2/tailnet/-/acl".into(), "application/hujson".into())));
    assert!(accepts.contains(&("/api/v2/tailnet/-/acl".into(), "application/json".into())));
    assert!(requests.iter().all(|r| r.method == "GET" && r.headers["authorization"] == "Bearer tok-all:read"));
}

#[tokio::test]
async fn externally_managed_policies_carry_their_link_and_other_schemes_are_dropped() {
    let (view, _) = loaded(Fixture { external: true, ..Fixture::default() }).await;
    assert!(view.externally_managed);
    assert_eq!(view.external_link.as_deref(), Some("https://github.com/acme/tailnet-policy"));
    assert_eq!(external_link(&json!({ "aclsExternalLink": "javascript:alert(1)" })), None);
    assert_eq!(external_link(&json!({ "aclsExternalLink": "" })), None);
}

#[tokio::test]
async fn load_still_shows_the_policy_when_settings_or_devices_cannot_be_read() {
    let (view, _) = loaded(Fixture { settings_status: 403, devices_status: 403, ..Fixture::default() }).await;
    assert_eq!(view.text, HUJSON_TEXT);
    assert!(!view.externally_managed);
    assert!(view.findings.iter().all(|f| !f.path.starts_with("tagOwners")), "기기를 못 읽으면 태그는 말하지 않아요");
}

#[tokio::test]
async fn load_fails_when_the_policy_itself_is_forbidden() {
    let (base, _) = serve(|_| reply(403, "{}")).await;
    let state = test_state_at(&base, std::path::PathBuf::new());
    assert_eq!(load(&state, TAILNET).await.unwrap_err(), AppError::other("이 자격 증명에 all:read 권한이 없어요"));
}

#[tokio::test]
async fn preview_sends_the_draft_with_an_encoded_query_and_maps_the_matches() {
    let (base, seen) = serve(|_| {
        reply(
            200,
            &json!({ "type": "user", "previewFor": "a+b@example.com", "matches": [{ "users": ["group:ops"], "ports": ["tag:prod:22"], "lineNumber": 3 }, { "users": ["*"], "ports": ["*:*"], "lineNumber": 7 }] }).to_string(),
        )
    })
    .await;
    let state = test_state_at(&base, std::path::PathBuf::new());
    let matches = preview(&state, TAILNET, PreviewKind::User, " a+b@example.com ", HUJSON_TEXT).await.unwrap();
    assert_eq!(
        matches,
        vec![
            RuleMatch { users: vec!["group:ops".into()], ports: vec!["tag:prod:22".into()], line_number: 3 },
            RuleMatch { users: vec!["*".into()], ports: vec!["*:*".into()], line_number: 7 },
        ]
    );
    let sent = &api_requests(&seen)[0];
    assert_eq!((sent.method.as_str(), sent.path.as_str()), ("POST", "/api/v2/tailnet/-/acl/preview?type=user&previewFor=a%2Bb%40example.com"));
    assert_eq!(sent.headers["content-type"], "application/hujson");
    assert_eq!(sent.body, HUJSON_TEXT);
    assert_eq!(sent.headers["authorization"], "Bearer tok-all:read");

    preview(&state, TAILNET, PreviewKind::Ipport, "100.64.0.7:22", "{}").await.unwrap();
    assert_eq!(api_requests(&seen)[1].path, "/api/v2/tailnet/-/acl/preview?type=ipport&previewFor=100.64.0.7%3A22");
}

#[tokio::test]
async fn preview_needs_a_subject_and_does_not_call_the_api_without_one() {
    let (base, seen) = serve(|_| reply(200, r#"{"matches":[]}"#)).await;
    let state = test_state_at(&base, std::path::PathBuf::new());
    assert!(preview(&state, TAILNET, PreviewKind::User, "  ", "{}").await.is_err());
    assert!(api_requests(&seen).is_empty());
}

#[tokio::test]
async fn validate_reads_empty_bodies_as_passing_and_lists_test_failures_and_warnings() {
    let state_for = |body: &'static str| async move {
        let (base, seen) = serve(move |_| reply(200, body)).await;
        (test_state_at(&base, std::path::PathBuf::new()), seen)
    };

    let (state, seen) = state_for("").await;
    assert_eq!(validate(&state, TAILNET, HUJSON_TEXT).await.unwrap(), Validation { ok: true, message: None, issues: vec![] });
    let sent = &api_requests(&seen)[0];
    assert_eq!((sent.method.as_str(), sent.path.as_str()), ("POST", "/api/v2/tailnet/-/acl/validate"));
    assert_eq!(sent.headers["content-type"], "application/hujson");
    assert_eq!(sent.headers["authorization"], "Bearer tok-all:read", "검사는 정책을 바꾸지 않아서 읽기 스코프예요");
    assert_eq!(sent.body, HUJSON_TEXT);

    let (state, _) = state_for("{}").await;
    assert!(validate(&state, TAILNET, "{}").await.unwrap().ok);

    let (state, _) = state_for(r#"{"message":"test(s) failed","data":[{"user":"user1@example.com","errors":["address \"2.2.2.2:22\": want: Drop, got: Accept"]}]}"#).await;
    let failed = validate(&state, TAILNET, "{}").await.unwrap();
    assert!(!failed.ok);
    assert_eq!(failed.message.as_deref(), Some("test(s) failed"));
    assert_eq!(failed.issues, vec![Issue { subject: Some("user1@example.com".into()), errors: vec!["address \"2.2.2.2:22\": want: Drop, got: Accept".into()], warnings: vec![] }]);

    let (state, _) = state_for(r#"{"message":"warning(s) found","data":[{"user":"group:x","warnings":["group is not syncing"]}]}"#).await;
    let warned = validate(&state, TAILNET, "{}").await.unwrap();
    assert!(warned.ok, "경고만 있으면 저장할 수 있어요");
    assert_eq!(warned.issues[0].warnings, vec!["group is not syncing"]);

    let (state, _) = state_for(r#"{"message":"something is wrong"}"#).await;
    assert!(!validate(&state, TAILNET, "{}").await.unwrap().ok);
}

#[tokio::test]
async fn validate_surfaces_the_syntax_error_the_api_rejects_with() {
    let (base, _) = serve(|_| reply(400, r#"{"message":"line 3: unexpected token"}"#)).await;
    let state = test_state_at(&base, std::path::PathBuf::new());
    assert_eq!(validate(&state, TAILNET, "{").await.unwrap_err(), AppError::other("line 3: unexpected token"));
}

fn saving(status: u16) -> impl Fn(&Seen) -> Reply + Send + Sync + 'static {
    move |_| match status {
        200 => reply(200, "{}").with_header("ETag", "\"new\""),
        412 => reply(412, r#"{"message":"precondition failed, invalid old hash"}"#),
        other => reply(other, r#"{"message":"acl tests failed"}"#),
    }
}

#[tokio::test]
async fn save_posts_the_text_with_if_match_under_the_write_scope_and_records_before_and_after() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("tailscale-changes.jsonl");
    let (base, seen) = serve(saving(200)).await;
    let state = test_state_at(&base, log.clone());

    let outcome = save(&state, TAILNET, "// 전\n{}", HUJSON_TEXT, ETAG).await.unwrap();
    assert_eq!(outcome, SaveOutcome { etag: Some("\"new\"".into()), record_error: None });

    let sent = &api_requests(&seen)[0];
    assert_eq!((sent.method.as_str(), sent.path.as_str()), ("POST", "/api/v2/tailnet/-/acl"));
    assert_eq!(sent.headers["if-match"], ETAG);
    assert_eq!(sent.headers["content-type"], "application/hujson");
    assert_eq!(sent.headers["authorization"], "Bearer tok-policy_file");
    assert_eq!(sent.body, HUJSON_TEXT);

    let entries = changes::list(&log);
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!((entry.action.as_str(), entry.tailnet.as_str()), ("policy", TAILNET));
    assert_eq!(entry.before, Value::String("// 전\n{}".into()));
    assert_eq!(entry.after, Value::String(HUJSON_TEXT.into()));
    assert!(!entry.undone && entry.undo_of.is_none());
}

#[tokio::test]
async fn save_rejected_with_412_says_the_policy_changed_elsewhere_and_records_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("tailscale-changes.jsonl");
    let (base, _) = serve(saving(412)).await;
    let state = test_state_at(&base, log.clone());
    let error = save(&state, TAILNET, "{}", "{ }", ETAG).await.unwrap_err();
    assert_eq!(error, AppError::other("다른 곳에서 정책이 바뀌었어요. 다시 불러와 주세요"));
    assert!(changes::list(&log).is_empty());
}

#[tokio::test]
async fn save_rejected_by_tests_shows_the_api_message_and_records_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("tailscale-changes.jsonl");
    let (base, _) = serve(saving(400)).await;
    let state = test_state_at(&base, log.clone());
    assert_eq!(save(&state, TAILNET, "{}", "{ }", ETAG).await.unwrap_err(), AppError::other("acl tests failed"));
    assert!(changes::list(&log).is_empty());
}

#[tokio::test]
async fn save_without_the_write_scope_names_it() {
    let (base, _) = serve(saving(403)).await;
    let state = test_state_at(&base, std::path::PathBuf::new());
    assert_eq!(save(&state, TAILNET, "{}", "{ }", ETAG).await.unwrap_err(), AppError::other("이 자격 증명에 policy_file 권한이 없어요 (acl tests failed)"));
}

#[tokio::test]
async fn a_saved_policy_stays_saved_when_the_change_log_cannot_be_written() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("blocker"), "x").unwrap();
    let (base, _) = serve(saving(200)).await;
    let state = test_state_at(&base, dir.path().join("blocker").join("tailscale-changes.jsonl"));
    let outcome = save(&state, TAILNET, "{}", "{ }", ETAG).await.unwrap();
    assert_eq!(outcome.etag.as_deref(), Some("\"new\""));
    assert!(outcome.record_error.unwrap().starts_with("정책은 저장했지만 변경 기록을 남기지 못했어요"));
}

#[tokio::test]
async fn restore_reads_the_current_etag_then_posts_the_old_text_under_the_write_scope() {
    let (base, seen) = serve(|s: &Seen| if s.method == "GET" { reply(200, HUJSON_TEXT).with_header("ETag", "\"current\"") } else { reply(200, "{}") }).await;
    let state = test_state_at(&base, std::path::PathBuf::new());
    restore(&state, TAILNET, "// 전\n{}", HUJSON_TEXT).await.unwrap();
    let requests = api_requests(&seen);
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].headers["accept"], "application/hujson");
    assert_eq!(requests[1].method, "POST");
    assert_eq!(requests[1].headers["if-match"], "\"current\"");
    assert_eq!(requests[1].headers["authorization"], "Bearer tok-policy_file");
    assert_eq!(requests[1].body, "// 전\n{}");
}

#[tokio::test]
async fn restore_refuses_when_the_policy_changed_after_the_recorded_save() {
    let (base, seen) = serve(|s: &Seen| if s.method == "GET" { reply(200, "{ \"acls\": [] }").with_header("ETag", "\"later\"") } else { reply(200, "{}") }).await;
    let state = test_state_at(&base, std::path::PathBuf::new());
    assert_eq!(restore(&state, TAILNET, "// 전\n{}", HUJSON_TEXT).await.unwrap_err(), AppError::other(CHANGED_SINCE));
    assert!(api_requests(&seen).iter().all(|r| r.method == "GET"), "덮어쓰지 않아요");
}
