//! 목록 한 줄. 모든 종류에 공통인 메타데이터와, 종류별로 화면에 보일 값(`values`). 종류별 값은 단계마다 여기에 더한다.
use std::collections::BTreeMap;

use k8s_openapi::jiff::Timestamp;
use kube::api::DynamicObject;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindRef {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub namespaced: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub uid: String,
    pub name: String,
    pub namespace: Option<String>,
    pub resource_version: String,
    pub created_at: Option<String>,
    pub labels: BTreeMap<String, String>,
    pub values: BTreeMap<String, String>,
}

/// 초 단위로 자르고 `Z`로 끝나는 RFC 3339 글
fn rfc3339_secs(t: &Timestamp) -> String {
    Timestamp::from_second(t.as_second()).map_or_else(|_| t.to_string(), |s| s.to_string())
}

pub fn row_of(kind: &KindRef, obj: &DynamicObject) -> Row {
    let m = &obj.metadata;
    let mut values = BTreeMap::new();
    if kind.group.is_empty() && kind.kind == "Namespace" {
        if let Some(phase) = obj.data.pointer("/status/phase").and_then(|v| v.as_str()) {
            values.insert("status".to_string(), phase.to_string());
        }
    }
    Row {
        uid: m.uid.clone().unwrap_or_default(),
        name: m.name.clone().unwrap_or_default(),
        namespace: m.namespace.clone(),
        resource_version: m.resource_version.clone().unwrap_or_default(),
        created_at: m.creation_timestamp.as_ref().map(|t| rfc3339_secs(&t.0)),
        labels: m.labels.clone().unwrap_or_default().into_iter().collect(),
        values,
    }
}

#[cfg(test)]
mod tests;
