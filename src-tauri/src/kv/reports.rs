//! 큰 키 찾기 결과를 대상(ARN)·DB 번호마다 디스크(`kv-bigkeys.json`)에 둔다. 다음 찾기가 끝나면 바뀐다.
//! 찾기는 모든 키를 훑어 수 분이 걸릴 수 있어서, 앱을 다시 켜거나 다시 연결해도 마지막 결과를 다시 보인다.
//! 키 이름과 크기, 종류만 담는다(값은 담지 않는다).

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};

use super::model::KvBigKeysReport;

#[derive(Serialize, Deserialize)]
struct ReportFile {
    version: u32,
    reports: HashMap<String, KvBigKeysReport>,
}

pub struct BigKeysReports {
    path: PathBuf,
    reports: Mutex<HashMap<String, KvBigKeysReport>>,
}

/// 보관 키: 같은 캐시라도 DB 번호마다 키가 다르다
pub fn report_key(arn: &str, database: u32) -> String {
    format!("{arn}|db{database}")
}

impl BigKeysReports {
    /// 파일이 없거나 깨졌으면 비어 있는 채로 연다
    pub fn load(path: PathBuf) -> BigKeysReports {
        let reports = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ReportFile>(&bytes).ok())
            .filter(|file| file.version == 1)
            .map(|file| file.reports)
            .unwrap_or_default();
        BigKeysReports { path, reports: Mutex::new(reports) }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, KvBigKeysReport>> {
        self.reports.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn get(&self, key: &str) -> Option<KvBigKeysReport> {
        self.lock().get(key).cloned()
    }

    /// 결과를 바꾸고 파일에 쓴다(임시 파일에 쓴 뒤 바꿔 넣는다)
    pub fn put(&self, key: &str, report: KvBigKeysReport) -> io::Result<()> {
        let mut reports = self.lock();
        reports.insert(key.to_string(), report);
        if let Some(parent) = self.path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent)?;
        }
        let file = ReportFile { version: 1, reports: reports.clone() };
        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, serde_json::to_vec(&file).map_err(io::Error::other)?)?;
        fs::rename(temp, &self.path)
    }
}

#[cfg(test)]
mod tests;
