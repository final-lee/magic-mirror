use super::*;

const NOW: i64 = 1_800_000_000_000;

#[test]
fn only_settled_minutes_are_kept_and_old_ones_fall_out() {
    let cache = BullCache::default();
    let minute = |ago: i64| NOW - NOW.rem_euclid(MINUTE_MS) - ago * MINUTE_MS;
    // 지금이 속한 분과 그 앞 2분은 아직 작업이 더 들어올 수 있다
    for ago in 0..=2 {
        cache.put_bucket("bull:q:completed", minute(ago), 5, NOW);
        assert_eq!(cache.bucket("bull:q:completed", minute(ago)), None, "{ago}분 전");
    }
    cache.put_bucket("bull:q:completed", minute(3), 7, NOW);
    assert_eq!(cache.bucket("bull:q:completed", minute(3)), Some(7));
    assert_eq!(cache.bucket("bull:q:failed", minute(3)), None);
    // 한 시간 넘게 지나면 다음에 담을 때 버린다
    let later = NOW + 62 * MINUTE_MS;
    cache.put_bucket("bull:q:completed", minute(-58), 1, later);
    assert_eq!(cache.bucket("bull:q:completed", minute(3)), None);
}

#[test]
fn a_finished_job_is_found_only_with_the_same_finish() {
    let cache = BullCache::default();
    let job = FinishedJob { timestamp: Some("1".into()), processed_on: Some("2".into()), finished_on: Some("3".into()), failed_reason: None };
    cache.put_job("bull:q:7", 3.0, job.clone());
    assert_eq!(cache.job("bull:q:7", 3.0), Some(job));
    // 다시 시도해 다시 끝나면 점수(끝난 시각)가 달라진다
    assert_eq!(cache.job("bull:q:7", 9.0), None);
}
