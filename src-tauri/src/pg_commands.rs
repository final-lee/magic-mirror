//! PostgreSQL 탭의 명령. 대상(클러스터·인스턴스)마다 로그인 사용자, 접속 정보, 클러스터 스냅숏, 데이터베이스 스냅숏을 한 번 읽어 두고
//! 명령은 그것으로 계산한다(`pg::summary`, `pg::checks`). 읽기 명령은 데이터베이스에 아무것도 쓰지 않는다.
//! 질의도 트랜잭션도 여기에 없다: 읽는 일은 `pg::catalog`이, 쓰는 일은 `pg::exec`가 하고, 여기서는 `commit::commit`과 `drop::apply`에 넘기는 닫힘 하나씩에서만 `exec`를 부른다(검사 테스트 `pg::hygiene`이 지킨다).
//!
//! 연결은 `pg::pool`이 (대상, DB 사용자, 데이터베이스)마다 하나씩 보관한다. 명령은 시작할 때 대상의 닫힌 횟수(`epoch`)를 읽어 두고
//! 연결을 열 때마다 넘긴다: 명령이 도는 중에 탭이 닫히면 새 연결을 열지도 보관하지도 않는다.
//! 열기(`pg_open`)는 거기에 그 대상의 열기 번호도 받는다: 로그인 사용자가 다른 두 열기가 겹쳐 돌 때, 먼저 시작한 쪽이 나중에 끝나도 남는 것은 나중에 시작한 쪽의 로그인이다.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex as AsyncMutex;

use crate::commands::AppState;
use crate::error::AppError;
use crate::iam::clock::now_secs;
use crate::iam::commit::{new_log_id, PlanStore};
use crate::pg::change::model::{PgChange, PresetKind};
use crate::pg::change::resolve::not_changeable;
use crate::pg::change::preview::{evaluate, evaluate_batch, PreviewCtx};
use crate::pg::commit::{self, PgChanges, PgCommitResult, PgPlan, PgRequest};
use crate::pg::connect::{self, Connected};
use crate::pg::drop::{self, DropLog};
use crate::pg::exec::{self, ExecError};
use crate::pg::log as change_log;
use crate::pg::model::{ClusterSnapshot, DbSnapshot};
use crate::pg::pool::{ConnKey, Pool, NOT_OPENED};
use crate::pg::summary::{self, parse_privilege};
use crate::pg::target::{resolve as resolve_target, PgTarget, PgTargetInfo};
use crate::pg::view::{
    PgApplyResult, PgBatchPreview, PgBatchResult, PgCellDetail, PgDatabaseView, PgDropPlan, PgDropResult, PgFindings, PgObjectRef, PgOverview, PgPresetSuggestion,
    PgPreview, PgRoleView, PgSession, PgSkippedDatabase, PgUndo, PgWhoCan,
};
use crate::pg::{catalog, checks, preset};

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
    /// 변경 기록 파일(`db-changes.jsonl`)의 경로
    log_path: PathBuf,
    /// 미리보기에서 사용자가 본 계획. 적용할 때 다시 계산한 계획과 견준다(한 번 쓰면 버린다)
    plans: Mutex<PlanStore<PgPlan>>,
    /// 역할 삭제 계획: (대상, 역할, 넘겨받을 역할)마다 마지막 계획. 적용이 꺼내 쓰면 버린다
    drop_plans: Mutex<PlanStore<PgDropPlan>>,
    /// 대상 → 열기 번호. 대상을 닫아도 지우지 않는다: 번호는 계속 커져야 한다(닫기 전에 시작한 열기는 `epoch`가 거른다)
    opens: Mutex<HashMap<PgTarget, OpenNumbers>>,
}

/// 한 대상의 열기 번호. 열기는 시작할 때 다음 번호를 받고(`begin_open`), 끝날 때 더 늦게 시작한 열기가 이미 받아들여졌는지 본다(`finish_open`)
#[derive(Default)]
struct OpenNumbers {
    /// 지금까지 나눠 준 마지막 번호
    given: u64,
    /// 받아들인 열기 가운데 가장 큰 번호. 아직 받아들인 열기가 없으면 0이다(번호는 1부터다)
    accepted: u64,
}

