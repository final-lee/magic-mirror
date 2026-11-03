//! EKS 탭의 Helm 명령(읽기). 변경(업그레이드·롤백·삭제·설치)은 변경 공통 틀(`k8s_preview`·`k8s_apply`)이 `k8s::helm::plan`으로 처리한다.
use std::time::Duration;

use tauri::State;

use crate::error::AppError;
use crate::k8s::helm::detail::{self, ReleaseDetail};
use crate::k8s::helm::read::{self, ReleaseRow};
use crate::k8s::helm::run::{self, Tool};
use crate::k8s::helm::{cli, plan, ChartSource};
use crate::k8s::target::K8sTarget;
use crate::k8s_commands::K8sState;

const SHOW_LIMIT: Duration = Duration::from_secs(60);

/// helm이 있는지, 버전과 못 쓰는 이유. 변경 단추를 켜고 끄는 데 쓴다.
#[tauri::command]
pub async fn k8s_helm_tool() -> Tool {
    run::tool().await
}

/// 릴리스 목록: 릴리스마다 가장 높은 리비전 한 줄. 네임스페이스가 없으면 모든 네임스페이스.
#[tauri::command]
pub async fn k8s_helm_releases(k8s: State<'_, K8sState>, target: K8sTarget, namespace: Option<String>) -> Result<Vec<ReleaseRow>, AppError> {
    let cluster = k8s.session(&target)?.helm();
    read::list(&cluster, namespace.as_deref()).await
}

/// 릴리스 상세(`revision`이 없으면 가장 높은 리비전)와 모든 리비전의 이력
#[tauri::command]
pub async fn k8s_helm_release(k8s: State<'_, K8sState>, target: K8sTarget, namespace: String, name: String, revision: Option<u32>) -> Result<ReleaseDetail, AppError> {
    let cluster = k8s.session(&target)?.helm();
    let stored = read::locate(&cluster, &namespace, &name).await?;
    let latest = stored.first().ok_or_else(|| AppError::other(read::NOT_FOUND))?.revision;
    let chosen = match revision {
        Some(wanted) => stored.iter().find(|s| s.revision == wanted).ok_or_else(|| AppError::other(read::REVISION_NOT_FOUND))?,
        None => &stored[0],
    };
    let (release, history) = tokio::join!(read::fetch(&cluster, chosen), read::history(&cluster, &stored));
    detail::build(&release?, chosen.driver, latest, history?)
}

/// 차트의 기본 values(`helm show values`). 설치 창의 편집기에 채운다. 클러스터에 닿지 않는다.
#[tauri::command]
pub async fn k8s_helm_show_values(chart: ChartSource) -> Result<String, AppError> {
    let built = cli::show_values(&plan::source_chart(&chart)?);
    let helm = run::require().await?;
    run::exec(&helm, &built.args, &[], run::NO_CLUSTER, SHOW_LIMIT).await
}
