//! kubeconfig context로 `kube::Client`를 만든다. 인증은 context의 것(exec 플러그인, 토큰, 클라이언트 인증서)을 그대로 쓴다.
use std::time::Duration;

use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};

use super::failure::{describe, exec_failed, failure_of, Endpoint};
use super::kubeconfig::{with_path, Loaded};
use super::path::login_path;
use crate::error::AppError;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub const EXEC_TIMEOUT_REASON: &str = "30초 안에 끝나지 않았어요";

/// kubeconfig 자체의 오류 글에는 필드 이름만 있고 값(토큰, 키)은 없다. 그래서 그대로 보여 준다.
pub async fn client_for(config: &Kubeconfig, context: &str, endpoint: Endpoint) -> Result<Client, AppError> {
    client_for_with_timeout(config, context, endpoint, REQUEST_TIMEOUT).await
}

/// `Client::try_from`은 exec 플러그인을 동기로 끝까지 돌린다. 워커 스레드를 막지 않게 블로킹 스레드에서 만들고 시간 제한을 둔다.
/// 시간이 지나도 블로킹 스레드의 플러그인은 끝날 때까지 남아 있을 수 있다(결과만 버린다).
pub async fn client_for_with_timeout(config: &Kubeconfig, context: &str, endpoint: Endpoint, limit: Duration) -> Result<Client, AppError> {
    let options = KubeConfigOptions { context: Some(context.to_string()), ..Default::default() };
    let mut cfg = Config::from_custom_kubeconfig(config.clone(), &options).await.map_err(|e| AppError::other(e.to_string()))?;
    cfg.connect_timeout = Some(CONNECT_TIMEOUT);
    let build = tokio::task::spawn_blocking(move || Client::try_from(cfg));
    match tokio::time::timeout(limit, build).await {
        Err(_) => Err(AppError::other(exec_failed(EXEC_TIMEOUT_REASON))),
        Ok(Err(joined)) => Err(AppError::other(joined.to_string())),
        Ok(Ok(built)) => built.map_err(|e| describe(&failure_of(&e, "connect", "cluster"), endpoint)),
    }
}

pub async fn connect(loaded: &Loaded, context: &str, endpoint: Endpoint) -> Result<Client, AppError> {
    let config = with_path(&loaded.config, context, login_path().await);
    client_for(&config, context, endpoint).await
}

#[cfg(test)]
mod tests;
