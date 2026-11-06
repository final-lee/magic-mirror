//! `managed-resources`·`manifests` 응답을 YAML과 줄 단위 diff로 바꾼다.
use std::collections::BTreeSet;

use serde::Serialize;
use serde_json::Value;

use super::resource::ResRef;
use super::{list, text};
use crate::error::AppError;
use crate::explorer::diff::{build_text_diff, TextDiff};

pub const YAML_UNREADABLE: &str = "리소스 내용을 YAML로 읽지 못했어요";
const MASK: &str = "********";
const CHANGED_MASK: &str = "++++++++";
const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

/// 서버가 문자열로 싣는 매니페스트(JSON). 비었거나 `null`이면 그 쪽에는 리소스가 없다는 뜻이다.
pub fn state_value(raw: Option<&str>) -> Result<Option<Value>, AppError> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty() && *s != "null") else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(raw).map_err(|_| AppError::other(YAML_UNREADABLE))?;
    Ok((!value.is_null()).then_some(value))
}

pub fn yaml_of(value: &Value) -> Result<String, AppError> {
    serde_saphyr::to_string(value).map_err(|_| AppError::other(YAML_UNREADABLE))
}

fn is_secret(v: &Value) -> bool {
    text(v, "/kind") == Some("Secret") && text(v, "/apiVersion") == Some("v1")
}

/// 줄 단위 비교와 화면 보기에서 빼는 필드: 서버가 채우는 소유 기록(managedFields)과, Secret의 평문이 담기는 last-applied 주석.
fn strip_noise(v: &mut Value) {
    if let Some(meta) = v.get_mut("metadata").and_then(Value::as_object_mut) {
        meta.remove("managedFields");
        if let Some(annotations) = meta.get_mut("annotations").and_then(Value::as_object_mut) {
            annotations.remove(LAST_APPLIED);
        }
    }
}

/// Secret의 값(`data`·`stringData`)을 모두 가린다. 다른 종류는 그대로 둔다.
pub fn hide_secret(v: &mut Value) {
    if !is_secret(v) {
        return;
    }
    for field in ["data", "stringData"] {
        if let Some(map) = v.get_mut(field).and_then(Value::as_object_mut) {
            map.values_mut().for_each(|x| *x = Value::String(MASK.into()));
        }
    }
}

/// 두 쪽의 Secret 값을 가리되 같은 키의 값이 다르면 target 쪽 가림 글자를 달리해, 값은 숨겨도 바뀐 것은 diff에 보이게 한다(ArgoCD의 기준).
fn hide_secret_pair(live: &mut Value, target: &mut Value) {
    if !is_secret(live) || !is_secret(target) {
        hide_secret(live);
        hide_secret(target);
        return;
    }
    for field in ["data", "stringData"] {
        let before = live.get(field).cloned().unwrap_or(Value::Null);
        let after = target.get(field).cloned().unwrap_or(Value::Null);
        let keys: BTreeSet<&String> = before.as_object().into_iter().chain(after.as_object()).flat_map(|m| m.keys()).collect();
        for key in keys {
            if let Some(slot) = live.get_mut(field).and_then(Value::as_object_mut).and_then(|map| map.get_mut(key)) {
                *slot = Value::String(MASK.into());
            }
            if let Some(slot) = target.get_mut(field).and_then(Value::as_object_mut).and_then(|map| map.get_mut(key)) {
                *slot = Value::String(if before.get(key) == after.get(key) { MASK } else { CHANGED_MASK }.into());
            }
        }
    }
}

/// 한 리소스의 live·목표 YAML과 그 차이.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ManagedDiff {
    pub live: String,
    pub target: String,
    pub diff: TextDiff,
    /// 줄 단위로 달라진 것이 있다(정규화된 live와 적용 뒤 예상 상태 비교)
    pub changed: bool,
}

