//! KV 탭(ElastiCache Valkey·Redis OSS)의 명령. 대상(탭)마다 세션(API로 읽은 접속 정보와 마지막 로그인)을 두고, 연결은 `kv::pool`이 보관한다.
//! 모든 명령은 캐시에 아무것도 쓰지 않는다: 서버에 보내는 명령은 `kv::command`의 허용 목록 관문 하나를 거친다(검사 테스트 `kv::hygiene`).
//!
//! 연결이 10분 동안 안 쓰여 닫혔으면 명령이 마지막 로그인으로 다시 붙는다. 비밀번호는 메모리에 남기지 않고 키체인에서 다시 읽는다.
//! 필요한데 저장된 것이 없으면 `LoginRequired`다. 명령은 시작할 때 대상의 닫힌 횟수(`epoch`)를 읽어 두고 연결을 열 때 넘긴다:
//! 도중에 탭이 닫히면 새 연결을 열지도 보관하지도 않는다.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::commands::AppState;
use crate::error::AppError;
use crate::kv::bull::keys::normalize_prefix;
use crate::kv::bull::model::{KvBullFlow, KvBullJob, KvBullJobsPage, KvBullQueue, KvBullQueueView, KvBullQueuesPage, KvBullState, KvBullTopology, KvBullTransitions};
use crate::kv::bull::{events, flow, jobs, queue, topology};
use crate::kv::connect::{self, Connected};
use crate::kv::login::plan_for;
use crate::kv::model::{
    KvBigKeysMessage, KvBigKeysReport, KvClient, KvKeyName, KvKeyView, KvLogin, KvLoginSaved, KvOverview, KvScanPage, KvSlowEntry, KvTarget, KvTargetInfo, KvType,
};
use crate::kv::password::Passwords;
use crate::kv::pool::{Pool, NOT_OPENED};
use crate::kv::target::{resolve as resolve_target, Resolved};
use crate::kv::reports::{report_key, BigKeysReports};
use crate::kv::{bigkeys, clients, key, overview, scan, slowlog};

/// 연결 보관함에서 오래 안 쓴 연결을 닫는 주기
pub const SWEEP_EVERY: Duration = Duration::from_secs(60);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn not_opened() -> AppError {
    AppError::other(NOT_OPENED)
}

/// 열린 대상의 세션: API로 읽은 접속 정보와 마지막으로 연 로그인(비밀 없음)
struct Session {
    resolved: Resolved,
    login: KvLoginSaved,
}

/// 읽어 둔 값들. 앱이 시작할 때 한 번 `manage`한다.
pub struct KvState {
    pub pool: Pool<Connected>,
    sessions: Mutex<HashMap<KvTarget, Arc<Session>>>,
    passwords: Passwords,
    /// 큰 키 찾기를 도는 대상의 중단 표시
    bigkeys: Mutex<HashMap<KvTarget, Arc<AtomicBool>>>,
    /// 대상·DB마다 마지막 큰 키 찾기 결과(디스크)
    reports: BigKeysReports,
}

/// 키체인 계정에 쓰는 사용자 이름: AUTH 토큰은 사용자가 없다
fn secret_user(login: &KvLoginSaved) -> &str {
    match login.mode {
        crate::kv::model::KvAuthMode::User | crate::kv::model::KvAuthMode::Iam => login.user.trim(),
        _ => "",
    }
}

impl KvState {
    /// `reports`는 큰 키 결과를 두는 파일(`kv-bigkeys.json`)
    pub fn new(reports: std::path::PathBuf) -> KvState {
        KvState { pool: Pool::default(), sessions: Mutex::default(), passwords: Passwords::default(), bigkeys: Mutex::default(), reports: BigKeysReports::load(reports) }
    }

    fn session(&self, target: &KvTarget) -> Result<Arc<Session>, AppError> {
        locked(&self.sessions).get(target).cloned().ok_or_else(not_opened)
    }

