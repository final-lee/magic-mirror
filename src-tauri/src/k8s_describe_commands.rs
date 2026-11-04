//! 객체의 읽기 전용 describe 출력.
use tauri::State;
use crate::error::AppError;
use crate::k8s::describe;
use crate::k8s::rows::KindRef;
use crate::k8s::target::K8sTarget;
use crate::k8s_commands::K8sState;

#[tauri::command]
pub async fn k8s_describe(k8s: State<'_, K8sState>, target: K8sTarget, kind: KindRef, namespace: Option<String>, name: String) -> Result<String, AppError> {
    let session = k8s.session(&target)?;
    describe::describe(&session, &kind, namespace.as_deref(), &name).await
}
