//! 미리보기와 적용 직전의 상태를 읽어 리비전과 버전을 재확인한다.
use kube::api::ListParams;
use kube::Client;
use serde::Serialize;
use serde_json::Value;

use super::change::{self, Change, ChangeObject, Operation, Plan};
use super::drain;
use super::failure::Endpoint;
use super::read::{api_for, bounded, list_all};
use super::rows::KindRef;
use crate::error::AppError;

pub const REVISION_MISSING: &str = "선택한 롤아웃 리비전을 찾을 수 없어요";
pub const CONFIRM_REQUIRED: &str = "리소스 이름을 정확히 입력해 주세요";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub revision: String,
    pub name: String,
}

/// 객체를 읽는다. Secret의 값은 이 함수의 반환값 밖으로 전달하지 않는다.
pub async fn current(client: Client, endpoint: Endpoint, target: &ChangeObject) -> Result<Option<Value>, AppError> {
    let api = api_for(client, &target.kind, target.namespace.as_deref());
    let object = bounded(api.get_opt(&target.name), "get", &target.kind.plural, endpoint).await?;
    object.map(|o| serde_json::to_value(o).map_err(|_| AppError::other(change::INVALID_CHANGE))).transpose()
}

/// 워크로드 UID를 소유자로 가진 리비전만 돌려준다.
async fn history(client: Client, endpoint: Endpoint, target: &ChangeObject, object: &Value) -> Result<Vec<(Revision, Value)>, AppError> {
    let uid = object.pointer("/metadata/uid").and_then(Value::as_str).ok_or_else(|| AppError::other(REVISION_MISSING))?;
    let deployment = target.kind.group == "apps" && target.kind.kind == "Deployment";
    if target.kind.group != "apps" || !matches!(target.kind.kind.as_str(), "Deployment" | "StatefulSet" | "DaemonSet") {
        return Err(AppError::other(change::INVALID_CHANGE));
    }
    let (revision_kind, plural) = if deployment {
        ("ReplicaSet", "replicasets")
    } else {
        ("ControllerRevision", "controllerrevisions")
    };
    let kind = KindRef {
        group: "apps".into(),
        version: "v1".into(),
        kind: revision_kind.into(),
        plural: plural.into(),
        namespaced: true,
    };
    let api = api_for(client, &kind, target.namespace.as_deref());
    let (items, _) = list_all(&api, &ListParams::default(), 100, &kind.plural, endpoint).await?;
    let mut revisions = Vec::new();
    for item in items {
        if !item.metadata.owner_references.as_ref().is_some_and(|owners| owners.iter().any(|owner| owner.uid == uid)) {
            continue;
        }
        let value = serde_json::to_value(&item).map_err(|_| AppError::other(REVISION_MISSING))?;
        let number = if deployment {
            value.pointer("/metadata/annotations/deployment.kubernetes.io~1revision").and_then(Value::as_str).map(str::to_owned)
        } else {
            value.get("revision").and_then(Value::as_i64).map(|n| n.to_string())
        };
        let template = if deployment {
            value.pointer("/spec/template")
        } else {
            value.pointer("/data/spec/template")
        };
        if let (Some(revision), Some(template), Some(name)) = (number, template, item.metadata.name) {
            let mut template = template.clone();
            if let Some(map) = template.as_object_mut() {
                map.remove("$patch");
            }
            if deployment {
                if let Some(labels) = template.pointer_mut("/metadata/labels").and_then(Value::as_object_mut) {
                    labels.remove("pod-template-hash");
                }
            }
            revisions.push((Revision { revision, name }, template));
        }
    }
    revisions.sort_by_key(|item| std::cmp::Reverse(item.0.revision.parse::<i64>().unwrap_or(0)));
    Ok(revisions)
}

pub async fn revisions(client: Client, endpoint: Endpoint, target: &ChangeObject) -> Result<Vec<Revision>, AppError> {
    let object = current(client.clone(), endpoint, target).await?.ok_or_else(|| AppError::other(REVISION_MISSING))?;
    Ok(history(client, endpoint, target, &object).await?.into_iter().map(|(revision, _)| revision).collect())
}

