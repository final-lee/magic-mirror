//! T5 키: auth key·OAuth 클라이언트·federated identity·API 토큰 목록과 지적, 삭제(미리보기 → 확인 → 적용), Tailnet Lock 상태.
use chrono::{DateTime, Duration, Utc};
use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};

use super::api::{Request, Scope, TailscaleState};
use super::{changes, cli};
use crate::error::AppError;

#[cfg(test)]
mod tests;

/// 이 날수 안에 만료되는 키를 "만료 임박"으로 지적한다.
pub const EXPIRING_DAYS: i64 = 30;
/// 한 번에 가져오는 키 상세 요청 수.
const DETAIL_BATCH: usize = 8;

const KEY_NOT_FOUND: &str = "이미 없는 키예요. 목록을 다시 읽어 주세요";
const KEY_ID_INVALID: &str = "키 ID가 올바르지 않아요";
const CONFIRM_MISMATCH: &str = "확인 입력이 키 ID와 달라요";
const LOCK_PARSE: &str = "Tailnet Lock 상태를 해석하지 못했어요";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyKind {
    Auth,
    Client,
    Federated,
    Api,
}

impl KeyKind {
    /// 이 종류의 키를 지울 때 필요한 OAuth 쓰기 스코프.
    fn delete_scope(self) -> &'static str {
        match self {
            KeyKind::Auth => "auth_keys",
            KeyKind::Client => "oauth_keys",
            KeyKind::Federated => "federated_keys",
            KeyKind::Api => "api_access_tokens",
        }
    }

    fn delete_warning(self) -> &'static str {
        match self {
            KeyKind::Auth => "이 키로 이미 등록한 기기는 그대로 남아요. 이 키로 새 기기를 등록하는 건 더는 안 돼요.",
            KeyKind::Client => "이 OAuth 클라이언트로 받은 토큰이 모두 못 쓰게 돼요. 이 앱이 쓰는 클라이언트라면 연결이 끊겨요.",
            KeyKind::Federated => "이 federated identity로 받은 토큰이 더는 통하지 않아요.",
            KeyKind::Api => "이 API 토큰을 쓰는 곳이 모두 인증에 실패해요. 이 앱이 쓰는 토큰이라면 연결이 끊겨요.",
        }
    }
}

/// 목록에 보이는 키 하나. 비밀값(`key`)은 읽지 않는다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TsKey {
    pub id: String,
    pub kind: KeyKind,
    pub description: String,
    pub created: Option<String>,
    pub expires: Option<String>,
    /// OAuth 클라이언트·federated identity·API 토큰의 스코프.
    pub scopes: Vec<String>,
    /// auth key는 등록한 기기에 붙는 태그, OAuth 클라이언트·federated identity는 허용 태그.
    pub tags: Vec<String>,
    pub reusable: bool,
    pub ephemeral: bool,
    pub preauthorized: bool,
    /// 이미 지웠거나 만료돼 못 쓰는 키.
    pub invalid: bool,
    pub user_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FindingKind {
    Expired,
    Expiring,
    ReusablePreauthorized,
    NoTags,
    AllScope,
}

/// 키 하나에 대한 지적. `days`는 Expiring이면 남은 날수, Expired면 지난 날수다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFinding {
    pub key_id: String,
    pub kind: FindingKind,
    pub days: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TsKeys {
    pub keys: Vec<TsKey>,
    pub findings: Vec<KeyFinding>,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default()
}

fn parse_time(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text).ok().map(|time| time.with_timezone(&Utc))
}

/// 키 하나(목록 항목 또는 `GET /keys/{id}`)를 읽는다. `id`가 없으면 `None`.
fn shape_key(value: &Value) -> Option<TsKey> {
    let id = text(value, "id")?;
    let create = value.pointer("/capabilities/devices/create");
    let kind = match value.get("keyType").and_then(Value::as_str) {
        Some("auth") => KeyKind::Auth,
        Some("client") => KeyKind::Client,
        Some("federated") => KeyKind::Federated,
        Some("api") => KeyKind::Api,
        _ if value.get("capabilities").is_some() => KeyKind::Auth,
        _ => KeyKind::Api,
    };
    let flag = |name: &str| create.and_then(|create| create.get(name)).and_then(Value::as_bool).unwrap_or(false);
    Some(TsKey {
        id,
        kind,
        description: text(value, "description").unwrap_or_default(),
        created: text(value, "created"),
        expires: text(value, "expires"),
        scopes: strings(value.get("scopes")),
        tags: if kind == KeyKind::Auth { strings(create.and_then(|create| create.get("tags"))) } else { strings(value.get("tags")) },
        reusable: flag("reusable"),
        ephemeral: flag("ephemeral"),
        preauthorized: flag("preauthorized"),
        invalid: value.get("invalid").and_then(Value::as_bool).unwrap_or(false),
        user_id: text(value, "userId"),
    })
}

