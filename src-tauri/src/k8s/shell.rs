//! Pod 셸(exec)과 컨테이너 attach 세션. 웹소켓으로 열고 출력을 채널로 흘린다. 클러스터에 터미널을 여는 곳은 이 파일뿐이다(`hygiene`이 지킨다).
//! 셸 입력·출력은 어디에도 남기지 않는다. 기록은 열고 닫은 시각과 대상뿐이고 변경 기록(`k8s-changes.jsonl`)에 한 줄로 남는다.
//! 세션은 `Shells`가 쥔다. 대상 탭을 닫거나 앱을 끄면 모두 닫는다.
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use futures::future::{BoxFuture, FutureExt};
use futures::{Sink, SinkExt};
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;
use kube::api::{Api, AttachParams, AttachedProcess, TerminalSize};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use super::change::{self, Change, Operation};
use super::connect::REQUEST_TIMEOUT;
use super::failure::{describe, short_reason, stream_failure_of, Endpoint, Failure};
use super::log;
use super::read::bounded;
use super::target::K8sTarget;
use crate::error::AppError;
use crate::iam::clock::{iso, now_secs};
use crate::iam::commit::new_log_id;

/// bash가 있으면 bash, 없으면 sh. 셸이 하나도 없는 이미지(distroless)는 exec 오류가 그대로 보인다.
pub const SHELL_COMMAND: [&str; 3] = ["/bin/sh", "-c", "[ -x /bin/bash ] && exec /bin/bash; exec /bin/sh"];
/// 한 번에 읽는 출력의 크기(바이트)
const READ_CHUNK: usize = 16 * 1024;
/// 프로세스가 끝났다고 알린 뒤(또는 출력이 모두 닫힌 뒤) 남은 출력이나 상태를 기다리는 시간
const DRAIN_GRACE: Duration = Duration::from_secs(2);
/// 변경 기록에 남기는 세션 요약
pub const SUMMARY_EXEC: &str = "Pod 셸 열기";
pub const SUMMARY_ATTACH: &str = "컨테이너 attach 열기";

pub const CONFIRM_MISMATCH: &str = "위험한 네임스페이스예요. Pod 이름을 정확히 입력해 주세요";
pub const NO_SUCH_CONTAINER: &str = "Pod에 그 컨테이너가 없어요";
pub const NOT_RUNNING: &str = "컨테이너가 실행 중이 아니에요";
pub const RECORD_FAILED: &str = "기록을 남기지 못해서 열지 않았어요";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellMode {
    /// 새 셸 프로세스
    Exec,
    /// 컨테이너의 주 프로세스
    Attach,
}

/// 터미널로 보내는 메시지
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ShellMessage {
    Output {
        data: String,
    },
    /// 프로세스가 끝났다. 끝나는 코드를 알면 `code`, 연결이 끊겨서 모르면 둘 다 없고, 시작하지 못했거나 코드가 없는 실패면 `reason`.
    Exit {
        code: Option<i32>,
        reason: Option<String>,
    },
}

/// 작업이 취소되어도 화면에 종료를 한 번 알린다.
pub struct ExitSender<F: FnMut(ShellMessage) -> bool> {
    send: F,
    exited: bool,
}

impl<F: FnMut(ShellMessage) -> bool> ExitSender<F> {
    pub fn new(send: F) -> Self {
        Self { send, exited: false }
    }

    pub fn send(&mut self, message: ShellMessage) -> bool {
        if matches!(message, ShellMessage::Exit { .. }) {
            self.exited = true;
        }
        (self.send)(message)
    }
}

impl<F: FnMut(ShellMessage) -> bool> Drop for ExitSender<F> {
    fn drop(&mut self) {
        if !self.exited {
            (self.send)(ShellMessage::Exit { code: None, reason: None });
        }
    }
}

/// 열린 세션. `input`은 이 세션이 입력을 받는지(attach는 컨테이너에 stdin과 tty가 켜져 있어야 한다).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOpened {
    pub id: u64,
    pub input: bool,
}

/// 위험한 네임스페이스·Pod면 Pod 이름을 그대로 입력해야 한다. 규칙은 변경 공통 틀의 것(`change::confirm_name`)을 쓴다.
pub fn check_confirm(namespace: &str, pod: &str, typed: Option<&str>) -> Result<(), AppError> {
    match change::confirm_name(Some(namespace), pod) {
        Some(needed) if typed != Some(needed.as_str()) => Err(AppError::other(CONFIRM_MISMATCH)),
        _ => Ok(()),
    }
}

