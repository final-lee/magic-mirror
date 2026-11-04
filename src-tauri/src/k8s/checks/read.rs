//! 보안 점검의 읽기: 쿠버네티스(GET·LIST만)와 EKS·EC2(Describe·List만). 읽지 못한 부분은 `Err`로 남기고 `checks::run`이 gap으로 알린다.
//! 접근 화면(K4)의 읽기 함수(RBAC, aws-auth, access entry, 네임스페이스)를 그대로 쓰고, 워크로드·ServiceAccount·NetworkPolicy·노드를 더한다.
use std::collections::HashMap;
use std::fmt::Debug;
use std::future::Future;

use aws_sdk_ec2::types::Filter;
use aws_smithy_runtime_api::client::result::SdkError;
use aws_smithy_types::error::metadata::ProvideErrorMetadata;
use futures::stream::{self, StreamExt};
use kube::api::{DynamicObject, ListParams};
use kube::Client;

use super::{
    AdminEntry, AwsAuthFacts, AwsAuthUse, ClusterFacts, Gap, ImdsInputs, Inputs, LaunchTemplateImds, NodeImds, NodegroupImds, SaFacts, Section, VersionSupport, Workload, WorkloadInputs,
    WorkloadKind,
};
use crate::error::{from_sdk, AppError};
use crate::k8s::access::engine::{evaluate, PolicyScope};
use crate::k8s::access::identity::{parse_mode, principals, resolve, AuthMode, IdentityMapping, MappingSource};
use crate::k8s::access::read::{read_aws_auth, read_entries, read_namespaces, read_rbac};
use crate::k8s::connect::REQUEST_TIMEOUT;
use crate::k8s::failure::Endpoint;
use crate::k8s::network::cluster::parse_provider_id;
use crate::k8s::read::eks::{call, cluster_view, ClusterView, PAGES_MAX};
use crate::k8s::read::overview::{LIST_PAGES_MAX, RUNNING_PODS};
use crate::k8s::read::values::labels_of;
use crate::k8s::read::{api_for, list_all};
use crate::k8s::rows::KindRef;

/// 한꺼번에 보내는 EKS·EC2 요청 수
const CONCURRENCY: usize = 8;
/// DescribeInstances 필터 값을 한 번에 보내는 수
const INSTANCE_CHUNK: usize = 100;
const CLUSTER_ADMIN_POLICY: &str = "AmazonEKSClusterAdminPolicy";
const NODEGROUP_LABEL: &str = "eks.amazonaws.com/nodegroup";
const NODEPOOL_LABEL: &str = "karpenter.sh/nodepool";

/// 점검이 쓰는 AWS 클라이언트(EKS, EC2)
pub struct Aws {
    pub eks: aws_sdk_eks::Client,
    pub ec2: aws_sdk_ec2::Client,
}

impl Aws {
    pub fn new(cfg: &aws_config::SdkConfig) -> Aws {
        Aws { eks: aws_sdk_eks::Client::new(cfg), ec2: aws_sdk_ec2::Client::new(cfg) }
    }
}

/// EC2 호출 하나를 `REQUEST_TIMEOUT` 안에 끝낸다
async fn ec2_call<T, E, R>(fut: impl Future<Output = Result<T, SdkError<E, R>>>, action: &str) -> Result<T, AppError>
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
    R: Debug + Send + Sync + 'static,
{
    match tokio::time::timeout(REQUEST_TIMEOUT, fut).await {
        Err(_) => Err(AppError::Network { message: format!("EC2 API가 30초 안에 답하지 않았어요({action})") }),
        Ok(r) => r.map_err(|e| from_sdk(e, action)),
    }
}

// ── EKS ──

/// `DescribeCluster`. 점검에 쓰는 값과, 인증 모드를 알려 주는 화면용 값을 함께 돌려준다.
pub async fn describe_cluster(eks: &aws_sdk_eks::Client, cluster: &str) -> Result<(ClusterFacts, ClusterView), AppError> {
    let out = call(eks.describe_cluster().name(cluster).send(), "eks:DescribeCluster").await?;
    let c = out.cluster().ok_or_else(|| AppError::other(crate::k8s::target::not_found(cluster)))?;
    let view = cluster_view(c);
    let facts = ClusterFacts {
        name: cluster.to_string(),
        version: view.version.clone(),
        endpoint_public: view.endpoint_public,
        endpoint_private: view.endpoint_private,
        public_cidrs: view.public_cidrs.clone(),
        logging_enabled: view.logging.clone(),
        secrets_encrypted: view.secrets_encrypted,
        created_at: c.created_at().map(|t| t.secs()),
    };
    Ok((facts, view))
}

