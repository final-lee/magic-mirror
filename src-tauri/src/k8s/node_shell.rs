//! 노드 셸 Pod의 뒷일: 준비될 때까지 기다리기와 셸을 닫은 뒤 지우기. Pod 만들기는 변경 공통 틀(`change::Operation::NodeShell`)이 하고,
//! 지우기도 같은 틀(`commit`, 쓰기는 `exec.rs`)로 하며 변경 기록에 남긴다. 이 파일은 클러스터에 쓰지 않는다.
use std::time::Duration;

use k8s_openapi::api::core::v1::Pod;
use kube::api::Api;
use kube::Client;

use super::change::{self, Change, Operation};
use super::commit;
use super::failure::Endpoint;
use super::log;
use super::read::bounded;
use super::shell::{self, ShellMode};
use super::target::K8sTarget;
use crate::error::AppError;
use crate::iam::clock::{iso, now_secs};
use crate::iam::commit::new_log_id;

pub const NOT_NODE_SHELL: &str = "앱이 만든 노드 셸 Pod가 아니에요";
pub const NOT_READY: &str = "노드 셸 Pod가 60초 안에 준비되지 않았어요. 이미지를 받는 중이거나 노드에 자리가 없을 수 있어요";
pub const POD_ENDED: &str = "노드 셸 Pod가 끝났어요";
pub const SUMMARY_DELETE: &str = "노드 셸 Pod 지우기";
const WAIT: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(500);

/// 이 앱이 노드 셸로 만든 Pod인지(표시 두 개). 앱이 지우는 Pod는 이것뿐이다.
pub fn is_node_shell_pod(pod: &Pod) -> bool {
    let labels = pod.metadata.labels.as_ref();
    let has = |key: &str, value: &str| labels.and_then(|l| l.get(key)).is_some_and(|v| v == value);
    has(change::NODE_SHELL_MANAGED_KEY, change::NODE_SHELL_MANAGED_VALUE) && has(change::NODE_SHELL_LABEL, "true")
}

/// 노드 셸 Pod의 `shell` 컨테이너가 실행될 때까지 기다린다(`WAIT`까지). 표시가 없거나 Pod가 끝났으면 바로 실패한다.
pub async fn wait_ready(client: Client, namespace: &str, pod: &str, endpoint: Endpoint) -> Result<(), AppError> {
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let found = bounded(api.get(pod), "get", "pods", endpoint).await?;
        if !is_node_shell_pod(&found) {
            return Err(AppError::other(NOT_NODE_SHELL));
        }
        match shell::plan_of(ShellMode::Exec, &found, change::NODE_SHELL_CONTAINER) {
            Ok(_) => return Ok(()),
            Err(e) if e == AppError::other(shell::NOT_RUNNING) => {}
            Err(e) => return Err(e),
        }
        if matches!(found.status.as_ref().and_then(|s| s.phase.as_deref()), Some("Failed" | "Succeeded")) {
            return Err(AppError::other(POD_ENDED));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(AppError::other(NOT_READY));
        }
        tokio::time::sleep(POLL).await;
    }
}

/// 노드 셸 Pod를 지우고 변경 기록에 남긴다(성공도 실패도). 이미 없으면 아무것도 하지 않는다.
/// 변경 공통 틀의 지우기와 같다: 미리보기(서버 dry-run), 같은 계획을 재확인해 적용. 위험한 네임스페이스는 Pod 이름을 확인 문구로 넘긴다.
pub async fn remove(client: Client, endpoint: Endpoint, target: K8sTarget, namespace: String, pod: String, log_path: std::path::PathBuf) {
    let object = change::pod_object(&namespace, &pod);
    if !matches!(commit::current(client.clone(), endpoint, &object).await, Ok(Some(found)) if is_node_shell_json(&found)) {
        return;
    }
    let change = Change { target: object, operation: Operation::Delete };
    let at = iso(now_secs());
    let outcome = async {
        let plan = commit::dry_plan(client.clone(), endpoint, &change, &at).await?;
        let (_, result) = commit::apply_plan(client, endpoint, &change, &plan, &at, Some(&pod)).await?;
        result
    }
    .await;
    let entry = log::Entry {
        id: new_log_id(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis())),
        at: iso(now_secs()),
        target,
        change,
        summary: SUMMARY_DELETE.into(),
        ok: outcome.is_ok(),
        error: outcome.as_ref().err().map(ToString::to_string),
        inverse: None,
        undo_of: None,
        undone: false,
        closed_at: None,
    };
    let _ = log::append(&log_path, &entry);
}

/// `remove`가 읽은 JSON 객체에서 같은 표시를 본다
fn is_node_shell_json(object: &serde_json::Value) -> bool {
    serde_json::from_value::<Pod>(object.clone()).is_ok_and(|pod| is_node_shell_pod(&pod))
}

#[cfg(test)]
mod tests;
