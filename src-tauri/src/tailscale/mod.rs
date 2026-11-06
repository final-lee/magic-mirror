mod api;
pub mod changes;
pub mod devices;
pub mod dns;
pub mod settings;
pub mod users;
pub mod policy;
pub mod keys;
pub mod logs;
pub mod services;
pub mod org;
pub mod integrations;
pub mod local;
mod cli;
mod diagnose;
mod parse;
mod node;

use std::net::IpAddr;
use std::time::Duration;
use crate::error::AppError;
use diagnose::{Inputs, Tcp};
pub use diagnose::Diagnosis;
pub use node::TsNode;
pub use api::{ApiConnection, ApiStatus, Credential, TailscaleState};

pub async fn node() -> Result<TsNode, AppError> {
    let Some(path) = cli::locate().await else { return Ok(TsNode::default()); };
    let status = cli::status_json(&path).await.map_err(AppError::other)?;
    let status = serde_json::from_str(&status).map_err(|e| AppError::other(format!("Tailscale 상태를 해석하지 못했어요: {e}")))?;
    let prefs = cli::prefs_json(&path).await.ok().and_then(|s| serde_json::from_str(&s).ok());
    Ok(node::shape(path.to_string_lossy().into_owned(), &status, prefs.as_ref()))
}

fn target(text: &str) -> Result<(String, u16), AppError> {
    let value = if text.contains("://") { text.to_string() } else { format!("https://{text}") };
    let url = reqwest::Url::parse(&value).map_err(|e| AppError::other(format!("주소를 읽지 못했어요: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") { return Err(AppError::other("HTTP 또는 HTTPS 주소가 필요해요")); }
    let host = url.host_str().ok_or_else(|| AppError::other("호스트가 없는 주소예요"))?.trim_matches(['[', ']']).to_string();
    let port = url.port_or_known_default().ok_or_else(|| AppError::other("포트를 알 수 없어요"))?;
    Ok((host, port))
}
async fn resolve(host: &str, port: u16) -> Result<IpAddr, String> {
    if let Ok(ip) = host.parse() { return Ok(ip); }
    let addresses = tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((host, port))).await
        .map_err(|_| "DNS 조회 시간이 초과됐어요".to_string())?
        .map_err(|e| format!("DNS 조회에 실패했어요: {e}"))?;
    let mut first = None;
    for addr in addresses { if addr.is_ipv4() { return Ok(addr.ip()); } first.get_or_insert(addr.ip()); }
    first.ok_or_else(|| "DNS 응답에 주소가 없어요".to_string())
}
async fn tcp(ip: IpAddr, port: u16) -> Tcp {
    match tokio::time::timeout(Duration::from_secs(5), tokio::net::TcpStream::connect((ip, port))).await {
        Ok(Ok(_)) => Tcp::Connected,
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => Tcp::Refused,
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::TimedOut => Tcp::Timeout,
        Ok(Err(e)) => Tcp::Error(e.to_string()),
        Err(_) => Tcp::Timeout,
    }
}
pub async fn diagnose(url: String) -> Result<Diagnosis, AppError> {
    let (host, port) = target(&url)?;
    let path = cli::locate().await;
    let mut inputs = Inputs { host, port, cli: path.is_some(), status: Err(String::new()), prefs: Err(String::new()), address: Err(String::new()), ping: Err(String::new()), tcp: None, udp: None };
    let Some(path) = path else { return Ok(diagnose::decide(inputs)); };
    inputs.status = match cli::status_json(&path).await {
        Ok(json) => serde_json::from_str(&json).map_err(|e| format!("Tailscale 상태를 해석하지 못했어요: {e}")),
        Err(e) => Err(e),
    };
    if !inputs.status.as_ref().is_ok_and(|s| s.backend_state == "Running") { return Ok(diagnose::decide(inputs)); }
    inputs.address = resolve(&inputs.host, port).await;
    inputs.prefs = match cli::prefs_json(&path).await {
        Ok(json) => serde_json::from_str(&json).map_err(|e| format!("Tailscale 설정을 해석하지 못했어요: {e}")),
        Err(e) => Err(e),
    };
    if let Ok(ip) = inputs.address {
        let has_peer = inputs.status.as_ref().ok().is_some_and(|s| diagnose::route(s, ip).1.is_some());
        let addr = ip.to_string();
        let ping = async { if has_peer { cli::ping(&path, &addr).await } else { Err(String::new()) } };
        let netcheck = async { cli::netcheck_json(&path).await.ok().and_then(|s| serde_json::from_str::<parse::Netcheck>(&s).ok()).map(|n| n.udp) };
        let (ping, tcp, udp) = tokio::join!(ping, tcp(ip, port), netcheck);
        inputs.ping = ping;
        inputs.tcp = Some(tcp);
        inputs.udp = udp;
    }
    Ok(diagnose::decide(inputs))
}
pub async fn accept_routes(enabled: bool) -> Result<(), AppError> {
    let path = cli::locate().await.ok_or_else(|| AppError::other("Tailscale CLI를 찾지 못했어요"))?;
    cli::set_accept_routes(&path, enabled).await.map_err(AppError::other)
}

pub async fn diagnostic_tool(kind: &str, value: &str, record_type: &str) -> Result<String, AppError> {
    let path = cli::locate().await.ok_or_else(|| AppError::other("Tailscale CLI를 찾지 못했어요"))?;
    let result = match kind {
        "dns-status" => cli::dns_status(&path).await,
        "dns-query" if !value.is_empty() && !value.starts_with('-') && !record_type.starts_with('-') =>
            cli::dns_query(&path, value, (!record_type.is_empty()).then_some(record_type)).await,
        "whois" if value.parse::<IpAddr>().is_ok() => cli::whois(&path, value).await,
        "whoami" => cli::whoami(&path).await,
        _ => return Err(AppError::other("올바른 조회 대상이 필요해요")),
    };
    result.map_err(AppError::other)
}

#[cfg(test)]
mod hygiene;
#[cfg(test)]
mod cli_tests;
#[cfg(test)]
mod tests;
