//! YAML 편집기로 만들고 고치는 Argo 객체(Workflow, 템플릿, Cron, EventSource, Sensor). YAML은 여기서 JSON으로 바꿔 보낸다.
//! YAML 글이나 그 조각은 오류에 싣지 않는다(비밀값이 들어 있을 수 있다).
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::client::{Server, State, ARGOWF_CONTEXT_REJECTED, ARGOWF_NETWORK, ARGOWF_TOKEN_INVALID, ARGOWF_TOKEN_MISSING};
use crate::error::AppError;
use crate::k8s::read::yaml::view_yaml;
use crate::k8s::rows::KindRef;

pub const YAML_UNREADABLE: &str = "YAML을 읽지 못했어요. 들여쓰기와 따옴표를 확인해 주세요";
pub const YAML_NOT_OBJECT: &str = "YAML 맨 위는 객체(키: 값)여야 해요";
pub const WORKFLOW_IMMUTABLE: &str = "실행한 Workflow는 고칠 수 없어요. YAML로 고쳐 다시 제출하세요";
pub const NAME_MISSING: &str = "metadata.name이나 metadata.generateName이 있어야 해요";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ManifestKind {
    Workflow,
    WorkflowTemplate,
    ClusterWorkflowTemplate,
    CronWorkflow,
    EventSource,
    Sensor,
}

impl ManifestKind {
    fn name(self) -> &'static str {
        match self {
            ManifestKind::Workflow => "Workflow",
            ManifestKind::WorkflowTemplate => "WorkflowTemplate",
            ManifestKind::ClusterWorkflowTemplate => "ClusterWorkflowTemplate",
            ManifestKind::CronWorkflow => "CronWorkflow",
            ManifestKind::EventSource => "EventSource",
            ManifestKind::Sensor => "Sensor",
        }
    }

    /// API 경로의 모음 이름
    fn collection(self) -> &'static str {
        match self {
            ManifestKind::Workflow => "workflows",
            ManifestKind::WorkflowTemplate => "workflow-templates",
            ManifestKind::ClusterWorkflowTemplate => "cluster-workflow-templates",
            ManifestKind::CronWorkflow => "cron-workflows",
            ManifestKind::EventSource => "event-sources",
            ManifestKind::Sensor => "sensors",
        }
    }

    /// 요청 본문에서 객체를 담는 키(`{namespace, template}` 등)
    fn body_key(self) -> &'static str {
        match self {
            ManifestKind::Workflow => "workflow",
            ManifestKind::WorkflowTemplate | ManifestKind::ClusterWorkflowTemplate => "template",
            ManifestKind::CronWorkflow => "cronWorkflow",
            ManifestKind::EventSource => "eventSource",
            ManifestKind::Sensor => "sensor",
        }
    }

    fn namespaced(self) -> bool {
        self != ManifestKind::ClusterWorkflowTemplate
    }

    /// Argo Server에 lint API가 있나(EventSource·Sensor는 없어 앱이 모양만 본다)
    fn server_lint(self) -> bool {
        !matches!(self, ManifestKind::EventSource | ManifestKind::Sensor)
    }

    fn kind_ref(self) -> KindRef {
        let plural = match self {
            ManifestKind::Workflow => "workflows",
            ManifestKind::WorkflowTemplate => "workflowtemplates",
            ManifestKind::ClusterWorkflowTemplate => "clusterworkflowtemplates",
            ManifestKind::CronWorkflow => "cronworkflows",
            ManifestKind::EventSource => "eventsources",
            ManifestKind::Sensor => "sensors",
        };
        KindRef {
            group: "argoproj.io".into(),
            version: "v1alpha1".into(),
            kind: self.name().into(),
            plural: plural.into(),
            namespaced: self.namespaced(),
        }
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LintResult {
    pub ok: bool,
    pub message: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub namespace: Option<String>,
    pub name: String,
}

/// API 경로 조각: 모음(`[api, v1, workflow-templates, ns]`) 뒤에 이름이나 `lint`를 붙인다
fn path(kind: ManifestKind, namespace: Option<&str>, tail: Option<&str>) -> Vec<String> {
    let mut p = vec!["api".to_string(), "v1".into(), kind.collection().into()];
    if kind.namespaced() {
        p.push(namespace.unwrap_or_default().to_string());
    }
    if let Some(t) = tail {
        p.push(t.to_string());
    }
    p
}

/// YAML 글 → 객체. kind가 맞는지 보고, apiVersion·kind가 없으면 채우고, 네임스페이스를 고른 대로 맞춘다.
pub fn parse(kind: ManifestKind, namespace: Option<&str>, yaml: &str) -> Result<Value, AppError> {
    let mut v: Value = serde_saphyr::from_str(yaml).map_err(|_| AppError::other(YAML_UNREADABLE))?;
    let Value::Object(map) = &mut v else {
        return Err(AppError::other(YAML_NOT_OBJECT));
    };
    match map.get("kind").and_then(Value::as_str) {
        Some(k) if k != kind.name() => return Err(AppError::other(format!("kind가 {}여야 해요(지금은 {k})", kind.name()))),
        Some(_) => {}
        None => {
            map.insert("kind".into(), json!(kind.name()));
        }
    }
    map.entry("apiVersion").or_insert_with(|| json!("argoproj.io/v1alpha1"));
    let meta = map.entry("metadata").or_insert_with(|| json!({}));
    let Value::Object(meta) = meta else {
        return Err(AppError::other(YAML_NOT_OBJECT));
    };
    let has_name = |key: &str| meta.get(key).and_then(Value::as_str).is_some_and(|s| !s.is_empty());
    if !has_name("name") && !has_name("generateName") {
        return Err(AppError::other(NAME_MISSING));
    }
    if kind.namespaced() {
        if let Some(ns) = namespace.filter(|n| !n.is_empty()) {
            meta.insert("namespace".into(), json!(ns));
        }
    } else {
        meta.remove("namespace");
    }
    Ok(v)
}

fn namespace_of(v: &Value, fallback: Option<&str>) -> Option<String> {
    v.pointer("/metadata/namespace")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| fallback.map(str::to_string))
        .filter(|s| !s.is_empty())
}

