//! 명령 시험: AWS에는 닿지 않는다. 상태(열기·닫기·담기), 점검의 데이터베이스 순회, 건너뛴 이유의 문구를 가짜 서버와 가짜 읽기로 본다.
//! 순회 시험은 연결을 진짜 연결 보관함(`Pool`)으로 열어서, 탭이 닫힌 뒤 연결이 남지 않는지를 본다.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;

use super::*;
use crate::aws::context::AwsContext;
use crate::pg::fake_server::{FakeServer, Script};
use crate::pg::fixtures::{app_scene, database, db, PG16};
use crate::pg::model::{DatabaseRec, Privilege, SessionRec};
use crate::pg::target::TargetKind;

fn target(id: &str) -> PgTarget {
    PgTarget { profile: "dev".into(), region: "ap-northeast-2".into(), kind: TargetKind::Cluster, id: id.into() }
}

fn info() -> PgTargetInfo {
    PgTargetInfo {
        arn: "arn:aws:rds:ap-northeast-2:123456789012:cluster:orders-aurora".into(),
        identifier: "orders-aurora".into(),
        kind: TargetKind::Cluster,
        engine: "aurora-postgresql".into(),
        engine_version: "16.4".into(),
        endpoint: "orders-aurora.cluster-c9akciq32.ap-northeast-2.rds.amazonaws.com".into(),
        port: 5432,
        default_database: "appdb".into(),
        iam_auth: true,
        read_replica: false,
    }
}

fn cluster() -> Arc<ClusterSnapshot> {
    Arc::new(app_scene(PG16).cluster)
}

fn snapshot(name: &str) -> DbSnapshot {
    db(name, "app_owner", Vec::new(), Vec::new(), Vec::new())
}

fn names(all: &[&str]) -> Vec<String> {
    all.iter().map(|name| name.to_string()).collect()
}

/// 대상을 연다(`pg_open`이 끝난 상태). 열기를 시작할 때의 epoch를 돌려준다
fn open(state: &PgState, target: &PgTarget) -> u64 {
    open_with(state, target, cluster())
}

fn open_with(state: &PgState, target: &PgTarget, cluster: Arc<ClusterSnapshot>) -> u64 {
    let start = state.begin_open(target);
    state.finish_open(target, start, "iam_admin".into(), info(), cluster).expect("finish_open");
    start.epoch
}

/// 열기 하나를 `login`으로 시작하고 바로 끝낸다
fn open_as(state: &PgState, target: &PgTarget, login: &str) -> Result<(), AppError> {
    let start = state.begin_open(target);
    state.finish_open(target, start, login.into(), info(), cluster())
}

fn not_opened_error() -> Option<AppError> {
    Some(AppError::other("먼저 연결해 주세요"))
}

// ───────────────────────── 상태 ─────────────────────────

#[test]
fn a_target_that_was_never_opened_is_not_opened() {
    let state = PgState::default();
    assert_eq!(state.opened(&target("a")).err(), not_opened_error());
    assert!(state.cached_db(&target("a"), "appdb").is_none());
    assert!(state.loaded_dbs(&target("a")).is_empty());
}

#[test]
fn opening_stores_the_login_the_info_and_the_cluster_and_drops_the_database_snapshots_of_that_target() {
    let state = PgState::default();
    let (a, b) = (target("a"), target("b"));
    open(&state, &b);
    let opened = state.opened(&b).expect("opened");
    assert_eq!((opened.login.as_str(), opened.info.clone(), opened.epoch), ("iam_admin", info(), 0));
    assert_eq!(opened.cluster.login_user, "iam_admin");

    open(&state, &a);
    let epoch = state.pool.epoch(&a);
    state.keep_db(&a, epoch, "appdb", Arc::new(snapshot("appdb")));
    state.keep_db(&b, epoch, "appdb", Arc::new(snapshot("appdb")));
    assert!(state.cached_db(&a, "appdb").is_some());

    // 다시 열면(다시 읽기, 로그인 사용자 바꾸기) 그 대상의 데이터베이스 스냅숏은 버리고 새 로그인을 기억한다. 다른 대상은 그대로다
    open_as(&state, &a, "other_user").expect("reopen");
    assert!(state.cached_db(&a, "appdb").is_none());
    assert!(state.cached_db(&b, "appdb").is_some());
    assert_eq!(state.opened(&a).expect("opened").login, "other_user");
    assert_eq!(state.opened(&b).expect("opened").login, "iam_admin");
}

#[test]
fn closing_forgets_everything_of_that_target_and_only_that_target_and_counts_the_close() {
    let state = PgState::default();
    let (a, b) = (target("a"), target("b"));
    open(&state, &a);
    open(&state, &b);
    for t in [&a, &b] {
        state.keep_db(t, 0, "appdb", Arc::new(snapshot("appdb")));
    }
    state.close(&a);

    assert_eq!(state.opened(&a).err(), not_opened_error());
    assert!(state.cached_db(&a, "appdb").is_none() && state.loaded_dbs(&a).is_empty());
    assert_eq!(state.pool.epoch(&a), 1);
    assert!(state.opened(&b).is_ok() && state.cached_db(&b, "appdb").is_some());
    assert_eq!(state.pool.epoch(&b), 0);
    // 다시 열면 닫힌 횟수를 달고 열린다
    open(&state, &a);
    assert_eq!(state.opened(&a).expect("opened").epoch, 1);
}

#[tokio::test]
async fn opening_as_another_login_closes_the_connections_of_the_previous_login_and_only_those() {
    let server = FakeServer::start(Script::Ready).await;
    let state = PgState::default();
    let (a, b) = (target("a"), target("b"));
    let epoch = open(&state, &a);
    open(&state, &b);
    // iam_admin이 연 연결 둘(기본 데이터베이스와 다른 데이터베이스)과 다른 대상의 연결 하나
    pool_a_connection(&state, &server, &a, epoch, "appdb", 7).await;
    pool_a_connection(&state, &server, &a, epoch, "orders", 8).await;
    pool_a_connection(&state, &server, &b, state.pool.epoch(&b), "appdb", 20).await;
    // 로그인 사용자를 바꾸는 열기는 새 사용자로 먼저 연결하고, 클러스터를 읽은 뒤에 로그인을 바꾼다(`open`)
    let key = ConnKey { target: a.clone(), user: "other_user".into(), database: "appdb".into() };
    state.pool.get_or_connect_at_epoch(key, epoch, || async { Ok(server.connected(9).await) }).await.expect("connect as the new login");
    assert_eq!(state.pool.backend_pids(&a), vec![7, 8, 9]);

    open_as(&state, &a, "other_user").expect("switch");
    assert_eq!(state.pool.backend_pids(&a), vec![9], "이전 사용자의 연결이 남았어요");
    assert_eq!(state.pool.backend_pids(&b), vec![20], "다른 대상의 연결은 그대로예요");
    assert_eq!(state.pool.epoch(&a), epoch, "대상을 닫은 것이 아니에요");
    assert_eq!(state.opened(&a).expect("opened").login, "other_user");

    // 같은 사용자로 다시 열면(다시 읽기) 그 사용자의 연결을 닫지 않는다
    open_as(&state, &a, "other_user").expect("reopen");
    assert_eq!(state.pool.backend_pids(&a), vec![9]);
    // 처음 열 때(기억한 로그인이 없다)는 닫을 이전 사용자가 없다
    let c = target("c");
    let first = ConnKey { target: c.clone(), user: "iam_admin".into(), database: "appdb".into() };
    state.pool.get_or_connect_at_epoch(first, 0, || async { Ok(server.connected(30).await) }).await.expect("connect");
    open(&state, &c);
    assert_eq!(state.pool.backend_pids(&c), vec![30]);
}

