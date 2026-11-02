//! 워크로드 변경 요청과 역변경을 클러스터 I/O 없이 계산한다.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::drain::DrainPlan;
use super::rows::KindRef;
use super::shell::ShellMode;
use crate::error::AppError;

pub mod apply;

pub const APPLY_IMPACT: &str = "server-side apply로 객체를 바꿉니다";
pub const CREATE_IMPACT: &str = "새 객체를 만듭니다";
pub const SECRET_APPLY_WARNING: &str = "Secret 변경은 값을 기록하지 않아 되돌릴 수 없어요";
pub const FORCE_WARNING: &str = "다른 manager가 가진 필드를 강제로 가져옵니다";
pub const AWS_AUTH_WARNING: &str = "aws-auth는 access entry로 옮기세요. 잘못 고치면 노드나 사용자가 클러스터에 접근하지 못해요";
pub const NOOP_WARNING: &str = "바뀌는 것이 없어요";

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
pub const NODE_SHELL_IMPACT: &str = "그 노드에 디버그 Pod를 만들어 노드 셸을 엽니다. 셸을 닫으면 Pod를 지웁니다";
pub const NODE_SHELL_WARNING: &str = "노드의 루트 권한(privileged, 호스트 PID·네트워크·IPC, 노드 루트 파일 시스템)을 가진 Pod를 만들어요";
/// 노드 셸 Pod를 알아보는 표시. 앱이 지울 수 있는 Pod는 이 표시가 붙은 것뿐이다.
pub const NODE_SHELL_MANAGED_KEY: &str = "app.kubernetes.io/managed-by";
pub const NODE_SHELL_MANAGED_VALUE: &str = "magic-mirror";
pub const NODE_SHELL_LABEL: &str = "magic-mirror.io/node-shell";
pub const NODE_SHELL_NODE_ANNOTATION: &str = "magic-mirror.io/node";
pub const NODE_SHELL_CONTAINER: &str = "shell";
/// 노드 셸 Pod의 최대 수명(초)
pub const NODE_SHELL_MAX_SECS: u64 = 28_800;
/// 노드 셸로 들어갈 명령: 노드의 PID 1 네임스페이스로 들어가 노드의 sh를 연다
pub const NODE_SHELL_COMMAND: [&str; 9] = ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--"];

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
    /// 셸·attach 세션을 연 기록. 클러스터에 쓰지 않으니 미리보기·적용 대상이 아니다.
    Shell { container: String, mode: ShellMode },
    /// 노드 셸 디버그 Pod 만들기. 대상(`Change.target`)은 만들 Pod, `node`는 고정할 노드.
    NodeShell { node: String, image: String },
    /// YAML 객체 하나를 server-side apply한다. 없는 객체면 만들고, `force`면 다른 manager의 필드도 가져온다.
    Apply { object: Value, #[serde(default)] force: bool },
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
    /// server-side apply에서 다른 manager와 겹친 필드. 비어 있지 않으면 강제 적용 없이는 적용되지 않는다.
    #[serde(default)]
    pub conflicts: Vec<apply::FieldConflict>,
}

