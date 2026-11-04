//! 읽기 전용 kubectl describe 실행. 임의의 하위 명령은 받지 않는다.
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::error::AppError;
use crate::k8s::failure::{exec_failure, redact_secrets, Failure};
use crate::k8s::path::login_path;
use crate::k8s::rows::KindRef;
use crate::k8s_commands::Session;

const LIMIT: u64 = 4 * 1024 * 1024;

fn plain(value: &str) -> bool {
    !value.is_empty() && !value.starts_with('-') && !value.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn arguments(context: &str, kind: &KindRef, namespace: Option<&str>, name: &str) -> Result<Vec<String>, AppError> {
    // kubectl은 서비스 계정 토큰과 last-applied 어노테이션에 남은 Secret 값을 내보낼 수 있다.
    if kind.plural.eq_ignore_ascii_case("secrets") || kind.plural.eq_ignore_ascii_case("secret") || kind.kind.eq_ignore_ascii_case("secret") {
        return Err(AppError::other("Secret 값 보호를 위해 앱의 요약을 보여요"));
    }
    let resource_valid = !kind.plural.is_empty() && !kind.plural.starts_with('-') && kind.plural.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-');
    let group_valid = kind.group.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'.');
    if context.is_empty() || context.chars().any(char::is_control) || !resource_valid || !group_valid || !plain(name) || namespace.is_some_and(|n| !plain(n)) {
        return Err(AppError::other("객체 이름 또는 context가 올바르지 않아요"));
    }
    let resource = if kind.group.is_empty() { kind.plural.clone() } else { format!("{}.{}", kind.plural, kind.group) };
    let mut args = vec!["--context".into(), context.into(), "describe".into(), resource, name.into()];
    if let Some(ns) = namespace {
        args.extend(["-n".into(), ns.into()]);
    }
    Ok(args)
}

async fn bounded(reader: impl AsyncRead + Unpin) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    reader.take(LIMIT + 1).read_to_end(&mut bytes).await.map_err(|_| AppError::other("kubectl 출력을 읽지 못했어요"))?;
    if bytes.len() as u64 > LIMIT {
        return Err(AppError::other("kubectl 출력이 너무 커요"));
    }
    Ok(bytes)
}

fn failure(stderr: &[u8]) -> AppError {
    let text = String::from_utf8_lossy(stderr);
    if matches!(exec_failure(&text), Failure::SsoExpired) {
        return AppError::SsoExpired;
    }
    let reason: String = redact_secrets(&text).chars().take(400).collect();
    if reason.trim().is_empty() {
        AppError::other("kubectl이 실패했어요")
    } else {
        AppError::other(format!("kubectl이 실패했어요: {reason}"))
    }
}

pub async fn describe(session: &Session, kind: &KindRef, namespace: Option<&str>, name: &str) -> Result<String, AppError> {
    let args = arguments(&session.context, kind, namespace, name)?;
    let path = login_path().await;
    let executable = path.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join("kubectl")).find(|p| {
        std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }).ok_or_else(|| AppError::other("kubectl을 찾지 못했어요"))?;
    let config = crate::k8s::terminal::write_pinned(&session.kubeconfig, &session.context)?;
    let mut command = Command::new(executable);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for (key, _) in std::env::vars_os() {
        let key_text = key.to_string_lossy();
        if key_text == "KUBECONFIG" || key_text.starts_with("HELM_KUBE") || ["HELM_NAMESPACE", "HELM_DRIVER", "HELM_DRIVER_SQL_CONNECTION_STRING"].contains(&key_text.as_ref()) {
            command.env_remove(key);
        }
    }
    command.env("PATH", path).env("KUBECONFIG", config.path());
    let mut child = command.spawn().map_err(|_| AppError::other("kubectl을 실행하지 못했어요"))?;
    let stdout = child.stdout.take().ok_or_else(|| AppError::other("kubectl 출력을 열지 못했어요"))?;
    let stderr = child.stderr.take().ok_or_else(|| AppError::other("kubectl 오류 출력을 열지 못했어요"))?;
    tokio::time::timeout(Duration::from_secs(30), async {
        let (out, err, status) = tokio::try_join!(bounded(stdout), bounded(stderr), async { child.wait().await.map_err(|_| AppError::other("kubectl을 기다리지 못했어요")) })?;
        if !status.success() {
            return Err(failure(&err));
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }).await.map_err(|_| AppError::other("kubectl이 시간 안에 끝나지 않았어요"))?
}

#[cfg(test)]
mod tests;