/// `managed-resources` 항목 하나의 비교. live는 `normalizedLiveState`(없으면 `liveState`), 목표는 `predictedLiveState`(없으면 `targetState`).
pub fn managed_diff(item: &Value) -> Result<ManagedDiff, AppError> {
    let live = state_value(text(item, "/normalizedLiveState"))?.map_or_else(|| state_value(text(item, "/liveState")), |v| Ok(Some(v)))?;
    let target = state_value(text(item, "/predictedLiveState"))?.map_or_else(|| state_value(text(item, "/targetState")), |v| Ok(Some(v)))?;
    let (mut live, mut target) = (live.unwrap_or(Value::Null), target.unwrap_or(Value::Null));
    strip_noise(&mut live);
    strip_noise(&mut target);
    hide_secret_pair(&mut live, &mut target);
    let render = |v: &Value| if v.is_null() { Ok(String::new()) } else { yaml_of(v) };
    let (live, target) = (render(&live)?, render(&target)?);
    let diff = build_text_diff(&live, &target);
    let changed = diff.stats.added + diff.stats.removed + diff.stats.changed > 0;
    Ok(ManagedDiff { live, target, diff, changed })
}

/// 응답 항목 중 `res`에 해당하는 것(클러스터 범위는 namespace가 비어 있다).
pub fn find_item<'a>(body: &'a Value, res: &ResRef) -> Option<&'a Value> {
    list(body, "/items").iter().find(|i| matches_ref(i, res))
}

fn matches_ref(item: &Value, res: &ResRef) -> bool {
    text(item, "/group").unwrap_or_default() == res.group
        && text(item, "/kind").unwrap_or_default() == res.kind
        && text(item, "/namespace").unwrap_or_default() == res.namespace.as_deref().unwrap_or_default()
        && text(item, "/name").unwrap_or_default() == res.name
}

/// 화면에 보이는 YAML: 소유 기록과 Secret 값을 가리고 읽기 좋게 바꾼다.
pub fn display_yaml(mut v: Value) -> Result<String, AppError> {
    strip_noise(&mut v);
    hide_secret(&mut v);
    yaml_of(&v)
}

/// 리소스 하나의 목표(desired) YAML. 목표가 없으면 None.
pub fn desired_yaml(item: &Value) -> Result<Option<String>, AppError> {
    state_value(text(item, "/targetState"))?.map(display_yaml).transpose()
}

/// 렌더 결과의 리소스 하나와 sync wave·hook 종류.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wave {
    pub group: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    pub wave: i64,
    /// `argocd.argoproj.io/hook` 값(예: `PreSync`). hook이 아니면 None
    pub hook: Option<String>,
}

/// 렌더 결과(`manifests`)에서 리소스마다 sync wave(`argocd.argoproj.io/sync-wave`, 기본 0)와 hook 종류를 읽는다.
pub fn waves_of(body: &Value) -> Vec<Wave> {
    let annotation = |d: &Value, key: &str| d.pointer("/metadata/annotations").and_then(|a| a.get(key)).and_then(Value::as_str).map(str::to_owned);
    list(body, "/manifests")
        .iter()
        .filter_map(Value::as_str)
        .filter_map(|raw| serde_json::from_str::<Value>(raw).ok())
        .map(|d| Wave {
            group: text(&d, "/apiVersion").and_then(|a| a.split_once('/')).map(|(g, _)| g.to_owned()).unwrap_or_default(),
            kind: string(&d, "/kind"),
            namespace: text(&d, "/metadata/namespace").filter(|s| !s.is_empty()).map(str::to_owned),
            name: string(&d, "/metadata/name"),
            wave: annotation(&d, "argocd.argoproj.io/sync-wave").and_then(|w| w.trim().parse().ok()).unwrap_or(0),
            hook: annotation(&d, "argocd.argoproj.io/hook").filter(|h| !h.is_empty()),
        })
        .collect()
}

/// 앱 전체 diff의 한 줄.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDiffRow {
    pub res: ResRef,
    pub sync_status: Option<String>,
    pub health: Option<String>,
    pub hook: bool,
    pub live: String,
    pub target: String,
    pub diff: TextDiff,
    pub changed: bool,
}

fn api_version(item: &Value) -> Option<String> {
    ["/predictedLiveState", "/targetState", "/normalizedLiveState", "/liveState"]
        .into_iter()
        .filter_map(|p| text(item, p))
        .filter_map(|raw| serde_json::from_str::<Value>(raw).ok())
        .find_map(|v| text(&v, "/apiVersion").map(|a| a.rsplit('/').next().unwrap_or(a).to_owned()))
}

