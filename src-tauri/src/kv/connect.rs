//! 접속: TLS(시스템 루트로 검증, aws-lc-rs), fred 클라이언트, 토폴로지, 오류의 사용자 문구. 연결 하나(`Connected`)가 탭 하나의 모든 명령을 받는다.
//!
//! - 클러스터 모드·서버리스: 엔드포인트를 씨앗으로 클러스터 모드로 붙어 슬롯을 따라간다(MOVED/ASK는 fred가 따라간다).
//!   기본 노드는 이 클라이언트로 노드를 가리켜 보낸다. 복제본은 노드마다 따로 연결한다(`peer`, 처음 쓸 때 만들어 보관한다).
//! - 클러스터 모드 꺼짐: 기본 엔드포인트에 붙는다. 읽기 엔드포인트가 있으면 키·값 읽기(`data`)는 그쪽 연결로 보낸다. 읽기 연결을 못 열면 기본 노드로 읽는다.
//! - 단일 노드: 그 노드에 붙는다.
//!
//! RESP2로 붙는다(옛 Redis OSS까지 같은 길). 연결 이름은 붙이지 않는다: fred의 `HELLO`는 `SETNAME`을 보내지 못하고 `CLIENT SETNAME`은 쓰기 명령이라 쓰지 않는다.
//! 클라이언트 목록의 "앱 자신의 연결"은 같은 연결로 `CLIENT ID`를 물어 알아본다.
//! 연결이 끊기면 다시 붙지 않고 이 연결을 쓸 수 없다고 표시한다(`usable`): 보관함이 다음 호출에서 새 토큰으로 새로 연결한다.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use fred::clients::Client;
use fred::interfaces::ClientLike;
use fred::socket2::TcpKeepalive;
use fred::types::config::{ClusterDiscoveryPolicy, Config, ConnectionConfig, Server, ServerConfig, TcpConfig, TlsConfig, TlsHostMapping};
use fred::types::{Builder, Value};
use rustls::{ClientConfig, RootCertStore};
use tokio::sync::Mutex;

use super::bull::cache::BullCache;
use super::command::{self, cmd, Cmd, KvCallError, Route};
use super::failure::{self, Ctx};
use super::iam::{IamCredentials, IamSigner};
use super::model::{KvAuthMode, KvMode, KvNode, KvRole};
use super::pool::Pooled;
use super::target::Resolved;
use super::topology::{nodes_from_shards, nodes_from_slots, split_address};
use crate::error::AppError;

/// 연결 시간 제한: 연결을 열고 로그인해 첫 응답을 받기까지
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 명령 시간 제한
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
/// 큰 키 찾기의 명령 시간 제한
pub const BIGKEYS_TIMEOUT: Duration = Duration::from_secs(30);
/// TCP keepalive: 1분 놀면 10초 간격으로 확인한다. VPN이 끊긴 연결을 오래 열려 있다고 믿지 않게 한다
const KEEPALIVE_IDLE: Duration = Duration::from_secs(60);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);

/// 비밀(비밀번호·AUTH 토큰). `Debug`에 찍히지 않는다
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Secret {
        Secret(value.into())
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([REDACTED])")
    }
}

/// 로그인 방식과 그 재료
#[derive(Clone, Debug)]
pub enum Auth {
    /// AUTH를 보내지 않는다
    None,
    /// `AUTH <토큰>`
    Password(Secret),
    /// `AUTH <user> <password>`. 비밀번호가 필요 없는 사용자는 빈 비밀번호다
    User { name: String, password: Secret },
    /// 연결마다 새 SigV4 토큰
    Iam(Arc<IamSigner>),
}

impl Auth {
    pub fn mode(&self) -> KvAuthMode {
        match self {
            Auth::None => KvAuthMode::None,
            Auth::Password(_) => KvAuthMode::Password,
            Auth::User { .. } => KvAuthMode::User,
            Auth::Iam(_) => KvAuthMode::Iam,
        }
    }

    pub fn user(&self) -> String {
        match self {
            Auth::None | Auth::Password(_) => String::new(),
            Auth::User { name, .. } => name.clone(),
            Auth::Iam(signer) => signer.user().to_string(),
        }
    }
}

/// 접속 계획: 대상 정보, 로그인, 데이터베이스
#[derive(Clone, Debug)]
pub struct Plan {
    pub resolved: Resolved,
    pub auth: Auth,
    pub database: u8,
}

impl Plan {
    pub fn mode(&self) -> KvMode {
        let info = &self.resolved.info;
        if info.serverless {
            KvMode::Serverless
        } else if info.cluster_mode {
            KvMode::Cluster
        } else {
            KvMode::Standalone
        }
    }

