//! Argo Workflows API 명령.
use crate::{
    argowf::{
        auth,
        client::{Server, Session, State as WfState},
        kube,
        logs::{self, Message},
        rows::{self, CronDetail, CronRow, TemplateDetail, TemplateKind, TemplateRow, WfDetail},
    },
    error::AppError,
};
use chrono::{DateTime, FixedOffset, Utc};
use reqwest::Method;
use serde_json::{json, Value};
use std::future::Future;
use tauri::{ipc::Channel, State};

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    namespace: Option<String>,
    label_selector: Option<String>,
    name: Option<NameFilter>,
    created_after: Option<String>,
    finished_before: Option<String>,
    phases: Vec<String>,
    limit: u64,
    continue_token: Option<String>,
}

#[derive(Clone, serde::Deserialize)]
struct NameFilter {
    mode: String,
    value: String,
}

fn list_params(query: &ListQuery, archived: bool) -> Vec<(String, String)> {
    let mut params = vec![("listOptions.limit".into(), query.limit.to_string())];
    let mut labels = Vec::new();
    if let Some(s) = query.label_selector.as_deref().filter(|s| !s.is_empty()) {
        labels.push(s.to_owned());
    }
    if !query.phases.is_empty() {
        labels.push(format!("workflows.argoproj.io/phase in ({})", query.phases.join(",")));
    }
    if !labels.is_empty() {
        params.push(("listOptions.labelSelector".into(), labels.join(",")));
    }
    let mut fields = Vec::new();
    if let Some(name) = &query.name {
        fields.push(format!("metadata.name={}", name.value));
        let mode = match name.mode.as_str() {
            "prefix" => "Prefix",
            "contains" => "Contains",
            _ => "Exact",
        };
        params.push(("nameFilter".into(), mode.into()));
    }
    if !fields.is_empty() {
        params.push(("listOptions.fieldSelector".into(), fields.join(",")));
    }
    if let Some(token) = query.continue_token.as_deref().filter(|s| !s.is_empty()) {
        params.push(("listOptions.continue".into(), token.into()));
    }
    if archived {
        if let Some(ns) = query.namespace.as_deref() {
            params.push(("namespace".into(), ns.into()));
        }
    } else {
        if let Some(date) = &query.created_after {
            params.push(("createdAfter".into(), date.clone()));
        }
        if let Some(date) = &query.finished_before {
            params.push(("finishedBefore".into(), date.clone()));
        }
        params.push(("fields".into(), rows::WF_LIST_FIELDS.into()));
    }
    params
}
// v4.1.6은 남은 live Workflow가 있어도 archive에 남은 항목이 없으면 continue를 생략한다.
fn page_continue(body: &Value, query: &ListQuery, archived: bool) -> Option<String> {
    if let Some(token) = body.pointer("/metadata/continue").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return Some(token.to_owned());
    }
    let count = body.get("items").and_then(Value::as_array).map_or(0, Vec::len);
    if !archived && query.limit > 0 && count as u64 == query.limit {
        let offset = query.continue_token.as_deref().unwrap_or("0").parse::<u64>().ok()?;
        return offset.checked_add(count as u64).map(|n| n.to_string());
    }
    None
}

/// 보관 목록 한 번에 서버에서 읽는 최대 쪽 수(날짜 조건을 백엔드에서 거를 때)
const MAX_ARCHIVE_PAGES: usize = 10;

/// 보관 목록의 날짜 조건. 서버는 `spec.startedAt`만 걸러 줘서 생성 시각·종료 시각 기준은 받은 쪽마다 직접 건다.
struct DateBounds {
    created_after: Option<DateTime<FixedOffset>>,
    finished_before: Option<DateTime<FixedOffset>>,
}

impl DateBounds {
    fn parse(query: &ListQuery) -> Result<Self, AppError> {
        let bound = |text: &Option<String>| match text.as_deref().filter(|s| !s.is_empty()) {
            Some(s) => DateTime::parse_from_rfc3339(s).map(Some).map_err(|_| AppError::other("날짜를 읽지 못했어요")),
            None => Ok(None),
        };
        Ok(Self {
            created_after: bound(&query.created_after)?,
            finished_before: bound(&query.finished_before)?,
        })
    }

    fn is_empty(&self) -> bool {
        self.created_after.is_none() && self.finished_before.is_none()
    }

