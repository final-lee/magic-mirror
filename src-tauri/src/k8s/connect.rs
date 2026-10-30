//! kubeconfig context로 `kube::Client`를 만든다. 인증은 context의 것(exec 플러그인, 토큰, 클라이언트 인증서)을 그대로 쓴다.
use std::time::Duration;

use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};

use super::failure::{describe, failure_of, Endpoint};
use super::kubeconfig::{with_path, Loaded};
use super::path::login_path;
use crate::error::AppError;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// kubeconfig 자체의 오류 글에는 필드 이름만 있고 값(토큰, 키)은 없다. 그래서 그대로 보여 준다.
pub async fn client_for(config: &Kubeconfig, context: &str, endpoint: Endpoint) -> Result<Client, AppError> {
    let options = KubeConfigOptions { context: Some(context.to_string()), ..Default::default() };
    let mut cfg = Config::from_custom_kubeconfig(config.clone(), &options).await.map_err(|e| AppError::other(e.to_string()))?;
    cfg.connect_timeout = Some(CONNECT_TIMEOUT);
    Client::try_from(cfg).map_err(|e| describe(&failure_of(&e, "connect", "cluster"), endpoint))
}

pub async fn connect(loaded: &Loaded, context: &str, endpoint: Endpoint) -> Result<Client, AppError> {
    let config = with_path(&loaded.config, context, login_path().await);
    client_for(&config, context, endpoint).await
}

#[cfg(test)]
mod tests;
