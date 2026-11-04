//! EKS 탭의 명령. 대상(프로필·리전·클러스터)마다 열린 연결 하나(`Session`)를 둔다.
//! 열기는 시작할 때 대상의 닫힌 횟수(`epoch`)를 읽어 두고, 끝날 때 그사이 닫혔으면 연결을 버린다(PG 탭과 같은 규칙).
//! 잠금 순서: `epochs`, `sessions`, `watches`, 그리고 맨 뒤에 `shells`·`forwards`(각자 안의 잠금). 두 잠금을 함께 잡는 곳은 모두 이 순서를 지킨다.
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
use crate::k8s::change::{self, Change, ChangeObject, Operation, Plan, Preview, INVALID_CHANGE};
use crate::k8s::drain::apply::{self as drain_apply, Job};
use crate::k8s::drain::run::{DrainMessage, Limits};
use crate::k8s::{commit, exec, helm, log, node_shell};
use crate::k8s::connect;
use crate::k8s::forward::{self, Forward, ForwardRequest, Forwards};
use crate::k8s::failure::{describe, failure_of, Endpoint, Failure, NOT_OPENED};
use crate::k8s::kubeconfig::{self, Candidate, NO_CONTEXT};
use crate::k8s::read::detail::{self, ObjectView};
use crate::k8s::read::kinds::{self, Kind};
use crate::k8s::read::overview::{self, Overview};
use crate::k8s::read::secret::{self, SecretValue};
use crate::k8s::review::{self, Identity, Rules};
use crate::k8s::logs::{self, LogMessage, LogOptions};
use crate::k8s::rows::KindRef;
use crate::k8s::shell::{self, ShellMessage, ShellMode, ShellOpened, ShellTarget, Shells};
use crate::k8s::target::{describe_cluster, K8sTarget};
use crate::k8s::watch::{self, WatchMessage};

/// 앱을 끌 때 노드 셸 Pod 지우기를 기다리는 시간
const CLEANUP_WAIT: std::time::Duration = std::time::Duration::from_secs(10);
pub const RECORD_FAILED: &str = "변경 결과를 기록하지 못했어요";
pub const UNDO_RECORD_FAILED: &str = "되돌리기 기록을 갱신하지 못했어요";

pub struct Session {
    pub client: kube::Client,
    pub endpoint: Endpoint,
    pub context: String,
    /// 로그인 PATH를 넣은 kubeconfig. 재시도 없는 Eviction용 클라이언트를 drain 때 만든다.
    pub kubeconfig: kube::config::Kubeconfig,
    /// 읽은 kubeconfig 파일들. helm에 `--kubeconfig`로 넘긴다.
    pub kubeconfig_paths: Vec<PathBuf>,
}

impl Session {
    /// helm 명령이 쓰는 이 세션의 클러스터 정보
    pub fn helm(&self) -> helm::Cluster {
        helm::Cluster { client: self.client.clone(), endpoint: self.endpoint, context: self.context.clone(), kubeconfig_paths: self.kubeconfig_paths.clone() }
    }
}

#[derive(Default)]
pub struct K8sState {
    sessions: Mutex<HashMap<K8sTarget, Arc<Session>>>,
    epochs: Mutex<HashMap<K8sTarget, u64>>,
    watches: Mutex<HashMap<u64, WatchEntry>>,
    next_watch: AtomicU64,
    shells: Arc<Shells>,
    node_shells: Arc<node_shell::NodeShells>,
    forwards: Arc<Forwards>,
    plans: Mutex<PlanStore<StoredPlan>>,
    /// 장바구니(권한 변경 일괄) 미리보기에서 본 계획들
    batches: Mutex<PlanStore<StoredBatch>>,
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

/// 일괄 미리보기에서 사용자가 본 계획들(변경 순서대로)
#[derive(Clone)]
struct StoredBatch {
    plans: Vec<Plan>,
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
            self.shells.close_target(t);
            self.node_shells.close_target(t);
            self.forwards.close_target(t);
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
        self.shells.close_target(t);
        self.node_shells.close_target(t);
        self.forwards.close_target(t);
    }

