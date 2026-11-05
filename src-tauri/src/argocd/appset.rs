//! ApplicationSet 읽기: 상세 한 화면 분량 만들기, 만든 앱·generate 응답 다듬기.
use serde::Serialize;
use serde_json::{json, Map, Value};

use super::diff::yaml_of;
use super::{list, text};
use crate::error::AppError;

const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";
/// generator 한 칸에서 종류를 가리키는 키(selector·template 같은 곁가지는 종류가 아니다)
const GENERATOR_KINDS: [&str; 9] = [
    "list",
    "clusters",
    "git",
    "scmProvider",
    "clusterDecisionResource",
    "pullRequest",
    "matrix",
    "merge",
    "plugin",
];
const GENERATE_FAILED: &str = "ApplicationSet YAML을 읽지 못했어요";

/// generator 하나: 종류와 한 줄 설명.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorInfo {
    pub kind: String,
    pub detail: Option<String>,
}

/// 만들 Application의 틀 요약.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub name: Option<String>,
    pub project: Option<String>,
    /// `저장소 경로|차트 @ 리비전` 한 줄씩
    pub sources: Vec<String>,
    pub destination: Option<String>,
}

/// Progressive Sync(`spec.strategy`): 단계마다 어떤 앱을 몇 개씩 올리는지.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyInfo {
    pub kind: String,
    pub steps: Vec<StepInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepInfo {
    /// `키 연산자 값` 한 줄씩
    pub matches: Vec<String>,
    /// 한 번에 올릴 수(숫자 또는 "25%")
    pub max_update: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSetCondition {
    pub r#type: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub last_transition_time: Option<String>,
}

/// `status.applicationStatus`: Progressive Sync가 보는 앱별 상태.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSetAppStatus {
    pub application: String,
    pub status: String,
    /// 1부터 세는 단계 번호(글자 그대로)
    pub step: Option<String>,
    pub message: Option<String>,
    pub last_transition_time: Option<String>,
}

/// ApplicationSet 상세.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSetDetail {
    pub name: String,
    pub namespace: String,
    pub resource_version: String,
    /// 편집·저장에 쓰는 매니페스트(apiVersion·kind·metadata·spec). status와 서버가 채우는 필드는 뺀다
    pub yaml: String,
    pub generators: Vec<GeneratorInfo>,
    pub template: TemplateInfo,
    pub strategy: Option<StrategyInfo>,
    /// 지우면 만든 앱도 지워진다(이 값이 참이면 남긴다)
    pub preserve_resources_on_deletion: bool,
    pub go_template: bool,
    pub conditions: Vec<AppSetCondition>,
    pub application_status: Vec<AppSetAppStatus>,
}

/// 이 ApplicationSet이 만든 앱 하나와 그 spec(미리 보기 비교용).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSetApp {
    pub name: String,
    pub namespace: String,
    pub yaml: String,
}

/// generate가 만들어 본 앱 하나. `yaml`은 [`AppSetApp::yaml`]과 같은 모양(spec)이라 그대로 비교할 수 있다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedApp {
    pub name: String,
    pub namespace: String,
    pub project: Option<String>,
    pub destination: Option<String>,
    pub sources: Vec<String>,
    pub yaml: String,
}

fn opt(v: &Value, path: &str) -> Option<String> {
    text(v, path).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn nested_kinds(g: &Value) -> Vec<String> {
    list(g, "/generators")
        .iter()
        .flat_map(|inner| GENERATOR_KINDS.iter().filter(|k| inner.get(**k).is_some()).map(|k| (*k).to_owned()))
        .collect()
}

fn selector_text(selector: &Value) -> Option<String> {
    let labels: Vec<String> = selector
        .pointer("/matchLabels")
        .and_then(Value::as_object)
        .map(|m| m.iter().map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or_default())).collect())
        .unwrap_or_default();
    let expressions: Vec<String> = list(selector, "/matchExpressions")
        .iter()
        .map(|e| {
            format!(
                "{} {} {}",
                text(e, "/key").unwrap_or_default(),
                text(e, "/operator").unwrap_or_default(),
                list(e, "/values").iter().filter_map(Value::as_str).collect::<Vec<_>>().join(",")
            )
        })
        .collect();
    let all: Vec<String> = labels.into_iter().chain(expressions).collect();
    (!all.is_empty()).then(|| all.join(", "))
}

