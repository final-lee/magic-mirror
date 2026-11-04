//! 워크로드 점검(순수): Pod 템플릿(Deployment·StatefulSet·DaemonSet·Job·CronJob)과 컨트롤러 없는 Pod의 보안 설정, 기본 ServiceAccount 토큰,
//! NetworkPolicy 없는 네임스페이스. 컨트롤러가 만든 Pod는 컨트롤러 템플릿에서 한 번만 본다. 한 워크로드는 점검마다 문제 하나로 묶는다.
use std::collections::{BTreeMap, HashSet};

use k8s_openapi::api::core::v1::{Container, PodSpec};

use super::fix::{automount_fix, privilege_escalation_fix, service_account_kind};
use super::{CheckId, Finding, SaFacts, Severity, Target, Workload, WorkloadKind};
use crate::k8s::rows::KindRef;

pub const TRUNCATED: &str = "목록이 너무 길어 끝까지 읽지 못했어요(일부만 점검했어요)";
/// 증거에 늘어놓는 줄의 최대 수
const EVIDENCE_MAX: usize = 8;
/// 노드의 이런 경로를 마운트하면 컨테이너 탈출이나 런타임 장악으로 이어진다
const SENSITIVE_PATHS: [&str; 8] = ["/etc", "/root", "/proc", "/sys", "/var/lib/kubelet", "/var/lib/docker", "/var/lib/containerd", "/etc/kubernetes"];

fn target(w: &Workload) -> Target {
    Target::Object { kind: w.kind.kind_ref(), namespace: Some(w.namespace.clone()), name: w.name.clone() }
}

fn finding(w: &Workload, check: CheckId, severity: Severity, message: &str, mut evidence: Vec<String>) -> Finding {
    if evidence.len() > EVIDENCE_MAX {
        let more = evidence.len() - EVIDENCE_MAX;
        evidence.truncate(EVIDENCE_MAX);
        evidence.push(format!("…외 {more}개"));
    }
    Finding::new(check, severity, target(w), Some(w.namespace.clone()), message, evidence)
}

/// 컨테이너 이름표. init 컨테이너는 따로 적는다.
fn label(c: &Container, init: bool) -> String {
    if init {
        format!("init 컨테이너 {}", c.name)
    } else {
        format!("컨테이너 {}", c.name)
    }
}

/// (init 여부, 컨테이너) 전부
fn all_containers(spec: &PodSpec) -> Vec<(bool, &Container)> {
    let init = spec.init_containers.iter().flatten().map(|c| (true, c));
    spec.containers.iter().map(|c| (false, c)).chain(init).collect()
}

fn privileged(c: &Container) -> bool {
    c.security_context.as_ref().and_then(|s| s.privileged) == Some(true)
}

fn is_windows(spec: &PodSpec) -> bool {
    spec.os.as_ref().is_some_and(|os| os.name == "windows")
}

/// 이 경로를 마운트하면 특히 위험하다: 루트, 컨테이너 런타임 소켓, 설정·kubelet 디렉터리
pub fn sensitive_host_path(path: &str) -> bool {
    let p = if path.len() > 1 { path.trim_end_matches('/') } else { path };
    p == "/" || p == "/var/run" || p == "/run" || p.ends_with(".sock") || SENSITIVE_PATHS.iter().any(|s| p == *s || p.starts_with(&format!("{s}/")))
}

/// 이미지 참조의 태그가 `latest`이거나 없으면 그 이유. 다이제스트(`@sha256:…`)로 고정했으면 문제 없다.
pub fn mutable_image(image: &str) -> Option<&'static str> {
    if image.contains('@') {
        return None;
    }
    // 레지스트리 포트(`localhost:5000/app`)와 태그를 구분하려고 마지막 경로 토막만 본다
    let last = image.rsplit('/').next().unwrap_or(image);
    match last.split_once(':') {
        None => Some("태그 없음(latest로 받아요)"),
        Some((_, "latest")) => Some("태그 latest"),
        Some(_) => None,
    }
}

