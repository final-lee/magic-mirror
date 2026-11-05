//! 대상 클러스터(kubeconfig context)에 붙는 읽기 전용 호출: ArgoCD 컨트롤러 지표(service proxy)와 앱 Pod 사용량(metrics-server).
use std::collections::HashMap;
use std::path::Path;

use kube::Client;

use super::prom::{self, Sample, Series, Tracker};
use crate::argowf::auth;
use crate::error::AppError;
use crate::k8s::connect::{self, REQUEST_TIMEOUT};
use crate::k8s::failure::{describe, failure_of, Endpoint};

pub const ENDPOINT: Endpoint = Endpoint { public: true, private: true };

/// context마다 클라이언트를 한 번만 만들고(exec 플러그인이 느리다), 지표 읽기의 앞 값(`Tracker`)을 context·네임스페이스별로 쥔다.
#[derive(Default)]
pub struct ArgoKube {
    clients: tokio::sync::Mutex<HashMap<String, Client>>,
    trackers: std::sync::Mutex<HashMap<String, Tracker>>,
}

impl ArgoKube {
    /// kubeconfig가 바뀌면 다른 클라이언트가 된다(설정 해시가 키에 든다). 같은 context의 옛 클라이언트는 버린다.
    pub async fn client(&self, settings_path: &Path, context: &str) -> Result<Client, AppError> {
        let loaded = auth::load(settings_path)?;
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        serde_json::to_string(&loaded.config)
            .map_err(|_| AppError::other("kubeconfig를 읽지 못했어요"))?
            .hash(&mut hasher);
        let key = format!("{context}\0{:016x}", hasher.finish());
        let mut clients = self.clients.lock().await;
        if let Some(client) = clients.get(&key) {
            return Ok(client.clone());
        }
        let (client, _) = connect::connect(&loaded, context, ENDPOINT).await?;
        clients.retain(|k, _| !k.starts_with(&format!("{context}\0")));
        clients.insert(key, client.clone());
        Ok(client)
    }

    /// 인증이 거절됐으면 다음에 새로 연결하도록 이 context의 클라이언트를 버린다.
    pub async fn forget(&self, context: &str) {
        self.clients.lock().await.retain(|k, _| !k.starts_with(&format!("{context}\0")));
    }
}

/// ArgoCD 컴포넌트 하나의 지표 서비스
pub struct Component {
    pub id: &'static str,
    pub service: &'static str,
    pub port: u16,
}

pub const COMPONENTS: [Component; 4] = [
    Component {
        id: "controller",
        service: "argocd-application-controller-metrics",
        port: 8082,
    },
    Component {
        id: "repo-server",
        service: "argocd-repo-server-metrics",
        port: 8084,
    },
    Component {
        id: "server",
        service: "argocd-server-metrics",
        port: 8083,
    },
    Component {
        id: "appset-controller",
        service: "argocd-applicationset-controller-metrics",
        port: 8080,
    },
];

/// 쿠버네티스 이름(DNS 레이블) 규칙. 경로에 그대로 들어가므로 이 모양이 아니면 보내지 않는다.
pub fn valid_namespace(name: &str) -> bool {
    !name.is_empty() && name.len() <= 63 && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !name.starts_with('-') && !name.ends_with('-')
}

/// API 서버가 서비스로 넘겨 주는 경로(`services/proxy` 하위 자원)
pub fn proxy_path(namespace: &str, service: &str, port: u16) -> String {
    format!("/api/v1/namespaces/{namespace}/services/{service}:{port}/proxy/metrics")
}

/// 프록시 호출이 API 서버에서 거절된 까닭. 다른 오류(연결·인증)는 None으로 두고 호출한 쪽이 일반 문구로 보인다.
pub fn proxy_failure(code: u16, namespace: &str, service: &str) -> Option<String> {
    match code {
        403 => Some(format!("이 context에는 {namespace} 네임스페이스의 서비스 프록시(services/proxy) 읽기 권한이 없어요")),
        404 => Some(format!(
            "{namespace} 네임스페이스에서 서비스 {service}를 찾지 못했어요. 네임스페이스나 ArgoCD 설치를 확인해 주세요"
        )),
        503 => Some(format!("서비스 {service}에 응답하는 Pod가 없어요")),
        _ => None,
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentStatus {
    pub component: String,
    pub service: String,
    pub ok: bool,
    pub error: Option<String>,
    /// 이 컴포넌트의 앞 읽기와의 간격(ms). 처음이면 None
    pub interval_ms: Option<i64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerScrape {
    /// 읽은 시각(epoch ms)
    pub at: i64,
    pub components: Vec<ComponentStatus>,
    pub series: Vec<Series>,
}

async fn fetch(client: &Client, namespace: &str, component: &Component) -> Result<String, kube::Error> {
    let request = http::Request::get(proxy_path(namespace, component.service, component.port))
        .body(Vec::new())
        .map_err(kube::Error::HttpError)?;
    match tokio::time::timeout(REQUEST_TIMEOUT, client.request_text(request)).await {
        Ok(result) => result,
        Err(_) => Err(kube::Error::Service(Box::new(std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out")))),
    }
}

impl ArgoKube {
    /// 네 컴포넌트의 `/metrics`를 service proxy로 읽어 요약한다. 한 컴포넌트가 실패해도 나머지는 돌려주고, 그 까닭은 `components`에 싣는다.
    pub async fn controller_metrics(&self, settings_path: &Path, context: &str, namespace: &str, at: i64) -> Result<ControllerScrape, AppError> {
        if !valid_namespace(namespace) {
            return Err(AppError::other("ArgoCD 네임스페이스 이름이 올바르지 않아요"));
        }
        let client = self.client(settings_path, context).await?;
        let reads = futures::future::join_all(COMPONENTS.iter().map(|c| fetch(&client, namespace, c))).await;
        let mut statuses = Vec::new();
        let mut parsed: Vec<(&Component, Vec<Sample>)> = Vec::new();
        for (component, read) in COMPONENTS.iter().zip(reads) {
            let mut status = ComponentStatus {
                component: component.id.into(),
                service: component.service.into(),
                ok: false,
                error: None,
                interval_ms: None,
            };
            match read {
                Ok(text) => {
                    status.ok = true;
                    parsed.push((component, prom::parse(&text)));
                }
                Err(kube::Error::Api(response)) if proxy_failure(response.code, namespace, component.service).is_some() => {
                    status.error = proxy_failure(response.code, namespace, component.service);
                }
                Err(error) => {
                    if matches!(&error, kube::Error::Api(response) if response.code == 401) {
                        self.forget(context).await;
                    }
                    // 연결·인증 같은 공통 실패는 컴포넌트마다 되풀이될 뿐이라 전체 오류로 돌려준다
                    return Err(describe(&failure_of(&error, "get", "services/proxy"), ENDPOINT));
                }
            }
            statuses.push(status);
        }
        let mut series = Vec::new();
        let mut trackers = self.trackers.lock().unwrap_or_else(|e| e.into_inner());
        let tracker = trackers.entry(format!("{context}\0{namespace}")).or_default();
        for (component, samples) in parsed {
            let (rows, interval) = tracker.reduce(component.id, at, &samples);
            series.extend(rows);
            if let Some(status) = statuses.iter_mut().find(|s| s.component == component.id) {
                status.interval_ms = interval;
            }
        }
        Ok(ControllerScrape { at, components: statuses, series })
    }
}

#[cfg(test)]
mod tests;
