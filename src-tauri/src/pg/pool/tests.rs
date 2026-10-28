use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::pg::fake_server::{FakeServer, Script};
use crate::pg::target::TargetKind;

fn target(id: &str) -> PgTarget {
    PgTarget { profile: "dev".into(), region: "ap-northeast-2".into(), kind: TargetKind::Cluster, id: id.into() }
}

fn key(id: &str, database: &str) -> ConnKey {
    ConnKey { target: target(id), user: "iam_admin".into(), database: database.into() }
}

/// 가짜 서버에 진짜로 연결해 `pid`를 단 연결을 돌려주는 연결 함수
async fn open(server: &FakeServer, pid: i32) -> Result<Connected, AppError> {
    Ok(server.connected(pid).await)
}

async fn get(pool: &Pool, server: &FakeServer, key: ConnKey, pid: i32) -> Arc<Mutex<Connected>> {
    pool.get_or_connect(key, || open(server, pid)).await.unwrap()
}

#[tokio::test]
async fn a_second_get_for_the_same_key_reuses_the_entry_without_connecting() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let called = AtomicUsize::new(0);
    let first = get(&pool, &server, key("a", "app"), 11).await;
    let second = pool
        .get_or_connect(key("a", "app"), || {
            called.fetch_add(1, Ordering::SeqCst);
            open(&server, 12)
        })
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(called.load(Ordering::SeqCst), 0, "연결 함수를 부르면 안 돼요");
    assert_eq!(server.accepted(), 1);
    assert_eq!(pool.backend_pids(&target("a")), vec![11]);
}

#[tokio::test]
async fn different_databases_users_and_targets_make_separate_entries() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let app = get(&pool, &server, key("a", "app"), 1).await;
    let other_db = get(&pool, &server, key("a", "orders"), 2).await;
    let other_user = get(&pool, &server, ConnKey { user: "reader".into(), ..key("a", "app") }, 3).await;
    let other_target = get(&pool, &server, key("b", "app"), 4).await;
    for (name, conn) in [("데이터베이스", &other_db), ("사용자", &other_user), ("대상", &other_target)] {
        assert!(!Arc::ptr_eq(&app, conn), "{name}이 다르면 연결도 달라야 해요");
    }
    assert_eq!(server.accepted(), 4);
    assert_eq!(pool.backend_pids(&target("a")), vec![1, 2, 3]);
    assert_eq!(pool.backend_pids(&target("b")), vec![4]);
}

#[tokio::test]
async fn a_connect_that_close_target_interrupts_is_not_stored() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    // 연결하는 사이에 탭이 닫힌다
    let interrupted = pool
        .get_or_connect(key("a", "app"), || async {
            pool.close_target(&target("a"));
            open(&server, 1).await
        })
        .await;
    assert_eq!(interrupted.err(), Some(AppError::other("먼저 연결해 주세요")));
    assert!(pool.backend_pids(&target("a")).is_empty(), "닫힌 대상의 연결이 보관됐어요");
    // 닫은 뒤에 새로 여는 연결은 보관된다
    get(&pool, &server, key("a", "app"), 2).await;
    assert_eq!(pool.backend_pids(&target("a")), vec![2]);
}

#[tokio::test]
async fn closing_another_target_does_not_interrupt_a_connect() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let kept = pool
        .get_or_connect(key("a", "app"), || async {
            pool.close_target(&target("b"));
            open(&server, 1).await
        })
        .await;
    assert!(kept.is_ok());
    assert_eq!(pool.backend_pids(&target("a")), vec![1]);
}

#[tokio::test]
async fn a_connect_started_after_the_close_is_stored_even_if_an_older_one_finishes_later() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    // 오래된 연결(닫기 전에 시작)이 새 연결(닫은 뒤에 시작)보다 늦게 끝난다: 신호로 순서를 고정한다
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let (stored_tx, stored_rx) = tokio::sync::oneshot::channel::<()>();
    let (older, newer) = tokio::join!(
        pool.get_or_connect(key("a", "app"), || async {
            pool.close_target(&target("a"));
            closed_tx.send(()).unwrap();
            stored_rx.await.unwrap();
            open(&server, 1).await
        }),
        async {
            closed_rx.await.unwrap();
            let newer = pool.get_or_connect(key("a", "app"), || open(&server, 2)).await;
            stored_tx.send(()).unwrap();
            newer
        }
    );
    assert_eq!(older.err(), Some(AppError::other("먼저 연결해 주세요")));
    assert!(newer.is_ok());
    assert_eq!(pool.backend_pids(&target("a")), vec![2], "닫은 뒤에 시작한 연결만 남아야 해요");
}