/// 요청 본문: `{namespace, name?, <키>: 객체}`(클러스터 템플릿은 namespace 없이)
pub fn body(kind: ManifestKind, namespace: Option<&str>, name: Option<&str>, object: Value) -> Value {
    let mut b = serde_json::Map::new();
    if kind.namespaced() {
        b.insert("namespace".into(), json!(namespace.unwrap_or_default()));
    }
    if let Some(n) = name {
        b.insert("name".into(), json!(n));
    }
    b.insert(kind.body_key().into(), object);
    Value::Object(b)
}

/// 편집용으로 덜어 낸다: status, managedFields, uid, creationTimestamp, generation. resourceVersion은 고칠 때 필요해 남긴다.
pub fn strip_for_edit(mut v: Value) -> Value {
    if let Value::Object(m) = &mut v {
        m.remove("status");
        if let Some(Value::Object(meta)) = m.get_mut("metadata") {
            for key in ["managedFields", "uid", "creationTimestamp", "generation", "selfLink"] {
                meta.remove(key);
            }
        }
    }
    v
}

/// 컨트롤러가 붙이는 Workflow 레이블: 새로 만들 때 옮기면 새 Workflow가 끝난 것처럼 보인다
const CONTROLLER_LABELS: [&str; 4] = [
    "workflows.argoproj.io/phase",
    "workflows.argoproj.io/completed",
    "workflows.argoproj.io/workflow-archiving-status",
    "workflows.argoproj.io/controller-instanceid",
];

/// 기존 객체를 새 객체로: 서버가 가진 칸(name·resourceVersion·uid·status·ownerReferences…)과 컨트롤러 레이블을 지우고
/// generateName(원래 것, 없으면 `<이름>-`)으로 새 이름을 받게 한다. 어디서 왔는지는 Argo와 같은 레이블로 남긴다.
pub fn as_new(v: Value) -> Value {
    let mut v = strip_for_edit(v);
    if let Some(Value::Object(meta)) = v.get_mut("metadata") {
        let old = meta.remove("name").and_then(|n| n.as_str().map(str::to_string));
        for key in ["resourceVersion", "ownerReferences", "finalizers", "deletionTimestamp"] {
            meta.remove(key);
        }
        let generate = meta.get("generateName").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        if let Some(g) = generate.or_else(|| old.as_ref().map(|n| format!("{n}-"))) {
            meta.insert("generateName".into(), json!(g));
        }
        if let Some(Value::Object(labels)) = meta.get_mut("labels") {
            for key in CONTROLLER_LABELS {
                labels.remove(key);
            }
        }
        if let Some(name) = old {
            let labels = meta.entry("labels").or_insert_with(|| json!({}));
            if let Value::Object(labels) = labels {
                labels.insert("workflows.argoproj.io/resubmitted-from-workflow".into(), json!(name));
            }
        }
    }
    v
}

