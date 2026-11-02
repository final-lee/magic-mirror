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
pub const LOG_WRITE_FAILED: &str = "로그를 임시 파일에 더 쓰지 못해 받기를 멈췄어요. 디스크 공간을 확인해 주세요";

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

/// 로그 임시 파일을 두는 곳. 실행 중인 앱마다 `<프로세스 번호>` 폴더를 따로 쓴다.
pub fn logs_root() -> PathBuf {
    std::env::temp_dir().join("magic-mirror-logs")
}

pub fn process_dir(root: &Path) -> PathBuf {
    root.join(std::process::id().to_string())
}

/// 본인만 들어갈 수 있는(0700) 폴더로 만든다
fn private_dir(dir: &Path) -> io::Result<()> {
    // 폴더 만들기는 `hygiene`이 쓰기 호출로 오해하는 이름을 피해 create_dir_all로 하고 권한을 좁힌다(안의 파일은 처음부터 0600)
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

/// `root/<이 프로세스>/` 안에 본인만 읽고 쓰는(0600) 새 로그 파일을 만든다. 로그에는 비밀값이 섞일 수 있다.
pub fn log_file(root: &Path) -> io::Result<(PathBuf, File)> {
    private_dir(root)?;
    let dir = process_dir(root);
    private_dir(&dir)?;
    let name = format!("{}-{}.log", NEXT_FILE.fetch_add(1, Ordering::Relaxed), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let path = dir.join(name);
    let file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)?;
    Ok((path, file))
}

/// 프로세스가 살아 있는지(신호 0: 보내지 않고 확인만)
fn alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else { return false };
    // SAFETY: kill에 신호 0을 주면 아무것도 보내지 않고 대상이 있는지만 본다
    let found = unsafe { libc::kill(pid, 0) } == 0;
    found || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// 앱을 켤 때: 끝난 앱(프로세스가 없는 번호)이 남긴 로그 폴더를 지운다. 종료 직전에 막 만든 파일처럼 그때 못 지운 것도 여기서 지워진다.
pub fn sweep_stale(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for e in entries.flatten() {
        let path = e.path();
        let owner = e.file_name().to_str().and_then(|n| n.parse::<u32>().ok());
        match owner {
            Some(pid) if pid == std::process::id() || alive(pid) => {}
            // 끝난 앱의 폴더, 또는 폴더 밖에 놓인 옛 형식의 파일
            _ => {
                let _ = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
            }
        }
    }
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

/// `program args…`을 새 PTY에서 띄운다(lnav에는 로그 파일 경로 하나를 넘긴다).
/// 실패할 수 있는 PTY 손잡이(읽기·쓰기)를 먼저 얻고 나서 띄운다. 띄운 뒤에는 실패할 일이 없어 자식이 관리 밖으로 새지 않는다.
pub fn spawn(program: &Path, args: &[&Path], cols: u16, rows: u16, path_env: &str) -> Result<Spawned, AppError> {
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|_| AppError::other(LNAV_FAILED))?;
    let reader = pair.master.try_clone_reader().map_err(|_| AppError::other(LNAV_FAILED))?;
    let writer = pair.master.take_writer().map_err(|_| AppError::other(LNAV_FAILED))?;
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
    Ok(Spawned { child, reader, writer, master: pair.master })
}

/// lnav를 죽이고(기다려 거두고) 로그 파일을 지운다
fn finish(child: Option<Box<dyn Child + Send + Sync>>, path: &Path) {
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
    let _ = fs::remove_file(path);
}

/// lnav 하나의 뒷정리. `finish_now`는 그 자리에서 다 끝낸다(앱 종료).
/// 그냥 버리면 SIGKILL을 보내고 로그 파일을 그 자리에서 지운 뒤, 거두기(wait)만 따로 스레드에서 한다
/// (portable-pty의 kill은 잠깐 기다리고 wait도 막혀서, 비동기 런타임의 일꾼 스레드를 붙잡지 않게).
pub struct Cleanup {
    child: Option<Box<dyn Child + Send + Sync>>,
    path: PathBuf,
}

impl Cleanup {
    pub fn new(child: Box<dyn Child + Send + Sync>, path: PathBuf) -> Self {
        Cleanup { child: Some(child), path }
    }

    pub fn finish_now(&mut self) {
        finish(self.child.take(), &self.path);
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        if let Some(mut child) = self.child.take() {
            match child.process_id().and_then(|p| i32::try_from(p).ok()) {
                // SAFETY: 우리가 띄운 자식에게만 보낸다. 아직 거두지 않았으니 번호가 다른 프로세스로 넘어가지 않았다.
                Some(pid) => unsafe {
                    libc::kill(pid, libc::SIGKILL);
                },
                None => {
                    let _ = child.kill();
                }
            }
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
}

/// 화면의 키 입력을 PTY에 쓰는 스레드. 큰 붙여넣기로 PTY가 막혀도 부른 쪽(메인 스레드, 등록부 잠금)은 기다리지 않는다.
/// 보내는 쪽이 모두 사라지거나 쓰기가 실패하면 끝난다.
pub fn input_worker(mut writer: Box<dyn Write + Send>) -> std::sync::mpsc::Sender<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for data in rx {
            if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                return;
            }
        }
    });
    tx
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
