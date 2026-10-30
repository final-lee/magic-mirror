//! exec 플러그인(`aws`)을 찾을 PATH. Finder에서 켠 앱은 셸의 PATH를 물려받지 않아서 로그인 셸에 한 번 물어본다.
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::OnceCell;

pub const FALLBACK_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const SHELL_TIMEOUT: Duration = Duration::from_secs(3);

/// 셸이 알려 준 PATH 뒤에, 거기 없는 기본 경로를 붙인다.
pub fn merge_path(shell: Option<&str>) -> String {
    let mut parts: Vec<&str> = shell.unwrap_or("").trim().split(':').filter(|p| !p.is_empty()).collect();
    for p in FALLBACK_PATH.split(':') {
        if !parts.contains(&p) {
            parts.push(p);
        }
    }
    parts.join(":")
}

static LOGIN_PATH: OnceCell<String> = OnceCell::const_new();

/// 로그인 셸의 PATH를 한 번만 읽어 둔다. 실패하거나 3초를 넘기면 기본 경로만 쓴다.
pub async fn login_path() -> &'static str {
    LOGIN_PATH
        .get_or_init(|| async {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let run = Command::new(shell).args(["-lc", "printf %s \"$PATH\""]).kill_on_drop(true).output();
            let out = tokio::time::timeout(SHELL_TIMEOUT, run).await.ok().and_then(Result::ok).filter(|o| o.status.success());
            merge_path(out.as_ref().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).as_deref())
        })
        .await
}

#[cfg(test)]
mod tests;