/// 모든 버전의 표준 지원 종료일(`DescribeClusterVersions`, 지원이 끝난 버전 포함)
pub async fn versions(eks: &aws_sdk_eks::Client) -> Result<Vec<VersionSupport>, AppError> {
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..PAGES_MAX {
        let page = call(eks.describe_cluster_versions().include_all(true).set_next_token(token.take()).send(), "eks:DescribeClusterVersions").await?;
        out.extend(page.cluster_versions().iter().filter_map(|v| {
            Some(VersionSupport { version: v.cluster_version()?.to_string(), end_of_standard_support: v.end_of_standard_support_date().map(|t| t.secs()) })
        }));
        token = page.next_token().map(str::to_string);
        if token.is_none() {
            break;
        }
    }
    Ok(out)
}

/// 노드그룹 하나와 그 시작 템플릿을 읽지 못한 이유
type Described = (NodegroupImds, Option<AppError>);

/// 노드그룹마다 시작 템플릿의 IMDS 설정. 시작 템플릿 하나를 읽지 못하면 그 노드그룹만 gap으로 남는다.
pub async fn nodegroups(aws: &Aws, cluster: &str) -> Result<(Vec<NodegroupImds>, Vec<Gap>), AppError> {
    let mut names = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..PAGES_MAX {
        let out = call(aws.eks.list_nodegroups().cluster_name(cluster).set_next_token(token.take()).send(), "eks:ListNodegroups").await?;
        names.extend(out.nodegroups().iter().cloned());
        token = out.next_token().map(str::to_string);
        if token.is_none() {
            break;
        }
    }
    let described: Vec<Result<Option<Described>, AppError>> = stream::iter(names)
        .map(|name| async move {
            let out = call(aws.eks.describe_nodegroup().cluster_name(cluster).nodegroup_name(&name).send(), "eks:DescribeNodegroup").await?;
            let Some(group) = out.nodegroup() else { return Ok(None) };
            let Some(lt) = group.launch_template() else { return Ok(Some((NodegroupImds { name, launch_template: None }, None))) };
            let label = format!("{} v{}", lt.id().or(lt.name()).unwrap_or("?"), lt.version().unwrap_or("?"));
            let hop = launch_template_hop(&aws.ec2, lt.id(), lt.name(), lt.version()).await;
            let (hop_limit, error) = match hop {
                Ok(h) => (h, None),
                Err(e) => (None, Some(e)),
            };
            Ok(Some((NodegroupImds { name, launch_template: Some(LaunchTemplateImds { label, hop_limit }) }, error)))
        })
        .buffered(CONCURRENCY)
        .collect()
        .await;
    let mut groups = Vec::new();
    let mut gaps = Vec::new();
    for r in described {
        // 노드그룹 하나를 읽지 못하면 그 노드그룹은 점검에서 빠지고 이유가 남는다
        let Some((group, error)) = (match r {
            Ok(found) => found,
            Err(error) => {
                gaps.push(Gap { section: Section::Nodegroups, subject: None, error, partial: false });
                continue;
            }
        }) else {
            continue;
        };
        if let Some(error) = error {
            gaps.push(Gap { section: Section::LaunchTemplates, subject: Some(group.name.clone()), error, partial: false });
        }
        groups.push(group);
    }
    groups.sort_by(|a, b| a.name.cmp(&b.name));
    Ok((groups, gaps))
}

async fn launch_template_hop(ec2: &aws_sdk_ec2::Client, id: Option<&str>, name: Option<&str>, version: Option<&str>) -> Result<Option<i32>, AppError> {
    let mut request = ec2.describe_launch_template_versions();
    request = match (id, name) {
        (Some(id), _) => request.launch_template_id(id),
        (None, Some(name)) => request.launch_template_name(name),
        (None, None) => return Ok(None),
    };
    if let Some(version) = version {
        request = request.versions(version);
    }
    let out = ec2_call(request.send(), "ec2:DescribeLaunchTemplateVersions").await?;
    Ok(out
        .launch_template_versions()
        .first()
        .and_then(|v| v.launch_template_data())
        .and_then(|d| d.metadata_options())
        .and_then(|m| m.http_put_response_hop_limit()))
}

