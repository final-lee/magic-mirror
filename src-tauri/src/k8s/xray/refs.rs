//! 객체 하나의 본문에서 다른 객체를 가리키는 곳을 읽어 낸다: 이름 참조, 레이블 선택자, 대상 지정.
use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::pool::{self, Item, Key, Spec};
use crate::k8s::read::detail::split_api_version;
use crate::k8s::read::values::{list, text};
use crate::k8s::rows::KindRef;

/// 이름으로 가리킨 객체
#[derive(Debug, Clone, PartialEq)]
pub struct Ref {
    pub kind: KindRef,
    pub namespace: Option<String>,
    pub name: String,
    pub roles: Vec<String>,
}

impl Ref {
    pub fn key(&self) -> Key {
        Key::new(&self.kind.group, &self.kind.kind, self.namespace.as_deref(), &self.name)
    }
}

fn is(item: &Item, spec: &Spec) -> bool {
    item.kind.group == spec.group && item.kind.kind == spec.kind
}

/// Pod 사양(`spec`)이 있는 객체: Pod와 Pod 템플릿을 가진 워크로드
pub fn pod_spec(item: &Item) -> Option<&Value> {
    let path = if is(item, &pool::POD) {
        "/spec"
    } else if is(item, &pool::CRON_JOB) {
        "/spec/jobTemplate/spec/template/spec"
    } else if [&pool::DEPLOYMENT, &pool::REPLICA_SET, &pool::STATEFUL_SET, &pool::DAEMON_SET, &pool::JOB].iter().any(|s| is(item, s)) {
        "/spec/template/spec"
    } else {
        return None;
    };
    item.data.pointer(path)
}

/// 이 객체가 띄우는 Pod의 레이블: Pod는 자기 레이블, 워크로드는 Pod 템플릿의 레이블. Pod를 띄우지 않는 객체는 None.
pub fn pod_labels(item: &Item) -> Option<BTreeMap<String, String>> {
    if is(item, &pool::POD) {
        return Some(item.labels.clone());
    }
    pod_spec(item)?;
    let path = if is(item, &pool::CRON_JOB) { "/spec/jobTemplate/spec/template/metadata/labels" } else { "/spec/template/metadata/labels" };
    let labels = item.data.pointer(path).and_then(Value::as_object);
    Some(labels.map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect()).unwrap_or_default())
}

/// 라벨 선택기(`matchLabels`, `matchExpressions`)가 라벨 집합과 맞는가. 선택기가 객체가 아니면 아무것도 고르지 않고, 빈 선택기는 모두 고른다.
pub fn selects(selector: &Value, labels: &BTreeMap<String, String>) -> bool {
    if !selector.is_object() {
        return false;
    }
    if let Some(wanted) = selector.get("matchLabels").and_then(Value::as_object) {
        if wanted.iter().any(|(key, value)| value.as_str().is_none_or(|v| labels.get(key).map(String::as_str) != Some(v))) {
            return false;
        }
    }
    list(selector, "/matchExpressions").iter().all(|e| {
        let key = text(e, "/key").unwrap_or("");
        let values: Vec<&str> = list(e, "/values").iter().filter_map(Value::as_str).collect();
        let have = labels.get(key).map(String::as_str);
        match text(e, "/operator").unwrap_or("") {
            "In" => have.is_some_and(|v| values.contains(&v)),
            "NotIn" => have.is_none_or(|v| !values.contains(&v)),
            "Exists" => have.is_some(),
            "DoesNotExist" => have.is_none(),
            // 알 수 없는 연산자는 API 서버가 만들 때 거절한다. 여기서는 맞지 않는 것으로 본다.
            _ => false,
        }
    })
}

/// Pod를 고르는 선택자: Service는 `spec.selector`(라벨 맵, 비면 아무것도 고르지 않는다), PodDisruptionBudget은 `spec.selector`, NetworkPolicy는 `spec.podSelector`.
pub fn pod_selector(item: &Item) -> Option<Value> {
    if is(item, &pool::SERVICE) {
        let map = item.data.pointer("/spec/selector").and_then(Value::as_object).filter(|m| !m.is_empty())?;
        return Some(json!({ "matchLabels": map }));
    }
    if is(item, &pool::PDB) {
        return item.data.pointer("/spec/selector").cloned();
    }
    if is(item, &pool::NETWORK_POLICY) {
        return item.data.pointer("/spec/podSelector").cloned();
    }
    None
}

/// HPA의 `scaleTargetRef`: (그룹, 종류, 이름)
pub fn scale_target(item: &Item) -> Option<(String, String, String)> {
    if !is(item, &pool::HPA) {
        return None;
    }
    let (group, _) = split_api_version(text(&item.data, "/spec/scaleTargetRef/apiVersion")?);
    Some((group, text(&item.data, "/spec/scaleTargetRef/kind")?.to_string(), text(&item.data, "/spec/scaleTargetRef/name")?.to_string()))
}

/// Ingress가 보내는 Service 이름(기본 백엔드와 규칙의 백엔드)
pub fn ingress_services(item: &Item) -> Vec<String> {
    if !is(item, &pool::INGRESS) {
        return vec![];
    }
    let mut out: Vec<String> = text(&item.data, "/spec/defaultBackend/service/name").map(str::to_string).into_iter().collect();
    for rule in list(&item.data, "/spec/rules") {
        out.extend(list(rule, "/http/paths").iter().filter_map(|p| text(p, "/backend/service/name")).map(str::to_string));
    }
    out.sort();
    out.dedup();
    out
}

