//! 앱 안 터미널: 사용자의 로그인 셸을 PTY에 띄우고, 그 셸의 `kubectl`이 이 탭의 클러스터만 보게 고정한다.
//! 고정하는 방법은 이 탭의 context 하나만 남긴(현재 context로 설정한) 임시 kubeconfig를 만들어 `KUBECONFIG`로 주고,
//! 부모에서 물려받은 `KUBECONFIG`·`KUBE*`·`HELM_KUBE*`는 치우는 것이다. 임시 파일은 터미널을 닫으면(탭 닫기, 앱 끄기 포함) 지운다.
//! 셸 입력·출력은 어디에도 남기지 않는다. 기록은 열고 닫은 시각과 대상(context)뿐이고 변경 기록에 한 줄로 남는다(`Shells`가 쥔다).
//! 플러그인 명령은 확인 창에서 사용자가 본 그대로를 `-lc`의 인자 하나로 넘긴다(키 입력으로 흉내 내지 않는다).
use std::path::{Path, PathBuf};
use std::pin::pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use kube::config::{AuthInfo, Kubeconfig};
use tempfile::NamedTempFile;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use super::change::{Change, ChangeObject, Operation};
use super::kubeconfig::{exec_profile, minify};
use super::log;
use super::rows::KindRef;
use super::shell::{decode_chunk, Cleanup, Input, ShellMessage, ShellOpened, Shells};
use super::target::K8sTarget;
use crate::error::AppError;
use crate::iam::clock::iso;
use self::pty::{Exited, Launch};

pub mod pty;

/// 프로세스가 끝났다고 알린 뒤(또는 출력이 모두 닫힌 뒤) 남은 출력이나 상태를 기다리는 시간
const DRAIN_GRACE: Duration = Duration::from_secs(2);
/// 변경 기록에 남기는 세션 요약
pub const SUMMARY: &str = "터미널 열기";
pub const SUMMARY_PLUGIN: &str = "플러그인 실행";
pub const KUBECONFIG_FAILED: &str = "이 탭의 kubeconfig를 임시 파일로 만들지 못했어요";
pub const FALLBACK_SHELL: &str = "/bin/zsh";
/// 셸이 알 수 있는 터미널 종류. xterm.js가 256색·트루컬러를 그린다.
const TERM: &str = "xterm-256color";

/// 이 앱의 터미널 기록이 가리키는 가상의 종류(클러스터 객체가 아니다). 대상 이름이 고정한 context다.
pub fn terminal_kind() -> KindRef {
    KindRef { group: "magic-mirror.io".into(), version: "v1".into(), kind: "Terminal".into(), plural: "terminals".into(), namespaced: false }
}

pub fn terminal_object(context: &str) -> ChangeObject {
    ChangeObject { kind: terminal_kind(), namespace: None, name: context.to_string() }
}

/// 변경 기록에 남기는 세션 한 줄: 어느 context에 언제 열었는지와(플러그인이면) 실행한 명령. 입력·출력은 없다. 되돌릴 수 없다.
fn record_of(target: &K8sTarget, context: &str, command: Option<&str>, id: String, now: i64) -> log::Entry {
    let summary = match command {
        None => format!("{SUMMARY}: {context}"),
        Some(command) => format!("{SUMMARY_PLUGIN}: {command} ({context})"),
    };
    log::Entry {
        id,
        at: iso(now),
        target: target.clone(),
        change: Change { target: terminal_object(context), operation: Operation::Terminal { command: command.map(str::to_owned) } },
        summary,
        ok: true,
        error: None,
        inverse: None,
        undo_of: None,
        undone: false,
        closed_at: None,
    }
}

/// 다른 클러스터를 가리킬 수 있어서 셸에 물려주지 않는 환경 변수
fn points_elsewhere(key: &str) -> bool {
    key == "KUBECONFIG" || key.starts_with("KUBE") || key.starts_with("HELM_KUBE")
}

/// 셸의 환경: 부모의 환경에서 다른 클러스터를 가리킬 수 있는 것을 치우고, 고정한 `KUBECONFIG`와 로그인 PATH, 터미널 종류를 넣는다.
/// `exec_profile`(kubeconfig의 exec 플러그인이 쓰는 AWS 프로필)이 있으면 `AWS_PROFILE`로 준다: 앱이 이 클러스터에 접속할 때와 같은 신원이다.
pub fn env_of(parent: impl IntoIterator<Item = (String, String)>, kubeconfig: &Path, exec_profile: Option<&str>, path: &str) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = parent
        .into_iter()
        .filter(|(key, _)| !points_elsewhere(key) && !["PATH", "TERM", "COLORTERM"].contains(&key.as_str()) && !(exec_profile.is_some() && key == "AWS_PROFILE"))
        .collect();
    env.push(("KUBECONFIG".into(), kubeconfig.to_string_lossy().into_owned()));
    env.push(("PATH".into(), path.to_string()));
    env.push(("TERM".into(), TERM.into()));
    env.push(("COLORTERM".into(), "truecolor".into()));
    if let Some(profile) = exec_profile {
        env.push(("AWS_PROFILE".into(), profile.to_string()));
    }
    env
}