fn refs(p: &[String]) -> Vec<&str> {
    p.iter().map(String::as_str).collect()
}

/// 서버가 돌려준 실패 중 YAML 내용 때문인 것(lint 결과로 보일 것)인가. 인증·연결 오류는 그대로 올린다.
fn is_content_error(e: &AppError) -> bool {
    match e {
        AppError::Other { message } => ![ARGOWF_TOKEN_INVALID, ARGOWF_TOKEN_MISSING, ARGOWF_CONTEXT_REJECTED, ARGOWF_NETWORK].contains(&message.as_str()),
        _ => false,
    }
}

pub async fn manifest(state: &State, server: &Server, kind: ManifestKind, namespace: Option<&str>, name: &str) -> Result<String, AppError> {
    let v = state.api(server, Method::GET, &refs(&path(kind, namespace, Some(name))), &[], None).await?;
    let mut obj = strip_for_edit(v);
    if let Value::Object(m) = &mut obj {
        m.entry("apiVersion").or_insert_with(|| json!("argoproj.io/v1alpha1"));
        m.entry("kind").or_insert_with(|| json!(kind.name()));
    }
    view_yaml(&kind.kind_ref(), &obj)
}

pub async fn lint(state: &State, server: &Server, kind: ManifestKind, namespace: Option<&str>, yaml: &str) -> Result<LintResult, AppError> {
    let object = match parse(kind, namespace, yaml) {
        Ok(v) => v,
        Err(AppError::Other { message }) => {
            return Ok(LintResult {
                ok: false,
                message: Some(message),
            })
        }
        Err(e) => return Err(e),
    };
    if !kind.server_lint() {
        return Ok(LintResult { ok: true, message: None });
    }
    let ns = namespace_of(&object, namespace);
    let request = body(kind, ns.as_deref(), None, object);
    match state
        .api(server, Method::POST, &refs(&path(kind, ns.as_deref(), Some("lint"))), &[], Some(&request))
        .await
    {
        Ok(_) => Ok(LintResult { ok: true, message: None }),
        Err(e) if is_content_error(&e) => Ok(LintResult {
            ok: false,
            message: Some(e.to_string()),
        }),
        Err(e) => Err(e),
    }
}

pub async fn create(state: &State, server: &Server, kind: ManifestKind, namespace: Option<&str>, yaml: &str, as_new_object: bool) -> Result<Created, AppError> {
    let parsed = parse(kind, namespace, yaml)?;
    let object = if as_new_object { as_new(parsed) } else { parsed };
    let ns = namespace_of(&object, namespace);
    let request = body(kind, ns.as_deref(), None, object);
    let made = state
        .api(server, Method::POST, &refs(&path(kind, ns.as_deref(), None)), &[], Some(&request))
        .await?;
    let name = made.pointer("/metadata/name").and_then(Value::as_str).unwrap_or_default().to_string();
    Ok(Created {
        namespace: if kind.namespaced() { namespace_of(&made, ns.as_deref()) } else { None },
        name,
    })
}

pub async fn update(state: &State, server: &Server, kind: ManifestKind, namespace: Option<&str>, name: &str, yaml: &str) -> Result<(), AppError> {
    if kind == ManifestKind::Workflow {
        return Err(AppError::other(WORKFLOW_IMMUTABLE));
    }
    let mut object = parse(kind, namespace, yaml)?;
    if let Some(Value::Object(meta)) = object.get_mut("metadata") {
        meta.insert("name".into(), json!(name));
    }
    let ns = namespace_of(&object, namespace);
    let request = body(kind, ns.as_deref(), Some(name), object);
    state
        .api(server, Method::PUT, &refs(&path(kind, ns.as_deref(), Some(name))), &[], Some(&request))
        .await?;
    Ok(())
}