#[tokio::test]
async fn a_late_open_that_is_refused_closes_nothing_of_the_tab_opened_since() {
    // 닫기 전에 시작한 열기가 늦게 끝났다. 그 사이 다시 연 탭의 연결과 로그인은 건드리지 않는다
    let server = FakeServer::start(Script::Ready).await;
    let state = PgState::default();
    let a = target("a");
    let started = state.begin_open(&a);
    state.close(&a);
    let epoch = open(&state, &a);
    pool_a_connection(&state, &server, &a, epoch, "appdb", 7).await;

    let late = state.finish_open(&a, started, "other_user".into(), info(), cluster());
    assert_eq!(late.err(), not_opened_error());
    assert_eq!(state.pool.backend_pids(&a), vec![7]);
    assert_eq!(state.opened(&a).expect("opened").login, "iam_admin");
}

#[test]
fn an_open_that_started_before_a_close_stores_nothing() {
    let state = PgState::default();
    let a = target("a");
    let started = state.begin_open(&a);
    state.close(&a);
    let late = state.finish_open(&a, started, "iam_admin".into(), info(), cluster());
    assert_eq!(late.err(), not_opened_error());
    assert_eq!(state.opened(&a).err(), not_opened_error());
}

// ───────────────────────── 겹쳐 도는 열기 ─────────────────────────
// 열기는 시작할 때 그 대상의 다음 번호를 받는다. 로그인 사용자가 다른 두 열기가 겹쳐 돌 때 먼저 시작한 쪽이 나중에 끝나도 남는 것은 나중에 시작한 쪽이다:
// 화면은 사용자를 바꾼 마지막 선택을 보여 주니, 백엔드가 기억하는 로그인도 그것이어야 한다.

#[tokio::test]
async fn an_older_open_that_finishes_last_is_refused_and_the_newer_login_stays_with_its_connections() {
    let server = FakeServer::start(Script::Ready).await;
    let state = PgState::default();
    let a = target("a");
    let older = state.begin_open(&a);
    let newer = state.begin_open(&a);
    // 열기는 끝나기 전에 자기 사용자로 연결을 열어 둔다(`open`)
    pool_a_connection_as(&state, &server, &a, older.epoch, "old_user", "appdb", 7).await;
    pool_a_connection_as(&state, &server, &a, newer.epoch, "new_user", "appdb", 8).await;

    state.finish_open(&a, newer, "new_user".into(), info(), cluster()).expect("나중에 시작한 열기가 먼저 끝나요");
    let late = state.finish_open(&a, older, "old_user".into(), info(), cluster());

    assert_eq!(late.err(), not_opened_error());
    assert_eq!(state.opened(&a).expect("opened").login, "new_user");
    assert_eq!(state.pool.backend_pids(&a), vec![8], "물러난 열기의 연결은 닫히고 나중 열기의 연결은 남아요");
}

#[tokio::test]
async fn an_older_open_of_the_same_login_is_refused_without_closing_the_connection_the_newer_one_uses() {
    let server = FakeServer::start(Script::Ready).await;
    let state = PgState::default();
    let a = target("a");
    let older = state.begin_open(&a);
    let newer = state.begin_open(&a);
    // 같은 사용자라 연결 열쇠가 같다: 그 연결은 나중 열기가 쓰는 것이다
    pool_a_connection_as(&state, &server, &a, newer.epoch, "iam_admin", "appdb", 8).await;

    state.finish_open(&a, newer, "iam_admin".into(), info(), cluster()).expect("newer");
    let late = state.finish_open(&a, older, "iam_admin".into(), info(), cluster());

    assert_eq!(late.err(), not_opened_error());
    assert_eq!(state.opened(&a).expect("opened").login, "iam_admin");
    assert_eq!(state.pool.backend_pids(&a), vec![8]);
}

#[test]
fn a_refused_older_open_stores_nothing_and_leaves_what_the_newer_one_stored() {
    let state = PgState::default();
    let a = target("a");
    let older = state.begin_open(&a);
    let newer = state.begin_open(&a);
    let newer_cluster = Arc::new(ClusterSnapshot { fetched_at: "newer".into(), ..(*cluster()).clone() });
    let older_cluster = Arc::new(ClusterSnapshot { fetched_at: "older".into(), ..(*cluster()).clone() });
    state.finish_open(&a, newer, "new_user".into(), info(), newer_cluster).expect("newer");
    // 나중 열기가 담은 뒤에 읽은 데이터베이스 스냅숏을, 물러나는 열기가 비우지 않는다
    state.keep_db(&a, newer.epoch, "appdb", Arc::new(snapshot("appdb")));

    assert!(state.finish_open(&a, older, "old_user".into(), info(), older_cluster).is_err());
    let opened = state.opened(&a).expect("opened");
    assert_eq!((opened.login.as_str(), opened.cluster.fetched_at.as_str()), ("new_user", "newer"));
    assert!(state.cached_db(&a, "appdb").is_some());
}

#[test]
fn opens_that_finish_in_the_order_they_started_each_replace_the_one_before() {
    let state = PgState::default();
    let a = target("a");
    let first = state.begin_open(&a);
    let second = state.begin_open(&a);
    state.finish_open(&a, first, "first".into(), info(), cluster()).expect("first");
    assert_eq!(state.opened(&a).expect("opened").login, "first");
    state.finish_open(&a, second, "second".into(), info(), cluster()).expect("second");
    assert_eq!(state.opened(&a).expect("opened").login, "second");
}

