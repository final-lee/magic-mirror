//! 노드 셸 Pod의 뒷일: 준비될 때까지 기다리기와 셸을 닫은 뒤 지우기. Pod 만들기는 변경 공통 틀(`change::Operation::NodeShell`)이 하고,
//! 지우기도 같은 틀(`commit`, 쓰기는 `exec.rs`)로 하며 변경 기록에 남긴다. 이 파일은 클러스터에 쓰지 않는다.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use futures::future::BoxFuture;

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

pub const NOT_NODE_SHELL: &str = "앱이 확인해 만든 노드 셸 Pod가 아니에요";
/// 만든 Pod의 UID를 읽지 못했을 때
pub const UID_UNKNOWN: &str = "노드 셸 Pod를 확인하지 못해 지웠어요. 다시 시도해 주세요";
const UID_READS: u32 = 5;
const UID_RETRY: Duration = Duration::from_millis(300);
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

/// 노드 셸 Pod의 `shell` 컨테이너가 실행될 때까지 기다린다(`WAIT`까지). 확인해 만든 Pod(`uid`)가 아니거나 Pod가 끝났으면 바로 실패한다.
pub async fn wait_ready(client: Client, namespace: &str, pod: &str, uid: &str, endpoint: Endpoint) -> Result<(), AppError> {
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let found = bounded(api.get(pod), "get", "pods", endpoint).await?;
        if !is_node_shell_pod(&found) || found.metadata.uid.as_deref() != Some(uid) {
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
pub async fn remove(client: Client, endpoint: Endpoint, target: K8sTarget, namespace: String, pod: String, uid: Option<String>, log_path: PathBuf) {
    let object = change::pod_object(&namespace, &pod);
    if !matches!(commit::current(client.clone(), endpoint, &object).await, Ok(Some(found)) if is_ours(&found, uid.as_deref())) {
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

/// 앱이 만든 바로 그 Pod(표시, 그리고 알고 있으면 UID까지 같음)인지. 지우기는 이것일 때만 한다.
pub fn is_ours(object: &serde_json::Value, uid: Option<&str>) -> bool {
    is_node_shell_json(object) && uid.is_none_or(|u| uid_of_json(object) == Some(u))
}

/// 읽은 Pod JSON의 UID
fn uid_of_json(object: &serde_json::Value) -> Option<&str> {
    object.pointer("/metadata/uid").and_then(serde_json::Value::as_str)
}

/// 방금 만든 노드 셸 Pod의 UID를 읽는다(만든 직후라 잠깐 안 보일 수 있어 몇 번 다시 읽는다). 표시가 없는 Pod는 돌려주지 않는다.
pub async fn read_uid(client: Client, endpoint: Endpoint, namespace: &str, pod: &str) -> Option<String> {
    let object = change::pod_object(namespace, pod);
    for attempt in 0..UID_READS {
        if attempt > 0 {
            tokio::time::sleep(UID_RETRY).await;
        }
        if let Ok(Some(found)) = commit::current(client.clone(), endpoint, &object).await {
            return is_node_shell_json(&found).then(|| uid_of_json(&found).map(str::to_string)).flatten();
        }
    }
    None
}

/// 지우기를 돌리는 함수(클라이언트·대상·기록 위치를 쥐고 있다)
pub type Remover = Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>;

/// `remove`를 이 Pod(UID)에 묶은 지우기
pub fn remover(client: Client, endpoint: Endpoint, target: K8sTarget, namespace: String, pod: String, uid: Option<String>, log_path: PathBuf) -> Remover {
    Arc::new(move || Box::pin(remove(client.clone(), endpoint, target.clone(), namespace.clone(), pod.clone(), uid.clone(), log_path.clone())))
}

struct Tracked {
    target: K8sTarget,
    uid: String,
    remove: Remover,
    /// 터미널을 열기로 가져갔다(이후 지우기는 그 세션이 맡는다)
    claimed: bool,
}

/// 확인한 노드 셸 적용(`NodeShell`)으로 만든 Pod를 기억하고 수명을 맡는다.
/// 터미널을 열 수 있는 Pod는 여기 있는 것뿐이고(UID까지 같아야 한다), 아직 터미널이 가져가지 않은 Pod는 탭을 닫거나 앱을 끌 때 지운다.
#[derive(Default)]
pub struct NodeShells {
    entries: Mutex<HashMap<(String, String), Tracked>>,
    tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 터미널을 연 쪽이 가져간 Pod
pub struct Claimed {
    pub uid: String,
    pub remove: Remover,
}

impl NodeShells {
    /// 적용이 성공한 Pod를 등록한다. 터미널을 열기 전에 탭이 닫히거나 앱이 꺼져도 `close_target`·`close_all`이 지운다.
    pub fn track(&self, target: K8sTarget, namespace: &str, pod: &str, uid: String, remove: Remover) {
        locked(&self.entries).insert((namespace.to_string(), pod.to_string()), Tracked { target, uid, remove, claimed: false });
    }

    /// 터미널을 열 Pod를 가져간다. 이 대상에서 확인해 만든 Pod만, 한 번만 가져갈 수 있다.
    pub fn claim(&self, target: &K8sTarget, namespace: &str, pod: &str) -> Result<Claimed, AppError> {
        let mut entries = locked(&self.entries);
        let tracked = entries
            .get_mut(&(namespace.to_string(), pod.to_string()))
            .filter(|t| t.target == *target && !t.claimed)
            .ok_or_else(|| AppError::other(NOT_NODE_SHELL))?;
        tracked.claimed = true;
        Ok(Claimed { uid: tracked.uid.clone(), remove: tracked.remove.clone() })
    }

    /// 지우기가 끝난 Pod를 잊는다
    pub fn forget(&self, namespace: &str, pod: &str) {
        locked(&self.entries).remove(&(namespace.to_string(), pod.to_string()));
    }

    /// 아직 터미널이 가져가지 않은 Pod를 지우고 잊는다(`only`가 있으면 그 대상의 것만)
    fn sweep(&self, only: Option<&K8sTarget>) {
        let mut gone = Vec::new();
        locked(&self.entries).retain(|_, t| {
            let sweep = !t.claimed && only.is_none_or(|o| t.target == *o);
            if sweep {
                gone.push(t.remove.clone());
            }
            !sweep
        });
        for remove in gone {
            // 앱 종료처럼 런타임 밖에서 불려도 되도록 tauri의 런타임으로 띄운다
            let task = tauri::async_runtime::spawn(remove());
            locked(&self.tasks).push(task);
        }
    }

    /// 탭을 닫을 때: 그 대상의, 터미널이 아직 가져가지 않은 Pod를 지운다
    pub fn close_target(&self, target: &K8sTarget) {
        self.sweep(Some(target));
    }

    /// 앱을 끌 때: 터미널이 가져가지 않은 모든 Pod를 지운다
    pub fn close_all(&self) {
        self.sweep(None);
    }

    /// 돌고 있는 지우기가 끝나기를 `limit`까지 기다린다
    pub async fn settle(&self, limit: Duration) {
        let pending: Vec<_> = locked(&self.tasks).drain(..).collect();
        let _ = tokio::time::timeout(limit, futures::future::join_all(pending)).await;
    }

    /// 등록은 했지만 더는 쓸 일이 없어진 Pod(적용 기록 실패 등)를 바로 지우고 잊는다
    pub fn discard(&self, namespace: &str, pod: &str) {
        let removed = locked(&self.entries).remove(&(namespace.to_string(), pod.to_string()));
        if let Some(t) = removed {
            let task = tauri::async_runtime::spawn((t.remove)());
            locked(&self.tasks).push(task);
        }
    }
}

#[cfg(test)]
mod tests;
