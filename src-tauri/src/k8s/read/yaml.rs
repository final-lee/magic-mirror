//! 보기용 YAML. managedFields를 빼고(status는 둔다), Secret이면 값을 가린 뒤 kubectl 순서(apiVersion, kind, metadata, 나머지, status)로 쓴다.
use serde::ser::{SerializeMap, Serializer};
use serde::Serialize;
use serde_json::Value;

use super::secret::{is_secret, mask};
use crate::error::AppError;
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
