//! ArgoCD 서버 연결과 응답 파싱. 토큰은 키체인과 메모리에만 둔다.
mod app;
mod client;
pub(crate) mod change;
pub(crate) mod appset;
pub(crate) mod notify;
pub(crate) mod events;
pub(crate) mod stream;
pub(crate) mod diff;
pub(crate) mod history;
pub(crate) mod logs;
pub(crate) mod resource;
pub(crate) mod ops;
pub(crate) mod prom;
pub(crate) mod cluster;
pub(crate) mod usage;
pub(crate) mod deploys;
pub(crate) mod window;

pub use app::{argo_app_of, ArgoApp};
pub use client::{ArgocdSession, ArgocdState};

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

fn text<'a>(v: &'a Value, path: &str) -> Option<&'a str> {
    v.pointer(path).and_then(Value::as_str)
}

pub(crate) fn list<'a>(v: &'a Value, path: &str) -> &'a [Value] {
    v.pointer(path).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn app_set(v: &Value) -> Option<String> {
    list(v, "/metadata/ownerReferences")
        .iter()
        .find(|o| text(o, "/kind") == Some("ApplicationSet"))
        .and_then(|o| text(o, "/name"))
        .map(str::to_owned)
}

/// Application 목록 한 줄.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoAppRow {
    pub name: String,
    pub namespace: String,
    pub resource_version: String,
    pub values: BTreeMap<String, String>,
    /// Application 자체의 레이블(환경 추론·레이블 필터·묶기에 쓴다)
    pub labels: BTreeMap<String, String>,
    /// status.resources 요약(전체 리소스 색인용). 없으면 직렬화에서 빠진다.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub resources: Vec<ArgoResourceRef>,
    /// 앱이 쓰는 컨테이너 이미지(`status.summary.images`). 이미지 목록 지표에 쓴다. 없으면 직렬화에서 빠진다.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
}

/// 목록 행에 싣는 리소스 요약. 비어 있거나 거짓인 선택 필드는 직렬화에서 뺀다(앱 수백 개의 스트림 메시지를 줄이려고).
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoResourceRef {
    pub group: String,
    pub version: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub name: String,
    /// Sync 상태
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hook: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub requires_pruning: bool,
}

fn resource_refs(d: &Value) -> Vec<ArgoResourceRef> {
    let owned = |r: &Value, path: &str| text(r, path).filter(|s| !s.is_empty()).map(str::to_owned);
    let flag = |r: &Value, path: &str| r.pointer(path).and_then(Value::as_bool).unwrap_or(false);
    list(d, "/status/resources")
        .iter()
        .filter_map(|r| {
            Some(ArgoResourceRef {
                group: text(r, "/group").unwrap_or_default().to_owned(),
                version: text(r, "/version").unwrap_or_default().to_owned(),
                kind: owned(r, "/kind")?,
                namespace: owned(r, "/namespace"),
                name: owned(r, "/name")?,
                status: owned(r, "/status"),
                health: owned(r, "/health/status"),
                hook: flag(r, "/hook"),
                requires_pruning: flag(r, "/requiresPruning"),
            })
        })
        .collect()
}

/// Application 응답에서 목록 행을 만든다.
pub fn app_row(d: &Value) -> ArgoAppRow {
    let mut values = BTreeMap::new();
    for (key, value) in [
        ("sync", text(d, "/status/sync/status")),
        ("health", text(d, "/status/health/status")),
        ("project", text(d, "/spec/project")),
        ("destNamespace", text(d, "/spec/destination/namespace")),
        ("operation", text(d, "/status/operationState/phase")),
        ("lastSync", text(d, "/status/operationState/finishedAt")),
        ("destination", text(d, "/spec/destination/name").or_else(|| text(d, "/spec/destination/server"))),
    ] {
        if let Some(value) = value {
            values.insert(key.to_owned(), value.to_owned());
        }
    }
    let single_revision = text(d, "/status/sync/revision");
    let revisions: Vec<_> = single_revision.into_iter().chain(
        list(d, "/status/sync/revisions").iter().filter_map(Value::as_str).filter(|_| single_revision.is_none()),
    ).map(|s| {
        if s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
            &s[..7]
        } else {
            s
        }
    }).collect();
    if !revisions.is_empty() {
        values.insert("revision".into(), revisions.join(", "));
    }
    let targets: Vec<_> = text(d, "/spec/source/targetRevision").into_iter()
        .chain(list(d, "/spec/sources").iter().filter_map(|s| text(s, "/targetRevision")))
        .collect();
    if !targets.is_empty() {
        values.insert("targetRevision".into(), targets.join(", "));
    }
    values.insert("autoSync".into(), d.pointer("/spec/syncPolicy/automated").is_some_and(|x| !x.is_null()).to_string());
    let automated_flag = |key: &str| d.pointer(&format!("/spec/syncPolicy/automated/{key}")).and_then(Value::as_bool).unwrap_or(false).to_string();
    values.insert("selfHeal".into(), automated_flag("selfHeal"));
    values.insert("autoPrune".into(), automated_flag("prune"));
    if let Some(name) = app_set(d) {
        values.insert("appSet".into(), name);
    }
    for (key, needle) in [("errors", "Error"), ("warnings", "Warning")] {
        let count = list(d, "/status/conditions").iter()
            .filter(|c| text(c, "/type").is_some_and(|t| t.contains(needle)))
            .count();
        if count > 0 {
            values.insert(key.into(), count.to_string());
        }
    }
    ArgoAppRow {
        name: text(d, "/metadata/name").unwrap_or_default().into(),
        namespace: text(d, "/metadata/namespace").unwrap_or_default().into(),
        resource_version: text(d, "/metadata/resourceVersion").unwrap_or_default().into(),
        values,
        resources: resource_refs(d),
        images: list(d, "/status/summary/images").iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        labels: d.pointer("/metadata/labels")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// ApplicationSet 목록 한 줄.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoAppSetRow {
    pub name: String,
    pub namespace: String,
    pub status: Option<String>,
    pub message: Option<String>,
    pub generators: Vec<String>,
}