/// access entry를 만든 시각(생성자 관리자 후보 판단에 쓴다)
async fn entry_created(eks: &aws_sdk_eks::Client, cluster: &str, principal: &str) -> Result<Option<i64>, AppError> {
    let out = call(eks.describe_access_entry().cluster_name(cluster).principal_arn(principal).send(), "eks:DescribeAccessEntry").await?;
    Ok(out.access_entry().and_then(|e| e.created_at()).map(|t| t.secs()))
}

// ── 신원 매핑에서 ──

/// aws-auth가 실제로 쓰이는 매핑
pub fn aws_auth_facts(mode: Option<&str>, mappings: &[IdentityMapping]) -> AwsAuthFacts {
    let entries = mappings
        .iter()
        .filter(|m| m.source == MappingSource::AwsAuth && m.effective)
        .map(|m| AwsAuthUse { arn: m.principal_arn.clone(), groups: m.groups.clone() })
        .collect();
    AwsAuthFacts { mode: mode.map(str::to_string), entries }
}

/// 클러스터 전체 범위의 `AmazonEKSClusterAdminPolicy`가 붙은 유효한 access entry의 주체
pub fn cluster_admin_principals(mappings: &[IdentityMapping]) -> Vec<String> {
    mappings
        .iter()
        .filter(|m| m.source == MappingSource::AccessEntry && m.effective)
        .filter(|m| m.policies.iter().any(|p| p.policy_name == CLUSTER_ADMIN_POLICY && p.scope == PolicyScope::Cluster))
        .map(|m| m.principal_arn.clone())
        .collect()
}

// ── 쿠버네티스 ──

fn kind(group: &str, kind: &str, plural: &str, namespaced: bool) -> KindRef {
    KindRef { group: group.into(), version: "v1".into(), kind: kind.into(), plural: plural.into(), namespaced }
}

fn controlled(obj: &DynamicObject) -> bool {
    obj.metadata.owner_references.iter().flatten().any(|o| o.controller == Some(true))
}

/// 객체에서 워크로드 하나를 꺼낸다. 컨트롤러가 만든 Pod·Job은 컨트롤러가 대표하므로 None.
pub fn workload_of(kind: WorkloadKind, obj: &DynamicObject) -> Option<Workload> {
    if matches!(kind, WorkloadKind::Pod | WorkloadKind::Job) && controlled(obj) {
        return None;
    }
    let path = match kind {
        WorkloadKind::Pod => "/spec",
        WorkloadKind::CronJob => "/spec/jobTemplate/spec/template/spec",
        _ => "/spec/template/spec",
    };
    let spec = serde_json::from_value(obj.data.pointer(path)?.clone()).ok()?;
    Some(Workload {
        kind,
        namespace: obj.metadata.namespace.clone().unwrap_or_default(),
        name: obj.metadata.name.clone().unwrap_or_default(),
        labels: labels_of(obj),
        annotations: obj.metadata.annotations.clone().unwrap_or_default().into_iter().collect(),
        spec,
    })
}

async fn read_workloads(client: &Client, endpoint: Endpoint) -> WorkloadInputs {
    let kinds = [
        (WorkloadKind::Deployment, Section::Deployments, "deployments"),
        (WorkloadKind::StatefulSet, Section::StatefulSets, "statefulsets"),
        (WorkloadKind::DaemonSet, Section::DaemonSets, "daemonsets"),
        (WorkloadKind::Job, Section::Jobs, "jobs"),
        (WorkloadKind::CronJob, Section::CronJobs, "cronjobs"),
        (WorkloadKind::Pod, Section::Pods, "pods"),
    ];
    let results = futures::future::join_all(kinds.iter().map(|(k, section, plural)| async move {
        let api = api_for(client.clone(), &k.kind_ref(), None);
        // 끝난 Pod는 지금 위험이 아니다
        let lp = if *k == WorkloadKind::Pod { ListParams::default().fields(RUNNING_PODS) } else { ListParams::default() };
        (*k, *section, list_all(&api, &lp, LIST_PAGES_MAX, plural, endpoint).await)
    }))
    .await;
    let mut out = WorkloadInputs::default();
    for (kind, section, result) in results {
        match result {
            Ok((items, cut)) => {
                out.items.extend(items.iter().filter_map(|o| workload_of(kind, o)));
                if cut {
                    out.truncated.push(section);
                }
            }
            Err(error) => out.errors.push((section, error)),
        }
    }
    out.items.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
    out
}

pub fn sa_facts(obj: &DynamicObject) -> SaFacts {
    SaFacts {
        namespace: obj.metadata.namespace.clone().unwrap_or_default(),
        name: obj.metadata.name.clone().unwrap_or_default(),
        automount: obj.data.get("automountServiceAccountToken").and_then(serde_json::Value::as_bool),
        bound: None,
    }
}

