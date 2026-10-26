use std::io::ErrorKind;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::error::AppError;

pub const FILEMERGE: &str = "/usr/bin/opendiff";
pub const VSCODE_CANDIDATES: [&str; 4] = [
    "code",
    "/usr/local/bin/code",
    "/opt/homebrew/bin/code",
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
];

/// 도구 이름과 사용자 지정 명령으로 실행할 (프로그램, 인자)를 만든다. 알 수 없는 도구는 FileMerge.
pub fn command_for(tool: &str, custom: Option<&str>, left: &str, right: &str) -> Result<(String, Vec<String>), AppError> {
    match tool {
        "vscode" => Ok(("code".into(), vec!["--diff".into(), left.into(), right.into()])),
        "custom" => {
            let template = custom
                .filter(|c| !c.trim().is_empty())
                .ok_or_else(|| AppError::other("비교 도구 명령을 설정에서 입력하세요"))?;
            // 공백으로 나눈 뒤 치환해서, 경로에 공백이 있어도 인자 하나로 유지한다.
            let mut parts = template.split_whitespace().map(|p| p.replace("{left}", left).replace("{right}", right));
            let program = parts.next().unwrap_or_default();
            Ok((program, parts.collect()))
        }
        _ => Ok((FILEMERGE.into(), vec![left.into(), right.into()])),
    }
}

fn not_found_message(tool: &str) -> String {
    match tool {
        "vscode" => "VS Code의 code 명령을 찾을 수 없어요. VS Code에서 'Shell Command: Install code command'를 실행하세요".into(),
        "custom" => "설정한 비교 도구를 찾을 수 없어요".into(),
        _ => "FileMerge를 찾을 수 없어요. Xcode를 설치하거나 설정에서 다른 도구를 고르세요".into(),
    }
}

/// 실행만 하고 기다리지 않는다(종료는 별도 스레드에서 회수).
pub fn spawn(program: &str, args: &[String], tool: &str) -> Result<(), AppError> {
    let candidates: Vec<&str> = if program == "code" { VSCODE_CANDIDATES.to_vec() } else { vec![program] };
    for candidate in candidates {
        match Command::new(candidate).args(args).spawn() {
            Ok(mut child) => {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(());
            }
            Err(e) if e.kind() == ErrorKind::NotFound => continue,
            Err(e) => return Err(AppError::other(format!("비교 도구를 실행할 수 없어요: {e}"))),
        }
    }
    Err(AppError::other(not_found_message(tool)))
}

pub const TEMP_MAX_AGE: Duration = Duration::from_secs(60 * 60);

fn temp_root() -> PathBuf {
    std::env::temp_dir().join("magic-mirror-diff")
}

pub fn temp_path(file_name: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    temp_root().join(nanos.to_string()).join(file_name)
}

/// `root` 아래에서 `max_age`보다 오래된 항목을 지운다. 오류는 무시(best-effort).
pub fn sweep_stale_in(root: &std::path::Path, max_age: Duration, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else { continue };
        if now.duration_since(modified).map(|age| age > max_age).unwrap_or(false) {
            let path = entry.path();
            let _ = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        }
    }
}

/// 오래된 비교용 임시 복사본을 정리한다.
pub fn sweep_stale() {
    sweep_stale_in(&temp_root(), TEMP_MAX_AGE, SystemTime::now());
}

/// `temp_path`가 만든 파일의 임시 폴더를 통째로 지운다. 임시 루트 밖이면 건드리지 않는다.
pub fn remove_temp_copy(file: &str) {
    let path = std::path::Path::new(file);
    if let Some(dir) = path.parent() {
        if dir.parent() == Some(temp_root().as_path()) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_tools() {
        assert_eq!(
            command_for("filemerge", None, "/a", "/b").unwrap(),
            (FILEMERGE.to_string(), vec!["/a".to_string(), "/b".to_string()])
        );
        assert_eq!(
            command_for("vscode", None, "/a", "/b").unwrap(),
            ("code".to_string(), vec!["--diff".to_string(), "/a".to_string(), "/b".to_string()])
        );
        assert_eq!(command_for("weird", None, "/a", "/b").unwrap().0, FILEMERGE);
    }

    #[test]
    fn custom_template_substitutes_placeholders() {
        let (p, args) = command_for("custom", Some("ksdiff --partial-changeset {left} {right}"), "/a b", "/c").unwrap();
        assert_eq!(p, "ksdiff");
        assert_eq!(args, vec!["--partial-changeset", "/a b", "/c"]);
    }

    #[test]
    fn custom_without_command_errors() {
        assert_eq!(
            command_for("custom", Some("  "), "/a", "/b"),
            Err(AppError::other("비교 도구 명령을 설정에서 입력하세요"))
        );
    }

    #[test]
    fn command_for_keeps_metacharacters_in_single_argv_entry() {
        let weird = "/tmp/a b;rm -rf $(x)";
        let (_, args) = command_for("vscode", None, weird, "/c").unwrap();
        assert_eq!(args, vec!["--diff", weird, "/c"]);
        let (p, args) = command_for("custom", Some("tool {left} {right}"), weird, "/c").unwrap();
        assert_eq!(p, "tool");
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], weird);
    }

    #[test]
    fn sweep_removes_only_stale_entries() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let fresh = root.path().join("fresh");
        std::fs::create_dir_all(old.join("x")).unwrap();
        std::fs::create_dir_all(&fresh).unwrap();
        // 지금이 2시간 뒤라고 보면 둘 다 오래됐으므로, 기준 시각을 조절해 구분한다.
        sweep_stale_in(root.path(), Duration::from_secs(3600), SystemTime::now());
        assert!(old.exists() && fresh.exists());
        sweep_stale_in(root.path(), Duration::from_secs(3600), SystemTime::now() + Duration::from_secs(7200));
        assert!(!old.exists() && !fresh.exists());
    }

    #[test]
    fn sweep_ignores_missing_root() {
        sweep_stale_in(std::path::Path::new("/nonexistent/magic-mirror-xyz"), TEMP_MAX_AGE, SystemTime::now());
    }

    #[test]
    fn temp_path_keeps_file_name() {
        assert!(temp_path("index.html").ends_with("index.html"));
    }
}
