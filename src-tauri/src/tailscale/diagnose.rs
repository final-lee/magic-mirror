//! 연결 진단의 판단. 입력(파싱한 CLI 출력, 푼 주소, TCP 결과)만 보고 점검 목록과 결론을 만든다. I/O는 `mod.rs`가 한다.
use std::net::IpAddr;

use serde::Serialize;

use super::parse::{self, Peer, Ping, Prefs, Status};

/// 점검 순서. 응답의 `checks`는 늘 이 순서로 9개다.
const IDS: [&str; 9] = ["cli", "backend", "dns", "route", "acceptRoutes", "peer", "ping", "tcp", "udp"];
const CLI: usize = 0;
const BACKEND: usize = 1;
const DNS: usize = 2;
const ROUTE: usize = 3;
const ACCEPT: usize = 4;
const PEER: usize = 5;
const PING: usize = 6;
const TCP: usize = 7;
const UDP: usize = 8;

const SKIPPED: &str = "점검을 건너뛰었어요";
const CONNECTED_NOW: &str = "지금은 연결돼요. 다시 시도해 보세요";
const PATH_OK: &str = "Tailscale 경로는 정상이에요";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: &'static str,
    pub status: &'static str,
    pub summary: String,
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    pub host: String,
    pub port: u16,
    pub address: Option<String>,
    pub tailnet: Option<String>,
    pub checks: Vec<Check>,
    pub verdict: String,
    pub fix: Option<&'static str>,
}

#[derive(Debug)]
pub enum Tcp {
    Connected,
    Refused,
    Timeout,
    Error(String),
}

/// 판단에 쓰는 입력. 앞 단계가 실패해 얻지 못한 값은 `Err`/`None`이고 그때 뒤 점검은 건너뛴다.
pub struct Inputs {
    pub host: String,
    pub port: u16,
    pub cli: bool,
    pub status: Result<Status, String>,
    pub prefs: Result<Prefs, String>,
    pub address: Result<IpAddr, String>,
    pub ping: Result<String, String>,
    pub tcp: Option<Tcp>,
    pub udp: Option<bool>,
}

struct Outcome {
    checks: Vec<Check>,
    address: Option<String>,
    tailnet: Option<String>,
    fix: Option<&'static str>,
}

impl Outcome {
    fn set(&mut self, index: usize, status: &'static str, summary: impl Into<String>, detail: Option<String>) {
        self.checks[index] = Check { id: IDS[index], status, summary: summary.into(), detail };
    }
}

/// `cidr`이 `ip`를 담으면 접두사 길이
fn contains(cidr: &str, ip: IpAddr) -> Option<u32> {
    let (net, prefix) = cidr.split_once('/')?;
    let net: IpAddr = net.parse().ok()?;
    let p: u32 = prefix.parse().ok()?;
    match (net, ip) {
        (IpAddr::V4(a), IpAddr::V4(b)) if p <= 32 => (p == 0 || u32::from(a) >> (32 - p) == u32::from(b) >> (32 - p)).then_some(p),
        (IpAddr::V6(a), IpAddr::V6(b)) if p <= 128 => (p == 0 || u128::from(a) >> (128 - p) == u128::from(b) >> (128 - p)).then_some(p),
        _ => None,
    }
}

/// (Tailscale 주소인가, 그 주소를 맡은 피어). Tailscale 주소면 그 주소를 가진 기기, 아니면 `PrimaryRoutes`에서 가장 긴 접두사의 라우터.
pub fn route(status: &Status, ip: IpAddr) -> (bool, Option<&Peer>) {
    let tailscale = contains("100.64.0.0/10", ip).is_some() || contains("fd7a:115c:a1e0::/48", ip).is_some();
    let peers = status.peers.iter().flat_map(|p| p.values());
    if tailscale {
        let owns = |p: &&Peer| p.tailscale_ips.iter().flatten().any(|s| s.parse::<IpAddr>() == Ok(ip));
        return (true, peers.filter(owns).min_by_key(|p| &p.host_name));
    }
    let mut best: Option<(u32, &Peer)> = None;
    for peer in peers {
        for prefix in peer.primary_routes.iter().flatten().filter_map(|cidr| contains(cidr, ip)) {
            // 같은 길이면 이름 순으로 골라 결과가 HashMap 순서에 흔들리지 않게 한다
            if best.is_none_or(|(n, p)| prefix > n || (prefix == n && peer.host_name < p.host_name)) {
                best = Some((prefix, peer));
            }
        }
    }
    (false, best.map(|(_, p)| p))
}

