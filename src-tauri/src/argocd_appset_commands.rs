//! ArgoCD ApplicationSet·알림 읽기 명령. 쓰기(저장·삭제)는 argocd_apply의 ArgoChange를 쓴다.
use reqwest::Method;
use serde_json::Value;
use tauri::State;

use crate::argocd::appset::{self, AppSetApp, AppSetDetail, GeneratedApp};
use crate::argocd::notify::{self, NotificationCatalog};
use crate::argocd::resource::{self, ResourceEvent};
use crate::argocd::{self, ArgoTreeNode, ArgocdState};
use crate::error::AppError;
use crate::explorer::diff::{build_text_diff, TextDiff};

async fn appset_get(state: &ArgocdState, url: &str, namespace: &str, name: &str, tail: &[&str]) -> Result<Value, AppError> {
    let mut path = vec!["api", "v1", "applicationsets", name];
    path.extend_from_slice(tail);
    state.api(url, Method::GET, &path, &[("appsetNamespace", namespace)], None).await
}

#[tauri::command]
/// ApplicationSet 상세(매니페스트 YAML, generator·템플릿·단계 요약, 조건, 앱별 상태).
pub async fn argocd_appset(state: State<'_, ArgocdState>, url: String, namespace: String, name: String) -> Result<AppSetDetail, AppError> {
    appset::appset_detail(&appset_get(&state, &url, &namespace, &name, &[]).await?)
}

#[tauri::command]
/// ApplicationSet의 Kubernetes 이벤트(최근 것부터).
pub async fn argocd_appset_events(state: State<'_, ArgocdState>, url: String, namespace: String, name: String) -> Result<Vec<ResourceEvent>, AppError> {
    Ok(resource::event_rows(&appset_get(&state, &url, &namespace, &name, &["events"]).await?))
}

#[tauri::command]
/// ApplicationSet이 직접 관리하는 리소스(만든 Application)의 트리.
pub async fn argocd_appset_tree(state: State<'_, ArgocdState>, url: String, namespace: String, name: String) -> Result<Vec<ArgoTreeNode>, AppError> {
    let body = appset_get(&state, &url, &namespace, &name, &["resource-tree"]).await?;
    Ok(argocd::list(&body, "/nodes").iter().map(argocd::tree_node).collect())
}

#[tauri::command]
/// 이 ApplicationSet이 지금 만들어 둔 앱과 그 spec(미리 보기 비교용).
pub async fn argocd_appset_apps(state: State<'_, ArgocdState>, url: String, namespace: String, name: String) -> Result<Vec<AppSetApp>, AppError> {
    let body = state.api(&url, Method::GET, &["api", "v1", "applications"], &[], None).await?;
    appset::owned_apps(&body, &namespace, &name)
}

#[tauri::command]
/// 편집한 ApplicationSet YAML이 만들 앱을 서버가 계산한다. 아무것도 저장하지 않는다.
pub async fn argocd_appset_generate(state: State<'_, ArgocdState>, url: String, yaml: String) -> Result<Vec<GeneratedApp>, AppError> {
    let body = appset::generate_request(&yaml)?;
    let response = state.api(&url, Method::POST, &["api", "v1", "applicationsets", "generate"], &[], Some(&body)).await?;
    appset::generated_apps(&response)
}

#[tauri::command]
/// 두 YAML 글의 줄 단위 비교(앱 하나의 현재와 미리 본 spec 비교에 쓴다).
pub fn argocd_yaml_diff(old: String, new: String) -> TextDiff {
    build_text_diff(&old, &new)
}

#[tauri::command]
/// 서버에 설정된 알림 서비스·트리거·템플릿 이름.
pub async fn argocd_notification_catalog(state: State<'_, ArgocdState>, url: String) -> Result<NotificationCatalog, AppError> {
    let (services, triggers, templates) = (
        ["api", "v1", "notifications", "services"],
        ["api", "v1", "notifications", "triggers"],
        ["api", "v1", "notifications", "templates"],
    );
    let (services, triggers, templates) = tokio::try_join!(
        state.api(&url, Method::GET, &services, &[], None),
        state.api(&url, Method::GET, &triggers, &[], None),
        state.api(&url, Method::GET, &templates, &[], None),
    )?;
    Ok(notify::catalog(&services, &triggers, &templates))
}
