//! 노드 점검(순수): 인스턴스 메타데이터(IMDS) hop limit. 2 이상이면 컨테이너 안의 Pod도 IMDS에 닿아 노드 IAM 역할의 자격 증명을 얻을 수 있다.
//! 두 곳에서 본다: 관리형 노드그룹의 시작 템플릿(`DescribeLaunchTemplateVersions`)과 노드 인스턴스의 실제 설정(`DescribeInstances`).
//! Karpenter 노드와 자체 관리 노드는 인스턴스 설정으로만 알 수 있다.
use std::collections::BTreeMap;

use super::{CheckId, Finding, NodeImds, NodegroupImds, Severity, Target};

/// 이 값 이상이면 Pod가 IMDS에 닿는다
pub const HOP_LIMIT_REACHABLE: i32 = 2;

fn resource_name(resource: &str) -> &'static str {
    match resource {
        "nodegroup" => "노드그룹",
        "nodepool" => "NodePool",
        _ => "인스턴스",
    }
}

/// 한 노드그룹(또는 NodePool, 인스턴스)의 문제를 모은다. 입력을 읽지 못한 쪽은 None.
pub fn check_imds(nodegroups: Option<&[NodegroupImds]>, nodes: Option<&[NodeImds]>) -> Vec<Finding> {
    // (종류, 이름) → (가장 큰 hop limit, 증거)
    let mut groups: BTreeMap<(&'static str, String), (i32, Vec<String>)> = BTreeMap::new();
    let mut add = |resource: &'static str, name: &str, hop: i32, line: String| {
        let entry = groups.entry((resource, name.to_string())).or_insert((hop, vec![]));
        entry.0 = entry.0.max(hop);
        entry.1.push(line);
    };
    for group in nodegroups.unwrap_or_default() {
        let Some(lt) = &group.launch_template else { continue };
        if let Some(hop) = lt.hop_limit.filter(|h| *h >= HOP_LIMIT_REACHABLE) {
            add("nodegroup", &group.name, hop, format!("시작 템플릿 {}: HttpPutResponseHopLimit={hop}", lt.label));
        }
    }
    for node in nodes.unwrap_or_default() {
        let Some(hop) = node.hop_limit.filter(|h| *h >= HOP_LIMIT_REACHABLE) else { continue };
        let line = format!("노드 {}({}): 인스턴스의 HttpPutResponseHopLimit={hop}", node.name, node.instance_id);
        match (&node.nodegroup, &node.nodepool) {
            (Some(group), _) => add("nodegroup", group, hop, line),
            (None, Some(pool)) => add("nodepool", pool, hop, line),
            (None, None) => add("instance", &node.instance_id, hop, line),
        }
    }
    groups
        .into_iter()
        .map(|((resource, name), (hop, mut evidence))| {
            evidence.push("hop limit이 1이면 컨테이너(hostNetwork가 아닌 Pod)의 IMDS 요청은 노드에서 끊겨요".into());
            Finding::new(
                CheckId::ImdsHopLimit,
                Severity::High,
                Target::Aws { resource: resource.into(), name: name.clone() },
                None,
                format!("{} {name}의 IMDS hop limit이 {hop}라서 Pod가 노드 IAM 역할의 자격 증명을 읽을 수 있어요", resource_name(resource)),
                evidence,
            )
        })
        .collect()
}

#[cfg(test)]
mod tests;
