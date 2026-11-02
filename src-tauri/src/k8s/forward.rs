//! Pod·Service port-forward. 이 컴퓨터의 `127.0.0.1` 포트를 열어 두고, 연결이 올 때마다 `pods/portforward` 웹소켓을 하나씩 연다(kubectl과 같다).
//! 클러스터에 port-forward를 여는 곳은 이 파일뿐이다(`hygiene`이 지킨다). Service는 준비된 Pod 하나로 붙고, 그 Pod가 사라지거나 준비가 풀리면 다른 Pod로 옮긴다.
//! 전달하는 바이트는 어디에도 남기지 않는다. 대상 탭을 닫거나 앱을 끄면 모두 닫는다.
use std::collections::{BTreeMap, HashMap};
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use futures::StreamExt;
use k8s_openapi::api::core::v1::{Pod, Service};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::Api;
use kube::runtime::watcher::{self, Event};
use kube::runtime::WatchStreamExt;
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinSet;

use super::failure::{short_reason, Endpoint};
use super::read::bounded;
use super::shell::bounded_stream;
use super::target::K8sTarget;
use crate::error::AppError;

/// 로컬은 이 주소로만 연다(다른 컴퓨터에서 닿지 않는다)
pub const LOCAL_ADDR: Ipv4Addr = Ipv4Addr::LOCALHOST;
/// Service의 준비된 Pod가 없을 때 연결 하나가 다른 Pod를 기다리는 시간
const RESOLVE_WAIT: Duration = Duration::from_secs(15);

pub const BAD_REQUEST: &str = "대상 이름과 포트를 확인해 주세요";
pub const NO_SELECTOR: &str = "셀렉터가 없는 Service는 연결할 Pod를 찾을 수 없어요";
pub const NO_SERVICE_PORT: &str = "Service에 그 포트가 없어요";
pub const UDP_PORT: &str = "TCP 포트만 연결할 수 있어요";
pub const NO_READY_POD: &str = "준비된 Pod가 없어요";
pub const POD_NOT_RUNNING: &str = "Pod가 실행 중이 아니에요";

