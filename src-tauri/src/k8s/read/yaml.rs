//! 보기용 YAML. managedFields를 빼고(status는 둔다), Secret이면 값을 가린 뒤 kubectl 순서(apiVersion, kind, metadata, 나머지, status)로 쓴다.
use serde::ser::{SerializeMap, Serializer};
use serde::Serialize;
use serde_json::Value;

use super::secret::{is_secret, mask, LAST_APPLIED};
use crate::error::AppError;
use crate::k8s::change::clean_object;
use crate::k8s::rows::KindRef;

/// 직렬화 오류의 글에는 값 조각이 실릴 수 있어 고정 문구만 쓴다
pub const YAML_FAILED: &str = "YAML로 바꾸지 못했어요";
const FIRST: [&str; 3] = ["apiVersion", "kind", "metadata"];
const LAST: &str = "status";

pub fn view_yaml(kind: &KindRef, obj: &Value) -> Result<String, AppError> {
    let mut v = obj.clone();
    if let Some(Value::Object(meta)) = v.get_mut("metadata") {
        meta.remove("managedFields");
    }
    if is_secret(kind) {
        mask(&mut v);
    }
    serde_saphyr::to_string(&Ordered(&v)).map_err(|_| AppError::other(YAML_FAILED))
}

/// 편집기에 넣는 YAML. 서버가 채우는 필드(status, managedFields, uid, resourceVersion, creationTimestamp, generation 등)는 뺀다.
/// Secret은 `data`·`stringData`와 last-applied 어노테이션도 뺀다: 값은 키별로 따로 보고 고치고, 건드리지 않은 키는 적용할 때 현재 값 그대로 둔다.
pub fn edit_yaml(kind: &KindRef, obj: &Value) -> Result<String, AppError> {
    let mut v = clean_object(obj.clone());
    if is_secret(kind) {
        if let Some(root) = v.as_object_mut() {
            root.remove("data");
            root.remove("stringData");
        }
        if let Some(Value::Object(annotations)) = v.pointer_mut("/metadata/annotations") {
            annotations.remove(LAST_APPLIED);
        }
        if v.pointer("/metadata/annotations").and_then(Value::as_object).is_some_and(|a| a.is_empty()) {
            if let Some(Value::Object(meta)) = v.get_mut("metadata") {
                meta.remove("annotations");
            }
        }
    }
    serde_saphyr::to_string(&Ordered(&v)).map_err(|_| AppError::other(YAML_FAILED))
}

/// 맨 위 키만 kubectl 순서로 쓴다. 안쪽은 원래(이름) 순서.
struct Ordered<'a>(&'a Value);

impl Serialize for Ordered<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let Value::Object(m) = self.0 else { return self.0.serialize(s) };
        let rank = |k: &str| match FIRST.iter().position(|f| *f == k) {
            Some(i) => i,
            None if k == LAST => FIRST.len() + 1,
            None => FIRST.len(),
        };
        let mut keys: Vec<&String> = m.keys().collect();
        keys.sort_by_key(|k| rank(k));
        let mut map = s.serialize_map(Some(m.len()))?;
        for k in keys {
            map.serialize_entry(k, &m[k])?;
        }
        map.end()
    }
}

#[cfg(test)]
mod tests;
