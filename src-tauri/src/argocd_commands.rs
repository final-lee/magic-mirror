//! ArgoCD 서버 API 명령.
use reqwest::Method;
use serde_json::{json, Value};
use tauri::State;

use crate::argocd::{self, ArgoApp, ArgoAppRow, ArgoAppSetRow, ArgoSyncOptions, ArgoTreeNode, ArgocdSession, ArgocdState};
use crate::error::AppError;

/// 토큰을 검증하고 키체인에 저장한다.
#[tauri::command]
pub async fn argocd_set_token(state: State<'_, ArgocdState>, url: String, token: String) -> Result<ArgocdSession, AppError> {
    state.set_token(&url, token).await
}

#[tauri::command]
/// 저장된 토큰을 지운다.
pub async fn argocd_forget_token(state: State<'_, ArgocdState>, url: String) -> Result<(), AppError> {
    state.forget_token(&url).await
}

#[tauri::command]
/// 서버 세션을 확인한다.
pub async fn argocd_session(state: State<'_, ArgocdState>, url: String) -> Result<Option<ArgocdSession>, AppError> {
    state.session(&url).await
}

#[tauri::command]
/// Application 목록을 읽는다.
pub async fn argocd_apps(state: State<'_, ArgocdState>, url: String) -> Result<Vec<ArgoAppRow>, AppError> {
    let body = state.api(&url, Method::GET, &["api", "v1", "applications"], None, None, None).await?;
    Ok(argocd::list(&body, "/items").iter().map(argocd::app_row).collect())
}

#[tauri::command]
/// ApplicationSet 목록을 읽는다.
pub async fn argocd_appsets(state: State<'_, ArgocdState>, url: String) -> Result<Vec<ArgoAppSetRow>, AppError> {
    let body = state.api(&url, Method::GET, &["api", "v1", "applicationsets"], None, None, None).await?;
    Ok(argocd::list(&body, "/items").iter().map(argocd::appset_row).collect())
}

#[tauri::command]
/// Application 상세를 읽는다.
pub async fn argocd_app(state: State<'_, ArgocdState>, url: String, namespace: String, name: String) -> Result<ArgoApp, AppError> {
    let body = state.api(&url, Method::GET, &["api", "v1", "applications", &name], Some(&namespace), None, None).await?;
    Ok(argocd::argo_app_of(&body))
}

#[tauri::command]
/// Application 리소스 트리를 읽는다.
pub async fn argocd_tree(state: State<'_, ArgocdState>, url: String, namespace: String, name: String) -> Result<Vec<ArgoTreeNode>, AppError> {
    let body = state.api(&url, Method::GET, &["api", "v1", "applications", &name, "resource-tree"], Some(&namespace), None, None).await?;
    Ok(argocd::list(&body, "/nodes").iter().chain(argocd::list(&body, "/orphanedNodes")).map(argocd::tree_node).collect())
}

#[tauri::command]
/// 서버에 새로고침을 요청한다.
pub async fn argocd_refresh(state: State<'_, ArgocdState>, url: String, namespace: String, name: String, hard: bool) -> Result<(), AppError> {
    let refresh = if hard {
        "hard"
    } else {
        "normal"
    };
    state.api(&url, Method::GET, &["api", "v1", "applications", &name], Some(&namespace), Some(refresh), None).await?;
    Ok(())
}

#[tauri::command]
/// 서버에 동기화를 요청한다.
pub async fn argocd_sync(state: State<'_, ArgocdState>, url: String, namespace: String, name: String, options: ArgoSyncOptions) -> Result<(), AppError> {
    let body: Value = json!({ "appNamespace": namespace, "prune": options.prune, "dryRun": options.dry_run });
    state.api(&url, Method::POST, &["api", "v1", "applications", &name, "sync"], None, None, Some(&body)).await?;
    Ok(())
}
