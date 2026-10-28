//! PostgreSQL 탭의 명령. 대상(클러스터·인스턴스)마다 로그인 사용자, 접속 정보, 클러스터 스냅숏, 데이터베이스 스냅숏을 한 번 읽어 두고
//! 명령은 그것으로 계산한다(`pg::summary`, `pg::checks`). 1단계라서 이 파일의 모든 읽기는 데이터베이스에 아무것도 쓰지 않는다.
//! 질의도 트랜잭션도 여기에 없다: 읽는 일은 `pg::catalog`만 한다(검사 테스트 `pg::hygiene`이 지킨다).
//!
//! 연결은 `pg::pool`이 (대상, DB 사용자, 데이터베이스)마다 하나씩 보관한다. 명령은 시작할 때 대상의 닫힌 횟수(`epoch`)를 읽어 두고
//! 연결을 열 때마다 넘긴다: 명령이 도는 중에 탭이 닫히면 새 연결을 열지도 보관하지도 않는다.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex as AsyncMutex;

use crate::commands::AppState;
use crate::error::AppError;
use crate::iam::clock::now_secs;
use crate::pg::connect::{self, Connected};
use crate::pg::model::{ClusterSnapshot, DbSnapshot};
use crate::pg::pool::{ConnKey, Pool, NOT_OPENED};
use crate::pg::summary::{self, parse_privilege};
use crate::pg::target::{resolve as resolve_target, PgTarget, PgTargetInfo};
use crate::pg::view::{PgCellDetail, PgDatabaseView, PgFindings, PgObjectRef, PgOverview, PgRoleView, PgSession, PgSkippedDatabase, PgWhoCan};
use crate::pg::{catalog, checks};

/// 연결 보관함에서 오래 안 쓴 연결을 닫는 주기
pub const SWEEP_EVERY: Duration = Duration::from_secs(60);

