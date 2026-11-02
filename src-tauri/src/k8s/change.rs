//! 워크로드 변경 요청과 역변경을 클러스터 I/O 없이 계산한다.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::drain::DrainPlan;
use super::rows::KindRef;
use crate::error::AppError;

pub const INVALID_CHANGE: &str = "이 리소스에는 이 변경을 적용할 수 없어요";
pub const MISSING_VERSION: &str = "리소스 버전을 읽지 못했어요. 다시 미리보기 해 주세요";
pub const OWNER_WARNING: &str = "소유자가 이 객체를 다시 만들 수 있어요";
pub const UNOWNED_POD_WARNING: &str = "컨트롤러가 없는 Pod는 다시 만들어지지 않아요";
pub const RESTART_WARNING: &str = "재시작은 직접 되돌릴 수 없어요. 롤아웃 되돌리기를 이용해 주세요";
pub const SCALE_IMPACT: &str = "원하는 Pod 수를 바꿉니다";
pub const RESTART_IMPACT: &str = "새 Pod로 순차 교체합니다";
pub const UNDO_IMPACT: &str = "선택한 리비전의 Pod 템플릿으로 교체합니다";
pub const DELETE_IMPACT: &str = "객체를 삭제합니다";
pub const RECREATE_IMPACT: &str = "삭제한 객체를 다시 만듭니다";
pub const SUSPEND_IMPACT: &str = "CronJob 예약 실행 상태를 바꿉니다";
pub const RERUN_IMPACT: &str = "새 Job을 만듭니다";
pub const CORDON_IMPACT: &str = "노드의 새 Pod 스케줄을 바꿉니다";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeObject {
    pub kind: KindRef,
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Operation {
    Scale { replicas: i32 },
    Restart,
    #[serde(rename = "rolloutUndo")]
    RolloutUndo { revision: String },
    Delete,
    Rerun { #[serde(rename = "jobName")] job_name: String },
    Suspend { suspend: bool },
    Recreate { object: Value },
    Cordon { unschedulable: bool },
    /// 노드를 스케줄 중지하고 Pod를 하나씩 옮긴다. 적용은 스트림(`k8s_drain`)으로 한다.
    Drain,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    #[serde(flatten)]
    pub target: ChangeObject,
    #[serde(flatten)]
    pub operation: Operation,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiCall {
    pub verb: String,
    pub path: String,
    pub body: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDiff {
    pub path: String,
    pub before: Value,
    pub after: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub calls: Vec<ApiCall>,
    pub diff: Vec<FieldDiff>,
    pub impact: Vec<String>,
    pub warnings: Vec<String>,
    pub confirm_name: Option<String>,
    pub reversible: bool,
    /// drain 미리보기에서만 채운다: 옮길 Pod, 건너뛸 Pod와 경고 대상
    pub drain: Option<DrainPlan>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub preview: Preview,
    pub inverse: Option<Change>,
    pub version: Option<String>,
    /// 상태만 바뀌었는지 비교한다. Secret 본문은 보관하지 않는다.
    pub fingerprint: Option<[u8; 32]>,
}

/// 상태와 서버 관리 필드를 제외한 객체 전체의 해시.
pub fn fingerprint(object: &Value) -> [u8; 32] {
    let mut value = object.clone();
    if let Some(root) = value.as_object_mut() {
        root.remove("status");
        if let Some(meta) = root.get_mut("metadata").and_then(Value::as_object_mut) {
            meta.remove("resourceVersion");
            meta.remove("managedFields");
        }
    }
    let bytes = serde_json::to_vec(&value).expect("JSON 값은 직렬화할 수 있어요");
    Sha256::digest(bytes).into()
}

/// 같은 객체에서 상태만 갱신된 경우에는 새 리소스 버전으로 같은 계획을 보낼 수 있다.
pub fn same_except_version(seen: &Plan, current: &Plan) -> bool {
    if seen == current {
        return true;
    }
    if seen.fingerprint.is_none() || seen.fingerprint != current.fingerprint {
        return false;
    }
    let mut normalized = current.clone();
    normalized.version = seen.version.clone();
    for (new, old) in normalized.preview.calls.iter_mut().zip(&seen.preview.calls) {
        for pointer in ["/metadata/resourceVersion", "/preconditions/resourceVersion"] {
            if let (Some(new), Some(old)) = (new.body.pointer_mut(pointer), old.body.pointer(pointer)) {
                *new = old.clone();
            }
        }
    }
    *seen == normalized
}

/// 생성할 때 서버가 채우는 메타데이터와 상태를 제거한다.
pub fn clean_object(mut object: Value) -> Value {
    if let Some(root) = object.as_object_mut() {
        root.remove("status");
        if let Some(meta) = root.get_mut("metadata").and_then(Value::as_object_mut) {
            for key in ["uid", "resourceVersion", "creationTimestamp", "generation", "managedFields", "deletionTimestamp", "deletionGracePeriodSeconds", "selfLink"] {
                meta.remove(key);
            }
        }
    }
    object
}

fn path(target: &ChangeObject, collection: bool) -> String {
    let kind = &target.kind;
    let prefix = if kind.group.is_empty() {
        format!("/api/{}", kind.version)
    } else {
        format!("/apis/{}/{}", kind.group, kind.version)
    };
    let namespace = target.namespace.as_ref().filter(|_| kind.namespaced).map(|ns| format!("/namespaces/{ns}")).unwrap_or_default();
    let name = if collection {
        String::new()
    } else {
        format!("/{}", target.name)
    };
    format!("{prefix}{namespace}/{}{name}", kind.plural)
}

fn inverse(change: &Change, operation: Operation) -> Change {
    Change { target: change.target.clone(), operation }
}

/// API 경로·본문, 필드 차이와 위험 확인을 같은 입력에서 만든다.
pub fn plan(change: &Change, current: Option<&Value>, revision: Option<&Value>, now: &str) -> Result<Plan, AppError> {
    let target = &change.target;
    let kind = target.kind.kind.as_str();
    let group = target.kind.group.as_str();
    let expected_version = if group.is_empty() {
        target.kind.version.clone()
    } else {
        format!("{group}/{}", target.kind.version)
    };
    if target.name.is_empty() || target.kind.namespaced != target.namespace.as_ref().is_some_and(|s| !s.is_empty()) {
        return Err(AppError::other(INVALID_CHANGE));
    }
    let recreate = matches!(change.operation, Operation::Recreate { .. });
    let version = current.and_then(|v| v.pointer("/metadata/resourceVersion")).and_then(Value::as_str).map(str::to_owned);
    if !recreate && version.is_none() {
        return Err(AppError::other(MISSING_VERSION));
    }
    let obj = current.unwrap_or(&Value::Null);
    if matches!(change.operation, Operation::Delete) {
        let actual_kind = obj.get("kind").and_then(Value::as_str);
        let actual_version = obj.get("apiVersion").and_then(Value::as_str);
        if actual_kind != Some(kind) || actual_version != Some(expected_version.as_str()) {
            return Err(AppError::other(INVALID_CHANGE));
        }
    }
    let owned = obj.pointer("/metadata/ownerReferences").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
    let dangerous = target.namespace.as_deref() == Some("kube-system") || target.name.to_ascii_lowercase().contains("prod")
        || (matches!(change.operation, Operation::Delete) && (owned || matches!(kind, "Namespace" | "Node" | "CustomResourceDefinition" | "PersistentVolume")));
    let mut warnings = Vec::new();
    let mut diff = Vec::new();
    let mut impact = Vec::new();
    let mut undo = None;
    let (verb, body, collection) = match &change.operation {
        Operation::Scale { replicas } if group == "apps" && matches!(kind, "Deployment" | "StatefulSet") && *replicas >= 0 => {
            let before = obj.pointer("/spec/replicas").cloned().unwrap_or(json!(1));
            let old = before.as_i64().and_then(|n| i32::try_from(n).ok()).ok_or_else(|| AppError::other(INVALID_CHANGE))?;
            undo = Some(inverse(change, Operation::Scale { replicas: old }));
            diff.push(FieldDiff { path: "spec.replicas".into(), before, after: json!(replicas) });
            impact.push(SCALE_IMPACT.into());
            ("PATCH", json!({"metadata":{"resourceVersion":version},"spec":{"replicas":replicas}}), false)
        }
        Operation::Cordon { unschedulable } if group.is_empty() && kind == "Node" => {
            let before = obj.pointer("/spec/unschedulable").and_then(Value::as_bool).unwrap_or(false);
            undo = Some(inverse(change, Operation::Cordon { unschedulable: before }));
            diff.push(FieldDiff { path: "spec.unschedulable".into(), before: json!(before), after: json!(unschedulable) });
            impact.push(CORDON_IMPACT.into());
            ("PATCH", json!({"metadata":{"resourceVersion":version},"spec":{"unschedulable":unschedulable}}), false)
        }
        Operation::Restart if group == "apps" && matches!(kind, "Deployment" | "StatefulSet" | "DaemonSet") => {
            let before = obj.pointer("/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt").cloned().unwrap_or(Value::Null);
            diff.push(FieldDiff { path: "spec.template.metadata.annotations.kubectl.kubernetes.io/restartedAt".into(), before, after: json!(now) });
            warnings.push(RESTART_WARNING.into());
            impact.push(RESTART_IMPACT.into());
            ("PATCH", json!({"metadata":{"resourceVersion":version},"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":now}}}}}), false)
        }
        Operation::RolloutUndo { .. } if group == "apps" && matches!(kind, "Deployment" | "StatefulSet" | "DaemonSet") => {
            let template = revision.ok_or_else(|| AppError::other(INVALID_CHANGE))?;
            let before = obj.pointer("/spec/template").cloned().unwrap_or(Value::Null);
            diff.push(FieldDiff { path: "spec.template".into(), before: before.clone(), after: template.clone() });
            impact.push(UNDO_IMPACT.into());
            let mut replacement = template.clone();
            replacement.as_object_mut().ok_or_else(|| AppError::other(INVALID_CHANGE))?.insert("$patch".into(), json!("replace"));
            ("PATCH", json!({"metadata":{"resourceVersion":version},"spec":{"template":replacement}}), false)
        }
        Operation::Delete => {
            if owned {
                warnings.push(OWNER_WARNING.into());
            } else if kind == "Pod" {
                warnings.push(UNOWNED_POD_WARNING.into());
            }
            if !owned && kind != "Pod" && !(group.is_empty() && kind == "Secret") {
                undo = Some(inverse(change, Operation::Recreate { object: clean_object(obj.clone()) }));
            }
            impact.push(DELETE_IMPACT.into());
            ("DELETE", json!({"preconditions":{"resourceVersion":version}}), false)
        }
        Operation::Recreate { object } if !(group.is_empty() && kind == "Secret") => {
            if object.get("kind").and_then(Value::as_str) != Some(kind)
                || object.get("apiVersion").and_then(Value::as_str) != Some(expected_version.as_str())
                || object.pointer("/metadata/name").and_then(Value::as_str) != Some(target.name.as_str()) {
                return Err(AppError::other(INVALID_CHANGE));
            }
            undo = Some(inverse(change, Operation::Delete));
            impact.push(RECREATE_IMPACT.into());
            ("POST", clean_object(object.clone()), true)
        }
        Operation::Suspend { suspend } if group == "batch" && kind == "CronJob" => {
            let before = obj.pointer("/spec/suspend").cloned().unwrap_or(json!(false));
            undo = Some(inverse(change, Operation::Suspend { suspend: before.as_bool().unwrap_or(false) }));
            diff.push(FieldDiff { path: "spec.suspend".into(), before, after: json!(suspend) });
            impact.push(SUSPEND_IMPACT.into());
            ("PATCH", json!({"metadata":{"resourceVersion":version},"spec":{"suspend":suspend}}), false)
        }
        Operation::Rerun { job_name } if group == "batch" && matches!(kind, "Job" | "CronJob") && !job_name.is_empty() => {
            let spec = if kind == "Job" {
                obj.pointer("/spec")
            } else {
                obj.pointer("/spec/jobTemplate/spec")
            }.cloned().ok_or_else(|| AppError::other(INVALID_CHANGE))?;
            let mut spec = spec;
            if let Some(map) = spec.as_object_mut() {
                map.remove("selector");
                map.remove("manualSelector");
            }
            if let Some(labels) = spec.pointer_mut("/template/metadata/labels").and_then(Value::as_object_mut) {
                for key in ["controller-uid", "job-name", "batch.kubernetes.io/controller-uid", "batch.kubernetes.io/job-name"] {
                    labels.remove(key);
                }
            }
            let source_meta = if kind == "Job" {
                obj.pointer("/metadata")
            } else {
                obj.pointer("/spec/jobTemplate/metadata")
            };
            let mut metadata = serde_json::Map::new();
            metadata.insert("name".into(), json!(job_name));
            metadata.insert("namespace".into(), json!(target.namespace));
            for key in ["labels", "annotations"] {
                if let Some(value) = source_meta.and_then(|meta| meta.get(key)) {
                    metadata.insert(key.into(), value.clone());
                }
            }
            let mut job_target = target.clone();
            job_target.kind.kind = "Job".into();
            job_target.kind.plural = "jobs".into();
            job_target.name = job_name.clone();
            undo = Some(Change { target: job_target, operation: Operation::Delete });
            impact.push(RERUN_IMPACT.into());
            ("POST", json!({"apiVersion":"batch/v1","kind":"Job","metadata":metadata,"spec":spec}), true)
        }
        _ => return Err(AppError::other(INVALID_CHANGE)),
    };
    let call_path = if matches!(change.operation, Operation::Rerun { .. }) {
        let mut job_target = target.clone();
        job_target.kind.plural = "jobs".into();
        path(&job_target, true)
    } else {
        path(target, collection)
    };
    Ok(Plan {
        preview: Preview { calls: vec![ApiCall { verb: verb.into(), path: call_path, body }], diff, impact, warnings, confirm_name: dangerous.then(|| target.name.clone()), reversible: undo.is_some(), drain: None },
        inverse: undo,
        version,
        fingerprint: current.map(fingerprint),
    })
}

#[cfg(test)]
mod tests;
