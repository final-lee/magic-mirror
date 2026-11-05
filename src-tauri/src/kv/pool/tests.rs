use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use super::*;
use crate::kv::model::KvKind;

/// 시험용 연결: 닫힌 횟수를 센다
struct Fake {
    id: usize,
    usable: AtomicBool,
    closed: Arc<AtomicUsize>,
}

#[async_trait]
impl Pooled for Fake {
    fn usable(&self) -> bool {
        self.usable.load(Ordering::Relaxed)
    }

    async fn close(&self) {
        self.closed.fetch_add(1, Ordering::Relaxed);
    }
}

fn target(id: &str) -> KvTarget {
    KvTarget { profile: "p".into(), region: "ap-northeast-2".into(), kind: KvKind::ReplicationGroup, id: id.into() }
}

struct Rig {
    pool: Pool<Fake>,
    made: Arc<AtomicUsize>,
    closed: Arc<AtomicUsize>,
}

impl Rig {
    fn new() -> Rig {
        Rig { pool: Pool::default(), made: Arc::new(AtomicUsize::new(0)), closed: Arc::new(AtomicUsize::new(0)) }
    }

    fn connector(&self) -> impl FnOnce() -> std::future::Ready<Result<Fake, AppError>> {
        let (made, closed) = (self.made.clone(), self.closed.clone());
        move || {
            let id = made.fetch_add(1, Ordering::Relaxed);
            std::future::ready(Ok(Fake { id, usable: AtomicBool::new(true), closed }))
        }
    }

    async fn get(&self, t: &KvTarget, now: Instant, wall: SystemTime) -> Result<Arc<Fake>, AppError> {
        self.pool.connect_in(t, now, wall, None, self.connector()).await
    }

    /// 백그라운드 닫기가 끝나기를 기다린다
    async fn settle(&self) {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }
}

#[tokio::test]
async fn the_same_target_reuses_its_connection() {
    let rig = Rig::new();
    let t = target("a");
    let first = rig.get(&t, Instant::now(), SystemTime::now()).await.unwrap();
    let second = rig.get(&t, Instant::now(), SystemTime::now()).await.unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(rig.made.load(Ordering::Relaxed), 1);
    assert!(rig.pool.holds(&t));
}