    /// 생성 시각이 기준 이후(같으면 포함)이고 종료 시각이 기준 이전인 항목. 시각이 없거나 읽지 못하면 뺀다.
    fn matches(&self, item: &Value) -> bool {
        let time = |pointer: &str| item.pointer(pointer).and_then(Value::as_str).and_then(|s| DateTime::parse_from_rfc3339(s).ok());
        let created_ok = self.created_after.is_none_or(|after| time("/metadata/creationTimestamp").is_some_and(|created| created >= after));
        let finished_ok = self.finished_before.is_none_or(|before| time("/status/finishedAt").is_some_and(|finished| finished < before));
        created_ok && finished_ok
    }
}

/// 서버 쪽을 이어 읽으며 조건에 맞는 항목을 `limit`개 이상 모으거나 쪽이 끝날 때까지 읽는다.
/// 마지막으로 읽은 쪽의 continue 토큰을 돌려준다. 쪽 일부만 잘라 쓰면 항목을 잃으므로 `limit`을 넘길 수 있다.
async fn collect_pages<F, Fut>(
    start_token: Option<String>,
    limit: u64,
    max_pages: usize,
    bounds: &DateBounds,
    mut fetch: F,
) -> Result<(Vec<Value>, Option<String>, Option<String>), AppError>
where
    F: FnMut(Option<String>) -> Fut,
    Fut: Future<Output = Result<Value, AppError>>,
{
    let mut items = Vec::new();
    let mut token = start_token;
    let mut resource_version = None;
    for _ in 0..max_pages.max(1) {
        let body = fetch(token.clone()).await?;
        if resource_version.is_none() {
            resource_version = body.pointer("/metadata/resourceVersion").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        }
        let page = body.get("items").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        items.extend(page.iter().filter(|item| bounds.matches(item)).cloned());
        token = body.pointer("/metadata/continue").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        if token.is_none() || items.len() as u64 >= limit {
            break;
        }
    }
    Ok((items, token, resource_version))
}

/// 날짜 조건이 있는 보관 목록: 서버가 못 거르므로 쪽마다 걸러 `limit`개를 채울 때까지 이어 읽는다
async fn list_archived_filtered(state: &WfState, server: &Server, query: &ListQuery, bounds: &DateBounds) -> Result<Value, AppError> {
    let (items, token, resource_version) = collect_pages(query.continue_token.clone(), query.limit, MAX_ARCHIVE_PAGES, bounds, |token| {
        let params = list_params(&ListQuery { continue_token: token, ..query.clone() }, true);
        async move {
            let refs: Vec<(&str, &str)> = params.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            state.api(server, Method::GET, &["api", "v1", "archived-workflows"], &refs, None).await
        }
    })
    .await?;
    Ok(json!({
        "rows": rows::wf_rows(&json!({ "items": items }), true),
        "continueToken": token,
        "resourceVersion": resource_version,
    }))
}

async fn list_workflows(state: &WfState, server: &Server, query: &ListQuery, archived: bool) -> Result<Value, AppError> {
    if archived {
        let bounds = DateBounds::parse(query)?;
        if !bounds.is_empty() {
            return list_archived_filtered(state, server, query, &bounds).await;
        }
    }
    let params = list_params(query, archived);
    let refs: Vec<(&str, &str)> = params.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let path = if archived {
        vec!["api", "v1", "archived-workflows"]
    } else {
        vec!["api", "v1", "workflows", query.namespace.as_deref().unwrap_or("")]
    };
    let body = state.api(server, Method::GET, &path, &refs, None).await?;
    Ok(json!({
        "rows": rows::wf_rows(&body, archived),
        "continueToken": page_continue(&body, query, archived),
        "resourceVersion": body.pointer("/metadata/resourceVersion").and_then(Value::as_str).filter(|s| !s.is_empty()),
    }))
}

#[tauri::command]
pub async fn argowf_info(state: State<'_, WfState>, server: Server) -> Result<Value, AppError> {
    let v = state.api(&server, Method::GET, &["api", "v1", "info"], &[], None).await?;
    Ok(
        json!({"managedNamespace": v.get("managedNamespace"), "links": v.get("links").and_then(Value::as_array).cloned().unwrap_or_default(), "columns": v.get("columns").and_then(Value::as_array).cloned().unwrap_or_default()}),
    )
}

