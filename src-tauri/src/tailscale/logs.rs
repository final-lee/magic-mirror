//! T6 로그: 설정 감사 로그, 네트워크 흐름 로그(켜져 있을 때만), 로그 스트리밍 상태, 웹훅 목록.
//! 구역마다 따로 읽어서 한 구역의 권한 오류가 다른 구역을 비우지 않는다.
use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;

use super::api::{Request, TailscaleState, RESPONSE_ERROR};
use crate::error::AppError;

#[cfg(test)]
mod tests;

/// 감사 로그를 고를 수 있는 기간(일).
pub const AUDIT_DAYS: [u32; 3] = [1, 7, 30];
/// 화면에 싣는 감사 이벤트의 최대 수(최신순).
const MAX_EVENTS: usize = 1000;
/// 화면에 싣는 흐름 행의 최대 수(바이트 많은 순).
const MAX_FLOWS: usize = 200;
/// `old`·`new` 값 미리보기의 최대 글자 수.
const MAX_VALUE_CHARS: usize = 400;

fn rfc3339(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default()
}

/// 응답의 목록. 비어 있으면 API가 `null`을 돌려준다(웹훅이 하나도 없을 때 `{"webhooks":null}`, 2026-11-05 확인).
fn items<'a>(value: &'a Value, key: &str) -> Result<&'a [Value], AppError> {
    match value.get(key) {
        Some(Value::Array(list)) => Ok(list),
        Some(Value::Null) => Ok(&[]),
        _ => Err(AppError::other(RESPONSE_ERROR)),
    }
}

// ---- 설정 감사 로그 ----

/// 감사 로그의 행위자 또는 대상.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditParty {
    pub name: String,
    pub kind: String,
    /// 대상에서 바뀐 속성(예: `ACL`, `KEY_EXPIRY`). 행위자에는 없다.
    pub property: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub time: String,
    pub actor: AuditParty,
    pub action: String,
    pub target: AuditParty,
    pub origin: String,
    pub error: Option<String>,
    pub details: Option<String>,
    pub old: Option<String>,
    pub new: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TsAuditLog {
    pub start: String,
    pub end: String,
    /// 최신순. 많으면 최신 `MAX_EVENTS`개만 싣는다.
    pub events: Vec<AuditEvent>,
    /// 기간 안의 전체 이벤트 수.
    pub total: usize,
}

/// 값을 한 줄 글로. 긴 값(ACL 전체 등)은 잘라서 `…`를 붙인다.
fn preview(value: &Value) -> Option<String> {
    let text = match value {
        Value::Null => return None,
        Value::String(s) if s.is_empty() => return None,
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    Some(match text.char_indices().nth(MAX_VALUE_CHARS) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text,
    })
}

fn shape_event(log: &Value) -> Option<AuditEvent> {
    let time = text(log, "eventTime")?;
    let actor = log.get("actor").unwrap_or(&Value::Null);
    let target = log.get("target").unwrap_or(&Value::Null);
    let party = |value: &Value, names: &[&str]| AuditParty {
        name: names.iter().find_map(|key| text(value, key)).unwrap_or_default(),
        kind: text(value, "type").unwrap_or_default(),
        property: text(value, "property"),
    };
    Some(AuditEvent {
        time,
        actor: party(actor, &["loginName", "displayName", "id"]),
        action: text(log, "action").unwrap_or_default(),
        target: party(target, &["name", "id"]),
        origin: text(log, "origin").unwrap_or_default(),
        error: text(log, "error"),
        details: text(log, "actionDetails"),
        old: log.get("old").and_then(preview),
        new: log.get("new").and_then(preview),
    })
}

