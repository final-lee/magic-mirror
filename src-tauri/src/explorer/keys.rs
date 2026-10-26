use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::AppError;

/// 업로드 키: `base`(선택한 항목의 부모 폴더) 기준 상대 경로를 `dest_prefix` 뒤에 `/`로 이어 붙인다.
pub fn upload_key(dest_prefix: &str, base: &Path, file: &Path) -> String {
    let rel = file.strip_prefix(base).unwrap_or(file);
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .filter(|p| p != "/")
        .collect();
    format!("{dest_prefix}{}", parts.join("/"))
}

/// 선택 항목의 부모 prefix: "a/b/" → "a/", "a/x.txt" → "a/", "x" → "".
pub fn parent_prefix(key: &str) -> &str {
    let trimmed = key.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(i) => &key[..=i],
        None => "",
    }
}

/// 다운로드 경로: `base_prefix` 이후의 키 경로를 `local_dir` 아래에 만든다.
/// `..`/`.` 세그먼트가 있으면 폴더 밖으로 나갈 수 있으므로 None.
pub fn download_path(local_dir: &Path, base_prefix: &str, key: &str) -> Option<PathBuf> {
    let rel = key.strip_prefix(base_prefix).unwrap_or(key);
    let segments: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() || segments.iter().any(|s| *s == ".." || *s == ".") {
        return None;
    }
    let mut path = local_dir.to_path_buf();
    for seg in segments {
        path.push(seg);
    }
    Some(path)
}

pub fn validate_name(name: &str) -> Result<(), AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::other("이름을 입력하세요"));
    }
    if name.contains('/') {
        return Err(AppError::other("이름에 /를 쓸 수 없어요"));
    }
    if name == "." || name == ".." {
        return Err(AppError::other("이 이름은 쓸 수 없어요"));
    }
    Ok(())
}

pub fn folder_key(prefix: &str, name: &str) -> String {
    format!("{prefix}{name}/")
}

/// 이름 변경 대상 키. 폴더(`/`로 끝남)면 결과도 `/`로 끝난다.
pub fn rename_target(from: &str, new_name: &str) -> String {
    let parent = parent_prefix(from);
    if from.ends_with('/') {
        format!("{parent}{new_name}/")
    } else {
        format!("{parent}{new_name}")
    }
}

/// `from` → `to`로 옮길 때 `key`의 새 키. 폴더면 하위 경로를 유지한다.
pub fn moved_key(from: &str, to: &str, key: &str) -> String {
    if from.ends_with('/') {
        format!("{to}{}", key.strip_prefix(from).unwrap_or(""))
    } else {
        to.to_string()
    }
}

pub fn new_transfer_id(index: usize) -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("t{nanos}-{index}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_key_keeps_relative_path() {
        let base = Path::new("/Users/me/web");
        assert_eq!(upload_key("site/", base, Path::new("/Users/me/web/index.html")), "site/index.html");
        assert_eq!(upload_key("", base, Path::new("/Users/me/web/dist/js/app.js")), "dist/js/app.js");
    }

    #[test]
    fn parent_prefix_cases() {
        assert_eq!(parent_prefix("a/b/"), "a/");
        assert_eq!(parent_prefix("a/x.txt"), "a/");
        assert_eq!(parent_prefix("x.txt"), "");
        assert_eq!(parent_prefix("top/"), "");
    }

    #[test]
    fn download_path_maps_and_blocks_traversal() {
        let dir = Path::new("/Users/me/Downloads");
        assert_eq!(download_path(dir, "a/", "a/b/c.txt"), Some(PathBuf::from("/Users/me/Downloads/b/c.txt")));
        assert_eq!(download_path(dir, "", "x.txt"), Some(PathBuf::from("/Users/me/Downloads/x.txt")));
        assert_eq!(download_path(dir, "a/", "a/../../etc/passwd"), None);
        assert_eq!(download_path(dir, "a/", "a/./x"), None);
        assert_eq!(download_path(dir, "a/", "a/"), None);
    }

    #[test]
    fn validate_name_rules() {
        assert!(validate_name("reports").is_ok());
        assert_eq!(validate_name("  "), Err(AppError::other("이름을 입력하세요")));
        assert_eq!(validate_name("a/b"), Err(AppError::other("이름에 /를 쓸 수 없어요")));
        assert_eq!(validate_name(".."), Err(AppError::other("이 이름은 쓸 수 없어요")));
    }

    #[test]
    fn rename_and_move_keys() {
        assert_eq!(rename_target("a/old.txt", "new.txt"), "a/new.txt");
        assert_eq!(rename_target("a/old/", "new"), "a/new/");
        assert_eq!(rename_target("old.txt", "new.txt"), "new.txt");
        assert_eq!(moved_key("a/old/", "a/new/", "a/old/x/y.txt"), "a/new/x/y.txt");
        assert_eq!(moved_key("a/old/", "a/new/", "a/old/"), "a/new/");
        assert_eq!(moved_key("a/f.txt", "a/g.txt", "a/f.txt"), "a/g.txt");
    }

    #[test]
    fn folder_key_and_ids() {
        assert_eq!(folder_key("a/", "b"), "a/b/");
        assert_ne!(new_transfer_id(0), new_transfer_id(1));
    }
}