#[test]
fn an_open_that_never_finishes_does_not_stop_an_older_one_from_being_accepted() {
    let state = PgState::default();
    let a = target("a");
    let older = state.begin_open(&a);
    // 나중에 시작했지만 연결하지 못해 끝내지 못한 열기
    let _failed = state.begin_open(&a);
    state.finish_open(&a, older, "old_user".into(), info(), cluster()).expect("older");
    assert_eq!(state.opened(&a).expect("opened").login, "old_user");
}

#[test]
fn each_target_counts_its_own_opens() {
    let state = PgState::default();
    let (a, b) = (target("a"), target("b"));
    let (b1, b2) = (state.begin_open(&b), state.begin_open(&b));
    let a1 = state.begin_open(&a);
    assert_eq!((b1.number, b2.number, a1.number), (1, 2, 1));
    // 대상 b의 둘째 열기가 받아들여진 뒤에도 대상 a의 첫 열기는 받아들여진다
    state.finish_open(&b, b2, "iam_admin".into(), info(), cluster()).expect("b2");
    state.finish_open(&a, a1, "iam_admin".into(), info(), cluster()).expect("a1");
    assert_eq!(state.finish_open(&b, b1, "iam_admin".into(), info(), cluster()).err(), not_opened_error());
}

#[test]
fn closing_a_target_does_not_restart_its_numbers() {
    let state = PgState::default();
    let a = target("a");
    let before = state.begin_open(&a);
    state.close(&a);
    let after = state.begin_open(&a);
    assert!(after.number > before.number, "{before:?} → {after:?}");
    assert_eq!(after.epoch, before.epoch + 1);
}

#[test]
fn a_database_read_that_finishes_after_the_close_is_not_kept() {
    let state = PgState::default();
    let a = target("a");
    let epoch = open(&state, &a);
    state.close(&a);
    // 닫힌 대상에는 담지 않는다
    state.keep_db(&a, epoch, "appdb", Arc::new(snapshot("appdb")));
    assert!(state.cached_db(&a, "appdb").is_none());
    // 닫은 뒤에 다시 열었어도, 닫기 전에 시작한 읽기의 결과는 새로 열린 탭에 담지 않는다
    open(&state, &a);
    state.keep_db(&a, epoch, "appdb", Arc::new(snapshot("appdb")));
    assert!(state.cached_db(&a, "appdb").is_none());
    state.keep_db(&a, state.pool.epoch(&a), "appdb", Arc::new(snapshot("appdb")));
    assert!(state.cached_db(&a, "appdb").is_some());
}

#[test]
fn the_loaded_databases_are_the_kept_snapshots_of_the_target_in_name_order() {
    let state = PgState::default();
    let a = target("a");
    open(&state, &a);
    for name in ["orders", "analytics"] {
        state.keep_db(&a, 0, name, Arc::new(snapshot(name)));
    }
    state.keep_db(&target("b"), 0, "elsewhere", Arc::new(snapshot("elsewhere")));
    assert_eq!(state.loaded_dbs(&a).iter().map(|s| s.database.as_str()).collect::<Vec<_>>(), ["analytics", "orders"]);
}

// ───────────────────────── 데이터베이스 스냅숏 ─────────────────────────

#[tokio::test]
async fn a_snapshot_is_read_once_kept_and_read_again_only_when_forced() {
    let state = PgState::default();
    let a = target("a");
    let epoch = open(&state, &a);
    let reads = AtomicUsize::new(0);
    let read = |database: String| {
        let n = reads.fetch_add(1, Ordering::SeqCst) + 1;
        async move {
            // 읽을 때마다 다른 스냅숏이 되도록 읽은 시각 칸에 차례를 적는다
            Ok(DbSnapshot { fetched_at: format!("read #{n}"), ..snapshot(&database) })
        }
    };
    let first = snapshot_of(&state, &a, epoch, "appdb", false, read).await.expect("first");
    assert_eq!((first.fetched_at.as_str(), reads.load(Ordering::SeqCst)), ("read #1", 1));
    let again = snapshot_of(&state, &a, epoch, "appdb", false, read).await.expect("again");
    assert!(Arc::ptr_eq(&first, &again), "읽어 둔 것을 그대로 돌려줘요");
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    // force면 새로 읽어 바꿔 담는다
    let forced = snapshot_of(&state, &a, epoch, "appdb", true, read).await.expect("forced");
    assert_eq!((forced.fetched_at.as_str(), reads.load(Ordering::SeqCst)), ("read #2", 2));
    assert!(Arc::ptr_eq(&state.cached_db(&a, "appdb").expect("cached"), &forced));
}

#[tokio::test]
async fn a_failed_read_keeps_nothing() {
    let state = PgState::default();
    let a = target("a");
    let epoch = open(&state, &a);
    let failed = snapshot_of(&state, &a, epoch, "appdb", false, |_| async { Err(AppError::other("appdb에 연결하지 못했어요: permission denied")) }).await;
    assert_eq!(failed.err(), Some(AppError::other("appdb에 연결하지 못했어요: permission denied")));
    assert!(state.cached_db(&a, "appdb").is_none());
}

fn app_state() -> AppState {
    AppState { ctx: AwsContext::default(), adapters: Vec::new(), settings_path: PathBuf::new(), sso: Default::default() }
}

#[tokio::test]
async fn a_database_the_cluster_does_not_list_is_refused_and_a_kept_snapshot_needs_no_connection() {
    let state = PgState::default();
    let a = target("a");
    open(&state, &a);
    let opened = state.opened(&a).expect("opened");
    let app = app_state();

    let unknown = database_snapshot(&app, &state, &a, &opened, "template1", false).await;
    assert_eq!(unknown.err(), Some(AppError::other("template1에 연결하지 못했어요: 데이터베이스 목록에 없어요")));
    assert_eq!(state.pool.backend_pids(&a), Vec::<i32>::new());

    // 읽어 둔 스냅숏은 AWS 자격 증명도 연결도 없이 돌려준다
    let kept = Arc::new(snapshot("appdb"));
    state.keep_db(&a, opened.epoch, "appdb", kept.clone());
    let hit = database_snapshot(&app, &state, &a, &opened, "appdb", false).await.expect("hit");
    assert!(Arc::ptr_eq(&hit, &kept));
}

// ───────────────────────── 점검의 순회 ─────────────────────────

