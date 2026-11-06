use tauri::State;

use crate::error::AppError;
use crate::tailscale::{self, ApiConnection, ApiStatus, Credential, Diagnosis, TailscaleState, TsNode};

#[tauri::command]
pub async fn tailscale_node() -> Result<TsNode, AppError> {
    tailscale::node().await
}

#[tauri::command]
pub async fn tailscale_diagnose(url: String) -> Result<Diagnosis, AppError> {
    tailscale::diagnose(url).await
}

#[tauri::command]
pub async fn tailscale_diagnostic_tool(kind: String, value: String, record_type: String) -> Result<String, AppError> {
    tailscale::diagnostic_tool(&kind, &value, &record_type).await
}

#[tauri::command]
pub async fn tailscale_local_read(kind: String) -> Result<String, AppError> {
    tailscale::local::read(&kind).await
}

#[tauri::command]
pub async fn tailscale_local_apply(state: State<'_, TailscaleState>, kind: String, value: String, tailnet: String) -> Result<String, AppError> {
    tailscale::local::apply(&state, &kind, &value, &tailnet).await
}

#[tauri::command]
pub async fn tailscale_lock_history() -> Result<String, AppError> {
    tailscale::local::lock_history().await
}

#[tauri::command]
pub async fn tailscale_lock_init(keys: Vec<String>, count: u32) -> Result<String, AppError> {
    tailscale::local::lock_init(keys, count).await
}

#[tauri::command]
pub async fn tailscale_lock_change(state: State<'_, TailscaleState>, kind: String, value: String) -> Result<String, AppError> {
    tailscale::local::lock_change(&state, &kind, &value).await
}

#[tauri::command]
pub async fn tailscale_share_read(kind: String) -> Result<String, AppError> {
    tailscale::local::share_read(&kind).await
}

#[tauri::command]
pub fn tailscale_share_preview(request: tailscale::local::ShareRequest) -> Result<Vec<String>, AppError> {
    tailscale::local::share_preview(&request)
}

#[tauri::command]
pub async fn tailscale_share_apply(state: State<'_, TailscaleState>, request: tailscale::local::ShareRequest) -> Result<String, AppError> {
    tailscale::local::share_apply(&state, &request).await
}

#[tauri::command]
pub async fn tailscale_pick_files(app: tauri::AppHandle) -> Result<Option<Vec<String>>, AppError> {
    tailscale::local::pick_files(app).await
}

#[tauri::command]
pub async fn tailscale_pick_folder(app: tauri::AppHandle) -> Result<Option<String>, AppError> {
    tailscale::local::pick_folder(app).await
}

#[tauri::command]
pub async fn tailscale_accept_routes(enabled: bool) -> Result<(), AppError> {
    tailscale::accept_routes(enabled).await
}

/// 테일넷의 API 자격 증명이 키체인에 있는지와 종류.
#[tauri::command]
pub async fn tailscale_api_status(state: State<'_, TailscaleState>, tailnet: Option<String>) -> Result<ApiStatus, AppError> {
    state.status(tailnet.as_deref()).await
}

/// 자격 증명으로 기기 목록을 읽어 확인한 뒤 키체인에 저장한다.
#[tauri::command]
pub async fn tailscale_api_connect(state: State<'_, TailscaleState>, tailnet: String, credential: Credential) -> Result<ApiConnection, AppError> {
    state.connect(&tailnet, credential).await
}

/// 키체인 항목과 캐시를 지운다.
#[tauri::command]
pub async fn tailscale_api_forget(state: State<'_, TailscaleState>, tailnet: String) -> Result<(), AppError> {
    state.forget(&tailnet).await
}

#[tauri::command]
pub async fn tailscale_devices(state: State<'_, TailscaleState>, tailnet: String) -> Result<Vec<serde_json::Value>, AppError> {
    tailscale::devices::list(&state, &tailnet).await
}

#[tauri::command]
pub async fn tailscale_device_preview(state: State<'_, TailscaleState>, tailnet: String, ids: Vec<String>, action: String, value: serde_json::Value) -> Result<tailscale::devices::Preview, AppError> {
    tailscale::devices::preview(&state, &tailnet, ids, action, value).await
}

