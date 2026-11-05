use std::collections::HashMap;
use serde::Deserialize;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Status {
    #[serde(default)] pub backend_state: String,
    pub health: Option<Vec<String>>,
    pub current_tailnet: Option<Tailnet>,
    #[serde(default, rename = "Peer")] pub peers: Option<HashMap<String, Peer>>,
}
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Tailnet { pub name: String, #[serde(rename = "MagicDNSSuffix")] pub magic_dns_suffix: String }
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Peer {
    #[serde(default)] pub host_name: String,
    #[serde(default, rename = "DNSName")] pub dns_name: String,
    #[serde(default)] pub online: bool,
    #[serde(rename = "TailscaleIPs")] pub tailscale_ips: Option<Vec<String>>,
    pub primary_routes: Option<Vec<String>>,
    pub last_seen: Option<String>,
}
#[derive(Debug, Default, Deserialize)]
pub struct Prefs {
    #[serde(rename = "accept-routes")] pub accept_routes: bool,
    #[serde(rename = "accept-dns")] pub accept_dns: bool,
    #[serde(rename = "exit-node")] pub exit_node: String,
}
#[derive(Debug, Deserialize)]
pub struct Netcheck { #[serde(rename = "UDP")] pub udp: bool }

#[derive(Debug, PartialEq)]
pub enum Ping { Pong { via: String, latency: String }, NoPeer, Timeout, Other }
pub fn ping(text: &str) -> Ping {
    for line in text.lines() {
        if line.contains("pong from ") {
            if let Some((_, rest)) = line.split_once(" via ") {
                if let Some((via, latency)) = rest.split_once(" in ") {
                    return Ping::Pong { via: via.trim().to_string(), latency: latency.trim().to_string() };
                }
            }
        }
    }
    if text.contains("no matching peer") { Ping::NoPeer }
    else if text.contains("timed out") || text.contains("no reply") { Ping::Timeout }
    else { Ping::Other }
}

#[cfg(test)]
mod tests;
