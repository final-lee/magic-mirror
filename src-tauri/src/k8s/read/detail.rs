//! 상세: 요약 줄, 소유 관계(위: ownerReferences, 아래: 알려진 자식 종류), 컨테이너, 상태 조건, 관련 이벤트, 보기용 YAML.
//! Secret은 키 크기를 센 뒤 JSON을 가리고, 어노테이션·YAML은 모두 가린 JSON에서 만든다.
use std::collections::BTreeMap;

use kube::api::{DynamicObject, ListParams};
use kube::Client;
use serde::Serialize;
use serde_json::Value;

use super::secret::{is_secret, keys, mask, SecretKey};
use super::values::{event_count, event_last_seen, event_object, list, text, Problem};
use super::yaml::{view_yaml, YAML_FAILED};
use super::{api_for, bounded};
use crate::error::AppError;
use crate::k8s::failure::Endpoint;
use crate::k8s::rows::{row_of, KindRef, Row};

pub const CHILDREN_MAX: u32 = 500;
pub const EVENTS_MAX: usize = 100;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub uid: String,
    pub controller: bool,
    pub problems: Vec<Problem>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Termination {
    pub reason: Option<String>,
    pub exit_code: i64,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContainerState {
    Running,
    Waiting,
    Terminated,
    Unknown,
    /// 워크로드의 Pod 템플릿에서 읽은 컨테이너(상태 없음)
    Template,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub name: String,
    pub image: String,
    pub init: bool,
    pub state: ContainerState,
    pub ready: bool,
    pub restarts: i64,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub last_termination: Option<Termination>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    #[serde(rename = "type")]
    pub type_: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub last_transition: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventView {
    #[serde(rename = "type")]
    pub type_: String,
    pub reason: String,
    pub message: String,
    pub count: i64,
    pub last_seen: Option<String>,
    pub source: Option<String>,
    pub object: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectView {
    pub kind: KindRef,
    pub row: Row,
    pub annotations: BTreeMap<String, String>,
    pub owners: Vec<Link>,
    pub children: Vec<Link>,
    pub children_truncated: bool,
    pub children_error: Option<AppError>,
    pub containers: Vec<Container>,
    pub conditions: Vec<Condition>,
    pub events: Vec<EventView>,
    pub events_error: Option<AppError>,
    pub yaml: String,
    pub secret_keys: Option<Vec<SecretKey>>,
}

fn opt(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

pub fn split_api_version(v: &str) -> (String, String) {
    match v.split_once('/') {
        Some((g, ver)) => (g.to_string(), ver.to_string()),
        None => (String::new(), v.to_string()),
    }
}

pub fn owners_of(obj: &DynamicObject) -> Vec<Link> {
    obj.metadata
        .owner_references
        .iter()
        .flatten()
        .map(|o| {
            let (group, version) = split_api_version(&o.api_version);
            Link { group, version, kind: o.kind.clone(), name: o.name.clone(), namespace: obj.metadata.namespace.clone(), uid: o.uid.clone(), controller: o.controller == Some(true), problems: vec![] }
        })
        .collect()
}

pub fn child_kind(kind: &KindRef) -> Option<KindRef> {
    let k = |group: &str, kind: &str, plural: &str| KindRef { group: group.into(), version: "v1".into(), kind: kind.into(), plural: plural.into(), namespaced: true };
    match (kind.group.as_str(), kind.kind.as_str()) {
        ("apps", "Deployment") => Some(k("apps", "ReplicaSet", "replicasets")),
        ("apps", "ReplicaSet" | "StatefulSet" | "DaemonSet") | ("batch", "Job") => Some(k("", "Pod", "pods")),
        ("batch", "CronJob") => Some(k("batch", "Job", "jobs")),
        _ => None,
    }
}

/// 자식 목록을 좁히는 레이블 셀렉터. matchLabels만 쓴다(matchExpressions는 빼서 넓게 받고 소유자 uid로 거른다).
pub fn selector_of(obj: &Value) -> Option<String> {
    let m = obj.pointer("/spec/selector/matchLabels").and_then(Value::as_object).filter(|m| !m.is_empty())?;
    Some(m.iter().map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or(""))).collect::<Vec<_>>().join(","))
}

pub fn children_of(child: &KindRef, owner_uid: &str, items: &[DynamicObject]) -> Vec<Link> {
    let mut out: Vec<Link> = items
        .iter()
        .filter(|o| o.metadata.owner_references.iter().flatten().any(|r| r.uid == owner_uid))
        .map(|o| Link {
            group: child.group.clone(),
            version: child.version.clone(),
            kind: child.kind.clone(),
            name: o.metadata.name.clone().unwrap_or_default(),
            namespace: o.metadata.namespace.clone(),
            uid: o.metadata.uid.clone().unwrap_or_default(),
            controller: false,
            problems: row_of(child, o).problems,
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn state_of(status: Option<&Value>) -> (ContainerState, Option<String>, Option<String>) {
    let Some(st) = status.and_then(|s| s.get("state")) else { return (ContainerState::Unknown, None, None) };
    if st.get("running").is_some() {
        return (ContainerState::Running, None, None);
    }
    if let Some(w) = st.get("waiting") {
        return (ContainerState::Waiting, opt(w, "reason"), opt(w, "message"));
    }
    if let Some(t) = st.get("terminated") {
        return (ContainerState::Terminated, opt(t, "reason"), opt(t, "message"));
    }
    (ContainerState::Unknown, None, None)
}

fn termination(status: Option<&Value>) -> Option<Termination> {
    let t = status?.pointer("/lastState/terminated")?;
    Some(Termination { reason: opt(t, "reason"), exit_code: t["exitCode"].as_i64().unwrap_or(0), finished_at: opt(t, "finishedAt") })
}

fn pod_containers(d: &Value, spec_path: &str, status_path: &str, init: bool) -> Vec<Container> {
    let statuses = list(d, status_path);
    list(d, spec_path)
        .iter()
        .map(|c| {
            let status = statuses.iter().find(|s| s["name"] == c["name"]);
            let (state, reason, message) = state_of(status);
            Container {
                name: opt(c, "name").unwrap_or_default(),
                image: opt(c, "image").unwrap_or_default(),
                init,
                state,
                ready: status.and_then(|s| s["ready"].as_bool()).unwrap_or(false),
                restarts: status.and_then(|s| s["restartCount"].as_i64()).unwrap_or(0),
                reason,
                message,
                last_termination: termination(status),
            }
        })
        .collect()
}

/// Pod는 상태까지, 워크로드는 Pod 템플릿의 이름과 이미지만
pub fn containers_of(kind: &KindRef, d: &Value) -> Vec<Container> {
    if kind.group.is_empty() && kind.kind == "Pod" {
        let mut out = pod_containers(d, "/spec/initContainers", "/status/initContainerStatuses", true);
        out.extend(pod_containers(d, "/spec/containers", "/status/containerStatuses", false));
        return out;
    }
    let spec = match (kind.group.as_str(), kind.kind.as_str()) {
        ("apps", "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet") | ("batch", "Job") => "/spec/template/spec",
        ("batch", "CronJob") => "/spec/jobTemplate/spec/template/spec",
        _ => return vec![],
    };
    let template = |path: &str, init: bool| -> Vec<Container> {
        list(d, &format!("{spec}{path}"))
            .iter()
            .map(|c| Container {
                name: opt(c, "name").unwrap_or_default(),
                image: opt(c, "image").unwrap_or_default(),
                init,
                state: ContainerState::Template,
                ready: false,
                restarts: 0,
                reason: None,
                message: None,
                last_termination: None,
            })
            .collect()
    };
    let mut out = template("/initContainers", true);
    out.extend(template("/containers", false));
    out
}

pub fn conditions_of(d: &Value) -> Vec<Condition> {
    list(d, "/status/conditions")
        .iter()
        .map(|c| Condition {
            type_: opt(c, "type").unwrap_or_default(),
            status: opt(c, "status").unwrap_or_default(),
            reason: opt(c, "reason"),
            message: opt(c, "message"),
            last_transition: opt(c, "lastTransitionTime"),
        })
        .collect()
}

pub fn events_kind() -> KindRef {
    KindRef { group: String::new(), version: "v1".into(), kind: "Event".into(), plural: "events".into(), namespaced: true }
}

pub fn events_of(items: &[DynamicObject]) -> Vec<EventView> {
    let mut out: Vec<EventView> = items
        .iter()
        .map(|o| {
            let d = &o.data;
            EventView {
                type_: text(d, "/type").unwrap_or("Normal").to_string(),
                reason: text(d, "/reason").unwrap_or("").to_string(),
                message: text(d, "/message").unwrap_or("").to_string(),
                count: event_count(d),
                last_seen: event_last_seen(o),
                source: text(d, "/source/component").or_else(|| text(d, "/reportingComponent")).filter(|s| !s.is_empty()).map(str::to_string),
                object: event_object(d),
            }
        })
        .collect();
    out.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    out.truncate(EVENTS_MAX);
    out
}

/// 객체 하나에서 만들 수 있는 것. 자식과 이벤트는 `get`이 따로 채운다.
pub fn view_of(kind: &KindRef, obj: &DynamicObject) -> Result<ObjectView, AppError> {
    let mut json = serde_json::to_value(obj).map_err(|_| AppError::other(YAML_FAILED))?;
    let secret_keys = is_secret(kind).then(|| keys(&json));
    if is_secret(kind) {
        mask(&mut json);
    }
    let annotations = json
        .pointer("/metadata/annotations")
        .and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect())
        .unwrap_or_default();
    Ok(ObjectView {
        kind: kind.clone(),
        row: row_of(kind, obj),
        annotations,
        owners: owners_of(obj),
        children: vec![],
        children_truncated: false,
        children_error: None,
        containers: containers_of(kind, &json),
        conditions: conditions_of(&json),
        events: vec![],
        events_error: None,
        yaml: view_yaml(kind, &json)?,
        secret_keys,
    })
}

async fn children(client: &Client, kind: &KindRef, obj: &DynamicObject, endpoint: Endpoint) -> Result<(Vec<Link>, bool), AppError> {
    let Some(child) = child_kind(kind) else { return Ok((vec![], false)) };
    let mut lp = ListParams::default().limit(CHILDREN_MAX);
    let selector = selector_of(&obj.data);
    if let Some(s) = &selector {
        lp = lp.labels(s);
    }
    let api = api_for(client.clone(), &child, obj.metadata.namespace.as_deref());
    let page = bounded(api.list(&lp), "list", &child.plural, endpoint).await?;
    let uid = obj.metadata.uid.clone().unwrap_or_default();
    let truncated = page.metadata.continue_.as_deref().is_some_and(|c| !c.is_empty());
    Ok((children_of(&child, &uid, &page.items), truncated))
}

async fn events(client: &Client, uid: &str, namespace: Option<&str>, endpoint: Endpoint) -> Result<Vec<EventView>, AppError> {
    let lp = ListParams::default().fields(&format!("involvedObject.uid={uid}")).limit(EVENTS_MAX as u32);
    let page = bounded(api_for(client.clone(), &events_kind(), namespace).list(&lp), "list", "events", endpoint).await?;
    Ok(events_of(&page.items))
}

/// 객체를 읽고(실패하면 명령도 실패), 자식과 이벤트를 함께 읽는다(실패는 각자 오류 칸에 둔다)
pub async fn get(client: &Client, kind: &KindRef, namespace: Option<&str>, name: &str, endpoint: Endpoint) -> Result<ObjectView, AppError> {
    let api = api_for(client.clone(), kind, namespace);
    let obj = bounded(api.get(name), "get", &kind.plural, endpoint).await?;
    let mut view = view_of(kind, &obj)?;
    let uid = view.row.uid.clone();
    let (kids, evs) = tokio::join!(children(client, kind, &obj, endpoint), events(client, &uid, obj.metadata.namespace.as_deref(), endpoint));
    match kids {
        Ok((links, truncated)) => {
            view.children = links;
            view.children_truncated = truncated;
        }
        Err(e) => view.children_error = Some(e),
    }
    match evs {
        Ok(e) => view.events = e,
        Err(e) => view.events_error = Some(e),
    }
    Ok(view)
}

#[cfg(test)]
mod tests;
