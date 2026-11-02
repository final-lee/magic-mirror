//! 로그를 설치된 lnav로 본다. 앱이 받는 로그 줄을 본인만 읽는 임시 파일에 이어 쓰고, lnav를 가상 터미널(PTY)에서 그 파일로 띄운다.
//! 화면(xterm.js)은 PTY 출력을 받아 그리고, 키 입력과 크기를 돌려보낸다. 끝나면(탭 닫기, 다른 Pod, lnav 종료) lnav를 죽이고 파일을 지운다.
//! 클러스터에는 로그 GET만 한다(`hygiene`).
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use super::logs::LogMessage;
use super::path::login_path;
use crate::error::AppError;

pub const LNAV_MISSING: &str = "lnav를 찾지 못했어요. brew install lnav로 설치하면 로그를 lnav로 볼 수 있어요";
pub const LNAV_FAILED: &str = "lnav를 띄우지 못했어요";
pub const LOG_FILE_FAILED: &str = "로그를 담을 임시 파일을 만들지 못했어요";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LnavMessage {
    /// PTY 출력(base64). 화면이 그대로 터미널에 쓴다.
    Output { data: String },
    /// 로그 흐름이 오류로 끝났다(lnav는 받은 데까지 계속 보여준다)
    LogError { error: AppError },
    /// 로그 흐름이 끝났다(따라가지 않을 때, 컨테이너가 끝났을 때)
    LogEnd,
    /// lnav가 끝났다(q로 나가기 등)
    Exit,
}

/// `path`(콜론으로 나눈 PATH)에서 실행할 수 있는 `name`을 찾는다
pub fn find_in_path(name: &str, path: &str) -> Option<PathBuf> {
    path.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join(name)).find(|p| p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

/// 로그인 셸의 PATH(Homebrew 포함)에서 lnav를 찾는다
pub async fn find_lnav() -> Option<PathBuf> {
    find_in_path("lnav", login_path().await)
}

static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

/// `dir`(본인만, 0700) 안에 본인만 읽고 쓰는(0600) 새 로그 파일을 만든다. 로그에는 비밀값이 섞일 수 있다.
pub fn log_file(dir: &Path) -> io::Result<(PathBuf, File)> {
    // 폴더 만들기는 `hygiene`이 쓰기 호출로 오해하는 이름을 피해 create_dir_all로 하고 권한을 좁힌다(안의 파일은 처음부터 0600)
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    let name = format!("{}-{}-{}.log", std::process::id(), NEXT_FILE.fetch_add(1, Ordering::Relaxed), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let path = dir.join(name);
    let file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)?;
    Ok((path, file))
}

/// 로그 메시지를 파일에 쓰고, 화면에 알릴 것만 돌려준다
pub fn write_log(file: &mut impl Write, msg: LogMessage) -> io::Result<Option<LnavMessage>> {
    match msg {
        LogMessage::Lines { lines } => {
            let mut text = lines.join("\n");
            text.push('\n');
            file.write_all(text.as_bytes())?;
            file.flush()?;
            Ok(None)
        }
        LogMessage::Error { error } => Ok(Some(LnavMessage::LogError { error })),
        LogMessage::End => Ok(Some(LnavMessage::LogEnd)),
    }
}

pub fn output(bytes: &[u8]) -> LnavMessage {
    LnavMessage::Output { data: base64::engine::general_purpose::STANDARD.encode(bytes) }
}

/// 띄운 lnav. 화면의 입력·크기 조절은 `writer`와 `master`로, 출력은 `reader`로.
pub struct Spawned {
    pub child: Box<dyn Child + Send + Sync>,
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
}

pub fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }
}

/// `program args…`을 새 PTY에서 띄운다(lnav에는 로그 파일 경로 하나를 넘긴다)
pub fn spawn(program: &Path, args: &[&Path], cols: u16, rows: u16, path_env: &str) -> Result<Spawned, AppError> {
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|_| AppError::other(LNAV_FAILED))?;
    let mut cmd = CommandBuilder::new(program);
    for a in args {
        cmd.arg(a);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("PATH", path_env);
    if let Some(home) = std::env::var_os("HOME") {
        cmd.cwd(home);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|_| AppError::other(LNAV_FAILED))?;
    // 자식이 끝나면 읽기가 EOF를 받도록 이쪽의 slave는 닫는다
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|_| AppError::other(LNAV_FAILED))?;
    let writer = pair.master.take_writer().map_err(|_| AppError::other(LNAV_FAILED))?;
    Ok(Spawned { child, reader, writer, master: pair.master })
}

/// 끝날 때(정상 종료, 패닉, 작업 중단) lnav를 죽이고 로그 파일을 지운다
pub struct Cleanup {
    pub child: Box<dyn Child + Send + Sync>,
    pub path: PathBuf,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_file(&self.path);
    }
}

/// PTY 출력을 끝(EOF)까지 읽어 보낸다. 보내기가 실패하면 멈춘다. 블로킹이라 따로 스레드에서 돈다.
pub fn pump(mut reader: impl Read, mut send: impl FnMut(LnavMessage) -> bool) {
    let mut buf = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => {
                send(LnavMessage::Exit);
                return;
            }
            Ok(n) => {
                if !send(output(&buf[..n])) {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
