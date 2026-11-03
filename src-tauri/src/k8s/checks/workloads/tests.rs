use serde_json::{json, Value};

use super::*;
use crate::k8s::checks::testkit::{deployment, of, workload};

/// 점검에 걸릴 것이 없는 컨테이너 하나짜리 스펙
fn clean_container(name: &str) -> Value {
    json!({
        "name": name,
        "image": "registry.example.com/app:1.2.3",
        "securityContext": { "allowPrivilegeEscalation": false, "runAsNonRoot": true },
        "resources": { "requests": { "cpu": "100m", "memory": "64Mi" }, "limits": { "cpu": "200m", "memory": "128Mi" } },
        "readinessProbe": { "httpGet": { "path": "/", "port": 80 } },
        "livenessProbe": { "httpGet": { "path": "/", "port": 80 } },
    })
}

fn clean_spec() -> Value {
    json!({ "containers": [clean_container("app")] })
}

fn with_container(patch: Value) -> Value {
    let mut c = clean_container("app");
    for (k, v) in patch.as_object().unwrap() {
        c[k] = v.clone();
    }
    json!({ "containers": [c] })
}

fn checks_of(w: &Workload) -> Vec<CheckId> {
    check_workloads(std::slice::from_ref(w)).iter().map(|f| f.check).collect()
}

#[test]
fn a_clean_workload_has_no_findings() {
    assert!(check_workloads(&[deployment("dev", "web", clean_spec())]).is_empty());
}

#[test]
fn findings_carry_the_workload_as_target_and_its_namespace() {
    let w = deployment("kube-system", "web", with_container(json!({ "securityContext": { "privileged": true } })));
    let found = check_workloads(&[w]);
    let f = &of(&found, CheckId::Privileged)[0];
    assert_eq!(f.target, Target::Object { kind: WorkloadKind::Deployment.kind_ref(), namespace: Some("kube-system".into()), name: "web".into() });
    assert!(f.system && f.namespace.as_deref() == Some("kube-system"));
    assert_eq!(f.severity, Severity::High);
}

// ── privileged · host* ──

#[test]
fn privileged_containers_including_init_containers_are_high() {
    let spec = json!({
        "containers": [clean_container("app")],
        "initContainers": [{ "name": "setup", "image": "busybox:1", "securityContext": { "privileged": true } }],
    });
    let found = check_workloads(&[deployment("dev", "web", spec)]);
    let f = of(&found, CheckId::Privileged);
    assert_eq!(f.len(), 1);
    assert_eq!(f[0].evidence, ["init 컨테이너 setup: privileged: true"]);
    // privileged: false는 문제가 아니다
    assert!(!checks_of(&deployment("dev", "web", with_container(json!({ "securityContext": { "privileged": false, "allowPrivilegeEscalation": false, "runAsNonRoot": true } })))).contains(&CheckId::Privileged));
}

#[test]
fn host_network_is_medium_and_host_pid_is_high() {
    let mut spec = clean_spec();
    spec["hostNetwork"] = json!(true);
    spec["hostPID"] = json!(true);
    let found = check_workloads(&[deployment("dev", "web", spec)]);
    assert_eq!(of(&found, CheckId::HostNetwork)[0].severity, Severity::Medium);
    assert_eq!(of(&found, CheckId::HostPid)[0].severity, Severity::High);
    let mut off = clean_spec();
    off["hostNetwork"] = json!(false);
    assert!(check_workloads(&[deployment("dev", "web", off)]).is_empty());
}

#[test]
fn host_path_volumes_are_medium_and_the_runtime_socket_or_root_is_high() {
    let spec = |path: &str| {
        let mut s = clean_spec();
        s["volumes"] = json!([{ "name": "data", "hostPath": { "path": path } }]);
        deployment("dev", "web", s)
    };
    let sev = |path: &str| of(&check_workloads(&[spec(path)]), CheckId::HostPath)[0].severity;
    assert_eq!(sev("/data/app"), Severity::Medium);
    assert_eq!(sev("/var/log/pods"), Severity::Medium);
    assert_eq!(sev("/"), Severity::High);
    assert_eq!(sev("/var/run/docker.sock"), Severity::High);
    assert_eq!(sev("/run/containerd/containerd.sock"), Severity::High);
    assert_eq!(sev("/etc/kubernetes/pki"), Severity::High);
    assert_eq!(sev("/var/lib/kubelet/"), Severity::High);
    // 이름이 비슷할 뿐인 경로는 민감하지 않다
    assert_eq!(sev("/etcetera"), Severity::Medium);
    let found = check_workloads(&[spec("/var/log")]);
    assert_eq!(of(&found, CheckId::HostPath)[0].evidence, ["볼륨 data: /var/log"]);
}

