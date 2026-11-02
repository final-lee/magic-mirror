//! YAML 적용(server-side apply)의 요청 본문, 서버 결과와 현재 객체의 차이, 필드 충돌을 클러스터 I/O 없이 계산한다.
use std::collections::BTreeSet;

use kube::core::Status;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{clean_object, Change, ChangeObject, FieldDiff, Operation, INVALID_CHANGE};
use crate::error::AppError;
use crate::k8s::read::secret::{LAST_APPLIED, MASK};

/// server-side apply가 남기는 field manager 이름.
pub const FIELD_MANAGER: &str = "magic-mirror";
/// 서버가 필드 충돌에 붙이는 원인 종류.
const CONFLICT_CAUSE: &str = "FieldManagerConflict";
/// Secret의 값이 바뀐 것을 값 없이 보여 주는 표시.
pub const MASK_CHANGED: &str = "•••• (바뀜)";
pub const MASKED_VALUE_UNKNOWN: &str = "가려진 값을 이 Secret에서 찾지 못했어요. 값을 보고 새 값으로 입력해 주세요";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldConflict {
    pub field: String,
    pub manager: String,
}

pub fn is_secret(target: &ChangeObject) -> bool {
    target.kind.group.is_empty() && target.kind.kind == "Secret"
}

/// 서버 오류의 원인 목록에서 필드 충돌만 꺼낸다. 충돌이 아니면 빈 목록이다.
pub fn conflicts_of(status: &Status) -> Vec<FieldConflict> {
    let Some(details) = &status.details else { return Vec::new() };
    details
        .causes
        .iter()
        .filter(|cause| cause.reason == CONFLICT_CAUSE)
        .map(|cause| FieldConflict { field: cause.field.clone(), manager: manager_of(&cause.message) })
        .collect()
}

/// `conflict with "kubectl" using apps/v1` 꼴의 메시지에서 따옴표 안의 manager 이름.
fn manager_of(message: &str) -> String {
    let mut parts = message.splitn(3, '"');
    match (parts.next(), parts.next()) {
        (Some(_), Some(name)) if !name.is_empty() => name.to_string(),
        _ => message.to_string(),
    }
}

/// 적용할 본문. 서버가 채우는 필드는 빼고, 이름·네임스페이스를 대상과 맞추며 버전 조건을 건다.
/// Secret의 가린 값은 현재 객체의 값으로 되돌려 놓는다(값을 화면으로 보내지 않고도 그대로 둘 수 있다).
pub fn body(target: &ChangeObject, object: &Value, current: Option<&Value>, version: Option<&str>) -> Result<Value, AppError> {
    let kind = &target.kind;
    let expected_version = if kind.group.is_empty() {
        kind.version.clone()
    } else {
        format!("{}/{}", kind.group, kind.version)
    };
    let mut body = clean_object(object.clone());
    let matches_target = body.get("kind").and_then(Value::as_str) == Some(kind.kind.as_str())
        && body.get("apiVersion").and_then(Value::as_str) == Some(expected_version.as_str())
        && body.pointer("/metadata/name").and_then(Value::as_str) == Some(target.name.as_str());
    let meta = body.get_mut("metadata").and_then(Value::as_object_mut).filter(|_| matches_target).ok_or_else(|| AppError::other(INVALID_CHANGE))?;
    let given = meta.get("namespace").and_then(Value::as_str).map(str::to_owned);
    match (kind.namespaced, given.as_deref(), target.namespace.as_deref()) {
        (true, None, Some(namespace)) => {
            meta.insert("namespace".into(), json!(namespace));
        }
        (true, Some(given), Some(namespace)) if given == namespace => {}
        (false, None, None) => {}
        _ => return Err(AppError::other(INVALID_CHANGE)),
    }
    if let (Some(_), Some(version)) = (current, version) {
        meta.insert("resourceVersion".into(), json!(version));
    }
    if is_secret(target) {
        resolve_masks(&mut body, current.unwrap_or(&Value::Null))?;
    }
    Ok(body)
}

