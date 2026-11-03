//! 통합 검색(⌘K)이 쓰는 리소스 색인. `list_resources`가 성공할 때마다 목록의 검색용 사본을 남기고, 디스크에도 보관해 앱을 다시 켜도 바로 검색한다.
//!
//! 검색에 필요한 칸(id·이름·ARN·표 값·태그)만 저장한다. `raw`(예: Lambda 환경 변수 같은 비밀이 들어 있다)·`fields`·`consoleUrl`은 절대 디스크에 쓰지 않는다.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::model::ListResult;

/// 이보다 오래된 목록은 검색에서 빼고 저장할 때 지운다.
pub const KEEP_MS: i64 = 7 * 86_400_000;
/// 마지막 기록 뒤 이만큼 조용해지면 파일에 쓴다. 목록 여러 개가 연달아 들어와도 한 번만 쓰기 위해서다.
const FLUSH_DELAY: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedItem {
    pub id: String,
    pub name: String,
    pub arn: Option<String>,
    pub values: BTreeMap<String, String>,
    pub tags: BTreeMap<String, String>,
}

/// 프론트엔드에 그대로 나가는 모양: 프로필 하나 안의 (리전, 서비스, 종류) 목록 하나.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedList {
    pub region: String,
    pub service: String,
    pub type_id: String,
    /// 목록을 받은 시각(unix ms)
    pub fetched_at: i64,
    pub truncated: bool,
    pub items: Vec<IndexedItem>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    profile: String,
    #[serde(flatten)]
    list: IndexedList,
}

#[derive(Serialize, Deserialize)]
struct IndexFile {
    version: u32,
    entries: HashMap<String, Entry>,
}

impl Default for IndexFile {
    fn default() -> Self {
        Self { version: 1, entries: HashMap::new() }
    }
}

fn fresh(fetched_at: i64, now_ms: i64) -> bool {
    fetched_at.saturating_add(KEEP_MS) > now_ms
}

pub struct ResourceIndex {
    path: PathBuf,
    file: IndexFile,
}

impl ResourceIndex {
    /// 파일이 없거나 깨졌거나 버전이 다르면 빈 색인으로 시작한다. 다음 `save`가 새 파일로 바꿔 쓴다.
    pub fn load(path: PathBuf) -> ResourceIndex {
        let file = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<IndexFile>(&bytes).ok())
            .filter(|file| file.version == 1)
            .unwrap_or_default();
        ResourceIndex { path, file }
    }

    fn empty(path: PathBuf) -> ResourceIndex {
        ResourceIndex { path, file: IndexFile::default() }
    }

    /// 같은 키의 이전 사본은 통째로 바뀐다. 그 사이 지워진 리소스가 검색에 남지 않게 하려는 것이다.
    pub fn record(&mut self, profile: &str, region_key: &str, service: &str, type_id: &str, result: &ListResult, now_ms: i64) {
        let items = result
            .items
            .iter()
            .map(|r| IndexedItem {
                id: r.id.clone(),
                name: r.name.clone(),
                arn: r.arn.clone(),
                values: r.values.clone(),
                tags: r.tags.clone(),
            })
            .collect();
        self.file.entries.insert(
            format!("{profile}|{region_key}|{service}|{type_id}"),
            Entry {
                profile: profile.to_string(),
                list: IndexedList {
                    region: region_key.to_string(),
                    service: service.to_string(),
                    type_id: type_id.to_string(),
                    fetched_at: now_ms,
                    truncated: result.truncated,
                    items,
                },
            },
        );
    }

    /// 이 프로필의 목록만, 7일 안에 받은 것만. 순서는 (리전, 서비스, 종류)로 고정한다.
    pub fn lists_for(&self, profile: &str, now_ms: i64) -> Vec<IndexedList> {
        let mut lists: Vec<IndexedList> = self
            .file
            .entries
            .values()
            .filter(|e| e.profile == profile && fresh(e.list.fetched_at, now_ms))
            .map(|e| e.list.clone())
            .collect();
        lists.sort_by(|a, b| (&a.region, &a.service, &a.type_id).cmp(&(&b.region, &b.service, &b.type_id)));
        lists
    }

    /// 메모리와 파일을 모두 비운다. 파일이 원래 없었으면 그대로 성공이다.
    pub fn clear(&mut self) -> io::Result<()> {
        self.file.entries.clear();
        remove_if_exists(&self.path)?;
        remove_if_exists(&self.temp_path())
    }

    pub fn save(&mut self, now_ms: i64) -> io::Result<()> {
        self.file.entries.retain(|_, e| fresh(e.list.fetched_at, now_ms));

        if let Some(parent) = self.path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
            fs::create_dir_all(parent)?;
        }
        let temp = self.temp_path();
        let bytes = serde_json::to_vec(&self.file).map_err(io::Error::other)?;
        write_private(&temp, &bytes)?;
        fs::rename(temp, &self.path)
    }

    fn temp_path(&self) -> PathBuf {
        self.path.with_extension("json.tmp")
    }
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// 리소스 이름·태그가 들어 있어서 나만 읽게(0600) 쓴다.
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    // 이전 실행이 남긴 임시 파일의 권한은 `mode`가 바꾸지 못한다.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(bytes)
}

