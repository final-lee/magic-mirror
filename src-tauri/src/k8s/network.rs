//! 네트워크 화면(K6): Service·Ingress ↔ ELBv2 로드 밸런서, 노드 → 인스턴스 → 서브넷·AZ, VPC CNI의 Pod IP → 서브넷, NetworkPolicy.
//! 읽기만 한다(쿠버네티스 GET·LIST, AWS Describe). 부분마다 실패를 `gaps`에 담아 나머지는 그대로 돌려준다.
use std::collections::{HashMap, HashSet};

use kube::Client;

use crate::error::AppError;
use crate::k8s::failure::Endpoint;

pub mod aws;
pub mod cidr;
pub mod cluster;
pub mod lb;
pub mod model;
pub mod policy;

use aws::{Clients, Instance, LbList, Subnet};
use cidr::{count_by_subnet, Cidr, SubnetRange};
use model::{AwsLb, Gap, LbRow, LoadBalancerView, Network, NodeNet, PodNet, PodsNet, Section, SubnetNet, Unmatched};

/// 읽어 온 원본 전체. AWS 쪽 실패는 같은 이유가 여러 부분에 반복될 수 있다.
pub struct Inputs {
    pub cluster: String,
    pub k8s: cluster::Parts,
    pub vpc: Result<Option<String>, AppError>,
    pub instances: Result<Vec<Instance>, AppError>,
    pub subnets: Result<Vec<Subnet>, AppError>,
    pub lbs: Result<LbList, AppError>,
}

fn keep<T>(r: &Result<T, AppError>, section: Section, gaps: &mut Vec<Gap>) -> bool {
    match r {
        Ok(_) => true,
        Err(error) => {
            gaps.push(Gap { section, subject: None, error: error.clone() });
            false
        }
    }
}

fn pods_of(inputs: &Inputs) -> (Vec<PodNet>, bool, bool) {
    match &inputs.k8s.pods {
        Ok((items, partial)) => {
            let (pods, cni) = cluster::pod_nets(items);
            (pods, cni, *partial)
        }
        Err(_) => (vec![], false, false),
    }
}

fn nodes_of(inputs: &Inputs) -> Vec<NodeNet> {
    let mut nodes = inputs.k8s.nodes.as_ref().map(|n| cluster::node_nets(n)).unwrap_or_default();
    if let Ok(instances) = &inputs.instances {
        for n in &mut nodes {
            if let Some(i) = n.instance_id.as_ref().and_then(|id| instances.iter().find(|i| &i.id == id)) {
                n.instance_state = i.state.clone();
                n.subnet_id = i.subnet_id.clone();
                // 인스턴스가 실제로 놓인 AZ가 레이블보다 정확하다
                n.zone = i.zone.clone().or(n.zone.take());
            }
        }
    }
    nodes
}

fn lb_list(inputs: &Inputs) -> &[AwsLb] {
    inputs.lbs.as_ref().map(|l| l.lbs.as_slice()).unwrap_or_default()
}

/// Service·Ingress 원본과 짝(index는 `lb_list`의 자리)
fn matches(inputs: &Inputs) -> Vec<(model::LbSource, Option<lb::Found>)> {
    let lbs = lb_list(inputs);
    let mut sources = inputs.k8s.services.as_ref().map(|s| lb::service_sources(s)).unwrap_or_default();
    sources.extend(inputs.k8s.ingresses.as_ref().map(|i| lb::ingress_sources(i)).unwrap_or_default());
    sources.into_iter().map(|s| {
        let found = lb::find(&s, &inputs.cluster, lbs);
        (s, found)
    })
    .collect()
}

/// 리스너·대상 그룹을 읽어야 하는 로드 밸런서: 짝이 있는 것(중복 없이). 호출 순서는 입력 순서다.
pub fn matched_lbs(inputs: &Inputs) -> Vec<&AwsLb> {
    let lbs = lb_list(inputs);
    let mut seen = HashSet::new();
    matches(inputs).into_iter().filter_map(|(_, f)| f).filter(|f| seen.insert(f.index)).map(|f| &lbs[f.index]).collect()
}

