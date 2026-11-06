//! Integration endpoints. Only explicitly supported operations are exposed to the UI.
use chrono::Utc;
use reqwest::Method;
use serde_json::{json, Value};
use crate::error::AppError;
use super::{api::{Request, Scope, TailscaleState}, changes::{self, Entry, Target}};

#[cfg(test)]
mod tests;

fn segment(value: &str) -> String {
    let mut output = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { output.push(b as char); }
        else { use std::fmt::Write; let _ = write!(output, "%{b:02X}"); }
    }
    output
}
fn route(action: &str, id: &str, body: &Value) -> Result<(Method, String, &'static str), AppError> {
    let id = segment(id);
    let (method, path, scope) = match action {
        "webhookList" => (Method::GET, "/tailnet/-/webhooks".into(), "all:read"),
        "webhookCreate" => (Method::POST, "/tailnet/-/webhooks".into(), "webhooks"),
        "webhookUpdate" => (Method::PATCH, format!("/webhooks/{id}"), "webhooks"),
        "webhookDelete" => (Method::DELETE, format!("/webhooks/{id}"), "webhooks"),
        "webhookTest" => (Method::POST, format!("/webhooks/{id}/test"), "webhooks"),
        "webhookRotate" => (Method::POST, format!("/webhooks/{id}/rotate"), "webhooks"),
        "postureList" => (Method::GET, "/tailnet/-/posture/integrations".into(), "all:read"),
        "postureCreate" => (Method::POST, "/tailnet/-/posture/integrations".into(), "feature_settings"),
        "postureUpdate" => (Method::PATCH, format!("/posture/integrations/{id}"), "feature_settings"),
        "postureDelete" => (Method::DELETE, format!("/posture/integrations/{id}"), "feature_settings"),
        "appList" => (Method::GET, "/tailnet/-/oauth-apps".into(), "all:read"),
        "appCreate" => (Method::POST, "/tailnet/-/oauth-apps".into(), if body.get("allowedNodeAttributes").is_some() { "oauth_apps devices:posture_attributes" } else { "oauth_apps" }),
        "appUpdate" => (Method::PUT, format!("/tailnet/-/oauth-apps/{id}"), "oauth_apps"),
        "appDelete" => (Method::DELETE, format!("/tailnet/-/oauth-apps/{id}"), "oauth_apps"),
        "streamGet" | "streamPut" | "streamPutPrivate" | "streamDelete" if id == "configuration" || id == "network" => (match action { "streamGet" => Method::GET, "streamPut" | "streamPutPrivate" => Method::PUT, _ => Method::DELETE }, format!("/tailnet/-/logging/{id}/stream"), match action { "streamGet" => "all:read", "streamPutPrivate" => "log_streaming device_invites policy_file", _ => "log_streaming" }),
        "externalCreate" => (Method::POST, "/tailnet/-/aws-external-id".into(), "log_streaming"),
        "externalValidate" => (Method::POST, format!("/tailnet/-/aws-external-id/{id}/validate-aws-trust-policy"), "log_streaming"),
        _ => return Err(AppError::other("연동 작업을 확인해 주세요")),
    };
    Ok((method, path, scope))
}
fn redact(value: &mut Value) {
    match value {
        Value::Object(map) => for (key, value) in map.iter_mut() {
            let lower = key.to_ascii_lowercase();
            if lower.contains("secret") || lower.contains("token") || lower.contains("password") || lower.contains("credentials") || lower == "url" || lower == "endpointurl" || lower == "status" {
                *value = json!("[REDACTED]");
            } else {
                redact(value);
            }
        },
        Value::Array(values) => for value in values { redact(value); },
        _ => (),
    }
}
pub async fn call(state: &TailscaleState, tailnet: &str, action: &str, id: &str, body: Value, before: Value, typed: &str) -> Result<Value, AppError> {
    if matches!(action, "webhookDelete" | "postureDelete" | "appDelete") && typed != id { return Err(AppError::other("확인 입력이 ID와 달라요")); }
    let (method, path, scope) = route(action, id, &body)?;
    let write = method != Method::GET;
    let mut request = Request::new(method, &path, if write { Scope::Write(scope) } else { Scope::Read });
    if !body.is_null() { request = request.json(body.clone()); }
    if action == "streamGet" { request = request.allow_not_found(); }
    let response = state.request(tailnet, request).await?;
    let result = if response.body.trim().is_empty() || response.status == 404 { Value::Null } else { response.json()? };
    let created = matches!(action, "webhookCreate" | "postureCreate" | "appCreate");
    if created || matches!(action, "webhookUpdate" | "postureUpdate" | "appUpdate" | "streamPut" | "streamPutPrivate" | "streamDelete") {
        let mut safe_before = before;
        let mut safe_after = body;
        redact(&mut safe_before);
        redact(&mut safe_after);
        let now = Utc::now();
        let created_id = if action == "webhookCreate" { result.get("endpointId") } else { result.get("id") };
        let target = created_id.and_then(Value::as_str).unwrap_or(id);
        let entry = Entry { id: format!("{}-integration", now.timestamp_nanos_opt().unwrap_or_default()), at: now.to_rfc3339(), tailnet: tailnet.into(), action: action.into(), target: Target { device_id: None, name: Some(target.into()) }, summary: "연동 설정을 바꿨어요".into(), before: safe_before, after: safe_after, undo_of: None, undone: false };
        let logged = changes::record(state.changes_path(), &entry);
        if !created { logged.map_err(|_| AppError::other("변경 기록을 저장하지 못했어요"))?; }
    }
    Ok(result)
}
