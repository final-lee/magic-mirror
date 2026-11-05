//! ArgoCD 운영 읽기 명령: 리소스 액션 목록, 터미널을 넘길 kubeconfig context 목록.
use reqwest::Method;
use tauri::State;

use crate::argocd::ops::{self, KubeContext, ResourceAction};
use crate::argocd::resource::{self, AppTarget, ResRef};
use crate::argocd::ArgocdState;
use crate::argowf::{auth, client::State as WfState};
use crate::error::AppError;

#[tauri::command]
/// 리소스에서 실행할 수 있는 액션(서버가 리소스 종류와 상태를 보고 정한다).
pub async fn argocd_resource_actions(state: State<'_, ArgocdState>, url: String, target: AppTarget, res: ResRef) -> Result<Vec<ResourceAction>, AppError> {
    let query = resource::resource_query(&target, &res, "resourceName");
    let body = state
        .api(&url, Method::GET, &["api", "v1", "applications", &target.name, "resource", "actions"], &query, None)
        .await?;
    Ok(ops::action_rows(&body))
}

#[tauri::command]
/// kubeconfig의 context 전체(서버 주소·AWS 프로필·EKS 클러스터). 대상 클러스터와 이어 터미널을 EKS 탭에서 열 때 쓴다.
pub fn argocd_kube_contexts(state: State<'_, WfState>) -> Result<Vec<KubeContext>, AppError> {
    Ok(ops::kube_contexts(&auth::load(&state.settings_path)?.config))
}
