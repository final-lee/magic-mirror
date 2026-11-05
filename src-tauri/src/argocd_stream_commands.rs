//! ArgoCD 감시와 로컬 이벤트 명령.
use crate::argocd::{
    events::{self, ArgoEvent},
    stream::{self, Watch},
    ArgocdState,
};
use serde_json::Value;
use tauri::{ipc::Channel, State};

#[tauri::command]
pub fn argocd_watch_apps(app: tauri::AppHandle, state: State<'_, ArgocdState>, url: String, on_event: Channel<Value>) -> u64 {
    stream::start(app, &state, url, Watch::Apps, on_event)
}
#[tauri::command]
pub fn argocd_watch_tree(app: tauri::AppHandle, state: State<'_, ArgocdState>, url: String, namespace: String, name: String, on_event: Channel<Value>) -> u64 {
    stream::start(app, &state, url, Watch::Tree { namespace, name }, on_event)
}
#[tauri::command]
pub fn argocd_watch_appsets(app: tauri::AppHandle, state: State<'_, ArgocdState>, url: String, on_event: Channel<Value>) -> u64 {
    stream::start(app, &state, url, Watch::Appsets, on_event)
}
#[tauri::command]
pub fn argocd_watch_stop(state: State<'_, ArgocdState>, id: u64) {
    state.stop_stream(id);
}
#[tauri::command]
pub fn argocd_events(state: State<'_, ArgocdState>, url: String, since: Option<String>) -> Vec<ArgoEvent> {
    events::read(&state, &url, since.as_deref())
}
