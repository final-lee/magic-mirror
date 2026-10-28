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
