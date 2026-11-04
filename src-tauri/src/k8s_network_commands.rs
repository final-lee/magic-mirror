//! 네트워크 화면(K6)의 명령. 읽기만 한다. 쿠버네티스 연결은 `k8s_open`이 연 세션을 쓴다.
use tauri::State;

use crate::commands::AppState;
use crate::error::AppError;
use crate::k8s::network::aws::Clients;
use crate::k8s::network::network;
use crate::k8s::network::model::Network;
use crate::k8s::target::K8sTarget;
use crate::k8s_commands::K8sState;

/// 네트워크 화면 한 장: 로드 밸런서 짝, 노드·서브넷, Pod IP, NetworkPolicy.
/// 부분마다 읽지 못한 이유는 `gaps`에 담기므로 연결이 없을 때만 실패한다(AWS 프로필 설정을 읽지 못해도 AWS 부분이 gap이 된다).
#[tauri::command]
pub async fn k8s_network(app: State<'_, AppState>, k8s: State<'_, K8sState>, target: K8sTarget) -> Result<Network, AppError> {
    let s = k8s.session(&target)?;
    let aws = app.ctx.config(&target.profile, &target.region).await.map(|cfg| Clients::new(&cfg));
    Ok(network(&aws, &target.cluster, &s.client, s.endpoint).await)
}