/// 컨테이너에 맞춘 열기 계획
#[derive(Debug)]
pub struct Plan {
    pub params: AttachParams,
    pub input: bool,
}

/// Pod와 컨테이너를 보고 열기 계획을 만든다. 실행 중이 아닌 컨테이너는 열지 않는다.
/// exec는 늘 tty와 입력을 쓴다. attach는 컨테이너 설정의 `stdin`과 `tty`가 둘 다 켜져 있을 때만 입력을 보내고, tty가 아니면 stderr도 받는다.
pub fn plan_of(mode: ShellMode, pod: &Pod, container: &str) -> Result<Plan, AppError> {
    let spec = pod
        .spec
        .as_ref()
        .and_then(|s| s.containers.iter().find(|c| c.name == container))
        .ok_or_else(|| AppError::other(NO_SUCH_CONTAINER))?;
    let running = pod
        .status
        .as_ref()
        .and_then(|s| s.container_statuses.as_ref())
        .and_then(|list| list.iter().find(|c| c.name == container))
        .and_then(|c| c.state.as_ref())
        .is_some_and(|state| state.running.is_some());
    if !running {
        return Err(AppError::other(NOT_RUNNING));
    }
    let (input, tty) = match mode {
        ShellMode::Exec => (true, true),
        ShellMode::Attach => {
            let tty = spec.tty.unwrap_or(false);
            (spec.stdin.unwrap_or(false) && tty, tty)
        }
    };
    let params = AttachParams {
        container: Some(container.to_string()),
        stdin: input,
        stdout: true,
        // tty에서는 stdout과 stderr가 하나로 합쳐져 와서 stderr를 따로 요청하면 서버가 거절한다
        stderr: !tty,
        tty,
        max_stdin_buf_size: Some(READ_CHUNK),
        max_stdout_buf_size: Some(READ_CHUNK),
        max_stderr_buf_size: Some(READ_CHUNK),
    };
    Ok(Plan { params, input })
}

/// 웹소켓으로 여는 요청 하나를 `REQUEST_TIMEOUT` 안에 끝낸다. 오류는 `stream_failure_of`로 가른다.
pub async fn bounded_stream<T>(fut: impl Future<Output = Result<T, kube::Error>>, verb: &str, resource: &str, endpoint: Endpoint) -> Result<T, AppError> {
    tokio::time::timeout(REQUEST_TIMEOUT, fut)
        .await
        .map_err(|_| describe(&Failure::Unreachable, endpoint))?
        .map_err(|e| describe(&stream_failure_of(&e, verb, resource), endpoint))
}

/// 서버에 연결된 프로세스와 입력 가능 여부
pub struct Connected {
    pub process: AttachedProcess,
    pub input: bool,
}

/// Pod를 읽어 계획을 세우고 exec(`mode`가 `Exec`, `command`를 실행) 또는 attach(`command`는 안 쓴다)로 연결한다.
pub async fn connect(client: kube::Client, mode: ShellMode, namespace: &str, pod: &str, container: &str, command: &[&str], endpoint: Endpoint) -> Result<Connected, AppError> {
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let found = bounded(api.get(pod), "get", "pods", endpoint).await?;
    let plan = plan_of(mode, &found, container)?;
    let process = match mode {
        ShellMode::Exec => bounded_stream(api.exec(pod, command.iter().copied(), &plan.params), "create", "pods/exec", endpoint).await?,
        ShellMode::Attach => bounded_stream(api.attach(pod, &plan.params), "create", "pods/attach", endpoint).await?,
    };
    Ok(Connected { process, input: plan.input })
}

/// 바이트 조각을 글로 바꾼다. 조각 끝에서 잘린 UTF-8 문자는 `carry`에 두었다가 다음 조각 앞에 붙이고, 깨진 바이트는 �로 바꾼다.
pub fn decode_chunk(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    carry.extend_from_slice(chunk);
    let mut out = String::new();
    loop {
        match std::str::from_utf8(carry) {
            Ok(text) => {
                out.push_str(text);
                carry.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                out.push_str(&String::from_utf8_lossy(&carry[..valid]));
                match e.error_len() {
                    // 끝에서 잘린 문자: 다음 조각을 기다린다
                    None => {
                        carry.drain(..valid);
                        return out;
                    }
                    Some(bad) => {
                        out.push('\u{fffd}');
                        carry.drain(..valid + bad);
                    }
                }
            }
        }
    }
}

