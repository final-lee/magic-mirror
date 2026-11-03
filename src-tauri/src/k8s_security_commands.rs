//! 보안 점검 화면(K5)의 명령. 읽기만 한다. 쿠버네티스 연결은 `k8s_open`이 연 세션을 쓴다.
//! 고칠 수 있는 항목의 변경은 이 명령이 아니라 공통 변경 틀(`k8s_preview`/`k8s_apply`)이 한다.
use tauri::State;

use crate::commands::AppState;
use crate::error::AppError;
use crate::iam::clock::{iso, now_secs};
use crate::k8s::checks::read::{gather, Aws};
use crate::k8s::checks::{run, Report};
use crate::k8s::target::K8sTarget;
use crate::k8s_commands::K8sState;

/// 보안 점검 결과 한 장. 항목마다 읽지 못한 입력은 `gaps`와 `skipped`에 담기므로 연결이 없을 때만 실패한다
/// (AWS 프로필 설정을 읽지 못해도 AWS 부분이 gap이 된다). 항목 켜고 끄기와 시스템 네임스페이스 제외는 화면이 이 결과를 걸러서 한다.
#[tauri::command]
pub async fn k8s_findings(app: State<'_, AppState>, k8s: State<'_, K8sState>, target: K8sTarget) -> Result<Report, AppError> {
    let s = k8s.session(&target)?;
    let aws = app.ctx.config(&target.profile, &target.region).await.map(|cfg| Aws::new(&cfg));
    let now = now_secs();
    let inputs = gather(&s.client, &aws, &target.cluster, s.endpoint, now).await;
    tokio::task::spawn_blocking(move || run(inputs, &iso(now))).await.map_err(|e| AppError::other(e.to_string()))
}
