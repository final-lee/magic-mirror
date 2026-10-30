//! kubeconfig context로 `kube::Client`를 만든다. 인증은 context의 것(exec 플러그인, 토큰, 클라이언트 인증서)을 그대로 쓴다.
use std::time::Duration;

use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};

use super::failure::{describe, exec_failed, failure_of, short_reason, Endpoint, Failure};
use super::kubeconfig::{with_path, Loaded};
use super::path::login_path;
use crate::error::AppError;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub const EXEC_TIMEOUT_REASON: &str = "30초 안에 끝나지 않았어요";

/// kubeconfig 해석 오류의 글은 원문 조각(토큰, 키)을 싣고 있을 수 있어, 첫 줄만 가려서(`short_reason`) 보여 준다.
pub async fn client_for(config: &Kubeconfig, context: &str, endpoint: Endpoint) -> Result<Client, AppError> {
    client_for_with_timeout(config, context, endpoint, REQUEST_TIMEOUT).await
}

/// `Client::try_from`은 exec 플러그인을 동기로 끝까지 돌린다. 워커 스레드를 막지 않게 블로킹 스레드에서 만들고 시간 제한을 둔다.
/// 시간이 지나도 블로킹 스레드의 플러그인은 끝날 때까지 남아 있을 수 있다(결과만 버린다).
pub async fn client_for_with_timeout(config: &Kubeconfig, context: &str, endpoint: Endpoint, limit: Duration) -> Result<Client, AppError> {
    let command = exec_command(config, context);
    let options = KubeConfigOptions { context: Some(context.to_string()), ..Default::default() };
    let mut cfg = Config::from_custom_kubeconfig(config.clone(), &options).await.map_err(|e| AppError::other(short_reason(&e)))?;
    cfg.connect_timeout = Some(CONNECT_TIMEOUT);
    let build = tokio::task::spawn_blocking(move || Client::try_from(cfg));
    match tokio::time::timeout(limit, build).await {
        Err(_) => Err(AppError::other(exec_failed(EXEC_TIMEOUT_REASON))),
        Ok(Err(joined)) => Err(AppError::other(joined.to_string())),
        Ok(Ok(built)) => built.map_err(|e| {
            let failure = match (failure_of(&e, "connect", "cluster"), &command) {
                // spawn 오류는 명령 이름을 싣지 않으니 kubeconfig에서 찾은 이름으로 바꾼다
                (Failure::ExecMissing { .. }, Some(command)) => Failure::ExecMissing { command: command.clone() },
                (other, _) => other,
            };
            describe(&failure, endpoint)
        }),
    }
}

/// context의 사용자가 쓰는 exec 플러그인 명령. 없으면 None.
pub fn exec_command(config: &Kubeconfig, context: &str) -> Option<String> {
    let user = config.contexts.iter().find(|c| c.name == context)?.context.as_ref()?.user.as_ref()?;
    config.auth_infos.iter().find(|u| u.name == *user)?.auth_info.as_ref()?.exec.as_ref()?.command.clone()
}

pub async fn connect(loaded: &Loaded, context: &str, endpoint: Endpoint) -> Result<Client, AppError> {
    let config = with_path(&loaded.config, context, login_path().await);
    client_for(&config, context, endpoint).await
}

#[cfg(test)]
mod tests;
