use std::fs;
use std::path::Path;

use serde::Serialize;

use super::local::system_time_iso;
use crate::error::AppError;

pub const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const BINARY_SNIFF: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum Content {
    Text(String),
    Binary,
    TooLarge,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideMeta {
    pub label: String,
    pub size: u64,
    pub modified: Option<String>,
    pub md5: Option<String>,
}

/// 앞 8KB에 NUL이 있거나 UTF-8이 아니면 바이너리.
pub fn classify_bytes(bytes: Vec<u8>) -> Content {
    let head = &bytes[..bytes.len().min(BINARY_SNIFF)];
    if head.contains(&0) {
        return Content::Binary;
    }
    match String::from_utf8(bytes) {
        Ok(s) => Content::Text(s),
        Err(_) => Content::Binary,
    }
}

pub fn read_local(path: &Path) -> Result<(SideMeta, Content), AppError> {
    let meta = fs::metadata(path).map_err(|e| AppError::other(format!("파일을 읽을 수 없어요: {e}")))?;
    let side = SideMeta {
        label: path.to_string_lossy().into_owned(),
        size: meta.len(),
        modified: meta.modified().ok().map(system_time_iso),
        md5: None,
    };
    if meta.len() > MAX_TEXT_BYTES {
        return Ok((side, Content::TooLarge));
    }
    let bytes = fs::read(path).map_err(|e| AppError::other(format!("파일을 읽을 수 없어요: {e}")))?;
    Ok((side, classify_bytes(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_text_and_binary() {
        assert_eq!(classify_bytes(b"hello\n".to_vec()), Content::Text("hello\n".into()));
        assert_eq!(classify_bytes(vec![0x89, b'P', b'N', b'G', 0, 1]), Content::Binary);
        assert_eq!(classify_bytes(vec![0xff, 0xfe, 0xfd]), Content::Binary);
        assert_eq!(classify_bytes(Vec::new()), Content::Text(String::new()));
    }

    #[test]
    fn read_local_marks_large_files() {
        let dir = tempfile::tempdir().unwrap();
        let small = dir.path().join("s.txt");
        fs::write(&small, "a\nb\n").unwrap();
        let (meta, content) = read_local(&small).unwrap();
        assert_eq!(meta.size, 4);
        assert_eq!(content, Content::Text("a\nb\n".into()));
        let big = dir.path().join("b.txt");
        fs::write(&big, vec![b'a'; (MAX_TEXT_BYTES + 1) as usize]).unwrap();
        assert_eq!(read_local(&big).unwrap().1, Content::TooLarge);
    }
}