    /// 세션의 로그인으로 연결을 얻는다. 보관함에 쓸 수 있는 연결이 있으면 그것을, 없으면 새로 연결한다(비밀번호는 키체인에서 다시 읽는다).
    async fn connection(&self, app: &AppState, target: &KvTarget) -> Result<(Arc<Connected>, Arc<Session>), AppError> {
        let epoch = self.pool.epoch(target);
        let session = self.session(target)?;
        let conn = self
            .pool
            .get_or_connect_at_epoch(target, epoch, || async {
                let password = match session.login.mode {
                    crate::kv::model::KvAuthMode::Password | crate::kv::model::KvAuthMode::User => self.passwords.get(&session.resolved.info.arn, secret_user(&session.login)).await?,
                    _ => None,
                };
                let cfg = match session.login.mode {
                    crate::kv::model::KvAuthMode::Iam => Some(app.ctx.config(&target.profile, &target.region).await?),
                    _ => None,
                };
                let plan = plan_for(&session.login, password, session.resolved.clone(), cfg.as_ref(), &target.region)?;
                connect::connect(plan).await
            })
            .await?;
        Ok((conn, session))
    }

    /// 대상을 닫는다: 세션과 연결을 버리고 도는 큰 키 찾기를 멈춘다
    fn close(&self, target: &KvTarget) {
        locked(&self.sessions).remove(target);
        if let Some(stop) = locked(&self.bigkeys).get(target) {
            stop.store(true, Ordering::Relaxed);
        }
        self.pool.close_target(target);
    }
}

#[tauri::command]
pub async fn kv_target(app: State<'_, AppState>, target: KvTarget) -> Result<KvTargetInfo, AppError> {
    let cfg = app.ctx.config(&target.profile, &target.region).await?;
    Ok(resolve_target(&cfg, &target).await?.info)
}

#[tauri::command]
pub async fn kv_open(app: State<'_, AppState>, kv: State<'_, KvState>, target: KvTarget, login: KvLogin) -> Result<KvOverview, AppError> {
    let cfg = app.ctx.config(&target.profile, &target.region).await?;
    let resolved = resolve_target(&cfg, &target).await?;
    let saved = login.saved.clone();
    let user = secret_user(&saved).to_string();
    let given = login.password.clone().filter(|p| !p.is_empty());
    let password = match (&given, saved.mode) {
        (Some(_), _) => given.clone(),
        (None, crate::kv::model::KvAuthMode::Password | crate::kv::model::KvAuthMode::User) => kv.passwords.get(&resolved.info.arn, &user).await?,
        (None, _) => None,
    };
    let plan = plan_for(&saved, password, resolved.clone(), Some(&cfg), &target.region)?;
    // 로그인이 바뀔 수 있으니 이전 연결은 버리고 새로 연다
    kv.pool.close_target(&target);
    let epoch = kv.pool.epoch(&target);
    let connected = kv.pool.get_or_connect_at_epoch(&target, epoch, || connect::connect(plan)).await?;
    let arn = resolved.info.arn.clone();
    locked(&kv.sessions).insert(target.clone(), Arc::new(Session { resolved, login: saved.clone() }));
    // 연결에 성공한 뒤에만 키체인을 고친다(틀린 비밀번호는 저장하지 않는다)
    if let Some(secret) = &given {
        if login.remember_password {
            kv.passwords.set(&arn, &user, secret).await?;
        } else {
            kv.passwords.delete(&arn, &user).await?;
        }
    }
    overview::overview(&connected, saved).await
}

#[tauri::command]
pub async fn kv_overview(app: State<'_, AppState>, kv: State<'_, KvState>, target: KvTarget) -> Result<KvOverview, AppError> {
    let (conn, session) = kv.connection(&app, &target).await?;
    overview::overview(&conn, session.login.clone()).await
}

#[tauri::command]
pub async fn kv_scan(
    app: State<'_, AppState>,
    kv: State<'_, KvState>,
    target: KvTarget,
    pattern: String,
    type_filter: Option<KvType>,
    cursor: Option<String>,
    count: usize,
) -> Result<KvScanPage, AppError> {
    let (conn, _) = kv.connection(&app, &target).await?;
    scan::scan(&conn, &pattern, type_filter, cursor.as_deref(), count).await
}