fn peer_name(peer: &Peer) -> &str {
    if peer.host_name.is_empty() {
        peer.dns_name.trim_end_matches('.')
    } else {
        &peer.host_name
    }
}

pub fn decide(input: Inputs) -> Diagnosis {
    let checks = IDS.iter().map(|id| Check { id, status: "skip", summary: SKIPPED.into(), detail: None }).collect();
    let mut out = Outcome { checks, address: None, tailnet: None, fix: None };
    walk(&input, &mut out);
    let verdict = verdict(&out.checks);
    Diagnosis { host: input.host, port: input.port, address: out.address, tailnet: out.tailnet, checks: out.checks, verdict, fix: out.fix }
}

/// 첫 실패. 실패가 없고 TCP가 지금 붙으면 주의가 있어도 "지금은 연결돼요"(주의는 목록에 남는다), 아니면 첫 주의, 모두 정상이면 경로 정상.
fn verdict(checks: &[Check]) -> String {
    let first = |status: &str| checks.iter().find(|c| c.status == status);
    if let Some(failed) = first("fail") {
        return failed.summary.clone();
    }
    if checks[TCP].status == "ok" {
        return CONNECTED_NOW.into();
    }
    first("warn").map_or_else(|| PATH_OK.into(), |c| c.summary.clone())
}

/// 점검을 순서대로 채운다. 뒤 점검이 뜻을 잃는 실패에서 돌아가고, 남은 점검은 건너뜀으로 남는다.
fn walk(input: &Inputs, out: &mut Outcome) {
    if !input.cli {
        out.set(CLI, "fail", "Tailscale CLI를 찾지 못했어요", Some("Tailscale 앱을 설치했는지 확인해 주세요".into()));
        return;
    }
    out.set(CLI, "ok", "Tailscale CLI를 찾았어요", None);

    let status = match &input.status {
        Ok(status) => status,
        Err(e) => {
            out.set(BACKEND, "fail", "Tailscale 상태를 읽지 못했어요", Some(e.clone()));
            return;
        }
    };
    out.tailnet = status.current_tailnet.as_ref().map(|t| t.name.clone());
    if !backend(status, out) {
        return;
    }

    let ip = match &input.address {
        Ok(ip) => *ip,
        Err(e) => {
            let summary = if magic_dns_off(input, status) {
                "MagicDNS 이름을 찾지 못했어요. Tailscale DNS 받기가 꺼져 있어요"
            } else {
                "호스트 주소를 찾지 못했어요"
            };
            out.set(DNS, "fail", summary, Some(e.clone()));
            return;
        }
    };
    out.address = Some(ip.to_string());
    out.set(DNS, "ok", format!("주소를 찾았어요: {ip}"), None);

    match route(status, ip) {
        (tailscale, Some(peer)) => {
            let name = peer_name(peer);
            if tailscale {
                out.set(ROUTE, "ok", format!("Tailscale 기기 {name}에 연결해요"), None);
            } else {
                out.set(ROUTE, "ok", format!("서브넷 라우터 {name}를 거쳐요"), None);
                accept_routes(&input.prefs, out);
            }
            if peer.online {
                out.set(PEER, "ok", format!("{name} 기기가 온라인이에요"), None);
            } else {
                out.set(PEER, "fail", format!("{name} 기기가 오프라인이에요"), peer.last_seen.as_ref().map(|s| format!("마지막 접속: {s}")));
            }
            ping(&input.ping, out);
        }
        (true, None) => out.set(ROUTE, "fail", "이 테일넷에 그 주소의 기기가 없어요", None),
        (false, None) => match &input.prefs {
            Ok(p) if !p.exit_node.is_empty() => out.set(ROUTE, "ok", "exit node를 거쳐요", Some(p.exit_node.clone())),
            Ok(_) => out.set(ROUTE, "warn", "Tailscale을 거치지 않는 주소예요", Some("이 주소의 경로를 광고하고 승인받은 기기가 없어요".into())),
            Err(e) => out.set(ROUTE, "warn", "Tailscale 경로를 확인하지 못했어요", Some(e.clone())),
        },
    }

    if let Some(tcp) = &input.tcp {
        match tcp {
            Tcp::Connected => out.set(TCP, "ok", "TCP 연결에 성공했어요", None),
            Tcp::Refused => out.set(TCP, "fail", "TCP 연결이 거부됐어요", Some("서비스가 포트를 열었는지 확인해 주세요".into())),
            Tcp::Timeout => out.set(TCP, "fail", "TCP 연결 시간이 초과됐어요", Some("Tailscale ACL, 보안 그룹 또는 NACL이 막고 있을 수 있어요".into())),
            Tcp::Error(e) => out.set(TCP, "fail", "TCP 연결에 실패했어요", Some(e.clone())),
        }
    }
    match input.udp {
        Some(true) => out.set(UDP, "ok", "UDP를 사용할 수 있어요", None),
        Some(false) => out.set(UDP, "warn", "UDP가 막혀 릴레이로만 연결돼요", None),
        None => {}
    }
}