#[tokio::test]
async fn the_walk_reads_the_databases_in_the_given_order_and_keeps_each_one() {
    let state = PgState::default();
    let a = target("a");
    let epoch = open(&state, &a);
    let order = std::sync::Mutex::new(Vec::new());
    let (snapshots, skipped) = collect_snapshots(&state, &a, epoch, &names(&["analytics", "orders", "postgres"]), false, |database| {
        order.lock().unwrap().push(database.clone());
        async move { Ok(snapshot(&database)) }
    })
    .await
    .expect("walk");
    assert_eq!(snapshots.iter().map(|s| s.database.as_str()).collect::<Vec<_>>(), ["analytics", "orders", "postgres"]);
    assert!(skipped.is_empty());
    assert_eq!(*order.lock().unwrap(), ["analytics", "orders", "postgres"]);
    assert_eq!(state.loaded_dbs(&a).len(), 3);
    // 데이터베이스가 없으면 아무것도 읽지 않는다
    let (none, none_skipped) = collect_snapshots(&state, &a, epoch, &[], false, |_| async { Ok(snapshot("never")) }).await.expect("walk");
    assert!(none.is_empty() && none_skipped.is_empty());
}

#[tokio::test]
async fn a_database_that_fails_is_skipped_with_the_error_text_and_the_walk_goes_on() {
    let state = PgState::default();
    let a = target("a");
    let epoch = open(&state, &a);
    // 끝점에 닿지 못한 오류(네트워크)는 뒤의 데이터베이스를 읽지 않게 하니 맨 뒤에 둔다. 그 앞의 오류는 건너뛰기만 하고 순회는 이어 간다
    let (snapshots, skipped) = collect_snapshots(&state, &a, epoch, &names(&["analytics", "orders", "reports", "legacy"]), false, |database| async move {
        match database.as_str() {
            "analytics" => Err(AppError::other("analytics에 연결하지 못했어요: permission denied for database \"analytics\"")),
            "legacy" => Err(AppError::Network { message: "엔드포인트에 연결하지 못했어요(db.example:5432). VPN이 켜져 있는지 확인하세요".into() }),
            "reports" => Err(AppError::other("질의가 30초 안에 끝나지 않았어요. 잠시 뒤 다시 읽어 주세요")),
            _ => Ok(snapshot(&database)),
        }
    })
    .await
    .expect("실패한 데이터베이스가 있어도 호출은 실패하지 않아요");
    assert_eq!(snapshots.iter().map(|s| s.database.as_str()).collect::<Vec<_>>(), ["orders"]);
    // 이유는 오류의 문구 그대로다(네트워크 오류도 앞에 붙는 말 없이)
    assert_eq!(
        skipped,
        [
            PgSkippedDatabase { database: "analytics".into(), reason: "analytics에 연결하지 못했어요: permission denied for database \"analytics\"".into() },
            PgSkippedDatabase { database: "reports".into(), reason: "질의가 30초 안에 끝나지 않았어요. 잠시 뒤 다시 읽어 주세요".into() },
            PgSkippedDatabase { database: "legacy".into(), reason: "엔드포인트에 연결하지 못했어요(db.example:5432). VPN이 켜져 있는지 확인하세요".into() },
        ]
    );
    // 건너뛴 데이터베이스는 담지 않는다
    assert!(state.cached_db(&a, "analytics").is_none() && state.cached_db(&a, "orders").is_some());
}

const VPN_TEXT: &str = "엔드포인트에 연결하지 못했어요(db.example:5432). VPN이 켜져 있는지 확인하세요";

fn skipped_as(databases: &[&str], reason: &str) -> Vec<PgSkippedDatabase> {
    databases.iter().map(|database| PgSkippedDatabase { database: database.to_string(), reason: reason.to_string() }).collect()
}

#[tokio::test]
async fn after_the_first_network_error_the_walk_stops_connecting_and_skips_the_rest_with_the_same_reason() {
    // 한 대상의 데이터베이스는 끝점 하나를 같이 쓴다. VPN이 꺼졌으면 데이터베이스마다 10초씩 기다릴 이유가 없다
    let state = PgState::default();
    let a = target("a");
    let epoch = open(&state, &a);
    let calls = std::sync::Mutex::new(Vec::new());
    let (snapshots, skipped) = collect_snapshots(&state, &a, epoch, &names(&["analytics", "legacy", "orders", "reports"]), false, |database| {
        calls.lock().unwrap().push(database.clone());
        async move {
            if database == "legacy" {
                Err(AppError::Network { message: VPN_TEXT.into() })
            } else {
                Ok(snapshot(&database))
            }
        }
    })
    .await
    .expect("끝점에 닿지 못해도 호출은 실패하지 않아요");
    assert_eq!(*calls.lock().unwrap(), ["analytics", "legacy"], "닿지 못한 뒤에는 읽으러 가지 않아요");
    assert_eq!(snapshots.iter().map(|s| s.database.as_str()).collect::<Vec<_>>(), ["analytics"]);
    assert_eq!(skipped, skipped_as(&["legacy", "orders", "reports"], VPN_TEXT));
    assert!(state.cached_db(&a, "orders").is_none() && state.cached_db(&a, "analytics").is_some());
}

#[tokio::test]
async fn an_error_that_is_not_a_network_error_does_not_stop_the_walk() {
    let state = PgState::default();
    let a = target("a");
    let epoch = open(&state, &a);
    let reads = AtomicUsize::new(0);
    let (snapshots, skipped) = collect_snapshots(&state, &a, epoch, &names(&["one", "two", "three"]), false, |database| {
        reads.fetch_add(1, Ordering::SeqCst);
        async move {
            if database == "one" {
                Err(AppError::other("one에 연결하지 못했어요: permission denied"))
            } else {
                Ok(snapshot(&database))
            }
        }
    })
    .await
    .expect("walk");
    assert_eq!(reads.load(Ordering::SeqCst), 3);
    assert_eq!(snapshots.len(), 2);
    assert_eq!(skipped, skipped_as(&["one"], "one에 연결하지 못했어요: permission denied"));
}

#[tokio::test]
async fn the_snapshots_already_read_are_still_used_after_a_network_error() {
    let state = PgState::default();
    let a = target("a");
    let epoch = open(&state, &a);
    let kept = Arc::new(snapshot("reports"));
    state.keep_db(&a, epoch, "reports", kept.clone());
    let calls = std::sync::Mutex::new(Vec::new());
    let (snapshots, skipped) = collect_snapshots(&state, &a, epoch, &names(&["legacy", "orders", "reports"]), false, |database| {
        calls.lock().unwrap().push(database.clone());
        async move {
            if database == "legacy" {
                Err(AppError::Network { message: VPN_TEXT.into() })
            } else {
                Ok(snapshot(&database))
            }
        }
    })
    .await
    .expect("walk");
    assert_eq!(*calls.lock().unwrap(), ["legacy"]);
    // 읽어 둔 reports는 연결 없이 그대로 쓰고, 읽어 둔 것이 없는 orders만 건너뛴다
    assert_eq!(snapshots.len(), 1);
    assert!(Arc::ptr_eq(&snapshots[0], &kept));
    assert_eq!(skipped, skipped_as(&["legacy", "orders"], VPN_TEXT));
}

