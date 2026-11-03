//! helm 프로세스를 띄우는 유일한 곳. 클러스터 쓰기는 이 프로세스가 한다(`hygiene`이 `Command::new`가 이 파일 밖에 없는지 확인한다).
//! helm은 exec 플러그인과 같은 로그인 셸 PATH에서 찾고, 사용자의 셸에 남은 `HELM_KUBE*` 같은 환경 변수가 다른 클러스터로 새지 않게 치운다.
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

use crate::error::AppError;
use crate::k8s::failure::{describe, exec_failure, failure_of_chain, redact_secrets, Endpoint, Failure};
use crate::k8s::path::login_path;

pub const HELM_MISSING: &str = "helm을 찾지 못했어요. helm을 설치(brew install helm)한 뒤 앱을 다시 열어 주세요";
pub const HELM_TIMEOUT: &str = "helm이 시간 안에 끝나지 않았어요";
pub const HELM_UNSTARTABLE: &str = "helm을 실행하지 못했어요";
pub const HELM_FAILED: &str = "helm이 실패했어요";
/// 서버 dry-run(`--dry-run=server`)이 있는 가장 낮은 helm 3 버전
pub const MIN_MINOR: u32 = 13;
const VERSION_LIMIT: Duration = Duration::from_secs(5);
/// 클러스터에 닿지 않는 명령(버전, 차트 보기)의 오류 문구용 값
pub const NO_CLUSTER: Endpoint = Endpoint { public: true, private: true };
/// 오류 글에 싣는 한도
const FAILURE_MAX: usize = 400;
/// 사용자의 셸에서 물려받으면 helm이 다른 클러스터·저장소를 쓰게 되는 환경 변수
const SCRUBBED: [&str; 4] = ["KUBECONFIG", "HELM_NAMESPACE", "HELM_DRIVER", "HELM_DRIVER_SQL_CONNECTION_STRING"];

pub fn too_old(version: &str) -> String {
    format!("helm {version}은 너무 낮아요. 서버 dry-run을 쓰려면 3.{MIN_MINOR} 이상이 필요해요")
}

/// `v4.3.1+gc0d08d0` 같은 글에서 (주, 부)
pub fn parse_version(text: &str) -> Option<(u32, u32)> {
    let rest = text.trim().strip_prefix('v')?;
    let mut parts = rest.split(['.', '+', '-']);
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

/// 서버 dry-run을 아는 버전인가(3.13 이상)
pub fn supported(version: (u32, u32)) -> bool {
    version.0 > 3 || (version.0 == 3 && version.1 >= MIN_MINOR)
}

/// PATH 문자열의 폴더들에서 실행할 수 있는 `helm`을 찾는다
pub fn find(path_var: &str) -> Option<PathBuf> {
    path_var.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join("helm")).find(|p| {
        std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    })
}

pub async fn locate() -> Option<PathBuf> {
    find(login_path().await)
}

/// helm을 쓸 수 있는지. 버튼을 켜고 끄는 데 쓴다.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// 쓸 수 없을 때의 이유
    pub reason: Option<String>,
}

fn unavailable(path: Option<&Path>, version: Option<String>, reason: &str) -> Tool {
    Tool { available: false, path: path.map(|p| p.display().to_string()), version, reason: Some(reason.to_string()) }
}

pub async fn tool() -> Tool {
    tool_at(locate().await).await
}

/// 찾은 경로(없으면 None)로 helm 상태를 읽는다
pub async fn tool_at(found: Option<PathBuf>) -> Tool {
    let Some(path) = found else {
        return unavailable(None, None, HELM_MISSING);
    };
    let version = match exec_in(&path, &["version", "--template", "{{.Version}}"], &[], NO_CLUSTER, VERSION_LIMIT).await {
        Ok(text) => text.trim().to_string(),
        Err(_) => return unavailable(Some(&path), None, HELM_UNSTARTABLE),
    };
    match parse_version(&version) {
        Some(parsed) if !supported(parsed) => unavailable(Some(&path), Some(version.clone()), &too_old(&version)),
        _ => Tool { available: true, path: Some(path.display().to_string()), version: Some(version), reason: None },
    }
}

/// helm 경로. 없으면 이유를 오류로 돌려준다.
pub async fn require() -> Result<PathBuf, AppError> {
    locate().await.ok_or_else(|| AppError::other(HELM_MISSING))
}

/// 실행해서 stdout을 돌려준다. 실패하면 stderr의 첫 줄들을 오류로 쓴다.
async fn exec_in(helm: &Path, args: &[&str], env: &[(String, String)], endpoint: Endpoint, limit: Duration) -> Result<String, AppError> {
    let mut command = Command::new(helm);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for (key, _) in std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v))) {
        if key.starts_with("HELM_KUBE") || SCRUBBED.contains(&key.as_str()) {
            command.env_remove(key);
        }
    }
    command.env("PATH", login_path().await).envs(env.iter().map(|(k, v)| (k, v)));
    let output = tokio::time::timeout(limit, command.output())
        .await
        .map_err(|_| AppError::other(HELM_TIMEOUT))?
        .map_err(|_| AppError::other(HELM_UNSTARTABLE))?;
    if !output.status.success() {
        return Err(failure(&String::from_utf8_lossy(&output.stderr), endpoint));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// 인자 목록(`cli`가 만든 것)으로 helm을 실행한다. 클러스터를 바꾸는 명령도 여기로 온다. 클러스터에 닿지 않는 명령은 `endpoint`에 `NO_CLUSTER`를 쓴다.
pub async fn exec(helm: &Path, args: &[String], env: &[(String, String)], endpoint: Endpoint, limit: Duration) -> Result<String, AppError> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    exec_in(helm, &refs, env, endpoint, limit).await
}

/// helm의 stderr를 사용자 문구로: SSO 만료와 클러스터 연결 실패는 앱의 다른 곳과 같은 오류로, 나머지는 첫 줄 몇 개(토큰은 가림, 400자까지).
pub fn failure(stderr: &str, endpoint: Endpoint) -> AppError {
    if matches!(exec_failure(stderr), Failure::SsoExpired) {
        return AppError::SsoExpired;
    }
    // 차트 오류에도 "certificate"가 나올 수 있어 helm이 연결 실패라고 밝힌 때만 연결 오류로 본다
    if stderr.to_lowercase().contains("cluster unreachable") {
        if let Some(found) = failure_of_chain(stderr) {
            return describe(&found, endpoint);
        }
        return describe(&Failure::Unreachable, endpoint);
    }
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("level=") && !l.starts_with("WARNING")).take(3).collect();
    if lines.is_empty() {
        return AppError::other(HELM_FAILED);
    }
    let text: String = redact_secrets(&lines.join(" ")).chars().take(FAILURE_MAX).collect();
    AppError::other(format!("{HELM_FAILED}: {text}"))
}

#[cfg(test)]
mod tests;