/// 백엔드 상태를 싣고, 실행 중이어서 뒤 점검을 이어 갈 수 있으면 true
fn backend(status: &Status, out: &mut Outcome) -> bool {
    let state = status.backend_state.as_str();
    let health = status.health.as_ref().filter(|h| !h.is_empty());
    let (level, summary) = match state {
        "Running" if health.is_some() => ("warn", "Tailscale에 상태 경고가 있어요"),
        "Running" => ("ok", "Tailscale이 실행 중이에요"),
        "Starting" => ("warn", "Tailscale이 시작 중이에요"),
        "NeedsLogin" => ("fail", "Tailscale에 로그인해야 해요"),
        "Stopped" => ("fail", "Tailscale이 꺼져 있어요"),
        "NeedsMachineAuth" => ("fail", "Tailscale 관리자 승인을 기다리고 있어요"),
        _ => ("fail", "Tailscale이 실행 중이 아니에요"),
    };
    let detail = if state == "Running" { health.map(|h| h.join("\n")) } else { Some(state.to_string()) };
    out.set(BACKEND, level, summary, detail);
    state == "Running"
}

/// 호스트가 이 테일넷의 MagicDNS 이름인데 DNS 받기가 꺼져 있는가
fn magic_dns_off(input: &Inputs, status: &Status) -> bool {
    let Some(tailnet) = &status.current_tailnet else { return false };
    let host = input.host.trim_end_matches('.').to_ascii_lowercase();
    let suffix = tailnet.magic_dns_suffix.trim_matches('.').to_ascii_lowercase();
    let in_tailnet = !suffix.is_empty() && (host == suffix || host.ends_with(&format!(".{suffix}")));
    in_tailnet && input.prefs.as_ref().is_ok_and(|p| !p.accept_dns)
}

fn accept_routes(prefs: &Result<Prefs, String>, out: &mut Outcome) {
    match prefs {
        Ok(p) if p.accept_routes => out.set(ACCEPT, "ok", "서브넷 경로 받기가 켜져 있어요", None),
        Ok(_) => {
            out.set(ACCEPT, "fail", "서브넷 경로 받기가 꺼져 있어요", None);
            out.fix = Some("acceptRoutes");
        }
        Err(e) => out.set(ACCEPT, "warn", "경로 받기 설정을 읽지 못했어요", Some(e.clone())),
    }
}

fn ping(result: &Result<String, String>, out: &mut Outcome) {
    let text = match result {
        Ok(text) => text,
        Err(e) => {
            out.set(PING, "fail", "Tailscale ping을 실행하지 못했어요", Some(e.clone()));
            return;
        }
    };
    match parse::ping(text) {
        Ping::Pong { via, latency } if via.starts_with("DERP(") => out.set(PING, "ok", format!("릴레이 {via}로 응답했어요 ({latency})"), None),
        Ping::Pong { via, latency } => out.set(PING, "ok", format!("직접 연결로 응답했어요 ({latency})"), Some(via)),
        Ping::NoPeer => out.set(PING, "fail", "응답할 Tailscale 기기를 찾지 못했어요", None),
        Ping::Timeout => out.set(PING, "fail", "Tailscale ping 응답 시간이 초과됐어요", None),
        Ping::Other => out.set(PING, "fail", "Tailscale ping에 응답이 없어요", Some(text.clone())),
    }
}

#[cfg(test)]
mod tests;
