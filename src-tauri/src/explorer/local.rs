use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use aws_smithy_types::{date_time::Format, DateTime};
use md5::{Digest, Md5};

use super::LocalEntry;
use crate::error::AppError;

pub fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}

pub fn system_time_iso(t: SystemTime) -> String {
    DateTime::from(t).fmt(Format::DateTime).unwrap_or_default()
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

pub fn list_dir(path: &Path) -> Result<Vec<LocalEntry>, AppError> {
    let read = fs::read_dir(path).map_err(|e| AppError::other(format!("폴더를 열 수 없어요: {e}")))?;
    let mut out = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        let Ok(meta) = fs::metadata(entry.path()) else { continue };
        let is_dir = meta.is_dir();
        out.push(LocalEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
            size: (!is_dir).then(|| meta.len()),
            modified: meta.modified().ok().map(system_time_iso),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

pub fn expand_files(path: &Path) -> Result<Vec<PathBuf>, AppError> {
    let meta = fs::metadata(path).map_err(|e| AppError::other(format!("파일을 읽을 수 없어요: {e}")))?;
    if !meta.is_dir() {
        return Ok(vec![path.to_path_buf()]);
    }
    let mut out = Vec::new();
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let read = fs::read_dir(&dir).map_err(|e| AppError::other(format!("폴더를 열 수 없어요: {e}")))?;
        for entry in read.flatten() {
            if is_hidden(&entry.file_name().to_string_lossy()) {
                continue;
            }
            let Ok(ft) = entry.file_type() else { continue };
            let p = entry.path();
            if ft.is_dir() {
                stack.push(p);
            } else if ft.is_file() || fs::metadata(&p).map(|m| m.is_file()).unwrap_or(false) {
                out.push(p);
            }
        }
    }
    out.sort();
    Ok(out)
}

pub fn md5_file(path: &Path) -> Result<String, AppError> {
    let mut file = fs::File::open(path).map_err(|e| AppError::other(format!("파일을 읽을 수 없어요: {e}")))?;
    let mut hasher = Md5::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| AppError::other(format!("파일을 읽을 수 없어요: {e}")))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("b.txt"), "bb").unwrap();
        fs::write(root.join("A.txt"), "a").unwrap();
        fs::write(root.join(".hidden"), "h").unwrap();
        fs::create_dir(root.join("zdir")).unwrap();
        fs::create_dir(root.join("Adir")).unwrap();
        fs::write(root.join("zdir/inner.txt"), "i").unwrap();
        fs::create_dir(root.join("zdir/deep")).unwrap();
        fs::write(root.join("zdir/deep/x.txt"), "x").unwrap();
        fs::write(root.join("zdir/.secret"), "s").unwrap();
        dir
    }

    #[test]
    fn list_dir_sorts_and_hides() {
        let dir = setup();
        let entries = list_dir(dir.path()).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Adir", "zdir", "A.txt", "b.txt"]);
        assert!(entries[0].is_dir);
        assert_eq!(entries[0].size, None);
        assert_eq!(entries[3].size, Some(2));
        assert!(entries[3].modified.as_deref().unwrap().ends_with('Z'));
        assert!(entries[3].path.ends_with("b.txt"));
    }

    #[test]
    fn list_dir_missing_folder_errors() {
        let err = list_dir(Path::new("/definitely/not/here")).unwrap_err();
        assert!(matches!(err, AppError::Other { ref message } if message.starts_with("폴더를 열 수 없어요")));
    }

    #[test]
    fn expand_files_recurses_without_hidden() {
        let dir = setup();
        let files = expand_files(&dir.path().join("zdir")).unwrap();
        let rel: Vec<_> = files.iter().map(|p| p.strip_prefix(dir.path()).unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(rel, vec!["zdir/deep/x.txt", "zdir/inner.txt"]);
        let single = expand_files(&dir.path().join("b.txt")).unwrap();
        assert_eq!(single.len(), 1);
    }

    #[test]
    fn md5_of_known_content() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("h.txt");
        fs::write(&p, "hello").unwrap();
        assert_eq!(md5_file(&p).unwrap(), "5d41402abc4b2a76b9719d911017c592");
    }
}
