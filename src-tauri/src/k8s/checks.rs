//! 보안 점검(K5): 클러스터·권한·워크로드를 읽어 온 값(`Inputs`)에서 찾은 문제(`Finding`)를 계산한다.
//! - `cluster`, `permissions`, `workloads`, `nodes`: 항목별 순수 함수. 읽지 못한 입력은 호출하지 않는다.
//! - `fix`: 안전하게 자동으로 고칠 수 있는 항목의 변경(server-side apply 본문)을 만든다. 적용은 변경 공통 틀(`k8s_preview`/`k8s_apply`)이 한다.
//! - `read`: 쿠버네티스·EKS·EC2에서 읽기. 읽지 못한 부분은 `gaps`에 남고 나머지 점검은 그대로 돈다.
//!
//! 권한 점검은 접근 화면(K4)의 실효 권한 엔진(`access::engine`)이 계산한 `Grant`를 그대로 쓴다. RBAC 평가를 다시 구현하지 않는다.
use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::PodSpec;
use serde::Serialize;
use serde_json::Value;

use crate::error::AppError;
use crate::k8s::access::engine::Evaluation;
use crate::k8s::access::rbac::Subject;
use crate::k8s::rows::KindRef;

pub mod cluster;
pub mod fix;
pub mod nodes;
pub mod permissions;
pub mod read;
pub mod versions;
pub mod workloads;

pub use crate::k8s::network::policy::is_system_namespace;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Cluster,
    Permissions,
    Workloads,
}

/// 점검 항목. 이름은 프론트 `src/k8s/security/text.ts`의 `CHECKS`와 같다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckId {
    ClusterPublicEndpoint,
    ClusterLoggingOff,
    ClusterSecretsPlain,
    ClusterVersionSupport,
    ClusterAwsAuth,
    ClusterCreatorAdmin,
    AdminSubject,
    AnonymousAccess,
    EscalateBind,
    Impersonate,
    PodCreateStrongSa,
    NodesProxy,
    SecretsReadAll,
    UnusedRole,
    BindingMissingRole,
    BindingMissingSubject,
    Privileged,
    HostPath,
    HostNetwork,
    HostPid,
    RunsAsRoot,
    PrivilegeEscalation,
    ResourcesMissing,
    ProbesMissing,
    ImageLatest,
    SaTokenAutomount,
    NoNetworkPolicy,
    ImdsHopLimit,
}

impl CheckId {
    pub const ALL: [CheckId; 28] = [
        CheckId::ClusterPublicEndpoint,
        CheckId::ClusterLoggingOff,
        CheckId::ClusterSecretsPlain,
        CheckId::ClusterVersionSupport,
        CheckId::ClusterAwsAuth,
        CheckId::ClusterCreatorAdmin,
        CheckId::AdminSubject,
        CheckId::AnonymousAccess,
        CheckId::EscalateBind,
        CheckId::Impersonate,
        CheckId::PodCreateStrongSa,
        CheckId::NodesProxy,
        CheckId::SecretsReadAll,
        CheckId::UnusedRole,
        CheckId::BindingMissingRole,
        CheckId::BindingMissingSubject,
        CheckId::Privileged,
        CheckId::HostPath,
        CheckId::HostNetwork,
        CheckId::HostPid,
        CheckId::RunsAsRoot,
        CheckId::PrivilegeEscalation,
        CheckId::ResourcesMissing,
        CheckId::ProbesMissing,
        CheckId::ImageLatest,
        CheckId::SaTokenAutomount,
        CheckId::NoNetworkPolicy,
        CheckId::ImdsHopLimit,
    ];