#[tauri::command]
pub async fn kv_key(app: State<'_, AppState>, kv: State<'_, KvState>, target: KvTarget, key: KvKeyName, page: Option<String>) -> Result<KvKeyView, AppError> {
    let (conn, _) = kv.connection(&app, &target).await?;
    key::key_view(&conn, &key, page.as_deref()).await
}

#[tauri::command]
pub async fn kv_slowlog(app: State<'_, AppState>, kv: State<'_, KvState>, target: KvTarget) -> Result<Vec<KvSlowEntry>, AppError> {
    let (conn, _) = kv.connection(&app, &target).await?;
    slowlog::slowlog(&conn).await
}

#[tauri::command]
pub async fn kv_clients(app: State<'_, AppState>, kv: State<'_, KvState>, target: KvTarget) -> Result<Vec<KvClient>, AppError> {
    let (conn, _) = kv.connection(&app, &target).await?;
    clients::clients(&conn).await
}

/// 큰 키 찾기(모든 키): 진행은 채널로 알리고, 끝나면 결과를 대상·DB마다 디스크에 남긴 뒤 `done` 메시지로 보낸다
#[tauri::command]
pub async fn kv_bigkeys(
    app: State<'_, AppState>,
    kv: State<'_, KvState>,
    target: KvTarget,
    limit: usize,
    on_progress: Channel<KvBigKeysMessage>,
) -> Result<(), AppError> {
    let (conn, session) = kv.connection(&app, &target).await?;
    let stop = Arc::new(AtomicBool::new(false));
    locked(&kv.bigkeys).insert(target.clone(), stop.clone());
    let progress = on_progress.clone();
    let result = bigkeys::bigkeys(&conn, limit.clamp(1, 200), &stop, move |message| {
        let _ = progress.send(message);
    })
    .await;
    // 같은 대상에서 새로 시작한 찾기의 표시를 지우지 않는다
    let mut flags = locked(&kv.bigkeys);
    if flags.get(&target).is_some_and(|current| Arc::ptr_eq(current, &stop)) {
        flags.remove(&target);
    }
    drop(flags);
    let report = result?;
    // 남기지 못해도 결과는 보인다(다음에 다시 열 때만 없다)
    if let Err(e) = kv.reports.put(&report_key(&session.resolved.info.arn, session.login.database), report.clone()) {
        eprintln!("큰 키 결과를 저장하지 못했어요: {e}");
    }
    let _ = on_progress.send(KvBigKeysMessage::Done(report));
    Ok(())
}

/// 이 대상·DB의 마지막 큰 키 찾기 결과. 찾은 적이 없으면 `None`
#[tauri::command]
pub fn kv_bigkeys_report(kv: State<'_, KvState>, target: KvTarget) -> Result<Option<KvBigKeysReport>, AppError> {
    let session = kv.session(&target)?;
    Ok(kv.reports.get(&report_key(&session.resolved.info.arn, session.login.database)))
}

