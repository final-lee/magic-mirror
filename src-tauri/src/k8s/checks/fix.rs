//! 안전하게 자동으로 고칠 수 있는 항목의 변경. 바꾸는 필드만 담은 부분 객체를 만든다(server-side apply로 합쳐진다).
//! 고치는 것은 둘뿐이다: ① 기본 ServiceAccount의 토큰 자동 마운트 끄기 ② 컨테이너의 `allowPrivilegeEscalation: false` 더하기.
//! 값을 사람이 정해야 하는 것(request·limit, 이미지 태그, probe)과 서비스가 깨질 수 있는 것(hostNetwork, root 실행, NetworkPolicy)은 고치지 않는다.
use serde_json::{json, Map, Value};

use super::{Fix, Workload, WorkloadKind};
use crate::k8s::rows::KindRef;

/// 같은 필드를 다른 도구(Helm, ArgoCD, Flux)가 관리하면 다음 배포 때 되돌아간다
pub fn managed_by(w: &Workload) -> Option<&'static str> {
    let label = |key: &str| w.labels.contains_key(key);
    if w.labels.get("app.kubernetes.io/managed-by").is_some_and(|v| v == "Helm") {
        Some("Helm")
    } else if label("argocd.argoproj.io/instance") || w.annotations.contains_key("argocd.argoproj.io/tracking-id") {
        Some("ArgoCD")
    } else if label("kustomize.toolkit.fluxcd.io/name") || label("helm.toolkit.fluxcd.io/name") {
        Some("Flux")
    } else {
        None
    }
}

pub fn service_account_kind() -> KindRef {
    KindRef { group: String::new(), version: "v1".into(), kind: "ServiceAccount".into(), plural: "serviceaccounts".into(), namespaced: true }
}

/// 네임스페이스의 `default` ServiceAccount가 토큰을 자동으로 마운트하지 않게 한다
pub fn automount_fix(namespace: &str) -> Fix {
    Fix {
        summary: "default ServiceAccount의 automountServiceAccountToken을 false로 바꿔요".into(),
        caution: Some("이 ServiceAccount를 쓰는 Pod가 쿠버네티스 API를 호출한다면 새로 뜨는 Pod부터 막혀요. 이미 떠 있는 Pod는 그대로예요".into()),
        kind: service_account_kind(),
        namespace: Some(namespace.to_string()),
        name: "default".into(),
        object: json!({
            "apiVersion": "v1",
            "kind": "ServiceAccount",
            "metadata": { "name": "default", "namespace": namespace },
            "automountServiceAccountToken": false,
        }),
    }
}

/// 컨테이너(`containers`)와 init 컨테이너(`init`)에 `allowPrivilegeEscalation: false`를 더한다. 컨트롤러의 Pod 템플릿에서만 고칠 수 있다
/// (Pod와 Job의 템플릿은 만든 뒤에 바꿀 수 없다). 고칠 컨테이너가 없으면 None.
pub fn privilege_escalation_fix(w: &Workload, containers: &[String], init: &[String]) -> Option<Fix> {
    if containers.is_empty() && init.is_empty() {
        return None;
    }
    let path = w.kind.pod_spec_path()?;
    let entry = |name: &String| json!({ "name": name, "securityContext": { "allowPrivilegeEscalation": false } });
    let mut spec = Map::new();
    if !containers.is_empty() {
        spec.insert("containers".into(), Value::Array(containers.iter().map(entry).collect()));
    }
    if !init.is_empty() {
        spec.insert("initContainers".into(), Value::Array(init.iter().map(entry).collect()));
    }
    // 객체 뼈대에 Pod 스펙까지 경로대로 감싼다
    let mut nested = Value::Object(spec);
    for key in path.iter().rev() {
        let mut wrap = Map::new();
        wrap.insert((*key).to_string(), nested);
        nested = Value::Object(wrap);
    }
    let mut object = nested.as_object().cloned().unwrap_or_default();
    object.insert("apiVersion".into(), json!(w.kind.api_version()));
    object.insert("kind".into(), json!(w.kind.kind_ref().kind));
    object.insert("metadata".into(), json!({ "name": w.name, "namespace": w.namespace }));
    let names: Vec<&str> = containers.iter().chain(init.iter()).map(String::as_str).collect();
    let mut caution = "Pod 템플릿이 바뀌어 Pod가 새로 만들어져요(롤아웃). setuid 프로그램(sudo 등)이나 파일 capability에 기대는 컨테이너는 동작이 달라질 수 있어요".to_string();
    if let Some(tool) = managed_by(w) {
        caution.push_str(&format!(". {tool}이(가) 관리하는 객체라 소스를 고치지 않으면 다음 배포 때 되돌아가요"));
    }
    Some(Fix {
        summary: format!("컨테이너 {}에 allowPrivilegeEscalation: false를 더해요", names.join(", ")),
        caution: Some(caution),
        kind: w.kind.kind_ref(),
        namespace: Some(w.namespace.clone()),
        name: w.name.clone(),
        object: Value::Object(object),
    })
}

impl WorkloadKind {
    pub fn api_version(self) -> &'static str {
        match self {
            WorkloadKind::Deployment | WorkloadKind::StatefulSet | WorkloadKind::DaemonSet => "apps/v1",
            WorkloadKind::Job | WorkloadKind::CronJob => "batch/v1",
            WorkloadKind::Pod => "v1",
        }
    }

    pub fn kind_ref(self) -> KindRef {
        let (group, kind, plural) = match self {
            WorkloadKind::Deployment => ("apps", "Deployment", "deployments"),
            WorkloadKind::StatefulSet => ("apps", "StatefulSet", "statefulsets"),
            WorkloadKind::DaemonSet => ("apps", "DaemonSet", "daemonsets"),
            WorkloadKind::Job => ("batch", "Job", "jobs"),
            WorkloadKind::CronJob => ("batch", "CronJob", "cronjobs"),
            WorkloadKind::Pod => ("", "Pod", "pods"),
        };
        KindRef { group: group.into(), version: "v1".into(), kind: kind.into(), plural: plural.into(), namespaced: true }
    }

    /// 객체 안에서 Pod 스펙의 경로. 만든 뒤에 Pod 스펙을 바꿀 수 없는 종류(Pod, Job)는 None.
    pub fn pod_spec_path(self) -> Option<&'static [&'static str]> {
        match self {
            WorkloadKind::Deployment | WorkloadKind::StatefulSet | WorkloadKind::DaemonSet => Some(&["spec", "template", "spec"]),
            WorkloadKind::CronJob => Some(&["spec", "jobTemplate", "spec", "template", "spec"]),
            WorkloadKind::Job | WorkloadKind::Pod => None,
        }
    }
}

#[cfg(test)]
mod tests;