/// 프로세스 상태를 끝 코드와 사유로. 상태 없이 연결이 닫혔으면 둘 다 없다.
pub fn exit_of(status: Option<&Status>) -> (Option<i32>, Option<String>) {
    let Some(status) = status else {
        return (None, None);
    };
    if status.status.as_deref() == Some("Success") {
        return (Some(0), None);
    }
    let code = status
        .details
        .as_ref()
        .and_then(|d| d.causes.as_ref())
        .and_then(|causes| causes.iter().find(|c| c.reason.as_deref() == Some("ExitCode")))
        .and_then(|c| c.message.as_deref())
        .and_then(|m| m.parse::<i32>().ok());
    match code {
        Some(code) => (Some(code), None),
        None => (None, Some(short_reason(&status.message.as_deref().unwrap_or_default()))),
    }
}

/// 입력 쪽으로 가는 일: 키 입력 또는 크기 변경
#[derive(Debug, Clone, PartialEq)]
pub enum Input {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
}

/// 입력을 프로세스에 쓴다. 출력 읽기와 따로 돌아서, 큰 붙여넣기가 출력을 막지 않는다(서로 기다리는 교착을 피한다).
/// 입력을 받지 않는 세션(`stdin`이 없음)은 키 입력을 버린다.
pub async fn write_input<I, Z>(mut rx: mpsc::UnboundedReceiver<Input>, mut stdin: Option<I>, mut size: Option<Z>)
where
    I: AsyncWrite + Unpin,
    Z: Sink<TerminalSize> + Unpin,
{
    while let Some(input) = rx.recv().await {
        match input {
            Input::Data(bytes) => {
                if let Some(w) = stdin.as_mut() {
                    if w.write_all(&bytes).await.is_err() || w.flush().await.is_err() {
                        stdin = None;
                    }
                }
            }
            Input::Resize { cols, rows } => {
                if cols == 0 || rows == 0 {
                    continue;
                }
                if let Some(z) = size.as_mut() {
                    if z.send(TerminalSize { width: cols, height: rows }).await.is_err() {
                        size = None;
                    }
                }
            }
        }
    }
}

/// 한 갈래(stdout 또는 stderr)의 읽기 상태
struct Lane<R> {
    reader: Option<R>,
    carry: Vec<u8>,
    buf: Vec<u8>,
}

impl<R: AsyncRead + Unpin> Lane<R> {
    fn new(reader: Option<R>) -> Self {
        Lane { reader, carry: Vec::new(), buf: vec![0; READ_CHUNK] }
    }

    /// 읽을 것이 없는 갈래(없거나 닫힘)는 끝없이 기다린다
    async fn read(&mut self) -> std::io::Result<usize> {
        match self.reader.as_mut() {
            Some(r) => r.read(&mut self.buf).await,
            None => std::future::pending().await,
        }
    }

    /// 읽은 결과를 처리한다. 보내기가 실패하면 false(채널이 닫힘).
    fn took(&mut self, read: std::io::Result<usize>, send: &mut impl FnMut(ShellMessage) -> bool) -> bool {
        match read {
            Ok(n) if n > 0 => {
                let data = decode_chunk(&mut self.carry, &self.buf[..n]);
                data.is_empty() || send(ShellMessage::Output { data })
            }
            _ => {
                self.reader = None;
                // 끝에서 잘려 남은 바이트가 있으면 마지막으로 내보낸다
                if self.carry.is_empty() {
                    return true;
                }
                let rest = String::from_utf8_lossy(&std::mem::take(&mut self.carry)).into_owned();
                send(ShellMessage::Output { data: rest })
            }
        }
    }
}

