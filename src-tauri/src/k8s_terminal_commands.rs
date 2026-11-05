//! EKS 탭의 앱 안 터미널 명령. 입력·크기·닫기는 셸 세션과 같은 명령(`k8s_shell_input`·`k8s_shell_resize`·`k8s_shell_close`)을 쓴다.
use std::path::PathBuf;

use tauri::State;

use crate::error::AppError;
use crate::k8s::failure::NOT_OPENED;
use crate::k8s::path::login_path;
use crate::k8s::shell::{ShellMessage, ShellOpened};
use crate::k8s::target::K8sTarget;
use crate::k8s::terminal::{self, OpenRequest};
use crate::k8s_commands::K8sState;

pub const EMPTY_COMMAND: &str = "실행할 명령이 비어 있어요";

/// 이 탭의 클러스터에 고정된 로컬 터미널을 연다. 플러그인 명령은 POSIX 셸의 `-c`로 실행한다.
/// 출력은 채널로 오고 반환값의 번호로 입력·크기·닫기를 한다. 열고 닫은 시각은 변경 기록에 남는다.
#[tauri::command]
pub async fn k8s_terminal_open(
    k8s: State<'_, K8sState>,
    target: K8sTarget,
    command: Option<String>,
    cols: u16,
    rows: u16,
    on_event: tauri::ipc::Channel<ShellMessage>,
) -> Result<ShellOpened, AppError> {
    if command.as_deref().is_some_and(|command| command.trim().is_empty()) {
        return Err(AppError::other(EMPTY_COMMAND));
    }
    let started = k8s.epoch(&target);
    let session = k8s.session(&target)?;
    let launched = terminal::launch(OpenRequest {
        target: target.clone(),
        context: session.context.clone(),
        config: &session.kubeconfig,
        command,
        shell: terminal::shell_of(std::env::var("SHELL").ok().as_deref()),
        parent_env: std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect(),
        path: login_path().await.to_string(),
        cwd: std::env::var_os("HOME").map(PathBuf::from),
        cols,
        rows,
    })?;
    // 그사이 탭이 닫혔으면 `launched`가 버려지며 프로세스와 임시 파일이 정리된다
    k8s.while_current(&target, started, || launched.register(k8s.shells(), k8s.log_path(), move |m| on_event.send(m).is_ok()))
        .ok_or_else(|| AppError::other(NOT_OPENED))?
}
