//! 테일넷 기기 목록과 미리보기 기반 변경.
use super::api::{Request, Scope, TailscaleState};
use super::changes::{self, Entry, Target};
use crate::error::AppError;
use chrono::{DateTime, Duration, Utc};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

fn date(v: &Value, key: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(v.get(key)?.as_str()?)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}
pub fn findings(device: &Value, now: DateTime<Utc>) -> Vec<&'static str> {
    let mut out = Vec::new();
    if let Some(expiry) = date(device, "expires") {
        if expiry <= now {
            out.push("expired");
        } else if expiry <= now + Duration::days(30) {
            out.push("expiring");
        }
    }
    if device["keyExpiryDisabled"] == true {
        out.push("expiryDisabled");
    }
    if date(device, "lastSeen").is_some_and(|seen| seen < now - Duration::days(30)) {
        out.push("stale");
    }
    if device["os"]
        .as_str()
        .is_some_and(|os| os.eq_ignore_ascii_case("linux"))
        && device["tags"].as_array().is_none_or(Vec::is_empty)
    {
        out.push("untaggedLinux");
    }
    if device["updateAvailable"] == true {
        out.push("update");
    }
    if device["authorized"] == false {
        out.push("unauthorized");
    }
    out
}

pub async fn list(state: &TailscaleState, tailnet: &str) -> Result<Vec<Value>, AppError> {
    let result = state
        .get_json(tailnet, "/tailnet/-/devices?fields=all")
        .await?;
    let mut devices = result
        .get("devices")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| AppError::other("기기 목록을 읽지 못했어요"))?;
    let now = Utc::now();
    for device in &mut devices {
        let found = findings(device, now);
        let found = serde_json::to_value(found)
            .map_err(|_| AppError::other("기기 점검 결과를 읽지 못했어요"))?;
        if let Some(object) = device.as_object_mut() {
            object.insert("findings".into(), found);
        }
    }
    Ok(devices)
}
fn encoded(id: &str) -> String {
    let mut out = String::new();
    for b in id.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
async fn get(state: &TailscaleState, tailnet: &str, id: &str) -> Result<Value, AppError> {
    state
        .get_json(tailnet, &format!("/device/{}?fields=all", encoded(id)))
        .await
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Item {
    pub device: Value,
    pub method: String,
    pub path: String,
    pub body: Value,
    pub action: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Preview {
    pub items: Vec<Item>,
}
#[derive(Serialize)]
pub struct ResultItem {
    pub id: String,
    pub name: String,
    pub ok: bool,
    pub error: Option<String>,
}
fn request_shape(
    id: &str,
    action: &str,
    value: &Value,
) -> Result<(String, String, Value), AppError> {
    let base = format!("/device/{}", encoded(id));
    let (method, suffix, body) = match action {
        "authorize" => ("POST", "/authorized", json!({"authorized":true})),
        "tags"
            if value
                .as_array()
                .is_some_and(|v| v.iter().all(Value::is_string)) =>
        {
            ("POST", "/tags", json!({"tags":value}))
        }
        "expire" => ("POST", "/expire", Value::Null),
        "keyExpiry" if value.is_boolean() => ("POST", "/key", json!({"keyExpiryDisabled":value})),
        "name" if value.as_str().is_some_and(|s| !s.trim().is_empty()) => {
            ("POST", "/name", json!({"name":value}))
        }
        "ip" if value.as_str().and_then(|s| s.parse::<std::net::Ipv4Addr>().ok()).is_some_and(|ip| {
            let octets = ip.octets();
            octets[0] == 100 && (64..=127).contains(&octets[1])
        }) => ("POST", "/ip", json!({"ipv4": value})),
        "delete" => ("DELETE", "", Value::Null),
        "routes"
            if value
                .as_array()
                .is_some_and(|v| v.iter().all(Value::is_string)) =>
        {
            ("POST", "/routes", json!({"routes":value}))
        }
        _ => return Err(AppError::other("변경 내용을 확인해 주세요")),
    };
    Ok((method.into(), format!("{base}{suffix}"), body))
}
fn value_from_body(item: &Item) -> &Value {
    match item.action.as_str() {
        "tags" => &item.body["tags"],
        "keyExpiry" => &item.body["keyExpiryDisabled"],
        "name" => &item.body["name"],
        "ip" => &item.body["ipv4"],
        "routes" => &item.body["routes"],
        _ => &Value::Null,
    }
}
pub async fn preview(
    state: &TailscaleState,
    tailnet: &str,
    ids: Vec<String>,
    action: String,
    value: Value,
) -> Result<Preview, AppError> {
    if ids.is_empty() || (matches!(action.as_str(), "name" | "ip") && ids.len() != 1) {
        return Err(AppError::other("기기를 선택해 주세요"));
    }
    let mut items = Vec::with_capacity(ids.len());
    for id in ids {
        if items.iter().any(|item: &Item| item.device["id"] == id) {
            return Err(AppError::other("같은 기기를 두 번 선택할 수 없어요"));
        }
        let device = get(state, tailnet, &id).await?;
        if device["id"] != id {
            return Err(AppError::other("기기 ID가 일치하지 않아요"));
        }
        if action == "routes" {
            let proposed = value
                .as_array()
                .ok_or_else(|| AppError::other("경로 목록을 확인해 주세요"))?;
            if device["enabledRoutes"]
                .as_array()
                .is_some_and(|routes| routes.iter().any(|r| !proposed.contains(r)))
            {
                return Err(AppError::other(
                    "승인된 경로가 바뀌었어요. 다시 불러와 주세요",
                ));
            }
        }
        let (method, path, body) = request_shape(&id, &action, &value)?;
        items.push(Item {
            device,
            method,
            path,
            body,
            action: action.clone(),
        });
    }
    Ok(Preview { items })
}
async fn send(
    state: &TailscaleState,
    tailnet: &str,
    method: &str,
    path: &str,
    body: &Value,
    action: &str,
) -> Result<(), AppError> {
    let scope = if action == "routes" {
        "devices:routes"
    } else {
        "devices:core"
    };
    let method = if method == "DELETE" {
        Method::DELETE
    } else {
        Method::POST
    };
    let mut request = Request::new(method, path, Scope::Write(scope));
    if !body.is_null() {
        request = request.json(body.clone());
    }
    state.request(tailnet, request).await?;
    Ok(())
}
fn field(action: &str) -> Option<&'static str> {
    match action {
        "tags" => Some("tags"),
        "name" => Some("name"),
        "keyExpiry" => Some("keyExpiryDisabled"),
        "ip" => Some("ipv4"),
        _ => None,
    }
}
fn field_value(device: &Value, key: &str) -> Value {
    if key == "ipv4" {
        device["addresses"].as_array().and_then(|addresses| addresses.iter().find(|address| address.as_str().and_then(|s| s.parse::<std::net::Ipv4Addr>().ok()).is_some())).cloned().unwrap_or(Value::Null)
    } else if key == "tags" && device[key].is_null() {
        json!([])
    } else {
        device[key].clone()
    }
}
fn entry(
    tailnet: &str,
    action: &str,
    device: &Value,
    before: Value,
    after: Value,
    undo_of: Option<String>,
) -> Entry {
    let now = Utc::now();
    let summary = match action {
        "tags" => "태그를 바꿨어요",
        "name" => "이름을 바꿨어요",
        "keyExpiry" => "키 만료 설정을 바꿨어요",
        _ => "기기를 바꿨어요",
    };
    Entry {
        id: format!(
            "{}-{}",
            now.timestamp_nanos_opt().unwrap_or_default(),
            device["id"].as_str().unwrap_or("policy")
        ),
        at: now.to_rfc3339(),
        tailnet: tailnet.trim().into(),
        action: action.into(),
        target: Target {
            device_id: device["id"].as_str().map(str::to_owned),
            name: device["name"].as_str().map(str::to_owned),
        },
        summary: summary.into(),
        before,
        after,
        undo_of,
        undone: false,
    }
}
pub async fn apply(
    state: &TailscaleState,
    tailnet: &str,
    preview: Preview,
    confirm_text: Option<String>,
    path: &Path,
) -> Result<Vec<ResultItem>, AppError> {
    if preview.items.is_empty() {
        return Err(AppError::other("기기를 선택해 주세요"));
    }
    if preview.items.iter().any(|i| i.action == "delete") {
        let expected = if preview.items.len() == 1 {
            preview.items[0].device["name"]
                .as_str()
                .unwrap_or("")
                .to_owned()
        } else {
            format!("선택한 {}개", preview.items.len())
        };
        if expected.is_empty() || confirm_text.as_deref() != Some(expected.as_str()) {
            return Err(AppError::other("삭제 확인 문구가 맞지 않아요"));
        }
    }
    let mut results = Vec::new();
    for item in preview.items {
        let id = item.device["id"].as_str().unwrap_or("").to_owned();
        let name = item.device["name"].as_str().unwrap_or("").to_owned();
        let result = async {
            if id.is_empty() {
                return Err(AppError::other("기기 ID가 없어요"));
            }
            let (method, target, body) = request_shape(&id, &item.action, value_from_body(&item))?;
            if method != item.method || target != item.path || body != item.body {
                return Err(AppError::other("미리보기 내용이 바뀌었어요"));
            }
            let current = get(state, tailnet, &id).await?;
            if current != item.device {
                return Err(AppError::other("기기가 바뀌었어요. 다시 미리보기해 주세요"));
            }
            send(state, tailnet, &method, &target, &body, &item.action).await?;
            if let Some(key) = field(&item.action) {
                let after = get(state, tailnet, &id).await.map_err(|_| {
                    AppError::other("변경은 적용됐지만 변경 결과를 읽거나 기록하지 못했어요")
                })?;
                changes::record(
                    path,
                    &entry(
                        tailnet,
                        &item.action,
                        &current,
                        field_value(&current, key),
                        field_value(&after, key),
                        None,
                    ),
                )
                .map_err(|_| AppError::other("변경은 적용됐지만 변경 기록을 저장하지 못했어요"))?;
            }
            Ok::<(), AppError>(())
        }
        .await;
        results.push(ResultItem {
            id,
            name,
            ok: result.is_ok(),
            error: result.err().map(|e| e.to_string()),
        });
    }
    Ok(results)
}
pub async fn undo(
    state: &TailscaleState,
    tailnet: &str,
    id: &str,
    path: &Path,
) -> Result<(), AppError> {
    let tailnet = tailnet.trim();
    let entries = changes::list(path);
    let original = entries
        .iter()
        .find(|e| e.id == id && e.tailnet == tailnet)
        .cloned()
        .ok_or_else(|| AppError::other("변경 기록을 찾지 못했어요"))?;
    if original.undone
        || original.undo_of.is_some()
        || entries
            .iter()
            .any(|e| e.tailnet == tailnet && e.undo_of.as_deref() == Some(id))
    {
        return Err(AppError::other("이미 되돌린 변경이에요"));
    }
    if matches!(original.action.as_str(), "localPreference" | "lockTrustedKey" | "shareConfig" | "serviceConfig") {
        super::local::undo(&original).await?;
    } else if original.action == "policy" {
        let text = original
            .before
            .as_str()
            .ok_or_else(|| AppError::other("정책 기록을 읽지 못했어요"))?;
        let expected = original
            .after
            .as_str()
            .ok_or_else(|| AppError::other("정책 기록을 읽지 못했어요"))?;
        super::policy::restore(state, tailnet, text, expected).await?;
    } else if original.action == "attributes" {
        let nodes = original.after["nodes"].as_object().ok_or_else(|| AppError::other("속성 기록을 읽지 못했어요"))?;
        let mut restore = serde_json::Map::new();
        for (device_id, attrs) in nodes {
            let current = extra_list(state, tailnet, device_id, false).await?;
            let mut restored = serde_json::Map::new();
            for (key, applied) in attrs.as_object().ok_or_else(|| AppError::other("속성 기록을 읽지 못했어요"))? {
                let actual = current["attributes"].get(key);
                if actual != applied.get("value") || current["expiries"].get(key) != applied.get("expiry") {
                    return Err(AppError::other("속성이 바뀌었어요. 변경을 되돌릴 수 없어요"));
                }
                let old = original.before[device_id]["attributes"].get(key);
                let value = match old {
                    Some(value) => {
                        let mut config = json!({"value": value});
                        if let Some(expiry) = original.before[device_id]["expiries"].get(key) { config["expiry"] = expiry.clone(); }
                        config
                    }
                    None => Value::Null,
                };
                restored.insert(key.clone(), value);
            }
            restore.insert(device_id.clone(), Value::Object(restored));
        }
        state.request(tailnet, Request::new(Method::PATCH, "/tailnet/-/device-attributes", Scope::Write("devices:posture_attributes")).json(json!({"nodes": restore}))).await?;
    } else {
        let key =
            field(&original.action).ok_or_else(|| AppError::other("되돌릴 수 없는 변경이에요"))?;
        let device_id = original
            .target
            .device_id
            .as_deref()
            .ok_or_else(|| AppError::other("기기 ID가 없어요"))?;
        let current = get(state, tailnet, device_id).await?;
        if field_value(&current, key) != original.after {
            return Err(AppError::other(
                "기기가 바뀌었어요. 변경을 되돌릴 수 없어요",
            ));
        }
        let (method, target, body) = request_shape(device_id, &original.action, &original.before)?;
        send(state, tailnet, &method, &target, &body, &original.action).await?;
    }
    let mut reversed = original.clone();
    let now = Utc::now();
    reversed.id = format!("{}-undo", now.timestamp_nanos_opt().unwrap_or_default());
    reversed.at = now.to_rfc3339();
    std::mem::swap(&mut reversed.before, &mut reversed.after);
    reversed.undo_of = Some(original.id.clone());
    changes::record(path, &reversed)
        .map_err(|_| AppError::other("되돌렸지만 변경 기록을 저장하지 못했어요"))?;
    changes::mark_undone(path, &original.id)
        .map_err(|_| AppError::other("되돌렸지만 기록에 표시하지 못했어요"))?;
    Ok(())
}

/// 기기 포스처 또는 공유 초대 목록을 읽는다.
pub async fn extra_list(state: &TailscaleState, tailnet: &str, id: &str, invites: bool) -> Result<Value, AppError> {
    let path = format!("/device/{}/{}", encoded(id), if invites { "device-invites" } else { "attributes" });
    state.get_json(tailnet, &path).await
}

/// 포스처 일괄 변경과 공유 초대 작업.
pub async fn extra_apply(state: &TailscaleState, tailnet: &str, action: &str, id: &str, body: Value, before: Value) -> Result<Value, AppError> {
    let (method, path, scope, payload) = match action {
        "attributes" => {
            let nodes = body.get("nodes").and_then(Value::as_object).ok_or_else(|| AppError::other("속성을 확인해 주세요"))?;
            if nodes.is_empty() || nodes.values().any(|attrs| attrs.as_object().is_none_or(|attrs| attrs.is_empty() || attrs.keys().any(|key| !key.starts_with("custom:") || key.len() == 7))) {
                return Err(AppError::other("custom: 속성을 확인해 주세요"));
            }
            for device_id in nodes.keys() {
                if extra_list(state, tailnet, device_id, false).await? != before[device_id] {
                    return Err(AppError::other("속성이 바뀌었어요. 다시 불러와 주세요"));
                }
            }
            (Method::PATCH, "/tailnet/-/device-attributes".to_owned(), "devices:posture_attributes", Some(body.clone()))
        }
        "createInvite" => (Method::POST, format!("/device/{}/device-invites", encoded(id)), "device_invites", Some(json!([body]))),
        "resendInvite" => (Method::POST, format!("/device-invites/{}/resend", encoded(id)), "device_invites", None),
        "deleteInvite" => (Method::DELETE, format!("/device-invites/{}", encoded(id)), "device_invites", None),
        _ => return Err(AppError::other("알 수 없는 작업이에요")),
    };
    let mut request = Request::new(method, &path, Scope::Write(scope));
    if let Some(payload) = payload { request = request.json(payload); }
    let response = state.request(tailnet, request).await?;
    let device = json!({"id": id, "name": id});
    changes::record(state.changes_path(), &entry(tailnet, action, &device, before, body, None))
        .map_err(|_| AppError::other("변경은 적용됐지만 변경 기록을 저장하지 못했어요"))?;
    Ok(serde_json::from_str(&response.body).unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests;