/// 응답의 `logs`를 최신순으로 읽는다.
pub fn shape_audit(value: &Value, start: &str, end: &str) -> Result<TsAuditLog, AppError> {
    let mut events: Vec<AuditEvent> = items(value, "logs")?.iter().filter_map(shape_event).collect();
    // RFC 3339 UTC 문자열은 길이가 달라도(소수 초) 시각순과 사전순이 같지 않으므로 시각으로 견준다.
    events.sort_by_key(|event| std::cmp::Reverse(DateTime::parse_from_rfc3339(&event.time).map(|t| t.timestamp_nanos_opt().unwrap_or(0)).unwrap_or(0)));
    let total = events.len();
    events.truncate(MAX_EVENTS);
    Ok(TsAuditLog { start: start.to_owned(), end: end.to_owned(), events, total })
}

/// `days`일 전부터 지금까지의 감사 로그. 기간은 [`AUDIT_DAYS`] 중 하나.
pub async fn audit(state: &TailscaleState, tailnet: &str, days: u32, now: DateTime<Utc>) -> Result<TsAuditLog, AppError> {
    if !AUDIT_DAYS.contains(&days) {
        return Err(AppError::other("기간은 1일, 7일, 30일 중에서 골라 주세요"));
    }
    let (start, end) = (rfc3339(now - Duration::days(days.into())), rfc3339(now));
    let path = format!("/tailnet/-/logging/configuration?start={start}&end={end}");
    shape_audit(&state.get_json(tailnet, &path).await?, &start, &end)
}

// ---- 네트워크 흐름 로그 ----

/// 같은 노드·종류·프로토콜·출발 IP·도착 주소로 묶은 흐름.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowRow {
    pub node_id: String,
    pub node_name: Option<String>,
    /// `tailnet`(테일넷 안), `subnet`(서브넷 라우터), `exit`(exit node).
    pub class: &'static str,
    pub proto: String,
    pub src: String,
    pub src_name: Option<String>,
    pub dst: String,
    pub dst_name: Option<String>,
    pub tx_bytes: u64,
    pub rx_bytes: u64,
    pub tx_pkts: u64,
    pub rx_pkts: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TsFlowLogs {
    /// 테일넷에서 흐름 로그를 켰는가. 꺼져 있으면 로그를 읽지 않고 `flows`는 비어 있다.
    pub enabled: bool,
    pub start: String,
    pub end: String,
    /// 바이트 많은 순.
    pub flows: Vec<FlowRow>,
    /// 묶은 뒤의 전체 행 수.
    pub total: usize,
}

/// 기기 이름 조회표: 노드 ID와 IP → 기기 이름.
#[derive(Debug, Default)]
struct Names {
    by_node: HashMap<String, String>,
    by_ip: HashMap<String, String>,
}

fn names_of(devices: &Value) -> Names {
    let mut names = Names::default();
    for device in devices.get("devices").and_then(Value::as_array).into_iter().flatten() {
        let name = text(device, "hostname").or_else(|| text(device, "name").map(|n| n.split('.').next().unwrap_or_default().to_owned()));
        let Some(name) = name else { continue };
        if let Some(id) = text(device, "nodeId") {
            names.by_node.insert(id, name.clone());
        }
        for ip in strings(device.get("addresses")) {
            names.by_ip.insert(ip, name.clone());
        }
    }
    names
}

/// `ip:port` 또는 `[ipv6]:port`에서 IP.
fn ip_of(addr: &str) -> &str {
    match addr.rsplit_once(':') {
        Some((ip, port)) if port.chars().all(|c| c.is_ascii_digit()) => ip.trim_start_matches('[').trim_end_matches(']'),
        _ => addr,
    }
}

const CLASSES: [(&str, &str); 3] = [("virtualTraffic", "tailnet"), ("subnetTraffic", "subnet"), ("exitTraffic", "exit")];

