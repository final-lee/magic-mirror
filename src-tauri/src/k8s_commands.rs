//! EKS 탭의 명령. 대상(프로필·리전·클러스터)마다 열린 연결 하나(`Session`)를 둔다.
//! 열기는 시작할 때 대상의 닫힌 횟수(`epoch`)를 읽어 두고, 끝날 때 그사이 닫혔으면 연결을 버린다(PG 탭과 같은 규칙).
//! 잠금 순서: `epochs`, `sessions`, `watches`. 두 잠금을 함께 잡는 곳은 모두 이 순서를 지킨다.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::{Manager, State};

use crate::commands::AppState;
use crate::error::AppError;
use crate::iam::clock::{iso, now_secs};
use crate::iam::commit::{new_log_id, plan::PlanStore};
use crate::k8s::change::{Change, ChangeObject, Operation, Plan, Preview, INVALID_CHANGE};
use crate::k8s::drain::apply::{self as drain_apply, Job};
use crate::k8s::drain::run::{DrainMessage, Limits};
use crate::k8s::{commit, exec, log};
use crate::k8s::connect;
use crate::k8s::failure::{describe, failure_of, Endpoint, Failure, NOT_OPENED};
use crate::k8s::kubeconfig::{self, Candidate, NO_CONTEXT};
use crate::k8s::read::detail::{self, ObjectView};
use crate::k8s::read::kinds::{self, Kind};
use crate::k8s::read::overview::{self, Overview};
use crate::k8s::read::secret::{self, SecretValue};
use crate::k8s::review::{self, Identity, Rules};
use crate::k8s::logs::{self, LogMessage, LogOptions};
use crate::k8s::rows::KindRef;
use crate::k8s::target::{describe_cluster, K8sTarget};
use crate::k8s::watch::{self, WatchMessage};

pub const RECORD_FAILED: &str = "변경 결과를 기록하지 못했어요";
pub const UNDO_RECORD_FAILED: &str = "되돌리기 기록을 갱신하지 못했어요";

pub struct Session {
    pub client: kube::Client,
    pub endpoint: Endpoint,
    pub context: String,
}

#[derive(Default)]
pub struct K8sState {
    sessions: Mutex<HashMap<K8sTarget, Arc<Session>>>,
    epochs: Mutex<HashMap<K8sTarget, u64>>,
    watches: Mutex<HashMap<u64, WatchEntry>>,
    next_watch: AtomicU64,
    plans: Mutex<PlanStore<StoredPlan>>,
    log_path: PathBuf,
}

/// 돌고 있는 watch, 로그, drain 하나. 대상이 닫히면 같은 대상의 것을 모두 멈춘다.
struct WatchEntry {
    target: K8sTarget,
    handle: tokio::task::AbortHandle,
    /// drain만 가진다. 끊지 않고 이 신호로 멈춰야 지금 하는 Eviction을 마치고 결과를 기록한다.
    cancel: Option<tokio::sync::watch::Sender<bool>>,
}

impl WatchEntry {
    fn stop(&self) {
        match &self.cancel {
            Some(cancel) => {
                cancel.send_replace(true);
            }
            None => self.handle.abort(),
        }
    }
}

