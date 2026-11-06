//! Tailscale VIP Services and host approvals.
use chrono::Utc;
use reqwest::Method;
use serde_json::{json, Value};
use crate::error::AppError;
use super::{api::{Request, Scope, TailscaleState}, changes::{self, Entry, Target}};

#[cfg(test)]
mod tests;

fn segment(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { out.push(b as char); }
        else { use std::fmt::Write; let _ = write!(out, "%{b:02X}"); }
    }
    out
}
fn service_path(name: &str) -> String { format!("/tailnet/-/services/{}", segment(name)) }
fn host_path(name: &str, device: &str) -> String { format!("{}/device/{}/approved", service_path(name), segment(device)) }

pub async fn list(state: &TailscaleState, tailnet: &str) -> Result<Value, AppError> {
    let value = state.get_json(tailnet, "/tailnet/-/services").await?;
    Ok(value.get("vipServices").filter(|v| v.is_array()).cloned().unwrap_or_else(|| json!([])))
}
pub async fn hosts(state: &TailscaleState, tailnet: &str, name: &str) -> Result<Value, AppError> {
    let path = format!("{}/devices", service_path(name));
    let value = state.request(tailnet, Request::new(Method::GET, &path, Scope::Write("services devices:core"))).await?.json()?;
    Ok(value.get("hosts").filter(|v| v.is_array()).cloned().unwrap_or_else(|| json!([])))
}
pub async fn approval(state: &TailscaleState, tailnet: &str, name: &str, device: &str) -> Result<Value, AppError> {
    let path = host_path(name, device);
    state.request(tailnet, Request::new(Method::GET, &path, Scope::Write("services devices:core"))).await?.json()
}
fn record(state: &TailscaleState, tailnet: &str, action: &str, name: &str, device: Option<&str>, before: Value, after: Value) -> Result<(), AppError> {
    let now = Utc::now();
    let entry = Entry { id: format!("{}-service", now.timestamp_nanos_opt().unwrap_or_default()), at: now.to_rfc3339(), tailnet: tailnet.trim().into(), action: action.into(), target: Target { name: Some(name.into()), device_id: device.map(str::to_owned) }, summary: "Service 설정을 바꿨어요".into(), before, after, undo_of: None, undone: false };
    changes::record(state.changes_path(), &entry).map_err(|_| AppError::other("변경 기록을 저장하지 못했어요"))
}
pub async fn put(state: &TailscaleState, tailnet: &str, name: &str, body: Value, before: Option<Value>) -> Result<(), AppError> {
    let path = service_path(name);
    state.request(tailnet, Request::new(Method::PUT, &path, Scope::Write("services")).json(body.clone())).await?;
    record(state, tailnet, "service", name, None, before.unwrap_or(Value::Null), body)
}
pub async fn delete(state: &TailscaleState, tailnet: &str, name: &str, typed: &str, before: Value) -> Result<(), AppError> {
    if typed != name { return Err(AppError::other("Service 이름이 일치하지 않아요")); }
    let path = service_path(name);
    state.request(tailnet, Request::new(Method::DELETE, &path, Scope::Write("services"))).await?;
    record(state, tailnet, "service", name, None, before, Value::Null)
}
pub async fn set_approval(state: &TailscaleState, tailnet: &str, name: &str, device: &str, approved: bool) -> Result<(), AppError> {
    let before = approval(state, tailnet, name, device).await?;
    let body = json!({"approved": approved});
    let path = host_path(name, device);
    state.request(tailnet, Request::new(Method::POST, &path, Scope::Write("services devices:core")).json(body.clone())).await?;
    record(state, tailnet, "serviceApproval", name, Some(device), before, body)
}