/// 열기가 시작한 때 받는 표: 대상이 닫힌 횟수(`epoch`)와 그 대상의 열기 번호. 열기가 끝날 때 `finish_open`에 되돌린다
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OpenStart {
    epoch: u64,
    number: u64,
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
    pub fn new(log_path: PathBuf) -> PgState {
        PgState { log_path, ..Default::default() }
    }

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

    /// 열기를 시작한다: 대상이 닫힌 횟수를 읽고 이 대상의 다음 열기 번호를 받는다. 닫힌 횟수를 먼저 읽는다(`opened`와 같은 까닭이다).
    fn begin_open(&self, target: &PgTarget) -> OpenStart {
        let epoch = self.pool.epoch(target);
        let mut opens = locked(&self.opens);
        let numbers = opens.entry(target.clone()).or_default();
        numbers.given += 1;
        OpenStart { epoch, number: numbers.given }
    }

    /// 이 열기를 받아들이는가: 더 늦게 시작한 열기가 이미 받아들여졌으면 아니다. 받아들이면 그 번호를 기억한다.
    /// `finish_open`이 `clusters`의 자물쇠를 쥔 채 부른다(`opens`는 그다음 칸이다).
    fn accept_open(&self, target: &PgTarget, number: u64) -> bool {
        let mut opens = locked(&self.opens);
        let numbers = opens.entry(target.clone()).or_default();
        if number < numbers.accepted {
            return false;
        }
        numbers.accepted = number;
        true
    }

    /// 열기가 끝났다: 로그인, 접속 정보, 클러스터 스냅숏을 담고 이 대상의 데이터베이스 스냅숏을 버린다.
    /// 기억하던 로그인과 다른 사용자로 열었으면 이전 사용자의 연결을 연결 보관함에서 뺀다(`close_user`): 남겨 두면 10분 동안 서버 연결을 쥐고,
    /// 세션 목록에 이전 사용자의 이름으로 "이 앱"의 연결이 보이고, 더 높은 권한의 연결이 낮은 권한으로 바꾼 뒤에도 붙어 있다.
    /// 새 사용자의 연결은 열기가 먼저 열어 두었으니 영향이 없다. 같은 사용자로 다시 열면(다시 읽기) 닫을 것이 없다.
    /// 열기를 시작한 뒤(`epoch`를 읽은 뒤) 탭이 닫혔으면 아무것도 담지 않고, 아무것도 닫지 않고 "먼저 연결해 주세요"다.
    /// 더 늦게 시작한 열기가 이미 받아들여졌으면(두 열기가 겹쳐 돌았고 나중에 시작한 쪽이 먼저 끝났다) 이 열기도 같은 말로 물러난다:
    /// 아무것도 담지 않는다(읽은 스냅숏은 버려진다). 이 열기가 연 연결은 그 사용자가 기억하는 로그인이 아니면 닫는다
    /// (같은 사용자면 나중 열기가 쓰는 연결과 같은 것이라 둔다). 사용자를 바꾼 마지막 선택이 남는다.
    fn finish_open(&self, target: &PgTarget, start: OpenStart, login: String, info: PgTargetInfo, cluster: Arc<ClusterSnapshot>) -> Result<(), AppError> {
        let mut clusters = locked(&self.clusters);
        if self.pool.epoch(target) != start.epoch {
            return Err(not_opened());
        }
        if !self.accept_open(target, start.number) {
            if locked(&self.logins).get(target) != Some(&login) {
                self.pool.close_user(target, &login);
            }
            return Err(not_opened());
        }
        let previous = locked(&self.logins).insert(target.clone(), login.clone());
        locked(&self.infos).insert(target.clone(), info);
        locked(&self.dbs).retain(|(owner, _), _| owner != target);
        clusters.insert(target.clone(), cluster);
        if let Some(previous) = previous.filter(|previous| *previous != login) {
            self.pool.close_user(target, &previous);
        }
        Ok(())
    }

    fn cached_db(&self, target: &PgTarget, database: &str) -> Option<Arc<DbSnapshot>> {
        locked(&self.dbs).get(&(target.clone(), database.to_string())).cloned()
    }

    /// 이 대상의 데이터베이스 스냅숏 가운데 `databases`의 것을 버린다(역할 삭제가 건드린 데이터베이스들)
    fn forget_databases(&self, target: &PgTarget, databases: &[String]) {
        locked(&self.dbs).retain(|(owner, name), _| !(owner == target && databases.contains(name)));
    }

    /// 읽은 데이터베이스 스냅숏을 담는다. 읽는 사이에 탭이 닫혔으면(닫고 다시 열었어도) 담지 않는다.
    fn keep_db(&self, target: &PgTarget, epoch: u64, database: &str, snapshot: Arc<DbSnapshot>) {
        let clusters = locked(&self.clusters);
        if !clusters.contains_key(target) || self.pool.epoch(target) != epoch {
            return;
        }
        locked(&self.dbs).insert((target.clone(), database.to_string()), snapshot);
    }

    /// 새로 읽은 클러스터 스냅숏을 담는다. `keep_db`처럼 읽는 사이에 탭이 닫혔으면(닫고 다시 열었어도) 담지 않는다.
    /// 다른 데이터베이스의 스냅숏은 그대로 둔다
    fn keep_cluster(&self, target: &PgTarget, epoch: u64, cluster: Arc<ClusterSnapshot>) {
        let mut clusters = locked(&self.clusters);
        if !clusters.contains_key(target) || self.pool.epoch(target) != epoch {
            return;
        }
        clusters.insert(target.clone(), cluster);
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
/// - 네트워크 오류(끝점에 닿지 못했거나 연결이 끊겼다)는 한 대상의 데이터베이스가 끝점 하나를 같이 쓰니 데이터베이스 하나의 문제가 아니다. 처음 만나면
///   더는 연결하지 않는다: 나머지는 같은 이유로 `skipped`에 담고(VPN이 꺼졌을 때 데이터베이스마다 연결 제한 시간을 기다리지 않는다),
///   읽어 둔 것은 그대로 쓴다. `force`면 읽어 둔 것을 다시 읽을 수 없으니 읽기가 실패한 것과 같게 건너뛴다.
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
    // 처음 만난 네트워크 오류. 있으면 나머지 데이터베이스는 읽으러 가지 않고(`read`를 부르지 않고) 이 오류로 읽지 못한 것처럼 다룬다
    let mut unreachable: Option<AppError> = None;
    for database in databases {
        if closed() {
            return Err(not_opened());
        }
        let outcome = match &unreachable {
            None => snapshot_of(pg, target, epoch, database, force, &mut read).await,
            Some(network_error) => snapshot_of(pg, target, epoch, database, force, |_| std::future::ready(Err(network_error.clone()))).await,
        };
        match outcome {
            Ok(snapshot) => snapshots.push(snapshot),
            Err(_) if closed() => return Err(not_opened()),
            Err(error @ (AppError::Other { .. } | AppError::Network { .. })) => {
                skipped.push(PgSkippedDatabase { database: database.clone(), reason: error_text(&error) });
                if matches!(error, AppError::Network { .. }) {
                    unreachable.get_or_insert(error);
                }
            }
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
    /// 열기는 로그인 이름을 본 뒤 시작할 때 번호를 받는다(`begin_open`): 두 열기가 겹쳐 돌 때 나중에 시작한 쪽이 이긴다.
    async fn open(&self, app: &AppState, target: PgTarget, login_user: String) -> Result<PgOverview, AppError> {
        connect::check_login_name(&login_user)?;
        let start = self.begin_open(&target);
        let cfg = app.ctx.config(&target.profile, &target.region).await?;
        let info = resolve_target(&cfg, &target).await?;
        connect::connect_check(&info)?;

        let key = ConnKey { target: target.clone(), user: login_user.clone(), database: info.default_database.clone() };
        let conn = self.pool.get_or_connect_at_epoch(key, start.epoch, || connect::connect(&cfg, &info, &login_user, &info.default_database)).await?;
        let cluster = Arc::new(catalog::cluster_snapshot(&mut *conn.lock().await, &login_user).await?);
        self.finish_open(&target, start, login_user, info.clone(), cluster.clone())?;
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

// ───────────────────────── 변경 ─────────────────────────

/// 변경이 도는 데이터베이스가 클러스터 스냅숏에 있고 연결할 수 있어야 한다(템플릿과 `rdsadmin`은 스냅숏에 없다). 연결하기 전에 본다
fn check_execution_database(cluster: &ClusterSnapshot, database: &str) -> Result<(), AppError> {
    if cluster.databases.iter().any(|d| d.name == database && d.allow_conn) {
        Ok(())
    } else {
        Err(AppError::other(not_changeable(database)))
    }
}

/// 미리보기와 적용이 똑같이 읽는 재료: 방금 `force`로 읽은 클러스터와 실행 데이터베이스의 스냅숏
struct Gathered {
    opened: Opened,
    cluster: Arc<ClusterSnapshot>,
    db: Arc<DbSnapshot>,
    own_pids: Vec<i32>,
}

impl PgState {
    /// 기본 데이터베이스의 연결로 클러스터 스냅숏을 새로 읽어 담는다
    async fn read_cluster(&self, app: &AppState, target: &PgTarget, opened: &Opened) -> Result<Arc<ClusterSnapshot>, AppError> {
        let conn = connection(app, self, target, opened, &opened.info.default_database).await?;
        let cluster = Arc::new(catalog::cluster_snapshot(&mut *conn.lock().await, &opened.login).await?);
        self.keep_cluster(target, opened.epoch, cluster.clone());
        Ok(cluster)
    }

    /// 클러스터와 실행 데이터베이스를 `force`로 다시 읽어 담는다(다른 데이터베이스의 스냅숏은 그대로 둔다)
    async fn refresh(&self, app: &AppState, target: &PgTarget, database: &str) -> Result<(Opened, Arc<ClusterSnapshot>, Arc<DbSnapshot>), AppError> {
        let opened = self.opened(target)?;
        check_execution_database(&opened.cluster, database)?;
        let cluster = self.read_cluster(app, target, &opened).await?;
        check_execution_database(&cluster, database)?;
        let opened = Opened { cluster: cluster.clone(), ..opened };
        let db = snapshot_of(self, target, opened.epoch, database, true, |name| read_database(app, self, target, &opened, name)).await?;
        Ok((opened, cluster, db))
    }

    async fn gather(&self, app: &AppState, target: &PgTarget, database: &str) -> Result<Gathered, AppError> {
        let (opened, cluster, db) = self.refresh(app, target, database).await?;
        Ok(Gathered { opened, cluster, db, own_pids: self.pool.backend_pids(target) })
    }

    /// 클러스터 스냅숏을 새로 읽어 담고 개요를 만든다. RDS API는 부르지 않고 데이터베이스 스냅숏은 그대로 둔다
    async fn overview(&self, app: &AppState, target: &PgTarget) -> Result<PgOverview, AppError> {
        let opened = self.opened(target)?;
        let cluster = self.read_cluster(app, target, &opened).await?;
        let info = opened.info;
        blocking(move || summary::overview(&info, &cluster, now_secs())).await
    }

    async fn preview(&self, app: &AppState, target: &PgTarget, change: PgChange) -> Result<PgPreview, AppError> {
        let default_db = self.opened(target)?.info.default_database;
        let g = self.gather(app, target, change.execution_database(&default_db)).await?;
        let (read_replica, now) = (g.opened.info.read_replica, now_secs());
        let shown = blocking({
            let change = change.clone();
            move || {
                let ctx = PreviewCtx { cluster: &g.cluster, db: &g.db, own_pids: &g.own_pids, read_replica, default_db: &default_db, now };
                evaluate(&ctx, &change).preview
            }
        })
        .await?;
        locked(&self.plans).remember(&target.profile, &(target, &change), PgPlan::One(shown.clone()), now);
        Ok(shown)
    }

    async fn preview_batch(&self, app: &AppState, target: &PgTarget, database: String, changes: Vec<PgChange>) -> Result<PgBatchPreview, AppError> {
        let g = self.gather(app, target, &database).await?;
        let (read_replica, now, default_db) = (g.opened.info.read_replica, now_secs(), g.opened.info.default_database.clone());
        let shown = blocking({
            let (database, changes) = (database.clone(), changes.clone());
            move || {
                let ctx = PreviewCtx { cluster: &g.cluster, db: &g.db, own_pids: &g.own_pids, read_replica, default_db: &default_db, now };
                evaluate_batch(&ctx, &database, &changes).preview
            }
        })
        .await?;
        locked(&self.plans).remember(&target.profile, &(target, (&database, &changes)), PgPlan::Batch(shown.clone()), now);
        Ok(shown)
    }

    /// 미리보기에서 본 계획을 꺼내(꺼낸 계획은 맞든 틀리든 다시 쓰지 않는다) `commit`에 넘긴다. 문장을 돌려 봤으면 읽어 둔 스냅숏을 새로 읽는다.
    /// 문장을 돌리는 `exec::run`은 이 파일에서 `commit::commit`에 넘기는 이 닫힘 하나에서만 부른다
    async fn apply(&self, app: &AppState, target: &PgTarget, changes: PgChanges, confirm_text: Option<String>, undo_of: Vec<String>) -> Result<PgCommitResult, AppError> {
        let default_db = self.opened(target)?.info.default_database;
        let database = match &changes {
            PgChanges::One(change) => change.execution_database(&default_db).to_string(),
            PgChanges::Batch { database, .. } => database.clone(),
        };
        let g = self.gather(app, target, &database).await?;
        let now = now_secs();
        let seen = match &changes {
            PgChanges::One(change) => locked(&self.plans).take(&target.profile, &(target, change), now),
            PgChanges::Batch { database, changes } => locked(&self.plans).take(&target.profile, &(target, (database, changes)), now),
        };
        let request = PgRequest {
            profile: target.profile.clone(),
            target_arn: g.opened.info.arn.clone(),
            login_user: g.opened.login.clone(),
            cluster: g.cluster.clone(),
            db: g.db.clone(),
            own_pids: g.own_pids.clone(),
            read_replica: g.opened.info.read_replica,
            default_db: g.opened.info.default_database.clone(),
            now,
            changes,
            confirm_text,
            undo_of,
            seen,
            log_path: self.log_path.clone(),
            log_id: new_log_id(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis())),
        };
        let (opened, database) = (&g.opened, database.as_str());
        let committed = commit::commit(
            request,
            |steps| async move {
                let conn = connection(app, self, target, opened, database).await.map_err(ExecError::Failed)?;
                let mut conn = conn.lock().await;
                exec::run(&mut conn, &steps).await
            },
            || async { self.refresh(app, target, database).await.map(|(_, cluster, db)| (cluster, db)) },
        )
        .await;
        if committed.ran {
            // 읽지 못해도 괜찮다: 화면이 다시 읽는다(`pg_overview`)
            let _ = self.refresh(app, target, database).await;
        }
        committed.result
    }

    /// 프리셋 제안: 같은 권한을 이미 가진 그룹, 새 그룹의 이름, 기본 권한을 줄 만드는 역할. 읽어 둔 스냅숏을 쓴다
    async fn preset(&self, app: &AppState, target: &PgTarget, database: &str, preset: PresetKind, schemas: Vec<String>) -> Result<PgPresetSuggestion, AppError> {
        let opened = self.opened(target)?;
        let snapshot = database_snapshot(app, self, target, &opened, database, false).await?;
        blocking(move || preset::suggest(&opened.cluster, &snapshot, preset, &schemas)).await
    }

    /// 삭제 계획의 재료를 모두 새로 읽는다: 클러스터와 연결할 수 있는 모든 데이터베이스(읽지 못한 데이터베이스는 계획이 막는다). 읽은 것은 읽어 둔 값으로 담긴다
    async fn drop_plan_now(&self, app: &AppState, target: &PgTarget, role: &str, reassign_to: &str) -> Result<(Opened, PgDropPlan), AppError> {
        let opened = self.opened(target)?;
        let cluster = self.read_cluster(app, target, &opened).await?;
        let opened = Opened { cluster: cluster.clone(), ..opened };
        let mut databases: Vec<String> = cluster.databases.iter().filter(|d| d.allow_conn).map(|d| d.name.clone()).collect();
        databases.sort();
        let opened_ref = &opened;
        let (snapshots, skipped) =
            collect_snapshots(self, target, opened.epoch, &databases, true, |database| read_database(app, self, target, opened_ref, database)).await?;
        let unreachable: Vec<String> = skipped.into_iter().map(|s| s.database).collect();
        let (default_db, read_replica) = (opened.info.default_database.clone(), opened.info.read_replica);
        let (role, reassign_to) = (role.to_string(), reassign_to.to_string());
        let plan = blocking(move || {
            let mut plan = drop::drop_plan(&cluster, &snapshots, &unreachable, &role, &reassign_to, &default_db);
            if read_replica {
                drop::block_replica(&mut plan);
            }
            plan
        })
        .await?;
        Ok((opened, plan))
    }

    async fn drop_plan(&self, app: &AppState, target: &PgTarget, role: String, reassign_to: String) -> Result<PgDropPlan, AppError> {
        let (_, plan) = self.drop_plan_now(app, target, &role, &reassign_to).await?;
        locked(&self.drop_plans).remember(&target.profile, &(target, &role, &reassign_to), plan.clone(), now_secs());
        Ok(plan)
    }

    /// 역할을 지운다: 모든 것을 새로 읽어 계획을 다시 계산하고, 사용자가 본 계획과 같은지와 막힘·확인 문구를 본 뒤에 데이터베이스마다 차례로 돌린다.
    /// 첫 실패에서 멈추고(`stopped`) 어디까지 했는지를 알린다. 끝났든 멈췄든 기록을 하나 남기고, 건드린 모든 데이터베이스의 읽어 둔 스냅숏을 버린다.
    /// 문장을 돌리는 `exec::run`은 이 파일에서 `drop::apply`에 넘기는 닫힘 하나에서만 부른다
    async fn apply_drop(&self, app: &AppState, target: &PgTarget, role: String, reassign_to: String, confirm_text: Option<String>) -> Result<PgDropResult, AppError> {
        let (opened, plan) = self.drop_plan_now(app, target, &role, &reassign_to).await?;
        let now = now_secs();
        let seen = locked(&self.drop_plans).take(&target.profile, &(target, &role, &reassign_to), now);
        drop::check(&plan, seen.as_ref(), confirm_text.as_deref())?;

        let default_db = opened.info.default_database.clone();
        let opened_ref = &opened;
        let (done, stopped) = drop::apply(&plan, &default_db, |database, steps| {
            let database = database.to_string();
            async move {
                let conn = connection(app, self, target, opened_ref, &database).await.map_err(ExecError::Failed)?;
                let mut conn = conn.lock().await;
                exec::run(&mut conn, &steps).await
            }
        })
        .await;

        let log_id = new_log_id(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis()));
        let entry = drop::log_entry(&DropLog {
            plan: &plan,
            profile: &target.profile,
            target_arn: &opened.info.arn,
            login_user: &opened.login,
            default_db: &default_db,
            now,
            log_id: &log_id,
            stopped: stopped.as_deref(),
        });
        let path = self.log_path.clone();
        let saved = tokio::task::spawn_blocking(move || change_log::append(&path, &entry)).await;
        // 지운 결과는 이미 서버에 있다. 기록을 저장하지 못한 것은 결과의 알림으로 알린다
        let unsaved = match saved {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(e.to_string()),
            Err(e) => Some(e.to_string()),
        };

        // 건드린 모든 데이터베이스의 읽어 둔 스냅숏을 버린다. 클러스터는 읽지 못해도 괜찮다: 화면이 다시 읽는다(`pg_overview`)
        let touched: Vec<String> = plan.steps.iter().map(|s| s.database.clone().unwrap_or_else(|| default_db.clone())).collect();
        self.forget_databases(target, &touched);
        let _ = self.read_cluster(app, target, &opened).await;
        let total = plan.steps.iter().filter(|s| s.database.is_some()).count();
        Ok(drop::result(&log_id, total, done, stopped, unsaved.as_deref()))
    }

    async fn log(&self) -> Result<Vec<change_log::PgLogEntry>, AppError> {
        let path = self.log_path.clone();
        let mut entries = tokio::task::spawn_blocking(move || change_log::read_all(&path)).await.map_err(|e| AppError::other(format!("변경 기록을 읽지 못했어요: {e}")))?;
        entries.reverse();
        Ok(entries)
    }
}

/// live 시험(`pg::live_tests`)이 AWS 없이 열린 상태를 만들고 명령의 몸통을 부르는 길. 제품 빌드에는 없다:
/// `begin_open`과 `finish_open`은 `open`이 로그인 이름과 대상을 확인한 뒤에만 부르는 것이라 크레이트 안의 다른 코드에 열어 두지 않는다.
#[cfg(test)]
impl PgState {
    /// 열기를 시작하고 바로 끝낸다. 열기를 시작한 때의 epoch를 돌려준다(보관함에 연결을 넣을 때 쓴다)
    pub(crate) fn open_for_tests(&self, target: &PgTarget, login: String, info: PgTargetInfo, cluster: Arc<ClusterSnapshot>) -> Result<u64, AppError> {
        let start = self.begin_open(target);
        self.finish_open(target, start, login, info, cluster)?;
        Ok(start.epoch)
    }

    pub(crate) async fn preview_for_tests(&self, app: &AppState, target: &PgTarget, change: PgChange) -> Result<PgPreview, AppError> {
        self.preview(app, target, change).await
    }

    pub(crate) async fn apply_for_tests(&self, app: &AppState, target: &PgTarget, change: PgChange, confirm_text: Option<String>) -> Result<PgCommitResult, AppError> {
        self.apply(app, target, PgChanges::One(change), confirm_text, Vec::new()).await
    }

    pub(crate) async fn drop_plan_for_tests(&self, app: &AppState, target: &PgTarget, role: &str, reassign_to: &str) -> Result<PgDropPlan, AppError> {
        self.drop_plan(app, target, role.to_string(), reassign_to.to_string()).await
    }

    pub(crate) async fn apply_drop_for_tests(&self, app: &AppState, target: &PgTarget, role: &str, reassign_to: &str, confirm_text: Option<String>) -> Result<PgDropResult, AppError> {
        self.apply_drop(app, target, role.to_string(), reassign_to.to_string(), confirm_text).await
    }

    pub(crate) fn kept_db_for_tests(&self, target: &PgTarget, database: &str) -> Option<Arc<DbSnapshot>> {
        self.cached_db(target, database)
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

/// 최신 클러스터 스냅숏으로 만든 개요. 적용한 뒤 화면이 부른다
#[tauri::command]
pub async fn pg_overview(app: State<'_, AppState>, pg: State<'_, PgState>, target: PgTarget) -> Result<PgOverview, AppError> {
    pg.overview(&app, &target).await
}

#[tauri::command]
pub async fn pg_preview(app: State<'_, AppState>, pg: State<'_, PgState>, target: PgTarget, change: PgChange) -> Result<PgPreview, AppError> {
    pg.preview(&app, &target, change).await
}

#[tauri::command]
pub async fn pg_apply(
    app: State<'_, AppState>,
    pg: State<'_, PgState>,
    target: PgTarget,
    change: PgChange,
    confirm_text: Option<String>,
    undo_of: Option<String>,
) -> Result<PgApplyResult, AppError> {
    match pg.apply(&app, &target, PgChanges::One(change), confirm_text, undo_of.into_iter().collect()).await? {
        PgCommitResult::One(result) => Ok(result),
        PgCommitResult::Batch(_) => Err(AppError::other("적용 결과를 읽지 못했어요")),
    }
}

#[tauri::command]
pub async fn pg_preview_batch(app: State<'_, AppState>, pg: State<'_, PgState>, target: PgTarget, database: String, changes: Vec<PgChange>) -> Result<PgBatchPreview, AppError> {
    pg.preview_batch(&app, &target, database, changes).await
}

#[tauri::command]
pub async fn pg_apply_batch(
    app: State<'_, AppState>,
    pg: State<'_, PgState>,
    target: PgTarget,
    database: String,
    changes: Vec<PgChange>,
    confirm_text: Option<String>,
    undo_of: Option<Vec<String>>,
) -> Result<PgBatchResult, AppError> {
    match pg.apply(&app, &target, PgChanges::Batch { database, changes }, confirm_text, undo_of.unwrap_or_default()).await? {
        PgCommitResult::Batch(result) => Ok(result),
        PgCommitResult::One(_) => Err(AppError::other("적용 결과를 읽지 못했어요")),
    }
}

/// 변경 기록, 최신순. 연결이 필요 없다
#[tauri::command]
pub async fn pg_change_log(pg: State<'_, PgState>) -> Result<Vec<change_log::PgLogEntry>, AppError> {
    pg.log().await
}

/// 기록 하나의 되돌리기. 적용은 이 값을 미리보기로 확인한 뒤 `pg_apply(undo_of = 기록 id)`로 한다
#[tauri::command]
pub async fn pg_undo(pg: State<'_, PgState>, log_id: String) -> Result<PgUndo, AppError> {
    commit::undo_of(&pg.log().await?, &log_id)
}

#[tauri::command]
pub async fn pg_undo_batch(pg: State<'_, PgState>, batch_id: String) -> Result<PgUndo, AppError> {
    commit::undo_batch_of(&pg.log().await?, &batch_id)
}

/// 새 역할의 프리셋 제안: 같은 권한을 이미 가진 그룹, 새 그룹의 이름, 기본 권한을 줄 만드는 역할
#[tauri::command]
pub async fn pg_preset(
    app: State<'_, AppState>,
    pg: State<'_, PgState>,
    target: PgTarget,
    database: String,
    preset: PresetKind,
    schemas: Vec<String>,
) -> Result<PgPresetSuggestion, AppError> {
    pg.preset(&app, &target, &database, preset, schemas).await
}

/// 역할 삭제 계획. 클러스터와 연결할 수 있는 모든 데이터베이스를 새로 읽는다
#[tauri::command]
pub async fn pg_drop_plan(app: State<'_, AppState>, pg: State<'_, PgState>, target: PgTarget, role: String, reassign_to: String) -> Result<PgDropPlan, AppError> {
    pg.drop_plan(&app, &target, role, reassign_to).await
}

#[tauri::command]
pub async fn pg_apply_drop(
    app: State<'_, AppState>,
    pg: State<'_, PgState>,
    target: PgTarget,
    role: String,
    reassign_to: String,
    confirm_text: Option<String>,
) -> Result<PgDropResult, AppError> {
    pg.apply_drop(&app, &target, role, reassign_to, confirm_text).await
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