/// EndpointSlice가 속한 Service(`kubernetes.io/service-name` 레이블)
pub fn slice_service(item: &Item) -> Option<&str> {
    if !is(item, &pool::ENDPOINT_SLICE) {
        return None;
    }
    item.labels.get("kubernetes.io/service-name").map(String::as_str)
}

/// EndpointSlice의 끝점이 가리키는 Pod 이름
pub fn slice_pods(item: &Item) -> Vec<String> {
    if !is(item, &pool::ENDPOINT_SLICE) {
        return vec![];
    }
    let mut out: Vec<String> = list(&item.data, "/endpoints").iter().filter(|e| text(e, "/targetRef/kind") == Some("Pod")).filter_map(|e| text(e, "/targetRef/name")).map(str::to_string).collect();
    out.sort();
    out.dedup();
    out
}

fn push(out: &mut Vec<Ref>, spec: &Spec, namespace: Option<&str>, name: &str, role: &str) {
    if name.is_empty() {
        return;
    }
    let namespace = if spec.namespaced { namespace.map(str::to_string) } else { None };
    if let Some(found) = out.iter_mut().find(|r| r.kind.group == spec.group && r.kind.kind == spec.kind && r.namespace == namespace && r.name == name) {
        if !found.roles.iter().any(|r| r == role) {
            found.roles.push(role.to_string());
        }
        return;
    }
    out.push(Ref { kind: spec.kind_ref(), namespace, name: name.to_string(), roles: vec![role.to_string()] });
}

/// 볼륨 한 개가 가리키는 ConfigMap·Secret·PVC
fn volume_refs(volume: &Value, ns: Option<&str>, out: &mut Vec<Ref>) {
    if let Some(n) = text(volume, "/configMap/name") {
        push(out, &pool::CONFIG_MAP, ns, n, "volume");
    }
    if let Some(n) = text(volume, "/secret/secretName") {
        push(out, &pool::SECRET, ns, n, "volume");
    }
    if let Some(n) = text(volume, "/persistentVolumeClaim/claimName") {
        push(out, &pool::PVC, ns, n, "volume");
    }
    for source in list(volume, "/projected/sources") {
        if let Some(n) = text(source, "/configMap/name") {
            push(out, &pool::CONFIG_MAP, ns, n, "volume");
        }
        if let Some(n) = text(source, "/secret/name") {
            push(out, &pool::SECRET, ns, n, "volume");
        }
    }
}

/// 컨테이너 하나의 환경 변수가 가리키는 ConfigMap·Secret
fn env_refs(container: &Value, ns: Option<&str>, out: &mut Vec<Ref>) {
    for env in list(container, "/env") {
        if let Some(n) = text(env, "/valueFrom/configMapKeyRef/name") {
            push(out, &pool::CONFIG_MAP, ns, n, "env");
        }
        if let Some(n) = text(env, "/valueFrom/secretKeyRef/name") {
            push(out, &pool::SECRET, ns, n, "env");
        }
    }
    for from in list(container, "/envFrom") {
        if let Some(n) = text(from, "/configMapRef/name") {
            push(out, &pool::CONFIG_MAP, ns, n, "env");
        }
        if let Some(n) = text(from, "/secretRef/name") {
            push(out, &pool::SECRET, ns, n, "env");
        }
    }
}

/// 객체가 이름으로 가리키는 것. Pod·워크로드는 템플릿의 ServiceAccount·볼륨·환경 변수·imagePullSecrets·PriorityClass(Pod는 노드도),
/// PVC는 PV와 StorageClass, PV는 StorageClass, Ingress는 TLS Secret.
pub fn refs_of(item: &Item) -> Vec<Ref> {
    let ns = item.namespace.as_deref();
    let mut out = Vec::new();
    if let Some(spec) = pod_spec(item) {
        push(&mut out, &pool::SERVICE_ACCOUNT, ns, text(spec, "/serviceAccountName").or_else(|| text(spec, "/serviceAccount")).unwrap_or("default"), "serviceAccount");
        for volume in list(spec, "/volumes") {
            volume_refs(volume, ns, &mut out);
        }
        for field in ["/containers", "/initContainers", "/ephemeralContainers"] {
            for container in list(spec, field) {
                env_refs(container, ns, &mut out);
            }
        }
        for secret in list(spec, "/imagePullSecrets") {
            push(&mut out, &pool::SECRET, ns, text(secret, "/name").unwrap_or(""), "imagePull");
        }
        push(&mut out, &pool::PRIORITY_CLASS, None, text(spec, "/priorityClassName").unwrap_or(""), "priority");
        if is(item, &pool::POD) {
            push(&mut out, &pool::NODE, None, text(spec, "/nodeName").unwrap_or(""), "node");
        }
    }
    if is(item, &pool::PVC) {
        push(&mut out, &pool::PV, None, text(&item.data, "/spec/volumeName").unwrap_or(""), "volume");
        push(&mut out, &pool::STORAGE_CLASS, None, text(&item.data, "/spec/storageClassName").unwrap_or(""), "storageClass");
    }
    if is(item, &pool::PV) {
        push(&mut out, &pool::STORAGE_CLASS, None, text(&item.data, "/spec/storageClassName").unwrap_or(""), "storageClass");
    }
    if is(item, &pool::INGRESS) {
        for tls in list(&item.data, "/spec/tls") {
            push(&mut out, &pool::SECRET, ns, text(tls, "/secretName").unwrap_or(""), "tls");
        }
    }
    out
}