#[tauri::command]
pub async fn tailscale_device_apply(state: State<'_, TailscaleState>, tailnet: String, preview: tailscale::devices::Preview, confirm_text: Option<String>) -> Result<Vec<tailscale::devices::ResultItem>, AppError> {
    tailscale::devices::apply(&state, &tailnet, preview, confirm_text, state.changes_path()).await
}

#[tauri::command]
pub async fn tailscale_changes(state: State<'_, TailscaleState>, tailnet: String) -> Result<Vec<tailscale::changes::Entry>, AppError> {
    Ok(tailscale::changes::list(state.changes_path()).into_iter().filter(|entry| entry.tailnet == tailnet.trim()).rev().collect())
}

#[tauri::command]
pub async fn tailscale_undo(state: State<'_, TailscaleState>, tailnet: String, id: String) -> Result<(), AppError> {
    tailscale::devices::undo(&state, &tailnet, &id, state.changes_path()).await
}

/// 정책 원문(HuJSON)·ETag·지적.
#[tauri::command]
pub async fn tailscale_policy(state: State<'_, TailscaleState>, tailnet: String) -> Result<tailscale::policy::PolicyView, AppError> {
    tailscale::policy::load(&state, &tailnet).await
}

/// 편집 중인 정책으로 이 사용자(`user`)·주소(`ipport`)에 맞는 규칙을 본다. 저장하지 않는다.
#[tauri::command]
pub async fn tailscale_policy_preview(state: State<'_, TailscaleState>, tailnet: String, kind: tailscale::policy::PreviewKind, subject: String, text: String) -> Result<Vec<tailscale::policy::RuleMatch>, AppError> {
    tailscale::policy::preview(&state, &tailnet, kind, &subject, &text).await
}

/// 편집한 정책을 저장하지 않고 검사한다.
#[tauri::command]
pub async fn tailscale_policy_validate(state: State<'_, TailscaleState>, tailnet: String, text: String) -> Result<tailscale::policy::Validation, AppError> {
    tailscale::policy::validate(&state, &tailnet, &text).await
}

/// 정책을 저장하고 변경 기록에 남긴다.
#[tauri::command]
pub async fn tailscale_policy_save(state: State<'_, TailscaleState>, tailnet: String, before: String, after: String, etag: String) -> Result<tailscale::policy::SaveOutcome, AppError> {
    tailscale::policy::save(&state, &tailnet, &before, &after, &etag).await
}

/// 키 목록(auth key·OAuth 클라이언트·federated identity·API 토큰)과 지적.
#[tauri::command]
pub async fn tailscale_keys(state: State<'_, TailscaleState>, tailnet: String) -> Result<tailscale::keys::TsKeys, AppError> {
    tailscale::keys::list(&state, &tailnet).await
}

/// 키 삭제 미리보기: 부를 API와 확인 입력.
#[tauri::command]
pub async fn tailscale_key_delete_preview(state: State<'_, TailscaleState>, tailnet: String, id: String) -> Result<tailscale::keys::KeyDeletePreview, AppError> {
    tailscale::keys::delete_preview(&state, &tailnet, &id).await
}

/// 확인 입력(키 ID)이 맞으면 키를 지우고 변경 기록에 남긴다. 되돌릴 수 없다.
#[tauri::command]
pub async fn tailscale_key_delete(state: State<'_, TailscaleState>, tailnet: String, id: String, typed: String) -> Result<tailscale::keys::KeyDeleted, AppError> {
    tailscale::keys::delete(&state, &tailnet, &id, &typed).await
}

/// 이 Mac의 Tailnet Lock 상태. CLI가 없으면 null.
#[tauri::command]
pub async fn tailscale_lock_status() -> Result<Option<tailscale::keys::TsLock>, AppError> {
    tailscale::keys::lock_status().await
}