async fn read_service_accounts(client: &Client, endpoint: Endpoint) -> Result<(Vec<SaFacts>, bool), AppError> {
    let api = api_for(client.clone(), &kind("", "ServiceAccount", "serviceaccounts", true), None);
    let (items, cut) = list_all(&api, &ListParams::default(), LIST_PAGES_MAX, "serviceaccounts", endpoint).await?;
    Ok((items.iter().map(sa_facts).collect(), cut))
}

/// NetworkPolicy가 있는 네임스페이스(정책마다 하나씩)
async fn read_policy_namespaces(client: &Client, endpoint: Endpoint) -> Result<Vec<String>, AppError> {
    let api = api_for(client.clone(), &kind("networking.k8s.io", "NetworkPolicy", "networkpolicies", true), None);
    let (items, _) = list_all(&api, &ListParams::default(), LIST_PAGES_MAX, "networkpolicies", endpoint).await?;
    Ok(items.into_iter().filter_map(|p| p.metadata.namespace).collect())
}

/// 노드 한 줄: 인스턴스를 알 수 있는 노드(Fargate·kind 노드는 제외)
pub struct NodeBase {
    pub name: String,
    pub instance_id: String,
    pub nodegroup: Option<String>,
    pub nodepool: Option<String>,
}

pub fn node_bases(nodes: &[DynamicObject]) -> Vec<NodeBase> {
    nodes
        .iter()
        .filter_map(|n| {
            let provider = n.data.pointer("/spec/providerID").and_then(serde_json::Value::as_str)?;
            let instance_id = parse_provider_id(provider).1?;
            let labels = labels_of(n);
            Some(NodeBase {
                name: n.metadata.name.clone().unwrap_or_default(),
                instance_id,
                nodegroup: labels.get(NODEGROUP_LABEL).cloned(),
                nodepool: labels.get(NODEPOOL_LABEL).cloned(),
            })
        })
        .collect()
}

async fn read_nodes(client: &Client, endpoint: Endpoint) -> Result<Vec<DynamicObject>, AppError> {
    let api = api_for(client.clone(), &kind("", "Node", "nodes", false), None);
    Ok(list_all(&api, &ListParams::default(), LIST_PAGES_MAX, "nodes", endpoint).await?.0)
}

// ── EC2 ──

/// 인스턴스 ID → IMDS hop limit. 필터로 읽어서 이미 사라진 ID가 있어도 나머지는 읽힌다(없는 인스턴스는 결과에 없다).
pub async fn instance_hops(ec2: &aws_sdk_ec2::Client, ids: &[String]) -> Result<HashMap<String, Option<i32>>, AppError> {
    let mut out = HashMap::new();
    for chunk in ids.chunks(INSTANCE_CHUNK) {
        let filter = Filter::builder().name("instance-id").set_values(Some(chunk.to_vec())).build();
        let mut token: Option<String> = None;
        for _ in 0..PAGES_MAX {
            let page = ec2_call(ec2.describe_instances().filters(filter.clone()).set_next_token(token.take()).send(), "ec2:DescribeInstances").await?;
            for reservation in page.reservations() {
                for i in reservation.instances() {
                    let hop = i.metadata_options().and_then(|m| m.http_put_response_hop_limit());
                    out.insert(i.instance_id().unwrap_or("").to_string(), hop);
                }
            }
            token = page.next_token().map(str::to_string);
            if token.is_none() {
                break;
            }
        }
    }
    Ok(out)
}

/// 노드의 인스턴스 설정을 읽어 `NodeImds`로 합친다. 인스턴스를 읽지 못하면 오류(그 점검은 노드그룹 쪽만으로 돈다).
async fn node_imds(aws: &Result<Aws, AppError>, bases: Vec<NodeBase>) -> Result<Vec<NodeImds>, AppError> {
    if bases.is_empty() {
        return Ok(vec![]);
    }
    let aws = aws.as_ref().map_err(Clone::clone)?;
    let ids: Vec<String> = bases.iter().map(|b| b.instance_id.clone()).collect();
    let hops = instance_hops(&aws.ec2, &ids).await?;
    Ok(bases
        .into_iter()
        .map(|b| NodeImds { hop_limit: hops.get(&b.instance_id).copied().flatten(), name: b.name, instance_id: b.instance_id, nodegroup: b.nodegroup, nodepool: b.nodepool })
        .collect())
}

fn join_error(e: tokio::task::JoinError) -> AppError {
    AppError::other(e.to_string())
}