/// `managed-resources` 응답과 Application의 `status.resources`로 앱 전체 diff를 만든다(종류·네임스페이스·이름 순).
pub fn app_diff(managed: &Value, app: &Value) -> Result<Vec<AppDiffRow>, AppError> {
    let statuses = list(app, "/status/resources");
    let mut rows = list(managed, "/items")
        .iter()
        .map(|item| {
            let (group, kind, name) = (string(item, "/group"), string(item, "/kind"), string(item, "/name"));
            let namespace = text(item, "/namespace").filter(|s| !s.is_empty()).map(str::to_owned);
            let status = statuses.iter().find(|s| {
                string(s, "/group") == group
                    && string(s, "/kind") == kind
                    && string(s, "/name") == name
                    && text(s, "/namespace").unwrap_or_default() == namespace.as_deref().unwrap_or_default()
            });
            let version = status
                .and_then(|s| text(s, "/version"))
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .or_else(|| api_version(item))
                .unwrap_or_default();
            let d = managed_diff(item)?;
            Ok(AppDiffRow {
                res: ResRef {
                    group,
                    version,
                    kind,
                    namespace,
                    name,
                    uid: None,
                },
                sync_status: status.and_then(|s| text(s, "/status")).map(str::to_owned),
                health: status.and_then(|s| text(s, "/health/status")).map(str::to_owned),
                hook: item.pointer("/hook").and_then(Value::as_bool).unwrap_or(false),
                live: d.live,
                target: d.target,
                diff: d.diff,
                changed: d.changed,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    rows.sort_by(|a, b| (&a.res.kind, &a.res.namespace, &a.res.name).cmp(&(&b.res.kind, &b.res.namespace, &b.res.name)));
    Ok(rows)
}

fn string(v: &Value, path: &str) -> String {
    text(v, path).unwrap_or_default().to_owned()
}

/// 소스 렌더 결과(`manifests`)를 종류·네임스페이스·이름 순으로 정렬해 `---`로 이은 YAML.
fn manifest_docs(body: &Value) -> Result<Vec<Value>, AppError> {
    let mut docs: Vec<Value> = list(body, "/manifests")
        .iter()
        .filter_map(Value::as_str)
        .map(|raw| serde_json::from_str(raw).map_err(|_| AppError::other(YAML_UNREADABLE)))
        .collect::<Result<_, _>>()?;
    docs.sort_by_cached_key(|d| (string(d, "/kind"), string(d, "/metadata/namespace"), string(d, "/metadata/name")));
    Ok(docs)
}

fn render_manifests(docs: Vec<Value>) -> Result<String, AppError> {
    let mut out = Vec::with_capacity(docs.len());
    for doc in docs {
        out.push(yaml_of(&doc)?);
    }
    Ok(out.join("---\n"))
}

/// 리비전 하나를 비교 화면과 같은 규칙으로 정리한 렌더 결과. 시험에서 정렬과 가림을 확인할 때 쓴다.
#[cfg(test)]
pub fn manifests_text(body: &Value) -> Result<String, AppError> {
    let mut docs = manifest_docs(body)?;
    for doc in &mut docs {
        strip_noise(doc);
        hide_secret(doc);
    }
    render_manifests(docs)
}

/// 두 리비전의 렌더 결과를 비교한다.
pub fn manifests_diff(from: &Value, to: &Value) -> Result<TextDiff, AppError> {
    let mut before = manifest_docs(from)?;
    let mut after = manifest_docs(to)?;
    for doc in &mut before {
        strip_noise(doc);
    }
    for doc in &mut after {
        strip_noise(doc);
    }
    let mut matched = vec![false; after.len()];
    for left in &mut before {
        if let Some((index, right)) = after.iter_mut().enumerate().find(|(index, right)| {
            !matched[*index]
                && ["/apiVersion", "/kind", "/metadata/namespace", "/metadata/name"]
                    .iter()
                    .all(|path| string(left, path) == string(right, path))
        }) {
            matched[index] = true;
            hide_secret_pair(left, right);
        } else {
            hide_secret(left);
        }
    }
    for (right, was_matched) in after.iter_mut().zip(matched) {
        if !was_matched {
            hide_secret(right);
        }
    }
    Ok(build_text_diff(&render_manifests(before)?, &render_manifests(after)?))
}

#[cfg(test)]
mod tests;
