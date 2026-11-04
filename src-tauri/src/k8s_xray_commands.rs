//! 객체의 관계 트리(xray). 읽기만 한다.
use tauri::State;

use crate::error::AppError;
use crate::k8s::rows::KindRef;
use crate::k8s::target::K8sTarget;
use crate::k8s::xray::{model::Xray, xray};
use crate::k8s_commands::K8sState;

/// 소유·참조·선택·대상 관계 트리. 읽지 못한 종류는 `gaps`에 담기므로 객체를 읽지 못할 때만 실패한다.
#[tauri::command]
pub async fn k8s_xray(k8s: State<'_, K8sState>, target: K8sTarget, kind: KindRef, namespace: Option<String>, name: String) -> Result<Xray, AppError> {
    let session = k8s.session(&target)?;
    xray(&session.client, &kind, namespace.as_deref(), &name, session.endpoint).await
}