/// 설정 감사 로그(최근 `days`일: 1, 7, 30).
#[tauri::command]
pub async fn tailscale_logs_audit(state: State<'_, TailscaleState>, tailnet: String, days: u32) -> Result<tailscale::logs::TsAuditLog, AppError> {
    tailscale::logs::audit(&state, &tailnet, days, chrono::Utc::now()).await
}

/// 네트워크 흐름 로그(최근 1시간). 테일넷에서 켜져 있지 않으면 `enabled: false`.
#[tauri::command]
pub async fn tailscale_logs_flows(state: State<'_, TailscaleState>, tailnet: String) -> Result<tailscale::logs::TsFlowLogs, AppError> {
    tailscale::logs::flows(&state, &tailnet, chrono::Utc::now()).await
}

/// 로그 스트리밍 설정과 상태(`configuration` 또는 `network`).
#[tauri::command]
pub async fn tailscale_logs_stream(state: State<'_, TailscaleState>, tailnet: String, log_type: String) -> Result<tailscale::logs::TsLogStream, AppError> {
    tailscale::logs::stream(&state, &tailnet, &log_type).await
}

/// 웹훅 목록.
#[tauri::command]
pub async fn tailscale_webhooks(state: State<'_, TailscaleState>, tailnet: String) -> Result<Vec<tailscale::logs::TsWebhook>, AppError> {
    tailscale::logs::webhooks(&state, &tailnet).await
}

#[tauri::command]
pub async fn tailscale_dns(state: State<'_, TailscaleState>, tailnet: String) -> Result<serde_json::Value, AppError> {
    tailscale::dns::load(&state, &tailnet).await
}

#[tauri::command]
pub async fn tailscale_dns_save(state: State<'_, TailscaleState>, tailnet: String, before: serde_json::Value, after: serde_json::Value) -> Result<Option<String>, AppError> {
    tailscale::dns::save(&state, &tailnet, before, after).await
}

#[tauri::command]
pub async fn tailscale_dns_split_save(state: State<'_, TailscaleState>, tailnet: String, before: serde_json::Value, after: serde_json::Value, patch: serde_json::Value) -> Result<Option<String>, AppError> {
    tailscale::dns::save_split(&state, &tailnet, before, after, patch).await
}

#[tauri::command]
pub async fn tailscale_services(state: State<'_, TailscaleState>, tailnet: String) -> Result<serde_json::Value, AppError> {
    tailscale::services::list(&state, &tailnet).await
}

#[tauri::command]
pub async fn tailscale_service_hosts(state: State<'_, TailscaleState>, tailnet: String, name: String) -> Result<serde_json::Value, AppError> {
    tailscale::services::hosts(&state, &tailnet, &name).await
}

#[tauri::command]
pub async fn tailscale_service_approval(state: State<'_, TailscaleState>, tailnet: String, name: String, device: String) -> Result<serde_json::Value, AppError> {
    tailscale::services::approval(&state, &tailnet, &name, &device).await
}

#[tauri::command]
pub async fn tailscale_service_put(state: State<'_, TailscaleState>, tailnet: String, name: String, body: serde_json::Value, before: Option<serde_json::Value>) -> Result<(), AppError> {
    tailscale::services::put(&state, &tailnet, &name, body, before).await
}

#[tauri::command]
pub async fn tailscale_service_delete(state: State<'_, TailscaleState>, tailnet: String, name: String, typed: String, before: serde_json::Value) -> Result<(), AppError> {
    tailscale::services::delete(&state, &tailnet, &name, &typed, before).await
}

#[tauri::command]
pub async fn tailscale_service_set_approval(state: State<'_, TailscaleState>, tailnet: String, name: String, device: String, approved: bool) -> Result<(), AppError> {
    tailscale::services::set_approval(&state, &tailnet, &name, &device, approved).await
}

#[tauri::command]
pub async fn tailscale_settings(state: State<'_, TailscaleState>, tailnet: String, contacts: bool) -> Result<serde_json::Value, AppError> {
    tailscale::settings::load(&state, &tailnet, contacts).await
}

