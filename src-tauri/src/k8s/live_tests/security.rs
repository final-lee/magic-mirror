//! 보안 점검(K5)을 실제 kind 클러스터에서 돌린다. 픽스처는 `scripts/k8s-live/security.sh`(mm-sec, mm-sec-bound, mm-sec-guarded 네임스페이스와 RBAC).
//! AWS에는 닿지 않는 것으로 두고(클라이언트를 만들지 못한 것과 같은 모양), 읽지 못한 AWS 부분이 gap·skipped로 남는지도 본다.
//! 고치기 시험은 kind 클러스터의 mm-sec-fix 객체에만 쓰기 요청을 보낸다.
use serde_json::{json, Value};

use super::{admin, build, reader_config, PRIVATE};
use crate::error::AppError;
use crate::k8s::change::{Change, ChangeObject, Operation};
use crate::k8s::checks::read::{gather, Aws};
use crate::k8s::checks::{run, CheckId, Finding, Report, Section, Severity, Target};
use crate::k8s::commit;
use crate::k8s::connect::client_for;

const NO_AWS: &str = "AWS를 쓰지 않는 시험이에요";
const NS: &str = "mm-sec";

async fn report_with(client: &kube::Client) -> Report {
    let aws: Result<Aws, AppError> = Err(AppError::other(NO_AWS));
    run(gather(client, &aws, "mm-live", PRIVATE, 1_800_000_000).await, "2026-11-03T00:00:00Z")
}

fn name_of(f: &Finding) -> &str {
    match &f.target {
        Target::Object { name, .. } | Target::Aws { name, .. } => name,
        Target::Subject { subject } => &subject.name,
    }
}

/// 이 점검의 문제 중 이 네임스페이스(`namespace`)의 것의 대상 이름(정렬)
fn names_in(r: &Report, check: CheckId, namespace: &str) -> Vec<String> {
    let mut out: Vec<String> = r.findings.iter().filter(|f| f.check == check && f.namespace.as_deref() == Some(namespace)).map(|f| name_of(f).to_string()).collect();
    out.sort();
    out
}

fn one<'a>(r: &'a Report, check: CheckId, name: &str) -> &'a Finding {
    let found: Vec<&Finding> = r.findings.iter().filter(|f| f.check == check && name_of(f) == name).collect();
    assert_eq!(found.len(), 1, "{check:?} {name}: {found:?}");
    found[0]
}

fn absent(r: &Report, check: CheckId, name: &str) -> bool {
    !r.findings.iter().any(|f| f.check == check && name_of(f) == name)
}