/// 점검 입력을 모두 읽는다. 읽지 못한 부분은 해당 필드가 `Err`가 되고 나머지는 그대로 돈다. AWS 클라이언트를 만들지 못했으면(`aws`가 오류) AWS 부분은 모두 그 이유로 `Err`다.
pub async fn gather(client: &Client, aws: &Result<Aws, AppError>, cluster: &str, endpoint: Endpoint, now: i64) -> Inputs {
    let (described, versions_result, aws_auth, rbac, namespaces, workloads, service_accounts, policies, nodes) = tokio::join!(
        async {
            match aws {
                Ok(a) => describe_cluster(&a.eks, cluster).await,
                Err(e) => Err(e.clone()),
            }
        },
        async {
            match aws {
                Ok(a) => versions(&a.eks).await,
                Err(e) => Err(e.clone()),
            }
        },
        read_aws_auth(client, endpoint),
        read_rbac(client, endpoint),
        read_namespaces(client, endpoint),
        read_workloads(client, endpoint),
        read_service_accounts(client, endpoint),
        read_policy_namespaces(client, endpoint),
        read_nodes(client, endpoint),
    );
    let mode_raw = described.as_ref().ok().and_then(|(_, view)| view.authentication_mode.clone());
    let mode = described.as_ref().ok().map(|(_, view)| parse_mode(view.authentication_mode.as_deref()));
    let bases = nodes.as_ref().map(|n| node_bases(n)).map_err(Clone::clone);
    let (entries, groups, node_hops) = tokio::join!(
        async {
            // CONFIG_MAP 모드에서는 access entry API가 오류를 내니 부르지 않는다(접근 화면과 같다)
            match aws {
                Ok(_) if mode == Some(AuthMode::ConfigMap) => Ok(vec![]),
                Ok(a) => read_entries(&a.eks, cluster).await,
                Err(e) => Err(e.clone()),
            }
        },
        async {
            match aws {
                Ok(a) => nodegroups(a, cluster).await,
                Err(e) => Err(e.clone()),
            }
        },
        async {
            match bases {
                Ok(bases) => node_imds(aws, bases).await,
                Err(e) => Err(e),
            }
        },
    );
    let mut gaps = Vec::new();
    let mappings = resolve(mode.unwrap_or(AuthMode::ApiAndConfigMap), entries.as_deref().unwrap_or_default(), aws_auth.as_ref().ok().and_then(Option::as_ref));

    // aws-auth: 읽었어도 access entry를 못 읽으면 어느 쪽이 유효한지 알 수 없다
    let aws_auth_facts = match (&aws_auth, &entries) {
        (Err(e), _) => Err(e.clone()),
        (Ok(_), Err(e)) if mode != Some(AuthMode::ConfigMap) => Err(e.clone()),
        _ => Ok(aws_auth_facts(mode_raw.as_deref(), &mappings)),
    };

    let created = match (&entries, aws) {
        (Ok(_), Ok(a)) => {
            let principals = cluster_admin_principals(&mappings);
            let results: Vec<(String, Result<Option<i64>, AppError>)> =
                stream::iter(principals).map(|p| async move { (p.clone(), entry_created(&a.eks, cluster, &p).await) }).buffered(CONCURRENCY).collect().await;
            let mut out = Vec::new();
            for (principal_arn, result) in results {
                let created_at = match result {
                    Ok(at) => at,
                    Err(error) => {
                        gaps.push(Gap { section: Section::AccessEntries, subject: Some(principal_arn.clone()), error, partial: false });
                        None
                    }
                };
                out.push(AdminEntry { principal_arn, created_at });
            }
            Ok(out)
        }
        (Err(e), _) => Err(e.clone()),
        (Ok(_), Err(e)) => Err(e.clone()),
    };

    let eval = match rbac {
        Ok(rbac) => {
            let principals = principals(&mappings);
            tokio::task::spawn_blocking(move || evaluate(rbac, principals)).await.map_err(join_error)
        }
        Err(e) => Err(e),
    };
    let nodegroup_imds = groups.map(|(groups, extra)| {
        gaps.extend(extra);
        groups
    });
    Inputs {
        now,
        cluster: described.map(|(facts, _)| facts),
        versions: versions_result,
        aws_auth: aws_auth_facts,
        admin_entries: created,
        eval,
        service_accounts,
        namespaces,
        workloads,
        policies,
        imds: ImdsInputs { nodegroups: nodegroup_imds, nodes: node_hops },
        gaps,
    }
}

#[cfg(test)]
mod tests;