    pub fn ctx(&self) -> Ctx {
        let info = &self.resolved.info;
        Ctx { host: info.endpoint.clone(), port: info.port, mode: self.auth.mode(), user: self.auth.user(), serverless: info.serverless }
    }
}

const NO_ROOTS: &str = "시스템 인증서를 읽지 못했어요";

/// 시스템(macOS 키체인)의 루트 인증서
pub fn system_roots() -> Result<RootCertStore, AppError> {
    let loaded = rustls_native_certs::load_native_certs();
    let mut roots = RootCertStore::empty();
    let (added, _ignored) = roots.add_parsable_certificates(loaded.certs);
    if added == 0 {
        return Err(AppError::Network { message: NO_ROOTS.to_string() });
    }
    Ok(roots)
}

/// 믿을 CA를 받는 꼴. 검증은 그대로 켜져 있고(서버 인증서와 호스트 이름), 테스트가 자기 CA로 TLS 연결 전체를 시험하려고 나눴다.
/// 이 빌드에는 rustls의 `ring`과 `aws_lc_rs`가 둘 다 들어 있어서(다른 의존성이 켠다) 프로세스 기본 공급자를 고를 수 없다.
/// `ClientConfig::builder()`는 그러면 패닉이라 공급자를 직접 넘긴다. TLS 1.2와 1.3을 모두 허용한다(서버리스는 1.3을 요구한다).
pub fn tls_config_with(roots: RootCertStore) -> Result<ClientConfig, AppError> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let versions = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::other(format!("TLS 설정을 만들지 못했어요: {e}")))?;
    Ok(versions.with_root_certificates(roots).with_no_client_auth())
}

fn client_config(plan: &Plan, tls: &Option<ClientConfig>, server: ServerConfig, cluster: bool) -> Config {
    let mut config = Config { fail_fast: true, server, ..Config::default() };
    if !cluster {
        config.database = Some(plan.database);
    }
    match &plan.auth {
        Auth::None => {}
        Auth::Password(secret) => config.password = Some(secret.0.clone()),
        Auth::User { name, password } => {
            config.username = Some(name.clone());
            config.password = Some(password.0.clone());
        }
        Auth::Iam(signer) => config.credential_provider = Some(Arc::new(IamCredentials(signer.clone()))),
    }
    if let Some(tls) = tls {
        // 클러스터는 노드가 IP로 알려질 수 있어서 인증서 이름은 씨앗 엔드포인트의 이름으로 맞춘다(서버가 호스트 이름을 알려 주면 그 이름이 먼저다)
        let hostnames = if cluster { TlsHostMapping::DefaultHost } else { TlsHostMapping::None };
        config.tls = Some(TlsConfig { connector: tls.clone().into(), hostnames });
    }
    config
}

fn build(config: Config) -> Result<Client, AppError> {
    let mut builder = Builder::from_config(config);
    builder
        .with_connection_config(|c: &mut ConnectionConfig| {
            c.connection_timeout = CONNECT_TIMEOUT;
            c.internal_command_timeout = CONNECT_TIMEOUT;
            c.tcp = TcpConfig { keepalive: Some(TcpKeepalive::new().with_time(KEEPALIVE_IDLE).with_interval(KEEPALIVE_INTERVAL)), ..TcpConfig::default() };
        })
        .with_performance_config(|p| p.default_command_timeout = COMMAND_TIMEOUT);
    builder.build().map_err(|e| AppError::other(format!("연결을 준비하지 못했어요: {}", e.details())))
}

/// 클라이언트 하나를 만들어 연결한다. 시간 안에 못 붙으면 `Network`
async fn start(client: Client, ctx: &Ctx) -> Result<Client, AppError> {
    match tokio::time::timeout(CONNECT_TIMEOUT + Duration::from_secs(2), client.init()).await {
        Ok(Ok(_task)) => Ok(client),
        Ok(Err(e)) => {
            let _ = client.quit().await;
            Err(failure::map_fred(&e, ctx, "PING"))
        }
        Err(_) => {
            let _ = client.quit().await;
            Err(AppError::Network { message: failure::unreachable_message(ctx) })
        }
    }
}

/// 연결 하나: 탭 하나가 쓴다. 명령은 모두 `command::send`(허용 목록 관문)를 거친다.
pub struct Connected {
    plan: Plan,
    mode: KvMode,
    tls: Option<ClientConfig>,
    primary: Client,
    /// 읽기 엔드포인트로 연 연결(클러스터 모드 꺼짐, 읽기 엔드포인트가 있을 때)
    reader: Option<Client>,
    nodes: Vec<KvNode>,
    /// 노드 주소 → 그 노드로 직접 연 연결(복제본 …)
    peers: Mutex<HashMap<String, Client>>,
    /// 연결이 끊기거나 응답이 없었다. 이 연결은 더 쓰지 않는다
    broken: AtomicBool,
    ctx: Ctx,
    /// Bull 화면의 읽기 캐시. 연결과 함께 버려진다
    bull: BullCache,
}