fn host_paths(w: &Workload) -> (Vec<String>, bool) {
    let mut sensitive = false;
    let lines = w
        .spec
        .volumes
        .iter()
        .flatten()
        .filter_map(|v| {
            let host = v.host_path.as_ref()?;
            sensitive |= sensitive_host_path(&host.path);
            Some(format!("볼륨 {}: {}", v.name, host.path))
        })
        .collect();
    (lines, sensitive)
}

/// root 실행 여부: 명시적 UID 0, 또는 UID와 runAsNonRoot를 모두 정하지 않아 이미지 기본 사용자를 따르는 경우
fn root_lines(w: &Workload) -> (Vec<String>, bool) {
    let pod = w.spec.security_context.as_ref();
    let mut explicit = false;
    let mut lines = Vec::new();
    for (init, c) in all_containers(&w.spec) {
        let sc = c.security_context.as_ref();
        let uid = sc.and_then(|s| s.run_as_user).or_else(|| pod.and_then(|p| p.run_as_user));
        let non_root = sc.and_then(|s| s.run_as_non_root).or_else(|| pod.and_then(|p| p.run_as_non_root));
        match (uid, non_root) {
            (Some(0), _) => {
                explicit = true;
                lines.push(format!("{}: runAsUser 0(root)", label(c, init)));
            }
            (None, Some(true)) | (Some(_), _) => {}
            (None, _) => lines.push(format!("{}: runAsUser·runAsNonRoot 미지정(이미지의 기본 사용자를 따라요)", label(c, init))),
        }
    }
    (lines, explicit)
}

struct Escalation {
    lines: Vec<String>,
    /// 자동으로 고칠 수 있는(미지정이고 privileged가 아닌) 컨테이너와 init 컨테이너
    fixable: Vec<String>,
    fixable_init: Vec<String>,
}

fn adds_sys_admin(c: &Container) -> bool {
    c.security_context.as_ref().and_then(|s| s.capabilities.as_ref()).and_then(|c| c.add.as_ref()).is_some_and(|add| add.iter().any(|cap| cap.trim_start_matches("CAP_") == "SYS_ADMIN"))
}

fn escalation(w: &Workload) -> Escalation {
    let mut out = Escalation { lines: vec![], fixable: vec![], fixable_init: vec![] };
    for (init, c) in all_containers(&w.spec) {
        // privileged는 따로 점검하고, 그 컨테이너에는 false를 쓸 수 없다
        if privileged(c) {
            continue;
        }
        match c.security_context.as_ref().and_then(|s| s.allow_privilege_escalation) {
            Some(false) => {}
            Some(true) => out.lines.push(format!("{}: allowPrivilegeEscalation: true", label(c, init))),
            None => {
                out.lines.push(format!("{}: allowPrivilegeEscalation 미지정(기본값 true)", label(c, init)));
                // CAP_SYS_ADMIN을 더한 컨테이너에 false를 쓰면 API 서버가 거절한다
                if !adds_sys_admin(c) {
                    if init {
                        out.fixable_init.push(c.name.clone());
                    } else {
                        out.fixable.push(c.name.clone());
                    }
                }
            }
        }
    }
    out
}

fn missing_resources(c: &Container) -> Option<String> {
    let r = c.resources.as_ref();
    let part = |name: &str, map: Option<&BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>>| {
        let missing: Vec<&str> = ["cpu", "memory"].into_iter().filter(|k| !map.is_some_and(|m| m.contains_key(*k))).collect();
        (!missing.is_empty()).then(|| format!("{name}({}) 없음", missing.join(", ")))
    };
    let parts: Vec<String> = [part("requests", r.and_then(|r| r.requests.as_ref())), part("limits", r.and_then(|r| r.limits.as_ref()))].into_iter().flatten().collect();
    (!parts.is_empty()).then(|| parts.join(", "))
}

fn probes_apply(kind: WorkloadKind) -> bool {
    !matches!(kind, WorkloadKind::Job | WorkloadKind::CronJob)
}

