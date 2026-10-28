//! 변경 기록: 앱 데이터 폴더의 `iam-changes.jsonl`. 한 줄이 변경 하나이고 새 기록은 맨 아래에 붙는다.
//! 읽을 수 없는 줄(깨진 줄, 빈 줄)은 건너뛰고, 고칠 때도 다른 줄은 그대로 둔다.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};

use super::change::IamChange;

/// 계약의 `ChangeLogEntry`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeLogEntry {
    pub id: String,
    /// ISO 8601
    pub at: String,
    pub profile: String,
    pub account_id: String,
    /// 변경한 자격 증명(`GetCallerIdentity`의 ARN)
    pub caller_arn: String,
    pub change: IamChange,
    pub summary: String,
    /// 부른 API 이름(`iam:AttachUserPolicy` …)
    pub calls: Vec<String>,
    pub ok: bool,
    pub error: Option<String>,
    /// 되돌리는 변경. 실패한 변경과 되돌릴 수 없는 변경은 None
    pub inverse: Option<IamChange>,
    /// 이 기록이 되돌린 기록의 id
    pub undo_of: Option<String>,
    #[serde(default)]
    pub undone: bool,
    /// 묶음으로 적용한 변경. 같은 묶음의 기록은 같은 값을 쓴다
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
}

/// 파일을 바꾸는 일(덧붙이기, 고쳐 쓰기)은 한 번에 하나씩 한다: 고쳐 쓰는 동안 덧붙인 기록이 사라지지 않게.
static WRITING: Mutex<()> = Mutex::new(());

fn writing() -> MutexGuard<'static, ()> {
    WRITING.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 파일 내용을 글자로 읽는다. 깨진 바이트가 섞여 있어도 읽을 수 있는 줄은 살린다.
fn read_text(path: &Path) -> io::Result<String> {
    Ok(String::from_utf8_lossy(&fs::read(path)?).into_owned())
}

/// 기록 하나를 파일 끝에 덧붙인다. 폴더가 없으면 만든다.
/// 앞선 쓰기가 줄바꿈 없이 끊겼다면 새 기록은 줄을 바꿔서 시작한다.
pub fn append(path: &Path, e: &ChangeLogEntry) -> io::Result<()> {
    let line = serde_json::to_string(e).map_err(io::Error::other)?;
    let _turn = writing();
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder)?;
    }
    let mut file = OpenOptions::new().read(true).append(true).create(true).open(path)?;
    let mut lead = "";
    if file.metadata()?.len() > 0 {
        let mut last = [0u8; 1];
        file.seek(SeekFrom::End(-1))?;
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            lead = "\n";
        }
    }
    // 한 번의 쓰기로 보낸다: 줄이 반쪽만 남는 일을 줄인다
    file.write_all(format!("{lead}{line}\n").as_bytes())
}

/// 파일의 모든 기록을 덧붙인 순서(오래된 것부터)로. 파일이 없거나 읽을 수 없는 줄은 건너뛴다.
pub fn read_all(path: &Path) -> Vec<ChangeLogEntry> {
    let Ok(text) = read_text(path) else {
        return Vec::new();
    };
    text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect()
}

/// `id` 기록에 "되돌림" 표시를 한다. 그런 기록이 없으면 `NotFound` 오류이고 파일은 그대로다.
/// 다른 줄은 한 글자도 바꾸지 않고, 임시 파일에 쓴 뒤 바꿔치기해서 도중에 끊겨도 기록이 반쪽이 되지 않는다.
pub fn mark_undone(path: &Path, id: &str) -> io::Result<()> {
    let _turn = writing();
    let text = read_text(path)?;
    let mut found = false;
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        match serde_json::from_str::<ChangeLogEntry>(line) {
            Ok(mut entry) if entry.id == id => {
                entry.undone = true;
                found = true;
                out.push_str(&serde_json::to_string(&entry).map_err(io::Error::other)?);
            }
            _ => out.push_str(line),
        }
        out.push('\n');
    }
    if !found {
        return Err(io::Error::new(io::ErrorKind::NotFound, "변경 기록을 찾을 수 없어요"));
    }
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    let replaced = write_synced(Path::new(&temp), out.as_bytes()).and_then(|()| fs::rename(&temp, path));
    if replaced.is_err() {
        // 바꿔치기 전에 실패했으면 원래 파일은 그대로다. 남은 임시 파일만 치운다
        let _ = fs::remove_file(&temp);
    }
    replaced
}