    pub fn category(self) -> Category {
        use CheckId::*;
        match self {
            ClusterPublicEndpoint | ClusterLoggingOff | ClusterSecretsPlain | ClusterVersionSupport | ClusterAwsAuth | ClusterCreatorAdmin => Category::Cluster,
            AdminSubject | AnonymousAccess | EscalateBind | Impersonate | PodCreateStrongSa | NodesProxy | SecretsReadAll | UnusedRole | BindingMissingRole
            | BindingMissingSubject => Category::Permissions,
            Privileged | HostPath | HostNetwork | HostPid | RunsAsRoot | PrivilegeEscalation | ResourcesMissing | ProbesMissing | ImageLatest | SaTokenAutomount
            | NoNetworkPolicy | ImdsHopLimit => Category::Workloads,
        }
    }

    /// 기록과 id에 쓰는 이름(직렬화와 같다)
    pub fn name(self) -> String {
        serde_json::to_value(self).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
    }
}

/// 문제가 가리키는 곳
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Target {
    /// 클러스터 안의 객체(워크로드 화면에서 연다)
    #[serde(rename_all = "camelCase")]
    Object { kind: KindRef, namespace: Option<String>, name: String },
    /// RBAC 주체(사용자·그룹·ServiceAccount·IAM 주체)
    Subject { subject: Subject },
    /// AWS 리소스. `resource`는 `cluster`, `nodegroup`, `nodepool`, `instance`, `accessEntry`
    #[serde(rename_all = "camelCase")]
    Aws { resource: String, name: String },
}

impl Target {
    fn key(&self) -> String {
        match self {
            Target::Object { kind, namespace, name } => format!("{}/{}/{}/{}", kind.group, kind.kind, namespace.as_deref().unwrap_or(""), name),
            Target::Subject { subject } => subject.key(),
            Target::Aws { resource, name } => format!("aws:{resource}/{name}"),
        }
    }
}

/// 자동으로 고치는 방법. 화면은 `object`를 `apply` 변경(server-side apply)으로 미리보기에 넘긴다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fix {
    /// 무엇을 바꾸는지 한 줄
    pub summary: String,
    /// 적용 전에 알아야 할 것(롤아웃, 다른 도구가 되돌릴 수 있음 등)
    pub caution: Option<String>,
    pub kind: KindRef,
    pub namespace: Option<String>,
    pub name: String,
    /// 적용할 부분 객체. 바꾸는 필드만 담는다.
    pub object: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// 목록 선택과 열린 상세를 알아보는 값. 같은 점검과 같은 대상은 같은 id다.
    pub id: String,
    pub check: CheckId,
    pub severity: Severity,
    pub target: Target,
    /// 시스템 네임스페이스 제외에 쓰는 네임스페이스(대상이나 문제가 있는 곳)
    pub namespace: Option<String>,
    /// `namespace`가 시스템 네임스페이스(`kube-system`, `amazon-*` …)
    pub system: bool,
    pub message: String,
    pub evidence: Vec<String>,
    pub fix: Option<Fix>,
}

impl Finding {
    pub fn new(check: CheckId, severity: Severity, target: Target, namespace: Option<String>, message: impl Into<String>, evidence: Vec<String>) -> Finding {
        let system = namespace.as_deref().is_some_and(is_system_namespace);
        Finding { id: format!("{}|{}", check.name(), target.key()), check, severity, target, namespace, system, message: message.into(), evidence, fix: None }
    }

    pub fn with_fix(mut self, fix: Option<Fix>) -> Finding {
        self.fix = fix;
        self
    }
}

/// 읽는 부분. 읽지 못한 부분과 그 이유를 `Gap`으로 알린다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Section {
    Cluster,
    Versions,
    AccessEntries,
    AwsAuth,
    Rbac,
    Namespaces,
    ServiceAccounts,
    Deployments,
    StatefulSets,
    DaemonSets,
    Jobs,
    CronJobs,
    Pods,
    NetworkPolicies,
    Nodes,
    Nodegroups,
    LaunchTemplates,
    Instances,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub section: Section,
    /// 어떤 항목에서(노드그룹 이름 등). 부분 실패일 때만
    pub subject: Option<String>,
    pub error: AppError,
    /// 목록이 쪽 한도에서 잘려 일부만 점검했다(오류가 아니라 불완전)
    pub partial: bool,
}