/// 노드에 있는 Pod. 모든 네임스페이스에서 `spec.nodeName`으로 고른다.
async fn pods_on(client: Client, endpoint: Endpoint, node: &str) -> Result<Vec<Value>, AppError> {
    let kind = KindRef { group: String::new(), version: "v1".into(), kind: "Pod".into(), plural: "pods".into(), namespaced: true };
    let api = api_for(client, &kind, None);
    let params = ListParams::default().fields(&format!("spec.nodeName={node}"));
    let (items, _) = list_all(&api, &params, 100, &kind.plural, endpoint).await?;
    items.into_iter().map(|item| serde_json::to_value(item).map_err(|_| AppError::other(change::INVALID_CHANGE))).collect()
}

/// 모든 PodDisruptionBudget. 읽을 권한이 없으면 None(막히는 Pod를 알 수 없다고 미리보기가 알린다).
async fn budgets(client: Client, endpoint: Endpoint) -> Result<Option<Vec<Value>>, AppError> {
    let kind = KindRef { group: "policy".into(), version: "v1".into(), kind: "PodDisruptionBudget".into(), plural: "poddisruptionbudgets".into(), namespaced: true };
    let api = api_for(client, &kind, None);
    match list_all(&api, &ListParams::default(), 100, &kind.plural, endpoint).await {
        Ok((items, _)) => items
            .into_iter()
            .map(|item| serde_json::to_value(item).map_err(|_| AppError::other(change::INVALID_CHANGE)))
            .collect::<Result<_, _>>()
            .map(Some),
        Err(AppError::AccessDenied { .. }) => Ok(None),
        Err(error) => Err(error),
    }
}

pub async fn make_plan(client: Client, endpoint: Endpoint, change: &Change, now: &str) -> Result<Plan, AppError> {
    Ok(plan_with_current(client, endpoint, change, now).await?.0)
}

/// 계획과 그 계획을 만든 현재 객체. 차이 계산에 현재 객체가 필요한 변경이 있다.
async fn plan_with_current(client: Client, endpoint: Endpoint, change: &Change, now: &str) -> Result<(Plan, Option<Value>), AppError> {
    let object = current(client.clone(), endpoint, &change.target).await?;
    if matches!(change.operation, Operation::Drain) {
        let node = object.ok_or_else(|| AppError::other(change::MISSING_VERSION))?;
        let pods = pods_on(client.clone(), endpoint, &change.target.name).await?;
        let budgets = budgets(client, endpoint).await?;
        return Ok((drain::preview(change, &node, drain::plan_drain(&node, &pods, budgets.as_deref()))?, Some(node)));
    }
    let revisions = if matches!(change.operation, Operation::RolloutUndo { .. }) {
        history(client, endpoint, &change.target, object.as_ref().ok_or_else(|| AppError::other(REVISION_MISSING))?).await?
    } else {
        Vec::new()
    };
    let template = match &change.operation {
        Operation::RolloutUndo { revision } => Some(&revisions.iter().find(|(r, _)| &r.revision == revision).ok_or_else(|| AppError::other(REVISION_MISSING))?.1),
        _ => None,
    };
    let mut plan = change::plan(change, object.as_ref(), template, now)?;
    if matches!(change.operation, Operation::RolloutUndo { .. }) {
        if let Some(current_template) = object.as_ref().and_then(|v| v.pointer("/spec/template")) {
            let mut current_template = current_template.clone();
            if let Some(labels) = current_template.pointer_mut("/metadata/labels").and_then(Value::as_object_mut) {
                labels.remove("pod-template-hash");
            }
            if let Some((revision, _)) = revisions.iter().find(|(_, template)| *template == current_template) {
                plan.inverse = Some(Change { target: change.target.clone(), operation: Operation::RolloutUndo { revision: revision.revision.clone() } });
                plan.preview.reversible = true;
            }
        }
        if plan.inverse.is_none() {
            return Err(AppError::other(REVISION_MISSING));
        }
    }
    Ok((plan, object))
}