/// 종류 키가 가리키는 값을 한 줄로.
fn generator_detail(kind: &str, body: &Value) -> Option<String> {
    match kind {
        "list" => Some(format!("요소 {}개", list(body, "/elements").len())),
        "clusters" => body.get("selector").and_then(selector_text).map(|s| format!("선택: {s}")),
        "git" => {
            let at = [opt(body, "/repoURL"), opt(body, "/revision").map(|r| format!("@ {r}"))]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
            let paths: Vec<String> = list(body, "/directories").iter().chain(list(body, "/files")).filter_map(|p| opt(p, "/path")).collect();
            let all = [Some(at).filter(|s| !s.is_empty()), (!paths.is_empty()).then(|| paths.join(", "))]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · ");
            Some(all).filter(|s| !s.is_empty())
        }
        "matrix" => Some(nested_kinds(body).join(" × ")).filter(|s| !s.is_empty()),
        "merge" => Some(nested_kinds(body).join(" + ")).filter(|s| !s.is_empty()),
        "scmProvider" | "pullRequest" => body
            .as_object()
            .and_then(|o| {
                o.keys()
                    .find(|k| !matches!(k.as_str(), "requeueAfterSeconds" | "filters" | "template" | "values" | "pullRequestState"))
            })
            .cloned(),
        "clusterDecisionResource" | "plugin" => opt(body, "/configMapRef").or_else(|| opt(body, "/configMapRef/name")),
        _ => None,
    }
}

/// `spec.generators`를 종류별 한 줄로 푼다. 한 칸에 여러 종류가 있어도(손으로 쓴 경우) 모두 센다.
pub fn generators_of(spec: &Value) -> Vec<GeneratorInfo> {
    list(spec, "/generators")
        .iter()
        .flat_map(|g| {
            GENERATOR_KINDS.iter().filter_map(move |kind| {
                g.get(*kind).map(|body| GeneratorInfo {
                    kind: (*kind).to_owned(),
                    detail: generator_detail(kind, body),
                })
            })
        })
        .collect()
}