#[tokio::test]
async fn a_forced_walk_cannot_read_again_after_a_network_error_so_it_skips_the_rest_like_any_failed_read() {
    let state = PgState::default();
    let a = target("a");
    let epoch = open(&state, &a);
    state.keep_db(&a, epoch, "reports", Arc::new(snapshot("reports")));
    let reads = AtomicUsize::new(0);
    let (snapshots, skipped) = collect_snapshots(&state, &a, epoch, &names(&["legacy", "reports"]), true, |_| {
        reads.fetch_add(1, Ordering::SeqCst);
        async { Err(AppError::Network { message: VPN_TEXT.into() }) }
    })
    .await
    .expect("walk");
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert!(snapshots.is_empty());
    assert_eq!(skipped, skipped_as(&["legacy", "reports"], VPN_TEXT));
    // 건너뛰어도 읽어 둔 것은 지우지 않는다
    assert!(state.cached_db(&a, "reports").is_some());
}

#[test]
fn the_reason_of_a_skipped_database_is_the_text_of_the_error() {
    assert_eq!(error_text(&AppError::other("permission denied")), "permission denied");
    assert_eq!(error_text(&AppError::Network { message: "VPN을 확인하세요".into() }), "VPN을 확인하세요");
    assert_eq!(error_text(&AppError::SsoExpired), "SSO 세션이 만료됐어요");
    assert_eq!(error_text(&AppError::AccessDenied { action: "sts:AssumeRole".into() }), "권한 없음 (sts:AssumeRole)");
}

#[tokio::test]
async fn read_snapshots_are_used_unless_forced() {
    let state = PgState::default();
    let a = target("a");
    let epoch = open(&state, &a);
    let kept = Arc::new(snapshot("orders"));
    state.keep_db(&a, epoch, "orders", kept.clone());
    let reads = std::sync::Mutex::new(Vec::new());
    let read = |database: String| {
        reads.lock().unwrap().push(database.clone());
        async move { Ok(snapshot(&database)) }
    };

    let (cached, _) = collect_snapshots(&state, &a, epoch, &names(&["analytics", "orders"]), false, read).await.expect("walk");
    assert_eq!(*reads.lock().unwrap(), ["analytics"], "읽어 둔 orders는 다시 읽지 않아요");
    assert!(Arc::ptr_eq(&cached[1], &kept));

    reads.lock().unwrap().clear();
    let (forced, _) = collect_snapshots(&state, &a, epoch, &names(&["analytics", "orders"]), true, read).await.expect("walk");
    assert_eq!(*reads.lock().unwrap(), ["analytics", "orders"]);
    assert!(!Arc::ptr_eq(&forced[1], &kept));
    assert!(Arc::ptr_eq(&state.cached_db(&a, "orders").expect("cached"), &forced[1]), "새로 읽은 것으로 바꿔 담아요");
}

#[tokio::test]
async fn a_credential_problem_ends_the_walk_instead_of_being_skipped() {
    // SSO 만료나 권한 거부는 데이터베이스 하나의 문제가 아니다: 호출이 실패해야 앱의 자동 로그인이 이어받는다
    for error in [AppError::SsoExpired, AppError::AccessDenied { action: "sts:AssumeRole".into() }, AppError::Throttled] {
        let state = PgState::default();
        let a = target("a");
        let epoch = open(&state, &a);
        let reads = AtomicUsize::new(0);
        let failure = error.clone();
        let result = collect_snapshots(&state, &a, epoch, &names(&["one", "two"]), false, |database| {
            reads.fetch_add(1, Ordering::SeqCst);
            let failure = failure.clone();
            async move {
                if database == "one" {
                    Err(failure)
                } else {
                    Ok(snapshot(&database))
                }
            }
        })
        .await;
        assert_eq!(result.err(), Some(error));
        assert_eq!(reads.load(Ordering::SeqCst), 1, "더 읽지 않아요");
    }
}

/// 데이터베이스 하나를 읽는 척한다: 연결 보관함에서 가짜 서버로 연결을 얻고(`epoch`에 묶어), 빈 스냅숏을 돌려준다.
/// `during`은 이 데이터베이스를 읽는 동안 할 일이다: `("one", false)`면 읽고 난 뒤, `("two", true)`면 연결하는 사이에 탭을 닫는다.
async fn pretend_read(state: &PgState, server: &FakeServer, target: &PgTarget, epoch: u64, database: String, close: Option<(&str, bool)>) -> Result<DbSnapshot, AppError> {
    let key = ConnKey { target: target.clone(), user: "iam_admin".into(), database: database.clone() };
    let closing_during_connect = close == Some((database.as_str(), true));
    state
        .pool
        .get_or_connect_at_epoch(key, epoch, || async {
            if closing_during_connect {
                state.close(target);
            }
            Ok(server.connected(7).await)
        })
        .await?;
    if close == Some((database.as_str(), false)) {
        state.close(target);
    }
    Ok(snapshot(&database))
}

#[tokio::test]
async fn closing_the_tab_between_databases_stops_the_walk_and_leaves_no_connection() {
    let server = FakeServer::start(Script::Ready).await;
    let state = PgState::default();
    let a = target("a");
    let epoch = open(&state, &a);
    let reads = AtomicUsize::new(0);

    let result = collect_snapshots(&state, &a, epoch, &names(&["one", "two", "three"]), false, |database| {
        reads.fetch_add(1, Ordering::SeqCst);
        // 첫 데이터베이스를 읽은 뒤, 둘째로 넘어가기 전에 탭이 닫힌다
        pretend_read(&state, &server, &a, epoch, database, Some(("one", false)))
    })
    .await;

    assert_eq!(result.err(), not_opened_error(), "닫힌 탭의 점검은 \"먼저 연결해 주세요\"로 끝나요");
    assert_eq!(reads.load(Ordering::SeqCst), 1, "닫은 뒤에는 데이터베이스를 읽으러 가지 않아요");
    assert_eq!(server.accepted(), 1, "닫은 뒤에 새 연결을 열지 않았어요");
    assert!(state.pool.backend_pids(&a).is_empty(), "연결이 남았어요");
    assert!(state.cached_db(&a, "one").is_none() && state.opened(&a).is_err(), "닫은 탭에는 아무것도 남지 않아요");
}