impl Preview {
    /// 화면으로 보내는 사본. Secret 본문의 값과 last-applied 어노테이션은 가린다.
    pub fn displayed(&self) -> Preview {
        let mut shown = self.clone();
        for call in &mut shown.calls {
            let secret = call.body.get("kind").and_then(Value::as_str) == Some("Secret") && call.body.get("apiVersion").and_then(Value::as_str) == Some("v1");
            if secret {
                crate::k8s::read::secret::mask(&mut call.body);
            }
        }
        shown
    }
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

/// 네임스페이스의 Pod 하나를 가리키는 변경 대상
pub fn pod_object(namespace: &str, name: &str) -> ChangeObject {
    ChangeObject {
        kind: KindRef { group: String::new(), version: "v1".into(), kind: "Pod".into(), plural: "pods".into(), namespaced: true },
        namespace: Some(namespace.to_string()),
        name: name.to_string(),
    }
}

/// 이름 입력이 필요한 위험한 대상: `kube-system` 네임스페이스, 이름에 `prod`가 들어간 네임스페이스나 객체.
/// 변경 미리보기와 셸·attach 열기가 같은 규칙을 쓴다.
pub fn dangerous(namespace: Option<&str>, name: &str) -> bool {
    namespace == Some("kube-system") || namespace.is_some_and(|ns| ns.to_ascii_lowercase().contains("prod")) || name.to_ascii_lowercase().contains("prod")
}

/// 위험한 대상이면 입력해야 하는 이름(대상 이름)
pub fn confirm_name(namespace: Option<&str>, name: &str) -> Option<String> {
    dangerous(namespace, name).then(|| name.to_string())
}

/// 노드 셸 Pod 이름: 소문자 DNS 라벨(63자 이내). 노드 이름과 이미지는 비어 있지 않고 공백·제어 문자가 없어야 한다.
fn valid_node_shell(pod: &str, node: &str, image: &str) -> bool {
    let label = !pod.is_empty()
        && pod.len() <= 63
        && pod.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !pod.starts_with('-')
        && !pod.ends_with('-');
    let plain = |s: &str| !s.is_empty() && !s.chars().any(|c| c.is_whitespace() || c.is_control());
    label && plain(node) && plain(image)
}

/// 그 노드에 고정한 디버그 Pod(`kubectl debug node`와 같은 방식): 호스트 PID·네트워크·IPC, privileged, 노드 루트를 `/host`에.
pub fn node_shell_pod(name: &str, namespace: &str, node: &str, image: &str) -> Value {
    json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": { NODE_SHELL_MANAGED_KEY: NODE_SHELL_MANAGED_VALUE, NODE_SHELL_LABEL: "true" },
            "annotations": { NODE_SHELL_NODE_ANNOTATION: node },
        },
        "spec": {
            "nodeName": node,
            "hostPID": true,
            "hostNetwork": true,
            "hostIPC": true,
            "restartPolicy": "Never",
            "terminationGracePeriodSeconds": 0,
            // 앱이 비정상으로 끝나 지우지 못해도 이 시간이 지나면 끝난다
            "activeDeadlineSeconds": NODE_SHELL_MAX_SECS,
            "tolerations": [{ "operator": "Exists" }],
            "containers": [{
                "name": NODE_SHELL_CONTAINER,
                "image": image,
                "command": ["sleep", NODE_SHELL_MAX_SECS.to_string()],
                "securityContext": { "privileged": true },
                "volumeMounts": [{ "name": "host-root", "mountPath": "/host" }],
            }],
            "volumes": [{ "name": "host-root", "hostPath": { "path": "/" } }],
        },
    })
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
    let creating = matches!(change.operation, Operation::Recreate { .. } | Operation::NodeShell { .. } | Operation::Apply { .. });
    let version = current.and_then(|v| v.pointer("/metadata/resourceVersion")).and_then(Value::as_str).map(str::to_owned);
    // 새로 만드는 변경은 현재 객체가 없어도 되지만, 있는 객체는 버전을 읽어야 한다
    if version.is_none() && (!creating || current.is_some()) {
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
    let dangerous = dangerous(target.namespace.as_deref(), &target.name)
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
        Operation::Apply { object, force } => {
            let body = apply::body(target, object, current, version.as_deref())?;
            if apply::is_secret(target) {
                warnings.push(SECRET_APPLY_WARNING.into());
            } else {
                undo = Some(inverse(
                    change,
                    match current {
                        Some(current) => Operation::Apply { object: clean_object(current.clone()), force: false },
                        None => Operation::Delete,
                    },
                ));
            }
            if *force {
                warnings.push(FORCE_WARNING.into());
            }
            if kind == "ConfigMap" && target.name == "aws-auth" && target.namespace.as_deref() == Some("kube-system") {
                warnings.push(AWS_AUTH_WARNING.into());
            }
            impact.push(format!("{kind} {}: {}", target.name, if current.is_some() { APPLY_IMPACT } else { CREATE_IMPACT }));
            ("PATCH", body, false)
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
        Operation::NodeShell { node, image } if group.is_empty() && kind == "Pod" => {
            if !valid_node_shell(&target.name, node, image) {
                return Err(AppError::other(INVALID_CHANGE));
            }
            warnings.push(NODE_SHELL_WARNING.into());
            impact.push(NODE_SHELL_IMPACT.into());
            ("POST", node_shell_pod(&target.name, target.namespace.as_deref().unwrap_or_default(), node, image), true)
        }
        _ => return Err(AppError::other(INVALID_CHANGE)),
    };
    let mut call_path = if matches!(change.operation, Operation::Rerun { .. }) {
        let mut job_target = target.clone();
        job_target.kind.plural = "jobs".into();
        path(&job_target, true)
    } else {
        path(target, collection)
    };
    let forced = matches!(change.operation, Operation::Apply { force: true, .. });
    if matches!(change.operation, Operation::Apply { .. }) {
        call_path.push_str(&format!("?fieldManager={}{}", apply::FIELD_MANAGER, if forced { "&force=true" } else { "" }));
    }
    // 노드 셸은 늘 노드 이름을 입력해야 한다(Pod 이름이 아니라 루트 권한을 얻는 노드). 강제 적용은 다른 manager의 필드를 가져오므로 위험한 변경처럼 이름을 입력받는다
    let confirm_name = match &change.operation {
        Operation::NodeShell { node, .. } => Some(node.clone()),
        _ => (dangerous || forced).then(|| target.name.clone()),
    };
    Ok(Plan {
        preview: Preview {
            calls: vec![ApiCall { verb: verb.into(), path: call_path, body }],
            diff,
            impact,
            warnings,
            confirm_name,
            reversible: undo.is_some(),
            drain: None,
            conflicts: Vec::new(),
        },
        inverse: undo,
        version,
        fingerprint: current.map(fingerprint),
    })
}

#[cfg(test)]
mod tests;
