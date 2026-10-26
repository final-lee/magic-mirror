use std::io::ErrorKind;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

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

pub fn temp_path(file_name: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    std::env::temp_dir().join("magic-mirror-diff").join(nanos.to_string()).join(file_name)
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
    fn temp_path_keeps_file_name() {
        assert!(temp_path("index.html").ends_with("index.html"));
    }
}