pub fn local_port_unavailable(port: u16) -> String {
    format!("로컬 포트 {port}를 쓸 수 없어요. 이미 쓰고 있거나 권한이 없어요")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForwardKind {
    Pod,
    Service,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRequest {
    pub namespace: String,
    pub kind: ForwardKind,
    pub name: String,
    /// Pod 컨테이너의 포트, Service면 Service의 포트
    pub remote_port: u16,
    /// 없으면 자동
    pub local_port: Option<u16>,
}

/// 열린 port-forward 하나
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Forward {
    pub id: u64,
    pub local_port: u16,
    pub target: K8sTarget,
    pub namespace: String,
    pub kind: ForwardKind,
    pub name: String,
    pub remote_port: u16,
    /// 지금 붙어 있는 Pod. Service에서 준비된 Pod가 없으면 없다.
    pub pod: Option<String>,
    /// 가장 최근 연결 실패의 사유. 다음 연결이 되면 지운다.
    pub error: Option<String>,
}

pub fn check_request(req: &ForwardRequest) -> Result<(), AppError> {
    if req.namespace.is_empty() || req.name.is_empty() || req.remote_port == 0 || req.local_port == Some(0) {
        return Err(AppError::other(BAD_REQUEST));
    }
    Ok(())
}

/// 로컬 포트를 연다. 지정했으면 그 포트만, 아니면 원격과 같은 번호(1024 이상)를 먼저 시도하고 안 되면 운영체제가 고른 포트.
pub async fn bind_local(requested: Option<u16>, remote: u16) -> Result<TcpListener, AppError> {
    if let Some(port) = requested {
        return TcpListener::bind((LOCAL_ADDR, port)).await.map_err(|_| AppError::other(local_port_unavailable(port)));
    }
    if remote >= 1024 {
        if let Ok(listener) = TcpListener::bind((LOCAL_ADDR, remote)).await {
            return Ok(listener);
        }
    }
    TcpListener::bind((LOCAL_ADDR, 0)).await.map_err(|_| AppError::other(local_port_unavailable(0)))
}

/// Service 포트가 가리키는 Pod 쪽 포트: 번호거나 컨테이너 포트 이름
#[derive(Debug, Clone, PartialEq)]
pub enum TargetPort {
    Number(u16),
    Name(String),
}

/// Service의 `port`에 해당하는 항목의 `targetPort`. 정하지 않았거나 0이면 `port` 자신이다.
pub fn service_target(svc: &Service, port: u16) -> Result<TargetPort, AppError> {
    let spec = svc.spec.as_ref().ok_or_else(|| AppError::other(NO_SERVICE_PORT))?;
    let entry = spec
        .ports
        .iter()
        .flatten()
        .find(|p| p.port == i32::from(port))
        .ok_or_else(|| AppError::other(NO_SERVICE_PORT))?;
    if entry.protocol.as_deref().is_some_and(|p| p != "TCP") {
        return Err(AppError::other(UDP_PORT));
    }
    Ok(match &entry.target_port {
        Some(IntOrString::Int(n)) if *n > 0 => TargetPort::Number(u16::try_from(*n).map_err(|_| AppError::other(NO_SERVICE_PORT))?),
        Some(IntOrString::String(name)) => TargetPort::Name(name.clone()),
        _ => TargetPort::Number(port),
    })
}

/// Service 셀렉터를 `a=b,c=d` 꼴로. 비어 있으면 에러.
pub fn selector_of(svc: &Service) -> Result<String, AppError> {
    let labels: &BTreeMap<String, String> = match svc.spec.as_ref().and_then(|s| s.selector.as_ref()) {
        Some(labels) if !labels.is_empty() => labels,
        _ => return Err(AppError::other(NO_SELECTOR)),
    };
    Ok(labels.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(","))
}

/// Pod 안에서 `target`이 가리키는 포트 번호. 이름이면 컨테이너 포트 이름으로 찾는다.
pub fn container_port(pod: &Pod, target: &TargetPort) -> Option<u16> {
    match target {
        TargetPort::Number(n) => Some(*n),
        TargetPort::Name(name) => pod
            .spec
            .as_ref()?
            .containers
            .iter()
            .flat_map(|c| c.ports.iter().flatten())
            .find(|p| p.name.as_deref() == Some(name))
            .and_then(|p| u16::try_from(p.container_port).ok()),
    }
}

/// 지워지는 중이 아니고, 실행 중이며, Ready 조건이 참인 Pod
pub fn is_ready(pod: &Pod) -> bool {
    pod.metadata.deletion_timestamp.is_none()
        && pod
            .status
            .as_ref()
            .is_some_and(|s| s.phase.as_deref() == Some("Running") && s.conditions.iter().flatten().any(|c| c.type_ == "Ready" && c.status == "True"))
}

/// 지금 붙을 Pod와 그 Pod 쪽 포트
#[derive(Debug, Clone, PartialEq)]
pub struct Chosen {
    pub pod: String,
    pub port: u16,
}

/// 준비된 Pod 중에서 고른다. 붙어 있던 Pod(`current`)가 아직 준비돼 있으면 그대로 두고(옮기지 않는다), 아니면 이름순으로 첫 Pod.
/// 포트 이름을 풀 수 없는 Pod는 건너뛴다.
pub fn choose<'a>(pods: impl IntoIterator<Item = &'a Pod>, current: Option<&Chosen>, target: &TargetPort) -> Option<Chosen> {
    let mut eligible: Vec<Chosen> = pods
        .into_iter()
        .filter(|p| is_ready(p))
        .filter_map(|p| Some(Chosen { pod: p.metadata.name.clone()?, port: container_port(p, target)? }))
        .collect();
    if let Some(keep) = current.filter(|c| eligible.contains(c)) {
        return Some(keep.clone());
    }
    eligible.sort_by(|a, b| a.pod.cmp(&b.pod));
    eligible.into_iter().next()
}

/// 연결 하나가 붙는 방법
#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    /// 정한 Pod 하나
    Pod,
    /// 셀렉터에 맞는 준비된 Pod 하나를 따라간다
    Service { selector: String, target: TargetPort },
}

/// 열기 전에 확인한 결과
#[derive(Debug, Clone, PartialEq)]
pub struct Prepared {
    pub source: Source,
    pub first: Chosen,
}

