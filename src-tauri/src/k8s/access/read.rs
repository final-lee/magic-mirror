//! 접근 화면이 쓰는 읽기: RBAC 객체, aws-auth, 네임스페이스(쿠버네티스 GET·LIST만)와 EKS access entry·Pod Identity·IAM 역할 신뢰 정책(Describe·List·Get만).
//! 출처마다 실패는 `Gap`에 담고 나머지는 그대로 쓴다. 가져온 것을 맞추는 `assemble`은 순수 함수다.
use std::collections::{HashMap, HashSet};
use std::fmt::Debug;

use aws_sdk_eks::Client as Eks;
use aws_sdk_iam::Client as Iam;
use futures::stream::{self, StreamExt};
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Pod, ServiceAccount};
use k8s_openapi::api::rbac::v1 as rbac_v1;
use kube::api::{Api, ListParams};
use kube::{Client, Resource};
use serde::de::DeserializeOwned;
use serde::Serialize;

use super::engine::PolicyScope;
use super::identity::{parse_aws_auth, parse_mode, resolve, AuthMode, AwsAuth, EntryInput, IdentityMapping};
use super::rbac::{binding_of, cluster_binding_of, cluster_role_of, role_of, Rbac};
use super::workload::{assemble as assemble_workloads, role_name, Association, PodInfo, SaInfo, TrustText, WorkloadIdentity};
use crate::error::{from_sdk, AppError};
use crate::iam::policy::decode_document;
use crate::k8s::failure::Endpoint;
use crate::k8s::read::eks::{call, describe, ClusterView, PAGES_MAX};
use crate::k8s::read::overview::RUNNING_PODS;
use crate::k8s::read::bounded;
use crate::k8s::watch::PAGE_SIZE;

/// 한꺼번에 보내는 EKS·IAM 요청 수
const CONCURRENCY: usize = 8;
/// RBAC 객체와 ServiceAccount를 읽는 쪽 수(쪽당 500개)
const PAGES: usize = 40;
const RBAC_TRUNCATED: &str = "RBAC 객체가 너무 많아 끝까지 읽지 못했어요";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Section {
    Cluster,
    AccessEntries,
    AwsAuth,
    Rbac,
    Namespaces,
    ServiceAccounts,
    Pods,
    PodIdentity,
    IamRoles,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub section: Section,
    pub error: AppError,
}