#[test]
fn emptydir_and_configmap_volumes_are_not_host_paths() {
    let mut s = clean_spec();
    s["volumes"] = json!([{ "name": "tmp", "emptyDir": {} }, { "name": "cfg", "configMap": { "name": "x" } }]);
    assert!(check_workloads(&[deployment("dev", "web", s)]).is_empty());
}

// ── root 실행 ──

#[test]
fn an_explicit_uid_zero_is_medium_even_when_run_as_non_root_is_missing() {
    let found = check_workloads(&[deployment("dev", "web", with_container(json!({ "securityContext": { "runAsUser": 0, "allowPrivilegeEscalation": false } })))]);
    let f = &of(&found, CheckId::RunsAsRoot)[0];
    assert_eq!(f.severity, Severity::Medium);
    assert_eq!(f.evidence, ["컨테이너 app: runAsUser 0(root)"]);
}

#[test]
fn leaving_the_user_unspecified_is_only_a_low_warning() {
    let found = check_workloads(&[deployment("dev", "web", with_container(json!({ "securityContext": { "allowPrivilegeEscalation": false } })))]);
    let f = &of(&found, CheckId::RunsAsRoot)[0];
    assert_eq!(f.severity, Severity::Low);
    assert!(f.evidence[0].contains("미지정"));
}

#[test]
fn run_as_non_root_or_a_nonzero_uid_clears_the_root_finding() {
    let uid = check_workloads(&[deployment("dev", "web", with_container(json!({ "securityContext": { "runAsUser": 1000, "allowPrivilegeEscalation": false } })))]);
    assert!(of(&uid, CheckId::RunsAsRoot).is_empty());
    let non_root = check_workloads(&[deployment("dev", "web", clean_spec())]);
    assert!(of(&non_root, CheckId::RunsAsRoot).is_empty());
}

#[test]
fn pod_level_security_context_applies_unless_the_container_overrides_it() {
    let mut spec = json!({ "containers": [{ "name": "app", "image": "a:1", "securityContext": { "allowPrivilegeEscalation": false } }], "securityContext": { "runAsUser": 1000 } });
    assert!(of(&check_workloads(&[deployment("dev", "web", spec.clone())]), CheckId::RunsAsRoot).is_empty());
    // 컨테이너가 0으로 덮어쓰면 root다
    spec["containers"][0]["securityContext"]["runAsUser"] = json!(0);
    assert_eq!(of(&check_workloads(&[deployment("dev", "web", spec)]), CheckId::RunsAsRoot)[0].severity, Severity::Medium);
    // Pod 수준의 runAsNonRoot도 물려받는다
    let spec = json!({ "containers": [{ "name": "app", "image": "a:1", "securityContext": { "allowPrivilegeEscalation": false } }], "securityContext": { "runAsNonRoot": true } });
    assert!(of(&check_workloads(&[deployment("dev", "web", spec)]), CheckId::RunsAsRoot).is_empty());
}

// ── allowPrivilegeEscalation ──

fn bare(kind: WorkloadKind, spec: Value) -> Workload {
    workload(kind, "dev", "x", spec)
}

fn escalation_spec() -> Value {
    json!({ "containers": [
        { "name": "app", "image": "a:1", "securityContext": { "runAsNonRoot": true } },
        { "name": "side", "image": "b:1", "securityContext": { "runAsNonRoot": true, "allowPrivilegeEscalation": false } },
    ]})
}

#[test]
fn an_unset_allow_privilege_escalation_is_flagged_with_a_fix_for_only_that_container() {
    let found = check_workloads(&[bare(WorkloadKind::Deployment, escalation_spec())]);
    let f = &of(&found, CheckId::PrivilegeEscalation)[0];
    assert_eq!(f.severity, Severity::Medium);
    assert_eq!(f.evidence, ["컨테이너 app: allowPrivilegeEscalation 미지정(기본값 true)"]);
    let fix = f.fix.as_ref().expect("고칠 수 있다");
    assert_eq!(fix.object["spec"]["template"]["spec"]["containers"], json!([{ "name": "app", "securityContext": { "allowPrivilegeEscalation": false } }]));
}

