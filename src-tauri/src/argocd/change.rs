use super::{resource::ResRef, ArgocdState};
use crate::{
    error::AppError,
    explorer::diff::{build_text_diff, TextDiff},
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoTarget {
    pub namespace: String,
    pub name: String,
    pub project: String,
    pub env: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ArgoChange {
    Refresh {
        hard: bool,
    },
    Sync {
        revision: Option<String>,
        resources: Option<Vec<ResRef>>,
        prune: bool,
        dry_run: bool,
        apply_only: bool,
        force: bool,
        server_side_apply: bool,
        replace: bool,
        prune_last: bool,
        create_namespace: bool,
        apply_out_of_sync_only: bool,
        respect_ignore_differences: bool,
        retry: Option<Value>,
    },
    Terminate,
    Rollback {
        id: i64,
        prune: bool,
        dry_run: bool,
        disable_auto_sync: bool,
    },
    ResourceAction {
        res: ResRef,
        action: String,
        params: Vec<Value>,
    },
    ResourceDelete {
        res: ResRef,
        force: bool,
        orphan: bool,
    },
    ResourcePatch {
        res: ResRef,
        patch: String,
        patch_type: String,
    },
    AppSpec {
        yaml: String,
    },
    AppPatch {
        patch: Value,
    },
    AppDelete {
        cascade: bool,
        propagation_policy: Option<String>,
    },
    AppCreate {
        yaml: String,
        upsert: bool,
    },
    AppSetUpsert {
        yaml: String,
    },
    AppSetDelete {
        name: String,
        namespace: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiCall {
    pub verb: String,
    pub path: String,
    pub body: Option<Value>,
    #[serde(skip)]
    segments: Vec<String>,
    #[serde(skip)]
    query: Vec<(String, String)>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgoPreview {
    pub title: String,
    pub calls: Vec<ApiCall>,
    pub diff: Option<TextDiff>,
    pub impact: Vec<String>,
    pub warnings: Vec<String>,
    pub blocked: Option<String>,
    pub confirm_name: Option<String>,
    pub expected_version: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct ArgoApplyResult {
    pub message: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct ArgoChangeRecord {
    pub at: String,
    pub server: String,
    pub user: Option<String>,
    pub namespace: String,
    pub name: String,
    pub kind: String,
    pub summary: String,
    pub calls: Vec<ApiCall>,
    pub ok: bool,
    pub error: Option<String>,
}

fn call(verb: &str, parts: &[&str], query: Vec<(&str, String)>, body: Option<Value>) -> ApiCall {
    let segments: Vec<String> = parts.iter().map(|s| (*s).into()).collect();
    let query: Vec<(String, String)> = query.into_iter().map(|(k, v)| (k.into(), v)).collect();
    let mut url = url::Url::parse("http://localhost/").unwrap();
    url.path_segments_mut().unwrap().extend(parts.iter().copied());
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    }
    let path = match url.query() {
        Some(q) => format!("{}?{}", url.path(), q),
        None => url.path().to_owned(),
    };
    ApiCall {
        verb: verb.into(),
        path,
        body,
        segments,
        query,
    }
}
fn yaml(s: &str) -> Result<Value, AppError> {
    serde_saphyr::from_str(s).map_err(|e| AppError::other(format!("YAML을 읽지 못했어요: {e}")))
}
fn check_identity(value: &Value, target: &ArgoTarget) -> Result<(), AppError> {
    let name = value.pointer("/metadata/name").and_then(Value::as_str);
    let namespace = value.pointer("/metadata/namespace").and_then(Value::as_str);
    if name != Some(target.name.as_str()) || namespace != Some(target.namespace.as_str()) {
        return Err(AppError::other("YAML의 이름과 네임스페이스가 대상과 일치하지 않아요"));
    }
    Ok(())
}
fn create_identity(value: &mut Value, target: &ArgoTarget) -> Result<(), AppError> {
    if let Some(metadata) = value.get_mut("metadata").and_then(Value::as_object_mut) {
        if !metadata.contains_key("namespace") {
            metadata.insert("namespace".into(), Value::String(target.namespace.clone()));
        }
    }
    check_identity(value, target)
}
fn yaml_text(v: &Value) -> Result<String, AppError> {
    serde_saphyr::to_string(v).map_err(|e| AppError::other(format!("YAML을 만들지 못했어요: {e}")))
}
fn diff(a: &Value, b: &Value) -> Result<TextDiff, AppError> {
    Ok(build_text_diff(&yaml_text(a)?, &yaml_text(b)?))
}
fn merge(a: &mut Value, b: &Value) {
    if let Value::Object(p) = b {
        if !a.is_object() {
            *a = json!({});
        }
        let obj = a.as_object_mut().unwrap();
        for (k, v) in p {
            if v.is_null() {
                obj.remove(k);
            } else {
                merge(obj.entry(k).or_insert(Value::Null), v);
            }
        }
    } else {
        *a = b.clone();
    }
}
fn selected(value: &Value, patch: &Value) -> Value {
    match (value.as_object(), patch.as_object()) {
        (Some(source), Some(fields)) => Value::Object(
            fields
                .iter()
                .filter_map(|(key, field)| source.get(key).map(|v| (key.clone(), selected(v, field))))
                .collect(),
        ),
        _ => value.clone(),
    }
}
/// 리소스 패치 종류(`merge`·`strategic`·`json`)를 서버가 Kubernetes에 그대로 넘기는 미디어 타입으로 바꾼다.
fn patch_media_type(kind: &str) -> Result<&'static str, AppError> {
    match kind {
        "merge" => Ok("application/merge-patch+json"),
        "strategic" => Ok("application/strategic-merge-patch+json"),
        "json" => Ok("application/json-patch+json"),
        other => Err(AppError::other(format!("지원하지 않는 패치 종류예요: {other}"))),
    }
}
fn resource_query<'a>(t: &'a ArgoTarget, r: &'a ResRef) -> Vec<(&'a str, String)> {
    vec![
        ("namespace", r.namespace.clone().unwrap_or_default()),
        ("resourceName", r.name.clone()),
        ("version", r.version.clone()),
        ("group", r.group.clone()),
        ("kind", r.kind.clone()),
        ("appNamespace", t.namespace.clone()),
        ("project", t.project.clone()),
    ]
}
fn patch_call(t: &ArgoTarget, patch: &Value) -> Result<ApiCall, AppError> {
    Ok(call(
        "PATCH",
        &["api", "v1", "applications", &t.name],
        vec![],
        Some(
            json!({"name":t.name,"appNamespace":t.namespace,"project":t.project,"patch":serde_json::to_string(patch).map_err(|e| AppError::other(e.to_string()))?,"patchType":"merge"}),
        ),
    ))
}
fn change_kind(c: &ArgoChange) -> &'static str {
    match c {
        ArgoChange::Refresh { .. } => "refresh",
        ArgoChange::Sync { .. } => "sync",
        ArgoChange::Terminate => "terminate",
        ArgoChange::Rollback { .. } => "rollback",
        ArgoChange::ResourceAction { .. } => "resourceAction",
        ArgoChange::ResourceDelete { .. } => "resourceDelete",
        ArgoChange::ResourcePatch { .. } => "resourcePatch",
        ArgoChange::AppSpec { .. } => "appSpec",
        ArgoChange::AppPatch { .. } => "appPatch",
        ArgoChange::AppDelete { .. } => "appDelete",
        ArgoChange::AppCreate { .. } => "appCreate",
        ArgoChange::AppSetUpsert { .. } => "appSetUpsert",
        ArgoChange::AppSetDelete { .. } => "appSetDelete",
    }
}
fn title(c: &ArgoChange) -> &'static str {
    match c {
        ArgoChange::Refresh { .. } => "새로고침",
        ArgoChange::Sync { .. } => "동기화",
        ArgoChange::Terminate => "작업 중단",
        ArgoChange::Rollback { .. } => "롤백",
        ArgoChange::ResourceAction { .. } => "리소스 작업",
        ArgoChange::ResourceDelete { .. } => "리소스 삭제",
        ArgoChange::ResourcePatch { .. } => "리소스 수정",
        ArgoChange::AppSpec { .. } | ArgoChange::AppPatch { .. } => "앱 수정",
        ArgoChange::AppDelete { .. } => "앱 삭제",
        ArgoChange::AppCreate { .. } => "앱 생성",
        ArgoChange::AppSetUpsert { .. } => "ApplicationSet 저장",
        ArgoChange::AppSetDelete { .. } => "ApplicationSet 삭제",
    }
}
fn plan(t: &ArgoTarget, c: &ArgoChange, current: Option<&Value>, windows: Option<&Value>) -> Result<ArgoPreview, AppError> {
    let mut calls = Vec::new();
    let mut impact = Vec::new();
    let mut warnings = Vec::new();
    let mut blocked = None;
    let mut comparison = None;
    let base = ["api", "v1", "applications", t.name.as_str()];
    let ns = || vec![("appNamespace", t.namespace.clone())];
    let auto = current
        .and_then(|v| v.pointer("/spec/syncPolicy/automated"))
        .is_some_and(|v| !v.is_null() && v.get("enabled").and_then(Value::as_bool) != Some(false));
    if let Some(v) = current {
        if v.pointer("/metadata/ownerReferences")
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|x| x.get("kind").and_then(Value::as_str) == Some("ApplicationSet")))
        {
            warnings.push("ApplicationSet이 변경을 되돌리거나 다시 만들 수 있어요".into());
        }
        if [
            "/metadata/labels/app.kubernetes.io~1instance",
            "/metadata/labels/argocd.argoproj.io~1instance",
            "/metadata/annotations/argocd.argoproj.io~1tracking-id",
        ]
        .iter()
        .any(|p| v.pointer(p).and_then(Value::as_str).is_some_and(|s| !s.is_empty()))
        {
            warnings.push("상위 앱 동기화가 Git 기준으로 변경을 되돌릴 수 있어요".into());
        }
        if matches!(c, ArgoChange::ResourcePatch { .. }) && v.pointer("/spec/syncPolicy/automated/selfHeal").and_then(Value::as_bool) == Some(true) {
            warnings.push("자동 복구가 리소스 변경을 곧 되돌릴 수 있어요".into());
        }
    }
    if windows.and_then(|w| w.get("canSync")).and_then(Value::as_bool) == Some(false) {
        blocked = Some("동기화 윈도우가 이 작업을 막고 있어요".into());
    }
    match c {
        ArgoChange::Refresh { hard } => calls.push(call("GET", &base, vec![("appNamespace", t.namespace.clone()), ("refresh", if *hard { "hard" } else { "normal" }.into())], None)),
        ArgoChange::Sync { revision, resources, prune, dry_run, apply_only, force, server_side_apply, replace, prune_last, create_namespace, apply_out_of_sync_only, respect_ignore_differences, retry } => {
            let opts = [("ServerSideApply", server_side_apply), ("Replace", replace), ("PruneLast", prune_last), ("CreateNamespace", create_namespace), ("ApplyOutOfSyncOnly", apply_out_of_sync_only), ("RespectIgnoreDifferences", respect_ignore_differences)].into_iter().filter_map(|(n, b)| if *b { Some(format!("{n}=true")) } else { None }).collect::<Vec<_>>();
            let mut body = json!({"appNamespace":t.namespace,"prune":prune,"dryRun":dry_run,"strategy": if *apply_only {json!({"apply":{"force":force}})} else {json!({"hook":{"syncStrategyApply":{"force":force}}})},"syncOptions":{"items":opts}});
            if let Some(r) = revision {
                body["revision"] = json!(r);
            }
            if let Some(rs) = resources {
                body["resources"] = Value::Array(rs.iter().map(|r| json!({"group":r.group,"kind":r.kind,"name":r.name,"namespace":r.namespace})).collect());
            }
            if let Some(r) = retry {
                body["retryStrategy"] = r.clone();
            }
            calls.push(call("POST", &["api", "v1", "applications", &t.name, "sync"], vec![], Some(body)));
            if *prune && !*dry_run {
                impact.push("Git에 없는 관리 리소스를 삭제해요".into());
            }
            if *dry_run {
                impact.push("시험 실행이라 리소스를 변경하지 않아요".into());
            }
        }
        ArgoChange::Terminate => calls.push(call("DELETE", &["api", "v1", "applications", &t.name, "operation"], ns(), None)),
        ArgoChange::Rollback { id, prune, dry_run, disable_auto_sync } => {
            if auto && !disable_auto_sync {
                blocked = Some("자동 동기화를 끈 뒤 롤백해 주세요".into());
            }
            if auto && *disable_auto_sync {
                calls.push(patch_call(t, &json!({"spec":{"syncPolicy":{"automated":null}}}))?);
                impact.push("자동 동기화를 꺼요".into());
            }
            calls.push(call("POST", &["api", "v1", "applications", &t.name, "rollback"], vec![], Some(json!({"id":id,"prune":prune,"dryRun":dry_run,"appNamespace":t.namespace}))));
            if *prune && !*dry_run {
                impact.push("대상 리비전에 없는 리소스를 삭제해요".into());
            }
            if *dry_run {
                impact.push("롤백은 시험 실행이라 리소스를 변경하지 않아요".into());
            }
        }
        ArgoChange::ResourceAction { res, action, params } => calls.push(call("POST", &["api", "v1", "applications", &t.name, "resource", "actions", "v2"], vec![], Some(json!({"name":t.name,"appNamespace":t.namespace,"project":t.project,"namespace":res.namespace,"resourceName":res.name,"group":res.group,"version":res.version,"kind":res.kind,"action":action,"resourceActionParameters":params})))),
        ArgoChange::ResourceDelete { res, force, orphan } => {
            let mut q = resource_query(t, res);
            q.push(("force", force.to_string()));
            q.push(("orphan", orphan.to_string()));
            calls.push(call("DELETE", &["api", "v1", "applications", &t.name, "resource"], q, None));
            impact.push("선택한 리소스를 삭제해요".into());
            if *orphan {
                impact.push("하위 리소스는 지우지 않고 남겨요".into());
            }
            if *force {
                impact.push("하위 리소스 삭제를 기다리지 않고 바로 지워요".into());
            }
        }
        ArgoChange::ResourcePatch { res, patch, patch_type } => {
            serde_json::from_str::<Value>(patch).map_err(|e| AppError::other(format!("패치가 올바른 JSON이 아니에요: {e}")))?;
            let mut q = resource_query(t, res);
            q.push(("patchType", patch_media_type(patch_type)?.into()));
            calls.push(call("POST", &["api", "v1", "applications", &t.name, "resource"], q, Some(json!(patch))));
            impact.push("선택한 리소스를 클러스터에서 바로 수정해요".into());
        }
        ArgoChange::AppSpec { yaml: input } => {
            let new = yaml(input)?;
            comparison = Some(diff(current.and_then(|v| v.get("spec")).unwrap_or(&Value::Null), &new)?);
            calls.push(call("PUT", &["api", "v1", "applications", &t.name, "spec"], ns(), Some(new)));
        }
        ArgoChange::AppPatch { patch } => {
            let old = current.cloned().unwrap_or(Value::Null);
            let mut new = old.clone();
            merge(&mut new, patch);
            comparison = Some(diff(&selected(&old, patch), &selected(&new, patch))?);
            calls.push(patch_call(t, patch)?);
        }
        ArgoChange::AppDelete { cascade, propagation_policy } => {
            let mut q = ns();
            q.push(("cascade", cascade.to_string()));
            if let Some(p) = propagation_policy {
                q.push(("propagationPolicy", p.clone()));
            }
            calls.push(call("DELETE", &base, q, None));
            impact.push(if *cascade { "앱과 관리 리소스를 삭제해요" } else { "앱만 삭제하고 리소스는 남겨요" }.into());
        }
        ArgoChange::AppCreate { yaml: input, upsert } => {
            if *upsert {
                return Err(AppError::other("앱 생성에서 덮어쓰기는 사용할 수 없어요"));
            }
            let mut new = yaml(input)?;
            create_identity(&mut new, t)?;
            calls.push(call("POST", &["api", "v1", "applications"], vec![("upsert", "false".into()), ("validate", "true".into())], Some(new)));
        }
        ArgoChange::AppSetUpsert { yaml: input } => {
            let mut new = yaml(input)?;
            if current.is_some() {
                check_identity(&new, t)?;
            } else {
                create_identity(&mut new, t)?;
            }
            if let Some(old) = current {
                comparison = Some(diff(old, &new)?);
            }
            calls.push(call("POST", &["api", "v1", "applicationsets"], vec![("upsert", "true".into())], Some(new)));
        }
        ArgoChange::AppSetDelete { name, namespace } => {
            if name != &t.name || namespace != &t.namespace {
                return Err(AppError::other("대상 ApplicationSet이 일치하지 않아요"));
            }
            calls.push(call("DELETE", &["api", "v1", "applicationsets", name], vec![("appsetNamespace", namespace.clone())], None));
            impact.push("ApplicationSet을 삭제해요".into());
        }
    }
    let confirm = t.env.as_deref() == Some("prd")
        || t.name.to_lowercase().contains("prod")
        || matches!(
            c,
            ArgoChange::AppDelete { .. } | ArgoChange::AppSetDelete { .. } | ArgoChange::Rollback { .. } | ArgoChange::ResourceDelete { .. }
        );
    if current.is_some()
        && !matches!(c, ArgoChange::Refresh { .. } | ArgoChange::AppCreate { .. })
        && current
            .and_then(|v| v.pointer("/metadata/resourceVersion"))
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .is_none()
    {
        return Err(AppError::other("대상의 리소스 버전을 읽지 못했어요"));
    }
    Ok(ArgoPreview {
        title: title(c).into(),
        calls,
        diff: comparison,
        impact,
        warnings,
        blocked,
        confirm_name: confirm.then(|| t.name.clone()),
        expected_version: current.map(fingerprint),
    })
}