#[tokio::test]
async fn sweep_drops_connections_idle_past_the_limit_and_keeps_recent_ones() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    get(&pool, &server, key("a", "one"), 1).await;
    get(&pool, &server, key("a", "two"), 2).await;
    // IDLE 안에 쓴 연결은 남는다
    pool.sweep(Instant::now() + IDLE - Duration::from_secs(60));
    assert_eq!(pool.backend_pids(&target("a")), vec![1, 2]);
    // IDLE을 넘겨 쉰 연결은 닫힌다
    pool.sweep(Instant::now() + IDLE + Duration::from_secs(1));
    assert!(pool.backend_pids(&target("a")).is_empty());
}

#[tokio::test]
async fn sweep_keeps_a_connection_idle_for_exactly_the_limit_and_the_one_used_again() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let t0 = Instant::now();
    pool.get_or_connect_at(key("a", "one"), t0, || open(&server, 1)).await.unwrap();
    pool.get_or_connect_at(key("a", "two"), t0, || open(&server, 2)).await.unwrap();
    pool.sweep(t0 + IDLE);
    assert_eq!(pool.backend_pids(&target("a")), vec![1, 2], "딱 IDLE만큼 쉰 연결은 남아요");
    // 9분째에 one만 다시 쓰면, 10분 1초째에는 two만 닫힌다
    let nine_minutes = t0 + Duration::from_secs(540);
    pool.get_or_connect_at(key("a", "one"), nine_minutes, || open(&server, 99)).await.unwrap();
    pool.sweep(t0 + IDLE + Duration::from_secs(1));
    assert_eq!(pool.backend_pids(&target("a")), vec![1]);
    pool.sweep(nine_minutes + IDLE + Duration::from_secs(1));
    assert!(pool.backend_pids(&target("a")).is_empty());
}

// ───────────────────────── 벽시계 ─────────────────────────
// macOS의 `Instant`는 맥이 잠자는 동안 멈춘다. 밤새 자고 일어나도 `Instant`로는 몇 초 쉰 연결이라서, 벽시계(`SystemTime`)로도 잰다.

/// 두 시계를 함께 주입해 연결한다
async fn get_at_wall(pool: &Pool, server: &FakeServer, key: ConnKey, now: Instant, wall: SystemTime, pid: i32) -> Arc<Mutex<Connected>> {
    pool.get_or_connect_at_wall(key, now, wall, || open(server, pid)).await.unwrap()
}

#[tokio::test]
async fn a_connection_idle_over_the_limit_by_the_wall_clock_is_replaced_though_the_monotonic_clock_says_seconds() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let (t0, wall0) = (Instant::now(), SystemTime::now());
    let first = get_at_wall(&pool, &server, key("a", "app"), t0, wall0, 1).await;
    // 맥이 자고 일어났다: Instant는 5초 갔고 벽시계는 11분 갔다
    let second = get_at_wall(&pool, &server, key("a", "app"), t0 + Duration::from_secs(5), wall0 + IDLE + Duration::from_secs(60), 2).await;
    assert!(!Arc::ptr_eq(&first, &second), "벽시계로 10분을 넘게 쉰 연결을 내줬어요");
    assert_eq!(pool.backend_pids(&target("a")), vec![2]);
    assert_eq!(server.accepted(), 2);
}

#[tokio::test]
async fn a_connection_idle_for_exactly_the_limit_by_the_wall_clock_is_reused_and_the_use_restarts_both_clocks() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let (t0, wall0) = (Instant::now(), SystemTime::now());
    let first = get_at_wall(&pool, &server, key("a", "app"), t0, wall0, 1).await;
    // 딱 IDLE만큼 쉰 연결은 그대로 쓴다(Instant와 같은 규칙이다)
    let again = get_at_wall(&pool, &server, key("a", "app"), t0 + Duration::from_secs(5), wall0 + IDLE, 2).await;
    assert!(Arc::ptr_eq(&first, &again));
    // 쓴 시각은 두 시계 모두 새로 적는다: 그 뒤 IDLE 안이면 벽시계로 따져도 남는다
    pool.sweep_at(t0 + Duration::from_secs(6), wall0 + IDLE + IDLE);
    assert_eq!(pool.backend_pids(&target("a")), vec![1], "벽시계의 쓴 시각이 새로 적히지 않았어요");
    pool.sweep_at(t0 + Duration::from_secs(6), wall0 + IDLE + IDLE + Duration::from_secs(1));
    assert!(pool.backend_pids(&target("a")).is_empty());
}

