//! Organization tailnets. The API accepts '-' for the credential's organization.
use chrono::Utc;
use reqwest::Method;
use serde_json::{json, Value};
use crate::error::AppError;
use super::{api::{Request, Scope, TailscaleState}, changes::{self, Entry, Target}};

#[cfg(test)]
mod tests;

pub async fn list(state: &TailscaleState, tailnet: &str) -> Result<Vec<Value>, AppError> {
    let mut result = Vec::new();
    let mut cursor = String::new();
    loop {
        let path = if cursor.is_empty() { "/organizations/-/tailnets".to_owned() } else {
            format!("/organizations/-/tailnets?cursor={}", reqwest::Url::parse_with_params("https://example.invalid/", &[("cursor", &cursor)]).map_err(|_| AppError::other("페이지 주소를 만들지 못했어요"))?.query().unwrap_or_default().trim_start_matches("cursor="))
        };
        let page = state.get_json(tailnet, &path).await?;
        if let Some(items) = page.get("tailnets").and_then(Value::as_array) { result.extend(items.iter().cloned()); }
        let next = page.get("cursor").and_then(Value::as_str).unwrap_or_default();
        if next.is_empty() { break; }
        if next == cursor { return Err(AppError::other("테일넷 목록의 페이지 응답이 반복됐어요")); }
        cursor = next.to_owned();
    }
    Ok(result)
}
pub async fn create(state: &TailscaleState, tailnet: &str, display_name: &str) -> Result<Value, AppError> {
    let mut result = state.request(tailnet, Request::new(Method::POST, "/organizations/-/tailnets", Scope::Write("tailnets")).json(json!({"displayName": display_name}))).await?.json()?;
    if result.get("alreadyExists").and_then(Value::as_bool) != Some(true) {
        let now = Utc::now();
        let id = result.get("id").and_then(Value::as_str).unwrap_or_default();
        let entry = Entry { id: format!("{}-tailnet", now.timestamp_nanos_opt().unwrap_or_default()), at: now.to_rfc3339(), tailnet: tailnet.into(), action: "tailnet_create".into(), target: Target { device_id: None, name: Some(display_name.into()) }, summary: "API 전용 테일넷을 만들었어요".into(), before: Value::Null, after: json!({"id": id, "displayName": display_name}), undo_of: None, undone: false };
        let logged = changes::record(state.changes_path(), &entry).is_ok();
        if let Some(object) = result.as_object_mut() { object.insert("logged".into(), json!(logged)); }
    }
    Ok(result)
}
pub async fn delete(state: &TailscaleState, tailnet: &str, id: &str, name: &str, typed: &str) -> Result<(), AppError> {
    if typed != name { return Err(AppError::other("테일넷 이름이 일치하지 않아요")); }
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b)) { return Err(AppError::other("테일넷 ID를 확인해 주세요")); }
    let path = format!("/tailnet/{id}");
    state.request_for_tailnet(tailnet, id, Request::new(Method::DELETE, &path, Scope::Write("all"))).await?;
    Ok(())
}