pub fn check(seen: Option<&Plan>, current: &Plan, confirmation: Option<&str>) -> Result<(), AppError> {
    let seen = seen.ok_or_else(|| AppError::other(super::exec::STALE))?;
    if !change::same_except_version(seen, current) {
        return Err(AppError::other(super::exec::STALE));
    }
    if !seen.preview.conflicts.is_empty() {
        return Err(AppError::other(super::exec::CONFLICT));
    }
    if seen.preview.confirm_name.as_deref().is_some_and(|name| Some(name) != confirmation) {
        return Err(AppError::other(CONFIRM_REQUIRED));
    }
    Ok(())
}

/// drain 적용 직전 확인: 미리보기를 본 노드와 옮길 Pod가 그대로이고 노드 이름을 정확히 입력했는가.
pub fn check_drain(seen: Option<&Plan>, current: &Plan, confirmation: Option<&str>) -> Result<(), AppError> {
    let seen = seen.ok_or_else(|| AppError::other(super::exec::STALE))?;
    let unchanged = seen.fingerprint == current.fingerprint
        && match (&seen.preview.drain, &current.preview.drain) {
            (Some(seen), Some(current)) => drain::same_targets(seen, current),
            _ => false,
        };
    if !unchanged {
        return Err(AppError::other(super::exec::STALE));
    }
    if seen.preview.confirm_name.is_none() || seen.preview.confirm_name.as_deref() != confirmation {
        return Err(AppError::other(CONFIRM_REQUIRED));
    }
    Ok(())
}

/// 서버 dry-run. server-side apply는 서버가 만든 결과로 필드 차이를 채우고, 충돌이면 충돌 목록을 채운다.
async fn dry_run(client: Client, endpoint: Endpoint, change: &Change, plan: &mut Plan, current: Option<&Value>) -> Result<(), AppError> {
    if !matches!(change.operation, Operation::Apply { .. }) {
        return super::exec::run(client, endpoint, change, plan, true).await;
    }
    match super::exec::server_apply(client, endpoint, change, plan, true).await {
        Ok(result) => {
            plan.preview.diff = change::apply::diff(&change.target, current, &result);
            if current.is_some() && plan.preview.diff.is_empty() {
                plan.preview.warnings.push(change::NOOP_WARNING.into());
            }
            Ok(())
        }
        Err(super::exec::ApplyFailure::Conflicts(conflicts)) => {
            plan.preview.conflicts = conflicts;
            Ok(())
        }
        Err(super::exec::ApplyFailure::Failed(error)) => Err(error),
    }
}

/// 최신 객체로 계획하고 서버 dry-run한다.
pub async fn dry_plan(client: Client, endpoint: Endpoint, change: &Change, at: &str) -> Result<Plan, AppError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let (mut plan, mut current) = plan_with_current(client.clone(), endpoint, change, at).await?;
    loop {
        match dry_run(client.clone(), endpoint, change, &mut plan, current.as_ref()).await {
            Ok(()) => return Ok(plan),
            Err(error) if error == AppError::other(super::exec::STALE) && plan.version.is_some() && std::time::Instant::now() < deadline => {
                let (next, next_current) = plan_with_current(client.clone(), endpoint, change, at).await?;
                if next.version == plan.version {
                    return Err(error);
                }
                plan = next;
                current = next_current;
            }
            Err(error) => return Err(error),
        }
    }
}

/// 사용자가 본 계획을 확인한 다음 상태만 변한 경우 새 버전으로 재시도한다.
pub async fn apply_plan(client: Client, endpoint: Endpoint, change: &Change, seen: &Plan, at: &str, confirmation: Option<&str>) -> Result<(Plan, Result<(), AppError>), AppError> {
    let mut plan = dry_plan(client.clone(), endpoint, change, at).await?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        check(Some(seen), &plan, confirmation)?;
        let result = super::exec::run(client.clone(), endpoint, change, &plan, false).await;
        if result != Err(AppError::other(super::exec::STALE)) || plan.version.is_none() || std::time::Instant::now() >= deadline {
            return Ok((plan, result));
        }
        let next = dry_plan(client.clone(), endpoint, change, at).await?;
        if next.version == plan.version {
            return Ok((plan, result));
        }
        check(Some(seen), &next, confirmation)?;
        plan = next;
    }
}