/// 대상을 읽어 처음 붙을 곳을 정하고, 권한과 연결이 되는지 웹소켓을 한 번 열어 보고 닫는다.
pub async fn prepare(client: kube::Client, req: &ForwardRequest, endpoint: Endpoint) -> Result<Prepared, AppError> {
    check_request(req)?;
    let pods: Api<Pod> = Api::namespaced(client.clone(), &req.namespace);
    let prepared = match req.kind {
        ForwardKind::Pod => {
            let pod = bounded(pods.get(&req.name), "get", "pods", endpoint).await?;
            if pod.status.as_ref().and_then(|s| s.phase.as_deref()) != Some("Running") {
                return Err(AppError::other(POD_NOT_RUNNING));
            }
            Prepared { source: Source::Pod, first: Chosen { pod: req.name.clone(), port: req.remote_port } }
        }
        ForwardKind::Service => {
            let services: Api<Service> = Api::namespaced(client, &req.namespace);
            let svc = bounded(services.get(&req.name), "get", "services", endpoint).await?;
            let selector = selector_of(&svc)?;
            let target = service_target(&svc, req.remote_port)?;
            let found = bounded(pods.list(&kube::api::ListParams::default().labels(&selector)), "list", "pods", endpoint).await?;
            let first = choose(&found.items, None, &target).ok_or_else(|| AppError::other(NO_READY_POD))?;
            Prepared { source: Source::Service { selector, target }, first }
        }
    };
    let probe = bounded_stream(pods.portforward(&prepared.first.pod, &[prepared.first.port]), "create", "pods/portforward", endpoint).await?;
    probe.abort();
    Ok(prepared)
}

/// 연결 작업들이 함께 보는 상태
struct Shared {
    chosen: watch::Sender<Option<Chosen>>,
    error: Mutex<Option<String>>,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shared {
    fn set_error(&self, error: Option<String>) {
        *locked(&self.error) = error;
    }
}

/// Service의 Pod 변화를 지켜보며 붙을 Pod를 갱신한다. 끝나지 않는다(감시가 끊기면 backoff로 다시 건다).
async fn supervise(client: kube::Client, namespace: String, selector: String, target: TargetPort, shared: Arc<Shared>) {
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let mut events = watcher::watcher(api, watcher::Config::default().labels(&selector)).default_backoff().boxed();
    let mut pods: HashMap<String, Pod> = HashMap::new();
    let mut fresh: HashMap<String, Pod> = HashMap::new();
    while let Some(event) = events.next().await {
        match event {
            Ok(Event::Init) => fresh.clear(),
            Ok(Event::InitApply(pod)) => {
                if let Some(name) = pod.metadata.name.clone() {
                    fresh.insert(name, pod);
                }
            }
            Ok(Event::InitDone) => pods = std::mem::take(&mut fresh),
            Ok(Event::Apply(pod)) => {
                if let Some(name) = pod.metadata.name.clone() {
                    pods.insert(name, pod);
                }
            }
            Ok(Event::Delete(pod)) => {
                if let Some(name) = &pod.metadata.name {
                    pods.remove(name);
                }
            }
            Err(_) => continue,
        }
        shared.chosen.send_if_modified(|current| {
            let next = choose(pods.values(), current.as_ref(), &target);
            let changed = *current != next;
            *current = next;
            changed
        });
    }
}

/// 로컬 연결 하나를 Pod로 이어 준다. Service는 붙은 Pod가 실패하면 다른 Pod가 정해질 때까지(`RESOLVE_WAIT`) 기다렸다 다시 시도한다.
async fn serve(client: kube::Client, endpoint: Endpoint, namespace: String, retarget: bool, shared: Arc<Shared>, mut tcp: TcpStream) {
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let mut chosen = shared.chosen.subscribe();
    let deadline = tokio::time::Instant::now() + RESOLVE_WAIT;
    let mut failed: Option<Chosen> = None;
    loop {
        let now = chosen.borrow_and_update().clone();
        match now {
            Some(c) if failed.as_ref() != Some(&c) => match bounded_stream(api.portforward(&c.pod, &[c.port]), "create", "pods/portforward", endpoint).await {
                Ok(mut forwarder) => {
                    shared.set_error(None);
                    if let Some(mut stream) = forwarder.take_stream(c.port) {
                        let refused = forwarder.take_error(c.port);
                        tokio::select! {
                            _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream) => {}
                            reason = async {
                                match refused {
                                    Some(f) => f.await,
                                    None => std::future::pending().await,
                                }
                            } => {
                                if let Some(reason) = reason {
                                    shared.set_error(Some(short_reason(&reason)));
                                }
                            }
                        }
                    }
                    forwarder.abort();
                    return;
                }
                Err(e) => {
                    shared.set_error(Some(error_text(&e)));
                    if !retarget {
                        return;
                    }
                    failed = Some(c);
                }
            },
            None => shared.set_error(Some(NO_READY_POD.into())),
            Some(_) => {}
        }
        if !retarget {
            return;
        }
        // 다른 Pod가 정해질 때까지 기다린다
        if !matches!(tokio::time::timeout_at(deadline, chosen.changed()).await, Ok(Ok(()))) {
            return;
        }
    }
}