#[tokio::test]
#[ignore]
async fn workload_findings_match_the_fixture() {
    let r = report_with(&admin().await).await;

    assert_eq!(names_in(&r, CheckId::Privileged, NS), ["priv"]);
    assert_eq!(names_in(&r, CheckId::HostNetwork, NS), ["host"]);
    assert_eq!(names_in(&r, CheckId::HostPid, NS), ["host"]);
    let host_path = one(&r, CheckId::HostPath, "host");
    assert_eq!(host_path.severity, Severity::High, "노드 루트를 마운트했다: {:?}", host_path.evidence);
    assert!(host_path.evidence.iter().any(|e| e == "볼륨 root: /") && host_path.evidence.iter().any(|e| e == "볼륨 scratch: /tmp/mm-sec"));

    // root: 명시한 UID 0만 중간이고, 지정하지 않은 것은 낮음
    assert_eq!(one(&r, CheckId::RunsAsRoot, "root").severity, Severity::Medium);
    assert_eq!(one(&r, CheckId::RunsAsRoot, "bare").severity, Severity::Low);
    assert!(absent(&r, CheckId::RunsAsRoot, "esc"), "runAsNonRoot와 UID 1000을 정했다");

    // allowPrivilegeEscalation: privileged와 false로 정한 것은 빠지고, 템플릿을 고칠 수 있는 종류만 고칠 수 있다
    assert_eq!(names_in(&r, CheckId::PrivilegeEscalation, NS), ["bare", "cron", "esc", "host", "job"]);
    for name in ["bare", "cron", "esc", "host"] {
        assert!(one(&r, CheckId::PrivilegeEscalation, name).fix.is_some(), "{name}");
    }
    let job = one(&r, CheckId::PrivilegeEscalation, "job");
    assert!(job.fix.is_none() && job.evidence.last().unwrap().contains("만든 뒤에 바꿀 수 없어요"), "{:?}", job.evidence);
    let esc = one(&r, CheckId::PrivilegeEscalation, "esc").fix.as_ref().unwrap();
    let spec = &esc.object["spec"]["template"]["spec"];
    assert_eq!(spec["containers"], json!([{ "name": "app", "securityContext": { "allowPrivilegeEscalation": false } }]), "false로 정한 side는 건드리지 않는다");
    assert_eq!(spec["initContainers"], json!([{ "name": "init", "securityContext": { "allowPrivilegeEscalation": false } }]));

    // request·limit·probe·이미지
    assert!(!absent(&r, CheckId::ResourcesMissing, "bare") && absent(&r, CheckId::ResourcesMissing, "clean"));
    assert!(!absent(&r, CheckId::ProbesMissing, "bare") && absent(&r, CheckId::ProbesMissing, "clean"));
    assert!(absent(&r, CheckId::ProbesMissing, "cron") && absent(&r, CheckId::ProbesMissing, "job"), "Job·CronJob은 probe를 보지 않는다");
    assert_eq!(names_in(&r, CheckId::ImageLatest, NS), ["bare"]);
    let image = one(&r, CheckId::ImageLatest, "bare");
    assert!(image.evidence.iter().any(|e| e.contains("untagged") && e.contains("태그 없음")) && image.evidence.iter().any(|e| e.contains("태그 latest")), "{:?}", image.evidence);

    // 모두 갖춘 워크로드에는 어떤 점검도 걸리지 않는다
    let clean: Vec<&Finding> = r.findings.iter().filter(|f| f.namespace.as_deref() == Some(NS) && name_of(f) == "clean").collect();
    assert!(clean.is_empty(), "{clean:?}");
}

#[tokio::test]
#[ignore]
async fn default_service_account_and_network_policy_findings() {
    let r = report_with(&admin().await).await;

    // 아무 권한도 없는 default ServiceAccount는 고칠 수 있고, 다른 권한이 붙은 것은 고치지 않는다
    let plain = one_in(&r, CheckId::SaTokenAutomount, NS);
    assert_eq!(plain.severity, Severity::Low);
    assert!(plain.evidence.iter().any(|e| e == "쓰는 워크로드: Deployment priv"), "{:?}", plain.evidence);
    assert_eq!(plain.fix.as_ref().unwrap().object["automountServiceAccountToken"], json!(false));
    let bound = one_in(&r, CheckId::SaTokenAutomount, "mm-sec-bound");
    assert_eq!(bound.severity, Severity::Medium);
    assert!(bound.fix.is_none());
    assert!(names_in(&r, CheckId::SaTokenAutomount, "mm-sec-guarded").is_empty(), "Pod가 토큰 마운트를 껐다");

    // NetworkPolicy: 정책이 없는 네임스페이스만(워크로드가 있으면 중간)
    assert_eq!(one(&r, CheckId::NoNetworkPolicy, NS).severity, Severity::Medium);
    assert!(absent(&r, CheckId::NoNetworkPolicy, "mm-sec-guarded"));
    let system = one(&r, CheckId::NoNetworkPolicy, "kube-system");
    assert!(system.system, "시스템 네임스페이스는 기본 제외 대상으로 표시된다");
}

fn one_in<'a>(r: &'a Report, check: CheckId, namespace: &str) -> &'a Finding {
    let found: Vec<&Finding> = r.findings.iter().filter(|f| f.check == check && f.namespace.as_deref() == Some(namespace)).collect();
    assert_eq!(found.len(), 1, "{check:?} {namespace}: {found:?}");
    found[0]
}

