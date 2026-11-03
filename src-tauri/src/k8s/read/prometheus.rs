//! 클러스터 내부 Prometheus를 API 서버의 서비스 프록시로 읽는다.
use k8s_openapi::api::core::v1::{Pod, Service};
use kube::{api::{Api, ListParams}, Client, ResourceExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use super::{api_for, bounded};
use crate::{error::AppError, k8s::{failure::Endpoint, logs, rows::KindRef}};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrometheusEndpoint { pub namespace: String, pub name: String, pub port: u16 }

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Series { pub name: String, pub values: Vec<(f64, f64)> }

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Graphs { pub cpu: Vec<Series>, pub memory: Vec<Series> }

fn candidates_of(services: &[Service]) -> Vec<PrometheusEndpoint> {
    let mut out = Vec::new();
    for service in services {
        let name = service.name_any();
        if !name.contains("prometheus") { continue; }
        let Some(namespace) = service.namespace() else { continue };
        for port in service.spec.iter().flat_map(|s| s.ports.iter().flatten()) {
            if (port.port == 9090 || matches!(port.name.as_deref(), Some("web" | "http"))) && port.protocol.as_deref().unwrap_or("TCP") == "TCP" {
                if let Ok(port) = u16::try_from(port.port) { if port > 0 { out.push(PrometheusEndpoint { namespace: namespace.clone(), name: name.clone(), port }); } }
            }
        }
    }
    out.sort_by(|a, b| (&a.namespace, &a.name, a.port).cmp(&(&b.namespace, &b.name, b.port)));
    out.dedup();
    out
}

pub async fn candidates(client: &Client, endpoint: Endpoint) -> Result<Vec<PrometheusEndpoint>, AppError> {
    let api: Api<Service> = Api::all(client.clone());
    let mut token: Option<String> = None;
    let mut services = Vec::new();
    loop {
        let mut lp = ListParams::default().limit(500);
        if let Some(t) = &token { lp = lp.continue_token(t); }
        let page = bounded(api.list(&lp), "list", "services", endpoint).await?;
        services.extend(page.items);
        token = page.metadata.continue_.filter(|s| !s.is_empty());
        if token.is_none() { break; }
    }
    Ok(candidates_of(&services))
}

fn valid_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 253 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
}

fn prom_string(s: &str) -> String { serde_json::to_string(s).unwrap_or_default() }
fn regex_literal(s: &str) -> String { s.chars().flat_map(|c| if ".+*?()|[]{}^$\\".contains(c) { vec!['\\', c] } else { vec![c] }).collect() }

fn query(namespace: &str, pods: &[String], pod_view: bool, cpu: bool) -> String {
    let pod_pattern = pods.iter().map(|p| regex_literal(p)).collect::<Vec<_>>().join("|");
    let labels = format!("namespace={},pod=~{},container!=\"\",container!=\"POD\"", prom_string(namespace), prom_string(&pod_pattern));
    let group = if pod_view { "container" } else { "pod" };
    if cpu { format!("sum by ({group}) (rate(container_cpu_usage_seconds_total{{{labels}}}[5m]))") }
    else { format!("sum by ({group}) (container_memory_working_set_bytes{{{labels}}})") }
}

fn parse(value: Value, label: &str) -> Result<Vec<Series>, AppError> {
    let invalid = || AppError::other("Prometheus 응답을 읽을 수 없어요");
    if value.get("status").and_then(Value::as_str) != Some("success") { return Err(invalid()); }
    if value.pointer("/data/resultType").and_then(Value::as_str) != Some("matrix") { return Err(invalid()); }
    let rows = value.pointer("/data/result").and_then(Value::as_array).ok_or_else(invalid)?;
    let mut result = Vec::new();
    for row in rows {
        let name = row.pointer(&format!("/metric/{label}")).and_then(Value::as_str).ok_or_else(invalid)?.to_owned();
        let values = row.get("values").and_then(Value::as_array).ok_or_else(invalid)?.iter().filter_map(|v| {
            let ts = v.get(0)?.as_f64()?;
            let n = v.get(1)?.as_str()?.parse::<f64>().ok()?;
            (ts.is_finite() && n.is_finite()).then_some((ts, n))
        }).collect();
        result.push(Series { name, values });
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

async fn range(client: &Client, endpoint: Endpoint, server: &PrometheusEndpoint, expr: &str, hours: u32, label: &str) -> Result<Vec<Series>, AppError> {
    if !valid_name(&server.namespace) || !valid_name(&server.name) || server.port == 0 { return Err(AppError::other("Prometheus 서비스 주소가 올바르지 않아요")); }
    let end = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| AppError::other("시계를 읽을 수 없어요"))?.as_secs();
    let start = end.saturating_sub(u64::from(hours) * 3600);
    let mut url = reqwest::Url::parse("http://localhost/").map_err(|_| AppError::other("주소를 만들 수 없어요"))?;
    url.set_path(&format!("/api/v1/namespaces/{}/services/{}:{}/proxy/api/v1/query_range", server.namespace, server.name, server.port));
    url.query_pairs_mut().append_pair("query", expr).append_pair("start", &start.to_string()).append_pair("end", &end.to_string()).append_pair("step", &(hours * 15).to_string());
    let uri = format!("{}?{}", url.path(), url.query().unwrap_or_default());
    let request = http::Request::get(uri).body(Vec::new()).map_err(|_| AppError::other("Prometheus 요청을 만들 수 없어요"))?;
    let value: Value = bounded(client.request(request), "get", "services/proxy", endpoint).await?;
    parse(value, label)
}

pub async fn graphs(client: &Client, endpoint: Endpoint, server: &PrometheusEndpoint, kind: &KindRef, namespace: &str, name: &str, hours: u32) -> Result<Graphs, AppError> {
    if !matches!(hours, 1 | 6 | 24) || !valid_name(namespace) || !valid_name(name) { return Err(AppError::other("사용량 조회 조건이 올바르지 않아요")); }
    let pod_view = kind.group.is_empty() && kind.kind == "Pod";
    let pods = if pod_view { vec![name.to_owned()] } else {
        if kind.group != "apps" || !matches!(kind.kind.as_str(), "Deployment" | "StatefulSet" | "DaemonSet") { return Err(AppError::other("이 리소스의 사용량 그래프는 지원하지 않아요")); }
        let object = bounded(api_for(client.clone(), kind, Some(namespace)).get(name), "get", &kind.plural, endpoint).await?;
        let selection = logs::selector(object.data.pointer("/spec/selector").ok_or_else(|| AppError::other("Pod 선택자가 없어요"))?, false)?;
        let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
        let mut names = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut lp = ListParams::default().labels(&selection).limit(500);
            if let Some(t) = &token { lp = lp.continue_token(t); }
            let page = bounded(api.list(&lp), "list", "pods", endpoint).await?;
            names.extend(page.items.iter().map(ResourceExt::name_any));
            token = page.metadata.continue_.filter(|s| !s.is_empty());
            if token.is_none() { break; }
        }
        names
    };
    if pods.is_empty() { return Ok(Graphs { cpu: vec![], memory: vec![] }); }
    let label = if pod_view { "container" } else { "pod" };
    let cpu_query = query(namespace, &pods, pod_view, true);
    let memory_query = query(namespace, &pods, pod_view, false);
    let (cpu, memory) = tokio::try_join!(range(client, endpoint, server, &cpu_query, hours, label), range(client, endpoint, server, &memory_query, hours, label))?;
    Ok(Graphs { cpu, memory })
}

#[cfg(test)]
mod tests;