fn error_text(e: &AppError) -> String {
    match e {
        AppError::AccessDenied { action } => format!("권한 없음 ({action})"),
        other => other.to_string(),
    }
}

struct ForwardEntry {
    info: Forward,
    shared: Arc<Shared>,
    handle: tokio::task::AbortHandle,
}

/// 열려 있는 port-forward. 잠금은 이 안에서만 잡는다(`K8sState`의 잠금 순서에서 맨 뒤).
#[derive(Default)]
pub struct Forwards {
    entries: Mutex<HashMap<u64, ForwardEntry>>,
    next: AtomicU64,
}

/// 작업이 끝나거나 패닉으로 풀릴 때 목록에서 자기 항목을 지운다
struct Forget {
    forwards: Arc<Forwards>,
    id: u64,
}

impl Drop for Forget {
    fn drop(&mut self) {
        locked(&self.forwards.entries).remove(&self.id);
    }
}

impl Forwards {
    /// 연 로컬 포트로 연결을 받는 작업을 띄워 등록한다. 등록이 끝날 때까지 잠금을 쥔다.
    pub fn start(self: &Arc<Self>, target: K8sTarget, req: &ForwardRequest, prepared: Prepared, listener: TcpListener, client: kube::Client, endpoint: Endpoint) -> Result<Forward, AppError> {
        let local_port = listener.local_addr().map_err(|_| AppError::other(local_port_unavailable(0)))?.port();
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (chosen, _) = watch::channel(Some(prepared.first.clone()));
        let shared = Arc::new(Shared { chosen, error: Mutex::new(None) });
        let info = Forward {
            id,
            local_port,
            target,
            namespace: req.namespace.clone(),
            kind: req.kind,
            name: req.name.clone(),
            remote_port: req.remote_port,
            pod: Some(prepared.first.pod.clone()),
            error: None,
        };
        let mut entries = locked(&self.entries);
        let forget = Forget { forwards: self.clone(), id };
        let task = tokio::spawn(accept_loop(client, endpoint, req.namespace.clone(), prepared.source, listener, shared.clone(), forget));
        entries.insert(id, ForwardEntry { info: info.clone(), shared, handle: task.abort_handle() });
        Ok(info)
    }

    /// 열린 것을 연 순서로. 붙은 Pod와 최근 오류는 지금 값이다.
    pub fn list(&self) -> Vec<Forward> {
        let mut all: Vec<Forward> = locked(&self.entries)
            .values()
            .map(|e| Forward {
                pod: e.shared.chosen.borrow().as_ref().map(|c| c.pod.clone()),
                error: locked(&e.shared.error).clone(),
                ..e.info.clone()
            })
            .collect();
        all.sort_by_key(|f| f.id);
        all
    }

    pub fn close(&self, id: u64) {
        if let Some(e) = locked(&self.entries).remove(&id) {
            e.handle.abort();
        }
    }

    pub fn close_target(&self, t: &K8sTarget) {
        locked(&self.entries).retain(|_, e| {
            let same = e.info.target == *t;
            if same {
                e.handle.abort();
            }
            !same
        });
    }

    pub fn close_all(&self) {
        for (_, e) in locked(&self.entries).drain() {
            e.handle.abort();
        }
    }
}

async fn accept_loop(client: kube::Client, endpoint: Endpoint, namespace: String, source: Source, listener: TcpListener, shared: Arc<Shared>, _forget: Forget) {
    // 이 집합이 버려지면(작업이 멈추면) 남은 연결과 감시도 함께 멈춘다
    let mut tasks: JoinSet<()> = JoinSet::new();
    let retarget = matches!(source, Source::Service { .. });
    if let Source::Service { selector, target } = source {
        tasks.spawn(supervise(client.clone(), namespace.clone(), selector, target, shared.clone()));
    }
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((tcp, _)) => {
                    tasks.spawn(serve(client.clone(), endpoint, namespace.clone(), retarget, shared.clone(), tcp));
                }
                // 파일 핸들이 모자라는 등 일시적인 오류: 잠깐 쉰다
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            },
            // 끝난 연결 작업을 치운다
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
        }
    }
}

#[cfg(test)]
mod tests;
