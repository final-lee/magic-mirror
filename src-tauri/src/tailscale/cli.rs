use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

fn executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

pub async fn locate() -> Option<PathBuf> {
    let app = PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    if executable(&app) { return Some(app); }
    crate::k8s::path::login_path().await.split(':').filter(|s| !s.is_empty())
        .map(|s| Path::new(s).join("tailscale")).find(|p| executable(p))
}

async fn run(path: &Path, args: &[&str], seconds: u64, allow_failure: bool) -> Result<String, String> {
    let mut command = Command::new(path);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(seconds), command.output()).await
        .map_err(|_| "Tailscale 명령이 시간 안에 끝나지 않았어요".to_string())?
        .map_err(|e| format!("Tailscale을 실행하지 못했어요: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !allow_failure && !output.status.success() {
        return Err(format!("Tailscale 명령이 실패했어요: {}", stderr.lines().next().filter(|s| !s.is_empty()).unwrap_or("알 수 없는 오류")));
    }
    let mut stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if allow_failure && !stderr.is_empty() { stdout.push('\n'); stdout.push_str(&stderr); }
    Ok(stdout)
}

pub async fn status_json(path: &Path) -> Result<String, String> { run(path, &["status", "--json"], 5, false).await }
pub async fn prefs_json(path: &Path) -> Result<String, String> { run(path, &["get", "--json"], 5, false).await }
pub async fn ping(path: &Path, addr: &str) -> Result<String, String> { run(path, &["ping", "--c", "3", "--timeout", "3s", addr], 12, true).await }
pub async fn netcheck_json(path: &Path) -> Result<String, String> { run(path, &["netcheck", "--format", "json"], 10, false).await }
pub async fn set_accept_routes(path: &Path, enabled: bool) -> Result<(), String> {
    run(path, &["set", if enabled { "--accept-routes=true" } else { "--accept-routes=false" }], 5, false).await.map(|_| ())
}
