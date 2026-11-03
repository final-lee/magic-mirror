//! Helm 릴리스 저장소(Secret `helm.sh/release.v1`, ConfigMap)의 `release` 데이터를 푼다.
//! 저장 방식: JSON → gzip → base64. Secret은 거기에 쿠버네티스의 base64가 한 겹 더 있다(kube가 `ByteString`으로 한 겹을 벗긴다).
//! 클러스터에 닿지 않는 순수 코드다.
use std::io::Read;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use flate2::read::GzDecoder;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use crate::error::AppError;

/// Secret 저장소의 `type`
pub const SECRET_TYPE: &str = "helm.sh/release.v1";
/// 두 저장소 모두 이 라벨로 helm이 만든 것을 알아본다
pub const OWNER_SELECTOR: &str = "owner=helm";
pub const UNREADABLE: &str = "릴리스 데이터를 읽지 못했어요";
/// 풀린 JSON의 한도. 이보다 크면 압축 폭탄으로 보고 거절한다(Secret은 1MiB라 정상 릴리스는 훨씬 작다)
const DECODED_MAX: u64 = 64 * 1024 * 1024;
const GZIP_MAGIC: [u8; 3] = [0x1f, 0x8b, 0x08];

/// Go가 빈 목록·빈 글을 `null`로 저장하는 필드(`files`, `hooks`, `dependencies` 등)도 기본값으로 읽는다
fn null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// 릴리스가 저장된 곳. helm은 `HELM_DRIVER`로 하나를 고른다(기본 secret).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Driver {
    Secret,
    ConfigMap,
}

impl Driver {
    /// `HELM_DRIVER` 값
    pub fn env_value(self) -> &'static str {
        match self {
            Driver::Secret => "secret",
            Driver::ConfigMap => "configmap",
        }
    }
}

