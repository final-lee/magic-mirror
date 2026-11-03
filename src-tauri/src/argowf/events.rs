//! Workflow Event Binding과 Argo Events(EventSource·Sensor) 목록. Argo Events가 없는 클러스터는 서버가 404
//! ("the server could not find the requested resource (get eventsources.argoproj.io)")를 주는데, 이것을 고정 문구로 바꾼다.
use reqwest::Method;
use serde::Serialize;
use serde_json::Value;

use super::client::{Server, State};
use crate::error::AppError;
use crate::k8s::read::yaml::view_yaml;
use crate::k8s::rows::KindRef;

pub const ARGO_EVENTS_MISSING: &str = "이 클러스터에 Argo Events가 없어요";

/// EventSource spec에서 이벤트 종류가 아닌 칸
const SOURCE_NON_TYPES: [&str; 5] = ["template", "service", "eventBusName", "replicas", "filter"];

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRef {
    pub name: String,
    pub cluster_scope: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventBindingRow {
    pub namespace: String,
    pub name: String,
    pub selector: String,
    pub template: Option<TemplateRef>,
    pub parameters: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventSourceRow {
    pub namespace: String,
    pub name: String,
    pub types: Vec<String>,
    pub event_names: Vec<String>,
    pub status: Option<String>,
    pub message: Option<String>,
    pub yaml: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub name: String,
    pub event_source_name: String,
    pub event_name: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trigger {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub target: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SensorRow {
    pub namespace: String,
    pub name: String,
    pub dependencies: Vec<Dependency>,
    pub triggers: Vec<Trigger>,
    pub status: Option<String>,
    pub message: Option<String>,
    pub yaml: String,
}

fn text(v: &Value, path: &str) -> Option<String> {
    v.pointer(path).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

fn items<'a>(v: &'a Value, path: &str) -> &'a [Value] {
    v.pointer(path).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn kind_ref(kind: &str, plural: &str) -> KindRef {
    KindRef {
        group: "argoproj.io".into(),
        version: "v1alpha1".into(),
        kind: kind.into(),
        plural: plural.into(),
        namespaced: true,
    }
}

/// 보기용 YAML(apiVersion·kind를 채우고 managedFields는 뺀다)
fn yaml(v: &Value, kind: &str, plural: &str) -> Result<String, AppError> {
    let mut obj = v.clone();
    if let Value::Object(m) = &mut obj {
        m.entry("apiVersion").or_insert_with(|| Value::String("argoproj.io/v1alpha1".into()));
        m.entry("kind").or_insert_with(|| Value::String(kind.into()));
    }
    view_yaml(&kind_ref(kind, plural), &obj)
}

/// 조건(conditions)을 한 줄로: 거짓인 조건이 있으면 그 종류와 메시지, 다 참이면 Deployed(또는 마지막 조건)
fn status_of(v: &Value) -> (Option<String>, Option<String>) {
    let conditions = items(v, "/status/conditions");
    if let Some(bad) = conditions.iter().find(|c| text(c, "/status").as_deref() != Some("True")) {
        return (text(bad, "/type").map(|t| format!("{t} 아님")), text(bad, "/message"));
    }
    let deployed = conditions
        .iter()
        .find(|c| text(c, "/type").as_deref() == Some("Deployed"))
        .or_else(|| conditions.last());
    (deployed.and_then(|c| text(c, "/type")), None)
}

pub fn binding_row(v: &Value) -> EventBindingRow {
    EventBindingRow {
        namespace: text(v, "/metadata/namespace").unwrap_or_default(),
        name: text(v, "/metadata/name").unwrap_or_default(),
        selector: text(v, "/spec/event/selector").unwrap_or_default(),
        template: text(v, "/spec/submit/workflowTemplateRef/name").map(|name| TemplateRef {
            name,
            cluster_scope: v
                .pointer("/spec/submit/workflowTemplateRef/clusterScope")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        parameters: items(v, "/spec/submit/arguments/parameters")
            .iter()
            .filter_map(|p| {
                let name = text(p, "/name")?;
                let value = text(p, "/valueFrom/event").or_else(|| text(p, "/value")).unwrap_or_default();
                Some(format!("{name}={value}"))
            })
            .collect(),
    }
}

pub fn source_row(v: &Value) -> Result<EventSourceRow, AppError> {
    let spec = v.pointer("/spec").and_then(Value::as_object);
    let mut types = Vec::new();
    let mut event_names = Vec::new();
    for (key, body) in spec.into_iter().flatten() {
        if SOURCE_NON_TYPES.contains(&key.as_str()) {
            continue;
        }
        if let Some(events) = body.as_object() {
            types.push(key.clone());
            event_names.extend(events.keys().cloned());
        }
    }
    let (status, message) = status_of(v);
    Ok(EventSourceRow {
        namespace: text(v, "/metadata/namespace").unwrap_or_default(),
        name: text(v, "/metadata/name").unwrap_or_default(),
        types,
        event_names,
        status,
        message,
        yaml: yaml(v, "EventSource", "eventsources")?,
    })
}

/// 트리거 하나: template 안에서 name·conditions가 아닌 칸이 종류다. 대상은 만드는 리소스(kind/이름) 또는 URL.
fn trigger_of(t: &Value) -> Option<Trigger> {
    let template = t.get("template")?.as_object()?;
    let name = template.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    let (kind, body) = template
        .iter()
        .find(|(k, v)| !matches!(k.as_str(), "name" | "conditions" | "conditionsReset") && v.is_object())?;
    let resource = body.pointer("/source/resource");
    let target = match resource {
        Some(r) => {
            let res_kind = text(r, "/kind").unwrap_or_else(|| "Workflow".into());
            text(r, "/metadata/name")
                .or_else(|| text(r, "/metadata/generateName"))
                .map(|n| format!("{res_kind}/{n}"))
        }
        None => text(body, "/url").or_else(|| text(body, "/serverURL")),
    };
    Some(Trigger {
        name,
        kind: kind.clone(),
        target,
    })
}

pub fn sensor_row(v: &Value) -> Result<SensorRow, AppError> {
    let (status, message) = status_of(v);
    Ok(SensorRow {
        namespace: text(v, "/metadata/namespace").unwrap_or_default(),
        name: text(v, "/metadata/name").unwrap_or_default(),
        dependencies: items(v, "/spec/dependencies")
            .iter()
            .map(|d| Dependency {
                name: text(d, "/name").unwrap_or_default(),
                event_source_name: text(d, "/eventSourceName").unwrap_or_default(),
                event_name: text(d, "/eventName").unwrap_or_default(),
            })
            .collect(),
        triggers: items(v, "/spec/triggers").iter().filter_map(trigger_of).collect(),
        status,
        message,
        yaml: yaml(v, "Sensor", "sensors")?,
    })
}

/// Argo Events가 없어서 난 오류면 고정 문구로
pub fn events_error(e: AppError) -> AppError {
    match &e {
        AppError::Other { message }
            if message.contains("could not find the requested resource") && (message.contains("eventsources") || message.contains("sensors")) =>
        {
            AppError::other(ARGO_EVENTS_MISSING)
        }
        _ => e,
    }
}

async fn list(state: &State, server: &Server, collection: &str, namespace: Option<&str>) -> Result<Value, AppError> {
    state
        .api(server, Method::GET, &["api", "v1", collection, namespace.unwrap_or_default()], &[], None)
        .await
}

pub async fn bindings(state: &State, server: &Server, namespace: Option<&str>) -> Result<Vec<EventBindingRow>, AppError> {
    let body = list(state, server, "workflow-event-bindings", namespace).await?;
    Ok(items(&body, "/items").iter().map(binding_row).collect())
}

pub async fn sources(state: &State, server: &Server, namespace: Option<&str>) -> Result<Vec<EventSourceRow>, AppError> {
    let body = list(state, server, "event-sources", namespace).await.map_err(events_error)?;
    items(&body, "/items").iter().map(source_row).collect()
}

pub async fn sensors(state: &State, server: &Server, namespace: Option<&str>) -> Result<Vec<SensorRow>, AppError> {
    let body = list(state, server, "sensors", namespace).await.map_err(events_error)?;
    items(&body, "/items").iter().map(sensor_row).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bindings_show_selector_template_and_event_parameters() {
        let b = binding_row(&json!({
            "metadata": { "name": "on-batch", "namespace": "data" },
            "spec": {
                "event": { "selector": "payload.kind == \"orders\"" },
                "submit": { "workflowTemplateRef": { "name": "etl", "clusterScope": true }, "arguments": { "parameters": [{ "name": "date", "valueFrom": { "event": "payload.date" } }] } }
            }
        }));
        assert_eq!(b.selector, "payload.kind == \"orders\"");
        assert_eq!(
            b.template,
            Some(TemplateRef {
                name: "etl".into(),
                cluster_scope: true
            })
        );
        assert_eq!(b.parameters, ["date=payload.date"]);
    }

    #[test]
    fn event_sources_list_their_types_and_event_names() {
        let s = source_row(&json!({
            "metadata": { "name": "github", "namespace": "ops" },
            "spec": { "service": { "ports": [] }, "eventBusName": "default", "webhook": { "release": { "port": "12000" }, "push": {} }, "sqs": { "orders": {} } },
            "status": { "conditions": [{ "type": "SourcesProvided", "status": "True" }, { "type": "Deployed", "status": "True" }] }
        }))
        .unwrap();
        assert_eq!(s.types, ["sqs", "webhook"]);
        assert_eq!(s.event_names, ["orders", "push", "release"]);
        assert_eq!((s.status.as_deref(), s.message), (Some("Deployed"), None));
        assert!(s.yaml.contains("kind: EventSource"));
    }

    #[test]
    fn sensors_show_dependencies_triggers_and_a_failing_condition() {
        let s = sensor_row(&json!({
            "metadata": { "name": "release", "namespace": "ops" },
            "spec": {
                "dependencies": [{ "name": "dep", "eventSourceName": "github", "eventName": "release" }],
                "triggers": [
                    { "template": { "name": "run", "argoWorkflow": { "operation": "submit", "source": { "resource": { "kind": "Workflow", "metadata": { "generateName": "release-" } } } } } },
                    { "template": { "name": "ping", "conditions": "dep", "http": { "url": "https://hooks.example.com/x" } } }
                ]
            },
            "status": { "conditions": [{ "type": "DependenciesProvided", "status": "True" }, { "type": "Deployed", "status": "False", "message": "image pull" }] }
        }))
        .unwrap();
        assert_eq!(
            s.dependencies,
            [Dependency {
                name: "dep".into(),
                event_source_name: "github".into(),
                event_name: "release".into()
            }]
        );
        assert_eq!(
            s.triggers[0],
            Trigger {
                name: "run".into(),
                kind: "argoWorkflow".into(),
                target: Some("Workflow/release-".into())
            }
        );
        assert_eq!(s.triggers[1].target.as_deref(), Some("https://hooks.example.com/x"));
        assert_eq!((s.status.as_deref(), s.message.as_deref()), (Some("Deployed 아님"), Some("image pull")));
    }

    #[test]
    fn a_missing_argo_events_install_becomes_a_plain_message() {
        let real = AppError::other("the server could not find the requested resource (get eventsources.argoproj.io)");
        assert_eq!(events_error(real), AppError::other(ARGO_EVENTS_MISSING));
        let other = AppError::other("forbidden");
        assert_eq!(events_error(other.clone()), other);
    }
}