#[tokio::test]
async fn sweep_drops_a_connection_idle_over_the_limit_by_the_wall_clock_only() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let (t0, wall0) = (Instant::now(), SystemTime::now());
    get_at_wall(&pool, &server, key("a", "one"), t0, wall0, 1).await;
    get_at_wall(&pool, &server, key("a", "two"), t0, wall0, 2).await;
    // Instant로는 5초, 벽시계로는 딱 IDLE: 남는다
    pool.sweep_at(t0 + Duration::from_secs(5), wall0 + IDLE);
    assert_eq!(pool.backend_pids(&target("a")), vec![1, 2]);
    // Instant로는 여전히 5초지만 벽시계로는 IDLE을 1초 넘었다: 닫힌다
    pool.sweep_at(t0 + Duration::from_secs(5), wall0 + IDLE + Duration::from_secs(1));
    assert!(pool.backend_pids(&target("a")).is_empty(), "벽시계로 10분을 넘게 쉰 연결이 남았어요");
}

#[tokio::test]
async fn a_wall_clock_that_went_backwards_does_not_expire_a_connection() {
    // 시계를 뒤로 돌리면(시간 동기화 …) 쉰 시간을 알 수 없다. 그것만으로 연결을 버리지 않는다
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let (t0, wall0) = (Instant::now(), SystemTime::now());
    let first = get_at_wall(&pool, &server, key("a", "app"), t0, wall0, 1).await;
    pool.sweep_at(t0 + Duration::from_secs(1), wall0 - Duration::from_secs(3600));
    assert_eq!(pool.backend_pids(&target("a")), vec![1]);
    let again = get_at_wall(&pool, &server, key("a", "app"), t0 + Duration::from_secs(2), wall0 - Duration::from_secs(3600), 2).await;
    assert!(Arc::ptr_eq(&first, &again));
}

#[tokio::test]
async fn a_connection_marked_broken_is_replaced_on_the_next_get_though_its_client_is_open() {
    // 읽다가 응답이 끊긴 연결: 서버가 닫지 않아서 클라이언트는 열려 있다고 믿는다. `broken`이 풀에게 알려 준다
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let first = get(&pool, &server, key("a", "app"), 1).await;
    assert!(!first.lock().await.client.is_closed());
    first.lock().await.broken = true;
    let second = get(&pool, &server, key("a", "app"), 2).await;
    assert!(!Arc::ptr_eq(&first, &second));
    assert_eq!(pool.backend_pids(&target("a")), vec![2]);
    assert!(!second.lock().await.broken);
    assert_eq!(server.accepted(), 2);
}

#[tokio::test]
async fn close_target_drops_every_entry_of_that_target_and_only_that_target() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let one = get(&pool, &server, key("a", "one"), 1).await;
    let two = get(&pool, &server, key("a", "two"), 2).await;
    let other = get(&pool, &server, key("b", "one"), 3).await;
    let (one_weak, two_weak) = (Arc::downgrade(&one), Arc::downgrade(&two));
    drop((one, two));
    pool.close_target(&target("a"));
    assert!(pool.backend_pids(&target("a")).is_empty());
    assert_eq!(pool.backend_pids(&target("b")), vec![3]);
    // 풀이 쥐고 있던 참조가 없어져야 연결이 닫힌다
    assert!(one_weak.upgrade().is_none() && two_weak.upgrade().is_none());
    drop(other);
}

