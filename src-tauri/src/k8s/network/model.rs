//! 네트워크 화면이 프런트로 보내는 값. 프런트 `src/k8s/network/types.ts`와 이름·모양이 같다.
use serde::Serialize;

use crate::error::AppError;

/// 읽지 못한 부분. `subject`는 로드 밸런서 하나에만 해당하는 실패일 때 그 이름이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Section {
    /// EKS DescribeCluster(VPC ID)
    Cluster,
    Services,
    Ingresses,
    Nodes,
    Pods,
    Policies,
    Namespaces,
    Instances,
    Subnets,
    LoadBalancers,
    Listeners,
    TargetGroups,
    TargetHealth,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub section: Section,
    pub subject: Option<String>,
    pub error: AppError,
}

/// 화면 안에서 쿠버네티스 객체 하나를 가리킨다(링크).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectLink {
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Service,
    Ingress,
}

/// 쿠버네티스에서 로드 밸런서를 요구하는 객체: type이 LoadBalancer인 Service나 Ingress.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LbSource {
    pub kind: SourceKind,
    pub namespace: String,
    pub name: String,
    /// Service의 `loadBalancerClass`, Ingress의 `ingressClassName`(없으면 옛 어노테이션)
    pub class: Option<String>,
    /// `status.loadBalancer.ingress[].hostname`
    pub hostnames: Vec<String>,
    /// `status.loadBalancer.ingress[].ip`(호스트명이 없는 IP형 주소)
    pub ips: Vec<String>,
    /// Service는 `80/TCP`꼴 포트, Ingress는 `host/path → service:port`꼴 규칙
    pub ports: Vec<String>,
    /// Ingress 그룹 이름(`alb.ingress.kubernetes.io/group.name`). 그룹이면 `ingress.k8s.aws/stack` 태그가 이 이름이다.
    pub group: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LbKind {
    Application,
    Network,
    Gateway,
}

