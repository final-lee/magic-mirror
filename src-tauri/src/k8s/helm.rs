//! Helm 릴리스 보기와 변경.
//! - 읽기(`read`, `release`, `detail`, `manifest`): helm 저장소(Secret `helm.sh/release.v1`, ConfigMap)를 kube로 읽어 앱이 직접 푼다. helm CLI가 필요 없다.
//! - 변경(`plan`, `cli`, `run`, `chart`): helm CLI로 한다. 미리보기·재확인·기록·되돌리기는 변경 공통 틀(`change`, `k8s_preview`/`k8s_apply`)을 그대로 거친다.
//!   helm 프로세스를 띄우는 곳은 `run.rs`, 쓰기 명령 인자를 만드는 곳은 `cli.rs` 둘뿐이다(`hygiene`이 지킨다).
use std::path::PathBuf;

use kube::Client;
use serde::{Deserialize, Serialize};

use super::change::{Change, Operation};
use super::failure::Endpoint;
use super::rows::KindRef;

pub mod chart;
pub mod cli;
pub mod detail;
pub mod manifest;
pub mod plan;
pub mod read;
pub mod release;
pub mod run;

/// 변경 틀에서 릴리스를 가리키는 종류. 클러스터의 API 종류가 아니라 앱 안의 이름표다.
pub fn release_kind() -> KindRef {
    KindRef { group: "helm.sh".into(), version: "v1".into(), kind: "Release".into(), plural: "releases".into(), namespaced: true }
}

/// helm을 부르는 데 필요한 세션 정보
pub struct Cluster {
    pub client: Client,
    pub endpoint: Endpoint,
    /// helm `--kube-context`
    pub context: String,
    /// 세션이 읽은 kubeconfig 파일들(하나면 `--kubeconfig`, 여럿이면 `KUBECONFIG`)
    pub kubeconfig_paths: Vec<PathBuf>,
}

/// 차트를 가리키는 법. `reference`는 로컬 경로(절대 경로 또는 `~/`), `oci://…`, 저장소 안의 차트 이름 중 하나다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartSource {
    pub reference: String,
    /// 저장소 주소(`--repo`). 저장소 안의 차트 이름과 함께 쓴다
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

/// 이 변경은 helm CLI로 하는 것인가
pub fn handles(change: &Change) -> bool {
    matches!(
        change.operation,
        Operation::HelmUpgrade { .. } | Operation::HelmRollback { .. } | Operation::HelmUninstall { .. } | Operation::HelmInstall { .. }
    )
}

/// 변경 기록에 남기기 전에 values를 뺀다. values에는 사용자의 비밀 값이 있을 수 있어 기록 파일에 쓰지 않는다.
pub fn redact(operation: &mut Operation) {
    if let Operation::HelmUpgrade { values, .. } | Operation::HelmInstall { values, .. } = operation {
        values.clear();
    }
}