/// 서브넷 표. 노드·Pod가 있는 서브넷이 먼저, 그다음 AZ·CIDR 순.
fn subnet_nets(subnets: &[Subnet], nodes: &[NodeNet], pod_counts: Option<&HashMap<String, usize>>) -> Vec<SubnetNet> {
    let mut out: Vec<SubnetNet> = subnets
        .iter()
        .map(|s| SubnetNet {
            id: s.id.clone(),
            name: s.name.clone(),
            zone: s.zone.clone(),
            capacity: s.cidrs.iter().filter_map(|c| Cidr::parse(c)).find_map(|c| c.capacity()),
            cidrs: s.cidrs.clone(),
            available_ips: s.available_ips,
            node_count: nodes.iter().filter(|n| n.subnet_id.as_deref() == Some(&s.id)).count(),
            pod_count: pod_counts.map(|c| c.get(&s.id).copied().unwrap_or(0)),
        })
        .collect();
    out.sort_by(|a, b| {
        let used = |s: &SubnetNet| s.node_count + s.pod_count.unwrap_or(0) > 0;
        (!used(a), &a.zone, &a.cidrs, &a.id).cmp(&(!used(b), &b.zone, &b.cidrs, &b.id))
    });
    out
}

/// 원본 전체와 짝 로드 밸런서의 상세로 화면 한 장을 만든다. `details`는 `matched_lbs`가 알려 준 로드 밸런서의 ARN별 상세다.
pub fn assemble(inputs: Inputs, details: &HashMap<String, LoadBalancerView>) -> Network {
    let mut gaps = Vec::new();
    keep(&inputs.vpc, Section::Cluster, &mut gaps);
    keep(&inputs.instances, Section::Instances, &mut gaps);
    keep(&inputs.subnets, Section::Subnets, &mut gaps);
    keep(&inputs.lbs, Section::LoadBalancers, &mut gaps);
    if let Ok(l) = &inputs.lbs {
        if let Some(error) = &l.tags_error {
            gaps.push(Gap { section: Section::LoadBalancers, subject: Some("tags".into()), error: error.clone() });
        }
    }
    let services_ok = keep(&inputs.k8s.services, Section::Services, &mut gaps);
    let ingresses_ok = keep(&inputs.k8s.ingresses, Section::Ingresses, &mut gaps);
    let nodes_ok = keep(&inputs.k8s.nodes, Section::Nodes, &mut gaps);
    let pods_ok = keep(&inputs.k8s.pods, Section::Pods, &mut gaps);
    let policies_ok = keep(&inputs.k8s.policies, Section::Policies, &mut gaps);
    let namespaces_ok = keep(&inputs.k8s.namespaces, Section::Namespaces, &mut gaps);

    let nodes = nodes_of(&inputs);
    let (mut pods, vpc_cni, partial) = pods_of(&inputs);
    let ranges: Vec<SubnetRange> = inputs
        .subnets
        .as_ref()
        .map(|s| s.iter().map(|s| SubnetRange { id: s.id.clone(), cidrs: s.cidrs.iter().filter_map(|c| Cidr::parse(c)).collect() }).collect())
        .unwrap_or_default();
    // Pod IP → 서브넷은 VPC CNI일 때만 뜻이 있다. hostNetwork Pod의 IP는 노드 IP라 세지 않는다.
    let mapped = vpc_cni && inputs.subnets.is_ok();
    let mut pod_counts = None;
    let mut outside = 0;
    if mapped {
        for p in &mut pods {
            p.subnet_id = cidr::subnet_of(&p.ip, &ranges).map(str::to_string);
        }
        let (counts, out) = count_by_subnet(pods.iter().filter(|p| !p.host_network).map(|p| p.ip.as_str()), &ranges);
        pod_counts = Some(counts);
        outside = out;
    }

    let lbs = lb_list(&inputs);
    let rows: Vec<LbRow> = matches(&inputs)
        .into_iter()
        .map(|(source, found)| {
            let view = found.and_then(|f| details.get(&lbs[f.index].arn).cloned());
            let unmatched = if found.is_some() {
                None
            } else if source.hostnames.is_empty() && source.ips.is_empty() {
                Some(Unmatched::Pending)
            } else if inputs.lbs.is_err() {
                Some(Unmatched::AwsUnavailable)
            } else {
                Some(Unmatched::NotFound)
            };
            LbRow { source, matched_by: found.map(|f| f.by), load_balancer: view, unmatched }
        })
        .collect();
    let claimed: HashSet<String> = rows.iter().filter_map(|r| r.load_balancer.as_ref().map(|l| l.arn.clone())).collect();
    let unclaimed = lb::unclaimed(lbs, &inputs.cluster, &claimed);

    let mut highlight: Vec<String> = nodes.iter().filter_map(|n| n.instance_id.clone()).collect();
    highlight.extend(claimed.iter().cloned());
    highlight.extend(unclaimed.iter().map(|u| u.arn.clone()));
    highlight.sort();
    highlight.dedup();

    let vpc_id = inputs.vpc.as_ref().ok().cloned().flatten().or_else(|| {
        // EKS를 읽지 못했으면 노드의 인스턴스가 놓인 VPC를 쓴다
        inputs.instances.as_ref().ok().and_then(|i| i.iter().find_map(|i| i.vpc_id.clone()))
    });
    let policies: Vec<model::PolicyView> = inputs.k8s.policies.as_ref().map(|p| p.iter().map(policy::policy_view).collect()).unwrap_or_default();
    let namespace_names: Vec<String> = inputs.k8s.namespaces.as_ref().map(|n| n.iter().filter_map(|n| n.metadata.name.clone()).collect()).unwrap_or_default();

    Network {
        vpc_id,
        load_balancers: (services_ok || ingresses_ok).then_some(rows),
        unclaimed,
        subnets: inputs.subnets.as_ref().ok().map(|s| subnet_nets(s, &nodes, pod_counts.as_ref())),
        nodes: nodes_ok.then_some(nodes),
        pods: pods_ok.then_some(PodsNet { vpc_cni, items: pods, outside, partial }),
        policies: policies_ok.then_some(policies.clone()),
        namespaces: (namespaces_ok && policies_ok).then(|| policy::namespace_policies(&namespace_names, &policies)),
        highlight,
        gaps,
    }
}