/// 프로세스 출력을 채널로 흘리고 끝나면 `Exit`를 보낸다. 상태가 오면 남은 출력을 `DRAIN_GRACE`까지만 기다린다. 보내기가 실패하면(화면이 채널을 버림) 바로 끝낸다.
pub async fn pump<O, E, S>(stdout: Option<O>, stderr: Option<E>, status: S, mut send: impl FnMut(ShellMessage) -> bool)
where
    O: AsyncRead + Unpin,
    E: AsyncRead + Unpin,
    S: Future<Output = Option<Status>>,
{
    let mut out = Lane::new(stdout);
    let mut err = Lane::new(stderr);
    let mut status = pin!(status.fuse());
    let mut result: Option<Option<Status>> = None;
    let mut deadline: Option<tokio::time::Instant> = None;
    loop {
        let lanes_open = out.reader.is_some() || err.reader.is_some();
        if result.is_some() && !lanes_open {
            break;
        }
        // 갈래가 모두 닫혔는데 상태가 없으면 상태도 잠깐만 기다린다
        if !lanes_open && deadline.is_none() {
            deadline = Some(tokio::time::Instant::now() + DRAIN_GRACE);
        }
        tokio::select! {
            read = out.read() => {
                if !out.took(read, &mut send) {
                    return;
                }
            }
            read = err.read() => {
                if !err.took(read, &mut send) {
                    return;
                }
            }
            s = &mut status, if result.is_none() => {
                result = Some(s);
                deadline.get_or_insert(tokio::time::Instant::now() + DRAIN_GRACE);
            }
            _ = tokio::time::sleep_until(deadline.unwrap_or_else(tokio::time::Instant::now)), if deadline.is_some() => {
                break;
            }
        }
    }
    let (code, reason) = exit_of(result.flatten().as_ref());
    send(ShellMessage::Exit { code, reason });
}

/// 사라지면 붙은 작업을 멈춘다
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// 사라지면 목록에서 자기 항목을 지우고 닫은 시각을 적는다
struct Finish {
    shells: Arc<Shells>,
    id: u64,
}

impl Drop for Finish {
    fn drop(&mut self) {
        self.shells.finish(self.id);
    }
}

async fn session(mut process: AttachedProcess, rx: mpsc::UnboundedReceiver<Input>, send: impl FnMut(ShellMessage) -> bool) {
    let stdout = process.stdout();
    let stderr = process.stderr();
    let stdin = process.stdin();
    let size = process.terminal_size();
    let status = process.take_status();
    let _writer = AbortOnDrop(tokio::spawn(write_input(rx, stdin, size)));
    let status = async move {
        match status {
            Some(s) => s.await,
            None => None,
        }
    };
    pump(stdout, stderr, status, send).await;
    // `process`는 여기서 버려지며 웹소켓을 닫는다
}

/// 열 세션의 대상
#[derive(Debug, Clone)]
pub struct ShellTarget {
    pub target: K8sTarget,
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub mode: ShellMode,
}

/// 세션이 끝난 뒤 한 번 돌리는 정리(노드 셸: 디버그 Pod 지우기)
pub type Cleanup = Box<dyn FnOnce() -> BoxFuture<'static, ()> + Send>;

/// 변경 기록에 남기는 세션 한 줄: 어디에, 언제 열고 닫았는지만. 입력·출력은 없다. 되돌릴 수 없다(`inverse` 없음).
fn record_of(info: &ShellTarget, id: String, now: i64) -> log::Entry {
    let object = change::pod_object(&info.namespace, &info.pod);
    let summary = match info.mode {
        ShellMode::Exec => SUMMARY_EXEC,
        ShellMode::Attach => SUMMARY_ATTACH,
    };
    log::Entry {
        id,
        at: iso(now),
        target: info.target.clone(),
        change: Change { target: object, operation: Operation::Shell { container: info.container.clone(), mode: info.mode } },
        summary: format!("{summary}: {}/{} ({})", info.namespace, info.pod, info.container),
        ok: true,
        error: None,
        inverse: None,
        undo_of: None,
        undone: false,
        closed_at: None,
    }
}

struct ShellEntry {
    target: K8sTarget,
    input: mpsc::UnboundedSender<Input>,
    handle: tokio::task::AbortHandle,
    log: PathBuf,
    key: String,
    cleanup: Option<Cleanup>,
}