/// 대상에 연결한다. TLS 루트는 시스템 저장소다.
pub async fn connect(plan: Plan) -> Result<Connected, AppError> {
    let tls = if plan.resolved.info.tls { Some(tls_config_with(system_roots()?)?) } else { None };
    connect_with(plan, tls).await
}

/// `connect`의 알맹이. TLS 설정을 받는 꼴이라 테스트가 자기 CA로 연결 전체를 시험한다.
pub async fn connect_with(plan: Plan, tls: Option<ClientConfig>) -> Result<Connected, AppError> {
    let info = &plan.resolved.info;
    let ctx = plan.ctx();
    let mode = plan.mode();
    let cluster = mode != KvMode::Standalone;
    // IAM: 자격 증명을 못 얻는 문제(만료된 SSO …)는 연결 오류가 아니라 그 오류 그대로 보인다
    if let Auth::Iam(signer) = &plan.auth {
        signer.token().await?;
    }
    let server = if cluster {
        ServerConfig::Clustered { hosts: vec![Server::new(info.endpoint.as_str(), info.port)], policy: ClusterDiscoveryPolicy::default() }
    } else {
        ServerConfig::Centralized { server: Server::new(info.endpoint.as_str(), info.port) }
    };
    let primary = start(build(client_config(&plan, &tls, server, cluster))?, &ctx).await?;
    let reader = match (&info.reader_endpoint, cluster) {
        (Some(host), false) => {
            let server = ServerConfig::Centralized { server: Server::new(host.as_str(), info.port) };
            let reader_ctx = Ctx { host: host.clone(), ..ctx.clone() };
            // 읽기 연결이 안 되면 기본 노드로 읽는다(기본 노드에는 이미 붙었다)
            match build(client_config(&plan, &tls, server, false)) {
                Ok(client) => start(client, &reader_ctx).await.ok(),
                Err(_) => None,
            }
        }
        _ => None,
    };
    let mut connected = Connected { plan, mode, tls, primary, reader, nodes: Vec::new(), peers: Mutex::new(HashMap::new()), broken: AtomicBool::new(false), ctx, bull: BullCache::default() };
    match connected.discover().await {
        Ok(nodes) => connected.nodes = nodes,
        Err(e) => {
            connected.close().await;
            return Err(e);
        }
    }
    Ok(connected)
}

impl Connected {
    pub fn plan(&self) -> &Plan {
        &self.plan
    }

    pub fn mode(&self) -> KvMode {
        self.mode
    }

    pub fn nodes(&self) -> &[KvNode] {
        &self.nodes
    }

    pub fn bull_cache(&self) -> &BullCache {
        &self.bull
    }

    /// 접속 계획의 기본 엔드포인트 `호스트:포트`
    pub fn endpoint(&self) -> String {
        let info = &self.plan.resolved.info;
        format!("{}:{}", info.endpoint, info.port)
    }

    /// 읽기 엔드포인트로 연 연결이 있는가
    pub fn has_reader(&self) -> bool {
        self.reader.is_some()
    }

    /// 노드 목록: 서버리스는 엔드포인트 하나, 클러스터 모드 꺼짐은 API가 알려 준 노드들, 클러스터는 `CLUSTER SHARDS`(없으면 `CLUSTER SLOTS`)
    async fn discover(&self) -> Result<Vec<KvNode>, AppError> {
        let info = &self.plan.resolved.info;
        match self.mode {
            KvMode::Serverless => Ok(vec![KvNode { id: info.identifier.clone(), address: self.endpoint(), role: KvRole::Primary, shard: None, slots: None }]),
            KvMode::Standalone => {
                let members = &self.plan.resolved.members;
                if members.is_empty() {
                    return Ok(vec![KvNode { id: info.identifier.clone(), address: self.endpoint(), role: KvRole::Primary, shard: None, slots: None }]);
                }
                Ok(members.clone())
            }
            KvMode::Cluster => {
                let route = Route { node: None, timeout: COMMAND_TIMEOUT };
                let shards = command::send(&self.primary, &route, cmd("CLUSTER SHARDS")).await.map(|v| nodes_from_shards(&v, info.tls)).unwrap_or_default();
                if !shards.is_empty() {
                    return Ok(shards);
                }
                let slots = command::send(&self.primary, &route, cmd("CLUSTER SLOTS")).await.map_err(|e| self.fail(&e, "CLUSTER SLOTS"))?;
                let nodes = nodes_from_slots(&slots, &info.endpoint);
                if nodes.is_empty() {
                    return Err(AppError::other("클러스터의 노드 목록을 읽지 못했어요"));
                }
                Ok(nodes)
            }
        }
    }

