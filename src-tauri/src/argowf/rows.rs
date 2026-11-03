//! Argo Server 응답(JSON)을 화면이 쓰는 행·노드·상세로 바꾼다. 모양은 프론트 `src/argowf/types.ts`와 같다.
use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::cron;
use crate::error::AppError;
use crate::k8s::read::yaml::view_yaml;
use crate::k8s::rows::KindRef;

const L_CRON: &str = "workflows.argoproj.io/cron-workflow";
const L_TEMPLATE: &str = "workflows.argoproj.io/workflow-template";
const L_CLUSTER_TEMPLATE: &str = "workflows.argoproj.io/cluster-workflow-template";
const L_CREATOR_EMAIL: &str = "workflows.argoproj.io/creator-email";
const L_CREATOR: &str = "workflows.argoproj.io/creator";
const A_POD_NAME_FORMAT: &str = "workflows.argoproj.io/pod-name-format";
const A_DESCRIPTION: &str = "workflows.argoproj.io/description";
/// 아카이브(DB)에서 읽은 Workflow에 서버가 붙이는 레이블 값(`workflow-archiving-status: Persisted`)
const L_ARCHIVING_STATUS: &str = "workflows.argoproj.io/workflow-archiving-status";

/// Workflow 목록에 받을 칸(Argo UI와 같은 목록에 resourceVersion을 더했다). 응답이 작아져 5초마다 읽어도 가볍다.
pub const WF_LIST_FIELDS: &str = "metadata,items.metadata.uid,items.metadata.name,items.metadata.namespace,items.metadata.resourceVersion,items.metadata.creationTimestamp,items.metadata.labels,items.metadata.annotations,items.status.phase,items.status.message,items.status.finishedAt,items.status.startedAt,items.status.progress,items.status.estimatedDuration,items.spec.suspend,items.spec.activeDeadlineSeconds";
/// Cron·템플릿 목록은 spec 전체가 필요해(스케줄, SA, 제한 시간) 칸을 고르지 않는다. 빈 글이면 `fields`를 붙이지 않는다.
pub const CRON_LIST_FIELDS: &str = "";
pub const TEMPLATE_LIST_FIELDS: &str = "";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TemplateKind {
    WorkflowTemplate,
    ClusterWorkflowTemplate,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WfParam {
    pub name: String,
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(rename = "enum", skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WfRow {
    pub namespace: String,
    pub name: String,
    pub uid: String,
    pub resource_version: String,
    pub phase: String,
    pub message: Option<String>,
    pub progress: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub cron: Option<String>,
    pub template: Option<String>,
    pub cluster_template: bool,
    pub creator: Option<String>,
    pub suspended: bool,
    /// 워크플로 수준의 제한 시간(점검의 "오래 실행 중"이 쓴다)
    pub active_deadline_seconds: Option<i64>,
    pub archived: bool,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub created_at: Option<String>,
    pub estimated_duration: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WfNode {
    pub id: String,
    pub name: String,
    pub display_name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub phase: String,
    pub message: Option<String>,
    pub template_name: Option<String>,
    pub template_scope: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub children: Vec<String>,
    pub boundary_id: Option<String>,
    pub pod_name: Option<String>,
    pub exit_code: Option<String>,
    pub inputs: Vec<WfParam>,
    pub outputs: Vec<WfParam>,
    pub artifacts: Vec<WfArtifact>,
    pub host_node_name: Option<String>,
    pub memoization: Option<WfMemoization>,
    pub containers: Vec<WfContainer>,
    pub estimated_duration: Option<i64>,
    pub resources_duration: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WfArtifact {
    pub name: String,
    pub direction: &'static str,
    pub key: Option<String>,
    pub repository: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WfMemoization {
    pub hit: bool,
    pub key: String,
    pub cache_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WfContainer {
    pub name: String,
    pub role: &'static str,
    pub image: Option<String>,
    pub command: Vec<String>,
    pub args: Vec<String>,
    pub working_dir: Option<String>,
    pub env: Vec<String>,
    pub requests: BTreeMap<String, String>,
    pub limits: BTreeMap<String, String>,
    pub volume_mounts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WfOrigin {
    pub kind: &'static str,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WfSynchronization {
    pub kind: &'static str,
    pub key: String,
    pub holding: Vec<String>,
    pub waiting: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WfCondition {
    #[serde(rename = "type")]
    pub kind: String,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WfDetail {
    pub row: WfRow,
    pub nodes: Vec<WfNode>,
    pub parameters: Vec<WfParam>,
    pub entrypoint: Option<String>,
    pub service_account: Option<String>,
    pub active_deadline_seconds: Option<i64>,
    #[serde(rename = "podGC")]
    pub pod_gc: Option<String>,
    pub ttl: Option<String>,
    pub conditions: Vec<WfCondition>,
    pub resources_duration: BTreeMap<String, i64>,
    pub outputs: Vec<WfParam>,
    pub created_from: Vec<WfOrigin>,
    pub synchronization: Vec<WfSynchronization>,
    pub yaml: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRow {
    pub namespace: String,
    pub name: String,
    pub schedules: Vec<String>,
    pub timezone: Option<String>,
    pub suspended: bool,
    pub concurrency_policy: Option<String>,
    pub starting_deadline_seconds: Option<i64>,
    pub last_scheduled_time: Option<String>,
    pub active: Vec<String>,
    pub succeeded: Option<i64>,
    pub failed: Option<i64>,
    pub next_runs: Vec<String>,
    pub missed: bool,
    pub service_account: Option<String>,
    pub has_deadline: bool,
    pub template: Option<String>,
    pub cluster_template: bool,
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronDetail {
    pub row: CronRow,
    pub entrypoint: Option<String>,
    pub template: Option<String>,
    pub parameters: Vec<WfParam>,
    pub yaml: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateParam {
    pub name: String,
    pub value: Option<String>,
    #[serde(rename = "enum")]
    pub choices: Vec<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRow {
    pub kind: TemplateKind,
    pub namespace: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub parameters: Vec<TemplateParam>,
    pub entrypoint: Option<String>,
    pub templates: Vec<String>,
    pub service_account: Option<String>,
    pub has_deadline: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDetail {
    pub row: TemplateRow,
    pub yaml: String,
}

fn text(v: &Value, path: &str) -> Option<String> {
    v.pointer(path).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

fn int(v: &Value, path: &str) -> Option<i64> {
    v.pointer(path).and_then(Value::as_i64)
}

fn items<'a>(v: &'a Value, path: &str) -> &'a [Value] {
    v.pointer(path).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn string_map(v: &Value, path: &str) -> BTreeMap<String, String> {
    v.pointer(path)
        .and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default()
}

fn durations(v: &Value, path: &str) -> BTreeMap<String, i64> {
    v.pointer(path)
        .and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, v)| v.as_i64().map(|n| (k.clone(), n))).collect())
        .unwrap_or_default()
}

/// 파라미터 값. 숫자·불이어도 글로 보인다(YAML에 따옴표 없이 쓴 값).
fn scalar(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Null) | None => None,
        Some(other) => Some(other.to_string()),
    }
}
fn param_value(p: &Value) -> Option<String> {
    scalar(p.get("value"))
}

/// 파라미터 목록(`[{name, value}]`)
fn params(v: &Value, path: &str) -> Vec<WfParam> {
    items(v, path)
        .iter()
        .filter_map(|p| {
            Some(WfParam {
                name: text(p, "/name")?,
                value: param_value(p),
                default: scalar(p.get("default")).or_else(|| scalar(p.pointer("/valueFrom/default"))),
                choices: p
                    .get("enum")
                    .and_then(Value::as_array)
                    .map(|v| v.iter().filter_map(|v| scalar(Some(v))).collect()),
                description: scalar(p.get("description")),
            })
        })
        .collect()
}

fn parse_time(s: Option<&str>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s?).ok().map(|d| d.with_timezone(&Utc))
}

/// 목록 응답(`items`가 null일 수 있다)
fn list_items(body: &Value) -> &[Value] {
    items(body, "/items")
}

pub fn wf_row(v: &Value, archived: bool) -> WfRow {
    let labels = string_map(v, "/metadata/labels");
    let (template, cluster_template) = match (labels.get(L_TEMPLATE), labels.get(L_CLUSTER_TEMPLATE)) {
        (Some(t), _) => (Some(t.clone()), false),
        (None, Some(t)) => (Some(t.clone()), true),
        (None, None) => match (
            text(v, "/spec/workflowTemplateRef/name"),
            v.pointer("/spec/workflowTemplateRef/clusterScope").and_then(Value::as_bool),
        ) {
            (Some(t), cluster) => (Some(t), cluster.unwrap_or(false)),
            (None, _) => (None, false),
        },
    };
    WfRow {
        namespace: text(v, "/metadata/namespace").unwrap_or_default(),
        name: text(v, "/metadata/name").unwrap_or_default(),
        uid: text(v, "/metadata/uid").unwrap_or_default(),
        resource_version: text(v, "/metadata/resourceVersion").unwrap_or_default(),
        phase: text(v, "/status/phase").unwrap_or_default(),
        message: text(v, "/status/message"),
        progress: text(v, "/status/progress"),
        started_at: text(v, "/status/startedAt"),
        finished_at: text(v, "/status/finishedAt"),
        cron: labels.get(L_CRON).cloned(),
        template,
        cluster_template,
        creator: labels.get(L_CREATOR_EMAIL).or_else(|| labels.get(L_CREATOR)).cloned(),
        suspended: v.pointer("/spec/suspend").and_then(Value::as_bool).unwrap_or(false),
        active_deadline_seconds: int(v, "/spec/activeDeadlineSeconds"),
        archived: archived || labels.get(L_ARCHIVING_STATUS).is_some_and(|s| s == "Persisted"),
        annotations: string_map(v, "/metadata/annotations"),
        created_at: text(v, "/metadata/creationTimestamp"),
        estimated_duration: int(v, "/status/estimatedDuration"),
        labels,
    }
}

/// 목록 응답의 행. 목록 API는 살아 있는 Workflow 뒤에 아카이브 것을 붙여 주는데, 아직 살아 있는 Workflow도
/// 아카이브에 있으면 둘 다 온다: 같은 uid면 살아 있는 쪽만 남긴다(상세·동작이 살아 있는 경로로 가게).
pub fn wf_rows(list_body: &Value, archived: bool) -> Vec<WfRow> {
    let rows: Vec<WfRow> = list_items(list_body).iter().map(|v| wf_row(v, archived)).collect();
    let live: std::collections::HashSet<String> = rows.iter().filter(|r| !r.archived).map(|r| r.uid.clone()).collect();
    rows.into_iter().filter(|r| !r.archived || r.uid.is_empty() || !live.contains(&r.uid)).collect()
}

/// fnv-1a 32비트(Go `hash/fnv` New32a와 같다)
fn fnv32a(s: &str) -> u32 {
    s.bytes().fold(0x811c_9dc5_u32, |h, b| (h ^ u32::from(b)).wrapping_mul(0x0100_0193))
}

const MAX_K8S_NAME: usize = 253;
const HASH_LEN: usize = 10;

/// 문자열을 n바이트 이하로, 글자 경계에서 자른다(Go는 바이트로 자르지만 이름은 ASCII라 같다)
fn cut(s: &str, n: usize) -> &str {
    if s.len() <= n {
        return s;
    }
    let mut end = n;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Argo v4.1.6 `util.GeneratePodName`와 같은 규칙으로 Pod 이름을 만든다.
/// v1이면 노드 id. 워크플로 이름과 노드 이름이 같으면 워크플로 이름. 아니면 `<워크플로>-<템플릿>` 접두사(길이 제한)에
/// 노드 id의 해시 부분(워크플로 이름 뒤)을, 그 모양이 아니면 노드 이름의 fnv32a를 붙인다.
pub fn pod_name(workflow: &str, node_name: &str, template: Option<&str>, node_id: &str, v1: bool) -> String {
    if v1 {
        return node_id.to_string();
    }
    if workflow == node_name {
        return workflow.to_string();
    }
    let mut prefix = match template.filter(|t| !t.is_empty()) {
        Some(t) => format!("{workflow}-{t}"),
        None => workflow.to_string(),
    };
    let max_prefix = MAX_K8S_NAME - HASH_LEN;
    if prefix.len() > max_prefix - 1 {
        prefix = cut(&prefix, max_prefix - 1).to_string();
    }
    if let Some(hash) = node_id.strip_prefix(&format!("{workflow}-")) {
        let excess = (prefix.len() + 1 + hash.len()).saturating_sub(MAX_K8S_NAME);
        if excess > 0 {
            prefix = cut(&prefix, prefix.len() - excess).to_string();
        }
        return format!("{prefix}-{hash}");
    }
    format!("{prefix}-{}", fnv32a(node_name))
}

/// Argo UI처럼 템플릿 이름이 없으면 templateRef의 템플릿을 쓴다
fn node_template(n: &Value) -> Option<String> {
    text(n, "/templateName").or_else(|| text(n, "/templateRef/template"))
}

fn uses_v1_pod_names(v: &Value) -> bool {
    v.pointer(&format!("/metadata/annotations/{}", A_POD_NAME_FORMAT.replace('/', "~1")))
        .and_then(Value::as_str)
        == Some("v1")
}

fn strings(v: &Value, path: &str) -> Vec<String> {
    items(v, path).iter().filter_map(Value::as_str).map(str::to_owned).collect()
}

fn artifacts(n: &Value) -> Vec<WfArtifact> {
    [("input", "/inputs/artifacts"), ("output", "/outputs/artifacts")]
        .into_iter()
        .flat_map(|(direction, path)| {
            items(n, path).iter().filter_map(move |a| {
                let name = text(a, "/name")?;
                let repository = ["s3", "gcs", "http", "git", "raw", "artifactory", "hdfs", "oss", "azure", "plugin"]
                    .into_iter()
                    .find(|k| a.get(*k).is_some_and(|v| !v.is_null()));
                let key = repository.and_then(|r| {
                    let location = a.get(r)?;
                    ["key", "blob", "url", "repo", "path"]
                        .into_iter()
                        .find_map(|k| location.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned))
                });
                Some(WfArtifact {
                    name,
                    direction,
                    key,
                    repository: repository.map(str::to_owned),
                })
            })
        })
        .collect()
}

/// 외부 템플릿은 실행 시점의 저장본을 우선한다. 서로 다른 scope의 같은 이름을 섞지 않는다.
fn node_template_spec<'a>(v: &'a Value, n: &Value, name: &str) -> Option<&'a Value> {
    let stored = v.pointer("/status/storedTemplates").and_then(Value::as_object);
    if let Some(reference) = n.get("templateRef") {
        let resource = reference.get("name").and_then(Value::as_str)?;
        let scope = if reference.get("clusterScope").and_then(Value::as_bool).unwrap_or(false) {
            "cluster"
        } else {
            "namespaced"
        };
        return stored?.get(&format!("{scope}/{resource}/{name}"));
    }
    if let Some(scope) = n
        .get("templateScope")
        .and_then(Value::as_str)
        .filter(|s| !s.starts_with("local/") && *s != "local")
    {
        let scope = if scope.contains('/') {
            scope.to_owned()
        } else {
            format!("namespaced/{scope}")
        };
        return stored?.get(&format!("{scope}/{name}"));
    }
    ["/status/storedWorkflowSpec/templates", "/spec/templates"]
        .into_iter()
        .flat_map(|p| items(v, p))
        .find(|t| t.get("name").and_then(Value::as_str) == Some(name))
}

fn container(v: &Value, role: &'static str) -> WfContainer {
    WfContainer {
        name: text(v, "/name").unwrap_or_else(|| if role == "main" { "main" } else { "" }.to_owned()),
        role,
        image: text(v, "/image"),
        command: strings(v, "/command"),
        args: strings(v, "/args"),
        working_dir: text(v, "/workingDir"),
        env: items(v, "/env").iter().filter_map(|e| text(e, "/name")).collect(),
        requests: string_map(v, "/resources/requests"),
        limits: string_map(v, "/resources/limits"),
        volume_mounts: items(v, "/volumeMounts")
            .iter()
            .filter_map(|m| text(m, "/mountPath").or_else(|| text(m, "/name")))
            .collect(),
    }
}

fn containers(v: &Value, n: &Value, template: Option<&str>) -> Vec<WfContainer> {
    let Some(t) = template.and_then(|name| node_template_spec(v, n, name)) else {
        return Vec::new();
    };
    let mut result: Vec<_> = items(t, "/initContainers").iter().map(|c| container(c, "init")).collect();
    if let Some(main) = t.get("container").or_else(|| t.get("script")) {
        result.push(container(main, "main"));
    }
    result.extend(items(t, "/containerSet/containers").iter().map(|c| container(c, "main")));
    result.extend(items(t, "/sidecars").iter().map(|c| container(c, "sidecar")));
    result
}

fn memoization(n: &Value) -> Option<WfMemoization> {
    let m = n.get("memoizationStatus")?.as_object()?;
    Some(WfMemoization {
        hit: m.get("hit").and_then(Value::as_bool).unwrap_or(false),
        key: m.get("key").and_then(Value::as_str).unwrap_or_default().to_owned(),
        cache_name: m.get("cacheName").and_then(Value::as_str).unwrap_or_default().to_owned(),
    })
}

/// 실행 값은 노드에서, 빠진 정의는 실행에 쓰인 템플릿에서 채운다.
fn node_params(v: &Value, n: &Value, template: Option<&str>, path: &str) -> Vec<WfParam> {
    let mut values = params(n, path);
    if let Some(spec) = template.and_then(|name| node_template_spec(v, n, name)) {
        for definition in params(spec, path) {
            if let Some(value) = values.iter_mut().find(|p| p.name == definition.name) {
                if value.default.is_none() {
                    value.default = definition.default;
                }
                if value.choices.is_none() {
                    value.choices = definition.choices;
                }
                if value.description.is_none() {
                    value.description = definition.description;
                }
            } else {
                values.push(definition);
            }
        }
    }
    values
}

fn nodes_of(v: &Value) -> Vec<WfNode> {
    let workflow = text(v, "/metadata/name").unwrap_or_default();
    let v1 = uses_v1_pod_names(v);
    let Some(map) = v.pointer("/status/nodes").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut nodes: Vec<WfNode> = map
        .iter()
        .map(|(key, n)| {
            let id = text(n, "/id").unwrap_or_else(|| key.clone());
            let name = text(n, "/name").unwrap_or_else(|| id.clone());
            let kind = text(n, "/type").unwrap_or_default();
            let template = node_template(n);
            let pod_name = (kind == "Pod").then(|| pod_name(&workflow, &name, template.as_deref(), &id, v1));
            let artifacts = artifacts(n);
            let containers = containers(v, n, template.as_deref());
            let inputs = node_params(v, n, template.as_deref(), "/inputs/parameters");
            let outputs = node_params(v, n, template.as_deref(), "/outputs/parameters");
            WfNode {
                display_name: text(n, "/displayName").unwrap_or_else(|| name.clone()),
                id,
                name,
                kind,
                phase: text(n, "/phase").unwrap_or_default(),
                message: text(n, "/message"),
                template_name: template,
                template_scope: text(n, "/templateScope"),
                started_at: text(n, "/startedAt"),
                finished_at: text(n, "/finishedAt"),
                children: items(n, "/children").iter().filter_map(|c| c.as_str().map(str::to_string)).collect(),
                boundary_id: text(n, "/boundaryID"),
                pod_name,
                exit_code: text(n, "/outputs/exitCode"),
                inputs,
                outputs,
                artifacts,
                host_node_name: text(n, "/hostNodeName"),
                memoization: memoization(n),
                containers,
                estimated_duration: int(n, "/estimatedDuration"),
                resources_duration: durations(n, "/resourcesDuration"),
            }
        })
        .collect();
    // 시작 시각 순(아직 시작 안 한 노드는 뒤), 같으면 id 순
    nodes.sort_by(|a, b| (a.started_at.is_none(), &a.started_at, &a.id).cmp(&(b.started_at.is_none(), &b.started_at, &b.id)));
    nodes
}

/// 이 Workflow의 모든 Pod 이름(이벤트를 찾을 때 쓴다)
pub fn pod_names_of(detail_json: &Value) -> Vec<String> {
    nodes_of(detail_json).into_iter().filter_map(|n| n.pod_name).collect()
}

fn ttl_text(v: &Value, path: &str) -> Option<String> {
    let m = v.pointer(path).and_then(Value::as_object)?;
    let parts: Vec<String> = ["secondsAfterCompletion", "secondsAfterSuccess", "secondsAfterFailure"]
        .iter()
        .filter_map(|k| m.get(*k).and_then(Value::as_i64).map(|n| format!("{k}={n}")))
        .collect();
    (!parts.is_empty()).then(|| parts.join(", "))
}

fn kind_ref(kind: &str, plural: &str, namespaced: bool) -> KindRef {
    KindRef {
        group: "argoproj.io".into(),
        version: "v1alpha1".into(),
        kind: kind.into(),
        plural: plural.into(),
        namespaced,
    }
}

/// Argo Server 응답에는 apiVersion·kind가 없어 넣고 YAML로(managedFields는 뺀다)
fn yaml_of(v: &Value, kind: &str, plural: &str, namespaced: bool) -> Result<String, AppError> {
    let mut obj = v.clone();
    if let Value::Object(m) = &mut obj {
        m.entry("apiVersion").or_insert_with(|| json!("argoproj.io/v1alpha1"));
        m.entry("kind").or_insert_with(|| json!(kind));
    }
    view_yaml(&kind_ref(kind, plural, namespaced), &obj)
}

fn origins(row: &WfRow) -> Vec<WfOrigin> {
    let mut result = Vec::new();
    if let Some(name) = &row.cron {
        result.push(WfOrigin {
            kind: "cron",
            name: name.clone(),
        });
    }
    if let Some(name) = &row.template {
        result.push(WfOrigin {
            kind: if row.cluster_template { "clusterTemplate" } else { "template" },
            name: name.clone(),
        });
    }
    for (label, kind) in [
        ("workflows.argoproj.io/resubmitted-from-workflow", "resubmit"),
        ("workflows.argoproj.io/workflow-event-binding", "event"),
        ("workflows.argoproj.io/workflow", "workflow"),
    ] {
        if let Some(name) = row.labels.get(label).filter(|s| !s.is_empty()) {
            result.push(WfOrigin { kind, name: name.clone() });
        }
    }
    result
}

fn synchronization(v: &Value) -> Vec<WfSynchronization> {
    let mut locks = BTreeMap::<(&str, String), (Vec<String>, Vec<String>)>::new();
    for (kind, name_field) in [("mutex", "mutex"), ("semaphore", "semaphore")] {
        for state in ["holding", "waiting"] {
            let path = format!("/status/synchronization/{kind}/{state}");
            for entry in items(v, &path) {
                let Some(key) = entry.get(name_field).and_then(Value::as_str).filter(|s| !s.is_empty()) else {
                    continue;
                };
                let lock = locks.entry((kind, key.to_owned())).or_default();
                let target = if state == "holding" { &mut lock.0 } else { &mut lock.1 };
                if let Some(holder) = text(entry, "/holder") {
                    target.push(holder);
                }
                target.extend(strings(entry, "/holders"));
            }
        }
    }
    locks
        .into_iter()
        .map(|((kind, key), (holding, waiting))| WfSynchronization { kind, key, holding, waiting })
        .collect()
}

pub fn wf_detail(v: &Value, archived: bool) -> Result<WfDetail, AppError> {
    let nodes = nodes_of(v);
    let mut row = wf_row(v, archived);
    // suspend 템플릿에서 기다리는 Workflow는 spec.suspend 없이 Running이다(Argo util.IsWorkflowSuspended와 같은 판단)
    row.suspended |= nodes.iter().any(|n| n.kind == "Suspend" && n.phase == "Running");
    let created_from = origins(&row);
    Ok(WfDetail {
        row,
        nodes,
        parameters: params(v, "/spec/arguments/parameters"),
        entrypoint: text(v, "/spec/entrypoint"),
        service_account: text(v, "/spec/serviceAccountName"),
        active_deadline_seconds: int(v, "/spec/activeDeadlineSeconds"),
        pod_gc: text(v, "/spec/podGC/strategy"),
        ttl: ttl_text(v, "/spec/ttlStrategy"),
        conditions: items(v, "/status/conditions")
            .iter()
            .map(|c| WfCondition {
                kind: text(c, "/type").unwrap_or_default(),
                status: text(c, "/status").unwrap_or_default(),
                message: text(c, "/message"),
            })
            .collect(),
        resources_duration: durations(v, "/status/resourcesDuration"),
        outputs: params(v, "/status/outputs/parameters"),
        created_from,
        synchronization: synchronization(v),
        yaml: yaml_of(v, "Workflow", "workflows", true)?,
    })
}

/// 워크플로 spec 하나에 제한 시간이 있나: 워크플로 수준이나 어느 템플릿에든. templateRef만 쓰면 알 수 없어 있다고 본다(점검이 헛짚지 않게).
fn spec_has_deadline(spec: &Value) -> bool {
    if spec.get("activeDeadlineSeconds").is_some_and(|d| !d.is_null()) {
        return true;
    }
    let templates = items(spec, "/templates");
    if templates.is_empty() {
        return spec.get("workflowTemplateRef").is_some();
    }
    templates.iter().any(|t| t.get("activeDeadlineSeconds").is_some_and(|d| !d.is_null()))
}

fn schedules_of(v: &Value) -> Vec<String> {
    let mut list: Vec<String> = items(v, "/spec/schedules").iter().filter_map(|s| s.as_str().map(str::to_string)).collect();
    if list.is_empty() {
        if let Some(one) = text(v, "/spec/schedule") {
            list.push(one);
        }
    }
    list
}

pub fn cron_row(v: &Value, now: DateTime<Utc>) -> CronRow {
    let schedules = schedules_of(v);
    let timezone = text(v, "/spec/timezone");
    let suspended = v.pointer("/spec/suspend").and_then(Value::as_bool).unwrap_or(false);
    let starting_deadline_seconds = int(v, "/spec/startingDeadlineSeconds");
    let last_scheduled_time = text(v, "/status/lastScheduledTime");
    let spec = v.pointer("/spec/workflowSpec").cloned().unwrap_or(Value::Null);
    let template = text(&spec, "/workflowTemplateRef/name");
    let last = parse_time(last_scheduled_time.as_deref());
    let created = parse_time(text(v, "/metadata/creationTimestamp").as_deref());
    let missed = cron::missed(&schedules, timezone.as_deref(), suspended, last, created, starting_deadline_seconds, now);
    let next_runs = if suspended {
        Vec::new()
    } else {
        cron::next_runs(&schedules, timezone.as_deref(), last.or(created), now, 5)
            .into_iter()
            .map(|d| d.to_rfc3339())
            .collect()
    };
    CronRow {
        namespace: text(v, "/metadata/namespace").unwrap_or_default(),
        name: text(v, "/metadata/name").unwrap_or_default(),
        schedules,
        timezone,
        suspended,
        concurrency_policy: text(v, "/spec/concurrencyPolicy"),
        starting_deadline_seconds,
        last_scheduled_time,
        active: items(v, "/status/active").iter().filter_map(|a| text(a, "/name")).collect(),
        succeeded: int(v, "/status/succeeded"),
        failed: int(v, "/status/failed"),
        next_runs,
        missed,
        service_account: text(&spec, "/serviceAccountName"),
        has_deadline: spec_has_deadline(&spec),
        cluster_template: template.is_some() && spec.pointer("/workflowTemplateRef/clusterScope").and_then(Value::as_bool).unwrap_or(false),
        template,
        labels: string_map(v, "/metadata/labels"),
    }
}

pub fn cron_rows(list_body: &Value, now: DateTime<Utc>) -> Vec<CronRow> {
    list_items(list_body).iter().map(|v| cron_row(v, now)).collect()
}

pub fn cron_detail(v: &Value, now: DateTime<Utc>) -> Result<CronDetail, AppError> {
    Ok(CronDetail {
        row: cron_row(v, now),
        entrypoint: text(v, "/spec/workflowSpec/entrypoint"),
        template: text(v, "/spec/workflowSpec/workflowTemplateRef/name"),
        parameters: params(v, "/spec/workflowSpec/arguments/parameters"),
        yaml: yaml_of(v, "CronWorkflow", "cronworkflows", true)?,
    })
}

pub fn template_row(v: &Value, kind: TemplateKind) -> TemplateRow {
    let spec = v.get("spec").cloned().unwrap_or(Value::Null);
    TemplateRow {
        kind,
        namespace: match kind {
            TemplateKind::WorkflowTemplate => text(v, "/metadata/namespace"),
            TemplateKind::ClusterWorkflowTemplate => None,
        },
        name: text(v, "/metadata/name").unwrap_or_default(),
        description: text(v, &format!("/metadata/annotations/{}", A_DESCRIPTION.replace('/', "~1"))),
        parameters: items(&spec, "/arguments/parameters")
            .iter()
            .filter_map(|p| {
                Some(TemplateParam {
                    name: text(p, "/name")?,
                    value: param_value(p),
                    choices: items(p, "/enum")
                        .iter()
                        .map(|e| e.as_str().map_or_else(|| e.to_string(), str::to_string))
                        .collect(),
                    description: text(p, "/description"),
                })
            })
            .collect(),
        entrypoint: text(&spec, "/entrypoint"),
        templates: items(&spec, "/templates").iter().filter_map(|t| text(t, "/name")).collect(),
        service_account: text(&spec, "/serviceAccountName"),
        has_deadline: spec_has_deadline(&spec),
    }
}

pub fn template_rows(list_body: &Value, kind: TemplateKind) -> Vec<TemplateRow> {
    list_items(list_body).iter().map(|v| template_row(v, kind)).collect()
}

pub fn template_detail(v: &Value, kind: TemplateKind) -> Result<TemplateDetail, AppError> {
    let yaml = match kind {
        TemplateKind::WorkflowTemplate => yaml_of(v, "WorkflowTemplate", "workflowtemplates", true)?,
        TemplateKind::ClusterWorkflowTemplate => yaml_of(v, "ClusterWorkflowTemplate", "clusterworkflowtemplates", false)?,
    };
    Ok(TemplateDetail {
        row: template_row(v, kind),
        yaml,
    })
}

#[cfg(test)]
mod tests;
