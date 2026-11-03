//! Argo 객체를 YAML로 만들고 고치는 명령과 Argo Events·Event Binding 목록.
use tauri::State;

use crate::argowf::client::{Server, State as WfState};
use crate::argowf::events::{self, EventBindingRow, EventSourceRow, SensorRow};
use crate::argowf::manifest::{self, Created, LintResult, ManifestKind};
use crate::error::AppError;

#[tauri::command]
pub async fn argowf_manifest(
    state: State<'_, WfState>,
    server: Server,
    kind: ManifestKind,
    namespace: Option<String>,
    name: String,
) -> Result<String, AppError> {
    manifest::manifest(&state, &server, kind, namespace.as_deref(), &name).await
}

#[tauri::command]
pub async fn argowf_lint(
    state: State<'_, WfState>,
    server: Server,
    kind: ManifestKind,
    namespace: Option<String>,
    yaml: String,
) -> Result<LintResult, AppError> {
    manifest::lint(&state, &server, kind, namespace.as_deref(), &yaml).await
}

#[tauri::command]
pub async fn argowf_create(
    state: State<'_, WfState>,
    server: Server,
    kind: ManifestKind,
    namespace: Option<String>,
    yaml: String,
    as_new: Option<bool>,
) -> Result<Created, AppError> {
    manifest::create(&state, &server, kind, namespace.as_deref(), &yaml, as_new.unwrap_or(false)).await
}

#[tauri::command]
pub async fn argowf_update(
    state: State<'_, WfState>,
    server: Server,
    kind: ManifestKind,
    namespace: Option<String>,
    name: String,
    yaml: String,
) -> Result<(), AppError> {
    manifest::update(&state, &server, kind, namespace.as_deref(), &name, &yaml).await
}

#[tauri::command]
pub async fn argowf_delete(state: State<'_, WfState>, server: Server, kind: ManifestKind, namespace: Option<String>, name: String) -> Result<(), AppError> {
    manifest::delete(&state, &server, kind, namespace.as_deref(), &name).await
}

#[tauri::command]
pub async fn argowf_event_bindings(state: State<'_, WfState>, server: Server, namespace: Option<String>) -> Result<Vec<EventBindingRow>, AppError> {
    events::bindings(&state, &server, namespace.as_deref()).await
}

#[tauri::command]
pub async fn argowf_event_sources(state: State<'_, WfState>, server: Server, namespace: Option<String>) -> Result<Vec<EventSourceRow>, AppError> {
    events::sources(&state, &server, namespace.as_deref()).await
}

#[tauri::command]
pub async fn argowf_sensors(state: State<'_, WfState>, server: Server, namespace: Option<String>) -> Result<Vec<SensorRow>, AppError> {
    events::sensors(&state, &server, namespace.as_deref()).await
}