#[tauri::command]
pub async fn argowf_userinfo(state: State<'_, WfState>, server: Server) -> Result<Value, AppError> {
    let v = state.api(&server, Method::GET, &["api", "v1", "userinfo"], &[], None).await?;
    Ok(
        json!({"issuer": v.get("issuer"), "subject": v.get("subject"), "groups": v.get("groups").and_then(Value::as_array).cloned().unwrap_or_default(), "email": v.get("email"), "emailVerified": v.get("emailVerified"), "serviceAccountName": v.get("serviceAccountName"), "serviceAccountNamespace": v.get("serviceAccountNamespace")}),
    )
}

#[tauri::command]
pub async fn argowf_copy_token(state: State<'_, WfState>, server: Server) -> Result<String, AppError> {
    state.current_token(&server).await
}

#[tauri::command]
pub fn argowf_contexts(state: State<'_, WfState>) -> Result<Vec<auth::Context>, AppError> {
    Ok(auth::contexts(&auth::load(&state.settings_path)?.config))
}
#[tauri::command]
pub async fn argowf_set_token(state: State<'_, WfState>, url: String, token: String) -> Result<Session, AppError> {
    state.set_token(&url, token).await
}
#[tauri::command]
pub async fn argowf_forget_token(state: State<'_, WfState>, url: String) -> Result<(), AppError> {
    state.forget_token(&url).await
}
#[tauri::command]
pub async fn argowf_session(state: State<'_, WfState>, server: Server) -> Result<Option<Session>, AppError> {
    state.session(&server).await
}
#[tauri::command]
pub async fn argowf_workflows(state: State<'_, WfState>, server: Server, query: ListQuery) -> Result<Value, AppError> {
    list_workflows(&state, &server, &query, false).await
}
#[tauri::command]
pub async fn argowf_archived(state: State<'_, WfState>, server: Server, query: ListQuery) -> Result<Value, AppError> {
    list_workflows(&state, &server, &query, true).await
}
async fn workflow_json(state: &WfState, server: &Server, namespace: &str, name: &str) -> Result<Value, AppError> {
    state.api(server, Method::GET, &["api", "v1", "workflows", namespace, name], &[], None).await
}
#[tauri::command]
pub async fn argowf_workflow(state: State<'_, WfState>, server: Server, namespace: String, name: String) -> Result<WfDetail, AppError> {
    rows::wf_detail(&workflow_json(&state, &server, &namespace, &name).await?, false)
}
#[tauri::command]
pub async fn argowf_archived_workflow(state: State<'_, WfState>, server: Server, uid: String) -> Result<WfDetail, AppError> {
    let v = state.api(&server, Method::GET, &["api", "v1", "archived-workflows", &uid], &[], None).await?;
    rows::wf_detail(&v, true)
}
#[tauri::command]
pub async fn argowf_role_arn(state: State<'_, WfState>, server: Server, namespace: String, service_account: String) -> Result<Option<String>, AppError> {
    kube::role_arn(&state, &server, &namespace, &service_account).await
}
#[tauri::command]
pub async fn argowf_events(state: State<'_, WfState>, server: Server, namespace: String, name: String) -> Result<Vec<kube::EventRow>, AppError> {
    if server.context.is_none() {
        return Err(AppError::other(kube::CONTEXT_REQUIRED));
    }
    let v = workflow_json(&state, &server, &namespace, &name).await?;
    let mut names = rows::pod_names_of(&v);
    names.push(name);
    kube::events(&state, &server, &namespace, names).await
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn argowf_logs(
    app: tauri::AppHandle,
    state: State<'_, WfState>,
    server: Server,
    namespace: String,
    name: String,
    pod_name: Option<String>,
    options: logs::Options,
    on_event: Channel<Message>,
) -> u64 {
    logs::start(app, &state, server, namespace, name, pod_name, options, on_event)
}
#[tauri::command]
pub fn argowf_logs_stop(state: State<'_, WfState>, id: u64) {
    logs::stop(&state, id);
}
/// 목록 경로의 네임스페이스 칸. 없거나 비면 모든 네임스페이스(`""`)
fn scope(namespace: &Option<String>) -> &str {
    namespace.as_deref().filter(|ns| !ns.is_empty()).unwrap_or("")
}
#[tauri::command]
pub async fn argowf_crons(state: State<'_, WfState>, server: Server, namespace: Option<String>) -> Result<Vec<CronRow>, AppError> {
    let query: &[(&str, &str)] = if rows::CRON_LIST_FIELDS.is_empty() {
        &[]
    } else {
        &[("fields", rows::CRON_LIST_FIELDS)]
    };
    let v = state
        .api(&server, Method::GET, &["api", "v1", "cron-workflows", scope(&namespace)], query, None)
        .await?;
    Ok(rows::cron_rows(&v, Utc::now()))
}
#[tauri::command]
pub async fn argowf_cron(state: State<'_, WfState>, server: Server, namespace: String, name: String) -> Result<CronDetail, AppError> {
    let v = state
        .api(&server, Method::GET, &["api", "v1", "cron-workflows", &namespace, &name], &[], None)
        .await?;
    rows::cron_detail(&v, Utc::now())
}
#[tauri::command]
pub async fn argowf_templates(state: State<'_, WfState>, server: Server, namespace: Option<String>) -> Result<Vec<TemplateRow>, AppError> {
    let query: &[(&str, &str)] = if rows::TEMPLATE_LIST_FIELDS.is_empty() {
        &[]
    } else {
        &[("fields", rows::TEMPLATE_LIST_FIELDS)]
    };
    let namespaced = state
        .api(&server, Method::GET, &["api", "v1", "workflow-templates", scope(&namespace)], query, None)
        .await?;
    let cluster = state
        .api(&server, Method::GET, &["api", "v1", "cluster-workflow-templates"], query, None)
        .await?;
    let mut result = rows::template_rows(&namespaced, TemplateKind::WorkflowTemplate);
    result.extend(rows::template_rows(&cluster, TemplateKind::ClusterWorkflowTemplate));
    Ok(result)
}
#[tauri::command]
pub async fn argowf_template(
    state: State<'_, WfState>,
    server: Server,
    kind: TemplateKind,
    namespace: Option<String>,
    name: String,
) -> Result<TemplateDetail, AppError> {
    let ns = namespace.as_deref().ok_or_else(|| AppError::other("네임스페이스를 골라 주세요"));
    let v = match kind {
        TemplateKind::WorkflowTemplate => {
            state
                .api(&server, Method::GET, &["api", "v1", "workflow-templates", ns?, &name], &[], None)
                .await?
        }
        TemplateKind::ClusterWorkflowTemplate => {
            state
                .api(&server, Method::GET, &["api", "v1", "cluster-workflow-templates", &name], &[], None)
                .await?
        }
    };
    rows::template_detail(&v, kind)
}
fn action_kind(action: &Value) -> Result<&str, AppError> {
    action
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::other("동작을 읽지 못했어요"))
}
fn result_name(v: &Value) -> Result<String, AppError> {
    v.pointer("/metadata/name")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AppError::other("생성된 Workflow 이름을 읽지 못했어요"))
}
fn action_body(action: &Value, namespace: Option<&str>) -> Value {
    let mut body = action.clone();
    if let Some(obj) = body.as_object_mut() {
        obj.remove("kind");
        if let Some(ns) = namespace {
            obj.insert("namespace".into(), json!(ns));
        }
        if let Some(outputs) = obj.get("outputParameters") {
            obj.insert("outputParameters".into(), Value::String(outputs.to_string()));
        }
    }
    body
}
async fn workflow_action(state: &WfState, server: &Server, namespace: &str, name: &str, action: &Value) -> Result<Option<String>, AppError> {
    let kind = action_kind(action)?;
    if !matches!(
        kind,
        "stop" | "terminate" | "suspend" | "resume" | "retry" | "resubmit" | "delete" | "setOutputs"
    ) {
        return Err(AppError::other("알 수 없는 동작이에요"));
    }
    let body = action_body(action, None);
    let path = ["api", "v1", "workflows", namespace, name];
    let v = if kind == "delete" {
        state.api(server, Method::DELETE, &path, &[], None).await?
    } else {
        let mut path = path.to_vec();
        path.push(if kind == "setOutputs" { "set" } else { kind });
        state.api(server, Method::PUT, &path, &[], Some(&body)).await?
    };
    if kind == "resubmit" {
        Ok(Some(result_name(&v)?))
    } else {
        Ok(None)
    }
}
#[tauri::command]
pub async fn argowf_workflow_action(
    state: State<'_, WfState>,
    server: Server,
    namespace: String,
    name: String,
    action: Value,
) -> Result<Option<String>, AppError> {
    workflow_action(&state, &server, &namespace, &name, &action).await
}