/// 목록 항목에 종류도 생성 시각도 없으면 ID만 온 것이라 상세를 따로 읽어야 한다.
fn id_only(value: &Value) -> Option<&str> {
    let id = value.get("id").and_then(Value::as_str)?;
    (value.get("keyType").is_none() && value.get("created").is_none() && value.get("capabilities").is_none()).then_some(id)
}

/// 종류, 만료가 빠른 순(만료 없음은 맨 뒤), ID 순.
fn sort_keys(keys: &mut [TsKey]) {
    keys.sort_by(|a, b| {
        let expiry = |key: &TsKey| key.expires.as_deref().and_then(parse_time);
        (a.kind, expiry(a).is_none(), expiry(a), &a.id).cmp(&(b.kind, expiry(b).is_none(), expiry(b), &b.id))
    });
}

/// 키가 이미 쓸 수 없는가: 지웠거나(`invalid`) 만료 시각이 지났다.
fn is_expired(key: &TsKey, now: DateTime<Utc>) -> bool {
    key.invalid || key.expires.as_deref().and_then(parse_time).is_some_and(|expires| expires <= now)
}

/// 지적 모음. `now`를 받는 순수 함수.
/// - 만료됨 / 30일 이내 만료: 만료 시각이 있는 모든 키.
/// - 재사용 + 사전 승인 auth key, 태그 없는 auth key, `all` 스코프 OAuth 클라이언트·federated identity: 아직 쓸 수 있는 키만.
pub fn findings(keys: &[TsKey], now: DateTime<Utc>) -> Vec<KeyFinding> {
    let mut out = Vec::new();
    for key in keys {
        let mut add = |kind, days| out.push(KeyFinding { key_id: key.id.clone(), kind, days });
        if is_expired(key, now) {
            let days = key.expires.as_deref().and_then(parse_time).map(|expires| (now - expires).num_days().max(0));
            add(FindingKind::Expired, days);
            continue;
        }
        if let Some(expires) = key.expires.as_deref().and_then(parse_time) {
            let remaining = expires - now;
            if remaining <= Duration::days(EXPIRING_DAYS) {
                add(FindingKind::Expiring, Some((remaining.num_seconds() + 86_399) / 86_400));
            }
        }
        match key.kind {
            KeyKind::Auth => {
                if key.reusable && key.preauthorized {
                    add(FindingKind::ReusablePreauthorized, None);
                }
                if key.tags.is_empty() {
                    add(FindingKind::NoTags, None);
                }
            }
            KeyKind::Client | KeyKind::Federated => {
                if key.scopes.iter().any(|scope| scope == "all") {
                    add(FindingKind::AllScope, None);
                }
            }
            KeyKind::Api => {}
        }
    }
    out
}

fn key_path(id: &str) -> Result<String, AppError> {
    let valid = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(AppError::other(KEY_ID_INVALID));
    }
    Ok(format!("/tailnet/-/keys/{id}"))
}

async fn get_key(state: &TailscaleState, tailnet: &str, id: &str) -> Result<TsKey, AppError> {
    let value = state.get_json(tailnet, &key_path(id)?).await?;
    shape_key(&value).ok_or_else(|| AppError::other(KEY_NOT_FOUND))
}