fn source_text(s: &Value) -> String {
    let place = opt(s, "/chart").or_else(|| opt(s, "/path")).unwrap_or_default();
    let rev = opt(s, "/targetRevision").map(|r| format!("@ {r}")).unwrap_or_default();
    [opt(s, "/repoURL").unwrap_or_default(), place, rev]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn destination_text(d: &Value) -> Option<String> {
    let target = opt(d, "/name").or_else(|| opt(d, "/server"));
    let text = [target, opt(d, "/namespace")].into_iter().flatten().collect::<Vec<_>>().join("/");
    Some(text).filter(|s| !s.is_empty())
}

fn sources_of(spec: &Value) -> Vec<String> {
    let sources = list(spec, "/sources");
    if !sources.is_empty() {
        return sources.iter().map(source_text).collect();
    }
    spec.get("source").map(source_text).filter(|s| !s.is_empty()).into_iter().collect()
}

fn template_of(spec: &Value) -> TemplateInfo {
    let t = spec.get("template").unwrap_or(&Value::Null);
    let inner = t.get("spec").unwrap_or(&Value::Null);
    TemplateInfo {
        name: opt(t, "/metadata/name"),
        project: opt(inner, "/project"),
        sources: sources_of(inner),
        destination: inner.get("destination").and_then(destination_text),
    }
}

fn strategy_of(spec: &Value) -> Option<StrategyInfo> {
    let strategy = spec.get("strategy").filter(|s| s.is_object())?;
    let kind = opt(strategy, "/type").unwrap_or_else(|| {
        if strategy.get("rollingSync").is_some() {
            "RollingSync".into()
        } else {
            "AllAtOnce".into()
        }
    });
    let steps = list(strategy, "/rollingSync/steps")
        .iter()
        .map(|step| StepInfo {
            matches: list(step, "/matchExpressions")
                .iter()
                .map(|m| {
                    format!(
                        "{} {} {}",
                        text(m, "/key").unwrap_or_default(),
                        text(m, "/operator").unwrap_or_default(),
                        list(m, "/values").iter().filter_map(Value::as_str).collect::<Vec<_>>().join(",")
                    )
                })
                .collect(),
            max_update: step
                .get("maxUpdate")
                .and_then(|v| v.as_str().map(str::to_owned).or_else(|| v.as_i64().map(|n| n.to_string()))),
        })
        .collect();
    Some(StrategyInfo { kind, steps })
}

fn conditions_of(d: &Value) -> Vec<AppSetCondition> {
    list(d, "/status/conditions")
        .iter()
        .map(|c| AppSetCondition {
            r#type: text(c, "/type").unwrap_or_default().into(),
            status: text(c, "/status").unwrap_or_default().into(),
            reason: opt(c, "/reason"),
            message: opt(c, "/message"),
            last_transition_time: opt(c, "/lastTransitionTime"),
        })
        .collect()
}

fn app_status_of(d: &Value) -> Vec<AppSetAppStatus> {
    list(d, "/status/applicationStatus")
        .iter()
        .map(|s| AppSetAppStatus {
            application: text(s, "/application").unwrap_or_default().into(),
            status: text(s, "/status").unwrap_or_default().into(),
            step: opt(s, "/step"),
            message: opt(s, "/message"),
            last_transition_time: opt(s, "/lastTransitionTime"),
        })
        .collect()
}

/// 서버가 채우는 필드를 뺀, 저장할 수 있는 매니페스트.
fn manifest_of(d: &Value) -> Value {
    let mut meta = Map::new();
    for key in ["name", "namespace"] {
        if let Some(v) = d.pointer(&format!("/metadata/{key}")) {
            meta.insert(key.into(), v.clone());
        }
    }
    if let Some(labels) = d.pointer("/metadata/labels").filter(|l| l.as_object().is_some_and(|o| !o.is_empty())) {
        meta.insert("labels".into(), labels.clone());
    }
    if let Some(mut annotations) = d.pointer("/metadata/annotations").and_then(Value::as_object).cloned() {
        annotations.remove(LAST_APPLIED);
        if !annotations.is_empty() {
            meta.insert("annotations".into(), Value::Object(annotations));
        }
    }
    json!({"apiVersion": text(d, "/apiVersion").unwrap_or("argoproj.io/v1alpha1"), "kind": "ApplicationSet", "metadata": meta, "spec": d.get("spec").cloned().unwrap_or_else(|| json!({}))})
}

/// ApplicationSet 응답에서 상세를 만든다.
pub fn appset_detail(d: &Value) -> Result<AppSetDetail, AppError> {
    let spec = d.get("spec").unwrap_or(&Value::Null);
    Ok(AppSetDetail {
        name: text(d, "/metadata/name").unwrap_or_default().into(),
        namespace: text(d, "/metadata/namespace").unwrap_or_default().into(),
        resource_version: text(d, "/metadata/resourceVersion").unwrap_or_default().into(),
        yaml: yaml_of(&manifest_of(d))?,
        generators: generators_of(spec),
        template: template_of(spec),
        strategy: strategy_of(spec),
        preserve_resources_on_deletion: spec.pointer("/syncPolicy/preserveResourcesOnDeletion").and_then(Value::as_bool).unwrap_or(false),
        go_template: spec.get("goTemplate").and_then(Value::as_bool).unwrap_or(false),
        conditions: conditions_of(d),
        application_status: app_status_of(d),
    })
}

/// 비교하려고 앱의 spec만 YAML로(null 값은 뺀다).
fn spec_yaml(app: &Value) -> Result<String, AppError> {
    let mut spec = app.get("spec").cloned().unwrap_or_else(|| json!({}));
    drop_nulls(&mut spec);
    yaml_of(&spec)
}

fn drop_nulls(v: &mut Value) {
    match v {
        Value::Object(map) => {
            map.retain(|_, v| !v.is_null());
            map.values_mut().for_each(drop_nulls);
        }
        Value::Array(items) => items.iter_mut().for_each(drop_nulls),
        _ => {}
    }
}

/// 목록 응답에서 이 ApplicationSet이 소유한 앱.
pub fn owned_apps(body: &Value, namespace: &str, name: &str) -> Result<Vec<AppSetApp>, AppError> {
    let owned = |a: &&Value| {
        text(a, "/metadata/namespace") == Some(namespace)
            && list(a, "/metadata/ownerReferences")
                .iter()
                .any(|o| text(o, "/kind") == Some("ApplicationSet") && text(o, "/name") == Some(name))
    };
    let mut apps = list(body, "/items")
        .iter()
        .filter(owned)
        .map(|a| {
            Ok(AppSetApp {
                name: text(a, "/metadata/name").unwrap_or_default().into(),
                namespace: namespace.into(),
                yaml: spec_yaml(a)?,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    apps.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(apps)
}

/// generate 요청 본문. 읽을 수 없거나 spec이 없으면 서버에 보내지 않는다.
pub fn generate_request(yaml: &str) -> Result<Value, AppError> {
    let set: Value = serde_saphyr::from_str(yaml).map_err(|e| AppError::other(format!("{GENERATE_FAILED}: {e}")))?;
    if !set.is_object() || set.get("spec").is_none_or(Value::is_null) {
        return Err(AppError::other(GENERATE_FAILED));
    }
    Ok(json!({"applicationSet": set}))
}

/// generate 응답에서 앱을 이름 순으로.
pub fn generated_apps(body: &Value) -> Result<Vec<GeneratedApp>, AppError> {
    let mut apps = list(body, "/applications")
        .iter()
        .map(|a| {
            let spec = a.get("spec").unwrap_or(&Value::Null);
            Ok(GeneratedApp {
                name: text(a, "/metadata/name").unwrap_or_default().into(),
                namespace: text(a, "/metadata/namespace").unwrap_or_default().into(),
                project: opt(spec, "/project"),
                destination: spec.get("destination").and_then(destination_text),
                sources: sources_of(spec),
                yaml: spec_yaml(a)?,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    apps.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
    Ok(apps)
}

#[cfg(test)]
mod tests;
