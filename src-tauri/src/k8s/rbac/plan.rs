//! 바인딩 변경(만들기·지우기·주체 편집)의 요청·필드 차이·역변경을 계산한다(순수). 실효 권한 영향과 위험 판단은 `assess`가 더한다.
use std::collections::BTreeSet;

use serde_json::{json, Value};

use super::{is_binding, SubjectSpec, BINDING_EXISTS, BINDING_MISSING, INVALID_BINDING, RBAC_API_VERSION, RBAC_GROUP};
use crate::error::AppError;
use crate::k8s::change::{clean_object, fingerprint, ApiCall, Change, ChangeObject, FieldDiff, Operation, Plan, Preview, INVALID_CHANGE, MISSING_VERSION, NOOP_WARNING, OWNER_WARNING};

pub const EMPTY_SUBJECTS_WARNING: &str = "주체가 하나도 남지 않아 이 바인딩은 아무에게도 적용되지 않아요";
pub const SYSTEM_BINDING_WARNING: &str = "시스템 기본 바인딩이라 API 서버가 다시 만들 수 있어요";
pub const CREATE_IMPACT: &str = "새 바인딩을 만듭니다";
pub const DELETE_IMPACT: &str = "바인딩을 삭제합니다. 이 바인딩으로 받던 권한이 사라져요";
pub const SUBJECTS_IMPACT: &str = "바인딩의 주체를 바꿉니다";
/// 아직 만들지 않은 바인딩을 이어서 계획할 때 그 객체에 달아 두는 리소스 버전. 실제 적용은 그때 읽은 버전을 쓴다.
const SIMULATED_VERSION: &str = "0";

/// 바인딩 하나의 API 경로. `collection`이면 이름을 붙이지 않는다.
fn path(target: &ChangeObject, collection: bool) -> String {
    let kind = &target.kind;
    let namespace = target.namespace.as_ref().filter(|_| kind.namespaced).map(|ns| format!("/namespaces/{ns}")).unwrap_or_default();
    let name = if collection { String::new() } else { format!("/{}", target.name) };
    format!("/apis/{RBAC_GROUP}/{}{namespace}/{}{name}", kind.version, kind.plural)
}

fn valid_target(target: &ChangeObject) -> bool {
    let namespaced = target.namespace.as_ref().is_some_and(|ns| !ns.is_empty());
    is_binding(&target.kind) && target.kind.version == "v1" && !target.name.is_empty() && target.kind.namespaced == namespaced
}

/// 객체가 대상이 가리키는 바인딩인가(종류·버전·이름)
fn is_that_binding(target: &ChangeObject, object: &Value) -> bool {
    object.get("kind").and_then(Value::as_str) == Some(target.kind.kind.as_str())
        && object.get("apiVersion").and_then(Value::as_str) == Some(RBAC_API_VERSION)
        && object.pointer("/metadata/name").and_then(Value::as_str) == Some(target.name.as_str())
}