/// 파일을 새로 쓰고 디스크까지 내려보낸다: 바꿔치기한 뒤 전원이 꺼져도 반쯤 쓴 기록이 남지 않게.
fn write_synced(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;
    use std::thread;

    use serde_json::json;

    use super::*;

    fn entry(id: &str) -> ChangeLogEntry {
        ChangeLogEntry {
            id: id.into(),
            at: "2026-10-27T01:02:03Z".into(),
            profile: "prod".into(),
            account_id: "111111111111".into(),
            caller_arn: "arn:aws:sts::111111111111:assumed-role/dev/me".into(),
            change: IamChange::AttachPolicy { target: "arn:aws:iam::111111111111:user/bob".into(), policy_arn: "arn:aws:iam::aws:policy/ReadOnlyAccess".into() },
            summary: "bob에 ReadOnlyAccess 붙이기".into(),
            calls: vec!["iam:AttachUserPolicy".into()],
            ok: true,
            error: None,
            inverse: Some(IamChange::DetachPolicy { target: "arn:aws:iam::111111111111:user/bob".into(), policy_arn: "arn:aws:iam::aws:policy/ReadOnlyAccess".into() }),
            undo_of: None,
            undone: false,
            batch_id: None,
        }
    }

    fn ids(path: &Path) -> Vec<String> {
        read_all(path).into_iter().map(|e| e.id).collect()
    }

    #[test]
    fn appended_entries_come_back_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("iam-changes.jsonl");
        let mut failed = entry("b");
        failed.ok = false;
        failed.error = Some("권한 없음 (iam:AttachUserPolicy)".into());
        failed.inverse = None;
        let mut undo = entry("c");
        undo.undo_of = Some("a".into());
        for e in [entry("a"), failed.clone(), undo.clone()] {
            append(&path, &e).unwrap();
        }
        assert_eq!(read_all(&path), vec![entry("a"), failed, undo]);
        // 한 줄에 하나
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 3);
    }

    #[test]
    fn a_missing_file_is_an_empty_log_and_appending_creates_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("deeper").join("iam-changes.jsonl");
        assert!(read_all(&path).is_empty());
        append(&path, &entry("a")).unwrap();
        assert_eq!(ids(&path), vec!["a"]);
    }

    #[test]
    fn every_kind_of_change_survives_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        let changes = [
            IamChange::AttachPolicy { target: "t".into(), policy_arn: "p".into() },
            IamChange::DetachPolicy { target: "t".into(), policy_arn: "p".into() },
            IamChange::AddToGroup { user_name: "u".into(), group_name: "g".into() },
            IamChange::RemoveFromGroup { user_name: "u".into(), group_name: "g".into() },
            IamChange::SetAccessKeyStatus { user_name: "u".into(), access_key_id: "k".into(), status: "Active".into() },
            IamChange::DeleteAccessKey { user_name: "u".into(), access_key_id: "k".into() },
            IamChange::PutInlinePolicy { target: "t".into(), name: "n".into(), document: "{\n  \"Version\": \"2012-10-17\"\n}".into() },
            IamChange::DeleteInlinePolicy { target: "t".into(), name: "n".into() },
            IamChange::UpdateManagedPolicy { policy_arn: "p".into(), document: "한글 \"따옴표\"".into() },
        ];
        for (i, change) in changes.iter().enumerate() {
            let mut e = entry(&format!("e{i}"));
            e.change = change.clone();
            e.inverse = Some(change.clone());
            append(&path, &e).unwrap();
        }
        let back = read_all(&path);
        assert_eq!(back.len(), changes.len());
        for (e, change) in back.iter().zip(&changes) {
            assert_eq!((&e.change, e.inverse.as_ref()), (change, Some(change)));
        }
    }

    #[test]
    fn lines_that_cannot_be_read_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        append(&path, &entry("a")).unwrap();
        let mut text = fs::read_to_string(&path).unwrap();
        text.push_str("\n   \n{\"id\": \"half\"\nnot json at all\n");
        fs::write(&path, text).unwrap();
        append(&path, &entry("b")).unwrap();
        assert_eq!(ids(&path), vec!["a", "b"]);
    }

    #[test]
    fn an_entry_after_a_half_written_line_starts_on_its_own_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        append(&path, &entry("a")).unwrap();
        let mut text = fs::read_to_string(&path).unwrap();
        text.push_str("{\"id\":\"cut-off");
        fs::write(&path, text).unwrap();
        append(&path, &entry("b")).unwrap();
        assert_eq!(ids(&path), vec!["a", "b"]);
    }

    #[test]
    fn marking_undone_changes_only_that_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        for id in ["a", "b", "c"] {
            append(&path, &entry(id)).unwrap();
        }
        mark_undone(&path, "b").unwrap();
        let back = read_all(&path);
        assert_eq!(back.iter().map(|e| (e.id.as_str(), e.undone)).collect::<Vec<_>>(), vec![("a", false), ("b", true), ("c", false)]);
        let mut expected = entry("b");
        expected.undone = true;
        assert_eq!(back[1], expected);
        // 이미 표시한 기록에 다시 해도 같다
        mark_undone(&path, "b").unwrap();
        assert!(read_all(&path)[1].undone);
    }

    #[test]
    fn marking_leaves_other_lines_byte_for_byte_and_keeps_unreadable_ones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        append(&path, &entry("a")).unwrap();
        let first_line = fs::read_to_string(&path).unwrap();
        let mut text = first_line.clone();
        text.push_str("garbage line\n");
        fs::write(&path, text).unwrap();
        append(&path, &entry("b")).unwrap();
        mark_undone(&path, "b").unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(format!("{}\n", lines[0]), first_line);
        assert_eq!(lines[1], "garbage line");
        assert!(lines[2].contains("\"undone\":true"));
        assert!(!dir.path().join("log.jsonl.tmp").exists(), "임시 파일이 남으면 안 돼요");
    }

    #[test]
    fn marking_an_unknown_entry_fails_and_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        append(&path, &entry("a")).unwrap();
        let before = fs::read_to_string(&path).unwrap();
        let err = mark_undone(&path, "zzz").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
        assert_eq!(mark_undone(&dir.path().join("none.jsonl"), "a").unwrap_err().kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn entries_serialize_with_the_contract_names() {
        let mut e = entry("a");
        e.inverse = None;
        let value = serde_json::to_value(&e).unwrap();
        let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["accountId", "at", "callerArn", "calls", "change", "error", "id", "inverse", "ok", "profile", "summary", "undoOf", "undone"]);
        assert_eq!(value["change"], json!({ "op": "attachPolicy", "target": "arn:aws:iam::111111111111:user/bob", "policyArn": "arn:aws:iam::aws:policy/ReadOnlyAccess" }));
        assert_eq!((&value["inverse"], &value["undoOf"], &value["error"], &value["undone"]), (&json!(null), &json!(null), &json!(null), &json!(false)));
    }

    #[test]
    fn an_entry_without_a_batch_reads_back_and_serializes_without_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        // 묶음이 생기기 전에 남은 줄에는 batchId가 없다
        let old_line = r#"{"id":"a","at":"2026-10-27T01:02:03Z","profile":"prod","accountId":"111111111111","callerArn":"arn:aws:sts::111111111111:assumed-role/dev/me","change":{"op":"attachPolicy","target":"t","policyArn":"p"},"summary":"요약","calls":["iam:AttachUserPolicy"],"ok":true,"error":null,"inverse":null,"undoOf":null,"undone":false}"#;
        fs::write(&path, format!("{old_line}\n")).unwrap();
        let back = read_all(&path);
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].batch_id, None);

        // batch_id가 없으면 키도 보내지 않는다. 있으면 camelCase로 보내고 파일을 거쳐도 그대로 돌아온다
        assert!(!serde_json::to_value(&back[0]).unwrap().as_object().unwrap().contains_key("batchId"));
        let mut batched = entry("b");
        batched.batch_id = Some("b1".into());
        assert_eq!(serde_json::to_value(&batched).unwrap()["batchId"], json!("b1"));
        append(&path, &batched).unwrap();
        mark_undone(&path, "b").unwrap();
        let read_back = read_all(&path);
        assert_eq!(read_back[1].batch_id.as_deref(), Some("b1"), "되돌림 표시를 해도 묶음 표시는 남아요");
    }

    #[test]
    fn a_line_without_the_undone_flag_reads_as_not_undone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        let mut value = serde_json::to_value(entry("a")).unwrap();
        value.as_object_mut().unwrap().remove("undone");
        fs::write(&path, format!("{value}\n")).unwrap();
        assert!(!read_all(&path)[0].undone);
    }

    #[test]
    fn writers_in_different_threads_never_mix_their_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = Arc::new(dir.path().join("log.jsonl"));
        let workers: Vec<_> = (0..8)
            .map(|w| {
                let path = path.clone();
                thread::spawn(move || {
                    for i in 0..25 {
                        let mut e = entry(&format!("w{w}-{i}"));
                        e.summary = "긴 요약 ".repeat(200);
                        append(&path, &e).unwrap();
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(read_all(&path).len(), 200);
        assert_eq!(fs::read_to_string(&*path).unwrap().lines().count(), 200);
    }
}
