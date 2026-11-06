//! 테일넷 설정과 연락처.
use reqwest::Method;
use serde_json::{json, Value};
use super::api::{Request, Scope, TailscaleState};
use super::changes::{self, Entry, Target};
use crate::error::AppError;

const SETTINGS: &str = "/tailnet/-/settings";
const CONTACTS: &str = "/tailnet/-/contacts";

pub async fn load(state: &TailscaleState, tailnet: &str, contacts: bool) -> Result<Value, AppError> {
    state.get_json(tailnet, if contacts { CONTACTS } else { SETTINGS }).await
}

fn record(state: &TailscaleState, tailnet: &str, action: &str, before: Value, after: Value) -> Option<String> {
    let at = crate::iam::clock::now_secs();
    let entry = Entry {
        id: format!("{action}-{at}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos())),
        at: crate::iam::clock::iso(at), tailnet: tailnet.trim().into(), action: action.into(),
        target: Target { device_id: None, name: Some(action.into()) }, summary: action.into(), before, after, undo_of: None, undone: false,
    };
    changes::record(state.changes_path(), &entry).err().map(|e| format!("변경 기록을 남기지 못했어요: {e}"))
}

pub async fn save_field(state: &TailscaleState, tailnet: &str, field: &str, before: Value, after: Value) -> Result<Option<String>, AppError> {
    let scope = match field {
        "aclsExternallyManagedOn" | "aclsExternalLink" => "policy_file",
        "networkFlowLoggingOn" => "logs:network",
        "httpsEnabled" => "networking_settings",
        "adminConsoleSessionTimeoutMinutes" | "devicesApprovalOn" | "devicesAutoUpdatesOn" | "devicesKeyDurationDays" | "usersApprovalOn" | "usersRoleAllowedToJoinExternalTailnets" | "routeSelection" | "postureIdentityCollectionOn" => "feature_settings",
        _ => return Err(AppError::other("바꿀 수 없는 설정이에요")),
    };
    let current = load(state, tailnet, false).await?;
    if current.get(field) != Some(&before) { return Err(AppError::other("설정이 바뀌었어요. 다시 불러와 주세요")); }
    state.request(tailnet, Request::new(Method::PATCH, SETTINGS, Scope::Write(scope)).json(json!({(field): after.clone()}))).await?;
    Ok(record(state, tailnet, &format!("settings:{field}"), before, after))
}

pub async fn contact(state: &TailscaleState, tailnet: &str, kind: &str, before: Value, email: Option<String>) -> Result<Option<String>, AppError> {
    if !matches!(kind, "account" | "support" | "security") { return Err(AppError::other("알 수 없는 연락처예요")); }
    let path = format!("{CONTACTS}/{kind}");
    match email {
        Some(email) => {
            let current = load(state, tailnet, true).await?;
            if current.get(kind).cloned().unwrap_or(Value::Null) != before { return Err(AppError::other("연락처가 바뀌었어요. 다시 불러와 주세요")); }
            state.request(tailnet, Request::new(Method::PATCH, &path, Scope::Write("account_settings")).json(json!({"email": email}))).await?;
            Ok(record(state, tailnet, &format!("contact:{kind}"), before, json!({"email": email})))
        }
        None => {
            let path = format!("{path}/resend-verification-email");
            state.request(tailnet, Request::new(Method::POST, &path, Scope::Write("account_settings"))).await?;
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tailscale::api::testing::{self, TAILNET};

    #[tokio::test]
    async fn settings_patch_only_the_changed_field_with_its_scope() {
        let (base, seen) = testing::serve(|_| testing::reply(200, r#"{"networkFlowLoggingOn":false}"#)).await;
        let dir = tempfile::tempdir().unwrap();
        let state = testing::test_state_at(&base, dir.path().join("changes.jsonl"));
        save_field(&state, TAILNET, "networkFlowLoggingOn", json!(false), json!(true)).await.unwrap();
        let calls = testing::api_requests(&seen);
        let write = calls.iter().find(|r| r.method == "PATCH").unwrap();
        assert_eq!(serde_json::from_str::<Value>(&write.body).unwrap(), json!({"networkFlowLoggingOn":true}));
        assert!(write.headers.get("authorization").is_some_and(|v| v.contains("logs:network")));
    }
}