fn not_opened() -> AppError {
    AppError::other(NOT_OPENED)
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 읽어 둔 값들. 앱이 시작할 때 한 번 `manage`한다.
///
/// 여러 칸을 함께 바꾸는 일(`finish_open`, `close`, `keep_db`)은 `clusters`의 자물쇠를 먼저 잡고 다른 칸을 잡는다. 이 순서만 지키면 서로 얽히지 않는다.
/// 읽는 쪽은 한 번에 한 칸만 잡는다(`opened`는 위와 같은 순서로 잡는다).
#[derive(Default)]
pub struct PgState {
    pub pool: Pool,
    /// 대상 → 로그인한 DB 사용자
    logins: Mutex<HashMap<PgTarget, String>>,
    /// 대상 → RDS API로 읽은 접속 정보(연결이 끊겨 다시 열 때 쓴다)
    infos: Mutex<HashMap<PgTarget, PgTargetInfo>>,
    /// 대상 → 클러스터 스냅숏. 여기 있어야 "열린" 대상이다
    clusters: Mutex<HashMap<PgTarget, Arc<ClusterSnapshot>>>,
    /// (대상, 데이터베이스) → 데이터베이스 스냅숏
    dbs: Mutex<HashMap<(PgTarget, String), Arc<DbSnapshot>>>,
}

/// 열린 대상에 대해 명령이 시작할 때 한 번 읽어 가는 것
struct Opened {
    login: String,
    info: PgTargetInfo,
    cluster: Arc<ClusterSnapshot>,
    /// 시작할 때 대상의 닫힌 횟수. 연결마다 넘겨서, 도중에 탭이 닫히면 연결하지 않게 한다
    epoch: u64,
}

impl PgState {
    /// 열린 대상의 상태. 아직 열리지 않았거나 닫혔으면 "먼저 연결해 주세요".
    /// 닫힌 횟수를 상태보다 먼저 읽는다: 그 사이에 닫히면 상태가 없거나 연결할 때 걸러진다.
    fn opened(&self, target: &PgTarget) -> Result<Opened, AppError> {
        let epoch = self.pool.epoch(target);
        let clusters = locked(&self.clusters);
        let cluster = clusters.get(target).cloned().ok_or_else(not_opened)?;
        let login = locked(&self.logins).get(target).cloned().ok_or_else(not_opened)?;
        let info = locked(&self.infos).get(target).cloned().ok_or_else(not_opened)?;
        Ok(Opened { login, info, cluster, epoch })
    }

    /// 열기가 끝났다: 로그인, 접속 정보, 클러스터 스냅숏을 담고 이 대상의 데이터베이스 스냅숏을 버린다.
    /// 열기를 시작한 뒤(`epoch`를 읽은 뒤) 탭이 닫혔으면 아무것도 담지 않고 "먼저 연결해 주세요"다.
    fn finish_open(&self, target: &PgTarget, epoch: u64, login: String, info: PgTargetInfo, cluster: Arc<ClusterSnapshot>) -> Result<(), AppError> {
        let mut clusters = locked(&self.clusters);
        if self.pool.epoch(target) != epoch {
            return Err(not_opened());
        }
        locked(&self.logins).insert(target.clone(), login);
        locked(&self.infos).insert(target.clone(), info);
        locked(&self.dbs).retain(|(owner, _), _| owner != target);
        clusters.insert(target.clone(), cluster);
        Ok(())
    }

    fn cached_db(&self, target: &PgTarget, database: &str) -> Option<Arc<DbSnapshot>> {
        locked(&self.dbs).get(&(target.clone(), database.to_string())).cloned()
    }

    /// 읽은 데이터베이스 스냅숏을 담는다. 읽는 사이에 탭이 닫혔으면(닫고 다시 열었어도) 담지 않는다.
    fn keep_db(&self, target: &PgTarget, epoch: u64, database: &str, snapshot: Arc<DbSnapshot>) {
        let clusters = locked(&self.clusters);
        if !clusters.contains_key(target) || self.pool.epoch(target) != epoch {
            return;
        }
        locked(&self.dbs).insert((target.clone(), database.to_string()), snapshot);
    }

    /// 읽어 둔 데이터베이스 스냅숏들(이름순)
    fn loaded_dbs(&self, target: &PgTarget) -> Vec<Arc<DbSnapshot>> {
        let mut loaded: Vec<Arc<DbSnapshot>> = locked(&self.dbs).iter().filter(|((owner, _), _)| owner == target).map(|(_, snapshot)| snapshot.clone()).collect();
        loaded.sort_by(|a, b| a.database.cmp(&b.database));
        loaded
    }

    /// 탭을 닫는다: 연결을 모두 버리고(쓰는 중인 것은 끝나는 대로 닫힌다) 읽어 둔 것과 로그인을 잊는다.
    /// 연결 보관함을 먼저 닫는다: 그래야 도는 명령이 이 뒤로는 새 연결을 열지도, 읽은 것을 담지도 못한다.
    pub fn close(&self, target: &PgTarget) {
        self.pool.close_target(target);
        let mut clusters = locked(&self.clusters);
        clusters.remove(target);
        locked(&self.logins).remove(target);
        locked(&self.infos).remove(target);
        locked(&self.dbs).retain(|(owner, _), _| owner != target);
    }
}

/// 데이터베이스 하나의 스냅숏: 읽어 둔 것이 있고 `force`가 아니면 그것을, 아니면 `read`로 읽어 담는다
async fn snapshot_of<R, Fut>(pg: &PgState, target: &PgTarget, epoch: u64, database: &str, force: bool, read: R) -> Result<Arc<DbSnapshot>, AppError>
where
    R: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<DbSnapshot, AppError>>,
{
    if !force {
        if let Some(kept) = pg.cached_db(target, database) {
            return Ok(kept);
        }
    }
    let snapshot = Arc::new(read(database.to_string()).await?);
    pg.keep_db(target, epoch, database, snapshot.clone());
    Ok(snapshot)
}

/// 점검이 읽은 데이터베이스들의 스냅숏과, 읽지 못해 건너뛴 데이터베이스
type Collected = (Vec<Arc<DbSnapshot>>, Vec<PgSkippedDatabase>);

/// 연결할 수 있는 데이터베이스들을 차례로 읽는다(읽어 둔 것은 `force`가 아니면 그대로 쓴다).
/// - 데이터베이스 하나를 연결하지 못하거나 읽지 못하면 그 이름과 이유를 `skipped`에 담고 다음으로 간다.
/// - 자격 증명 문제(SSO 만료, 권한 거부)는 데이터베이스 하나의 문제가 아니니 호출을 실패시킨다. 앱의 자동 로그인이 이어받는다.
/// - 탭이 닫히면(`epoch`가 달라지면) 더 읽지 않고 "먼저 연결해 주세요"로 끝낸다. 닫혀서 생긴 실패는 건너뛴 데이터베이스로 적지 않는다.
///   데이터베이스 사이에서 닫혔으면 다음 데이터베이스에 연결을 시도하지도 않고, 연결하는 중에 닫혔으면 그 연결은 보관함이 버린다.
async fn collect_snapshots<R, Fut>(pg: &PgState, target: &PgTarget, epoch: u64, databases: &[String], force: bool, mut read: R) -> Result<Collected, AppError>
where
    R: FnMut(String) -> Fut,
    Fut: Future<Output = Result<DbSnapshot, AppError>>,
{
    let closed = || pg.pool.epoch(target) != epoch;
    let mut snapshots = Vec::new();
    let mut skipped = Vec::new();
    for database in databases {
        if closed() {
            return Err(not_opened());
        }
        match snapshot_of(pg, target, epoch, database, force, &mut read).await {
            Ok(snapshot) => snapshots.push(snapshot),
            Err(_) if closed() => return Err(not_opened()),
            Err(error @ (AppError::Other { .. } | AppError::Network { .. })) => skipped.push(PgSkippedDatabase { database: database.clone(), reason: error_text(&error) }),
            Err(error) => return Err(error),
        }
    }
    Ok((snapshots, skipped))
}

/// 건너뛴 데이터베이스에 적는 이유: 오류의 문구(네트워크 오류도 앞에 붙는 말 없이 문구만)
fn error_text(error: &AppError) -> String {
    match error {
        AppError::Other { message } | AppError::Network { message } => message.clone(),
        other => other.to_string(),
    }
}

/// 데이터베이스 하나에 쓸 연결. 보관함에 있으면 그것을, 없으면 IAM 토큰으로 새로 연결해 보관한다.
async fn connection(app: &AppState, pg: &PgState, target: &PgTarget, opened: &Opened, database: &str) -> Result<Arc<AsyncMutex<Connected>>, AppError> {
    let key = ConnKey { target: target.clone(), user: opened.login.clone(), database: database.to_string() };
    pg.pool
        .get_or_connect_at_epoch(key, opened.epoch, || async {
            let cfg = app.ctx.config(&target.profile, &target.region).await?;
            connect::connect(&cfg, &opened.info, &opened.login, database).await
        })
        .await
}

/// 데이터베이스 하나를 새로 읽는다
async fn read_database(app: &AppState, pg: &PgState, target: &PgTarget, opened: &Opened, database: String) -> Result<DbSnapshot, AppError> {
    let conn = connection(app, pg, target, opened, &database).await?;
    let mut conn = conn.lock().await;
    catalog::db_snapshot(&mut conn, &database).await
}

/// 클러스터에 있는 데이터베이스의 스냅숏(읽어 둔 것 또는 새로 읽은 것). 목록에 없는 이름은 연결하지 않고 거절한다.
async fn database_snapshot(app: &AppState, pg: &PgState, target: &PgTarget, opened: &Opened, database: &str, force: bool) -> Result<Arc<DbSnapshot>, AppError> {
    if !opened.cluster.databases.iter().any(|d| d.name == database) {
        return Err(AppError::other(format!("{database}에 연결하지 못했어요: 데이터베이스 목록에 없어요")));
    }
    snapshot_of(pg, target, opened.epoch, database, force, |name| read_database(app, pg, target, opened, name)).await
}

/// 무거운 계산은 비동기 실행기를 막지 않게 따로 돌린다
async fn blocking<T, F>(job: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(job).await.map_err(|e| AppError::other(format!("계산하지 못했어요: {e}")))
}

// ───────────────────────── 명령의 몸통 ─────────────────────────
// Tauri 명령은 아래 메서드를 부르는 한 줄이다. 몸통을 `State` 없이 부를 수 있게 해 두어서 AWS에 닿지 않는 부분은 시험이 직접 돌린다.

impl PgState {
    /// 대상을 연다: 대상을 확인하고, 기본 데이터베이스에 `login_user`로 연결해 클러스터 스냅숏을 새로 읽는다.
    /// 성공하면 로그인 사용자를 이 대상에 기억하고, 읽어 둔 데이터베이스 스냅숏을 버린다. 실패하면 이전 상태를 그대로 둔다.
    /// 로그인 이름은 가장 먼저 본다: 토큰을 서명하거나 AWS에 묻기 전에, 상태에 담기 전에 걸러야 한다.
    async fn open(&self, app: &AppState, target: PgTarget, login_user: String) -> Result<PgOverview, AppError> {
        connect::check_login_name(&login_user)?;
        let epoch = self.pool.epoch(&target);
        let cfg = app.ctx.config(&target.profile, &target.region).await?;
        let info = resolve_target(&cfg, &target).await?;
        connect::connect_check(&info)?;

        let key = ConnKey { target: target.clone(), user: login_user.clone(), database: info.default_database.clone() };
        let conn = self.pool.get_or_connect_at_epoch(key, epoch, || connect::connect(&cfg, &info, &login_user, &info.default_database)).await?;
        let cluster = Arc::new(catalog::cluster_snapshot(&mut *conn.lock().await, &login_user).await?);
        self.finish_open(&target, epoch, login_user, info.clone(), cluster.clone())?;
        blocking(move || summary::overview(&info, &cluster, now_secs())).await
    }

    async fn database(&self, app: &AppState, target: &PgTarget, database: &str, force: bool) -> Result<PgDatabaseView, AppError> {
        let opened = self.opened(target)?;
        let snapshot = database_snapshot(app, self, target, &opened, database, force).await?;
        blocking(move || summary::database_view(&opened.cluster, &snapshot)).await
    }

    async fn cell(&self, app: &AppState, target: &PgTarget, database: &str, role: String, schema: String) -> Result<PgCellDetail, AppError> {
        let opened = self.opened(target)?;
        let snapshot = database_snapshot(app, self, target, &opened, database, false).await?;
        blocking(move || summary::cell_detail(&opened.cluster, &snapshot, &role, &schema)).await?
    }

    async fn objects(&self, app: &AppState, target: &PgTarget, database: &str, query: String) -> Result<Vec<PgObjectRef>, AppError> {
        let opened = self.opened(target)?;
        let snapshot = database_snapshot(app, self, target, &opened, database, false).await?;
        blocking(move || summary::search_objects(&opened.cluster, &snapshot, &query)).await
    }

    /// 역할 하나의 상세. 새로 읽는 것은 없다: 클러스터 스냅숏과 이미 읽어 둔 데이터베이스 스냅숏만 쓴다.
    async fn role(&self, target: &PgTarget, role: String) -> Result<PgRoleView, AppError> {
        let opened = self.opened(target)?;
        let loaded = self.loaded_dbs(target);
        let own = self.pool.backend_pids(target);
        blocking(move || {
            let refs: Vec<&DbSnapshot> = loaded.iter().map(Arc::as_ref).collect();
            summary::role_view(&opened.cluster, &refs, &role, now_secs(), &own)
        })
        .await?
    }

    /// 연결 상태를 먼저 본다: 열리지 않은 대상에는 권한 이름이 틀려도 "먼저 연결해 주세요"다.
    async fn who_can(&self, app: &AppState, target: &PgTarget, database: &str, object: PgObjectRef, privilege: &str) -> Result<PgWhoCan, AppError> {
        let opened = self.opened(target)?;
        let privilege = parse_privilege(privilege)?;
        let snapshot = database_snapshot(app, self, target, &opened, database, false).await?;
        blocking(move || summary::who_can_view(&opened.cluster, &snapshot, &object, privilege)).await?
    }

    /// 지금 접속해 있는 세션들. 매번 기본 데이터베이스의 연결로 새로 읽는다.
    async fn sessions(&self, app: &AppState, target: &PgTarget) -> Result<Vec<PgSession>, AppError> {
        let opened = self.opened(target)?;
        let conn = connection(app, self, target, &opened, &opened.info.default_database).await?;
        let records = catalog::sessions(&mut *conn.lock().await).await?;
        Ok(summary::sessions(&records, &self.pool.backend_pids(target)))
    }

    /// 연결할 수 있는 모든 데이터베이스를 읽어(읽어 둔 것은 `force`가 아니면 그대로) 보안 점검을 한다.
    /// 읽지 못한 데이터베이스는 이유와 함께 `skipped`에 담고 나머지로 점검한다. 도중에 탭이 닫히면 더 읽지 않고 "먼저 연결해 주세요"다.
    async fn findings(&self, app: &AppState, target: &PgTarget, force: bool) -> Result<PgFindings, AppError> {
        let opened = self.opened(target)?;
        let databases: Vec<String> = opened.cluster.databases.iter().filter(|d| d.allow_conn).map(|d| d.name.clone()).collect();
        let opened_ref = &opened;
        let (snapshots, skipped) =
            collect_snapshots(self, target, opened.epoch, &databases, force, |database| read_database(app, self, target, opened_ref, database)).await?;
        let cluster = opened.cluster.clone();
        blocking(move || {
            let refs: Vec<&DbSnapshot> = snapshots.iter().map(Arc::as_ref).collect();
            checks::findings(&cluster, &refs, skipped, now_secs())
        })
        .await
    }
}

/// live 시험(`pg::live_tests`)이 AWS 없이 열린 상태를 만들고 명령의 몸통을 부르는 길. 제품 빌드에는 없다:
/// `finish_open`은 `open`이 로그인 이름과 대상을 확인한 뒤에만 부르는 것이라 크레이트 안의 다른 코드에 열어 두지 않는다.
#[cfg(test)]
impl PgState {
    pub(crate) fn finish_open_for_tests(&self, target: &PgTarget, epoch: u64, login: String, info: PgTargetInfo, cluster: Arc<ClusterSnapshot>) -> Result<(), AppError> {
        self.finish_open(target, epoch, login, info, cluster)
    }

    pub(crate) async fn sessions_for_tests(&self, app: &AppState, target: &PgTarget) -> Result<Vec<PgSession>, AppError> {
        self.sessions(app, target).await
    }
}

// ───────────────────────── 명령 ─────────────────────────

/// RDS API로 대상을 확인한다. 데이터베이스에는 연결하지 않는다.
#[tauri::command]
pub async fn pg_target(app: State<'_, AppState>, target: PgTarget) -> Result<PgTargetInfo, AppError> {
    let cfg = app.ctx.config(&target.profile, &target.region).await?;
    resolve_target(&cfg, &target).await
}

#[tauri::command]
pub async fn pg_open(app: State<'_, AppState>, pg: State<'_, PgState>, target: PgTarget, login_user: String) -> Result<PgOverview, AppError> {
    pg.open(&app, target, login_user).await
}

#[tauri::command]
pub async fn pg_database(app: State<'_, AppState>, pg: State<'_, PgState>, target: PgTarget, database: String, force: bool) -> Result<PgDatabaseView, AppError> {
    pg.database(&app, &target, &database, force).await
}

#[tauri::command]
pub async fn pg_cell(app: State<'_, AppState>, pg: State<'_, PgState>, target: PgTarget, database: String, role: String, schema: String) -> Result<PgCellDetail, AppError> {
    pg.cell(&app, &target, &database, role, schema).await
}

#[tauri::command]
pub async fn pg_objects(app: State<'_, AppState>, pg: State<'_, PgState>, target: PgTarget, database: String, query: String) -> Result<Vec<PgObjectRef>, AppError> {
    pg.objects(&app, &target, &database, query).await
}

#[tauri::command]
pub async fn pg_role(pg: State<'_, PgState>, target: PgTarget, role: String) -> Result<PgRoleView, AppError> {
    pg.role(&target, role).await
}

#[tauri::command]
pub async fn pg_who_can(
    app: State<'_, AppState>,
    pg: State<'_, PgState>,
    target: PgTarget,
    database: String,
    object: PgObjectRef,
    privilege: String,
) -> Result<PgWhoCan, AppError> {
    pg.who_can(&app, &target, &database, object, &privilege).await
}

#[tauri::command]
pub async fn pg_sessions(app: State<'_, AppState>, pg: State<'_, PgState>, target: PgTarget) -> Result<Vec<PgSession>, AppError> {
    pg.sessions(&app, &target).await
}

#[tauri::command]
pub async fn pg_findings(app: State<'_, AppState>, pg: State<'_, PgState>, target: PgTarget, force: bool) -> Result<PgFindings, AppError> {
    pg.findings(&app, &target, force).await
}

/// 탭을 닫을 때: 이 대상의 연결을 모두 닫고 읽어 둔 것과 기억해 둔 로그인을 버린다.
#[tauri::command]
pub fn pg_close(pg: State<'_, PgState>, target: PgTarget) {
    pg.close(&target);
}

// ───────────────────────── 연결 보관함 청소 ─────────────────────────

/// `period`마다 `sweep`을 부른다. 끝나지 않는다.
pub async fn sweep_every(period: Duration, mut sweep: impl FnMut()) {
    let mut tick = tokio::time::interval(period);
    loop {
        tick.tick().await;
        sweep();
    }
}

/// 보관함에서 10분 넘게 안 쓴 연결을 1분마다 닫는다. 앱이 시작할 때 한 번 띄운다.
pub fn spawn_sweeper(app: AppHandle) {
    tauri::async_runtime::spawn(sweep_every(SWEEP_EVERY, move || app.state::<PgState>().pool.sweep(Instant::now())));
}

#[cfg(test)]
mod tests;