    /// 앱을 끌 때: 모든 셸과 port-forward를 닫는다(셸 기록에 닫은 시각을 남기고, 노드 셸 Pod 지우기가 끝나길 잠깐 기다린다).
    pub async fn close_streams(&self) {
        self.shells.close_all();
        self.node_shells.close_all();
        self.forwards.close_all();
        self.shells.settle(CLEANUP_WAIT).await;
        self.node_shells.settle(CLEANUP_WAIT).await;
    }

    /// 시작할 때의 `epoch`와 같을 때만 `register`를 실행한다(실행하는 동안 `epochs` 잠금을 쥔다). 다르면(그사이 닫힘) None.
    pub fn while_current<T>(&self, t: &K8sTarget, started: u64, register: impl FnOnce() -> T) -> Option<T> {
        let epochs = locked(&self.epochs);
        if *epochs.get(t).unwrap_or(&0) != started {
            return None;
        }
        Some(register())
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

    /// 열려 있는 셸 세션들. 로컬 터미널도 같은 목록에 올라서 대상을 닫거나 앱을 끌 때 함께 닫힌다.
    pub fn shells(&self) -> &Arc<Shells> {
        &self.shells
    }

    /// 변경 기록 파일
    pub fn log_path(&self) -> &std::path::Path {
        &self.log_path
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
    let (client, kubeconfig) = connect::connect(&loaded, &context, endpoint).await?;
    let identity = review::identity(&client, &candidate.user, endpoint).await?;
    let version = tokio::time::timeout(connect::REQUEST_TIMEOUT, client.apiserver_version())
        .await
        .map_err(|_| describe(&Failure::Unreachable, endpoint))?
        .map_err(|e| describe(&failure_of(&e, "get", "version"), endpoint))?;
    let session = Session { client, endpoint, context, kubeconfig, kubeconfig_paths: loaded.paths.clone() };
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

/// 워크로드가 선택한 Pod의 로그를 지켜본다.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn k8s_workload_logs(
    app: tauri::AppHandle,
    k8s: State<'_, K8sState>,
    target: K8sTarget,
    kind: KindRef,
    namespace: String,
    name: String,
    options: LogOptions,
    on_event: tauri::ipc::Channel<LogMessage>,
) -> Result<u64, AppError> {
    let started = k8s.epoch(&target);
    let session = k8s.session(&target)?;
    let (client, endpoint) = (session.client.clone(), session.endpoint);
    k8s.register_watch(&target, started, |id| {
        let task = tauri::async_runtime::spawn(async move {
            let _forget = ForgetWatch { app, id };
            logs::workload(client, kind, namespace, name, options, endpoint, move |m| on_event.send(m).is_ok()).await;
        });
        task.inner().abort_handle()
    }).ok_or_else(|| AppError::other(NOT_OPENED))
}

#[tauri::command]
pub async fn k8s_logs_save(file_name: String, text: String) -> Result<String, AppError> {
    logs::save(file_name, text).await
}

/// 셸(exec) 세션을 연다. 터미널 출력은 채널로 흐르고 반환값의 번호로 입력·크기·닫기를 한다.
/// 위험한 네임스페이스·Pod(`change::dangerous`)는 `confirm_text`가 Pod 이름과 같아야 한다. 열고 닫은 시각은 변경 기록에 남는다.
#[tauri::command]
pub async fn k8s_shell_open(
    k8s: State<'_, K8sState>,
    target: K8sTarget,
    namespace: String,
    pod: String,
    container: String,
    confirm_text: Option<String>,
    on_event: tauri::ipc::Channel<ShellMessage>,
) -> Result<ShellOpened, AppError> {
    open_shell(&k8s, ShellMode::Exec, target, namespace, pod, container, confirm_text, on_event).await
}

/// 컨테이너의 주 프로세스에 attach한다. 입력은 컨테이너에 `stdin`과 `tty`가 켜져 있을 때만 간다(`input`).
#[tauri::command]
pub async fn k8s_attach_open(
    k8s: State<'_, K8sState>,
    target: K8sTarget,
    namespace: String,
    pod: String,
    container: String,
    confirm_text: Option<String>,
    on_event: tauri::ipc::Channel<ShellMessage>,
) -> Result<ShellOpened, AppError> {
    open_shell(&k8s, ShellMode::Attach, target, namespace, pod, container, confirm_text, on_event).await
}

#[allow(clippy::too_many_arguments)]
async fn open_shell(
    k8s: &K8sState,
    mode: ShellMode,
    target: K8sTarget,
    namespace: String,
    pod: String,
    container: String,
    confirm_text: Option<String>,
    on_event: tauri::ipc::Channel<ShellMessage>,
) -> Result<ShellOpened, AppError> {
    shell::check_confirm(&namespace, &pod, confirm_text.as_deref())?;
    let started = k8s.epoch(&target);
    let session = k8s.session(&target)?;
    let connected = shell::connect(session.client.clone(), mode, &namespace, &pod, &container, &shell::SHELL_COMMAND, session.endpoint).await?;
    let info = ShellTarget { target: target.clone(), namespace, pod, container, mode };
    k8s.while_current(&target, started, || k8s.shells.start(&k8s.log_path, info, connected, None, move |m| on_event.send(m).is_ok()))
        .ok_or_else(|| AppError::other(NOT_OPENED))?
}

/// 셸·attach를 열 때 입력해야 하는 이름. 위험하지 않으면 없다(화면이 확인 창에 입력칸을 둘지 정한다).
#[tauri::command]
pub fn k8s_shell_confirm_name(namespace: String, pod: String) -> Option<String> {
    change::confirm_name(Some(&namespace), &pod)
}

/// 노드 셸을 연다: 변경 틀로 만든 노드 셸 Pod가 준비되길 기다렸다가 노드의 PID 1 네임스페이스로 들어가는 셸을 연다.
/// 열지 못하면, 그리고 셸을 닫거나 탭을 닫거나 앱을 끌 때 Pod를 지운다(변경 기록에 남는다).
#[tauri::command]
pub async fn k8s_node_shell_open(
    k8s: State<'_, K8sState>,
    target: K8sTarget,
    namespace: String,
    pod: String,
    on_event: tauri::ipc::Channel<ShellMessage>,
) -> Result<ShellOpened, AppError> {
    let started = k8s.epoch(&target);
    let session = k8s.session(&target)?;
    let (client, endpoint) = (session.client.clone(), session.endpoint);
    // 변경 틀로 확인해 만든 Pod(UID까지 같은 것)만 연다. 표시만 같은 Pod(YAML 적용으로 만든 것 등)는 거부한다.
    let claimed = k8s.node_shells.claim(&target, &namespace, &pod)?;
    let remove = claimed.remove.clone();
    let opened = async {
        node_shell::wait_ready(client.clone(), &namespace, &pod, &claimed.uid, endpoint).await?;
        let mut command = change::NODE_SHELL_COMMAND.to_vec();
        command.push("sh");
        let connected = shell::connect(client.clone(), ShellMode::Exec, &namespace, &pod, change::NODE_SHELL_CONTAINER, &command, endpoint).await?;
        let info = ShellTarget { target: target.clone(), namespace: namespace.clone(), pod: pod.clone(), container: change::NODE_SHELL_CONTAINER.into(), mode: ShellMode::Exec };
        // 세션이 끝나면 Pod를 지우고 등록을 잊는다
        let cleanup: shell::Cleanup = Box::new({
            let (remove, node_shells, namespace, pod) = (remove.clone(), k8s.node_shells.clone(), namespace.clone(), pod.clone());
            move || {
                Box::pin(async move {
                    (*remove)().await;
                    node_shells.forget(&namespace, &pod);
                })
            }
        });
        k8s.while_current(&target, started, || k8s.shells.start(&k8s.log_path, info, connected, Some(cleanup), move |m| on_event.send(m).is_ok()))
            .ok_or_else(|| AppError::other(NOT_OPENED))?
    }
    .await;
    if opened.is_err() {
        (*remove)().await;
        k8s.node_shells.forget(&namespace, &pod);
    }
    opened
}

/// 터미널 입력(키 입력)을 보낸다. 이미 끝난 세션이면 무시한다.
#[tauri::command]
pub async fn k8s_shell_input(k8s: State<'_, K8sState>, shell_id: u64, data: String) -> Result<(), AppError> {
    k8s.shells.input(shell_id, data);
    Ok(())
}

#[tauri::command]
pub async fn k8s_shell_resize(k8s: State<'_, K8sState>, shell_id: u64, cols: u16, rows: u16) -> Result<(), AppError> {
    k8s.shells.resize(shell_id, cols, rows);
    Ok(())
}

#[tauri::command]
pub fn k8s_shell_close(k8s: State<'_, K8sState>, shell_id: u64) {
    k8s.shells.close(shell_id);
}

/// 로컬 `127.0.0.1` 포트를 Pod나 Service에 이어 준다. 포트는 지정하지 않으면 자동.
#[tauri::command]
pub async fn k8s_forward_open(k8s: State<'_, K8sState>, target: K8sTarget, request: ForwardRequest) -> Result<Forward, AppError> {
    let started = k8s.epoch(&target);
    let session = k8s.session(&target)?;
    let prepared = forward::prepare(session.client.clone(), &request, session.endpoint).await?;
    let listener = forward::bind_local(request.local_port, request.remote_port).await?;
    k8s.while_current(&target, started, || k8s.forwards.start(target.clone(), &request, prepared, listener, session.client.clone(), session.endpoint))
        .ok_or_else(|| AppError::other(NOT_OPENED))?
}

/// 열려 있는 port-forward 전체(모든 탭). 붙은 Pod와 최근 오류는 지금 값이다.
#[tauri::command]
pub fn k8s_forward_list(k8s: State<'_, K8sState>) -> Vec<Forward> {
    k8s.forwards.list()
}

#[tauri::command]
pub fn k8s_forward_close(k8s: State<'_, K8sState>, id: u64) {
    k8s.forwards.close(id);
}

/// 클러스터가 내주는 종류(목록·watch가 되는 것). 사용자 정의 리소스 목록을 만든다.
#[tauri::command]
pub async fn k8s_kinds(k8s: State<'_, K8sState>, target: K8sTarget) -> Result<Vec<Kind>, AppError> {
    let s = k8s.session(&target)?;
    kinds::discover_kinds(&s.client, s.endpoint).await
}

/// 상세 화면. 소유 관계, 컨테이너, 이벤트, YAML(Secret 값은 가림)을 한 번에 돌려준다.
#[tauri::command]
pub async fn k8s_get(k8s: State<'_, K8sState>, target: K8sTarget, kind: KindRef, namespace: Option<String>, name: String) -> Result<ObjectView, AppError> {
    let s = k8s.session(&target)?;
    detail::get(&s.client, &kind, namespace.as_deref(), &name, s.endpoint).await
}

/// 사용량(metrics-server). 네임스페이스가 없으면 모든 네임스페이스. 서버가 없거나 권한이 없으면 오류 대신 `unavailable` 사유를 돌려준다.
#[tauri::command]
pub async fn k8s_metrics(k8s: State<'_, K8sState>, target: K8sTarget, namespace: Option<String>) -> Result<crate::k8s::read::metrics::Metrics, AppError> {
    let s = k8s.session(&target)?;
    crate::k8s::read::metrics::metrics(&s.client, namespace.as_deref(), s.endpoint).await
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
pub async fn k8s_preview(app: State<'_, AppState>, k8s: State<'_, K8sState>, target: K8sTarget, change: Change) -> Result<Preview, AppError> {
    check_recreate(&k8s, &target, &change)?;
    let session = k8s.session(&target)?;
    let epoch = k8s.epoch(&target);
    let now = now_secs();
    let at = iso(now);
    let plan = if helm::handles(&change) {
        helm::plan::dry_plan(&session.helm(), &change).await?
    } else if crate::k8s::rbac::handles(&change) {
        crate::k8s::rbac::commit::dry_plan(&rbac::context(&app, &session, &target).await?, &change).await?
    } else {
        commit::dry_plan(session.client.clone(), session.endpoint, &change, &at).await?
    };
    if k8s.epoch(&target) != epoch || !Arc::ptr_eq(&session, &k8s.session(&target)?) {
        return Err(AppError::other(NOT_OPENED));
    }
    let preview = plan.preview.displayed();
    locked(&k8s.plans).remember(&target.profile, &(&target, &change), StoredPlan { plan, at, epoch, session }, now);
    Ok(preview)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sApplyResult {
    log_id: String,
}

#[tauri::command]
pub async fn k8s_apply(
    app: State<'_, AppState>,
    k8s: State<'_, K8sState>,
    target: K8sTarget,
    change: Change,
    confirm_text: Option<String>,
    undo_of: Option<String>,
) -> Result<K8sApplyResult, AppError> {
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
    let (plan, outcome) = if helm::handles(&change) {
        helm::plan::apply(&session.helm(), &change, &seen.plan, confirm_text.as_deref()).await?
    } else if crate::k8s::rbac::handles(&change) {
        crate::k8s::rbac::commit::apply_plan(&rbac::context(&app, &session, &target).await?, &change, &seen.plan, confirm_text.as_deref()).await?
    } else {
        commit::apply_plan(session.client.clone(), session.endpoint, &change, &seen.plan, &seen.at, confirm_text.as_deref()).await?
    };
    // 확인한 노드 셸 적용으로 만든 Pod는 만든 즉시 UID와 함께 등록한다. 그러면 터미널을 열기 전에 탭이 닫히거나 기록·열기가 실패해도 지워지고,
    // 이 Pod만 터미널을 열 수 있다(같은 표시를 단 다른 Pod는 열 수 없다).
    let mut tracked: Option<(String, String)> = None;
    let mut untracked = false;
    if let (Operation::NodeShell { .. }, true) = (&change.operation, outcome.is_ok()) {
        let (namespace, pod) = (change.target.namespace.clone().unwrap_or_default(), change.target.name.clone());
        match node_shell::read_uid(session.client.clone(), session.endpoint, &namespace, &pod).await {
            Some(uid) => {
                let remove = node_shell::remover(session.client.clone(), session.endpoint, target.clone(), namespace.clone(), pod.clone(), Some(uid.clone()), k8s.log_path.clone());
                k8s.node_shells.track(target.clone(), &namespace, &pod, uid, remove);
                tracked = Some((namespace, pod));
            }
            None => {
                // 만든 Pod를 확인하지 못하면 터미널을 열 수 없으니, 방금 만든 것(표시 확인)을 이름으로 지운다
                node_shell::remove(session.client.clone(), session.endpoint, target.clone(), namespace, pod, None, k8s.log_path.clone()).await;
                untracked = true;
            }
        }
    }
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
        // Secret 값은 기록하지 않는다
        change: crate::k8s::change::apply::redact(&change),
        summary: plan.preview.impact.join(", "),
        ok: outcome.is_ok(),
        error: outcome.as_ref().err().map(ToString::to_string),
        inverse,
        undo_of: undo_of.clone(),
        undone: false,
        closed_at: None,
    };
    if log::append(&k8s.log_path, &entry).is_err() {
        if let Some((namespace, pod)) = &tracked {
            k8s.node_shells.discard(namespace, pod);
        }
        return Err(AppError::other(RECORD_FAILED));
    }
    if outcome.is_ok() {
        if let Some(original) = undo_of {
            log::mark_undone(&k8s.log_path, &original).map_err(|_| AppError::other(UNDO_RECORD_FAILED))?;
        }
    }
    outcome?;
    if untracked {
        return Err(AppError::other(node_shell::UID_UNKNOWN));
    }
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
    // Eviction만 재시도 없는 클라이언트로 보낸다: 429를 곧바로 받아야 PDB 막힘을 우리 간격과 한도로 다룰 수 있다
    let evict_client = connect::eviction_client(&session.kubeconfig, &session.context, session.endpoint).await?;
    let job = Job {
        client: session.client.clone(),
        evict_client,
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

pub mod rbac;

#[cfg(test)]
mod tests;