#[tokio::test]
async fn close_user_drops_only_that_users_entries_of_that_target_and_leaves_the_epoch_alone() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let as_reader = |id: &str, database: &str| ConnKey { user: "reader".into(), ..key(id, database) };
    let one = get(&pool, &server, key("a", "one"), 1).await;
    get(&pool, &server, key("a", "two"), 2).await;
    get(&pool, &server, as_reader("a", "one"), 3).await;
    // 같은 사용자라도 다른 대상의 연결은 그대로다
    get(&pool, &server, key("b", "one"), 4).await;
    let epoch = pool.epoch(&target("a"));
    let one_weak = Arc::downgrade(&one);
    drop(one);

    pool.close_user(&target("a"), "iam_admin");
    assert_eq!(pool.backend_pids(&target("a")), vec![3]);
    assert_eq!(pool.backend_pids(&target("b")), vec![4]);
    // 풀이 쥐고 있던 참조가 없어져야 연결이 닫힌다
    assert!(one_weak.upgrade().is_none());
    // epoch는 그대로다: 대상을 닫은 것이 아니라서, 도는 명령이 쥔 epoch로 계속 연결할 수 있다
    assert_eq!(pool.epoch(&target("a")), epoch);
    get_at_epoch(&pool, &server, key("a", "one"), epoch, 5).await.unwrap();
    assert_eq!(pool.backend_pids(&target("a")), vec![3, 5]);
    // 없는 사용자와 연결이 없는 대상은 아무 일도 아니다
    pool.close_user(&target("a"), "nobody");
    pool.close_user(&target("c"), "iam_admin");
    assert_eq!(pool.backend_pids(&target("a")), vec![3, 5]);
}

#[tokio::test]
async fn backend_pids_lists_the_pids_of_that_target() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    assert!(pool.backend_pids(&target("a")).is_empty());
    get(&pool, &server, key("a", "z"), 30).await;
    get(&pool, &server, key("a", "y"), 10).await;
    get(&pool, &server, key("a", "x"), 20).await;
    get(&pool, &server, key("b", "x"), 99).await;
    assert_eq!(pool.backend_pids(&target("a")), vec![10, 20, 30]);
    assert_eq!(pool.backend_pids(&target("b")), vec![99]);
    assert!(pool.backend_pids(&target("c")).is_empty());
}

#[tokio::test]
async fn a_connection_the_server_closed_is_replaced_on_the_next_get() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let first = get(&pool, &server, key("a", "app"), 1).await;
    server.close_connections();
    let mut waited = 0;
    while !first.lock().await.client.is_closed() {
        waited += 1;
        assert!(waited < 300, "서버가 닫은 연결을 클라이언트가 알아채지 못했어요");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // 닫힌 연결은 풀에서 빠지고, 새로 연결한다
    let second = get(&pool, &server, key("a", "app"), 2).await;
    assert!(!Arc::ptr_eq(&first, &second));
    assert_eq!(pool.backend_pids(&target("a")), vec![2]);
    assert!(!second.lock().await.client.is_closed());
}

#[tokio::test]
async fn a_failed_connect_leaves_no_entry_and_the_next_get_tries_again() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let failed = pool.get_or_connect(key("a", "app"), || async { Err(AppError::other("연결 실패")) }).await;
    assert!(matches!(failed, Err(AppError::Other { ref message }) if message == "연결 실패"));
    assert!(pool.backend_pids(&target("a")).is_empty());
    get(&pool, &server, key("a", "app"), 5).await;
    assert_eq!(pool.backend_pids(&target("a")), vec![5]);
}

#[tokio::test]
async fn two_gets_racing_for_one_key_end_up_with_one_shared_entry() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    // 두 호출 모두 "없음"을 본 뒤에 연결하도록 연결 함수가 한 번 양보한다
    let slow = |pid: i32| {
        let server = &server;
        move || async move {
            tokio::task::yield_now().await;
            open(server, pid).await
        }
    };
    let (a, b) = tokio::join!(pool.get_or_connect(key("a", "app"), slow(1)), pool.get_or_connect(key("a", "app"), slow(2)));
    let (a, b) = (a.unwrap(), b.unwrap());
    assert!(Arc::ptr_eq(&a, &b), "같은 열쇠는 같은 연결을 받아야 해요");
    assert_eq!(pool.backend_pids(&target("a")).len(), 1);
}

// ───────────────────────── 대상이 닫힌 횟수에 묶인 연결 ─────────────────────────