#[tokio::test]
#[ignore]
async fn permission_findings_match_the_rbac_fixture() {
    let r = report_with(&admin().await).await;

    // 모든 권한: 클러스터 전체, 네임스페이스 안, 강한 ServiceAccount. system:masters 그룹은 기본 구성이라 낮음
    assert_eq!(one(&r, CheckId::AdminSubject, "mm-sec-alice").severity, Severity::High);
    let bob = one(&r, CheckId::AdminSubject, "mm-sec-bob");
    assert_eq!((bob.severity, bob.namespace.as_deref()), (Severity::Medium, Some(NS)));
    assert_eq!(one(&r, CheckId::AdminSubject, "runner").severity, Severity::High);
    assert_eq!(one(&r, CheckId::AdminSubject, "system:masters").severity, Severity::Low);
    assert!(absent(&r, CheckId::AdminSubject, "mm-sec-carol") && absent(&r, CheckId::AdminSubject, "mm-sec-dave"));

    // 권한 상승 경로는 관리자가 아닌 주체에게만(carol이 넷 모두)
    for check in [CheckId::EscalateBind, CheckId::Impersonate, CheckId::NodesProxy, CheckId::SecretsReadAll] {
        let f = one(&r, check, "mm-sec-carol");
        assert_eq!(f.severity, Severity::High, "{check:?}");
        assert!(f.evidence[0].contains("ClusterRoleBinding mm-sec-carol → ClusterRole mm-sec-esc"), "{check:?}: {:?}", f.evidence);
        assert!(absent(&r, check, "mm-sec-alice"), "관리자는 상승 경로로 따로 세지 않는다: {check:?}");
    }

    // Pod를 만들 수 있는 사용자 + 같은 네임스페이스의 강한 ServiceAccount(runner)
    let pod_create: Vec<&str> = r.findings.iter().filter(|f| f.check == CheckId::PodCreateStrongSa && name_of(f).starts_with("mm-sec-")).map(name_of).collect();
    assert_eq!(pod_create, ["mm-sec-dave"], "읽기만 하는 erin과 네임스페이스 관리자 bob은 아니다");
    assert!(one(&r, CheckId::PodCreateStrongSa, "mm-sec-dave").evidence[0].contains("mm-sec/runner(클러스터 전체 모든 권한)"));

    // 익명·인증된 모든 주체: 기본 구성(system:public-info-viewer 등)은 나오지 않는다
    assert_eq!(one(&r, CheckId::AnonymousAccess, "mm-sec-peek-anon").severity, Severity::High);
    let everyone = one(&r, CheckId::AnonymousAccess, "mm-sec-everyone");
    assert_eq!((everyone.severity, everyone.namespace.as_deref()), (Severity::Medium, Some(NS)));
    let builtin: Vec<&str> = r.findings.iter().filter(|f| f.check == CheckId::AnonymousAccess && name_of(f).starts_with("system:")).map(name_of).collect();
    assert!(builtin.is_empty(), "{builtin:?}");

    // 안 쓰는 역할(쓰이는 것과 기본 역할은 빠진다), 없는 역할·없는 ServiceAccount를 가리키는 바인딩
    let unused: Vec<&str> = r.findings.iter().filter(|f| f.check == CheckId::UnusedRole && name_of(f).contains("mm-sec")).map(name_of).collect();
    assert_eq!(unused.len(), 1, "{unused:?}");
    assert_eq!(unused, ["mm-sec-unused"]);
    assert_eq!(names_in(&r, CheckId::UnusedRole, NS), ["unused-role"]);
    for builtin in ["cluster-admin", "edit", "view", "admin"] {
        assert!(absent(&r, CheckId::UnusedRole, builtin), "{builtin}");
    }
    assert!(absent(&r, CheckId::UnusedRole, "mm-sec-esc") && absent(&r, CheckId::UnusedRole, "mm-sec-peek"));
    assert_eq!(names_in(&r, CheckId::BindingMissingRole, NS), ["ghost-role"]);
    assert!(!absent(&r, CheckId::BindingMissingRole, "mm-sec-ghost-cluster"));
    let ghost = one(&r, CheckId::BindingMissingSubject, "ghost-sa");
    assert_eq!(ghost.severity, Severity::Medium);
    assert!(ghost.message.contains("mm-sec/ghost"), "{}", ghost.message);
}

