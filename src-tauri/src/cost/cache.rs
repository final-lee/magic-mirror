//! Cost Explorer 응답과 계정별 월간 요청 수를 디스크에 보관한다.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::expr::CeRequest;
use super::period::Ymd;
use super::table::CeTable;

pub const CE_TTL_SECS: i64 = 21_600;
pub const KEEP_SECS: i64 = 7 * 86_400;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheEntry {
    fetched_at: i64,
    table: CeTable,
}

#[derive(Serialize, Deserialize)]
struct CacheFile {
    version: u32,
    entries: HashMap<String, CacheEntry>,
    requests: HashMap<String, u32>,
}

impl Default for CacheFile {
    fn default() -> Self {
        Self { version: 1, entries: HashMap::new(), requests: HashMap::new() }
    }
}

pub struct CostCache {
    path: PathBuf,
    file: CacheFile,
}

impl CostCache {
    pub fn load(path: PathBuf) -> CostCache {
        let file = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<CacheFile>(&bytes).ok())
            .filter(|file| file.version == 1)
            .unwrap_or_default();
        CostCache { path, file }
    }

    pub fn get(&self, account: &str, req: &CeRequest, now: i64) -> Option<(CeTable, i64)> {
        let entry = self.file.entries.get(&format!("{}|{}", account, req.canonical()))?;
        (i128::from(now) < i128::from(entry.fetched_at) + i128::from(CE_TTL_SECS))
            .then(|| (entry.table.clone(), entry.fetched_at))
    }

    pub fn put(&mut self, account: &str, req: &CeRequest, table: &CeTable, now: i64) {
        self.file.entries.insert(
            format!("{}|{}", account, req.canonical()),
            CacheEntry { fetched_at: now, table: table.clone() },
        );
    }

    pub fn count(&mut self, account: &str, year_month: &str, pages: u32) {
        *self.file.requests.entry(format!("{account}|{year_month}")).or_default() += pages;
    }

    pub fn requests(&self, account: &str, year_month: &str) -> u32 {
        self.file.requests.get(&format!("{account}|{year_month}")).copied().unwrap_or(0)
    }

    pub fn save(&mut self, now: i64) -> io::Result<()> {
        self.file.entries.retain(|_, entry| {
            i128::from(entry.fetched_at) + i128::from(KEEP_SECS) > i128::from(now)
        });
        let previous_month = Ymd::from_unix(now).first_of_month().add_months(-1).year_month();
        self.file.requests.retain(|key, _| {
            key.rsplit_once('|').is_some_and(|(_, month)| month >= previous_month.as_str())
        });

        if let Some(parent) = self.path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
            fs::create_dir_all(parent)?;
        }
        let temp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(&self.file).map_err(io::Error::other)?;
        fs::write(&temp, bytes)?;
        fs::rename(temp, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::model::CostMetric;
    use serde_json::json;
    use tempfile::tempdir;

    fn table() -> CeTable {
        CeTable { unit: Some("USD".into()), tag_keys: vec!["team".into()], ..CeTable::default() }
    }

    fn forecast() -> CeRequest {
        CeRequest::Forecast {
            start: "2026-10-01".into(), end: "2026-11-01".into(),
            metric: CostMetric::UnblendedCost, exclude_credits: true, filters: vec![],
        }
    }

    #[test]
    fn answers_round_trip_in_memory_and_across_save_and_load() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cost-cache.json");
        let mut cache = CostCache::load(path.clone());
        cache.put("123", &CeRequest::TagKeys, &table(), 1_000);
        assert_eq!(cache.get("123", &CeRequest::TagKeys, 1_001), Some((table(), 1_000)));
        assert!(!path.exists());
        cache.save(1_001).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(json["version"], 1);
        assert_eq!(json["entries"][format!("123|{}", CeRequest::TagKeys.canonical())]["fetchedAt"], 1_000);
        assert_eq!(CostCache::load(path).get("123", &CeRequest::TagKeys, 1_001), Some((table(), 1_000)));
    }

    #[test]
    fn answers_expire_at_the_ttl_boundary() {
        let dir = tempdir().unwrap();
        let mut cache = CostCache::load(dir.path().join("cache.json"));
        cache.put("123", &CeRequest::TagKeys, &table(), 100);
        assert!(cache.get("123", &CeRequest::TagKeys, 100 + CE_TTL_SECS - 1).is_some());
        assert!(cache.get("123", &CeRequest::TagKeys, 100 + CE_TTL_SECS).is_none());
    }

    #[test]
    fn different_accounts_and_requests_miss() {
        let dir = tempdir().unwrap();
        let mut cache = CostCache::load(dir.path().join("cache.json"));
        cache.put("123", &CeRequest::TagKeys, &table(), 100);
        assert!(cache.get("456", &CeRequest::TagKeys, 100).is_none());
        assert!(cache.get("123", &forecast(), 100).is_none());
    }

    #[test]
    fn save_prunes_expired_retention_and_old_counter_months_across_years() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let mut cache = CostCache::load(path.clone());
        // 2027-01-01 UTC: 이전 달은 2026-12다.
        let now = 1_798_761_600;
        cache.put("old", &CeRequest::TagKeys, &table(), now - KEEP_SECS);
        cache.put("new", &CeRequest::TagKeys, &table(), now - KEEP_SECS + 1);
        cache.count("123", "2026-11", 1);
        cache.count("123", "2026-12", 2);
        cache.count("123", "2027-01", 3);
        cache.save(now).unwrap();
        let loaded = CostCache::load(path);
        assert!(!loaded.file.entries.contains_key(&format!("old|{}", CeRequest::TagKeys.canonical())));
        assert!(loaded.file.entries.contains_key(&format!("new|{}", CeRequest::TagKeys.canonical())));
        assert_eq!(loaded.requests("123", "2026-11"), 0);
        assert_eq!(loaded.requests("123", "2026-12"), 2);
        assert_eq!(loaded.requests("123", "2027-01"), 3);
    }

    #[test]
    fn invalid_and_wrong_version_files_load_empty_and_are_replaced() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cache.json");
        for content in ["not json".to_string(), json!({"version": 2, "entries": {}, "requests": {"123|1970-01": 9}}).to_string()] {
            fs::write(&path, content).unwrap();
            let mut cache = CostCache::load(path.clone());
            assert_eq!(cache.requests("123", "1970-01"), 0);
            assert!(cache.get("123", &CeRequest::TagKeys, 0).is_none());
            cache.put("123", &CeRequest::TagKeys, &table(), 0);
            cache.save(0).unwrap();
            let value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(value["version"], 1);
            assert_eq!(CostCache::load(path.clone()).get("123", &CeRequest::TagKeys, 0), Some((table(), 0)));
        }
    }

    #[test]
    fn request_counts_accumulate_and_persist_per_account_and_month() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let mut cache = CostCache::load(path.clone());
        cache.count("123", "1970-01", 2);
        cache.count("123", "1970-01", 3);
        cache.count("456", "1970-01", 1);
        assert_eq!(cache.requests("123", "1970-01"), 5);
        assert_eq!(cache.requests("123", "1969-12"), 0);
        cache.save(0).unwrap();
        let loaded = CostCache::load(path);
        assert_eq!(loaded.requests("123", "1970-01"), 5);
        assert_eq!(loaded.requests("456", "1970-01"), 1);
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("cost").join("cache.json");
        let mut cache = CostCache::load(path.clone());
        cache.save(0).unwrap();
        assert!(path.is_file());
    }
}