/// 미리 본 대상이 그 뒤에 바뀌었는지 가리는 값. Application의 resourceVersion은 컨트롤러가 상태를 고칠 때마다(조정 시각, 헬스) 바뀌므로
/// 사람이 바꾸는 설정(spec, 레이블, annotation, finalizer, 삭제 표시)만 본다. 새로고침 요청 annotation은 컨트롤러가 곧 지우므로 뺀다.
pub(crate) fn fingerprint(v: &Value) -> String {
    use sha2::{Digest, Sha256};
    let mut annotations = v.pointer("/metadata/annotations").cloned().unwrap_or(Value::Null);
    if let Some(map) = annotations.as_object_mut() {
        map.remove("argocd.argoproj.io/refresh");
        map.remove("argocd.argoproj.io/hydrate");
    }
    let config = json!({
        "spec": v.get("spec"),
        "labels": v.pointer("/metadata/labels"),
        "annotations": annotations,
        "finalizers": v.pointer("/metadata/finalizers"),
        "deleting": v.pointer("/metadata/deletionTimestamp"),
    });
    let digest = Sha256::digest(config.to_string().as_bytes());
    digest.iter().take(12).map(|b| format!("{b:02x}")).collect()
}

async fn current(state: &ArgocdState, url: &str, t: &ArgoTarget, c: &ArgoChange) -> Result<Option<Value>, AppError> {
    match c {
        ArgoChange::AppCreate { .. } | ArgoChange::Refresh { .. } => Ok(None),
        ArgoChange::AppSetUpsert { .. } => {
            let v = state
                .api(url, Method::GET, &["api", "v1", "applicationsets"], &[("appsetNamespace", &t.namespace)], None)
                .await?;
            Ok(super::list(&v, "/items")
                .iter()
                .find(|v| v.pointer("/metadata/name").and_then(Value::as_str) == Some(&t.name) && v.pointer("/metadata/namespace").and_then(Value::as_str) == Some(&t.namespace))
                .cloned())
        }
        ArgoChange::AppSetDelete { .. } => state
            .api(url, Method::GET, &["api", "v1", "applicationsets", &t.name], &[("appsetNamespace", &t.namespace)], None)
            .await
            .map(Some),
        _ => state
            .api(url, Method::GET, &["api", "v1", "applications", &t.name], &[("appNamespace", &t.namespace)], None)
            .await
            .map(Some),
    }
}
pub async fn preview(state: &ArgocdState, url: &str, t: &ArgoTarget, c: &ArgoChange) -> Result<ArgoPreview, AppError> {
    let app = current(state, url, t, c).await?;
    let windows = if matches!(c, ArgoChange::Sync { .. } | ArgoChange::Rollback { .. }) {
        Some(
            state
                .api(
                    url,
                    Method::GET,
                    &["api", "v1", "applications", &t.name, "syncwindows"],
                    &[("appNamespace", &t.namespace), ("project", &t.project)],
                    None,
                )
                .await?,
        )
    } else {
        None
    };
    plan(t, c, app.as_ref(), windows.as_ref())
}
pub async fn apply(state: &ArgocdState, url: &str, t: &ArgoTarget, c: &ArgoChange, expected: Option<String>, confirm: Option<String>) -> Result<ArgoApplyResult, AppError> {
    let mut calls = Vec::new();
    let user = state
        .api(url, Method::GET, &["api", "v1", "session", "userinfo"], &[], None)
        .await
        .ok()
        .and_then(|v| v.get("username").and_then(Value::as_str).map(str::to_owned));
    let result: Result<ArgoApplyResult, AppError> = async {
        let p = preview(state, url, t, c).await?;
        calls = p.calls;
        if !matches!(c, ArgoChange::Refresh { .. } | ArgoChange::AppCreate { .. }) && p.expected_version != expected {
            return Err(AppError::other("미리 본 뒤 앱이 바뀌었어요. 다시 미리 봐 주세요"));
        }
        if p.confirm_name.is_some() && p.confirm_name != confirm && !matches!(c, ArgoChange::Refresh { .. }) {
            return Err(AppError::other("확인 이름이 일치하지 않아요"));
        }
        if let Some(reason) = p.blocked {
            return Err(AppError::other(reason));
        }
        for c in &calls {
            let method = Method::from_bytes(c.verb.as_bytes()).map_err(|e| AppError::other(e.to_string()))?;
            let segments: Vec<&str> = c.segments.iter().map(String::as_str).collect();
            let query: Vec<(&str, &str)> = c.query.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            state.api(url, method, &segments, &query, c.body.as_ref()).await?;
        }
        Ok(ArgoApplyResult {
            message: format!("{} 요청을 보냈어요", title(c)),
        })
    }
    .await;
    let record = ArgoChangeRecord {
        at: chrono::Utc::now().to_rfc3339(),
        server: url.trim_end_matches('/').into(),
        user,
        namespace: t.namespace.clone(),
        name: t.name.clone(),
        kind: change_kind(c).into(),
        summary: title(c).into(),
        calls: audit_calls(&calls),
        ok: result.is_ok(),
        error: result.as_ref().err().map(|_| "요청을 완료하지 못했어요".into()),
    };
    crate::jsonl::append(&state.changes_path(), &record).map_err(|e| AppError::other(format!("변경 기록을 저장하지 못했어요: {e}")))?;
    result
}
fn audit_calls(calls: &[ApiCall]) -> Vec<ApiCall> {
    calls
        .iter()
        .cloned()
        .map(|mut call| {
            call.body = call.body.map(|_| Value::String("[REDACTED]".into()));
            call
        })
        .collect()
}
pub fn changes(state: &ArgocdState, url: &str) -> Vec<ArgoChangeRecord> {
    crate::jsonl::read_all::<ArgoChangeRecord>(&state.changes_path())
        .into_iter()
        .filter(|r| r.server == url.trim_end_matches('/'))
        .collect()
}

#[cfg(test)]
mod tests;