#[derive(serde::Deserialize)]
pub struct BatchTarget {
    namespace: String,
    name: String,
}

#[tauri::command]
pub async fn argowf_batch_action(state: State<'_, WfState>, server: Server, targets: Vec<BatchTarget>, action: Value) -> Result<Vec<Value>, AppError> {
    let mut results = Vec::with_capacity(targets.len());
    for target in targets {
        let result = workflow_action(&state, &server, &target.namespace, &target.name, &action).await;
        let (created, error) = match result {
            Ok(created) => (created, None),
            Err(error) => (None, Some(error.to_string())),
        };
        results.push(json!({"namespace": target.namespace, "name": target.name, "ok": error.is_none(), "error": error, "created": created}));
    }
    Ok(results)
}
#[tauri::command]
pub async fn argowf_archived_action(
    state: State<'_, WfState>,
    server: Server,
    uid: String,
    namespace: String,
    action: Value,
) -> Result<Option<String>, AppError> {
    let kind = action_kind(&action)?;
    if !matches!(kind, "retry" | "resubmit" | "delete") {
        return Err(AppError::other("알 수 없는 동작이에요"));
    }
    let path = ["api", "v1", "archived-workflows", &uid];
    let body = action_body(&action, Some(&namespace));
    let v = if kind == "delete" {
        state.api(&server, Method::DELETE, &path, &[], None).await?
    } else {
        let mut path = path.to_vec();
        path.push(kind);
        state.api(&server, Method::PUT, &path, &[], Some(&body)).await?
    };
    if kind == "resubmit" || kind == "retry" {
        Ok(Some(result_name(&v)?))
    } else {
        Ok(None)
    }
}
#[tauri::command]
pub async fn argowf_cron_action(state: State<'_, WfState>, server: Server, namespace: String, name: String, action: Value) -> Result<Option<String>, AppError> {
    let kind = action_kind(&action)?;
    match kind {
        "submit" => {
            let v = state
                .api(
                    &server,
                    Method::POST,
                    &["api", "v1", "workflows", &namespace, "submit"],
                    &[],
                    Some(&json!({"resourceKind":"CronWorkflow", "resourceName":name})),
                )
                .await?;
            Ok(Some(result_name(&v)?))
        }
        "delete" => {
            state
                .api(&server, Method::DELETE, &["api", "v1", "cron-workflows", &namespace, &name], &[], None)
                .await?;
            Ok(None)
        }
        "suspend" | "resume" => {
            state
                .api(
                    &server,
                    Method::PUT,
                    &["api", "v1", "cron-workflows", &namespace, &name, kind],
                    &[],
                    Some(&json!({})),
                )
                .await?;
            Ok(None)
        }
        _ => Err(AppError::other("알 수 없는 동작이에요")),
    }
}
#[tauri::command]
pub async fn argowf_submit_template(
    state: State<'_, WfState>,
    server: Server,
    kind: TemplateKind,
    template_namespace: Option<String>,
    namespace: String,
    name: String,
    options: Value,
) -> Result<String, AppError> {
    let resource_kind = match kind {
        TemplateKind::WorkflowTemplate => {
            if template_namespace.as_deref() != Some(namespace.as_str()) {
                return Err(AppError::other("템플릿의 네임스페이스에서 실행해 주세요"));
            }
            "WorkflowTemplate"
        }
        TemplateKind::ClusterWorkflowTemplate => "ClusterWorkflowTemplate",
    };
    let v = state
        .api(
            &server,
            Method::POST,
            &["api", "v1", "workflows", &namespace, "submit"],
            &[],
            Some(&json!({"resourceKind": resource_kind, "resourceName": name, "submitOptions": options})),
        )
        .await?;
    result_name(&v)
}