pub async fn delete(state: &State, server: &Server, kind: ManifestKind, namespace: Option<&str>, name: &str) -> Result<(), AppError> {
    state.api(server, Method::DELETE, &refs(&path(kind, namespace, Some(name))), &[], None).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_body_keys_follow_the_argo_api() {
        assert_eq!(
            path(ManifestKind::WorkflowTemplate, Some("data"), Some("lint")),
            ["api", "v1", "workflow-templates", "data", "lint"]
        );
        assert_eq!(
            path(ManifestKind::ClusterWorkflowTemplate, Some("ignored"), Some("etl")),
            ["api", "v1", "cluster-workflow-templates", "etl"]
        );
        assert_eq!(path(ManifestKind::Sensor, Some("ops"), None), ["api", "v1", "sensors", "ops"]);
        let b = body(ManifestKind::CronWorkflow, Some("jobs"), Some("nightly"), json!({ "kind": "CronWorkflow" }));
        assert_eq!(b, json!({ "namespace": "jobs", "name": "nightly", "cronWorkflow": { "kind": "CronWorkflow" } }));
        assert_eq!(
            body(ManifestKind::ClusterWorkflowTemplate, Some("x"), None, json!({})),
            json!({ "template": {} })
        );
        assert_eq!(body(ManifestKind::EventSource, Some("ops"), None, json!({}))["eventSource"], json!({}));
    }

    #[test]
    fn parse_fills_kind_and_namespace_and_checks_the_kind() {
        let v = parse(
            ManifestKind::WorkflowTemplate,
            Some("data"),
            "metadata:\n  name: etl\nspec:\n  entrypoint: main\n",
        )
        .unwrap();
        assert_eq!(
            (v["kind"].as_str(), v["apiVersion"].as_str(), v["metadata"]["namespace"].as_str()),
            (Some("WorkflowTemplate"), Some("argoproj.io/v1alpha1"), Some("data"))
        );
        let cluster = parse(
            ManifestKind::ClusterWorkflowTemplate,
            Some("data"),
            "kind: ClusterWorkflowTemplate\nmetadata:\n  name: x\n  namespace: data\n",
        )
        .unwrap();
        assert!(cluster["metadata"].get("namespace").is_none());
        let wrong = parse(ManifestKind::CronWorkflow, None, "kind: Workflow\nmetadata:\n  name: a\n").unwrap_err();
        assert!(wrong.to_string().contains("CronWorkflow"));
        assert_eq!(
            parse(ManifestKind::Workflow, None, "kind: Workflow\nmetadata: {}\n").unwrap_err(),
            AppError::other(NAME_MISSING)
        );
        assert!(parse(ManifestKind::Workflow, None, "metadata:\n  generateName: hello-\n").is_ok());
    }

    #[test]
    fn unreadable_yaml_never_echoes_its_content() {
        let secret = "metadata:\n  name: a\n  password: \"hunter2-secret\n  bad: [";
        let e = parse(ManifestKind::Workflow, None, secret).unwrap_err();
        assert_eq!(e, AppError::other(YAML_UNREADABLE));
        assert!(!e.to_string().contains("hunter2"));
        assert_eq!(
            parse(ManifestKind::Workflow, None, "- just\n- a list\n").unwrap_err(),
            AppError::other(YAML_NOT_OBJECT)
        );
    }

    #[test]
    fn resubmitting_as_new_drops_server_identity_and_controller_labels() {
        let v = as_new(json!({
            "metadata": {
                "name": "etl-x7k2p", "namespace": "data", "uid": "u", "resourceVersion": "42", "ownerReferences": [{ "kind": "CronWorkflow" }],
                "labels": { "team": "data", "workflows.argoproj.io/phase": "Failed", "workflows.argoproj.io/completed": "true" }
            },
            "spec": { "entrypoint": "main" }, "status": { "phase": "Failed" }
        }));
        assert_eq!(
            v,
            json!({
                "metadata": {
                    "generateName": "etl-x7k2p-", "namespace": "data",
                    "labels": { "team": "data", "workflows.argoproj.io/resubmitted-from-workflow": "etl-x7k2p" }
                },
                "spec": { "entrypoint": "main" }
            })
        );
        let kept = as_new(json!({ "metadata": { "name": "hello-abcde", "generateName": "hello-" } }));
        assert_eq!(kept["metadata"]["generateName"], json!("hello-"));
    }

    #[test]
    fn editing_strips_server_fields_but_keeps_resource_version() {
        let v = strip_for_edit(json!({
            "metadata": { "name": "etl", "uid": "u", "resourceVersion": "42", "generation": 3, "creationTimestamp": "t", "managedFields": [] },
            "spec": {}, "status": { "phase": "x" }
        }));
        assert_eq!(v, json!({ "metadata": { "name": "etl", "resourceVersion": "42" }, "spec": {} }));
    }

    #[test]
    fn auth_and_network_failures_are_not_lint_results() {
        assert!(is_content_error(&AppError::other("templates.main: unknown field")));
        assert!(!is_content_error(&AppError::other(ARGOWF_TOKEN_INVALID)));
        assert!(!is_content_error(&AppError::Network {
            message: ARGOWF_NETWORK.into()
        }));
    }
}
