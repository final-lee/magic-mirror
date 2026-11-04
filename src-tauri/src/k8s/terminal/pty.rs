//! 의사 터미널(PTY)에 프로세스를 띄우는 유일한 곳이다(`hygiene`이 `CommandBuilder::new(`와 `.spawn_command(`가 이 파일 밖에 없는지 확인한다).
//! 프로세스는 사용자의 로그인 셸이고 그 안에서 `kubectl` 같은 명령이 클러스터를 바꿀 수 있어서, kube 쓰기 호출과 같은 취급이다.
//! PTY 읽기·쓰기·종료 기다리기는 막히는 호출이라 각자 스레드에서 돌리고, 비동기 쪽에는 채널로 넘긴다.
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{mpsc, oneshot};

use crate::error::AppError;

pub const OPEN_FAILED: &str = "터미널을 열지 못했어요";
pub const SPAWN_FAILED: &str = "셸을 실행하지 못했어요";
/// 한 번에 읽는 출력의 크기(바이트)
const READ_CHUNK: usize = 16 * 1024;

/// 프로세스가 끝난 상태. `code`는 종료 코드, `signal`은 신호로 끝났을 때의 이름.
#[derive(Debug, Clone, PartialEq)]
pub struct Exited {
    pub code: Option<i32>,
    pub signal: Option<String>,
}

/// 띄울 프로세스: 인자 전체(첫 번째가 프로그램), 환경 전체(비어 있는 것에서 시작한다), 작업 폴더, 처음 크기
#[derive(Debug, Clone)]
pub struct Launch<'a> {
    pub argv: &'a [String],
    pub env: &'a [(String, String)],
    pub cwd: Option<&'a Path>,
    pub cols: u16,
    pub rows: u16,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn size_of(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

/// 열린 PTY와 그 안의 프로세스. `close`(또는 버려질 때)가 프로세스를 죽이고 PTY를 닫는다. 여러 번 불러도 된다.
pub struct Pty {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    /// 입력은 쓰기 스레드가 순서대로 쓴다(큰 붙여넣기가 출력을 읽는 쪽을 막지 않는다)
    writer: Mutex<Option<std_mpsc::Sender<Vec<u8>>>>,
    /// 프로세스를 이미 거둬 갔는지. 거둔 뒤의 PID는 다른 프로세스가 쓸 수 있어서 신호를 보내지 않는다.
    reaped: Arc<AtomicBool>,
}

/// 띄운 결과: PTY, 출력 조각(끝나면 닫힌다), 프로세스가 끝났다는 알림
pub struct Spawned {
    pub pty: Pty,
    pub output: mpsc::UnboundedReceiver<Vec<u8>>,
    pub exit: oneshot::Receiver<Exited>,
}

/// 환경은 `launch.env`에 있는 것만 쓴다(부모의 환경을 물려받지 않는다).
pub fn spawn(launch: &Launch<'_>) -> Result<Spawned, AppError> {
    let (program, args) = launch.argv.split_first().ok_or_else(|| AppError::other(SPAWN_FAILED))?;
    let pair = native_pty_system().openpty(size_of(launch.cols, launch.rows)).map_err(|_| AppError::other(OPEN_FAILED))?;
    let mut command = CommandBuilder::new(program);
    command.args(args);
    command.env_clear();
    for (key, value) in launch.env {
        command.env(key, value);
    }
    if let Some(cwd) = launch.cwd {
        command.cwd(cwd);
    }
    let mut child = pair.slave.spawn_command(command).map_err(|_| AppError::other(SPAWN_FAILED))?;
    // 슬레이브를 여기서 닫아야 프로세스가 끝났을 때 읽는 쪽이 끝을 안다
    drop(pair.slave);
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|_| AppError::other(OPEN_FAILED))?;
    let mut writer = pair.master.take_writer().map_err(|_| AppError::other(OPEN_FAILED))?;

    let (output_tx, output) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    if output_tx.send(buf[..n].to_vec()).is_err() {
                        return;
                    }
                }
                // 프로세스가 끝나면 EOF나 EIO가 온다
                _ => return,
            }
        }
    });
    let (exit_tx, exit) = oneshot::channel();
    let reaped = Arc::new(AtomicBool::new(false));
    let waiter_reaped = reaped.clone();
    std::thread::spawn(move || {
        let status = child.wait().ok().map(|status| Exited {
            code: status.signal().is_none().then(|| status.exit_code() as i32),
            signal: status.signal().map(str::to_owned),
        });
        waiter_reaped.store(true, Ordering::SeqCst);
        let _ = exit_tx.send(status.unwrap_or(Exited { code: None, signal: None }));
    });
    let (writer_tx, writer_rx) = std_mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(bytes) = writer_rx.recv() {
            if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                return;
            }
        }
    });
    let pty = Pty { master: Mutex::new(Some(pair.master)), killer: Mutex::new(Some(killer)), writer: Mutex::new(Some(writer_tx)), reaped };
    Ok(Spawned { pty, output, exit })
}

impl Pty {
    /// 키 입력을 프로세스에 보낸다. 닫힌 뒤에는 버린다.
    pub fn write(&self, bytes: Vec<u8>) {
        if let Some(writer) = locked(&self.writer).as_ref() {
            let _ = writer.send(bytes);
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        if let Some(master) = locked(&self.master).as_ref() {
            let _ = master.resize(size_of(cols, rows));
        }
    }

    /// 프로세스를 죽이고 PTY를 닫는다(남은 자식에게는 제어 터미널이 닫히며 SIGHUP이 간다).
    pub fn close(&self) {
        if let Some(mut killer) = locked(&self.killer).take() {
            if !self.reaped.load(Ordering::SeqCst) {
                let _ = killer.kill();
            }
        }
        locked(&self.writer).take();
        locked(&self.master).take();
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        self.close();
    }
}