#[test]
fn an_explicit_true_is_flagged_but_not_overwritten_by_the_fix() {
    let spec = json!({ "containers": [{ "name": "app", "image": "a:1", "securityContext": { "runAsNonRoot": true, "allowPrivilegeEscalation": true } }] });
    let found = check_workloads(&[bare(WorkloadKind::Deployment, spec)]);
    let f = &of(&found, CheckId::PrivilegeEscalation)[0];
    assert!(f.evidence[0].contains("allowPrivilegeEscalation: true"));
    assert!(f.fix.is_none(), "사람이 일부러 켠 값은 자동으로 바꾸지 않는다");
}

#[test]
fn privileged_and_sys_admin_containers_cannot_take_the_fix() {
    // privileged에 false를 쓰면 API 서버가 거절하므로 점검 대상에서도 빠지고(privileged로 따로 걸린다), CAP_SYS_ADMIN도 같다
    let spec = json!({ "containers": [
        { "name": "priv", "image": "a:1", "securityContext": { "privileged": true } },
        { "name": "cap", "image": "a:1", "securityContext": { "capabilities": { "add": ["CAP_SYS_ADMIN"] } } },
        { "name": "plain", "image": "a:1" },
    ]});
    let found = check_workloads(&[bare(WorkloadKind::Deployment, spec)]);
    assert_eq!(of(&found, CheckId::Privileged).len(), 1);
    let f = &of(&found, CheckId::PrivilegeEscalation)[0];
    assert_eq!(f.evidence.len(), 2, "{:?}", f.evidence);
    let containers = &f.fix.as_ref().unwrap().object["spec"]["template"]["spec"]["containers"];
    assert_eq!(containers, &json!([{ "name": "plain", "securityContext": { "allowPrivilegeEscalation": false } }]));
}

#[test]
fn only_a_privileged_container_leaves_nothing_to_fix_and_no_escalation_finding() {
    let spec = json!({ "containers": [{ "name": "priv", "image": "a:1", "securityContext": { "privileged": true } }] });
    let found = check_workloads(&[bare(WorkloadKind::Deployment, spec)]);
    assert!(of(&found, CheckId::PrivilegeEscalation).is_empty());
}

#[test]
fn init_containers_are_fixed_through_init_containers() {
    let spec = json!({ "containers": [clean_container("app")], "initContainers": [{ "name": "setup", "image": "a:1" }] });
    let found = check_workloads(&[bare(WorkloadKind::StatefulSet, spec)]);
    let fix = of(&found, CheckId::PrivilegeEscalation)[0].fix.as_ref().unwrap();
    assert_eq!(fix.object["spec"]["template"]["spec"]["initContainers"][0]["name"], "setup");
    assert!(fix.object["spec"]["template"]["spec"].get("containers").is_none());
}

#[test]
fn bare_pods_and_jobs_are_flagged_without_a_fix_and_with_a_reason() {
    for kind in [WorkloadKind::Pod, WorkloadKind::Job] {
        let found = check_workloads(&[bare(kind, escalation_spec())]);
        let f = &of(&found, CheckId::PrivilegeEscalation)[0];
        assert!(f.fix.is_none(), "{kind:?}");
        assert!(f.evidence.last().unwrap().contains("만든 뒤에 바꿀 수 없어요"), "{kind:?}: {:?}", f.evidence);
    }
}

#[test]
fn a_cronjob_is_fixed_inside_its_job_template() {
    let found = check_workloads(&[bare(WorkloadKind::CronJob, escalation_spec())]);
    let fix = of(&found, CheckId::PrivilegeEscalation)[0].fix.as_ref().unwrap();
    assert_eq!(fix.object["spec"]["jobTemplate"]["spec"]["template"]["spec"]["containers"][0]["name"], "app");
    assert_eq!(fix.object["apiVersion"], "batch/v1");
}

#[test]
fn windows_pods_skip_the_linux_security_context_checks() {
    let mut spec = json!({ "containers": [{ "name": "app", "image": "a:1" }] });
    spec["os"] = json!({ "name": "windows" });
    let ids = checks_of(&bare(WorkloadKind::Deployment, spec));
    assert!(!ids.contains(&CheckId::RunsAsRoot) && !ids.contains(&CheckId::PrivilegeEscalation), "{ids:?}");
}

// ── request·limit, probe ──