#[tokio::test]
async fn closing_the_tab_while_a_database_connects_ends_the_walk_without_skipping_it_or_keeping_the_connection() {
    let server = FakeServer::start(Script::Ready).await;
    let state = PgState::default();
    let a = target("a");
    let epoch = open(&state, &a);
    let reads = AtomicUsize::new(0);

    let result = collect_snapshots(&state, &a, epoch, &names(&["one", "two", "three"]), false, |database| {
        reads.fetch_add(1, Ordering::SeqCst);
        // 둘째에 연결하는 사이에 탭이 닫힌다
        pretend_read(&state, &server, &a, epoch, database, Some(("two", true)))
    })
    .await;

    // 닫힌 탓의 실패는 "건너뛴 데이터베이스"가 아니다. 호출이 끝나고, 셋째는 시도하지 않는다
    assert_eq!(result.err(), not_opened_error());
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    assert_eq!(server.accepted(), 2, "연결하던 중이라 열린 연결은 있었지만 보관하지 않았어요");
    assert!(state.pool.backend_pids(&a).is_empty(), "연결이 남았어요");
}

#[tokio::test]
async fn closing_the_tab_while_the_last_database_connects_is_not_a_skipped_database_either() {
    let server = FakeServer::start(Script::Ready).await;
    let state = PgState::default();
    let a = target("a");
    let epoch = open(&state, &a);

    // 둘째가 마지막이라 "다음 데이터베이스 앞의 검사"가 가려 주지 않는다: 닫힌 탓의 실패는 그 자리에서 "먼저 연결해 주세요"로 끝나야 한다
    let result = collect_snapshots(&state, &a, epoch, &names(&["one", "two"]), false, |database| pretend_read(&state, &server, &a, epoch, database, Some(("two", true)))).await;

    assert_eq!(result.err(), not_opened_error());
    assert!(state.pool.backend_pids(&a).is_empty(), "연결이 남았어요");
}

#[tokio::test]
async fn a_walk_that_started_before_a_close_and_reopen_does_not_touch_the_new_session() {
    let server = FakeServer::start(Script::Ready).await;
    let state = PgState::default();
    let a = target("a");
    let old_epoch = open(&state, &a);
    state.close(&a);
    open(&state, &a);
    // 닫기 전에 시작한 점검이 다시 열린 탭에서 연결을 열지 않는다
    let reads = AtomicUsize::new(0);
    let result = collect_snapshots(&state, &a, old_epoch, &names(&["one"]), false, |database| {
        reads.fetch_add(1, Ordering::SeqCst);
        pretend_read(&state, &server, &a, old_epoch, database, None)
    })
    .await;
    assert_eq!(result.err(), not_opened_error());
    assert_eq!((reads.load(Ordering::SeqCst), server.accepted()), (0, 0));
    assert!(state.loaded_dbs(&a).is_empty());
}

// ───────────────────────── 명령의 몸통 ─────────────────────────
// Tauri 명령은 `PgState`의 메서드를 한 줄로 부른다. 여기서는 AWS에 닿는 길(RDS API, 새 연결)은 보지 않는다.
// 닿기 전에 걸러지는 것, 읽어 둔 스냅숏으로 답하는 것, 연결 보관함에 이미 있는 연결로 읽는 것을 본다.

const PERMISSION_DENIED: &str = "permission denied for table pg_class";

/// 연결 보관함에 `database`용 연결을 미리 넣어 둔다(가짜 서버, 백엔드 PID는 `pid`). 명령은 새로 연결하지 않고 이것을 쓴다
async fn pool_a_connection(state: &PgState, server: &FakeServer, target: &PgTarget, epoch: u64, database: &str, pid: i32) {
    pool_a_connection_as(state, server, target, epoch, "iam_admin", database, pid).await;
}

/// `pool_a_connection`을 DB 사용자 `user`로 넣는다
async fn pool_a_connection_as(state: &PgState, server: &FakeServer, target: &PgTarget, epoch: u64, user: &str, database: &str, pid: i32) {
    let key = ConnKey { target: target.clone(), user: user.into(), database: database.into() };
    state.pool.get_or_connect_at_epoch(key, epoch, || async { Ok(server.connected(pid).await) }).await.expect("pooled");
}

fn session(pid: i32, role: &str) -> SessionRec {
    SessionRec {
        pid,
        role: Some(role.into()),
        database: Some("appdb".into()),
        client_addr: Some("10.0.0.5".into()),
        application_name: "psql".into(),
        state: Some("idle".into()),
        backend_start: None,
        query_start: None,
        wait_event: None,
    }
}

#[tokio::test]
async fn a_bad_login_name_is_refused_before_aws_is_asked_and_the_open_state_stays() {
    let state = PgState::default();
    let (a, b) = (target("a"), target("b"));
    let epoch = open(&state, &a);
    state.keep_db(&a, epoch, "appdb", Arc::new(snapshot("appdb")));
    let app = app_state();

    let invalid = "DB 사용자 이름이 올바르지 않아요. 공백이나 \" < > # & % + 같은 문자는 쓸 수 없어요";
    let too_long = "DB 사용자 이름은 63바이트까지 쓸 수 있어요";
    let long = "x".repeat(64);
    // 열려 있는 대상과 열린 적 없는 대상 모두에서: 이름을 AWS보다 먼저 본다(AWS에 물었다면 다른 오류가 나온다)
    for target in [&a, &b] {
        for (login, text) in [("", invalid), ("two words", invalid), ("a\"b", invalid), ("a&b", invalid), ("a+b", invalid), (long.as_str(), too_long)] {
            let refused = state.open(&app, target.clone(), login.to_string()).await;
            assert_eq!(refused.err(), Some(AppError::other(text)), "{login:?}");
        }
    }
    // 거절한 열기는 아무것도 바꾸지 않는다
    let opened = state.opened(&a).expect("still open");
    assert_eq!((opened.login.as_str(), opened.epoch), ("iam_admin", 0));
    assert!(state.cached_db(&a, "appdb").is_some());
    assert_eq!(state.opened(&b).err(), not_opened_error());
}

