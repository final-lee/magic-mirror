//! 사용자와 초대 관리.
use reqwest::Method;
use serde_json::{json, Value};
use super::api::{Request, Scope, TailscaleState};
use super::changes::{self, Entry, Target};
use crate::error::AppError;

pub async fn list(state: &TailscaleState, tailnet: &str, invites: bool) -> Result<Value, AppError> {
    state.get_json(tailnet, if invites { "/tailnet/-/user-invites" } else { "/tailnet/-/users?type=all" }).await
}

pub async fn apply(state: &TailscaleState, tailnet: &str, action: &str, id: &str, value: Value, before: Value, typed: &str) -> Result<Value, AppError> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') { return Err(AppError::other("잘못된 ID예요")); }
    let (method, path, body) = match action {
        "createInvite" => (Method::POST, "/tailnet/-/user-invites".to_owned(), Some(json!([value]))),
        "resendInvite" => (Method::POST, format!("/user-invites/{id}/resend"), None),
        "deleteInvite" => {
            if id.is_empty() || typed != id { return Err(AppError::other("초대 ID가 일치하지 않아요")); }
            (Method::DELETE, format!("/user-invites/{id}"), None)
        },
        "role" | "approve" | "suspend" | "restore" | "delete" => {
            let current = state.get_json(tailnet, &format!("/users/{id}")).await?;
            if current != before { return Err(AppError::other("사용자가 바뀌었어요. 다시 불러와 주세요")); }
            if action == "delete" || (action == "role" && value == "owner") {
                let name = current.get("loginName").and_then(Value::as_str).filter(|name| !name.is_empty()).ok_or_else(|| AppError::other("사용자 이름을 읽지 못했어요"))?;
                if typed != name { return Err(AppError::other("사용자 이름이 일치하지 않아요")); }
            }
            (Method::POST, format!("/users/{id}/{action}"), (action == "role").then(|| json!({"role": value})))
        }
        _ => return Err(AppError::other("알 수 없는 작업이에요")),
    };
    let mut request = Request::new(method, &path, Scope::Write("users"));
    if let Some(body) = body { request = request.json(body); }
    let response = state.request(tailnet, request).await?;
    let at = crate::iam::clock::now_secs();
    let entry = Entry { id: format!("users-{at}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos())), at: crate::iam::clock::iso(at), tailnet: tailnet.trim().into(), action: format!("user:{action}"), target: Target { device_id: None, name: Some(id.into()) }, summary: action.into(), before, after: value, undo_of: None, undone: false };
    changes::record(state.changes_path(), &entry).map_err(|e| AppError::other(format!("적용했지만 변경 기록을 남기지 못했어요: {e}")))?;
    Ok(serde_json::from_str(&response.body).unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tailscale::api::testing::{self, TAILNET};

    #[tokio::test]
    async fn owner_transfer_requires_name_and_users_scope() {
        let user = json!({"id":"u1","loginName":"user@example.com","role":"member"});
        let snapshot = user.clone();
        let (base, seen) = testing::serve(move |_| testing::reply(200, &snapshot.to_string())).await;
        let dir = tempfile::tempdir().unwrap();
        let state = testing::test_state_at(&base, dir.path().join("changes.jsonl"));
        assert!(apply(&state, TAILNET, "role", "u1", json!("owner"), user.clone(), "wrong").await.is_err());
        assert!(!testing::api_requests(&seen).iter().any(|r| r.method == "POST"));
        apply(&state, TAILNET, "role", "u1", json!("owner"), user, "user@example.com").await.unwrap();
        let calls = testing::api_requests(&seen);
        let write = calls.iter().find(|r| r.method == "POST").unwrap();
        assert!(write.path.ends_with("/users/u1/role"));
        assert_eq!(serde_json::from_str::<Value>(&write.body).unwrap(), json!({"role":"owner"}));
        assert!(write.headers.get("authorization").is_some_and(|v| v.contains("users")));
    }
}