/// 열 셸: `$SHELL`이 존재하는 절대 경로면 그것, 아니면 macOS 기본 셸
pub fn shell_of(env_shell: Option<&str>) -> String {
    match env_shell {
        Some(shell) if Path::new(shell).is_absolute() && Path::new(shell).is_file() => shell.to_string(),
        _ => FALLBACK_SHELL.to_string(),
    }
}

/// 셸에 넘길 인자: 명령이 없으면 로그인 셸(`-l`, 터미널이라 대화형), 있으면 `-lc <명령>`(명령 전체가 인자 하나)
pub fn argv_of(shell: &str, command: Option<&str>) -> Vec<String> {
    match command {
        None => vec![shell.to_string(), "-l".into()],
        Some(command) => vec![shell.to_string(), "-lc".into(), command.to_string()],
    }
}

/// context의 사용자가 쓰는 exec 플러그인의 AWS 프로필
pub fn exec_profile_of(config: &Kubeconfig, context: &str) -> Option<String> {
    let user = config.contexts.iter().find(|c| c.name == context)?.context.as_ref()?.user.as_ref()?;
    let info: &AuthInfo = config.auth_infos.iter().find(|u| u.name == *user)?.auth_info.as_ref()?;
    exec_profile(info)
}

/// 이 context 하나만 담은 임시 kubeconfig를 쓴다(현재 context로 설정). 소유자만 읽을 수 있고, 파일 값이 버려지면 지워진다.
/// kubeconfig는 YAML이고 JSON은 YAML의 부분집합이라 `serde_json`으로 쓴다.
pub fn write_pinned(config: &Kubeconfig, context: &str) -> Result<NamedTempFile, AppError> {
    let pinned = minify(config, context)?;
    let text = serde_json::to_string_pretty(&pinned).map_err(|_| AppError::other(KUBECONFIG_FAILED))?;
    let mut file = tempfile::Builder::new().prefix("mm-kubeconfig-").suffix(".yaml").tempfile().map_err(|_| AppError::other(KUBECONFIG_FAILED))?;
    std::io::Write::write_all(&mut file, text.as_bytes()).map_err(|_| AppError::other(KUBECONFIG_FAILED))?;
    Ok(file)
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 열 터미널의 요청
pub struct OpenRequest<'a> {
    pub target: K8sTarget,
    /// 고정할 context(이 탭이 연결한 것)
    pub context: String,
    pub config: &'a Kubeconfig,
    /// 플러그인이 확인받은 명령. 없으면 대화형 로그인 셸
    pub command: Option<String>,
    pub shell: String,
    pub parent_env: Vec<(String, String)>,
    pub path: String,
    pub cwd: Option<PathBuf>,
    pub cols: u16,
    pub rows: u16,
}

/// 열린 PTY와 그것이 쓰는 임시 kubeconfig. `close`(또는 버려질 때)가 프로세스를 죽이고 파일을 지운다. 여러 번 불러도 된다.
pub struct Terminal {
    pty: pty::Pty,
    file: Mutex<Option<NamedTempFile>>,
}

impl Terminal {
    pub fn close(&self) {
        self.pty.close();
        // 값이 버려지면 파일이 지워진다
        locked(&self.file).take();
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.close();
    }
}

/// 띄운 터미널. `register`로 세션 목록에 올리기 전에 버려지면 프로세스와 임시 파일이 바로 정리된다.
pub struct Launched {
    terminal: Arc<Terminal>,
    output: mpsc::UnboundedReceiver<Vec<u8>>,
    exit: oneshot::Receiver<Exited>,
    kubeconfig: PathBuf,
    target: K8sTarget,
    context: String,
    command: Option<String>,
}

