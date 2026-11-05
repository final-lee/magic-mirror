use super::*;
use crate::kv::model::{KvBigKey, KvBigKeysBasis, KvKeyName, KvType};

fn report(size: u64, at: i64) -> KvBigKeysReport {
    KvBigKeysReport { basis: KvBigKeysBasis::Memory, keys: vec![KvBigKey { name: KvKeyName::from_bytes(b"bin:\xff"), kind: KvType::Hash, size }], scanned: 390_000, stopped: false, generated_at: at }
}

#[test]
fn a_report_survives_a_reload_per_cache_and_database_and_the_next_one_replaces_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("kv-bigkeys.json");
    let store = BigKeysReports::load(path.clone());
    store.put(&report_key("arn:a", 0), report(10, 1)).unwrap();
    store.put(&report_key("arn:a", 1), report(20, 2)).unwrap();
    let again = BigKeysReports::load(path.clone());
    // 바이너리 키 이름도 그대로 돌아온다
    assert_eq!(again.get(&report_key("arn:a", 0)), Some(report(10, 1)));
    assert_eq!(again.get(&report_key("arn:a", 1)), Some(report(20, 2)));
    assert_eq!(again.get(&report_key("arn:b", 0)), None);
    again.put(&report_key("arn:a", 0), report(30, 3)).unwrap();
    assert_eq!(BigKeysReports::load(path).get(&report_key("arn:a", 0)), Some(report(30, 3)));
}

#[test]
fn a_broken_file_opens_empty() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("kv-bigkeys.json");
    fs::write(&path, b"{not json").unwrap();
    assert_eq!(BigKeysReports::load(path).get(&report_key("arn:a", 0)), None);
}