#[tauri::command]
pub fn argowf_watch(
    app: tauri::AppHandle,
    state: State<'_, WfState>,
    server: Server,
    namespace: Option<String>,
    label_selector: Option<String>,
    resource_version: Option<String>,
    on_event: Channel<Value>,
) -> u64 {
    crate::argowf::watch::start(app, &state, server, namespace, label_selector, resource_version, None, on_event)
}

#[tauri::command]
pub fn argowf_watch_workflow(
    app: tauri::AppHandle,
    state: State<'_, WfState>,
    server: Server,
    namespace: String,
    name: String,
    resource_version: Option<String>,
    on_event: Channel<Value>,
) -> u64 {
    crate::argowf::watch::start(app, &state, server, Some(namespace), None, resource_version, Some(name), on_event)
}

#[tauri::command]
pub fn argowf_watch_stop(state: State<'_, WfState>, id: u64) {
    crate::argowf::watch::stop(&state, id);
}

#[tauri::command]
pub async fn argowf_plugins(state: State<'_, WfState>, server: Server, namespace: Option<String>) -> Result<Vec<Value>, AppError> {
    kube::plugins(&state, &server, namespace.as_deref()).await
}

#[tauri::command]
pub async fn argowf_save_text(app: tauri::AppHandle, suggested_name: String, text: String) -> Result<Option<String>, AppError> {
    crate::argowf::artifacts::save_text(app, suggested_name, text).await
}