/// 열려 있는 셸·attach 세션. 잠금은 이 안에서만 잡는다(`K8sState`의 잠금 순서에서 맨 뒤).
#[derive(Default)]
pub struct Shells {
    entries: Mutex<HashMap<u64, ShellEntry>>,
    next: AtomicU64,
    /// 돌고 있는 정리 작업. 앱을 끌 때 `settle`이 끝나기를 기다린다.
    cleanups: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shells {
    /// 연결된 프로세스로 세션을 띄워 등록한다.
    pub fn start(
        self: &Arc<Self>,
        log: &Path,
        info: ShellTarget,
        connected: Connected,
        cleanup: Option<Cleanup>,
        send: impl FnMut(ShellMessage) -> bool + Send + 'static,
    ) -> Result<ShellOpened, AppError> {
        let Connected { process, input } = connected;
        let mut sender = ExitSender::new(send);
        self.register(log, info, input, cleanup, move |rx| session(process, rx, move |message| sender.send(message)))
    }

    /// 변경 기록에 세션 한 줄을 남기고 `run`이 만든 세션 작업을 띄워 등록한다. 기록을 못 남기면 열지 않는다.
    /// 등록이 끝날 때까지 잠금을 쥐므로, 곧바로 끝나는 세션의 `finish`도 등록 뒤에 실행된다.
    pub fn register<F>(
        self: &Arc<Self>,
        log: &Path,
        info: ShellTarget,
        input: bool,
        cleanup: Option<Cleanup>,
        run: impl FnOnce(mpsc::UnboundedReceiver<Input>) -> F,
    ) -> Result<ShellOpened, AppError>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let target = info.target.clone();
        self.register_with(log, target, |key, now| record_of(&info, key, now), input, cleanup, run)
    }

    /// `register`와 같되 기록 한 줄을 `record`(기록 번호, 지금 시각)로 직접 만든다. Pod가 아닌 세션(로컬 터미널)이 쓴다.
    pub fn register_with<F>(
        self: &Arc<Self>,
        log: &Path,
        target: K8sTarget,
        record: impl FnOnce(String, i64) -> log::Entry,
        input: bool,
        cleanup: Option<Cleanup>,
        run: impl FnOnce(mpsc::UnboundedReceiver<Input>) -> F,
    ) -> Result<ShellOpened, AppError>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let now = now_secs();
        let key = new_log_id(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis()));
        log::append(log, &record(key.clone(), now)).map_err(|_| AppError::other(RECORD_FAILED))?;
        let (tx, rx) = mpsc::unbounded_channel();
        let mut entries = locked(&self.entries);
        let finish = Finish { shells: self.clone(), id };
        let session = run(rx);
        let task = tokio::spawn(async move {
            // 끝나는 길이 무엇이든(패닉, 취소 포함) 항목을 지우고 닫은 시각을 적는다
            let _finish = finish;
            session.await;
        });
        entries.insert(id, ShellEntry { target, input: tx, handle: task.abort_handle(), log: log.to_path_buf(), key, cleanup });
        Ok(ShellOpened { id, input })
    }

    /// 키 입력을 보낸다. 이미 끝난 세션이면 무시한다.
    pub fn input(&self, id: u64, data: String) {
        if let Some(e) = locked(&self.entries).get(&id) {
            let _ = e.input.send(Input::Data(data.into_bytes()));
        }
    }

    pub fn resize(&self, id: u64, cols: u16, rows: u16) {
        if let Some(e) = locked(&self.entries).get(&id) {
            let _ = e.input.send(Input::Resize { cols, rows });
        }
    }

    /// 세션을 닫는다: 웹소켓을 끊고 닫은 시각을 적는다. 없는 번호는 무시한다.
    pub fn close(&self, id: u64) {
        self.finish(id);
    }

    pub fn close_target(&self, t: &K8sTarget) {
        let ids: Vec<u64> = locked(&self.entries).iter().filter(|(_, e)| e.target == *t).map(|(id, _)| *id).collect();
        for id in ids {
            self.finish(id);
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<u64> = locked(&self.entries).keys().copied().collect();
        for id in ids {
            self.finish(id);
        }
    }

    /// 돌고 있는 정리 작업이 끝나기를 `limit`까지 기다린다(앱을 끌 때 노드 셸 Pod가 남지 않게).
    pub async fn settle(&self, limit: Duration) {
        let pending: Vec<_> = locked(&self.cleanups).drain(..).collect();
        let _ = tokio::time::timeout(limit, futures::future::join_all(pending)).await;
    }

    /// 항목을 지우고 세션을 멈추고 닫은 시각을 적고 정리를 띄운다. 이미 지워졌으면 아무것도 하지 않는다.
    fn finish(&self, id: u64) {
        let Some(entry) = locked(&self.entries).remove(&id) else {
            return;
        };
        entry.handle.abort();
        let _ = log::mark_closed(&entry.log, &entry.key, &iso(now_secs()));
        if let Some(cleanup) = entry.cleanup {
            // 앱 종료처럼 런타임 밖에서 불려도 되도록 tauri의 런타임으로 띄운다
            let task = tauri::async_runtime::spawn(cleanup());
            locked(&self.cleanups).push(task);
        }
    }
}

#[cfg(test)]
mod tests;