#[tauri::command]
pub async fn tailscale_settings_save(state: State<'_, TailscaleState>, tailnet: String, field: String, before: serde_json::Value, after: serde_json::Value) -> Result<Option<String>, AppError> {
    tailscale::settings::save_field(&state, &tailnet, &field, before, after).await
}

#[tauri::command]
pub async fn tailscale_contact_save(state: State<'_, TailscaleState>, tailnet: String, kind: String, before: serde_json::Value, email: Option<String>) -> Result<Option<String>, AppError> {
    tailscale::settings::contact(&state, &tailnet, &kind, before, email).await
}

#[tauri::command]
pub async fn tailscale_org_tailnets(state: State<'_, TailscaleState>, tailnet: String) -> Result<Vec<serde_json::Value>, AppError> {
    tailscale::org::list(&state, &tailnet).await
}

#[tauri::command]
pub async fn tailscale_org_create(state: State<'_, TailscaleState>, tailnet: String, display_name: String) -> Result<serde_json::Value, AppError> {
    tailscale::org::create(&state, &tailnet, &display_name).await
}

#[tauri::command]
pub async fn tailscale_org_delete(state: State<'_, TailscaleState>, tailnet: String, id: String, name: String, typed: String) -> Result<(), AppError> {
    tailscale::org::delete(&state, &tailnet, &id, &name, &typed).await
}

#[tauri::command]
pub async fn tailscale_users(state: State<'_, TailscaleState>, tailnet: String, invites: bool) -> Result<serde_json::Value, AppError> {
    tailscale::users::list(&state, &tailnet, invites).await
}

#[tauri::command]
pub async fn tailscale_user_apply(state: State<'_, TailscaleState>, tailnet: String, action: String, id: String, value: serde_json::Value, before: serde_json::Value, typed: String) -> Result<serde_json::Value, AppError> {
    tailscale::users::apply(&state, &tailnet, &action, &id, value, before, &typed).await
}

#[tauri::command]
pub async fn tailscale_key_detail(state: State<'_, TailscaleState>, tailnet: String, id: String) -> Result<serde_json::Value, AppError> {
    tailscale::keys::detail(&state, &tailnet, &id).await
}

#[tauri::command]
pub async fn tailscale_key_save(state: State<'_, TailscaleState>, tailnet: String, id: Option<String>, body: serde_json::Value) -> Result<serde_json::Value, AppError> {
    tailscale::keys::create_or_update(&state, &tailnet, id.as_deref(), body).await
}

#[tauri::command]
pub async fn tailscale_device_extra_list(state: State<'_, TailscaleState>, tailnet: String, id: String, invites: bool) -> Result<serde_json::Value, AppError> {
    tailscale::devices::extra_list(&state, &tailnet, &id, invites).await
}

#[tauri::command]
pub async fn tailscale_device_extra_apply(state: State<'_, TailscaleState>, tailnet: String, action: String, id: String, body: serde_json::Value, before: serde_json::Value, typed: String) -> Result<serde_json::Value, AppError> {
    if action == "deleteInvite" && (id.is_empty() || typed != id) { return Err(AppError::other("초대 ID가 일치하지 않아요")); }
    if action == "attributes" {
        let mut deleted = std::collections::BTreeSet::new();
        if let Some(nodes) = body.get("nodes").and_then(serde_json::Value::as_object) {
            for attributes in nodes.values().filter_map(serde_json::Value::as_object) {
                deleted.extend(attributes.iter().filter(|(_, value)| value.is_null()).map(|(key, _)| key.as_str()));
            }
        }
        if !deleted.is_empty() && typed != deleted.into_iter().collect::<Vec<_>>().join(", ") {
            return Err(AppError::other("삭제할 속성 이름이 일치하지 않아요"));
        }
    }
    tailscale::devices::extra_apply(&state, &tailnet, &action, &id, body, before).await
}

#[tauri::command]
pub async fn tailscale_integration_call(state: State<'_, TailscaleState>, tailnet: String, action: String, id: String, body: serde_json::Value, before: serde_json::Value, typed: String) -> Result<serde_json::Value, AppError> {
    tailscale::integrations::call(&state, &tailnet, &action, &id, body, before, &typed).await
}