#[tauri::command]
pub async fn argowf_artifact_preview(state: State<'_, WfState>, server: Server, artifact: crate::argowf::artifacts::Artifact) -> Result<Value, AppError> {
    crate::argowf::artifacts::preview(&state, &server, &artifact).await
}

#[tauri::command]
pub async fn argowf_save_artifact(
    app: tauri::AppHandle,
    state: State<'_, WfState>,
    server: Server,
    artifact: crate::argowf::artifacts::Artifact,
) -> Result<Option<String>, AppError> {
    crate::argowf::artifacts::save_artifact(app, &state, &server, &artifact).await
}

#[tauri::command]
pub fn argowf_resource_logs(
    app: tauri::AppHandle,
    state: State<'_, WfState>,
    server: Server,
    kind: String,
    namespace: String,
    name: String,
    on_event: Channel<Message>,
) -> Result<u64, AppError> {
    crate::argowf::resource_logs::start(app, &state, server, kind, namespace, name, on_event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argowf_list_params_and_actions() {
        let query: ListQuery = serde_json::from_value(json!({
            "namespace":"demo", "labelSelector":"team=a", "name":{"mode":"prefix","value":"job"},
            "createdAfter":"2026-01-01T00:00:00Z", "finishedBefore":null,
            "phases":["Running","Failed"], "limit":2, "continueToken":"2"
        }))
        .unwrap();
        let params = list_params(&query, false);
        assert!(params.contains(&("nameFilter".into(), "Prefix".into())));
        assert!(params.contains(&("listOptions.fieldSelector".into(), "metadata.name=job".into())));
        assert!(params.contains(&(
            "listOptions.labelSelector".into(),
            "team=a,workflows.argoproj.io/phase in (Running,Failed)".into()
        )));
        assert!(params.contains(&("listOptions.continue".into(), "2".into())));
        assert_eq!(page_continue(&json!({"items":[{},{}]}), &query, false).as_deref(), Some("4"));
        assert_eq!(page_continue(&json!({"items":[{}]}), &query, false), None);
        assert_eq!(
            page_continue(&json!({"items":[{},{}], "metadata":{"continue":"9"}}), &query, false).as_deref(),
            Some("9")
        );
        let archived = list_params(&query, true);
        assert!(archived.contains(&("namespace".into(), "demo".into())));
        assert!(archived.contains(&("listOptions.fieldSelector".into(), "metadata.name=job".into())));
        let set = action_body(
            &json!({"kind":"setOutputs","nodeFieldSelector":"id=n","outputParameters":{"result":"yes"},"phase":"Succeeded"}),
            None,
        );
        assert_eq!(set["outputParameters"], "{\"result\":\"yes\"}");
        assert_eq!(set["nodeFieldSelector"], "id=n");
        let retry = action_body(&json!({"kind":"retry","nodeFieldSelector":"id=n","parameters":["a=b"]}), None);
        assert_eq!(retry["nodeFieldSelector"], "id=n");
        assert_eq!(retry["parameters"][0], "a=b");
    }

    fn wf(name: &str, created: &str, finished: Option<&str>) -> Value {
        json!({ "metadata": { "name": name, "creationTimestamp": created }, "status": { "finishedAt": finished } })
    }

    fn page(items: Vec<Value>, next: Option<&str>) -> Value {
        json!({ "items": items, "metadata": { "continue": next } })
    }

    fn bounds(created_after: Option<&str>, finished_before: Option<&str>) -> DateBounds {
        let query: ListQuery = serde_json::from_value(json!({
            "createdAfter": created_after, "finishedBefore": finished_before, "phases": [], "limit": 2
        }))
        .unwrap();
        DateBounds::parse(&query).unwrap()
    }

    fn names(items: &[Value]) -> Vec<&str> {
        items.iter().filter_map(|i| i.pointer("/metadata/name").and_then(Value::as_str)).collect()
    }

    #[test]
    fn archive_dates_are_not_sent_as_started_at_selectors() {
        let query: ListQuery = serde_json::from_value(json!({
            "name": {"mode":"exact","value":"job"}, "createdAfter": "2026-01-01T00:00:00Z",
            "finishedBefore": "2026-02-01T00:00:00Z", "phases": [], "limit": 2
        }))
        .unwrap();
        let params = list_params(&query, true);
        assert!(params.contains(&("listOptions.fieldSelector".into(), "metadata.name=job".into())));
        assert!(params.iter().all(|(k, v)| k != "createdAfter" && k != "finishedBefore" && !v.contains("startedAt")));
    }

    #[test]
    fn date_bounds_use_creation_and_finish_times() {
        let b = bounds(Some("2026-01-02T00:00:00Z"), Some("2026-01-04T00:00:00Z"));
        assert!(b.matches(&wf("ok", "2026-01-02T00:00:00Z", Some("2026-01-03T00:00:00Z"))));
        assert!(!b.matches(&wf("early", "2026-01-01T23:59:59Z", Some("2026-01-03T00:00:00Z"))));
        assert!(!b.matches(&wf("late", "2026-01-03T00:00:00Z", Some("2026-01-04T00:00:00Z"))));
        assert!(!b.matches(&wf("running", "2026-01-03T00:00:00Z", None)));
        assert!(bounds(Some("2026-01-02T00:00:00Z"), None).matches(&wf("running", "2026-01-03T00:00:00Z", None)));
        assert!(bounds(None, None).is_empty());
    }

    #[test]
    fn filtered_pages_keep_fetching_until_limit_and_return_last_token() {
        let b = bounds(Some("2026-01-02T00:00:00Z"), None);
        let pages = [
            page(vec![wf("a", "2026-01-01T00:00:00Z", None), wf("b", "2026-01-02T00:00:00Z", None)], Some("t1")),
            page(vec![wf("c", "2026-01-01T00:00:00Z", None), wf("d", "2025-12-01T00:00:00Z", None)], Some("t2")),
            page(vec![wf("e", "2026-01-05T00:00:00Z", None), wf("f", "2026-01-06T00:00:00Z", None)], Some("t3")),
            page(vec![wf("g", "2026-01-07T00:00:00Z", None)], None),
        ];
        let mut seen = Vec::new();
        let (items, token, _) = tauri::async_runtime::block_on(collect_pages(None, 3, 10, &b, |t| {
            seen.push(t);
            let body = pages[seen.len() - 1].clone();
            async move { Ok(body) }
        }))
        .unwrap();
        assert_eq!(names(&items), ["b", "e", "f"]);
        assert_eq!(token.as_deref(), Some("t3"));
        assert_eq!(seen, [None, Some("t1".to_string()), Some("t2".to_string())]);
    }

    #[test]
    fn filtered_pages_stop_at_the_end_or_the_page_cap() {
        let b = bounds(Some("2030-01-01T00:00:00Z"), None);
        let mut calls = 0;
        let (items, token, _) = tauri::async_runtime::block_on(collect_pages(Some("t0".into()), 5, 10, &b, |_| {
            calls += 1;
            let next = format!("t{calls}");
            async move { Ok(page(vec![wf("x", "2026-01-01T00:00:00Z", None)], Some(&next))) }
        }))
        .unwrap();
        assert!(items.is_empty());
        assert_eq!((calls, token.as_deref()), (10, Some("t10")));

        let (items, token, _) = tauri::async_runtime::block_on(collect_pages(None, 5, 10, &b, |_| async { Ok(page(vec![], None)) })).unwrap();
        assert!(items.is_empty() && token.is_none());
    }
}
