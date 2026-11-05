use super::*;
use crate::kv::model::KvKeyspace;

#[test]
fn gather_keeps_partial_results_and_fails_only_when_all_fail() {
    assert_eq!(gather(vec![Ok(1), Err(AppError::other("x")), Ok(3)]).unwrap(), vec![1, 3]);
    assert_eq!(gather::<i32>(vec![Err(AppError::other("a")), Err(AppError::other("b"))]).unwrap_err(), AppError::other("a"));
    assert!(gather::<i32>(vec![]).unwrap().is_empty());
}

#[test]
fn databases_come_from_the_keyspace_plus_the_selected_one_and_zero() {
    let info = |dbs: &[u32]| KvNodeInfo {
        node: "n".into(), version: String::new(), role: "primary".into(), used_memory: 0, used_memory_peak: 0, max_memory: None, fragmentation: None, hits: 0, misses: 0,
        ops_per_sec: 0, connected_clients: 0, evicted_keys: 0, expired_keys: 0, uptime_seconds: 0, replication_lag_seconds: None,
        keyspace: dbs.iter().map(|db| KvKeyspace { db: *db, keys: 1, expires: 0 }).collect(),
    };
    assert_eq!(databases_of(&[info(&[3, 1])], 5), vec![0, 1, 3, 5]);
    assert_eq!(databases_of(&[], 0), vec![0]);
}
