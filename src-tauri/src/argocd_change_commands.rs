use crate::{
    argocd::{
        change::{self, ArgoApplyResult, ArgoChange, ArgoChangeRecord, ArgoPreview, ArgoTarget},
        ArgocdState,
    },
    error::AppError,
};
use futures::future::try_join_all;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use tauri::State;

#[tauri::command]
pub async fn argocd_preview(state: State<'_, ArgocdState>, url: String, target: ArgoTarget, change: ArgoChange) -> Result<ArgoPreview, AppError> {
    change::preview(&state, &url, &target, &change).await
}
#[tauri::command]
pub async fn argocd_apply(
    state: State<'_, ArgocdState>,
    url: String,
    target: ArgoTarget,
    change: ArgoChange,
    expected_version: Option<String>,
    confirm_name: Option<String>,
) -> Result<ArgoApplyResult, AppError> {
    change::apply(&state, &url, &target, &change, expected_version, confirm_name).await
}
#[tauri::command]
pub fn argocd_changes(state: State<'_, ArgocdState>, url: String) -> Vec<ArgoChangeRecord> {
    change::changes(&state, &url)
}

#[derive(Deserialize)]
pub struct ArgoCanCheck {
    resource: String,
    action: String,
    object: String,
}
#[tauri::command]
pub async fn argocd_can(state: State<'_, ArgocdState>, url: String, checks: Vec<ArgoCanCheck>) -> Result<Vec<bool>, AppError> {
    try_join_all(checks.iter().map(|c| async {
        let v = state
            .api(&url, Method::GET, &["api", "v1", "account", "can-i", &c.resource, &c.action, &c.object], &[], None)
            .await?;
        Ok(v.get("value").and_then(|v| v.as_str()).is_some_and(|s| s.eq_ignore_ascii_case("yes")))
    }))
    .await
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoServerSettings {
    url: Option<String>,
    exec_enabled: bool,
    status_badge_enabled: bool,
    status_badge_root_url: Option<String>,
    app_label_key: Option<String>,
}
#[tauri::command]
pub async fn argocd_settings(state: State<'_, ArgocdState>, url: String) -> Result<ArgoServerSettings, AppError> {
    let v = state.api(&url, Method::GET, &["api", "v1", "settings"], &[], None).await?;
    let string = |key| v.get(key).and_then(|v| v.as_str()).map(str::to_owned);
    Ok(ArgoServerSettings {
        url: string("url"),
        exec_enabled: v.get("execEnabled").and_then(|v| v.as_bool()).unwrap_or(false),
        status_badge_enabled: v.get("statusBadgeEnabled").and_then(|v| v.as_bool()).unwrap_or(false),
        status_badge_root_url: string("statusBadgeRootUrl"),
        app_label_key: string("appLabelKey"),
    })
}