/// 워크로드 하나의 모든 점검
fn check_one(w: &Workload) -> Vec<Finding> {
    let mut out = Vec::new();
    let windows = is_windows(&w.spec);

    let lines: Vec<String> = all_containers(&w.spec).into_iter().filter(|(_, c)| privileged(c)).map(|(i, c)| format!("{}: privileged: true", label(c, i))).collect();
    if !lines.is_empty() {
        out.push(finding(w, CheckId::Privileged, Severity::High, "privileged 컨테이너가 있어요(호스트의 거의 모든 권한을 가져요)", lines));
    }
    let (lines, sensitive) = host_paths(w);
    if !lines.is_empty() {
        out.push(finding(w, CheckId::HostPath, if sensitive { Severity::High } else { Severity::Medium }, "hostPath 볼륨으로 노드의 파일 시스템을 마운트해요", lines));
    }
    if w.spec.host_network == Some(true) {
        out.push(finding(w, CheckId::HostNetwork, Severity::Medium, "hostNetwork로 노드의 네트워크를 그대로 써요", vec!["hostNetwork: true".into()]));
    }
    if w.spec.host_pid == Some(true) {
        out.push(finding(w, CheckId::HostPid, Severity::High, "hostPID로 노드의 모든 프로세스가 보여요", vec!["hostPID: true".into()]));
    }
    if !windows {
        let (lines, explicit) = root_lines(w);
        if !lines.is_empty() {
            let message = if explicit { "root(UID 0)로 실행하는 컨테이너가 있어요" } else { "runAsNonRoot·runAsUser를 정하지 않은 컨테이너가 있어요(이미지가 root면 root로 실행돼요)" };
            out.push(finding(w, CheckId::RunsAsRoot, if explicit { Severity::Medium } else { Severity::Low }, message, lines));
        }
        let esc = escalation(w);
        if !esc.lines.is_empty() {
            let mut lines = esc.lines.clone();
            let fix = privilege_escalation_fix(w, &esc.fixable, &esc.fixable_init);
            if fix.is_none() && (!esc.fixable.is_empty() || !esc.fixable_init.is_empty()) {
                lines.push("Pod와 Job의 Pod 템플릿은 만든 뒤에 바꿀 수 없어요. 이 객체를 만든 쪽(컨트롤러·매니페스트)에서 고쳐 주세요".into());
            }
            out.push(finding(w, CheckId::PrivilegeEscalation, Severity::Medium, "allowPrivilegeEscalation이 false가 아닌 컨테이너가 있어요", lines).with_fix(fix));
        }
    }
    let lines: Vec<String> = w.spec.containers.iter().filter_map(|c| missing_resources(c).map(|m| format!("{}: {m}", label(c, false)))).collect();
    if !lines.is_empty() {
        out.push(finding(w, CheckId::ResourcesMissing, Severity::Low, "request·limit이 없는 컨테이너가 있어요", lines));
    }
    if probes_apply(w.kind) {
        let lines: Vec<String> = w
            .spec
            .containers
            .iter()
            .filter_map(|c| {
                let mut missing = Vec::new();
                if c.readiness_probe.is_none() {
                    missing.push("readinessProbe");
                }
                if c.liveness_probe.is_none() {
                    missing.push("livenessProbe");
                }
                (!missing.is_empty()).then(|| format!("{}: {} 없음", label(c, false), missing.join(", ")))
            })
            .collect();
        if !lines.is_empty() {
            out.push(finding(w, CheckId::ProbesMissing, Severity::Low, "readiness·liveness probe가 없는 컨테이너가 있어요", lines));
        }
    }
    let lines: Vec<String> = all_containers(&w.spec)
        .into_iter()
        .filter_map(|(init, c)| {
            let image = c.image.as_deref()?;
            mutable_image(image).map(|why| format!("{}: {image} ({why})", label(c, init)))
        })
        .collect();
    if !lines.is_empty() {
        out.push(finding(w, CheckId::ImageLatest, Severity::Low, "태그가 latest이거나 없는 이미지를 써요(어떤 버전이 돌지 알 수 없어요)", lines));
    }
    out
}

/// 워크로드 점검(기본 SA·NetworkPolicy는 별도 함수)
pub fn check_workloads(items: &[Workload]) -> Vec<Finding> {
    items.iter().flat_map(check_one).collect()
}