/// ApplicationSet 응답에서 목록 행을 만든다.
pub fn appset_row(d: &Value) -> ArgoAppSetRow {
    let conditions = list(d, "/status/conditions");
    let error = conditions.iter().find(|c| text(c, "/type") == Some("ErrorOccurred") && text(c, "/status") == Some("True"));
    let status = if error.is_some() {
        Some("Error")
    } else if conditions.iter().any(|c| text(c, "/type") == Some("ResourcesUpToDate") && text(c, "/status") == Some("True")) {
        Some("UpToDate")
    } else {
        None
    };
    ArgoAppSetRow {
        name: text(d, "/metadata/name").unwrap_or_default().into(),
        namespace: text(d, "/metadata/namespace").unwrap_or_default().into(),
        status: status.map(str::to_owned),
        message: error.and_then(|c| text(c, "/message")).map(str::to_owned),
        generators: list(d, "/spec/generators").iter().filter_map(Value::as_object).flat_map(|g| g.keys().cloned()).collect(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoNetworkingInfo {
    pub target_labels: std::collections::HashMap<String, String>,
    pub target_refs: Vec<ArgoNetworkRef>,
    pub labels: std::collections::HashMap<String, String>,
    pub ingress: Vec<ArgoNetworkIngress>,
    #[serde(rename = "externalURLs")]
    pub external_urls: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoNetworkRef {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    pub uid: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ArgoNetworkIngress {
    pub hostname: Option<String>,
    pub ip: Option<String>,
}

/// 서버 리소스 트리의 노드.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoTreeNode {
    pub uid: String,
    pub group: String,
    pub version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    pub parents: Vec<String>,
    pub health: Option<String>,
    pub health_message: Option<String>,
    pub info: Vec<String>,
    pub images: Vec<String>,
    pub networking_info: Option<ArgoNetworkingInfo>,
    pub created_at: Option<String>,
}

/// 서버 리소스 트리 응답에서 노드를 만든다.
pub fn tree_node(d: &Value) -> ArgoTreeNode {
    let s = |p| text(d, p).unwrap_or_default().to_owned();
    let opt = |p| text(d, p).map(str::to_owned);
    let networking_info = d.pointer("/networkingInfo").filter(|v| v.is_object()).map(|n| {
        let labels = |path| n.pointer(path).and_then(Value::as_object).into_iter().flat_map(|m| m.iter())
            .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned()))).collect();
        ArgoNetworkingInfo {
            target_labels: labels("/targetLabels"),
            labels: labels("/labels"),
            target_refs: list(n, "/targetRefs").iter().map(|r| ArgoNetworkRef {
                group: text(r, "/group").unwrap_or_default().into(),
                version: text(r, "/version").unwrap_or_default().into(),
                kind: text(r, "/kind").unwrap_or_default().into(),
                namespace: text(r, "/namespace").map(str::to_owned),
                name: text(r, "/name").unwrap_or_default().into(),
                uid: text(r, "/uid").map(str::to_owned),
            }).collect(),
            ingress: list(n, "/ingress").iter().map(|i| ArgoNetworkIngress {
                hostname: text(i, "/hostname").map(str::to_owned),
                ip: text(i, "/ip").map(str::to_owned),
            }).collect(),
            external_urls: list(n, "/externalURLs").iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        }
    });
    ArgoTreeNode {
        uid: s("/uid"),
        group: s("/group"),
        version: s("/version"),
        kind: s("/kind"),
        namespace: opt("/namespace"),
        name: s("/name"),
        parents: list(d, "/parentRefs").iter().filter_map(|p| text(p, "/uid").map(str::to_owned)).collect(),
        health: opt("/health/status"),
        health_message: opt("/health/message"),
        info: list(d, "/info").iter().map(|i| format!("{}: {}", text(i, "/name").unwrap_or_default(), text(i, "/value").unwrap_or_default())).collect(),
        images: list(d, "/images").iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        networking_info,
        created_at: opt("/createdAt"),
    }
}


#[cfg(test)]
mod tests;

#[cfg(test)]
mod live_tests;