/// 점검 결과 한 장
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// 심각도 높은 순, 같으면 항목 순서
    pub findings: Vec<Finding>,
    /// 입력을 읽지 못해 점검하지 못한 항목
    pub skipped: Vec<CheckId>,
    pub gaps: Vec<Gap>,
    pub fetched_at: String,
}

/// ServiceAccount 하나. `bound`는 기본 그룹 말고 다른 권한이 이 ServiceAccount에 붙어 있는지(알 수 없으면 None).
#[derive(Debug, Clone, PartialEq)]
pub struct SaFacts {
    pub namespace: String,
    pub name: String,
    pub automount: Option<bool>,
    pub bound: Option<bool>,
}

/// 워크로드 종류. Pod 템플릿을 가진 객체와 컨트롤러가 없는 Pod.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WorkloadKind {
    Deployment,
    StatefulSet,
    DaemonSet,
    Job,
    CronJob,
    Pod,
}

/// 읽은 워크로드 하나(Pod 템플릿 기준). 컨트롤러가 만든 Pod는 컨트롤러에서 한 번만 본다.
#[derive(Debug, Clone, PartialEq)]
pub struct Workload {
    pub kind: WorkloadKind,
    pub namespace: String,
    pub name: String,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub spec: PodSpec,
}

/// 읽은 워크로드 전부와 종류마다 읽지 못한 이유
#[derive(Debug, Default)]
pub struct WorkloadInputs {
    pub items: Vec<Workload>,
    pub errors: Vec<(Section, AppError)>,
    /// 쪽 한도에서 잘려 일부만 읽은 종류
    pub truncated: Vec<Section>,
}