/// `GET /tailnet/-/keys?all=true`. 항목에 ID만 있으면 `GET /keys/{id}`로 상세를 채운다.
pub async fn list(state: &TailscaleState, tailnet: &str) -> Result<TsKeys, AppError> {
    let value = state.get_json(tailnet, "/tailnet/-/keys?all=true").await?;
    let items = value.get("keys").and_then(Value::as_array).ok_or_else(|| AppError::other(super::api::RESPONSE_ERROR))?;
    let mut keys: Vec<TsKey> = items.iter().filter(|item| id_only(item).is_none()).filter_map(shape_key).collect();
    let missing: Vec<&str> = items.iter().filter_map(id_only).collect();
    for chunk in missing.chunks(DETAIL_BATCH) {
        for detail in futures::future::join_all(chunk.iter().map(|id| get_key(state, tailnet, id))).await {
            keys.push(detail?);
        }
    }
    sort_keys(&mut keys);
    let findings = findings(&keys, Utc::now());
    Ok(TsKeys { keys, findings })
}

/// 부를 API 하나.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KeyCall {
    pub method: &'static str,
    pub path: String,
    /// 이 호출에 쓰는 OAuth 스코프(API 액세스 토큰에는 뜻이 없다).
    pub scope: &'static str,
}

/// 삭제 미리보기: 부를 API, 지울 키, 경고, 확인 입력(키 ID).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyDeletePreview {
    pub key: TsKey,
    pub calls: Vec<KeyCall>,
    pub confirm_name: String,
    pub warnings: Vec<String>,
    pub reversible: bool,
}

pub async fn delete_preview(state: &TailscaleState, tailnet: &str, id: &str) -> Result<KeyDeletePreview, AppError> {
    let key = get_key(state, tailnet, id).await?;
    Ok(KeyDeletePreview {
        calls: vec![KeyCall { method: "DELETE", path: format!("/tailnet/-/keys/{}", key.id), scope: key.kind.delete_scope() }],
        confirm_name: key.id.clone(),
        warnings: vec![key.kind.delete_warning().to_owned()],
        reversible: false,
        key,
    })
}

/// 삭제 결과. `logged`가 false면 키는 지웠지만 변경 기록을 남기지 못했다.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KeyDeleted {
    pub logged: bool,
}

/// 확인 입력(`typed`)이 키 ID와 같을 때만 지운다. 지운 키는 되돌릴 수 없지만 변경 기록에는 남긴다.
pub async fn delete(state: &TailscaleState, tailnet: &str, id: &str, typed: &str) -> Result<KeyDeleted, AppError> {
    let key = get_key(state, tailnet, id).await?;
    if typed != key.id {
        return Err(AppError::other(CONFIRM_MISMATCH));
    }
    let path = key_path(&key.id)?;
    state.request(tailnet, Request::new(Method::DELETE, &path, Scope::Write(key.kind.delete_scope()))).await?;
    let label = if key.description.is_empty() { key.id.clone() } else { key.description.clone() };
    let at = Utc::now();
    let entry = changes::Entry {
        id: format!("key-{}-{}", at.timestamp_millis(), key.id),
        at: at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        tailnet: tailnet.to_owned(),
        action: "key_delete".into(),
        target: changes::Target { device_id: None, name: Some(label.clone()) },
        summary: format!("키 삭제: {label} ({})", key.id),
        before: json!(key),
        after: Value::Null,
        undo_of: None,
        undone: false,
    };
    Ok(KeyDeleted { logged: changes::record(state.changes_path(), &entry).is_ok() })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockPeer {
    pub name: String,
    pub node_key: Option<String>,
}

/// 이 Mac의 Tailnet Lock 상태(`tailscale lock status --json`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TsLock {
    pub enabled: bool,
    /// 이 Mac의 잠금(서명) 공개 키.
    pub public_key: Option<String>,
    /// 이 Mac의 노드 키에 서명이 있는지. 잠금이 꺼져 있으면 의미가 없다.
    pub node_key_signed: Option<bool>,
    /// 이 Mac의 잠금 키가 신뢰 키에 들어 있는지(서명 노드인지). 잠금이 꺼져 있으면 `None`.
    pub this_key_trusted: Option<bool>,
    pub trusted_keys: usize,
    /// 서명이 없어서 걸러진 기기와 해당 노드 키.
    pub needs_signature: Vec<LockPeer>,
}