#[test]
fn containers_without_requests_or_limits_list_what_is_missing() {
    let spec = json!({ "containers": [
        { "name": "none", "image": "a:1" },
        { "name": "half", "image": "a:1", "resources": { "requests": { "cpu": "1" }, "limits": { "cpu": "2", "memory": "1Gi" } } },
        { "name": "full", "image": "a:1", "resources": { "requests": { "cpu": "1", "memory": "1Gi" }, "limits": { "cpu": "2", "memory": "1Gi" } } },
    ]});
    let found = check_workloads(&[bare(WorkloadKind::Deployment, spec)]);
    let f = &of(&found, CheckId::ResourcesMissing)[0];
    assert_eq!(f.severity, Severity::Low);
    assert_eq!(f.evidence, ["컨테이너 none: requests(cpu, memory) 없음, limits(cpu, memory) 없음", "컨테이너 half: requests(memory) 없음"]);
}

#[test]
fn probes_are_checked_per_container_and_skipped_for_jobs() {
    let spec = json!({ "containers": [
        { "name": "ready-only", "image": "a:1", "readinessProbe": { "tcpSocket": { "port": 1 } } },
        { "name": "both", "image": "a:1", "readinessProbe": { "tcpSocket": { "port": 1 } }, "livenessProbe": { "tcpSocket": { "port": 1 } } },
    ]});
    let found = check_workloads(&[bare(WorkloadKind::Deployment, spec.clone())]);
    assert_eq!(of(&found, CheckId::ProbesMissing)[0].evidence, ["컨테이너 ready-only: livenessProbe 없음"]);
    for kind in [WorkloadKind::Job, WorkloadKind::CronJob] {
        assert!(of(&check_workloads(&[bare(kind, spec.clone())]), CheckId::ProbesMissing).is_empty(), "{kind:?}");
    }
}

// ── 이미지 ──

#[test]
fn image_references_without_a_pinned_version_are_flagged() {
    for (image, flagged) in [
        ("nginx", true),
        ("nginx:latest", true),
        ("registry.example.com:5000/team/app", true),
        ("registry.example.com:5000/team/app:latest", true),
        ("nginx:1.27", false),
        ("registry.example.com:5000/team/app:v2", false),
        ("nginx@sha256:abc", false),
        ("nginx:latest@sha256:abc", false),
    ] {
        assert_eq!(mutable_image(image).is_some(), flagged, "{image}");
    }
}

#[test]
fn the_image_finding_names_the_container_image_and_reason() {
    let spec = json!({ "containers": [{ "name": "a", "image": "nginx" }, { "name": "b", "image": "nginx:1.27" }], "initContainers": [{ "name": "i", "image": "busybox:latest" }] });
    let found = check_workloads(&[bare(WorkloadKind::Deployment, spec)]);
    assert_eq!(of(&found, CheckId::ImageLatest)[0].evidence, ["컨테이너 a: nginx (태그 없음(latest로 받아요))", "init 컨테이너 i: busybox:latest (태그 latest)"]);
}

// ── 증거 길이 ──

#[test]
fn a_long_evidence_list_is_cut_with_a_remainder() {
    let containers: Vec<Value> = (0..12).map(|i| json!({ "name": format!("c{i}"), "image": "a:1" })).collect();
    let found = check_workloads(&[bare(WorkloadKind::Deployment, json!({ "containers": containers }))]);
    let f = &of(&found, CheckId::ResourcesMissing)[0];
    assert_eq!(f.evidence.len(), 9);
    assert_eq!(f.evidence.last().unwrap(), "…외 4개");
}

// ── 기본 ServiceAccount ──

fn sa(namespace: &str, automount: Option<bool>, bound: Option<bool>) -> SaFacts {
    SaFacts { namespace: namespace.into(), name: "default".into(), automount, bound }
}

fn uses_default(namespace: &str, name: &str) -> Workload {
    deployment(namespace, name, clean_spec())
}

#[test]
fn a_default_service_account_used_by_a_workload_with_automount_on_is_flagged_with_a_fix() {
    let found = check_default_sa(&[uses_default("dev", "web")], &[sa("dev", None, Some(false))]);
    assert_eq!(found.len(), 1);
    let f = &found[0];
    assert_eq!(f.check, CheckId::SaTokenAutomount);
    assert_eq!(f.severity, Severity::Low);
    assert_eq!(f.target, Target::Object { kind: service_account_kind(), namespace: Some("dev".into()), name: "default".into() });
    assert!(f.evidence.iter().any(|e| e == "쓰는 워크로드: Deployment web"));
    let fix = f.fix.as_ref().unwrap();
    assert_eq!(fix.object["automountServiceAccountToken"], json!(false));
    assert_eq!(fix.object["metadata"], json!({ "name": "default", "namespace": "dev" }));
}

