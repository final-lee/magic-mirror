//! Secret 값 다루기. 값은 `k8s_secret_value`(`secret_value`)로만 나간다. 상세·YAML에서는 가리고(`mask`), 오류에는 키 이름까지만 넣는다.
use std::fmt;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use kube::Client;
use serde::Serialize;
use serde_json::Value;

use super::{api_for, bounded};
use crate::error::AppError;
use crate::k8s::failure::Endpoint;
use crate::k8s::rows::KindRef;

pub const MASK: &str = "••••";
/// `kubectl apply`가 남기는 어노테이션. Secret이면 그 안에 값이 그대로 들어 있다.
pub const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";
pub const SECRET_UNREADABLE: &str = "Secret 값을 해석하지 못했어요";

pub fn key_missing(key: &str) -> String {
    format!("이 Secret에 {key} 키가 없어요")
}

pub fn is_secret(kind: &KindRef) -> bool {
    kind.group.is_empty() && kind.kind == "Secret"
}

pub fn secrets_kind() -> KindRef {
    KindRef { group: String::new(), version: "v1".into(), kind: "Secret".into(), plural: "secrets".into(), namespaced: true }
}

/// `data`, `stringData`의 모든 값과 last-applied 어노테이션을 `MASK`로 바꾼다. 키는 그대로 둔다.
pub fn mask(obj: &mut Value) {
    for field in ["data", "stringData"] {
        if let Some(Value::Object(m)) = obj.get_mut(field) {
            for v in m.values_mut() {
                *v = Value::String(MASK.into());
            }
        }
    }
    if let Some(Value::Object(a)) = obj.pointer_mut("/metadata/annotations") {
        if let Some(v) = a.get_mut(LAST_APPLIED) {
            *v = Value::String(MASK.into());
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretKey {
    pub key: String,
    pub size: u64,
}

/// 키와 값의 바이트 수. `data`는 base64를 풀어 잰다(풀지 못하면 글자 수). `stringData`는 서버가 돌려주지 않는 쓰기용 필드지만 있으면 센다.
pub fn keys(obj: &Value) -> Vec<SecretKey> {
    let mut out: Vec<SecretKey> = Vec::new();
    if let Some(m) = obj.get("data").and_then(Value::as_object) {
        for (k, v) in m {
            let s = v.as_str().unwrap_or("");
            let size = STANDARD.decode(s).map_or(s.len(), |b| b.len()) as u64;
            out.push(SecretKey { key: k.clone(), size });
        }
    }
    if let Some(m) = obj.get("stringData").and_then(Value::as_object) {
        for (k, v) in m {
            if !out.iter().any(|e| e.key == *k) {
                out.push(SecretKey { key: k.clone(), size: v.as_str().map_or(0, str::len) as u64 });
            }
        }
    }
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Encoding {
    Utf8,
    Base64,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretValue {
    pub text: String,
    pub encoding: Encoding,
}

/// 값이 로그나 패닉 글에 찍히지 않게 손으로 쓴다
impl fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretValue(••••)")
    }
}

/// 키 하나의 값. UTF-8이면 글로, 아니면 base64 그대로.
pub fn value_of(obj: &Value, key: &str) -> Result<SecretValue, AppError> {
    if let Some(s) = obj.get("data").and_then(|d| d.get(key)).and_then(Value::as_str) {
        let bytes = STANDARD.decode(s).map_err(|_| AppError::other(SECRET_UNREADABLE))?;
        return Ok(match String::from_utf8(bytes) {
            Ok(text) => SecretValue { text, encoding: Encoding::Utf8 },
            Err(_) => SecretValue { text: s.to_string(), encoding: Encoding::Base64 },
        });
    }
    if let Some(s) = obj.get("stringData").and_then(|d| d.get(key)).and_then(Value::as_str) {
        return Ok(SecretValue { text: s.to_string(), encoding: Encoding::Utf8 });
    }
    Err(AppError::other(key_missing(key)))
}

/// 누를 때마다 서버에서 읽는다(캐시하지 않는다)
pub async fn secret_value(client: &Client, namespace: &str, name: &str, key: &str, endpoint: Endpoint) -> Result<SecretValue, AppError> {
    let api = api_for(client.clone(), &secrets_kind(), Some(namespace));
    let obj = bounded(api.get(name), "get", "secrets", endpoint).await?;
    value_of(&obj.data, key)
}

#[cfg(test)]
mod tests;