pub fn shape_lock(json: &str) -> Result<TsLock, AppError> {
    let value: Value = serde_json::from_str(json).map_err(|_| AppError::other(LOCK_PARSE))?;
    if !value.is_object() {
        return Err(AppError::other(LOCK_PARSE));
    }
    let enabled = value.get("Enabled").and_then(Value::as_bool).unwrap_or(false);
    let public_key = text(&value, "PublicKey");
    let trusted: Vec<&str> = value.get("TrustedKeys").and_then(Value::as_array).map(|keys| keys.iter().filter_map(|key| key.get("Key").and_then(Value::as_str)).collect()).unwrap_or_default();
    let needs_signature = value
        .get("FilteredPeers")
        .and_then(Value::as_array)
        .map(|peers| {
            peers
                .iter()
                .filter_map(|peer| {
                    let node_key = text(peer, "NodeKey");
                    let name = text(peer, "Name")
                        .or_else(|| peer.get("TailscaleIPs").and_then(Value::as_array).and_then(|ips| ips.first()).and_then(Value::as_str).map(str::to_owned))
                        .or_else(|| node_key.clone())?;
                    Some(LockPeer { name, node_key })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(TsLock {
        enabled,
        this_key_trusted: enabled.then(|| public_key.as_deref().is_some_and(|key| trusted.contains(&key))),
        public_key,
        node_key_signed: enabled.then(|| value.get("NodeKeySigned").and_then(Value::as_bool).unwrap_or(false)),
        trusted_keys: trusted.len(),
        needs_signature,
    })
}

/// CLI가 없으면 `None`(패널을 숨긴다). 있으면 `lock status --json`을 읽는다.
pub async fn lock_status() -> Result<Option<TsLock>, AppError> {
    let Some(path) = cli::locate().await else { return Ok(None) };
    let json = cli::lock_status_json(&path).await.map_err(AppError::other)?;
    shape_lock(&json).map(Some)
}

/// 생성 결과에는 일회성 비밀값이 들어 있으므로 기록하거나 Debug로 출력하지 않는다.
pub async fn create_or_update(state: &TailscaleState, tailnet: &str, id: Option<&str>, body: Value) -> Result<Value, AppError> {
    let kind = body.get("keyType").and_then(Value::as_str).unwrap_or("");
    let scope = match kind {
        "auth" if id.is_none() => "auth_keys",
        "client" => "oauth_keys",
        "federated" => "federated_keys",
        _ => return Err(AppError::other("키 종류를 확인해 주세요")),
    };
    let (method, path) = match id {
        Some(id) => (Method::PUT, key_path(id)?),
        None => (Method::POST, "/tailnet/-/keys".to_owned()),
    };
    let before = if let Some(id) = id {
        let raw = detail(state, tailnet, id).await?;
        let mut old = serde_json::Map::new();
        for field in ["keyType", "description", "scopes", "tags", "issuer", "subject", "audience", "customClaimRules"] {
            if let Some(value) = raw.get(field) { old.insert(field.to_owned(), value.clone()); }
        }
        Some(Value::Object(old))
    } else { None };
    let result = state.request(tailnet, Request::new(method, &path, Scope::Write(scope)).json(body.clone())).await?.json()?;
    if let (Some(id), Some(before)) = (id, before) {
        let now = Utc::now();
        let mut after = serde_json::Map::new();
        for field in ["keyType", "description", "scopes", "tags", "issuer", "subject", "audience", "customClaimRules"] {
            if let Some(value) = body.get(field) { after.insert(field.to_owned(), value.clone()); }
        }
        let entry = changes::Entry {
            id: format!("key-update-{}", now.timestamp_nanos_opt().unwrap_or_default()),
            at: now.to_rfc3339(),
            tailnet: tailnet.into(),
            action: "key_update".into(),
            target: changes::Target { device_id: None, name: Some(id.into()) },
            summary: "키 설정을 바꿨어요".into(),
            before,
            after: Value::Object(after),
            undo_of: None,
            undone: false,
        };
        changes::record(state.changes_path(), &entry).map_err(|_| AppError::other("변경 기록을 저장하지 못했어요"))?;
    }
    Ok(result)
}

pub async fn detail(state: &TailscaleState, tailnet: &str, id: &str) -> Result<Value, AppError> {
    let mut value = state.get_json(tailnet, &key_path(id)?).await?;
    if let Some(object) = value.as_object_mut() { object.remove("key"); object.remove("secret"); }
    Ok(value)
}