#[tokio::test]
#[ignore]
async fn without_aws_the_cluster_checks_are_skipped_and_the_kubernetes_ones_still_run() {
    let r = report_with(&admin().await).await;
    let sections: Vec<Section> = r.gaps.iter().filter(|g| !g.partial).map(|g| g.section).collect();
    for expected in [Section::Cluster, Section::Versions, Section::AwsAuth, Section::AccessEntries, Section::Nodegroups] {
        assert!(sections.contains(&expected), "{expected:?} ∉ {sections:?}");
    }
    for k8s in [Section::Rbac, Section::Namespaces, Section::ServiceAccounts, Section::Deployments, Section::Pods, Section::NetworkPolicies, Section::Nodes] {
        assert!(!sections.contains(&k8s), "{k8s:?}은 읽혀야 해요: {:?}", r.gaps);
    }
    assert!(r.gaps.iter().all(|g| g.error == AppError::other(NO_AWS)), "{:?}", r.gaps);
    for id in [CheckId::ClusterPublicEndpoint, CheckId::ClusterLoggingOff, CheckId::ClusterSecretsPlain, CheckId::ClusterVersionSupport, CheckId::ClusterAwsAuth, CheckId::ClusterCreatorAdmin] {
        assert!(r.skipped.contains(&id), "{id:?}");
    }
    // kind 노드는 EC2 인스턴스가 아니라서 IMDS는 읽을 것이 없고, 문제도 없다
    assert!(!r.skipped.contains(&CheckId::ImdsHopLimit) && !r.findings.iter().any(|f| f.check == CheckId::ImdsHopLimit));
    assert!(r.findings.iter().any(|f| f.check == CheckId::Privileged));
    // 같은 읽기는 같은 결과(id가 겹치지 않고 순서가 정해져 있다)
    let mut ids: Vec<&str> = r.findings.iter().map(|f| f.id.as_str()).collect();
    let total = ids.len();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), total);
}

#[tokio::test]
#[ignore]
async fn a_reader_without_cluster_wide_access_gets_gaps_and_skipped_checks_not_a_failure() {
    let (context, value) = reader_config();
    let client = client_for(&build(&value), &context, PRIVATE).await.unwrap();
    let r = report_with(&client).await;
    assert!(r.findings.is_empty(), "{:?}", r.findings);
    assert_eq!(r.skipped.len(), CheckId::ALL.len(), "모든 항목을 점검하지 못한다: {:?}", r.skipped);
    for section in [Section::Rbac, Section::Namespaces, Section::ServiceAccounts, Section::Deployments, Section::StatefulSets, Section::DaemonSets, Section::Jobs, Section::CronJobs, Section::Pods, Section::NetworkPolicies, Section::Nodes] {
        let gap = r.gaps.iter().find(|g| g.section == section).unwrap_or_else(|| panic!("{section:?} gap이 없어요: {:?}", r.gaps));
        assert!(matches!(gap.error, AppError::AccessDenied { .. }), "{section:?}: {:?}", gap.error);
    }
}

fn change(target: &Finding, force: bool) -> Change {
    let fix = target.fix.as_ref().expect("고칠 수 있는 항목");
    Change { target: ChangeObject { kind: fix.kind.clone(), namespace: fix.namespace.clone(), name: fix.name.clone() }, operation: Operation::Apply { object: fix.object.clone(), force } }
}

async fn live(client: &kube::Client, f: &Finding) -> Value {
    let fix = f.fix.as_ref().unwrap();
    let target = ChangeObject { kind: fix.kind.clone(), namespace: fix.namespace.clone(), name: fix.name.clone() };
    commit::current(client.clone(), PRIVATE, &target).await.unwrap().expect("객체가 있어요")
}