/// 흐름 로그를 묶는다. 출발 포트는 연결마다 바뀌어서 버리고, 물리 경로 트래픽(`physicalTraffic`)은 담지 않는다.
fn shape_flows(value: &Value, names: &Names, enabled: bool, start: &str, end: &str) -> Result<TsFlowLogs, AppError> {
    type Key = (String, &'static str, String, String, String);
    let mut sums: BTreeMap<Key, [u64; 4]> = BTreeMap::new();
    for log in items(value, "logs")? {
        let node = text(log, "nodeId").unwrap_or_default();
        for (field, class) in CLASSES {
            for flow in log.get(field).and_then(Value::as_array).into_iter().flatten() {
                let key = (node.clone(), class, text(flow, "proto").unwrap_or_default(), ip_of(&text(flow, "src").unwrap_or_default()).to_owned(), text(flow, "dst").unwrap_or_default());
                let sum = sums.entry(key).or_default();
                for (slot, name) in sum.iter_mut().zip(["txBytes", "rxBytes", "txPkts", "rxPkts"]) {
                    *slot += flow.get(name).and_then(Value::as_u64).unwrap_or(0);
                }
            }
        }
    }
    let mut flows: Vec<FlowRow> = sums
        .into_iter()
        .map(|((node_id, class, proto, src, dst), [tx_bytes, rx_bytes, tx_pkts, rx_pkts])| FlowRow {
            node_name: names.by_node.get(&node_id).cloned(),
            src_name: names.by_ip.get(&src).cloned(),
            dst_name: names.by_ip.get(ip_of(&dst)).cloned(),
            node_id,
            class,
            proto,
            src,
            dst,
            tx_bytes,
            rx_bytes,
            tx_pkts,
            rx_pkts,
        })
        .collect();
    flows.sort_by_key(|flow| std::cmp::Reverse(flow.tx_bytes + flow.rx_bytes));
    let total = flows.len();
    flows.truncate(MAX_FLOWS);
    Ok(TsFlowLogs { enabled, start: start.to_owned(), end: end.to_owned(), flows, total })
}

/// 설정의 `networkFlowLoggingOn`이 켜져 있을 때만 최근 1시간의 흐름 로그를 읽는다. 기기 이름은 읽을 수 있으면 붙인다.
pub async fn flows(state: &TailscaleState, tailnet: &str, now: DateTime<Utc>) -> Result<TsFlowLogs, AppError> {
    let (start, end) = (rfc3339(now - Duration::hours(1)), rfc3339(now));
    let settings = state.get_json(tailnet, "/tailnet/-/settings").await?;
    if settings.get("networkFlowLoggingOn").and_then(Value::as_bool) != Some(true) {
        return Ok(TsFlowLogs { enabled: false, start, end, flows: Vec::new(), total: 0 });
    }
    let path = format!("/tailnet/-/logging/network?start={start}&end={end}");
    let logs = state.get_json(tailnet, &path).await?;
    let names = state.get_json(tailnet, "/tailnet/-/devices").await.map(|devices| names_of(&devices)).unwrap_or_default();
    shape_flows(&logs, &names, true, &start, &end)
}

// ---- 로그 스트리밍 ----

/// 스트리밍이 마지막으로 보고한 상태.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStatus {
    pub last_activity: Option<String>,
    pub last_error: Option<String>,
    pub entries_sent: u64,
    pub bytes_sent: u64,
    pub requests: u64,
    pub failed_requests: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TsLogStream {
    pub log_type: String,
    /// 아직 스트리밍을 설정하지 않았다(설정 조회가 404).
    pub configured: bool,
    pub destination_type: Option<String>,
    /// 받는 주소. 인증 정보와 쿼리는 뺀다.
    pub url: Option<String>,
    pub user: Option<String>,
    pub upload_period_minutes: Option<u64>,
    pub compression: Option<String>,
    pub status: Option<StreamStatus>,
}

/// 주소에서 사용자 정보와 쿼리, 조각을 뺀다. 읽을 수 없으면 `None`.
fn scrub_url(url: &str) -> Option<String> {
    let mut parsed = reqwest::Url::parse(url).ok()?;
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    parsed.set_query(None);
    parsed.set_fragment(None);
    Some(parsed.to_string())
}

fn shape_stream(log_type: &str, config: Option<&Value>, status: Option<&Value>) -> TsLogStream {
    let Some(config) = config else {
        return TsLogStream { log_type: log_type.to_owned(), configured: false, destination_type: None, url: None, user: None, upload_period_minutes: None, compression: None, status: None };
    };
    let number = |value: &Value, key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    TsLogStream {
        log_type: log_type.to_owned(),
        configured: true,
        destination_type: text(config, "destinationType"),
        url: text(config, "url").and_then(|url| scrub_url(&url)),
        user: text(config, "user"),
        upload_period_minutes: config.get("uploadPeriodMinutes").and_then(Value::as_u64),
        compression: text(config, "compressionFormat"),
        status: status.map(|status| StreamStatus {
            last_activity: text(status, "lastActivity").filter(|time| !time.starts_with("0001-")),
            last_error: text(status, "lastError"),
            entries_sent: number(status, "numEntriesSent"),
            bytes_sent: number(status, "numBytesSent"),
            requests: number(status, "numTotalRequests"),
            failed_requests: number(status, "numFailedRequests"),
        }),
    }
}

/// `configuration` 또는 `network` 로그의 스트리밍 설정과 상태. 설정이 없으면(404) `configured: false`.
pub async fn stream(state: &TailscaleState, tailnet: &str, log_type: &str) -> Result<TsLogStream, AppError> {
    if !matches!(log_type, "configuration" | "network") {
        return Err(AppError::other("로그 종류는 configuration이나 network여야 해요"));
    }
    let config = state.request(tailnet, Request::get(&format!("/tailnet/-/logging/{log_type}/stream")).allow_not_found()).await?;
    if config.status == 404 {
        return Ok(shape_stream(log_type, None, None));
    }
    let config = config.json()?;
    let status = state.request(tailnet, Request::get(&format!("/tailnet/-/logging/{log_type}/stream/status")).allow_not_found()).await?;
    let status = if status.status == 404 { None } else { Some(status.json()?) };
    Ok(shape_stream(log_type, Some(&config), status.as_ref()))
}

// ---- 웹훅 ----

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TsWebhook {
    pub id: String,
    /// 받는 곳. 경로에 비밀이 들어 있는 주소(Slack 등)가 많아서 호스트까지만 싣는다.
    pub endpoint: String,
    pub provider: String,
    pub creator: Option<String>,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub subscriptions: Vec<String>,
}

/// `https://hooks.slack.com/services/T0/B0/xyz` → `https://hooks.slack.com/…`
fn mask_endpoint(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(parsed) if parsed.host_str().is_some() => {
            let port = parsed.port().map(|port| format!(":{port}")).unwrap_or_default();
            let rest = if parsed.path() == "/" && parsed.query().is_none() { "" } else { "/…" };
            format!("{}://{}{port}{rest}", parsed.scheme(), parsed.host_str().unwrap_or_default())
        }
        _ => "(읽을 수 없는 주소)".to_owned(),
    }
}

pub fn shape_webhooks(value: &Value) -> Result<Vec<TsWebhook>, AppError> {
    Ok(items(value, "webhooks")?
        .iter()
        .filter_map(|hook| {
            Some(TsWebhook {
                id: text(hook, "endpointId")?,
                endpoint: mask_endpoint(&text(hook, "endpointUrl").unwrap_or_default()),
                provider: text(hook, "providerType").unwrap_or_default(),
                creator: text(hook, "creatorLoginName"),
                created: text(hook, "created"),
                modified: text(hook, "lastModified"),
                subscriptions: strings(hook.get("subscriptions")),
            })
        })
        .collect())
}

pub async fn webhooks(state: &TailscaleState, tailnet: &str) -> Result<Vec<TsWebhook>, AppError> {
    shape_webhooks(&state.get_json(tailnet, "/tailnet/-/webhooks").await?)
}