/// 임시 kubeconfig를 쓰고 셸을 PTY에 띄운다.
pub fn launch(request: OpenRequest<'_>) -> Result<Launched, AppError> {
    let file = write_pinned(request.config, &request.context)?;
    let kubeconfig = file.path().to_path_buf();
    let env = env_of(request.parent_env, &kubeconfig, exec_profile_of(request.config, &request.context).as_deref(), &request.path);
    let argv = argv_of(&request.shell, request.command.as_deref());
    // 실패하면 `file`이 버려지며 파일이 지워진다
    let spawned = pty::spawn(&Launch { argv: &argv, env: &env, cwd: request.cwd.as_deref(), cols: request.cols, rows: request.rows })?;
    let terminal = Arc::new(Terminal { pty: spawned.pty, file: Mutex::new(Some(file)) });
    Ok(Launched { terminal, output: spawned.output, exit: spawned.exit, kubeconfig, target: request.target, context: request.context, command: request.command })
}

impl Launched {
    /// 이 터미널이 쓰는 임시 kubeconfig의 경로
    pub fn kubeconfig_path(&self) -> &Path {
        &self.kubeconfig
    }

    /// 세션 목록에 올리고(변경 기록에 열었다고 남긴다) 출력을 `send`로 흘린다. 기록을 못 남기면 열지 않고 정리한다.
    pub fn register(self, shells: &Arc<Shells>, log: &Path, send: impl FnMut(ShellMessage) -> bool + Send + 'static) -> Result<ShellOpened, AppError> {
        let Launched { terminal, output, exit, target, context, command, .. } = self;
        let cleanup: Cleanup = Box::new({
            let terminal = terminal.clone();
            move || {
                Box::pin(async move {
                    terminal.close();
                })
            }
        });
        let record_target = target.clone();
        let record_command = command.clone();
        shells.register_with(
            log,
            target,
            move |id, now| record_of(&record_target, &context, record_command.as_deref(), id, now),
            true,
            Some(cleanup),
            move |rx| session(terminal, output, exit, rx, send),
        )
    }
}

/// 끝난 상태를 터미널 메시지로. 신호로 끝났으면 코드 없이 사유만 싣는다.
pub fn exit_message(exited: Option<Exited>) -> ShellMessage {
    match exited {
        Some(Exited { code: Some(code), .. }) => ShellMessage::Exit { code: Some(code), reason: None },
        Some(Exited { signal: Some(signal), .. }) => ShellMessage::Exit { code: None, reason: Some(signal) },
        _ => ShellMessage::Exit { code: None, reason: None },
    }
}

/// 출력 조각을 글로 바꿔 보낸다. 보내기가 실패하면(화면이 채널을 버림) false.
fn flush(carry: &mut Vec<u8>, chunk: &[u8], send: &mut impl FnMut(ShellMessage) -> bool) -> bool {
    let data = decode_chunk(carry, chunk);
    data.is_empty() || send(ShellMessage::Output { data })
}

/// 출력을 채널로 흘리고 입력·크기 변경을 PTY에 전한다. 프로세스가 끝나면 남은 출력을 `DRAIN_GRACE`까지만 기다렸다 `Exit`를 보낸다.
async fn session(
    terminal: Arc<Terminal>,
    mut output: mpsc::UnboundedReceiver<Vec<u8>>,
    exit: oneshot::Receiver<Exited>,
    mut rx: mpsc::UnboundedReceiver<Input>,
    mut send: impl FnMut(ShellMessage) -> bool,
) {
    let mut carry = Vec::new();
    let mut exit = pin!(exit);
    let mut input_open = true;
    let exited = loop {
        tokio::select! {
            chunk = output.recv() => match chunk {
                Some(chunk) => {
                    if !flush(&mut carry, &chunk, &mut send) {
                        return;
                    }
                }
                // 출력이 먼저 닫혔다: 프로세스 상태를 잠깐 기다린다
                None => break tokio::time::timeout(DRAIN_GRACE, exit.as_mut()).await.ok().and_then(Result::ok),
            },
            input = rx.recv(), if input_open => match input {
                Some(Input::Data(bytes)) => terminal.pty.write(bytes),
                Some(Input::Resize { cols, rows }) => terminal.pty.resize(cols, rows),
                None => input_open = false,
            },
            status = exit.as_mut() => {
                // 상태가 먼저 왔다: 남은 출력을 마저 읽는다
                let deadline = Instant::now() + DRAIN_GRACE;
                while let Ok(Some(chunk)) = tokio::time::timeout_at(deadline, output.recv()).await {
                    if !flush(&mut carry, &chunk, &mut send) {
                        return;
                    }
                }
                break status.ok();
            }
        }
    };
    if !carry.is_empty() {
        let rest = String::from_utf8_lossy(&std::mem::take(&mut carry)).into_owned();
        if !send(ShellMessage::Output { data: rest }) {
            return;
        }
    }
    send(exit_message(exited));
}

#[cfg(test)]
mod tests;
