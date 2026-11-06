//! ArgoCD 지표 화면 명령: 서버 배포 이력, 컨트롤러 지표(service proxy), 앱 Pod 사용량(metrics-server).
use reqwest::Method;
use tauri::State;

use crate::argocd::cluster::{ArgoKube, ControllerScrape};
use crate::argocd::deploys::{self, DeployRecord};
use crate::argocd::usage::{self, AppUsage, PodRef};
use crate::argocd::ArgocdState;
use crate::argowf::client::State as WfState;
use crate::error::AppError;

#[tauri::command]
/// 모든 앱의 서버 배포 이력(성공한 sync만, 앱마다 서버가 보관하는 만큼). 로컬 이벤트 기록과 합쳐 배포 지표를 낸다.
pub async fn argocd_deploy_history(state: State<'_, ArgocdState>, url: String) -> Result<Vec<DeployRecord>, AppError> {
    let body = state.api(&url, Method::GET, &["api", "v1", "applications"], &[], None).await?;
    Ok(deploys::records_of(&body))
}

#[tauri::command]
/// ArgoCD 네 컴포넌트의 `/metrics`를 kube context의 service proxy로 읽어 요약한다(읽기 전용).
pub async fn argocd_controller_metrics(kube: State<'_, ArgoKube>, wf: State<'_, WfState>, context: String, namespace: String) -> Result<ControllerScrape, AppError> {
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    kube.controller_metrics(&wf.settings_path, &context, &namespace, at).await
}

#[tauri::command]
/// 앱의 Pod들의 지금 CPU·메모리 사용량(metrics-server)과 요청·제한. Pod 목록은 화면이 리소스 트리에서 보낸다.
pub async fn argocd_app_usage(kube: State<'_, ArgoKube>, wf: State<'_, WfState>, context: String, pods: Vec<PodRef>) -> Result<AppUsage, AppError> {
    let client = kube.client(&wf.settings_path, &context).await?;
    usage::read_usage(&client, &pods).await
}