/// 색인과 "쓸 것이 남았는가"를 한 자물쇠로 묶는다. 쓰기·비우기가 서로 끼어들 수 없어서, 비운 뒤에 묵은 데이터가 되살아나지 않는다.
struct Inner {
    path: PathBuf,
    /// 처음 쓸 때 파일에서 읽는다.
    index: Option<ResourceIndex>,
    /// 마지막 기록 시각. 파일에 아직 안 쓴 변경이 있을 때만 있다.
    last_record: Option<Instant>,
    /// 쓰기를 기다리는 작업이 이미 떠 있는가. 하나만 둔다.
    scheduled: bool,
}

impl Inner {
    fn new(path: PathBuf) -> Inner {
        Inner { path, index: None, last_record: None, scheduled: false }
    }

    fn index(&mut self) -> &mut ResourceIndex {
        let path = &self.path;
        self.index.get_or_insert_with(|| ResourceIndex::load(path.clone()))
    }

    /// `now`: (단조 시계, unix ms). 돌려주는 값: 쓰기 작업을 새로 띄워야 하면 true
    fn record(&mut self, profile: &str, region_key: &str, service: &str, type_id: &str, result: &ListResult, (now, now_ms): (Instant, i64)) -> bool {
        self.index().record(profile, region_key, service, type_id, result, now_ms);
        self.last_record = Some(now);
        !std::mem::replace(&mut self.scheduled, true)
    }

    /// 쓸 때가 안 됐으면 더 기다릴 시간을, 끝났으면(썼거나 쓸 것이 없으면) None을 돌려준다.
    fn poll_flush(&mut self, now: Instant, now_ms: i64) -> Option<Duration> {
        let Some(last) = self.last_record else {
            self.scheduled = false;
            return None;
        };
        let due = last + FLUSH_DELAY;
        if now < due {
            return Some(due - now);
        }
        self.last_record = None;
        self.scheduled = false;
        if let Some(index) = self.index.as_mut() {
            if let Err(e) = index.save(now_ms) {
                eprintln!("리소스 색인을 저장하지 못했어요: {e}");
            }
        }
        None
    }

    /// 파일을 지우고 대기 중인 쓰기를 무효로 만든다(떠 있는 작업은 다음에 깨어나 쓸 것이 없음을 보고 끝난다).
    fn clear(&mut self) -> io::Result<()> {
        self.last_record = None;
        let path = &self.path;
        self.index.get_or_insert_with(|| ResourceIndex::empty(path.clone())).clear()
    }
}

pub struct ResourceIndexState {
    inner: Arc<Mutex<Inner>>,
}

fn lock(inner: &Mutex<Inner>) -> std::sync::MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

impl ResourceIndexState {
    pub fn new(path: PathBuf) -> ResourceIndexState {
        ResourceIndexState { inner: Arc::new(Mutex::new(Inner::new(path))) }
    }

    pub fn record(&self, profile: &str, region_key: &str, service: &str, type_id: &str, result: &ListResult) {
        let spawn = lock(&self.inner).record(profile, region_key, service, type_id, result, (Instant::now(), now_ms()));
        if spawn {
            tauri::async_runtime::spawn(flush_when_quiet(self.inner.clone()));
        }
    }

    pub fn lists_for(&self, profile: &str) -> Vec<IndexedList> {
        lock(&self.inner).index().lists_for(profile, now_ms())
    }

    pub fn clear(&self) -> io::Result<()> {
        lock(&self.inner).clear()
    }
}