/// DescribeLoadBalancers와 DescribeTags로 읽은 로드 밸런서(짝을 찾는 데 쓰는 값).
#[derive(Debug, Clone, PartialEq)]
pub struct AwsLb {
    pub arn: String,
    pub name: String,
    pub dns_name: String,
    pub kind: Option<LbKind>,
    pub scheme: Option<String>,
    pub state: Option<String>,
    pub vpc_id: Option<String>,
    pub zones: Vec<LbZone>,
    pub security_groups: Vec<String>,
    pub tags: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LbZone {
    pub zone: String,
    pub subnet_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchedBy {
    /// status 호스트명이 로드 밸런서의 DNS 이름과 같다
    Hostname,
    /// AWS Load Balancer Controller 태그(클러스터 + stack)가 맞다
    Tag,
    /// 둘 다 같은 로드 밸런서를 가리킨다
    Both,
}

/// 짝을 찾지 못한 이유
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Unmatched {
    /// status에 주소가 아직 없다(만드는 중이거나 컨트롤러가 없다)
    Pending,
    /// 주소는 있는데 ELBv2에서 찾지 못했다(클래식 로드 밸런서일 수 있다)
    NotFound,
    /// AWS를 읽지 못해 찾아보지 못했다
    AwsUnavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerView {
    pub arn: String,
    pub protocol: String,
    pub port: i32,
    pub ssl_policy: Option<String>,
    /// 기본 동작 한 줄(`forward → web-tg`, `redirect → HTTPS:443`)
    pub default_action: String,
    /// 기본 규칙을 뺀 규칙(ALB만). 우선순위 순
    pub rules: Vec<RuleView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleView {
    pub priority: String,
    pub conditions: String,
    pub action: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetView {
    pub id: String,
    pub port: Option<i32>,
    pub zone: Option<String>,
    /// healthy, unhealthy, initial, draining, unused, unavailable
    pub state: String,
    pub reason: Option<String>,
    pub description: Option<String>,
    /// 인스턴스 ID면 노드, IP면 Pod
    pub link: Option<ObjectLink>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheck {
    pub protocol: Option<String>,
    /// 숫자나 `traffic-port`
    pub port: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetGroupView {
    pub arn: String,
    pub name: String,
    pub protocol: Option<String>,
    pub port: Option<i32>,
    /// instance, ip, lambda, alb
    pub target_type: Option<String>,
    /// 상태 확인 설정. 끄면 None
    pub health_check: Option<HealthCheck>,
    pub targets: Vec<TargetView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadBalancerView {
    pub arn: String,
    pub name: String,
    pub dns_name: String,
    pub kind: Option<LbKind>,
    pub scheme: Option<String>,
    pub state: Option<String>,
    pub vpc_id: Option<String>,
    pub zones: Vec<LbZone>,
    pub security_groups: Vec<String>,
    pub listeners: Vec<ListenerView>,
    pub target_groups: Vec<TargetGroupView>,
    /// 이 로드 밸런서의 리스너·대상 그룹을 읽지 못한 이유
    pub gaps: Vec<Gap>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LbRow {
    #[serde(flatten)]
    pub source: LbSource,
    pub load_balancer: Option<LoadBalancerView>,
    pub matched_by: Option<MatchedBy>,
    pub unmatched: Option<Unmatched>,
}

/// 이 클러스터 태그가 붙었지만 어떤 Service·Ingress도 가리키지 않는 로드 밸런서
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnclaimedLb {
    pub arn: String,
    pub name: String,
    pub dns_name: String,
    pub kind: Option<LbKind>,
    pub scheme: Option<String>,
    pub state: Option<String>,
    /// `service.k8s.aws/stack`나 `ingress.k8s.aws/stack` 태그 값
    pub stack: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeNet {
    pub name: String,
    pub ready: bool,
    pub provider_id: Option<String>,
    /// providerID가 `aws:///<az>/i-…`일 때의 인스턴스 ID
    pub instance_id: Option<String>,
    /// Fargate 노드(`fargate-ip-…`)는 인스턴스가 없다
    pub fargate: bool,
    pub instance_type: Option<String>,
    pub internal_ip: Option<String>,
    /// EC2 Placement, 없으면 노드의 zone 레이블, 없으면 providerID의 zone
    pub zone: Option<String>,
    /// EC2가 알려 준 인스턴스 상태(running 등). 읽지 못했으면 None
    pub instance_state: Option<String>,
    pub subnet_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubnetNet {
    pub id: String,
    pub name: Option<String>,
    pub zone: Option<String>,
    pub cidrs: Vec<String>,
    /// DescribeSubnets의 남은 IP 수(IPv4)
    pub available_ips: Option<i32>,
    /// IPv4 CIDR의 사용 가능한 주소 수(AWS가 5개를 예약한다)
    pub capacity: Option<u64>,
    /// 이 서브넷에 있는 노드 수
    pub node_count: usize,
    /// 이 서브넷의 IP를 받은 Pod 수. VPC CNI가 아니면 None
    pub pod_count: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodNet {
    pub namespace: String,
    pub name: String,
    pub ip: String,
    pub node: Option<String>,
    /// hostNetwork Pod의 IP는 노드 IP다. 서브넷 Pod 수에 세지 않는다.
    pub host_network: bool,
    pub subnet_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodsNet {
    /// kube-system의 aws-node(VPC CNI)가 있는지
    pub vpc_cni: bool,
    pub items: Vec<PodNet>,
    /// IP가 있는데 아는 서브넷 어디에도 속하지 않는 Pod 수(VPC CNI일 때만 센다)
    pub outside: usize,
    /// Pod 목록이 쪽 수 한도에서 잘렸다
    pub partial: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortRule {
    pub protocol: String,
    /// 숫자나 이름. 없으면 모든 포트
    pub port: Option<String>,
    pub end_port: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpBlock {
    pub cidr: String,
    pub except: Vec<String>,
}

/// NetworkPolicyPeer 하나. 빈 문자열 셀렉터는 "모두"다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub pod_selector: Option<String>,
    pub namespace_selector: Option<String>,
    pub ip_block: Option<IpBlock>,
}

/// 규칙 하나. peers와 ports가 모두 비면 모든 곳 모든 포트를 허용한다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRule {
    pub peers: Vec<Peer>,
    pub ports: Vec<PortRule>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyView {
    pub namespace: String,
    pub name: String,
    /// 빈 문자열이면 네임스페이스의 모든 Pod
    pub pod_selector: String,
    /// 정책이 다루는 방향(`Ingress`, `Egress`). 비워 두면 쿠버네티스 기본값을 적용한 값이다.
    pub types: Vec<String>,
    pub ingress: Vec<PolicyRule>,
    pub egress: Vec<PolicyRule>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespacePolicies {
    pub name: String,
    pub policies: usize,
    /// kube-system, kube-public, kube-node-lease, amazon-*
    pub system: bool,
}

/// 네트워크 화면 한 장. 부분마다 읽지 못한 이유는 `gaps`에 담고 나머지는 그대로 돌려준다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub vpc_id: Option<String>,
    pub load_balancers: Option<Vec<LbRow>>,
    pub unclaimed: Vec<UnclaimedLb>,
    pub nodes: Option<Vec<NodeNet>>,
    pub subnets: Option<Vec<SubnetNet>>,
    pub pods: Option<PodsNet>,
    pub policies: Option<Vec<PolicyView>>,
    pub namespaces: Option<Vec<NamespacePolicies>>,
    /// VPC 다이어그램에서 강조할 리소스 ID: 노드의 인스턴스 ID와 로드 밸런서 ARN
    pub highlight: Vec<String>,
    pub gaps: Vec<Gap>,
}
