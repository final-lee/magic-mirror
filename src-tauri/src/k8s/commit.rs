//! 미리보기와 적용 직전의 상태를 읽어 리비전과 버전을 재확인한다.
use kube::api::ListParams;
use kube::Client;
use serde::Serialize;
use serde_json::Value;

use super::change::{self, Change, ChangeObject, Operation, Plan};
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

pub async fn make_plan(client: Client, endpoint: Endpoint, change: &Change, now: &str) -> Result<Plan, AppError> {
    let object = current(client.clone(), endpoint, &change.target).await?;
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
    }
    Ok(plan)
}

pub fn check(seen: Option<&Plan>, current: &Plan, confirmation: Option<&str>) -> Result<(), AppError> {
    let seen = seen.ok_or_else(|| AppError::other(super::exec::STALE))?;
    if !change::same_except_version(seen, current) {
        return Err(AppError::other(super::exec::STALE));
    }
    if seen.preview.confirm_name.as_deref().is_some_and(|name| Some(name) != confirmation) {
        return Err(AppError::other(CONFIRM_REQUIRED));
    }
    Ok(())
}

/// 최신 객체로 계획하고 서버 dry-run한다.
pub async fn dry_plan(client: Client, endpoint: Endpoint, change: &Change, at: &str) -> Result<Plan, AppError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut plan = make_plan(client.clone(), endpoint, change, at).await?;
    loop {
        match super::exec::run(client.clone(), endpoint, change, &plan, true).await {
            Ok(()) => return Ok(plan),
            Err(error) if error == AppError::other(super::exec::STALE) && plan.version.is_some() && std::time::Instant::now() < deadline => {
                let next = make_plan(client.clone(), endpoint, change, at).await?;
                if next.version == plan.version {
                    return Err(error);
                }
                plan = next;
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