fn uses_default_sa(spec: &PodSpec) -> bool {
    let name = spec.service_account_name.as_deref().or(spec.service_account.as_deref()).unwrap_or("default");
    name.is_empty() || name == "default"
}

fn kind_name(kind: WorkloadKind) -> String {
    kind.kind_ref().kind
}

/// 네임스페이스의 `default` ServiceAccount를 쓰는 워크로드가 있는데 토큰 자동 마운트가 꺼져 있지 않다
pub fn check_default_sa(items: &[Workload], service_accounts: &[SaFacts]) -> Vec<Finding> {
    let mut out = Vec::new();
    for sa in service_accounts.iter().filter(|s| s.name == "default" && s.automount != Some(false)) {
        let users: Vec<&Workload> = items.iter().filter(|w| w.namespace == sa.namespace && uses_default_sa(&w.spec) && w.spec.automount_service_account_token != Some(false)).collect();
        if users.is_empty() {
            continue;
        }
        let mut evidence = vec![match sa.automount {
            Some(_) => "automountServiceAccountToken: true".to_string(),
            None => "automountServiceAccountToken 미설정(기본값 true)".to_string(),
        }];
        evidence.extend(users.iter().take(EVIDENCE_MAX).map(|w| format!("쓰는 워크로드: {} {}", kind_name(w.kind), w.name)));
        if users.len() > EVIDENCE_MAX {
            evidence.push(format!("…외 {}개", users.len() - EVIDENCE_MAX));
        }
        let bound = sa.bound == Some(true);
        if bound {
            evidence.push("이 ServiceAccount에는 기본 그룹 말고 다른 권한도 붙어 있어요(그 권한을 쓰는 Pod가 있을 수 있어 자동으로 고치지 않아요)".into());
        } else if sa.bound.is_none() {
            evidence.push("RBAC을 읽지 못해 이 ServiceAccount에 붙은 권한을 알 수 없어요(자동으로 고치지 않아요)".into());
        }
        let message = format!("{}의 default ServiceAccount 토큰이 Pod에 자동으로 마운트돼요", sa.namespace);
        let finding = Finding::new(
            CheckId::SaTokenAutomount,
            if bound { Severity::Medium } else { Severity::Low },
            Target::Object { kind: service_account_kind(), namespace: Some(sa.namespace.clone()), name: sa.name.clone() },
            Some(sa.namespace.clone()),
            message,
            evidence,
        );
        out.push(finding.with_fix((sa.bound == Some(false)).then(|| automount_fix(&sa.namespace))));
    }
    out
}

fn namespace_kind() -> KindRef {
    KindRef { group: String::new(), version: "v1".into(), kind: "Namespace".into(), plural: "namespaces".into(), namespaced: false }
}

/// NetworkPolicy가 하나도 없는 네임스페이스. 워크로드가 있으면 중간, 없으면 낮음.
pub fn check_network_policies(namespaces: &[String], policy_namespaces: &[String], items: &[Workload]) -> Vec<Finding> {
    let with_policy: HashSet<&str> = policy_namespaces.iter().map(String::as_str).collect();
    namespaces
        .iter()
        .filter(|ns| !with_policy.contains(ns.as_str()))
        .map(|ns| {
            let count = items.iter().filter(|w| &w.namespace == ns).count();
            Finding::new(
                CheckId::NoNetworkPolicy,
                if count > 0 { Severity::Medium } else { Severity::Low },
                Target::Object { kind: namespace_kind(), namespace: None, name: ns.clone() },
                Some(ns.clone()),
                format!("네임스페이스 {ns}에 NetworkPolicy가 없어요(Pod끼리 모든 통신이 열려 있어요)"),
                vec!["NetworkPolicy 0개".to_string(), format!("워크로드 {count}개"), "NetworkPolicy는 CNI가 지원해야 동작해요(VPC CNI는 네트워크 정책 기능을 켜야 해요)".into()],
            )
        })
        .collect()
}

#[cfg(test)]
mod tests;