#[derive(Clone)]
struct StoredPlan {
    plan: Plan,
    at: String,
    epoch: u64,
    session: Arc<Session>,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl K8sState {
    pub fn new(log_path: PathBuf) -> Self {
        Self { log_path, ..Self::default() }
    }

    pub fn epoch(&self, t: &K8sTarget) -> u64 {
        *locked(&self.epochs).get(t).unwrap_or(&0)
    }

    /// 시작할 때의 `epoch`와 같을 때만 넣는다. 다르면(그사이 닫힘) false.
    /// 이미 연결이 있던 대상을 다시 열면(닫지 않은 재연결: kubeconfig 경로 변경, 웹뷰 새로고침) 그 대상의 watch는 옛 클라이언트를 쥐고 있으니 멈추고 잊는다.
    pub fn keep(&self, t: &K8sTarget, started: u64, session: Session) -> bool {
        let epochs = locked(&self.epochs);
        if *epochs.get(t).unwrap_or(&0) != started {
            return false;
        }
        let mut sessions = locked(&self.sessions);
        if sessions.insert(t.clone(), Arc::new(session)).is_some() {
            locked(&self.watches).retain(|_, w| {
                let same = w.target == *t;
                if same {
                    w.stop();
                }
                !same
            });
        }
        true
    }

    pub fn close(&self, t: &K8sTarget) {
        let mut epochs = locked(&self.epochs);
        *epochs.entry(t.clone()).or_insert(0) += 1;
        locked(&self.sessions).remove(t);
        locked(&self.watches).retain(|_, w| {
            let same = w.target == *t;
            if same {
                w.stop();
            }
            !same
        });
    }

    /// 시작할 때의 `epoch`와 같을 때만 `spawn`으로 watch를 띄워 등록한다. 다르면(그사이 닫힘) None.
    /// 등록이 끝날 때까지 `watches` 잠금을 쥐니, 곧바로 끝나는 작업의 `forget_watch`도 등록 뒤에 실행된다.
    pub fn register_watch(&self, t: &K8sTarget, started: u64, spawn: impl FnOnce(u64) -> tokio::task::AbortHandle) -> Option<u64> {
        let epochs = locked(&self.epochs);
        if *epochs.get(t).unwrap_or(&0) != started {
            return None;
        }
        let mut watches = locked(&self.watches);
        let id = self.next_watch.fetch_add(1, Ordering::Relaxed) + 1;
        watches.insert(id, WatchEntry { target: t.clone(), handle: spawn(id), cancel: None });
        Some(id)
    }

    /// `register_watch`와 같되 drain용이다. `spawn`이 돌려주는 보내는 쪽으로 멈춘다(`unwatch`, 대상 닫기).
    pub fn register_drain(
        &self,
        t: &K8sTarget,
        started: u64,
        spawn: impl FnOnce(u64) -> (tokio::task::AbortHandle, tokio::sync::watch::Sender<bool>),
    ) -> Option<u64> {
        let epochs = locked(&self.epochs);
        if *epochs.get(t).unwrap_or(&0) != started {
            return None;
        }
        let mut watches = locked(&self.watches);
        let id = self.next_watch.fetch_add(1, Ordering::Relaxed) + 1;
        let (handle, cancel) = spawn(id);
        watches.insert(id, WatchEntry { target: t.clone(), handle, cancel: Some(cancel) });
        Some(id)
    }

    pub fn forget_watch(&self, id: u64) {
        locked(&self.watches).remove(&id);
    }

    pub fn unwatch(&self, id: u64) {
        if let Some(w) = locked(&self.watches).remove(&id) {
            w.stop();
        }
    }

    pub fn session(&self, t: &K8sTarget) -> Result<Arc<Session>, AppError> {
        locked(&self.sessions).get(t).cloned().ok_or_else(|| AppError::other(NOT_OPENED))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sContextInfo {
    pub arn: String,
    pub endpoint: String,
    pub version: String,
    pub endpoint_public: bool,
    pub endpoint_private: bool,
    pub public_cidrs: Vec<String>,
    pub kubeconfig_paths: Vec<String>,
    pub kubeconfig_missing: bool,
    pub candidates: Vec<Candidate>,
    pub chosen: Option<String>,
    pub saved_missing: Option<String>,
    pub update_command: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sSession {
    pub context: String,
    pub exec_profile: Option<String>,
    pub identity: Identity,
    pub server_version: String,
}

fn kubeconfig_search(setting: Option<&str>) -> Vec<PathBuf> {
    let env = std::env::var("KUBECONFIG").ok();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    kubeconfig::kubeconfig_paths(setting, env.as_deref(), home.as_deref())
}

/// 어느 경로에도 파일이 없을 때만 true
fn none_exists(paths: &[PathBuf]) -> bool {
    !paths.iter().any(|p| p.is_file())
}

fn display_paths(paths: &[PathBuf]) -> Vec<String> {
    paths.iter().map(|p| p.display().to_string()).collect()
}

#[tauri::command]
pub async fn k8s_context(app: State<'_, AppState>, target: K8sTarget, kubeconfig: Option<String>, saved: Option<String>) -> Result<K8sContextInfo, AppError> {
    let cfg = app.ctx.config(&target.profile, &target.region).await?;
    let info = describe_cluster(&cfg, &target.cluster).await?;
    let update_command = kubeconfig::update_command(&target.cluster, &target.region, &target.profile);
    let paths = kubeconfig_search(kubeconfig.as_deref());
    let missing = none_exists(&paths);
    let (loaded_paths, candidates) = if missing {
        (display_paths(&paths), vec![])
    } else {
        let loaded = kubeconfig::load(&paths)?;
        (display_paths(&loaded.paths), kubeconfig::candidates(&loaded.config, &info.arn, &info.endpoint))
    };
    // kubeconfig가 없으면 저장값이 사라졌다는 안내는 의미가 없다
    let (chosen, saved_missing) = if missing { (None, None) } else { kubeconfig::choose(&candidates, saved.as_deref()) };
    Ok(K8sContextInfo {
        arn: info.arn,
        endpoint: info.endpoint,
        version: info.version,
        endpoint_public: info.endpoint_public,
        endpoint_private: info.endpoint_private,
        public_cidrs: info.public_cidrs,
        kubeconfig_paths: loaded_paths,
        kubeconfig_missing: missing,
        candidates,
        chosen,
        saved_missing,
        update_command,
    })
}

#[tauri::command]
pub async fn k8s_open(app: State<'_, AppState>, k8s: State<'_, K8sState>, target: K8sTarget, kubeconfig: Option<String>, context: String) -> Result<K8sSession, AppError> {
    let started = k8s.epoch(&target);
    let cfg = app.ctx.config(&target.profile, &target.region).await?;
    let info = describe_cluster(&cfg, &target.cluster).await?;
    let endpoint = Endpoint { public: info.endpoint_public, private: info.endpoint_private };
    let loaded = kubeconfig::load(&kubeconfig_search(kubeconfig.as_deref()))?;
    let candidate = kubeconfig::candidates(&loaded.config, &info.arn, &info.endpoint)
        .into_iter()
        .find(|c| c.name == context)
        .ok_or_else(|| AppError::other(NO_CONTEXT))?;
    let client = connect::connect(&loaded, &context, endpoint).await?;
    let identity = review::identity(&client, &candidate.user, endpoint).await?;
    let version = tokio::time::timeout(connect::REQUEST_TIMEOUT, client.apiserver_version())
        .await
        .map_err(|_| describe(&Failure::Unreachable, endpoint))?
        .map_err(|e| describe(&failure_of(&e, "get", "version"), endpoint))?;
    let session = Session { client, endpoint, context };
    let context = session.context.clone();
    if !k8s.keep(&target, started, session) {
        return Err(AppError::other(NOT_OPENED));
    }
    Ok(K8sSession { context, exec_profile: candidate.exec_profile, identity, server_version: version.git_version })
}

#[tauri::command]
pub fn k8s_close(k8s: State<'_, K8sState>, target: K8sTarget) {
    k8s.close(&target);
}

#[tauri::command]
pub async fn k8s_rules(k8s: State<'_, K8sState>, target: K8sTarget, namespace: String) -> Result<Rules, AppError> {
    let s = k8s.session(&target)?;
    review::rules(&s.client, &namespace, s.endpoint).await
}

/// 작업이 끝나거나 패닉으로 풀릴 때 `watches`에서 자기 항목을 지운다
struct ForgetWatch {
    app: tauri::AppHandle,
    id: u64,
}

impl Drop for ForgetWatch {
    fn drop(&mut self) {
        self.app.state::<K8sState>().forget_watch(self.id);
    }
}

/// 목록을 지켜본다. 처음 목록은 `reset`, 이후 변경은 묶어서 `changes`로 채널에 흘린다. 반환값은 `k8s_unwatch`에 쓰는 번호.
#[tauri::command]
pub fn k8s_watch(
    app: tauri::AppHandle,
    k8s: State<'_, K8sState>,
    target: K8sTarget,
    kind: KindRef,
    namespace: Option<String>,
    on_event: tauri::ipc::Channel<WatchMessage>,
) -> Result<u64, AppError> {
    let started = k8s.epoch(&target);
    let session = k8s.session(&target)?;
    let (client, endpoint) = (session.client.clone(), session.endpoint);
    k8s.register_watch(&target, started, |id| {
        let task = tauri::async_runtime::spawn(async move {
            // 끝나는 길이 무엇이든(패닉 포함) 항목을 지운다
            let _forget = ForgetWatch { app, id };
            watch::run(client, kind, namespace, endpoint, move |m| on_event.send(m).is_ok()).await;
        });
        task.inner().abort_handle()
    })
    .ok_or_else(|| AppError::other(NOT_OPENED))
}

/// watch, 로그, drain 흐름을 멈춘다(번호는 `k8s_watch`·`k8s_logs`·`k8s_drain`이 돌려준 것). drain은 지금 하는 Eviction을 마치고 멈춘다.
#[tauri::command]
pub fn k8s_unwatch(k8s: State<'_, K8sState>, watch_id: u64) {
    k8s.unwatch(watch_id);
}

/// Pod 컨테이너 로그를 채널로 흘린다. watch처럼 대상이 닫히면 멈추고, 반환값은 `k8s_unwatch`에 쓰는 번호.
#[tauri::command]
pub fn k8s_logs(
    app: tauri::AppHandle,
    k8s: State<'_, K8sState>,
    target: K8sTarget,
    namespace: String,
    pod: String,
    options: LogOptions,
    on_event: tauri::ipc::Channel<LogMessage>,
) -> Result<u64, AppError> {
    let started = k8s.epoch(&target);
    let session = k8s.session(&target)?;
    let (client, endpoint) = (session.client.clone(), session.endpoint);
    k8s.register_watch(&target, started, |id| {
        let task = tauri::async_runtime::spawn(async move {
            let _forget = ForgetWatch { app, id };
            logs::run(client, namespace, pod, options, endpoint, move |m| on_event.send(m).is_ok()).await;
        });
        task.inner().abort_handle()
    })
    .ok_or_else(|| AppError::other(NOT_OPENED))
}

/// 클러스터가 내주는 종류(목록·watch가 되는 것). 사용자 정의 리소스 목록을 만든다.
#[tauri::command]
pub async fn k8s_kinds(k8s: State<'_, K8sState>, target: K8sTarget) -> Result<Vec<Kind>, AppError> {
    let s = k8s.session(&target)?;
    let discovery = kinds::discover(&s.client, s.endpoint).await?;
    Ok(kinds::kinds_of(&discovery))
}

/// 상세 화면. 소유 관계, 컨테이너, 이벤트, YAML(Secret 값은 가림)을 한 번에 돌려준다.
#[tauri::command]
pub async fn k8s_get(k8s: State<'_, K8sState>, target: K8sTarget, kind: KindRef, namespace: Option<String>, name: String) -> Result<ObjectView, AppError> {
    let s = k8s.session(&target)?;
    detail::get(&s.client, &kind, namespace.as_deref(), &name, s.endpoint).await
}

/// 개요. 부분마다 실패를 `gaps`에 담아 돌려주므로 연결이 없을 때와 AWS 프로필 설정을 읽지 못할 때만 실패한다.
#[tauri::command]
pub async fn k8s_overview(app: State<'_, AppState>, k8s: State<'_, K8sState>, target: K8sTarget) -> Result<Overview, AppError> {
    let s = k8s.session(&target)?;
    let cfg = app.ctx.config(&target.profile, &target.region).await?;
    Ok(overview::overview(&aws_sdk_eks::Client::new(&cfg), &target.cluster, &s.client, s.endpoint).await)
}

/// Secret 키 하나의 값. 화면이 "값 보기"를 누를 때만 부른다. 값은 기록·오류에 넣지 않는다.
#[tauri::command]
pub async fn k8s_secret_value(k8s: State<'_, K8sState>, target: K8sTarget, namespace: String, name: String, key: String) -> Result<SecretValue, AppError> {
    let s = k8s.session(&target)?;
    secret::secret_value(&s.client, &namespace, &name, &key, s.endpoint).await
}

/// 롤아웃 대상의 소유 리비전만 고른다.
#[tauri::command]
pub async fn k8s_revisions(k8s: State<'_, K8sState>, target: K8sTarget, object: ChangeObject) -> Result<Vec<commit::Revision>, AppError> {
    let session = k8s.session(&target)?;
    commit::revisions(session.client.clone(), session.endpoint, &object).await
}

/// 되살릴 객체는 이 클러스터의 변경 기록에서 나온 역변경이어야 한다.
fn check_recreate(k8s: &K8sState, target: &K8sTarget, change: &Change) -> Result<(), AppError> {
    if matches!(change.operation, Operation::Recreate { .. })
        && !log::read_all(&k8s.log_path).iter().any(|entry| entry.target == *target && entry.ok && !entry.undone && entry.inverse.as_ref() == Some(change))
    {
        return Err(AppError::other(log::UNDO_UNAVAILABLE));
    }
    Ok(())
}


#[tauri::command]
pub async fn k8s_preview(k8s: State<'_, K8sState>, target: K8sTarget, change: Change) -> Result<Preview, AppError> {
    check_recreate(&k8s, &target, &change)?;
    let session = k8s.session(&target)?;
    let epoch = k8s.epoch(&target);
    let now = now_secs();
    let at = iso(now);
    let plan = commit::dry_plan(session.client.clone(), session.endpoint, &change, &at).await?;
    if k8s.epoch(&target) != epoch || !Arc::ptr_eq(&session, &k8s.session(&target)?) {
        return Err(AppError::other(NOT_OPENED));
    }
    let preview = plan.preview.clone();
    locked(&k8s.plans).remember(&target.profile, &(&target, &change), StoredPlan { plan, at, epoch, session }, now);
    Ok(preview)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sApplyResult {
    log_id: String,
}

#[tauri::command]
pub async fn k8s_apply(k8s: State<'_, K8sState>, target: K8sTarget, change: Change, confirm_text: Option<String>, undo_of: Option<String>) -> Result<K8sApplyResult, AppError> {
    // drain은 진행을 채널로 알리는 `k8s_drain`으로만 적용한다
    if matches!(change.operation, Operation::Drain) {
        return Err(AppError::other(INVALID_CHANGE));
    }
    let session = k8s.session(&target)?;
    let seen = locked(&k8s.plans).take(&target.profile, &(&target, &change), now_secs()).ok_or_else(|| AppError::other(exec::STALE))?;
    if k8s.epoch(&target) != seen.epoch || !Arc::ptr_eq(&session, &seen.session) {
        return Err(AppError::other(exec::STALE));
    }
    check_recreate(&k8s, &target, &change)?;
    if let Some(id) = &undo_of {
        let undo = log::undo(&log::read_all(&k8s.log_path), id)?;
        if undo.target != target || undo.change != change {
            return Err(AppError::other(log::UNDO_UNAVAILABLE));
        }
    } else if matches!(change.operation, Operation::Recreate { .. }) {
        return Err(AppError::other(log::UNDO_UNAVAILABLE));
    }
    let (plan, outcome) = commit::apply_plan(session.client.clone(), session.endpoint, &change, &seen.plan, &seen.at, confirm_text.as_deref()).await?;
    let now = now_secs();
    let id = new_log_id(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let inverse = if outcome.is_ok() {
        plan.inverse
    } else {
        None
    };
    let entry = log::Entry {
        id: id.clone(),
        at: iso(now),
        target,
        change,
        summary: plan.preview.impact.join(", "),
        ok: outcome.is_ok(),
        error: outcome.as_ref().err().map(ToString::to_string),
        inverse,
        undo_of: undo_of.clone(),
        undone: false,
    };
    log::append(&k8s.log_path, &entry).map_err(|_| AppError::other(RECORD_FAILED))?;
    if outcome.is_ok() {
        if let Some(original) = undo_of {
            log::mark_undone(&k8s.log_path, &original).map_err(|_| AppError::other(UNDO_RECORD_FAILED))?;
        }
    }
    outcome?;
    Ok(K8sApplyResult { log_id: id })
}

/// 노드를 drain한다. 미리보기(`k8s_preview`)한 계획과 노드 이름 입력을 확인하고 곧바로 돌아오며,
/// cordon과 Eviction 진행은 채널로 흘린다. 반환값은 멈출 때 쓰는 번호(`k8s_unwatch`).
#[tauri::command]
pub async fn k8s_drain(
    app: tauri::AppHandle,
    k8s: State<'_, K8sState>,
    target: K8sTarget,
    node: String,
    confirm_text: Option<String>,
    on_event: tauri::ipc::Channel<DrainMessage>,
) -> Result<u64, AppError> {
    let session = k8s.session(&target)?;
    let change = Change {
        target: ChangeObject { kind: node_kind(), namespace: None, name: node },
        operation: Operation::Drain,
    };
    let seen = locked(&k8s.plans).take(&target.profile, &(&target, &change), now_secs()).ok_or_else(|| AppError::other(exec::STALE))?;
    if k8s.epoch(&target) != seen.epoch || !Arc::ptr_eq(&session, &seen.session) {
        return Err(AppError::other(exec::STALE));
    }
    let current = commit::make_plan(session.client.clone(), session.endpoint, &change, &seen.at).await?;
    commit::check_drain(Some(&seen.plan), &current, confirm_text.as_deref())?;
    let plan = current.preview.drain.ok_or_else(|| AppError::other(INVALID_CHANGE))?;
    let job = Job {
        client: session.client.clone(),
        endpoint: session.endpoint,
        log_path: k8s.log_path.clone(),
        target: target.clone(),
        change,
        plan,
        at: seen.at,
        limits: Limits::default(),
    };
    k8s.register_drain(&target, seen.epoch, |id| {
        let (cancel, signal) = tokio::sync::watch::channel(false);
        let task = tauri::async_runtime::spawn(async move {
            // 끝나는 길이 무엇이든(패닉 포함) 항목을 지운다
            let _forget = ForgetWatch { app, id };
            drain_apply::apply(job, signal, move |m| on_event.send(m).is_ok()).await;
        });
        (task.inner().abort_handle(), cancel)
    })
    .ok_or_else(|| AppError::other(NOT_OPENED))
}

fn node_kind() -> KindRef {
    KindRef { group: String::new(), version: "v1".into(), kind: "Node".into(), plural: "nodes".into(), namespaced: false }
}

#[tauri::command]
pub fn k8s_change_log(k8s: State<'_, K8sState>) -> Vec<log::Entry> {
    let mut entries = log::read_all(&k8s.log_path);
    entries.reverse();
    entries
}

#[tauri::command]
pub fn k8s_undo(k8s: State<'_, K8sState>, log_id: String) -> Result<log::Undo, AppError> {
    log::undo(&log::read_all(&k8s.log_path), &log_id)
}

#[cfg(test)]
mod tests;