#[test]
fn no_finding_when_nothing_uses_the_default_service_account() {
    let mut other = clean_spec();
    other["serviceAccountName"] = json!("app-sa");
    assert!(check_default_sa(&[deployment("dev", "web", other)], &[sa("dev", None, Some(false))]).is_empty());
    assert!(check_default_sa(&[], &[sa("dev", None, Some(false))]).is_empty());
    // 다른 네임스페이스의 워크로드는 이 네임스페이스의 default를 쓰지 않는다
    assert!(check_default_sa(&[uses_default("other", "web")], &[sa("dev", None, Some(false))]).is_empty());
}

#[test]
fn already_disabled_automount_on_the_service_account_or_the_pod_is_fine() {
    assert!(check_default_sa(&[uses_default("dev", "web")], &[sa("dev", Some(false), Some(false))]).is_empty());
    let mut off = clean_spec();
    off["automountServiceAccountToken"] = json!(false);
    assert!(check_default_sa(&[deployment("dev", "web", off)], &[sa("dev", None, Some(false))]).is_empty());
}

#[test]
fn an_explicit_default_name_and_the_old_service_account_field_both_mean_default() {
    for key in ["serviceAccountName", "serviceAccount"] {
        let mut s = clean_spec();
        s[key] = json!("default");
        assert_eq!(check_default_sa(&[deployment("dev", "web", s)], &[sa("dev", Some(true), Some(false))]).len(), 1, "{key}");
    }
}

#[test]
fn a_default_service_account_with_its_own_grants_is_medium_and_never_auto_fixed() {
    let found = check_default_sa(&[uses_default("dev", "web")], &[sa("dev", None, Some(true))]);
    assert_eq!(found[0].severity, Severity::Medium);
    assert!(found[0].fix.is_none());
    assert!(found[0].evidence.iter().any(|e| e.contains("자동으로 고치지 않아요")));
}

#[test]
fn when_rbac_could_not_be_read_the_fix_is_withheld() {
    let found = check_default_sa(&[uses_default("dev", "web")], &[sa("dev", None, None)]);
    assert_eq!(found.len(), 1);
    assert!(found[0].fix.is_none());
}

#[test]
fn many_users_of_the_default_account_are_listed_up_to_the_limit() {
    let items: Vec<Workload> = (0..11).map(|i| uses_default("dev", &format!("w{i}"))).collect();
    let found = check_default_sa(&items, &[sa("dev", None, Some(false))]);
    assert_eq!(found[0].evidence.len(), 1 + EVIDENCE_MAX + 1);
    assert_eq!(found[0].evidence.last().unwrap(), "…외 3개");
}

// ── NetworkPolicy ──

#[test]
fn namespaces_without_any_policy_are_flagged_medium_when_they_run_workloads() {
    let namespaces = ["dev".to_string(), "empty".to_string(), "guarded".to_string()];
    let found = check_network_policies(&namespaces, &["guarded".to_string()], &[uses_default("dev", "web")]);
    assert_eq!(found.len(), 2);
    let dev = found.iter().find(|f| f.namespace.as_deref() == Some("dev")).unwrap();
    let empty = found.iter().find(|f| f.namespace.as_deref() == Some("empty")).unwrap();
    assert_eq!((dev.severity, empty.severity), (Severity::Medium, Severity::Low));
    assert_eq!(dev.target, Target::Object { kind: namespace_kind(), namespace: None, name: "dev".into() });
    assert!(dev.evidence.contains(&"워크로드 1개".to_string()));
}

#[test]
fn system_namespaces_without_policy_are_marked_system() {
    let found = check_network_policies(&["kube-system".to_string(), "amazon-guardduty".to_string()], &[], &[]);
    assert!(found.iter().all(|f| f.system));
}

#[test]
fn a_namespace_with_a_policy_is_fine_even_when_the_policy_is_in_another_listing_order() {
    let found = check_network_policies(&["a".to_string(), "b".to_string()], &["b".to_string(), "b".to_string(), "a".to_string()], &[]);
    assert!(found.is_empty());
}
