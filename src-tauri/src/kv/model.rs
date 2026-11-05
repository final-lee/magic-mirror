//! 화면과 맞춘 계약의 모양(명령이 받고 돌려주는 값). 프런트엔드의 `src/kv/types.ts`와 필드마다 맞는다. JSON은 camelCase다.

use std::fmt;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// 탭이 여는 대상 종류
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KvKind {
    ReplicationGroup,
    ServerlessCache,
    CacheCluster,
}

/// 탭이 여는 대상: 프로필과 리전 안의 복제 그룹·서버리스 캐시·단일 노드 클러스터 하나
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvTarget {
    pub profile: String,
    pub region: String,
    pub kind: KvKind,
    pub id: String,
}

/// 사용자 그룹의 사용자. `auth`는 `iam`·`password`·`no-password`
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvUser {
    pub id: String,
    pub name: String,
    pub auth: String,
    pub status: String,
    pub access: String,
}

/// ElastiCache API로 읽은 대상 정보
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvTargetInfo {
    pub arn: String,
    pub identifier: String,
    pub kind: KvKind,
    /// `valkey` 또는 `redis`
    pub engine: String,
    pub engine_version: String,
    pub endpoint: String,
    pub port: u16,
    pub reader_endpoint: Option<String>,
    pub tls: bool,
    pub cluster_mode: bool,
    pub serverless: bool,
    pub auth_token_enabled: bool,
    pub user_group_ids: Vec<String>,
    /// `None`: 읽지 못했다(권한이 없거나 사용자 그룹이 없다)
    pub users: Option<Vec<KvUser>>,
    pub iam_supported: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KvAuthMode {
    /// AUTH를 보내지 않는다
    #[default]
    None,
    /// AUTH 토큰(사용자 이름 없이 `AUTH <토큰>`)
    Password,
    /// RBAC 사용자 이름과 비밀번호
    User,
    /// IAM 사용자 이름. 연결할 때마다 SigV4 토큰을 새로 만든다
    Iam,
}

/// 대상 ARN별로 설정 파일 `kvLogins`에 기억하는 로그인(비밀 없음)
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct KvLoginSaved {
    pub mode: KvAuthMode,
    pub user: String,
    pub database: u32,
}

/// `kv_open`이 받는 로그인. 비밀번호는 로그·오류·반환값에 넣지 않는다(`Debug`도 가린다)
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvLogin {
    #[serde(flatten)]
    pub saved: KvLoginSaved,
    /// `None`: 키체인에 저장한 것을 쓴다
    pub password: Option<String>,
    /// 켜면 `password`를 키체인에 저장한다. 끄고 비밀번호를 줬으면 저장된 것을 지운다
    pub remember_password: bool,
}

impl fmt::Debug for KvLogin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KvLogin")
            .field("saved", &self.saved)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .field("remember_password", &self.remember_password)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KvRole {
    Primary,
    Replica,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvNode {
    pub id: String,
    /// `호스트:포트`
    pub address: String,
    pub role: KvRole,
    pub shard: Option<String>,
    /// 슬롯 범위(`0-5460`). 클러스터 모드의 기본 노드에만 있다
    pub slots: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvKeyspace {
    pub db: u32,
    pub keys: u64,
    pub expires: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvNodeInfo {
    /// `KvNode.address`
    pub node: String,
    pub version: String,
    pub role: String,
    pub used_memory: u64,
    pub used_memory_peak: u64,
    pub max_memory: Option<u64>,
    pub fragmentation: Option<f64>,
    pub hits: u64,
    pub misses: u64,
    pub ops_per_sec: u64,
    pub connected_clients: u64,
    pub evicted_keys: u64,
    pub expired_keys: u64,
    pub uptime_seconds: u64,
    pub replication_lag_seconds: Option<i64>,
    pub keyspace: Vec<KvKeyspace>,
}

/// 서버리스에서 막힌 기능
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KvFeature {
    Slowlog,
    Clients,
    Memory,
    Encoding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KvMode {
    Cluster,
    Standalone,
    Serverless,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvOverview {
    pub mode: KvMode,
    pub engine: String,
    pub version: String,
    pub database: u32,
    /// 데이터베이스 고르기에 내놓는 번호(클러스터 모드 꺼짐만. 나머지는 `[0]`)
    pub databases: Vec<u32>,
    /// 기본 노드들의 DBSIZE 합(고른 데이터베이스)
    pub dbsize: u64,
    pub nodes: Vec<KvNode>,
    pub info: Vec<KvNodeInfo>,
    pub unsupported: Vec<KvFeature>,
    pub login: KvLoginSaved,
}

/// 키 이름은 바이트 그대로다. `text`는 화면용(UTF-8이 아니면 깨진 글자가 바뀐다)이고, UTF-8이 아니면 `base64`에 정확한 바이트가 있다.
/// 같은 값을 그대로 돌려주면 그 키를 가리킨다.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvKeyName {
    pub text: String,
    pub base64: Option<String>,
}

impl KvKeyName {
    pub fn from_bytes(bytes: &[u8]) -> KvKeyName {
        match std::str::from_utf8(bytes) {
            Ok(text) => KvKeyName { text: text.to_string(), base64: None },
            Err(_) => KvKeyName { text: String::from_utf8_lossy(bytes).into_owned(), base64: Some(STANDARD.encode(bytes)) },
        }
    }

    /// 서버에 보낼 바이트. `base64`가 있으면 그것이 정확한 이름이다
    pub fn to_bytes(&self) -> Result<Vec<u8>, AppError> {
        match &self.base64 {
            Some(encoded) => STANDARD.decode(encoded).map_err(|_| AppError::other("키 이름이 올바르지 않아요")),
            None => Ok(self.text.clone().into_bytes()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KvType {
    String,
    Hash,
    List,
    Set,
    Zset,
    Stream,
    Json,
    Other,
}

impl KvType {
    /// `TYPE`의 답. ReJSON 모듈의 키는 `ReJSON-RL`이다. 모르는 이름은 `Other`
    pub fn from_type_name(name: &str) -> KvType {
        match name {
            "string" => KvType::String,
            "hash" => KvType::Hash,
            "list" => KvType::List,
            "set" => KvType::Set,
            "zset" => KvType::Zset,
            "stream" => KvType::Stream,
            "ReJSON-RL" => KvType::Json,
            _ => KvType::Other,
        }
    }

    /// `SCAN ... TYPE`에 넣는 이름. 서버가 아는 이름이라야 한다
    pub fn scan_name(self) -> Option<&'static str> {
        match self {
            KvType::String => Some("string"),
            KvType::Hash => Some("hash"),
            KvType::List => Some("list"),
            KvType::Set => Some("set"),
            KvType::Zset => Some("zset"),
            KvType::Stream => Some("stream"),
            KvType::Json => Some("ReJSON-RL"),
            KvType::Other => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvKeyRow {
    pub name: KvKeyName,
    #[serde(rename = "type")]
    pub kind: KvType,
    /// `None`: 만료 없음
    pub ttl_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvScanPage {
    pub keys: Vec<KvKeyRow>,
    /// `None`: 끝까지 읽었다
    pub cursor: Option<String>,
    pub scanned: u64,
}

/// 값 조각. `text`는 UTF-8이 아니면 `None`이고 `base64`는 늘 있다
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvBytes {
    pub text: Option<String>,
    pub base64: String,
    pub bytes: usize,
}

impl KvBytes {
    pub fn from_bytes(bytes: &[u8]) -> KvBytes {
        KvBytes { text: std::str::from_utf8(bytes).ok().map(str::to_string), base64: STANDARD.encode(bytes), bytes: bytes.len() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KvField {
    pub field: KvBytes,
    pub value: KvBytes,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KvScored {
    pub member: KvBytes,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvStreamSummary {
    pub length: u64,
    pub groups: u64,
    pub first_id: Option<String>,
    pub last_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KvStreamEntry {
    pub id: String,
    pub fields: Vec<KvField>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum KvValue {
    String { value: KvBytes, truncated: bool },
    Hash { entries: Vec<KvField> },
    List { start: u64, items: Vec<KvBytes> },
    Set { members: Vec<KvBytes> },
    Zset { start: u64, members: Vec<KvScored> },
    Stream { summary: Option<KvStreamSummary>, entries: Vec<KvStreamEntry> },
    Json { text: String, truncated: bool },
    Other { type_name: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvKeyView {
    pub name: KvKeyName,
    #[serde(rename = "type")]
    pub kind: KvType,
    pub ttl_ms: Option<i64>,
    pub length: Option<u64>,
    pub memory: Option<u64>,
    pub encoding: Option<String>,
    pub value: KvValue,
    /// 컬렉션의 다음 쪽을 가리키는 불투명 값
    pub next: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvSlowEntry {
    pub node: String,
    pub id: i64,
    /// 유닉스 초
    pub time: i64,
    pub micros: i64,
    pub args: Vec<String>,
    pub client: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvClient {
    pub node: String,
    pub id: String,
    pub addr: String,
    pub name: String,
    pub user: String,
    pub db: i64,
    pub age: i64,
    pub idle: i64,
    pub cmd: String,
    pub flags: String,
    /// 이 앱이 연 연결
    pub own: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvBigKey {
    pub name: KvKeyName,
    #[serde(rename = "type")]
    pub kind: KvType,
    pub size: u64,
}

/// 큰 키의 크기를 잰 기준
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KvBigKeysBasis {
    Memory,
    Length,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum KvBigKeysMessage {
    Progress { scanned: u64, total: u64 },
    Done { basis: KvBigKeysBasis, keys: Vec<KvBigKey>, scanned: u64, stopped: bool },
}

#[cfg(test)]
mod tests;