/// 이 시험은 스크립트가 만든 kind 클러스터의 mm-sec-fix 객체에만 쓰기 요청을 보낸다(다른 시험이 읽는 객체는 건드리지 않는다).
#[tokio::test]
#[ignore]
async fn a_fix_previews_through_server_dry_run_and_applies_only_the_changed_fields() {
    let client = admin().await;
    let r = report_with(&client).await;

    // Deployment: 미리보기는 서버 dry-run이라 객체가 그대로고, 바뀌는 필드는 컨테이너의 allowPrivilegeEscalation 둘뿐이다
    let esc = one(&r, CheckId::PrivilegeEscalation, "fix-esc").clone();
    let before = live(&client, &esc).await;
    let applied = change(&esc, false);
    let plan = commit::dry_plan(client.clone(), PRIVATE, &applied, "").await.unwrap();
    let mut paths: Vec<&str> = plan.preview.diff.iter().map(|d| d.path.as_str()).collect();
    paths.sort();
    assert_eq!(
        paths,
        ["spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation", "spec.template.spec.initContainers[0].securityContext.allowPrivilegeEscalation"],
        "{:?}",
        plan.preview.diff
    );
    assert!(plan.preview.diff.iter().all(|d| d.before.is_null() && d.after == json!(false)));
    assert!(plan.preview.conflicts.is_empty(), "{:?}", plan.preview.conflicts);
    assert!(plan.inverse.is_some(), "되돌릴 수 있다");
    assert_eq!(live(&client, &esc).await["metadata"]["resourceVersion"], before["metadata"]["resourceVersion"], "dry-run은 쓰지 않아요");

    // 적용하면 그 필드만 바뀌고(다른 컨테이너 설정과 replicas는 그대로), 다시 점검하면 그 항목이 사라진다
    let (_, result) = commit::apply_plan(client.clone(), PRIVATE, &applied, &plan, "", None).await.unwrap();
    result.unwrap();
    let after = live(&client, &esc).await;
    let containers = after["spec"]["template"]["spec"]["containers"].as_array().unwrap();
    assert_eq!(containers[0]["securityContext"], json!({ "runAsNonRoot": true, "runAsUser": 1000, "allowPrivilegeEscalation": false }));
    assert_eq!(containers[1]["securityContext"], before["spec"]["template"]["spec"]["containers"][1]["securityContext"]);
    assert_eq!(after["spec"]["replicas"], before["spec"]["replicas"]);
    let managers: Vec<&str> = after["metadata"]["managedFields"].as_array().unwrap().iter().filter_map(|m| m["manager"].as_str()).collect();
    assert!(managers.contains(&"magic-mirror"), "{managers:?}");
    let again = report_with(&client).await;
    assert!(absent(&again, CheckId::PrivilegeEscalation, "fix-esc"));
    // 다른 워크로드의 같은 문제는 그대로다
    assert!(!absent(&again, CheckId::PrivilegeEscalation, "host"));

    // CronJob은 Job 템플릿 안의 컨테이너를 고친다
    let cron = one(&r, CheckId::PrivilegeEscalation, "fix-cron").clone();
    let plan = commit::dry_plan(client.clone(), PRIVATE, &change(&cron, false), "").await.unwrap();
    assert_eq!(plan.preview.diff.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), ["spec.jobTemplate.spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation"]);

    // default ServiceAccount: 미리보기 뒤 적용하면 점검에서 사라지고, 되돌리기 변경이 만들어진다
    let sa = one_in(&r, CheckId::SaTokenAutomount, "mm-sec-fix").clone();
    let plan = commit::dry_plan(client.clone(), PRIVATE, &change(&sa, false), "").await.unwrap();
    assert_eq!(plan.preview.diff.iter().map(|d| (d.path.as_str(), d.after.clone())).collect::<Vec<_>>(), [("automountServiceAccountToken", json!(false))]);
    assert!(plan.preview.confirm_name.is_none(), "mm-sec-fix는 위험한 네임스페이스가 아니다");
    let (_, result) = commit::apply_plan(client.clone(), PRIVATE, &change(&sa, false), &plan, "", None).await.unwrap();
    result.unwrap();
    assert_eq!(live(&client, &sa).await["automountServiceAccountToken"], json!(false));
    let again = report_with(&client).await;
    assert!(names_in(&again, CheckId::SaTokenAutomount, "mm-sec-fix").is_empty());
}