/// 저장소 객체 이름: `sh.helm.release.v1.<이름>.v<리비전>`(Secret), `<이름>.v<리비전>`(ConfigMap)
pub fn object_name(driver: Driver, name: &str, revision: u32) -> String {
    match driver {
        Driver::Secret => format!("sh.helm.release.v1.{name}.v{revision}"),
        Driver::ConfigMap => format!("{name}.v{revision}"),
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Info {
    #[serde(default)]
    pub first_deployed: Option<String>,
    #[serde(default)]
    pub last_deployed: Option<String>,
    #[serde(default, deserialize_with = "null_default")]
    pub description: String,
    #[serde(default, deserialize_with = "null_default")]
    pub status: String,
    #[serde(default, deserialize_with = "null_default")]
    pub notes: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Hook {
    #[serde(default, deserialize_with = "null_default")]
    pub name: String,
    #[serde(default, deserialize_with = "null_default")]
    pub kind: String,
    #[serde(default, deserialize_with = "null_default")]
    pub events: Vec<String>,
}

/// 차트 안의 파일 하나. `data`는 base64(Go의 `[]byte`)다.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct File {
    pub name: String,
    #[serde(default, deserialize_with = "null_default")]
    pub data: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Chart {
    /// Chart.yaml의 내용. 키 이름은 Chart.yaml과 같다(`appVersion` 등)
    #[serde(default)]
    pub metadata: Value,
    #[serde(default, deserialize_with = "null_default")]
    pub templates: Vec<File>,
    /// 차트의 기본값(values.yaml)
    #[serde(default)]
    pub values: Option<Value>,
    /// values.schema.json(base64)
    #[serde(default)]
    pub schema: Option<String>,
    /// templates 밖의 파일: 보통 파일, `crds/`, README 등
    #[serde(default, deserialize_with = "null_default")]
    pub files: Vec<File>,
    #[serde(default, deserialize_with = "null_default")]
    pub dependencies: Vec<Chart>,
}

impl Chart {
    fn text(&self, key: &str) -> String {
        self.metadata.get(key).and_then(Value::as_str).unwrap_or("").to_string()
    }

    pub fn name(&self) -> String {
        self.text("name")
    }

    pub fn version(&self) -> String {
        self.text("version")
    }

    pub fn app_version(&self) -> String {
        self.text("appVersion")
    }

    /// `이름-버전`(`helm list`의 CHART 열과 같은 꼴)
    pub fn label(&self) -> String {
        let (name, version) = (self.name(), self.version());
        if version.is_empty() {
            name
        } else {
            format!("{name}-{version}")
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct Release {
    pub name: String,
    #[serde(default, deserialize_with = "null_default")]
    pub namespace: String,
    pub version: u32,
    #[serde(default)]
    pub info: Info,
    #[serde(default)]
    pub chart: Chart,
    /// 사용자가 준 values(`--set`·`-f`를 합친 것). 없으면 null이거나 빈 맵
    #[serde(default)]
    pub config: Option<Value>,
    #[serde(default, deserialize_with = "null_default")]
    pub manifest: String,
    #[serde(default, deserialize_with = "null_default")]
    pub hooks: Vec<Hook>,
}

impl Release {
    /// 사용자가 준 values. 없으면 빈 맵
    pub fn user_values(&self) -> Value {
        match &self.config {
            Some(Value::Object(map)) => Value::Object(map.clone()),
            _ => Value::Object(Map::new()),
        }
    }

    /// 차트 기본값 위에 사용자 값을 얹은 값(`helm get values --all`)
    pub fn computed_values(&self) -> Value {
        coalesce(&self.chart, &self.user_values())
    }
}

/// 문제가 있는 상태: 실패했거나 끝나지 않은 작업이 걸려 있다.
/// `uninstalled`(이력만 남김)와 `superseded`(옛 리비전)는 문제가 아니다.
pub fn is_problem(status: &str) -> bool {
    matches!(status, "failed" | "unknown" | "uninstalling") || status.starts_with("pending-")
}

/// 저장소의 `release` 데이터(base64 글자)를 푼다.
pub fn decode(payload: &[u8]) -> Result<Release, AppError> {
    let text: Vec<u8> = payload.iter().copied().filter(|b| !b.is_ascii_whitespace()).collect();
    let bytes = STANDARD.decode(text).map_err(|_| AppError::other(UNREADABLE))?;
    let json = if bytes.starts_with(&GZIP_MAGIC) {
        let mut out = Vec::new();
        GzDecoder::new(bytes.as_slice()).take(DECODED_MAX + 1).read_to_end(&mut out).map_err(|_| AppError::other(UNREADABLE))?;
        if out.len() as u64 > DECODED_MAX {
            return Err(AppError::other(UNREADABLE));
        }
        out
    } else {
        bytes
    };
    serde_json::from_slice(&json).map_err(|_| AppError::other(UNREADABLE))
}

/// 두 값을 합친다. 맵은 안쪽까지 합치고, 그 밖의 값은 `over`가 이긴다. `over`의 null은 키를 지운다(helm과 같다).
pub fn merge(base: &Value, over: &Value) -> Value {
    let (Value::Object(base), Value::Object(over)) = (base, over) else {
        return over.clone();
    };
    let mut out = base.clone();
    for (key, value) in over {
        if value.is_null() {
            out.remove(key);
        } else if let Some(old) = out.get(key) {
            let merged = merge(old, value);
            out.insert(key.clone(), merged);
        } else {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

/// 차트 기본값 + 사용자 값. 서브차트는 부모 값의 서브차트 이름 아래 값을 받아 같은 방식으로 합친다.
pub fn coalesce(chart: &Chart, config: &Value) -> Value {
    let base = chart.values.clone().unwrap_or_else(|| Value::Object(Map::new()));
    let mut merged = merge(&base, config);
    for dependency in &chart.dependencies {
        let name = dependency.name();
        let given = merged.get(&name).filter(|v| v.is_object()).cloned().unwrap_or_else(|| Value::Object(Map::new()));
        let sub = coalesce(dependency, &given);
        if let Value::Object(map) = &mut merged {
            map.insert(name, sub);
        }
    }
    merged
}

#[cfg(test)]
mod tests;
