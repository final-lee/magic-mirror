//! 변경 기록 파일(JSON Lines)의 읽기·덧붙이기·고쳐 쓰기. IAM(`iam-changes.jsonl`)과 PostgreSQL(`db-changes.jsonl`)의 기록이 함께 쓴다.
//! 한 줄이 기록 하나이고 새 기록은 맨 아래에 붙는다. 읽을 수 없는 줄(깨진 줄, 빈 줄)은 건너뛰고, 고칠 때도 다른 줄은 그대로 둔다.
//! 파일을 바꾸는 일(덧붙이기, 고쳐 쓰기)은 파일에 상관없이 한 번에 하나씩 한다: 고쳐 쓰는 동안 덧붙인 기록이 사라지지 않게.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::de::DeserializeOwned;
use serde::Serialize;

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
pub fn append<T: Serialize>(path: &Path, entry: &T) -> io::Result<()> {
    let line = serde_json::to_string(entry).map_err(io::Error::other)?;
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
pub fn read_all<T: DeserializeOwned>(path: &Path) -> Vec<T> {
    let Ok(text) = read_text(path) else {
        return Vec::new();
    };
    text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect()
}

/// `is_target`인 기록에 `mark`를 적용해 고쳐 쓴다. 그런 기록이 없으면 `NotFound` 오류이고 파일은 그대로다.
/// 다른 줄은 한 글자도 바꾸지 않고, 임시 파일에 쓴 뒤 바꿔치기해서 도중에 끊겨도 기록이 반쪽이 되지 않는다.
pub fn update<T>(path: &Path, is_target: impl Fn(&T) -> bool, mark: impl Fn(&mut T)) -> io::Result<()>
where
    T: Serialize + DeserializeOwned,
{
    let _turn = writing();
    let text = read_text(path)?;
    let mut found = false;
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        match serde_json::from_str::<T>(line) {
            Ok(mut entry) if is_target(&entry) => {
                mark(&mut entry);
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
mod tests;
