//! EKS 탭의 명령. 대상(프로필·리전·클러스터)마다 열린 연결 하나(`Session`)를 둔다.
//! 열기는 시작할 때 대상의 닫힌 횟수(`epoch`)를 읽어 두고, 끝날 때 그사이 닫혔으면 연결을 버린다(PG 탭과 같은 규칙).
//! 잠금 순서: `epochs`, `sessions`, `watches`. 두 잠금을 함께 잡는 곳은 모두 이 순서를 지킨다. `terminals`는 `watches` 다음에만 잡는다.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::{Manager, State};

use crate::commands::AppState;
use crate::error::AppError;
use crate::k8s::connect;
use crate::k8s::failure::{describe, failure_of, Endpoint, Failure, NOT_OPENED};
use crate::k8s::kubeconfig::{self, Candidate, NO_CONTEXT};
use crate::k8s::read::detail::{self, ObjectView};
use crate::k8s::read::kinds::{self, Kind};
use crate::k8s::read::overview::{self, Overview};
use crate::k8s::read::secret::{self, SecretValue};
use crate::k8s::review::{self, Identity, Rules};
use crate::k8s::lnav::{self, Cleanup, LnavMessage, Spawned, LNAV_MISSING, LOG_FILE_FAILED, LOG_WRITE_FAILED};
use crate::k8s::logs::{self, LogMessage, LogOptions};
use crate::k8s::path::login_path;
use crate::k8s::rows::KindRef;
use crate::k8s::target::{describe_cluster, K8sTarget};
use crate::k8s::watch::{self, WatchMessage};

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
    /// lnav를 띄운 로그 흐름(키 입력, 크기 조절, 뒷정리). 번호는 watch 번호와 같다. 항목을 지우면 lnav도 끝나고 로그 파일도 지워진다.
    terminals: Mutex<HashMap<u64, Terminal>>,
    /// 앱이 끝나는 중이면 새 lnav를 띄우지 않는다
    closing: std::sync::atomic::AtomicBool,
}

struct Terminal {
    /// `lnav::input_worker`로 가는 키 입력
    input: std::sync::mpsc::Sender<Vec<u8>>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    cleanup: Cleanup,
}

/// 돌고 있는 watch 하나. 대상이 닫히면 같은 대상의 것을 모두 멈춘다.
struct WatchEntry {
    target: K8sTarget,
    handle: tokio::task::AbortHandle,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl K8sState {
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
                    w.handle.abort();
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
                w.handle.abort();
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
        watches.insert(id, WatchEntry { target: t.clone(), handle: spawn(id) });
        Some(id)
    }

    pub fn forget_watch(&self, id: u64) {
        locked(&self.watches).remove(&id);
    }

    pub fn unwatch(&self, id: u64) {
        if let Some(w) = locked(&self.watches).remove(&id) {
            w.handle.abort();
        }
    }

    pub fn session(&self, t: &K8sTarget) -> Result<Arc<Session>, AppError> {
        locked(&self.sessions).get(t).cloned().ok_or_else(|| AppError::other(NOT_OPENED))
    }

    fn put_terminal(&self, id: u64, t: Terminal) {
        locked(&self.terminals).insert(id, t);
    }

    fn forget_terminal(&self, id: u64) {
        // 뒷정리(Cleanup)는 잠금을 놓은 뒤에 버린다
        let gone = locked(&self.terminals).remove(&id);
        drop(gone);
    }

    /// 화면의 키 입력을 lnav에 넘긴다(쓰기는 입력 스레드가 한다). 이미 끝난 흐름이면 버린다.
    pub fn terminal_input(&self, id: u64, data: &[u8]) {
        if let Some(t) = locked(&self.terminals).get(&id) {
            let _ = t.input.send(data.to_vec());
        }
    }

    pub fn terminal_resize(&self, id: u64, cols: u16, rows: u16) {
        if let Some(t) = locked(&self.terminals).get(&id) {
            let _ = t.master.resize(lnav::size(cols, rows));
        }
    }

    /// 앱이 끝날 때: 새 lnav를 막고, 떠 있는 lnav를 모두 그 자리에서 끝내고, 이 앱의 로그 폴더를 통째로 지운다
    /// (종료는 비동기 작업을 버리지 않고 프로세스를 끝내므로 여기서 직접 한다. 막 만들어지던 파일도 폴더와 함께 지워지고, 그보다 늦은 것은 다음 실행의 `sweep_stale`이 지운다).
    pub fn shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        let all: Vec<Terminal> = locked(&self.terminals).drain().map(|(_, t)| t).collect();
        for mut t in all {
            t.cleanup.finish_now();
        }
        let _ = std::fs::remove_dir_all(lnav::process_dir(&lnav::logs_root()));
    }

    fn closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }
}