fn subjects_of(object: &Value) -> Vec<Value> {
    object.get("subjects").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn label(target: &ChangeObject) -> String {
    match &target.namespace {
        Some(ns) if target.kind.namespaced => format!("{} {ns}/{}", target.kind.kind, target.name),
        _ => format!("{} {}", target.kind.kind, target.name),
    }
}

/// 만들 바인딩을 확인하고 서버가 채우는 필드를 뺀 본문을 만든다.
fn checked_body(target: &ChangeObject, object: &Value) -> Result<Value, AppError> {
    let invalid = || AppError::other(INVALID_BINDING);
    if !is_that_binding(target, object) {
        return Err(invalid());
    }
    let role_kind = object.pointer("/roleRef/kind").and_then(Value::as_str).ok_or_else(invalid)?;
    let role_ok = object.pointer("/roleRef/apiGroup").and_then(Value::as_str) == Some(RBAC_GROUP)
        && object.pointer("/roleRef/name").and_then(Value::as_str).is_some_and(|name| !name.is_empty())
        && (role_kind == "ClusterRole" || (role_kind == "Role" && target.kind.namespaced));
    if !role_ok {
        return Err(invalid());
    }
    let namespace = object.pointer("/metadata/namespace").and_then(Value::as_str).filter(|ns| !ns.is_empty());
    if namespace != target.namespace.as_deref().filter(|_| target.kind.namespaced) && !(namespace.is_none() && target.kind.namespaced) {
        return Err(invalid());
    }
    for subject in subjects_of(object) {
        SubjectSpec::from_value(&subject).ok_or_else(invalid)?.validate()?;
    }
    let mut body = clean_object(object.clone());
    if let (Some(ns), true) = (&target.namespace, target.kind.namespaced) {
        body["metadata"]["namespace"] = json!(ns);
    }
    Ok(body)
}

fn version_of(current: &Value) -> Result<String, AppError> {
    current.pointer("/metadata/resourceVersion").and_then(Value::as_str).map(str::to_string).ok_or_else(|| AppError::other(MISSING_VERSION))
}

/// 시스템이 관리하는 기본 바인딩인가(`system:` 이름이거나 기본 부트스트랩 표시)
fn is_system(object: &Value) -> bool {
    let named = object.pointer("/metadata/name").and_then(Value::as_str).is_some_and(|name| name.starts_with("system:"));
    let bootstrap = object.pointer("/metadata/labels/kubernetes.io~1bootstrapping").and_then(Value::as_str) == Some("rbac-defaults");
    named || bootstrap
}

fn plan_of(calls: Vec<ApiCall>, diff: Vec<FieldDiff>, impact: String, warnings: Vec<String>, inverse: Option<Change>, current: Option<&Value>, version: Option<String>) -> Plan {
    Plan {
        preview: Preview {
            calls,
            diff,
            impact: vec![impact],
            warnings,
            confirm_name: None,
            reversible: inverse.is_some(),
            drain: None,
            conflicts: Vec::new(),
            effect: None,
        },
        inverse,
        version,
        fingerprint: current.map(fingerprint),
    }
}

fn create(change: &Change, object: &Value, current: Option<&Value>) -> Result<(Plan, Option<Value>), AppError> {
    let target = &change.target;
    if current.is_some() {
        return Err(AppError::other(BINDING_EXISTS));
    }
    let body = checked_body(target, object)?;
    let mut warnings = Vec::new();
    if subjects_of(&body).is_empty() {
        warnings.push(EMPTY_SUBJECTS_WARNING.to_string());
    }
    let inverse = Change { target: target.clone(), operation: Operation::Delete };
    // 이어지는 변경(주체 추가, 삭제)이 이 바인딩을 볼 수 있게, 만든 뒤의 객체에는 가짜 버전을 단다(요청 본문에는 넣지 않는다)
    let mut created = body.clone();
    created["metadata"]["resourceVersion"] = json!(SIMULATED_VERSION);
    let plan = plan_of(
        vec![ApiCall { verb: "POST".into(), path: path(target, true), body: body.clone() }],
        vec![FieldDiff { path: String::new(), before: Value::Null, after: body.clone() }],
        format!("{}: {CREATE_IMPACT}", label(target)),
        warnings,
        Some(inverse),
        None,
        None,
    );
    Ok((plan, Some(created)))
}

fn remove(change: &Change, current: Option<&Value>) -> Result<(Plan, Option<Value>), AppError> {
    let target = &change.target;
    let object = current.ok_or_else(|| AppError::other(BINDING_MISSING))?;
    let version = version_of(object)?;
    if !is_that_binding(target, object) {
        return Err(AppError::other(INVALID_CHANGE));
    }
    let mut warnings = Vec::new();
    // 소유자가 있는 객체는 원본을 다시 만들어도 옛 소유자 UID 때문에 정리될 수 있어 되돌리기를 만들지 않는다
    let owned = object.pointer("/metadata/ownerReferences").and_then(Value::as_array).is_some_and(|owners| !owners.is_empty());
    let inverse = if owned {
        warnings.push(OWNER_WARNING.to_string());
        None
    } else {
        // 지우는 바인딩의 원본 전체를 되돌리기에 남긴다
        Some(Change { target: target.clone(), operation: Operation::BindingCreate { object: clean_object(object.clone()) } })
    };
    if is_system(object) {
        warnings.push(SYSTEM_BINDING_WARNING.to_string());
    }
    let plan = plan_of(
        vec![ApiCall { verb: "DELETE".into(), path: path(target, false), body: json!({"preconditions": {"resourceVersion": version}}) }],
        vec![FieldDiff { path: String::new(), before: clean_object(object.clone()), after: Value::Null }],
        format!("{}: {DELETE_IMPACT}", label(target)),
        warnings,
        inverse,
        Some(object),
        Some(version),
    );
    Ok((plan, None))
}

fn edit_subjects(change: &Change, add: &[SubjectSpec], remove: &[SubjectSpec], current: Option<&Value>) -> Result<(Plan, Option<Value>), AppError> {
    let target = &change.target;
    let object = current.ok_or_else(|| AppError::other(BINDING_MISSING))?;
    let version = version_of(object)?;
    if !is_that_binding(target, object) {
        return Err(AppError::other(INVALID_CHANGE));
    }
    for subject in add.iter().chain(remove) {
        subject.validate()?;
    }
    let before = subjects_of(object);
    let before_keys: BTreeSet<_> = before.iter().filter_map(SubjectSpec::from_value).map(|s| s.key()).collect();
    let remove_keys: BTreeSet<_> = remove.iter().map(SubjectSpec::key).collect();
    // 알 수 없는 종류의 항목은 그대로 둔다
    let mut after: Vec<Value> = before.iter().filter(|v| SubjectSpec::from_value(v).is_none_or(|s| !remove_keys.contains(&s.key()))).cloned().collect();
    let mut after_keys: BTreeSet<_> = after.iter().filter_map(SubjectSpec::from_value).map(|s| s.key()).collect();
    for subject in add {
        if after_keys.insert(subject.key()) {
            after.push(subject.to_value());
        }
    }
    let mut diff = Vec::new();
    let mut removed = Vec::new();
    let mut added = Vec::new();
    for value in &before {
        let Some(spec) = SubjectSpec::from_value(value) else { continue };
        if !after_keys.contains(&spec.key()) {
            diff.push(FieldDiff { path: "subjects[-]".into(), before: value.clone(), after: Value::Null });
            removed.push(spec);
        }
    }
    for value in &after {
        let Some(spec) = SubjectSpec::from_value(value) else { continue };
        if !before_keys.contains(&spec.key()) {
            diff.push(FieldDiff { path: "subjects[+]".into(), before: Value::Null, after: value.clone() });
            added.push(spec);
        }
    }
    let mut warnings = Vec::new();
    if diff.is_empty() {
        warnings.push(NOOP_WARNING.to_string());
    } else if after.is_empty() {
        warnings.push(EMPTY_SUBJECTS_WARNING.to_string());
    }
    let inverse = (!diff.is_empty()).then(|| Change { target: target.clone(), operation: Operation::BindingSubjects { add: removed, remove: added } });
    let mut next = object.clone();
    next["subjects"] = Value::Array(after.clone());
    let plan = plan_of(
        vec![ApiCall { verb: "PATCH".into(), path: path(target, false), body: json!({"metadata": {"resourceVersion": version}, "subjects": after}) }],
        diff,
        format!("{}: {SUBJECTS_IMPACT}", label(target)),
        warnings,
        inverse,
        Some(object),
        Some(version),
    );
    Ok((plan, Some(next)))
}

/// 바인딩 변경 하나의 계획과, 적용한 뒤의 바인딩 객체(지웠으면 None). `current`는 지금 클러스터의 바인딩(없으면 None).
pub fn plan_binding(change: &Change, current: Option<&Value>) -> Result<(Plan, Option<Value>), AppError> {
    if !valid_target(&change.target) {
        return Err(AppError::other(INVALID_CHANGE));
    }
    match &change.operation {
        Operation::BindingCreate { object } => create(change, object, current),
        Operation::Delete => remove(change, current),
        Operation::BindingSubjects { add, remove } => edit_subjects(change, add, remove, current),
        _ => Err(AppError::other(INVALID_CHANGE)),
    }
}

#[cfg(test)]
mod tests;