#[tokio::test]
async fn a_connection_idle_for_ten_minutes_by_the_monotonic_clock_is_replaced_and_closed() {
    let rig = Rig::new();
    let t = target("a");
    let start = Instant::now();
    let wall = SystemTime::now();
    let first = rig.get(&t, start, wall).await.unwrap();
    let later = rig.get(&t, start + IDLE + Duration::from_secs(1), wall).await.unwrap();
    assert_ne!(first.id, later.id);
    rig.settle().await;
    assert_eq!(rig.closed.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn a_mac_that_slept_is_caught_by_the_wall_clock_even_when_the_monotonic_clock_stood_still() {
    let rig = Rig::new();
    let t = target("a");
    let start = Instant::now();
    let wall = SystemTime::now();
    let first = rig.get(&t, start, wall).await.unwrap();
    // Instant는 맥이 자는 동안 멈춘다: 단조 시계는 몇 초, 벽시계는 8시간
    let woke = rig.get(&t, start + Duration::from_secs(5), wall + Duration::from_secs(8 * 3600)).await.unwrap();
    assert_ne!(first.id, woke.id);
}

#[tokio::test]
async fn a_wall_clock_that_went_backwards_does_not_count_as_idle() {
    let rig = Rig::new();
    let t = target("a");
    let start = Instant::now();
    let wall = SystemTime::now();
    let first = rig.get(&t, start, wall).await.unwrap();
    let again = rig.get(&t, start + Duration::from_secs(5), wall - Duration::from_secs(3600)).await.unwrap();
    assert_eq!(first.id, again.id);
}

#[tokio::test]
async fn a_connection_that_is_no_longer_usable_is_replaced() {
    let rig = Rig::new();
    let t = target("a");
    let first = rig.get(&t, Instant::now(), SystemTime::now()).await.unwrap();
    first.usable.store(false, Ordering::Relaxed);
    let second = rig.get(&t, Instant::now(), SystemTime::now()).await.unwrap();
    assert_ne!(first.id, second.id);
    rig.settle().await;
    assert_eq!(rig.closed.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn the_sweeper_closes_only_connections_idle_over_the_limit() {
    let rig = Rig::new();
    let (old, fresh) = (target("old"), target("fresh"));
    let start = Instant::now();
    let wall = SystemTime::now();
    rig.get(&old, start, wall).await.unwrap();
    rig.get(&fresh, start + IDLE, wall + IDLE).await.unwrap();
    rig.pool.sweep_at(start + IDLE + Duration::from_secs(1), wall + IDLE + Duration::from_secs(1));
    assert!(!rig.pool.holds(&old));
    assert!(rig.pool.holds(&fresh));
    rig.settle().await;
    assert_eq!(rig.closed.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn closing_a_target_drops_and_closes_its_connection_and_bumps_the_epoch() {
    let rig = Rig::new();
    let t = target("a");
    rig.get(&t, Instant::now(), SystemTime::now()).await.unwrap();
    assert_eq!(rig.pool.epoch(&t), 0);
    rig.pool.close_target(&t);
    assert_eq!(rig.pool.epoch(&t), 1);
    assert!(!rig.pool.holds(&t));
    rig.settle().await;
    assert_eq!(rig.closed.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn a_command_started_before_the_target_was_closed_does_not_connect_again() {
    let rig = Rig::new();
    let t = target("a");
    let epoch = rig.pool.epoch(&t);
    rig.pool.close_target(&t);
    let error = rig.pool.get_or_connect_at_epoch(&t, epoch, rig.connector()).await.err().unwrap();
    assert_eq!(error, AppError::other(NOT_OPENED));
    assert_eq!(rig.made.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn a_connection_made_while_the_target_closes_is_closed_and_not_kept() {
    let rig = Rig::new();
    let t = target("a");
    let epoch = rig.pool.epoch(&t);
    let closed = rig.closed.clone();
    let pool = &rig.pool;
    let error = pool
        .get_or_connect_at_epoch(&t, epoch, || async {
            // 연결하는 사이에 탭이 닫힌다
            pool.close_target(&t);
            Ok(Fake { id: 7, usable: AtomicBool::new(true), closed })
        })
        .await
        .err()
        .unwrap();
    assert_eq!(error, AppError::other(NOT_OPENED));
    assert!(!pool.holds(&t));
    rig.settle().await;
    assert_eq!(rig.closed.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn a_failed_connection_keeps_nothing() {
    let rig = Rig::new();
    let t = target("a");
    let error = rig.pool.get_or_connect_at_epoch(&t, 0, || async { Err::<Fake, _>(AppError::other("연결 실패")) }).await.err().unwrap();
    assert_eq!(error, AppError::other("연결 실패"));
    assert!(!rig.pool.holds(&t));
}

/// `kv_close`는 동기 명령이라 Tauri가 Tokio 실행기 밖(메인 스레드)에서 부른다. 거기서 닫아도 멈추지 않고 연결이 닫혀야 한다
#[test]
fn closing_outside_a_runtime_still_closes_the_connection() {
    let rig = Rig::new();
    let t = target("a");
    tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
        rig.get(&t, Instant::now(), SystemTime::now()).await.unwrap();
    });
    assert!(tokio::runtime::Handle::try_current().is_err());
    rig.pool.close_target(&t);
    assert!(!rig.pool.holds(&t));
    let deadline = Instant::now() + std::time::Duration::from_secs(2);
    while rig.closed.load(Ordering::Relaxed) == 0 && Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(rig.closed.load(Ordering::Relaxed), 1);
}