/// 작업이 어떻게 끝나든 PTY 항목을 지운다
struct ForgetTerminal {
    app: tauri::AppHandle,
    id: u64,
}

impl Drop for ForgetTerminal {
    fn drop(&mut self) {
        if let Some(k8s) = self.app.try_state::<K8sState>() {
            k8s.forget_terminal(self.id);
        }
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

/// watch와 로그 흐름을 멈춘다(번호는 `k8s_watch`·`k8s_logs`가 돌려준 것)
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

/// 설치된 lnav가 있는지(로그인 셸의 PATH에서 찾는다)
#[tauri::command]
pub async fn k8s_lnav_available() -> bool {
    lnav::find_lnav().await.is_some()
}

/// Pod 로그를 lnav로 본다. 로그 줄은 본인만 읽는 임시 파일에 이어 쓰고, lnav는 PTY에서 그 파일을 따라간다.
/// PTY 출력과 로그 흐름의 오류·끝, lnav 종료는 채널로 보낸다. 반환값은 `k8s_unwatch`(멈춤), `k8s_lnav_input`, `k8s_lnav_resize`에 쓰는 번호.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn k8s_lnav(
    app: tauri::AppHandle,
    k8s: State<'_, K8sState>,
    target: K8sTarget,
    namespace: String,
    pod: String,
    options: LogOptions,
    cols: u16,
    rows: u16,
    on_event: tauri::ipc::Channel<LnavMessage>,
) -> Result<u64, AppError> {
    let program = lnav::find_lnav().await.ok_or_else(|| AppError::other(LNAV_MISSING))?;
    if k8s.closing() {
        return Err(AppError::other(NOT_OPENED));
    }
    let started = k8s.epoch(&target);
    let session = k8s.session(&target)?;
    let (client, endpoint) = (session.client.clone(), session.endpoint);
    let (path, mut file) = lnav::log_file(&lnav::logs_root()).map_err(|_| AppError::other(LOG_FILE_FAILED))?;
    let spawned = lnav::spawn(&program, &[path.as_path()], cols, rows, login_path().await);
    let Spawned { child, reader, writer, master } = match spawned {
        Ok(s) => s,
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
    };
    // 항목을 지우거나(작업 끝) 등록하지 못해 버려지면(그사이 대상이 닫힘) lnav를 끝내고 파일을 지운다
    let terminal = Terminal { input: lnav::input_worker(writer), master, cleanup: Cleanup::new(child, path) };
    if k8s.closing() {
        // 버리면 그 자리에서 파일을 지우고 lnav를 죽인다
        drop(terminal);
        return Err(AppError::other(NOT_OPENED));
    }
    k8s.register_watch(&target, started, |id| {
        k8s.put_terminal(id, terminal);
        // 첫 실행 전에 중단돼도 항목이 남지 않도록 지킴이를 먼저 만들어 작업에 넘긴다
        let forget = (ForgetWatch { app: app.clone(), id }, ForgetTerminal { app, id });
        let task = tauri::async_runtime::spawn(async move {
            let _forget = forget;
            let out = on_event.clone();
            let mut pump = tokio::task::spawn_blocking(move || lnav::pump(reader, move |m| out.send(m).is_ok()));
            let logs = logs::run(client, namespace, pod, options, endpoint, move |m| match lnav::write_log(&mut file, m) {
                Ok(None) => true,
                Ok(Some(msg)) => on_event.send(msg).is_ok(),
                // 디스크가 가득 차는 등: 알리고 받기를 멈춘다(lnav는 받은 데까지 계속 보여준다)
                Err(_) => {
                    let _ = on_event.send(LnavMessage::LogError { error: AppError::other(LOG_WRITE_FAILED) });
                    false
                }
            });
            // 로그가 먼저 끝나면(따라가지 않을 때) lnav는 사용자가 닫을 때까지 둔다. lnav가 먼저 끝나면 로그도 멈춘다.
            tokio::select! {
                _ = logs => { let _ = (&mut pump).await; }
                _ = &mut pump => {}
            }
        });
        task.inner().abort_handle()
    })
    .ok_or_else(|| AppError::other(NOT_OPENED))
}

#[tauri::command]
pub fn k8s_lnav_input(k8s: State<'_, K8sState>, id: u64, data: String) {
    k8s.terminal_input(id, data.as_bytes());
}

#[tauri::command]
pub fn k8s_lnav_resize(k8s: State<'_, K8sState>, id: u64, cols: u16, rows: u16) {
    k8s.terminal_resize(id, cols, rows);
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

#[cfg(test)]
mod tests;