/// 기록이 1초 동안 없을 때까지 기다렸다가 한 번 쓴다. 쓰기는 블로킹 스레드에서 한다.
async fn flush_when_quiet(inner: Arc<Mutex<Inner>>) {
    tokio::time::sleep(FLUSH_DELAY).await;
    loop {
        let shared = inner.clone();
        let wait = tauri::async_runtime::spawn_blocking(move || lock(&shared).poll_flush(Instant::now(), now_ms())).await;
        match wait {
            Ok(Some(more)) => tokio::time::sleep(more).await,
            Ok(None) => return,
            Err(_) => {
                // 쓰기 중 패닉: 다음 기록이 새 작업을 띄우도록 표시를 푼다.
                lock(&inner).scheduled = false;
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Resource;
    use tempfile::tempdir;

    const DAY: i64 = 86_400_000;

    fn list(ids: &[&str]) -> ListResult {
        ListResult { items: ids.iter().map(|id| Resource::new(*id, format!("name-{id}")).value("state", "running")).collect(), truncated: false }
    }

    fn ids(lists: &[IndexedList]) -> Vec<(&str, &str, &str, Vec<&str>)> {
        lists.iter().map(|l| (l.region.as_str(), l.service.as_str(), l.type_id.as_str(), l.items.iter().map(|i| i.id.as_str()).collect())).collect()
    }

    #[test]
    fn round_trip_returns_only_the_requested_profile() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("resource-index.json");
        let mut index = ResourceIndex::load(path.clone());
        let tagged = ListResult {
            items: vec![Resource::new("i-1", "web").arn(Some("arn:aws:ec2:::i-1")).value("state", "running").tags([(Some("team"), Some("core"))])],
            truncated: true,
        };
        index.record("dev", "ap-northeast-2", "ec2", "instances", &tagged, 1_000);
        index.record("dev", "global", "iam", "users", &list(&["alice"]), 1_000);
        index.record("prod", "ap-northeast-2", "ec2", "instances", &list(&["i-9"]), 1_000);
        index.save(2_000).unwrap();

        let loaded = ResourceIndex::load(path);
        let dev = loaded.lists_for("dev", 2_000);
        assert_eq!(
            ids(&dev),
            [("ap-northeast-2", "ec2", "instances", vec!["i-1"]), ("global", "iam", "users", vec!["alice"])]
        );
        let item = &dev[0].items[0];
        assert_eq!(item.name, "web");
        assert_eq!(item.arn.as_deref(), Some("arn:aws:ec2:::i-1"));
        assert_eq!(item.values["state"], "running");
        assert_eq!(item.tags["team"], "core");
        assert!(dev[0].truncated);
        assert_eq!(dev[0].fetched_at, 1_000);
        assert_eq!(ids(&loaded.lists_for("prod", 2_000)), [("ap-northeast-2", "ec2", "instances", vec!["i-9"])]);
        assert!(loaded.lists_for("other", 2_000).is_empty());
    }

    #[test]
    fn json_shape_is_camel_case() {
        let mut index = ResourceIndex::empty(PathBuf::new());
        index.record("dev", "global", "iam", "users", &list(&["alice"]), 5);
        let json = serde_json::to_value(index.lists_for("dev", 5)).unwrap();
        assert_eq!(
            json,
            serde_json::json!([{
                "region": "global", "service": "iam", "typeId": "users", "fetchedAt": 5, "truncated": false,
                "items": [{"id": "alice", "name": "name-alice", "arn": null, "values": {"state": "running"}, "tags": {}}]
            }])
        );
    }

    #[test]
    fn file_never_holds_raw_fields_or_console_url_and_is_private() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("resource-index.json");
        let secret = Resource::new("fn-1", "handler")
            .raw(&"DB_PASSWORD=hunter2")
            .field("환경 변수", "API_KEY=abc123")
            .console("https://console.example/secret-link");
        let mut index = ResourceIndex::load(path.clone());
        index.record("dev", "us-east-1", "lambda", "functions", &ListResult { items: vec![secret], truncated: false }, 1);
        index.save(1).unwrap();

        let text = fs::read_to_string(&path).unwrap();
        for leaked in ["hunter2", "abc123", "secret-link", "환경 변수"] {
            assert!(!text.contains(leaked), "{leaked} leaked into the index file");
        }
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        let entry = json["entries"].as_object().unwrap().values().next().unwrap();
        for key in ["raw", "fields", "consoleUrl"] {
            assert!(entry["items"][0].get(key).is_none() && entry.get(key).is_none(), "{key} was persisted");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn seven_day_boundary_hides_and_prunes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("resource-index.json");
        let now = 100 * DAY;
        let mut index = ResourceIndex::load(path.clone());
        index.record("dev", "r", "s", "old", &list(&["a"]), now - 7 * DAY);
        index.record("dev", "r", "s", "edge", &list(&["b"]), now - 7 * DAY + 1);
        index.record("dev", "r", "s", "new", &list(&["c"]), now);

        let types: Vec<String> = index.lists_for("dev", now).into_iter().map(|l| l.type_id).collect();
        assert_eq!(types, ["edge", "new"]);

        index.save(now).unwrap();
        let loaded = ResourceIndex::load(path);
        assert_eq!(loaded.file.entries.len(), 2);
        assert!(!loaded.file.entries.contains_key("dev|r|s|old"));
        // 저장하지 않아도 시간이 흐르면 검색에서 빠진다
        assert_eq!(loaded.lists_for("dev", now + DAY).len(), 1);
    }

    #[test]
    fn corrupt_or_wrong_version_loads_empty_and_is_replaced() {
        let dir = tempdir().unwrap();
        for (i, content) in ["not json {", r#"{"version":2,"entries":{}}"#, r#"{"version":1}"#, ""].into_iter().enumerate() {
            let path = dir.path().join(format!("index-{i}.json"));
            fs::write(&path, content).unwrap();
            let mut index = ResourceIndex::load(path.clone());
            assert!(index.lists_for("dev", 0).is_empty());
            index.record("dev", "r", "s", "t", &list(&["a"]), 0);
            index.save(0).unwrap();
            let value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(value["version"], 1);
            assert_eq!(ids(&ResourceIndex::load(path).lists_for("dev", 0)), [("r", "s", "t", vec!["a"])]);
        }
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("app").join("resource-index.json");
        ResourceIndex::load(path.clone()).save(0).unwrap();
        assert!(path.is_file());
    }

    #[test]
    fn rerecording_a_key_replaces_the_snapshot() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("resource-index.json");
        let mut index = ResourceIndex::load(path.clone());
        index.record("dev", "r", "ec2", "instances", &list(&["i-1", "i-2"]), 1);
        index.record("dev", "r", "ec2", "instances", &list(&["i-2"]), 2);
        let lists = index.lists_for("dev", 2);
        assert_eq!(ids(&lists), [("r", "ec2", "instances", vec!["i-2"])]);
        assert_eq!(lists[0].fetched_at, 2);

        index.save(2).unwrap();
        assert_eq!(ids(&ResourceIndex::load(path).lists_for("dev", 2)), [("r", "ec2", "instances", vec!["i-2"])]);
    }

    #[test]
    fn clear_removes_memory_and_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("resource-index.json");
        let mut index = ResourceIndex::load(path.clone());
        index.record("dev", "r", "s", "t", &list(&["a"]), 1);
        index.save(1).unwrap();
        assert!(path.is_file());

        index.clear().unwrap();
        assert!(index.lists_for("dev", 1).is_empty());
        assert!(!path.exists());
        // 이미 없는 파일을 또 비워도 실패하지 않는다
        index.clear().unwrap();
        assert!(ResourceIndex::load(path).lists_for("dev", 1).is_empty());
    }

    #[test]
    fn burst_of_records_writes_once_after_the_quiet_period() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("resource-index.json");
        let mut inner = Inner::new(path.clone());
        let t0 = Instant::now();
        let ms = Duration::from_millis;

        assert!(inner.record("dev", "r", "s", "a", &list(&["1"]), (t0, 10)), "첫 기록이 쓰기 작업을 띄운다");
        assert!(!inner.record("dev", "r", "s", "b", &list(&["2"]), (t0 + ms(600), 610)), "이미 떠 있으면 또 띄우지 않는다");
        // 첫 기록 1초 뒤라도 마지막 기록 뒤 1초가 안 찼으면 기다린다
        assert_eq!(inner.poll_flush(t0 + ms(1_000), 1_010), Some(ms(600)));
        assert!(!path.exists());
        assert_eq!(inner.poll_flush(t0 + ms(1_600), 1_610), None);
        assert_eq!(ResourceIndex::load(path.clone()).lists_for("dev", 1_610).len(), 2);

        // 다 쓴 뒤의 기록은 새 작업을 띄운다
        assert!(inner.record("dev", "r", "s", "c", &list(&["3"]), (t0 + ms(5_000), 5_010)));
    }

    #[test]
    fn clear_cancels_a_pending_flush() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("resource-index.json");
        let mut inner = Inner::new(path.clone());
        let t0 = Instant::now();
        inner.record("dev", "r", "s", "a", &list(&["1"]), (t0, 10));
        inner.clear().unwrap();

        assert_eq!(inner.poll_flush(t0 + Duration::from_secs(5), 5_010), None);
        assert!(!path.exists(), "비운 뒤에 묵은 데이터가 되살아났다");
        assert!(inner.index().lists_for("dev", 5_010).is_empty());
        // 비운 뒤의 새 기록은 다시 정상적으로 쓰인다
        assert!(inner.record("dev", "r", "s", "b", &list(&["2"]), (t0 + Duration::from_secs(6), 6_010)));
        assert_eq!(inner.poll_flush(t0 + Duration::from_secs(8), 8_010), None);
        assert_eq!(ids(&ResourceIndex::load(path).lists_for("dev", 8_010)), [("r", "s", "b", vec!["2"])]);
    }

    #[test]
    fn clear_deletes_a_file_that_was_never_loaded() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("resource-index.json");
        let mut seeded = ResourceIndex::load(path.clone());
        seeded.record("dev", "r", "s", "t", &list(&["a"]), 1);
        seeded.save(1).unwrap();

        let mut inner = Inner::new(path.clone());
        inner.clear().unwrap();
        assert!(!path.exists());
    }
}