/// Secret 본문의 `••••`를 현재 값으로 바꾼다. 찾지 못하거나 `stringData`에 남아 있으면 거절한다.
fn resolve_masks(body: &mut Value, current: &Value) -> Result<(), AppError> {
    if let Some(data) = body.get_mut("data").and_then(Value::as_object_mut) {
        for (key, value) in data.iter_mut().filter(|(_, v)| v.as_str() == Some(MASK)) {
            *value = current.pointer(&format!("/data/{}", escape(key))).cloned().ok_or_else(|| AppError::other(MASKED_VALUE_UNKNOWN))?;
        }
    }
    if let Some(string_data) = body.get("stringData").and_then(Value::as_object) {
        if string_data.values().any(|v| v.as_str() == Some(MASK)) {
            return Err(AppError::other(MASKED_VALUE_UNKNOWN));
        }
    }
    let annotation = format!("/metadata/annotations/{}", escape(LAST_APPLIED));
    if body.pointer(&annotation).and_then(Value::as_str) == Some(MASK) {
        match current.pointer(&annotation).cloned() {
            Some(value) => *body.pointer_mut(&annotation).expect("방금 읽은 자리예요") = value,
            None => {
                if let Some(map) = body.pointer_mut("/metadata/annotations").and_then(Value::as_object_mut) {
                    map.remove(LAST_APPLIED);
                }
            }
        }
    }
    Ok(())
}

/// JSON Pointer의 `~`, `/` 이스케이프.
fn escape(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for c in key.chars() {
        match c {
            '~' => out.push_str("~0"),
            '/' => out.push_str("~1"),
            c => out.push(c),
        }
    }
    out
}

/// 서버 dry-run 결과와 현재 객체를 정리해 필드마다 비교한다. Secret은 값 없이 바뀐 키만 보여 준다.
/// 현재 객체가 없으면(새로 만듦) 결과 전체를 하나의 항목으로 돌려준다.
pub fn diff(target: &ChangeObject, current: Option<&Value>, result: &Value) -> Vec<FieldDiff> {
    let secret = is_secret(target);
    let mut after = clean_object(result.clone());
    let Some(current) = current else {
        if secret {
            crate::k8s::read::secret::mask(&mut after);
        }
        return vec![FieldDiff { path: String::new(), before: Value::Null, after }];
    };
    let mut before = clean_object(current.clone());
    if secret {
        mask_pair(&mut before, &mut after);
    }
    let mut out = Vec::new();
    walk(&mut String::new(), &before, &after, &mut out);
    out
}

/// 같은 값은 둘 다 `••••`, 다른 값은 앞은 `••••`, 뒤는 `•••• (바뀜)`으로 바꿔 값을 숨긴 채 바뀐 키만 남긴다.
fn mask_pair(before: &mut Value, after: &mut Value) {
    for field in ["data", "stringData"] {
        let keys: BTreeSet<String> = [&*before, &*after].iter().filter_map(|v| v.get(field).and_then(Value::as_object)).flat_map(|m| m.keys().cloned()).collect();
        for key in keys {
            mask_entry(before.pointer_mut(&format!("/{field}/{}", escape(&key))), after.pointer_mut(&format!("/{field}/{}", escape(&key))));
        }
    }
    let annotation = format!("/metadata/annotations/{}", escape(LAST_APPLIED));
    mask_entry(before.pointer_mut(&annotation), after.pointer_mut(&annotation));
}

fn mask_entry(before: Option<&mut Value>, after: Option<&mut Value>) {
    let changed = match (&before, &after) {
        (Some(b), Some(a)) => b != a,
        _ => false,
    };
    if let Some(before) = before {
        *before = json!(MASK);
    }
    if let Some(after) = after {
        *after = json!(if changed { MASK_CHANGED } else { MASK });
    }
}

/// 필드 경로는 `spec.template.spec.containers[0].image` 꼴. 길이가 다른 배열은 통째로 비교한다.
fn walk(path: &mut String, before: &Value, after: &Value, out: &mut Vec<FieldDiff>) {
    if before == after {
        return;
    }
    let mark = path.len();
    match (before, after) {
        (Value::Object(b), Value::Object(a)) => {
            let keys: BTreeSet<&String> = b.keys().chain(a.keys()).collect();
            for key in keys {
                if !path.is_empty() {
                    path.push('.');
                }
                path.push_str(key);
                walk(path, b.get(key).unwrap_or(&Value::Null), a.get(key).unwrap_or(&Value::Null), out);
                path.truncate(mark);
            }
        }
        (Value::Array(b), Value::Array(a)) if b.len() == a.len() => {
            for (index, (b, a)) in b.iter().zip(a).enumerate() {
                path.push_str(&format!("[{index}]"));
                walk(path, b, a, out);
                path.truncate(mark);
            }
        }
        _ => out.push(FieldDiff { path: path.clone(), before: before.clone(), after: after.clone() }),
    }
}

/// 기록에 남길 변경. Secret이면 `data`·`stringData`의 값을 모두 가린다.
pub fn redact(change: &Change) -> Change {
    let mut change = change.clone();
    if let (true, Operation::Apply { object, .. }) = (is_secret(&change.target), &mut change.operation) {
        crate::k8s::read::secret::mask(object);
    }
    change
}

#[cfg(test)]
mod tests;