#[tauri::command]
pub fn kv_bigkeys_stop(kv: State<'_, KvState>, target: KvTarget) {
    if let Some(stop) = locked(&kv.bigkeys).get(&target) {
        stop.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn kv_close(kv: State<'_, KvState>, target: KvTarget) {
    kv.close(&target);
}

#[tauri::command]
pub async fn kv_forget_password(app: State<'_, AppState>, kv: State<'_, KvState>, target: KvTarget, user: String) -> Result<(), AppError> {
    let arn = match kv.session(&target) {
        Ok(session) => session.resolved.info.arn.clone(),
        Err(_) => {
            let cfg = app.ctx.config(&target.profile, &target.region).await?;
            resolve_target(&cfg, &target).await?.info.arn
        }
    };
    kv.passwords.delete(&arn, user.trim()).await
}

/// 큐를 찾는 prefix. 앞뒤 공백과 끝의 `:`는 뗀다(`bull:`로 넣어도 `bull:<큐>:…` 키를 찾는다)
fn bull_prefix(prefix: &str) -> Result<&str, AppError> {
    normalize_prefix(prefix).ok_or_else(|| AppError::other("prefix를 입력해 주세요(기본값은 bull이에요)"))
}

#[tauri::command]
pub async fn kv_bull_queues(app: State<'_, AppState>, kv: State<'_, KvState>, target: KvTarget, prefix: String, cursor: Option<String>) -> Result<KvBullQueuesPage, AppError> {
    let prefix = bull_prefix(&prefix)?;
    let (conn, _) = kv.connection(&app, &target).await?;
    queue::queues(&conn, prefix, cursor.as_deref()).await
}

/// 이미 찾은 큐들의 요약만 다시 읽는다(키 공간을 다시 훑지 않는다). 자동으로 다시 읽을 때 쓴다
#[tauri::command]
pub async fn kv_bull_queue_summaries(app: State<'_, AppState>, kv: State<'_, KvState>, target: KvTarget, prefix: String, names: Vec<String>) -> Result<Vec<KvBullQueue>, AppError> {
    let prefix = bull_prefix(&prefix)?;
    let (conn, _) = kv.connection(&app, &target).await?;
    queue::summaries(&conn, prefix, &names).await
}

#[tauri::command]
pub async fn kv_bull_queue(app: State<'_, AppState>, kv: State<'_, KvState>, target: KvTarget, prefix: String, name: String) -> Result<KvBullQueueView, AppError> {
    let prefix = bull_prefix(&prefix)?;
    let (conn, _) = kv.connection(&app, &target).await?;
    queue::queue_view(&conn, prefix, &name).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn kv_bull_jobs(
    app: State<'_, AppState>,
    kv: State<'_, KvState>,
    target: KvTarget,
    prefix: String,
    name: String,
    state: KvBullState,
    start: u64,
    count: u64,
) -> Result<KvBullJobsPage, AppError> {
    let prefix = bull_prefix(&prefix)?;
    let (conn, _) = kv.connection(&app, &target).await?;
    jobs::jobs_page(&conn, prefix, &name, state, start, count).await
}

#[tauri::command]
pub async fn kv_bull_job(app: State<'_, AppState>, kv: State<'_, KvState>, target: KvTarget, prefix: String, name: String, id: String) -> Result<KvBullJob, AppError> {
    let prefix = bull_prefix(&prefix)?;
    let (conn, _) = kv.connection(&app, &target).await?;
    jobs::job(&conn, prefix, &name, &id).await
}

/// 작업의 흐름 그래프(부모 쪽으로 뿌리까지, 아래로 자식들)
#[tauri::command]
pub async fn kv_bull_flow(app: State<'_, AppState>, kv: State<'_, KvState>, target: KvTarget, prefix: String, name: String, id: String) -> Result<KvBullFlow, AppError> {
    let prefix = bull_prefix(&prefix)?;
    let (conn, _) = kv.connection(&app, &target).await?;
    flow::flow(&conn, prefix, &name, &id).await
}

/// 큐의 상태 전이(`events` 스트림의 지난 `minutes`분)
#[tauri::command]
pub async fn kv_bull_transitions(app: State<'_, AppState>, kv: State<'_, KvState>, target: KvTarget, prefix: String, name: String, minutes: u64) -> Result<KvBullTransitions, AppError> {
    let prefix = bull_prefix(&prefix)?;
    let (conn, _) = kv.connection(&app, &target).await?;
    events::transitions(&conn, prefix, &name, minutes).await
}

/// 큐 지도: 큐, 큐 사이의 부모→자식 연결, 워커
#[tauri::command]
pub async fn kv_bull_topology(app: State<'_, AppState>, kv: State<'_, KvState>, target: KvTarget, prefix: String) -> Result<KvBullTopology, AppError> {
    let prefix = bull_prefix(&prefix)?;
    let (conn, _) = kv.connection(&app, &target).await?;
    topology::topology(&conn, prefix).await
}

/// 보관함에서 10분 넘게 안 쓴 연결을 1분마다 닫는다. 앱이 시작할 때 한 번 띄운다.
pub fn spawn_sweeper(app: AppHandle) {
    tauri::async_runtime::spawn(crate::pg_commands::sweep_every(SWEEP_EVERY, move || app.state::<KvState>().pool.sweep(Instant::now())));
}
