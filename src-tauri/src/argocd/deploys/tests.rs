use serde_json::json;

use super::*;

#[test]
fn records_collect_every_apps_history_and_drop_entries_without_a_deploy_time() {
    let apps = json!({"items": [
        {"metadata": {"namespace": "argocd", "name": "web"}, "status": {"history": [
            {"id": 1, "revision": "aaa", "deployedAt": "2026-11-01T00:00:10Z", "deployStartedAt": "2026-11-01T00:00:00Z"},
            {"id": 2, "revision": "bbb", "deployedAt": "2026-11-02T00:00:10Z"},
            {"id": 3, "revision": "ccc"}
        ]}},
        {"metadata": {"namespace": "argocd", "name": "api"}, "status": {"history": [
            {"id": 7, "revisions": ["r1", "r2"], "deployedAt": "2026-11-03T00:00:00Z", "deployStartedAt": "2026-11-03T00:00:05Z"}
        ]}},
        {"metadata": {"namespace": "argocd", "name": "fresh"}}
    ]});
    let records = records_of(&apps);
    assert_eq!(records.len(), 3);
    let web: Vec<_> = records.iter().filter(|r| r.app == "web").collect();
    assert_eq!(web.len(), 2);
    let first = web.iter().find(|r| r.id == 1).unwrap();
    assert_eq!(
        (first.revision.as_deref(), first.started_at.as_deref(), first.deployed_at.as_deref()),
        (Some("aaa"), Some("2026-11-01T00:00:00Z"), Some("2026-11-01T00:00:10Z"))
    );
    // 소스가 여럿이면 첫 소스의 리비전
    let api = records.iter().find(|r| r.app == "api").unwrap();
    assert_eq!(api.revision.as_deref(), Some("r1"));
}
