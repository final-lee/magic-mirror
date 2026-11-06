//! 전체 DNS 구성 읽기와 안전한 교체.
use reqwest::Method;
use serde_json::Value;
use super::api::{Request, Scope, TailscaleState};
use super::changes::{self, Entry, Target};
use crate::error::AppError;

const PATH: &str = "/tailnet/-/dns/configuration";

pub async fn load(state: &TailscaleState, tailnet: &str) -> Result<Value, AppError> {
    state.get_json(tailnet, PATH).await
}

pub async fn save(state: &TailscaleState, tailnet: &str, before: Value, after: Value) -> Result<Option<String>, AppError> {
    if !after.is_object() { return Err(AppError::other("DNS 구성은 객체여야 해요")); }
    if load(state, tailnet).await? != before { return Err(AppError::other("DNS 구성이 바뀌었어요. 다시 불러와 주세요")); }
    state.request(tailnet, Request::new(Method::POST, PATH, Scope::Write("dns")).json(after.clone())).await?;
    Ok(record(state, tailnet, "dns", before, after))
}

fn record(state: &TailscaleState, tailnet: &str, action: &str, before: Value, after: Value) -> Option<String> {
    let at = crate::iam::clock::now_secs();
    let entry = Entry {
        id: format!("dns-{at}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos())),
        at: crate::iam::clock::iso(at), tailnet: tailnet.trim().into(), action: action.into(),
        target: Target { device_id: None, name: Some("DNS".into()) }, summary: "DNS 구성 변경".into(),
        before, after, undo_of: None, undone: false,
    };
    changes::record(state.changes_path(), &entry).err().map(|e| format!("변경 기록을 남기지 못했어요: {e}"))
}

/// Split DNS의 주소는 전용 PATCH로 바꾸고, resolver 옵션은 전체 구성 API로 보존한다.
pub async fn save_split(state: &TailscaleState, tailnet: &str, before: Value, after: Value, patch: Value) -> Result<Option<String>, AppError> {
    if !after.is_object() || !patch.is_object() { return Err(AppError::other("DNS 구성을 확인해 주세요")); }
    if load(state, tailnet).await? != before { return Err(AppError::other("DNS 구성이 바뀌었어요. 다시 불러와 주세요")); }
    let mut before_other = before.as_object().cloned().ok_or_else(|| AppError::other("DNS 구성을 확인해 주세요"))?;
    let mut after_other = after.as_object().cloned().ok_or_else(|| AppError::other("DNS 구성을 확인해 주세요"))?;
    before_other.remove("splitDNS");
    after_other.remove("splitDNS");
    if before_other != after_other { return Err(AppError::other("Split DNS 외의 설정이 바뀌었어요")); }
    let empty = serde_json::Map::new();
    let before_split = before.get("splitDNS").and_then(Value::as_object).unwrap_or(&empty);
    let after_split = after.get("splitDNS").and_then(Value::as_object).unwrap_or(&empty);
    let mut expected = serde_json::Map::new();
    for key in before_split.keys().chain(after_split.keys()) {
        if before_split.get(key) == after_split.get(key) { continue; }
        let addresses = match after_split.get(key) {
            None | Some(Value::Null) => Value::Null,
            Some(Value::Array(resolvers)) => {
                let mut addresses = Vec::with_capacity(resolvers.len());
                for resolver in resolvers {
                    addresses.push(Value::String(resolver.get("address").and_then(Value::as_str)
                        .ok_or_else(|| AppError::other("네임서버 주소를 확인해 주세요"))?.to_owned()));
                }
                Value::Array(addresses)
            }
            _ => return Err(AppError::other("네임서버 목록을 확인해 주세요")),
        };
        expected.insert(key.clone(), addresses);
    }
    if patch != Value::Object(expected) { return Err(AppError::other("미리보기 내용이 바뀌었어요")); }
    state.request(tailnet, Request::new(Method::PATCH, "/tailnet/-/dns/split-dns", Scope::Write("dns")).json(patch)).await?;
    if let Err(error) = state.request(tailnet, Request::new(Method::POST, PATH, Scope::Write("dns")).json(after.clone())).await {
        let _ = record(state, tailnet, "dns:split-partial", before, after);
        return Err(AppError::other(format!("Split DNS 주소는 바뀌었지만 resolver 옵션 적용에 실패했어요: {error}")));
    }
    Ok(record(state, tailnet, "dns:split", before, after))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tailscale::api::testing::{self, TAILNET};
    use serde_json::json;

    #[tokio::test]
    async fn dns_save_rechecks_and_posts_full_configuration() {
        let before = json!({"nameservers": [], "splitDNS": {}, "searchPaths": [], "preferences": {"magicDNS": false}});
        let after = json!({"nameservers": [{"address": "1.1.1.1"}], "splitDNS": {}, "searchPaths": [], "preferences": {"magicDNS": true}});
        let snapshot = before.clone();
        let (base, seen) = testing::serve(move |_| testing::reply(200, &snapshot.to_string())).await;
        let dir = tempfile::tempdir().unwrap();
        let state = testing::test_state_at(&base, dir.path().join("changes.jsonl"));
        save(&state, TAILNET, before, after.clone()).await.unwrap();
        let calls = testing::api_requests(&seen);
        let write = calls.iter().find(|r| r.method == "POST").unwrap();
        assert!(write.path.ends_with("/tailnet/-/dns/configuration"));
        assert_eq!(serde_json::from_str::<Value>(&write.body).unwrap(), after);
        assert!(write.headers.get("authorization").is_some_and(|v| v.contains("dns")));
    }

    #[tokio::test]
    async fn split_patch_and_configuration_preserve_resolver_options() {
        let before = json!({"splitDNS":{"corp.test":[{"address":"10.0.0.1","useWithExitNode":false}]}});
        let after = json!({"splitDNS":{"corp.test":[{"address":"10.0.0.2","useWithExitNode":true}]}});
        let snapshot = before.clone();
        let (base, seen) = testing::serve(move |_| testing::reply(200, &snapshot.to_string())).await;
        let dir = tempfile::tempdir().unwrap();
        let state = testing::test_state_at(&base, dir.path().join("changes.jsonl"));
        save_split(&state, TAILNET, before, after.clone(), json!({"corp.test":["10.0.0.2"]})).await.unwrap();
        let calls = testing::api_requests(&seen);
        let writes: Vec<_> = calls.iter().filter(|request| request.method != "GET").collect();
        assert_eq!(writes.len(), 2);
        assert_eq!(writes[0].method, "PATCH");
        assert!(writes[0].path.ends_with("/tailnet/-/dns/split-dns"));
        assert_eq!(serde_json::from_str::<Value>(&writes[0].body).unwrap(), json!({"corp.test":["10.0.0.2"]}));
        assert_eq!(writes[1].method, "POST");
        assert_eq!(serde_json::from_str::<Value>(&writes[1].body).unwrap(), after);
        assert!(writes.iter().all(|request| request.headers.get("authorization").is_some_and(|v| v.contains("dns"))));
    }
}