#[tokio::test]
async fn a_target_that_is_not_open_gets_the_connect_first_text_from_every_command() {
    let state = PgState::default();
    let app = app_state();
    let a = target("a");
    let object = PgObjectRef::database("appdb");

    assert_eq!(state.database(&app, &a, "appdb", false).await.err(), not_opened_error());
    assert_eq!(state.cell(&app, &a, "appdb", "alice".into(), "app".into()).await.err(), not_opened_error());
    assert_eq!(state.objects(&app, &a, "appdb", "ord".into()).await.err(), not_opened_error());
    assert_eq!(state.role(&a, "alice".into()).await.err(), not_opened_error());
    assert_eq!(state.who_can(&app, &a, "appdb", object.clone(), "SELECT").await.err(), not_opened_error());
    assert_eq!(state.sessions(&app, &a).await.err(), not_opened_error());
    assert_eq!(state.findings(&app, &a, false).await.err(), not_opened_error());
    // 권한 이름이 틀려도 연결 상태가 먼저다
    assert_eq!(state.who_can(&app, &a, "appdb", object, "SUPERPOWER").await.err(), not_opened_error());

    // 닫은 탭도 같다
    open(&state, &a);
    state.close(&a);
    assert_eq!(state.findings(&app, &a, true).await.err(), not_opened_error());
    assert_eq!(state.role(&a, "alice".into()).await.err(), not_opened_error());
}

#[tokio::test]
async fn the_commands_answer_from_the_kept_snapshots_without_connecting() {
    let state = PgState::default();
    let a = target("a");
    let scene = app_scene(PG16);
    let (cluster, db) = (Arc::new(scene.cluster), Arc::new(scene.db));
    let epoch = open_with(&state, &a, cluster.clone());
    state.keep_db(&a, epoch, "appdb", db.clone());
    let app = app_state();
    let orders = PgObjectRef::relation(db.relations.iter().find(|r| r.name == "orders").expect("orders"));

    assert_eq!(state.database(&app, &a, "appdb", false).await, Ok(summary::database_view(&cluster, &db)));
    assert_eq!(state.cell(&app, &a, "appdb", "alice".into(), "app".into()).await, summary::cell_detail(&cluster, &db, "alice", "app"));
    let found = state.objects(&app, &a, "appdb", "ord".into()).await.expect("objects");
    assert_eq!(found, summary::search_objects(&cluster, &db, "ord"));
    assert!(found.contains(&orders), "{found:?}");
    assert_eq!(state.who_can(&app, &a, "appdb", orders.clone(), "SELECT").await, summary::who_can_view(&cluster, &db, &orders, Privilege::Select));
    assert_eq!(state.role(&a, "alice".into()).await, summary::role_view(&cluster, &[&*db], "alice", now_secs(), &[]));
    // 틀린 입력은 빌더의 오류 그대로 나간다
    assert_eq!(state.who_can(&app, &a, "appdb", orders, "SUPERPOWER").await.err(), Some(AppError::other("알 수 없는 권한이에요: SUPERPOWER")));
    assert_eq!(state.cell(&app, &a, "appdb", "nobody".into(), "app".into()).await.err(), Some(AppError::other("역할을 찾을 수 없어요: nobody")));

    let checked = state.findings(&app, &a, false).await.expect("findings");
    let expected = checks::findings(&cluster, &[&*db], Vec::new(), now_secs());
    assert!(!expected.groups.is_empty());
    assert_eq!((checked.groups, checked.skipped), (expected.groups, expected.skipped));
    assert_eq!(state.pool.backend_pids(&a), Vec::<i32>::new(), "연결을 열지 않았어요");
}

#[tokio::test]
async fn a_role_view_marks_the_sessions_of_the_connections_this_app_holds() {
    let server = FakeServer::start(Script::Ready).await;
    let state = PgState::default();
    let a = target("a");
    let mut scene = app_scene(PG16);
    scene.cluster.sessions = vec![session(7, "alice"), session(8, "alice"), session(9, "bob")];
    let epoch = open_with(&state, &a, Arc::new(scene.cluster));
    pool_a_connection(&state, &server, &a, epoch, "appdb", 7).await;

    let view = state.role(&a, "alice".into()).await.expect("role");
    assert_eq!(view.sessions.iter().map(|s| (s.pid, s.own)).collect::<Vec<_>>(), [(7, true), (8, false)]);
    assert_eq!(state.role(&a, "nobody".into()).await.err(), Some(AppError::other("역할을 찾을 수 없어요: nobody")));
}

#[tokio::test]
async fn reads_that_need_the_server_use_the_connection_the_pool_holds_and_a_failed_read_keeps_what_was_kept() {
    let server = FakeServer::start(Script::RejectsQueries { code: "42501", message: PERMISSION_DENIED }).await;
    let state = PgState::default();
    let a = target("a");
    let scene = app_scene(PG16);
    let (cluster, db) = (Arc::new(scene.cluster), Arc::new(scene.db));
    let epoch = open_with(&state, &a, cluster.clone());
    pool_a_connection(&state, &server, &a, epoch, "appdb", 7).await;
    let app = app_state();
    let denied = || Some(AppError::other(PERMISSION_DENIED));

    // 세션은 기본 데이터베이스의 연결로 읽는다
    assert_eq!(state.sessions(&app, &a).await.err(), denied());
    // 읽어 둔 것이 없으면 읽는다. 읽지 못하면 아무것도 담지 않는다
    assert_eq!(state.database(&app, &a, "appdb", false).await.err(), denied());
    assert_eq!(state.cell(&app, &a, "appdb", "alice".into(), "app".into()).await.err(), denied());
    assert_eq!(state.objects(&app, &a, "appdb", "ord".into()).await.err(), denied());
    assert!(state.cached_db(&a, "appdb").is_none());
    // 읽어 둔 것이 있으면 force일 때만 다시 읽는다. 다시 읽다 실패해도 읽어 둔 것은 그대로다
    state.keep_db(&a, epoch, "appdb", db.clone());
    assert_eq!(state.database(&app, &a, "appdb", false).await, Ok(summary::database_view(&cluster, &db)));
    assert_eq!(state.database(&app, &a, "appdb", true).await.err(), denied());
    assert!(Arc::ptr_eq(&state.cached_db(&a, "appdb").expect("kept"), &db));
    // 점검도 force면 다시 읽고, 읽지 못한 데이터베이스는 이유와 함께 건너뛴다
    let forced = state.findings(&app, &a, true).await.expect("findings");
    assert_eq!(forced.skipped, [PgSkippedDatabase { database: "appdb".into(), reason: PERMISSION_DENIED.into() }]);
    assert!(state.findings(&app, &a, false).await.expect("findings").skipped.is_empty());
    assert_eq!(server.accepted(), 1, "보관함에 있는 연결만 썼어요");
}