    /// 명령 오류를 앱 오류로 바꾸고, 연결이 끊긴 오류면 이 연결을 못 쓴다고 표시한다
    fn fail(&self, error: &KvCallError, command: &str) -> AppError {
        if failure::is_connection_loss(error) {
            self.broken.store(true, Ordering::Relaxed);
        }
        failure::map_call(error, &self.ctx, command)
    }

    async fn run(&self, client: &Client, node: Option<Server>, timeout: Duration, command: Cmd) -> Result<Value, AppError> {
        let name = command.name();
        command::send(client, &Route { node, timeout }, command).await.map_err(|e| self.fail(&e, name))
    }

    /// 키·값을 읽는 명령: 읽기 연결이 있으면 그쪽, 없으면 기본 연결. 클러스터는 키의 슬롯으로 노드를 고른다
    pub async fn data(&self, command: Cmd) -> Result<Value, AppError> {
        self.data_within(COMMAND_TIMEOUT, command).await
    }

    pub async fn data_within(&self, timeout: Duration, command: Cmd) -> Result<Value, AppError> {
        self.run(self.reader.as_ref().unwrap_or(&self.primary), None, timeout, command).await
    }

    /// 이 노드(`KvNode.address`)에서 실행하는 명령
    pub async fn on_node(&self, address: &str, command: Cmd) -> Result<Value, AppError> {
        self.on_node_within(address, COMMAND_TIMEOUT, command).await
    }

    pub async fn on_node_within(&self, address: &str, timeout: Duration, command: Cmd) -> Result<Value, AppError> {
        let node = self.nodes.iter().find(|n| n.address == address).ok_or_else(|| AppError::other(format!("노드를 찾지 못했어요: {address}")))?;
        match self.mode {
            KvMode::Serverless => self.run(&self.primary, None, timeout, command).await,
            KvMode::Cluster if node.role == KvRole::Primary => {
                let (host, port) = split_address(address).ok_or_else(|| AppError::other(format!("노드 주소가 올바르지 않아요: {address}")))?;
                self.run(&self.primary, Some(Server::new(host, port)), timeout, command).await
            }
            KvMode::Standalone if address == self.endpoint() => self.run(&self.primary, None, timeout, command).await,
            _ => {
                let peer = self.peer(address).await?;
                self.run(&peer, None, timeout, command).await
            }
        }
    }

    /// 이 노드로 직접 연 연결(처음 쓸 때 만들어 보관한다). 복제본의 INFO·CLIENT LIST·SLOWLOG가 쓴다
    async fn peer(&self, address: &str) -> Result<Client, AppError> {
        if let Some(client) = self.peers.lock().await.get(address) {
            return Ok(client.clone());
        }
        let (host, port) = split_address(address).ok_or_else(|| AppError::other(format!("노드 주소가 올바르지 않아요: {address}")))?;
        let tls_name = (self.mode == KvMode::Cluster && self.tls.is_some()).then(|| self.plan.resolved.info.endpoint.clone());
        let server = ServerConfig::Centralized { server: Server::new_with_tls(host.as_str(), port, tls_name) };
        let ctx = Ctx { host, port, ..self.ctx.clone() };
        let client = start(build(client_config(&self.plan, &self.tls, server, self.mode == KvMode::Cluster))?, &ctx).await?;
        let mut peers = self.peers.lock().await;
        // 같은 노드를 동시에 연 호출이 먼저 넣었으면 그 연결을 쓰고 이쪽은 닫는다
        if let Some(existing) = peers.get(address) {
            let existing = existing.clone();
            drop(peers);
            let _ = client.quit().await;
            return Ok(existing);
        }
        peers.insert(address.to_string(), client.clone());
        Ok(client)
    }

    /// 열린 연결을 모두 닫는다
    pub async fn close(&self) {
        let mut clients: Vec<Client> = vec![self.primary.clone()];
        clients.extend(self.reader.clone());
        clients.extend(self.peers.lock().await.drain().map(|(_, c)| c));
        for client in clients {
            let _ = tokio::time::timeout(Duration::from_secs(2), client.quit()).await;
        }
    }
}

#[async_trait]
impl Pooled for Connected {
    fn usable(&self) -> bool {
        !self.broken.load(Ordering::Relaxed) && self.primary.is_connected()
    }

    async fn close(&self) {
        Connected::close(self).await;
    }
}

#[cfg(test)]
mod tests;