/// 명령이 시작할 때 읽어 둔 `epoch`로 연결한다
async fn get_at_epoch(pool: &Pool, server: &FakeServer, key: ConnKey, epoch: u64, pid: i32) -> Result<Arc<Mutex<Connected>>, AppError> {
    pool.get_or_connect_at_epoch(key, epoch, || open(server, pid)).await
}

#[test]
fn the_epoch_of_a_target_goes_up_only_when_that_target_is_closed() {
    let pool = Pool::default();
    assert_eq!((pool.epoch(&target("a")), pool.epoch(&target("b"))), (0, 0));
    pool.close_target(&target("b"));
    assert_eq!((pool.epoch(&target("a")), pool.epoch(&target("b"))), (0, 1));
    pool.close_target(&target("a"));
    pool.close_target(&target("a"));
    assert_eq!((pool.epoch(&target("a")), pool.epoch(&target("b"))), (2, 1));
}

#[test]
fn the_not_opened_text_is_the_one_the_commands_use() {
    assert_eq!(NOT_OPENED, "먼저 연결해 주세요");
}

#[tokio::test]
async fn a_connect_pinned_to_an_epoch_the_target_has_left_makes_no_connection() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let epoch = pool.epoch(&target("a"));
    pool.close_target(&target("a"));
    let called = AtomicUsize::new(0);
    let refused = pool
        .get_or_connect_at_epoch(key("a", "app"), epoch, || {
            called.fetch_add(1, Ordering::SeqCst);
            open(&server, 1)
        })
        .await;
    assert_eq!(refused.err(), Some(AppError::other("먼저 연결해 주세요")));
    assert_eq!(called.load(Ordering::SeqCst), 0, "닫힌 대상에는 연결 함수를 부르면 안 돼요");
    assert_eq!(server.accepted(), 0, "닫힌 대상에는 연결을 열면 안 돼요");
    assert!(pool.backend_pids(&target("a")).is_empty());
}

#[tokio::test]
async fn a_pinned_connect_that_close_target_interrupts_is_not_stored() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let epoch = pool.epoch(&target("a"));
    // 연결하는 사이에 탭이 닫힌다
    let interrupted = pool
        .get_or_connect_at_epoch(key("a", "app"), epoch, || async {
            pool.close_target(&target("a"));
            open(&server, 1).await
        })
        .await;
    assert_eq!(interrupted.err(), Some(AppError::other("먼저 연결해 주세요")));
    assert!(pool.backend_pids(&target("a")).is_empty(), "닫힌 대상의 연결이 보관됐어요");
    // 닫은 뒤에 새로 읽은 epoch로는 다시 연결할 수 있다
    get_at_epoch(&pool, &server, key("a", "app"), pool.epoch(&target("a")), 2).await.unwrap();
    assert_eq!(pool.backend_pids(&target("a")), vec![2]);
}

#[tokio::test]
async fn a_pinned_get_reuses_an_entry_without_connecting_while_the_epoch_is_the_same() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let epoch = pool.epoch(&target("a"));
    let first = get_at_epoch(&pool, &server, key("a", "app"), epoch, 11).await.unwrap();
    let called = AtomicUsize::new(0);
    let second = pool
        .get_or_connect_at_epoch(key("a", "app"), epoch, || {
            called.fetch_add(1, Ordering::SeqCst);
            open(&server, 12)
        })
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!((called.load(Ordering::SeqCst), server.accepted()), (0, 1));
    // 닫은 뒤에는 보관돼 있던 연결도 없고, 옛 epoch로는 다시 얻을 수 없다
    pool.close_target(&target("a"));
    assert_eq!(get_at_epoch(&pool, &server, key("a", "app"), epoch, 13).await.err(), Some(AppError::other("먼저 연결해 주세요")));
    assert_eq!(server.accepted(), 1);
}

#[tokio::test]
async fn closing_another_target_does_not_stop_a_pinned_connect() {
    let server = FakeServer::start(Script::Ready).await;
    let pool = Pool::default();
    let epoch = pool.epoch(&target("a"));
    pool.close_target(&target("b"));
    let kept = pool
        .get_or_connect_at_epoch(key("a", "app"), epoch, || async {
            pool.close_target(&target("b"));
            open(&server, 1).await
        })
        .await;
    assert!(kept.is_ok());
    assert_eq!(pool.backend_pids(&target("a")), vec![1]);
}