/// 노드그룹 시작 템플릿의 IMDS 설정
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchTemplateImds {
    /// 화면에 보일 이름(`lt-0abc v3`)
    pub label: String,
    pub hop_limit: Option<i32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NodegroupImds {
    pub name: String,
    pub launch_template: Option<LaunchTemplateImds>,
}

/// 노드 하나의 IMDS 설정(인스턴스에서 읽은 값)
#[derive(Debug, Clone, PartialEq)]
pub struct NodeImds {
    pub name: String,
    pub instance_id: String,
    /// 관리형 노드그룹 레이블 `eks.amazonaws.com/nodegroup`
    pub nodegroup: Option<String>,
    /// Karpenter 레이블 `karpenter.sh/nodepool`
    pub nodepool: Option<String>,
    pub hop_limit: Option<i32>,
}

#[derive(Debug)]
pub struct ImdsInputs {
    pub nodegroups: Result<Vec<NodegroupImds>, AppError>,
    pub nodes: Result<Vec<NodeImds>, AppError>,
}

/// 클러스터 설정(`DescribeCluster`)에서 점검에 쓰는 값
#[derive(Debug, Clone, PartialEq)]
pub struct ClusterFacts {
    pub name: String,
    pub version: String,
    pub endpoint_public: bool,
    pub endpoint_private: bool,
    pub public_cidrs: Vec<String>,
    /// 켜진 컨트롤 플레인 로그 유형
    pub logging_enabled: Vec<String>,
    pub secrets_encrypted: bool,
    /// 만든 시각(epoch 초)
    pub created_at: Option<i64>,
}

/// 표준 지원 종료일. API 값을 우선하고 없으면 코드의 고정 표(`versions`)를 쓴다.
#[derive(Debug, Clone, PartialEq)]
pub struct VersionSupport {
    pub version: String,
    /// epoch 초
    pub end_of_standard_support: Option<i64>,
}

/// 쓰이는 aws-auth 매핑 하나
#[derive(Debug, Clone, PartialEq)]
pub struct AwsAuthUse {
    pub arn: String,
    pub groups: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AwsAuthFacts {
    /// `DescribeCluster`의 인증 모드 원문(없으면 `CONFIG_MAP`으로 본다)
    pub mode: Option<String>,
    /// 인증 모드와 우선순위를 따졌을 때 실제로 쓰이는 매핑
    pub entries: Vec<AwsAuthUse>,
}

/// 생성자 관리자(bootstrap) 후보: 클러스터 전체 범위의 `AmazonEKSClusterAdminPolicy`가 붙은 access entry
#[derive(Debug, Clone, PartialEq)]
pub struct AdminEntry {
    pub principal_arn: String,
    /// access entry를 만든 시각(epoch 초). 읽지 못하면 None
    pub created_at: Option<i64>,
}

/// 점검 입력 전부. 읽지 못한 것은 `Err`이고, 그 입력이 필요한 점검은 건너뛴다.
pub struct Inputs {
    /// 지금 시각(epoch 초)
    pub now: i64,
    pub cluster: Result<ClusterFacts, AppError>,
    pub versions: Result<Vec<VersionSupport>, AppError>,
    pub aws_auth: Result<AwsAuthFacts, AppError>,
    pub admin_entries: Result<Vec<AdminEntry>, AppError>,
    pub eval: Result<Evaluation, AppError>,
    /// ServiceAccount 목록과 쪽 한도에서 잘렸는지
    pub service_accounts: Result<(Vec<SaFacts>, bool), AppError>,
    pub namespaces: Result<Vec<String>, AppError>,
    pub workloads: WorkloadInputs,
    /// NetworkPolicy가 있는 네임스페이스(정책마다 하나씩)
    pub policies: Result<Vec<String>, AppError>,
    pub imds: ImdsInputs,
    /// 읽는 중 일부만 실패한 것(노드그룹 하나의 시작 템플릿 등)
    pub gaps: Vec<Gap>,
}

fn gap_of<T>(r: &Result<T, AppError>, section: Section, gaps: &mut Vec<Gap>) -> bool {
    match r {
        Ok(_) => true,
        Err(error) => {
            gaps.push(Gap { section, subject: None, error: error.clone(), partial: false });
            false
        }
    }
}

const ALL_WORKLOAD_SECTIONS: [Section; 6] = [Section::Deployments, Section::StatefulSets, Section::DaemonSets, Section::Jobs, Section::CronJobs, Section::Pods];

/// 입력 전체를 점검해 결과 한 장을 만든다. `fetched_at`은 화면에 보일 읽은 시각.
pub fn run(inputs: Inputs, fetched_at: &str) -> Report {
    use CheckId::*;
    let mut gaps = Vec::new();
    gap_of(&inputs.cluster, Section::Cluster, &mut gaps);
    // 버전 표는 읽지 못해도 고정 표로 이어 간다. 이유만 남긴다
    gap_of(&inputs.versions, Section::Versions, &mut gaps);
    gap_of(&inputs.aws_auth, Section::AwsAuth, &mut gaps);
    gap_of(&inputs.admin_entries, Section::AccessEntries, &mut gaps);
    let rbac_ok = gap_of(&inputs.eval, Section::Rbac, &mut gaps);
    let sas_ok = gap_of(&inputs.service_accounts, Section::ServiceAccounts, &mut gaps);
    let ns_ok = gap_of(&inputs.namespaces, Section::Namespaces, &mut gaps);
    let policies_ok = gap_of(&inputs.policies, Section::NetworkPolicies, &mut gaps);
    let nodegroups_ok = gap_of(&inputs.imds.nodegroups, Section::Nodegroups, &mut gaps);
    let nodes_ok = gap_of(&inputs.imds.nodes, Section::Nodes, &mut gaps);
    for (section, error) in &inputs.workloads.errors {
        gaps.push(Gap { section: *section, subject: None, error: error.clone(), partial: false });
    }
    for section in &inputs.workloads.truncated {
        gaps.push(Gap { section: *section, subject: None, error: AppError::other(workloads::TRUNCATED), partial: true });
    }
    if let Ok((_, true)) = &inputs.service_accounts {
        gaps.push(Gap { section: Section::ServiceAccounts, subject: None, error: AppError::other(workloads::TRUNCATED), partial: true });
    }
    gaps.extend(inputs.gaps.iter().cloned());

    let mut findings: Vec<Finding> = Vec::new();
    let mut skipped: Vec<CheckId> = Vec::new();

    if let Ok(c) = &inputs.cluster {
        findings.extend(cluster::check_cluster(c, &inputs.versions, inputs.now));
    } else {
        skipped.extend([ClusterPublicEndpoint, ClusterLoggingOff, ClusterSecretsPlain, ClusterVersionSupport]);
    }
    match &inputs.aws_auth {
        Ok(a) => findings.extend(cluster::check_aws_auth(a)),
        Err(_) => skipped.push(ClusterAwsAuth),
    }
    match (&inputs.cluster, &inputs.admin_entries) {
        (Ok(c), Ok(entries)) => findings.extend(cluster::check_creator_admin(c, entries)),
        _ => skipped.push(ClusterCreatorAdmin),
    }

    let bound = match &inputs.eval {
        Ok(eval) => permissions::bound_service_accounts(eval),
        Err(_) => Default::default(),
    };
    let sas: Option<Vec<SaFacts>> = inputs.service_accounts.as_ref().ok().map(|(list, _)| {
        list.iter()
            .map(|s| SaFacts { bound: rbac_ok.then(|| bound.contains(&(s.namespace.clone(), s.name.clone()))), ..s.clone() })
            .collect()
    });
    match &inputs.eval {
        Ok(eval) => {
            let truncated = matches!(&inputs.service_accounts, Ok((_, true)));
            findings.extend(permissions::check_permissions(eval, sas.as_deref().filter(|_| !truncated)));
            if !sas_ok || truncated {
                skipped.push(BindingMissingSubject);
            }
        }
        Err(_) => skipped.extend([AdminSubject, AnonymousAccess, EscalateBind, Impersonate, PodCreateStrongSa, NodesProxy, SecretsReadAll, UnusedRole, BindingMissingRole, BindingMissingSubject]),
    }

    let workloads_failed = ALL_WORKLOAD_SECTIONS.iter().all(|s| inputs.workloads.errors.iter().any(|(e, _)| e == s));
    if workloads_failed {
        skipped.extend([Privileged, HostPath, HostNetwork, HostPid, RunsAsRoot, PrivilegeEscalation, ResourcesMissing, ProbesMissing, ImageLatest]);
    } else {
        findings.extend(workloads::check_workloads(&inputs.workloads.items));
    }
    if sas_ok && !workloads_failed {
        findings.extend(workloads::check_default_sa(&inputs.workloads.items, sas.as_deref().unwrap_or_default()));
    } else {
        skipped.push(SaTokenAutomount);
    }
    if ns_ok && policies_ok {
        findings.extend(workloads::check_network_policies(
            inputs.namespaces.as_deref().unwrap_or_default(),
            inputs.policies.as_deref().unwrap_or_default(),
            &inputs.workloads.items,
        ));
    } else {
        skipped.push(NoNetworkPolicy);
    }
    if nodegroups_ok || nodes_ok {
        findings.extend(nodes::check_imds(inputs.imds.nodegroups.as_deref().ok(), inputs.imds.nodes.as_deref().ok()));
    } else {
        skipped.push(ImdsHopLimit);
    }

    findings.sort_by(|a, b| {
        b.severity
            .cmp(&a.severity)
            .then(a.check.cmp(&b.check))
            .then(a.namespace.cmp(&b.namespace))
            .then(a.id.cmp(&b.id))
    });
    skipped.sort();
    skipped.dedup();
    Report { findings, skipped, gaps, fetched_at: fetched_at.to_string() }
}

#[cfg(test)]
mod mock_aws;
#[cfg(test)]
mod testkit;
#[cfg(test)]
mod tests;