fn keep<T>(r: Result<T, AppError>, section: Section, gaps: &mut Vec<Gap>) -> Option<T> {
    match r {
        Ok(v) => Some(v),
        Err(error) => {
            gaps.push(Gap { section, error });
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsAuthSummary {
    pub present: bool,
    pub accounts: Vec<String>,
    pub errors: Vec<String>,
}

pub struct Parts {
    pub cluster: Result<ClusterView, AppError>,
    pub entries: Result<Vec<EntryInput>, AppError>,
    pub aws_auth: Result<Option<AwsAuth>, AppError>,
    pub rbac: Result<Rbac, AppError>,
    pub namespaces: Result<Vec<String>, AppError>,
}

pub struct Loaded {
    pub rbac: Option<Rbac>,
    /// `rbac`를 읽었는지(`rbac`를 꺼내 간 뒤에도 남는다)
    pub rbac_available: bool,
    pub mappings: Vec<IdentityMapping>,
    /// 인증 모드를 읽지 못하면 None(둘 다 유효하다고 보고 계산한다)
    pub mode: Option<AuthMode>,
    pub mode_raw: Option<String>,
    pub aws_auth: AwsAuthSummary,
    pub namespaces: Vec<String>,
    pub gaps: Vec<Gap>,
}

pub fn assemble(parts: Parts) -> Loaded {
    let mut gaps = Vec::new();
    let cluster = keep(parts.cluster, Section::Cluster, &mut gaps);
    let mode_raw = cluster.as_ref().and_then(|c| c.authentication_mode.clone());
    let mode = cluster.as_ref().map(|c| parse_mode(c.authentication_mode.as_deref()));
    let entries = keep(parts.entries, Section::AccessEntries, &mut gaps).unwrap_or_default();
    let aws_auth = keep(parts.aws_auth, Section::AwsAuth, &mut gaps).flatten();
    let rbac = keep(parts.rbac, Section::Rbac, &mut gaps);
    let namespaces = keep(parts.namespaces, Section::Namespaces, &mut gaps).unwrap_or_default();
    let mappings = resolve(mode.unwrap_or(AuthMode::ApiAndConfigMap), &entries, aws_auth.as_ref());
    let summary = AwsAuthSummary {
        present: aws_auth.is_some(),
        accounts: aws_auth.as_ref().map(|a| a.accounts.clone()).unwrap_or_default(),
        errors: aws_auth.as_ref().map(|a| a.errors.clone()).unwrap_or_default(),
    };
    Loaded { rbac_available: rbac.is_some(), rbac, mappings, mode, mode_raw, aws_auth: summary, namespaces, gaps }
}

/// 쪽을 넘기며 `PAGES`쪽까지 읽는다. 둘째 값은 한도에서 멈췄는지(뒤에 더 있음).
async fn list_typed<K>(client: &Client, lp: &ListParams, resource: &str, endpoint: Endpoint) -> Result<(Vec<K>, bool), AppError>
where
    K: Resource<DynamicType = ()> + Clone + DeserializeOwned + Debug,
{
    let api: Api<K> = Api::all(client.clone());
    let mut items = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..PAGES {
        let mut params = lp.clone().limit(PAGE_SIZE);
        if let Some(t) = &token {
            params = params.continue_token(t);
        }
        let page = bounded(api.list(&params), "list", resource, endpoint).await?;
        items.extend(page.items);
        token = page.metadata.continue_.filter(|c| !c.is_empty());
        if token.is_none() {
            return Ok((items, false));
        }
    }
    Ok((items, true))
}

pub async fn read_rbac(client: &Client, endpoint: Endpoint) -> Result<Rbac, AppError> {
    let lp = ListParams::default();
    let (roles, cluster_roles, bindings, cluster_bindings) = tokio::join!(
        list_typed::<rbac_v1::Role>(client, &lp, "roles", endpoint),
        list_typed::<rbac_v1::ClusterRole>(client, &lp, "clusterroles", endpoint),
        list_typed::<rbac_v1::RoleBinding>(client, &lp, "rolebindings", endpoint),
        list_typed::<rbac_v1::ClusterRoleBinding>(client, &lp, "clusterrolebindings", endpoint),
    );
    let (roles, cluster_roles, bindings, cluster_bindings) = (roles?, cluster_roles?, bindings?, cluster_bindings?);
    if roles.1 || cluster_roles.1 || bindings.1 || cluster_bindings.1 {
        return Err(AppError::other(RBAC_TRUNCATED));
    }
    Ok(Rbac {
        roles: roles.0.iter().map(role_of).collect(),
        cluster_roles: cluster_roles.0.iter().map(cluster_role_of).collect(),
        bindings: bindings.0.iter().filter_map(binding_of).collect(),
        cluster_bindings: cluster_bindings.0.iter().filter_map(cluster_binding_of).collect(),
    })
}

/// `kube-system/aws-auth`. 없으면 Ok(None)(오류가 아니다).
pub async fn read_aws_auth(client: &Client, endpoint: Endpoint) -> Result<Option<AwsAuth>, AppError> {
    let api: Api<ConfigMap> = Api::namespaced(client.clone(), "kube-system");
    let found = bounded(api.get_opt("aws-auth"), "get", "configmaps", endpoint).await?;
    Ok(found.map(|cm| parse_aws_auth(&cm.data.unwrap_or_default().into_iter().collect())))
}

pub async fn read_namespaces(client: &Client, endpoint: Endpoint) -> Result<Vec<String>, AppError> {
    let (items, _) = list_typed::<Namespace>(client, &ListParams::default(), "namespaces", endpoint).await?;
    let mut names: Vec<String> = items.into_iter().filter_map(|n| n.metadata.name).collect();
    names.sort();
    Ok(names)
}

fn scope_of(scope: Option<&aws_sdk_eks::types::AccessScope>) -> PolicyScope {
    match scope {
        Some(s) if s.r#type().is_some_and(|t| t.as_str() == "namespace") => PolicyScope::Namespaces { namespaces: s.namespaces().to_vec() },
        _ => PolicyScope::Cluster,
    }
}

async fn entry_of(eks: &Eks, cluster: &str, principal: &str) -> EntryInput {
    let described = call(eks.describe_access_entry().cluster_name(cluster).principal_arn(principal).send(), "eks:DescribeAccessEntry").await;
    let policies = read_policies(eks, cluster, principal).await;
    let mut entry = EntryInput { principal_arn: principal.to_string(), entry_type: None, username: None, groups: vec![], policies: vec![], read_error: None };
    match described {
        Ok(out) => {
            if let Some(e) = out.access_entry() {
                entry.entry_type = e.r#type().map(str::to_string);
                entry.username = e.username().map(str::to_string);
                entry.groups = e.kubernetes_groups().to_vec();
            }
        }
        Err(e) => entry.read_error = Some(e.to_string()),
    }
    match policies {
        Ok(list) => entry.policies = list,
        Err(e) => entry.read_error = entry.read_error.or_else(|| Some(e.to_string())),
    }
    entry
}

async fn read_policies(eks: &Eks, cluster: &str, principal: &str) -> Result<Vec<(String, PolicyScope)>, AppError> {
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..PAGES_MAX {
        let page = call(
            eks.list_associated_access_policies().cluster_name(cluster).principal_arn(principal).set_next_token(token.take()).send(),
            "eks:ListAssociatedAccessPolicies",
        )
        .await?;
        out.extend(page.associated_access_policies().iter().filter_map(|p| Some((p.policy_arn()?.to_string(), scope_of(p.access_scope())))));
        token = page.next_token().map(str::to_string);
        if token.is_none() {
            break;
        }
    }
    Ok(out)
}

/// access entry 전부. 목록을 못 읽으면 오류, 항목 하나를 자세히 못 읽으면 그 항목만 `read_error`로 남긴다.
pub async fn read_entries(eks: &Eks, cluster: &str) -> Result<Vec<EntryInput>, AppError> {
    let mut principals = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..PAGES_MAX {
        let page = call(eks.list_access_entries().cluster_name(cluster).set_next_token(token.take()).send(), "eks:ListAccessEntries").await?;
        principals.extend(page.access_entries().iter().cloned());
        token = page.next_token().map(str::to_string);
        if token.is_none() {
            break;
        }
    }
    let mut entries: Vec<EntryInput> = stream::iter(principals).map(|p| async move { entry_of(eks, cluster, &p).await }).buffered(CONCURRENCY).collect().await;
    entries.sort_by(|a, b| a.principal_arn.cmp(&b.principal_arn));
    Ok(entries)
}

/// 접근 화면의 입력을 모두 읽는다. 출처마다 실패해도 나머지는 그대로 돌려준다.
pub async fn load(client: &Client, eks: &Eks, cluster: &str, endpoint: Endpoint) -> Loaded {
    let described = describe(eks, cluster).await;
    let mode = described.as_ref().ok().map(|c| parse_mode(c.authentication_mode.as_deref()));
    let (entries, aws_auth, rbac, namespaces) = tokio::join!(
        async {
            // CONFIG_MAP 모드에서는 access entry API가 오류를 내니 부르지 않는다
            if mode == Some(AuthMode::ConfigMap) {
                Ok(vec![])
            } else {
                read_entries(eks, cluster).await
            }
        },
        read_aws_auth(client, endpoint),
        read_rbac(client, endpoint),
        read_namespaces(client, endpoint),
    );
    assemble(Parts { cluster: described, entries, aws_auth, rbac, namespaces })
}

// ── 워크로드 신원 ──

pub struct WorkloadParts {
    pub cluster: Result<ClusterView, AppError>,
    pub service_accounts: Result<(Vec<SaInfo>, bool), AppError>,
    pub pods: Result<(Vec<PodInfo>, bool), AppError>,
    pub associations: Result<Vec<Association>, AppError>,
    /// 역할 ARN → 신뢰 정책 글 또는 못 읽은 이유
    pub trusts: HashMap<String, TrustText>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadView {
    pub items: Vec<WorkloadIdentity>,
    pub oidc_issuer: Option<String>,
    /// Pod·ServiceAccount 목록이 쪽 한도에서 잘렸다
    pub truncated: bool,
    pub gaps: Vec<Gap>,
}

pub fn assemble_workload(parts: WorkloadParts) -> WorkloadView {
    let mut gaps = Vec::new();
    let cluster = keep(parts.cluster, Section::Cluster, &mut gaps);
    let (sas, sa_cut) = keep(parts.service_accounts, Section::ServiceAccounts, &mut gaps).unwrap_or_default();
    let (pods, pod_cut) = keep(parts.pods, Section::Pods, &mut gaps).unwrap_or_default();
    let associations = keep(parts.associations, Section::PodIdentity, &mut gaps).unwrap_or_default();
    let issuer = cluster.and_then(|c| c.oidc_issuer);
    let items = assemble_workloads(&sas, &pods, &associations, &parts.trusts, issuer.as_deref());
    WorkloadView { items, oidc_issuer: issuer, truncated: sa_cut || pod_cut, gaps }
}

fn sa_of(s: ServiceAccount) -> SaInfo {
    SaInfo { namespace: s.metadata.namespace.unwrap_or_default(), name: s.metadata.name.unwrap_or_default(), annotations: s.metadata.annotations.unwrap_or_default().into_iter().collect() }
}

fn pod_of(p: Pod) -> PodInfo {
    PodInfo {
        namespace: p.metadata.namespace.unwrap_or_default(),
        name: p.metadata.name.unwrap_or_default(),
        service_account: p.spec.and_then(|s| s.service_account_name).filter(|n| !n.is_empty()).unwrap_or_else(|| "default".to_string()),
    }
}

async fn read_associations(eks: &Eks, cluster: &str) -> Result<Vec<Association>, AppError> {
    let mut ids = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..PAGES_MAX {
        let page = call(eks.list_pod_identity_associations().cluster_name(cluster).set_next_token(token.take()).send(), "eks:ListPodIdentityAssociations").await?;
        ids.extend(page.associations().iter().filter_map(|a| a.association_id().map(str::to_string)));
        token = page.next_token().map(str::to_string);
        if token.is_none() {
            break;
        }
    }
    let described: Vec<Result<Option<Association>, AppError>> = stream::iter(ids)
        .map(|id| async move {
            let out = call(eks.describe_pod_identity_association().cluster_name(cluster).association_id(&id).send(), "eks:DescribePodIdentityAssociation").await?;
            Ok(out.association().map(|a| Association {
                id: a.association_id().unwrap_or(&id).to_string(),
                namespace: a.namespace().unwrap_or_default().to_string(),
                service_account: a.service_account().unwrap_or_default().to_string(),
                role_arn: a.role_arn().unwrap_or_default().to_string(),
                target_role_arn: a.target_role_arn().map(str::to_string),
            }))
        })
        .buffered(CONCURRENCY)
        .collect()
        .await;
    let mut out = Vec::new();
    for r in described {
        out.extend(r?);
    }
    out.sort_by(|a, b| (&a.namespace, &a.service_account).cmp(&(&b.namespace, &b.service_account)));
    Ok(out)
}

/// 역할의 신뢰 정책 글. `GetRole`만 쓴다(읽기). 문서는 URL 인코딩돼 오니 풀어서 돌려준다.
pub async fn read_trust(iam: &Iam, role_arn: &str) -> TrustText {
    let Some(name) = role_name(role_arn) else {
        return Err(format!("역할 ARN을 해석하지 못했어요: {role_arn}"));
    };
    match tokio::time::timeout(crate::k8s::connect::REQUEST_TIMEOUT, iam.get_role().role_name(name).send()).await {
        Err(_) => Err("IAM이 30초 안에 답하지 않았어요(iam:GetRole)".to_string()),
        Ok(Err(e)) => Err(from_sdk(e, "iam:GetRole").to_string()),
        Ok(Ok(out)) => out.role().and_then(|r| r.assume_role_policy_document()).map(decode_document).ok_or_else(|| "역할의 신뢰 정책이 비어 있어요".to_string()),
    }
}

async fn read_trusts(iam: &Iam, arns: Vec<String>) -> HashMap<String, TrustText> {
    stream::iter(arns).map(|arn| async move { (arn.clone(), read_trust(iam, &arn).await) }).buffered(CONCURRENCY).collect::<Vec<_>>().await.into_iter().collect()
}

/// 워크로드 신원 화면의 입력을 모두 읽는다
pub async fn load_workload(client: &Client, eks: &Eks, iam: &Iam, cluster: &str, endpoint: Endpoint) -> WorkloadView {
    let pods_lp = ListParams::default().fields(RUNNING_PODS);
    let (described, sas, pods, associations) = tokio::join!(
        describe(eks, cluster),
        async { list_typed::<ServiceAccount>(client, &ListParams::default(), "serviceaccounts", endpoint).await.map(|(items, cut)| (items.into_iter().map(sa_of).collect::<Vec<_>>(), cut)) },
        async { list_typed::<Pod>(client, &pods_lp, "pods", endpoint).await.map(|(items, cut)| (items.into_iter().map(pod_of).collect::<Vec<_>>(), cut)) },
        read_associations(eks, cluster),
    );
    let mut roles: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let annotated = sas.iter().flat_map(|(list, _)| list.iter()).filter_map(|s| s.annotations.get(super::workload::IRSA_ANNOTATION)).filter(|r| !r.is_empty());
    let assigned = associations.iter().flatten().map(|a| &a.role_arn).filter(|r| !r.is_empty());
    for arn in annotated.chain(assigned) {
        if seen.insert(arn.clone()) {
            roles.push(arn.clone());
        }
    }
    let trusts = read_trusts(iam, roles).await;
    assemble_workload(WorkloadParts { cluster: described, service_accounts: sas, pods, associations, trusts })
}

#[cfg(test)]
mod tests;