#[tokio::test]
async fn the_findings_walk_leaves_out_databases_that_do_not_accept_connections() {
    let state = PgState::default();
    let a = target("a");
    let mut scene = app_scene(PG16);
    scene.cluster.databases.push(DatabaseRec { allow_conn: false, ..database("template0", "app_owner") });
    let (cluster, db) = (Arc::new(scene.cluster), Arc::new(scene.db));
    let epoch = open_with(&state, &a, cluster.clone());
    state.keep_db(&a, epoch, "appdb", db.clone());

    // template0은 연결할 수 없다: 시도하지도, 건너뛴 데이터베이스로 적지도 않는다
    let found = state.findings(&app_state(), &a, false).await.expect("findings");
    assert!(found.skipped.is_empty(), "{:?}", found.skipped);
    assert_eq!(found.groups, checks::findings(&cluster, &[&*db], Vec::new(), now_secs()).groups);
}

// ───────────────────────── 보관함 청소, 인자 ─────────────────────────

#[tokio::test]
async fn the_sweeper_calls_the_sweep_again_and_again() {
    let calls = Arc::new(AtomicUsize::new(0));
    let task = tokio::spawn(sweep_every(Duration::from_millis(10), {
        let calls = calls.clone();
        move || {
            calls.fetch_add(1, Ordering::SeqCst);
        }
    }));
    for _ in 0..200 {
        if calls.load(Ordering::SeqCst) >= 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    task.abort();
    assert!(calls.load(Ordering::SeqCst) >= 3, "청소가 되풀이되지 않았어요");
    assert_eq!(SWEEP_EVERY, Duration::from_secs(60));
}

#[test]
fn the_frontend_sends_the_target_as_one_object_and_the_object_ref_back_unchanged() {
    let sent: PgTarget = serde_json::from_value(json!({ "profile": "prod", "region": "ap-northeast-2", "kind": "cluster", "id": "orders-aurora" })).expect("target");
    assert_eq!(sent, PgTarget { profile: "prod".into(), region: "ap-northeast-2".into(), kind: TargetKind::Cluster, id: "orders-aurora".into() });
    let instance: PgTarget = serde_json::from_value(json!({ "profile": "p", "region": "r", "kind": "instance", "id": "i" })).expect("target");
    assert_eq!(instance.kind, TargetKind::Instance);
    assert!(serde_json::from_value::<PgTarget>(json!({ "profile": "p", "region": "r", "kind": "proxy", "id": "i" })).is_err());
    // 같은 값이 키로 쓰이므로 두 번 읽어도 같다
    assert_eq!(sent, serde_json::from_value(serde_json::to_value(&sent).expect("json")).expect("target"));
}

// ───────────────────────── 변경 ─────────────────────────

#[test]
fn keeping_a_cluster_replaces_only_the_cluster_and_checks_the_epoch() {
    let state = PgState::default();
    let t = target("a");
    let epoch = open(&state, &t);
    state.keep_db(&t, epoch, "appdb", Arc::new(snapshot("appdb")));
    let mut fresh = (*cluster()).clone();
    fresh.fetched_at = "2030-01-01T00:00:00Z".into();
    state.keep_cluster(&t, epoch, Arc::new(fresh));
    assert_eq!(state.opened(&t).unwrap().cluster.fetched_at, "2030-01-01T00:00:00Z");
    assert!(state.cached_db(&t, "appdb").is_some(), "다른 스냅숏은 그대로 둬요");

    // 닫힌 뒤에 끝난 읽기는 담지 않는다
    state.close(&t);
    state.keep_cluster(&t, epoch, cluster());
    assert_eq!(state.opened(&t).err(), not_opened_error());
    // 닫고 다시 연 대상에 이전 epoch의 읽기를 담지 않는다
    let reopened = open(&state, &t);
    assert_ne!(reopened, epoch);
    let mut stale = (*cluster()).clone();
    stale.fetched_at = "2001-01-01T00:00:00Z".into();
    state.keep_cluster(&t, epoch, Arc::new(stale));
    assert_ne!(state.opened(&t).unwrap().cluster.fetched_at, "2001-01-01T00:00:00Z");
}

#[test]
fn the_execution_database_must_be_listed_and_connectable() {
    let cluster = app_scene(PG16).cluster;
    assert_eq!(check_execution_database(&cluster, "appdb"), Ok(()));
    for name in ["template1", "rdsadmin", "nope"] {
        assert_eq!(check_execution_database(&cluster, name), Err(AppError::other(format!("이 데이터베이스에서는 바꿀 수 없어요: {name}"))), "{name}");
    }
    let mut closed = cluster.clone();
    closed.databases[0].allow_conn = false;
    assert!(check_execution_database(&closed, "appdb").is_err());
}

#[test]
fn plans_are_kept_per_target_and_change_and_used_once() {
    use crate::pg::change::model::PgChange;
    let state = PgState::default();
    let change = PgChange::Password { role: "carol".into() };
    let other = PgChange::Password { role: "bob".into() };
    let batch = ("appdb".to_string(), vec![change.clone()]);
    let plan = || PgPlan::Batch(crate::pg::view::PgBatchPreview {
        database: "appdb".into(),
        login_user: "mm".into(),
        items: Vec::new(),
        sql: Vec::new(),
        impacts: Vec::new(),
        impacts_omitted: 0,
        roles: Vec::new(),
        defaults: Vec::new(),
        warnings: Vec::new(),
        confirm_text: None,
        reversible: false,
    });
    let (a, b) = (target("a"), target("b"));
    locked(&state.plans).remember("dev", &(&a, &change), plan(), 100);
    locked(&state.plans).remember("dev", &(&a, (&batch.0, &batch.1)), plan(), 100);
    assert!(locked(&state.plans).take("dev", &(&b, &change), 101).is_none());
    assert!(locked(&state.plans).take("dev", &(&a, &other), 101).is_none());
    assert!(locked(&state.plans).take("dev", &(&a, &change), 101).is_some());
    assert!(locked(&state.plans).take("dev", &(&a, &change), 102).is_none(), "한 번만 쓴다");
    assert!(locked(&state.plans).take("dev", &(&a, (&batch.0, &batch.1)), 101).is_some());
}

#[tokio::test]
async fn the_change_log_is_newest_first_and_needs_no_connection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db-changes.jsonl");
    let state = PgState::new(path.clone());
    assert!(state.log().await.unwrap().is_empty());
    for id in ["a", "b"] {
        change_log::append(
            &path,
            &change_log::PgLogEntry {
                id: id.into(),
                at: "2026-10-29T00:00:00Z".into(),
                profile: "dev".into(),
                target_arn: "arn".into(),
                database: "appdb".into(),
                login_user: "mm".into(),
                change: PgChange::Password { role: "carol".into() },
                summary: "s".into(),
                sql: Vec::new(),
                ok: true,
                error: None,
                inverse: None,
                undo_of: None,
                undone: false,
                batch_id: None,
            },
        )
        .unwrap();
    }
    assert_eq!(state.log().await.unwrap().iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["b", "a"]);
}