/// 화면 한 장을 읽는다. AWS 클라이언트를 만들지 못했으면(`aws`가 오류) AWS 부분은 모두 그 이유로 gap이 된다.
pub async fn network(aws: &Result<Clients, AppError>, cluster: &str, client: &Client, endpoint: Endpoint) -> Network {
    let (k8s, vpc) = tokio::join!(cluster::read(client, endpoint), async {
        match aws {
            Ok(c) => aws::cluster_vpc(&c.eks, cluster).await,
            Err(e) => Err(e.clone()),
        }
    });
    collect(aws, cluster, k8s, vpc).await
}

/// 읽어 온 쿠버네티스 원본에 AWS 쪽(인스턴스 → 서브넷, 로드 밸런서 → 짝의 상세)을 더해 화면 한 장으로 만든다.
/// 쿠버네티스 연결 없이 부를 수 있어서, AWS 호출의 순서와 인자를 가짜 클라이언트로 시험한다.
pub async fn collect(aws: &Result<Clients, AppError>, cluster: &str, k8s: cluster::Parts, vpc: Result<Option<String>, AppError>) -> Network {
    let node_nets = k8s.nodes.as_ref().map(|n| cluster::node_nets(n)).unwrap_or_default();
    let ids: Vec<String> = node_nets.iter().filter_map(|n| n.instance_id.clone()).collect();
    let instances = match aws {
        Ok(c) if !ids.is_empty() => aws::instances(&c.ec2, &ids).await,
        Ok(_) => Ok(vec![]),
        Err(e) => Err(e.clone()),
    };
    // EKS가 VPC를 알려 주지 않으면 인스턴스가 놓인 VPC로 대신한다
    let vpc_id = vpc.as_ref().ok().cloned().flatten().or_else(|| instances.as_ref().ok().and_then(|i| i.iter().find_map(|i| i.vpc_id.clone())));
    let subnet_ids: Vec<String> = instances.as_ref().map(|i| i.iter().filter_map(|i| i.subnet_id.clone()).collect()).unwrap_or_default();
    let (subnets, lbs) = match aws {
        Ok(c) => tokio::join!(aws::subnets(&c.ec2, vpc_id.as_deref(), &subnet_ids), aws::load_balancers(&c.elb, vpc_id.as_deref())),
        Err(e) => (Err(e.clone()), Err(e.clone())),
    };
    let inputs = Inputs { cluster: cluster.to_string(), k8s, vpc, instances, subnets, lbs };
    let details = match aws {
        Ok(c) => lb_details(c, &inputs).await,
        Err(_) => HashMap::new(),
    };
    assemble(inputs, &details)
}

/// 짝이 있는 로드 밸런서마다 리스너·대상 그룹·대상 상태를 읽는다(동시에 몇 개씩).
async fn lb_details(c: &Clients, inputs: &Inputs) -> HashMap<String, LoadBalancerView> {
    use futures::StreamExt;
    let nodes = nodes_of(inputs);
    let (pods, _, _) = pods_of(inputs);
    let matched: Vec<AwsLb> = matched_lbs(inputs).into_iter().cloned().collect();
    futures::stream::iter(matched.into_iter().map(|lb| {
        let (nodes, pods) = (&nodes, &pods);
        async move { (lb.arn.clone(), aws::details(&c.elb, &lb, nodes, pods).await) }
    }))
    .buffer_unordered(DETAIL_CONCURRENCY)
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .collect()
}

/// 로드 밸런서 상세를 동시에 읽는 수
const DETAIL_CONCURRENCY: usize = 4;

#[cfg(test)]
mod mock_aws;
#[cfg(test)]
mod tests;
