import type { AppError } from "../../api/types";
import type { VpcHighlight } from "../../vpcmap/types";

// 백엔드 `src-tauri/src/k8s/network/model.rs`와 같은 모양(camelCase)

export type NetworkSection =
  | "cluster" | "services" | "ingresses" | "nodes" | "pods" | "policies" | "namespaces"
  | "instances" | "subnets" | "loadBalancers" | "listeners" | "targetGroups" | "targetHealth";

export interface NetworkGap {
  section: NetworkSection;
  /** 로드 밸런서 하나에만 해당하는 실패면 그 이름 */
  subject: string | null;
  error: AppError;
}

export interface ObjectLink {
  kind: string;
  namespace: string | null;
  name: string;
}

export type SourceKind = "service" | "ingress";
export type LbKind = "application" | "network" | "gateway";
export type MatchedBy = "hostname" | "tag" | "both";
export type Unmatched = "pending" | "notFound" | "awsUnavailable";

export interface LbZone {
  zone: string;
  subnetId: string | null;
}

export interface RuleView {
  priority: string;
  conditions: string;
  action: string;
}

export interface ListenerView {
  arn: string;
  protocol: string;
  port: number;
  sslPolicy: string | null;
  defaultAction: string;
  rules: RuleView[];
}

export interface TargetView {
  id: string;
  port: number | null;
  zone: string | null;
  /** healthy, unhealthy, initial, draining, unused, unavailable */
  state: string;
  reason: string | null;
  description: string | null;
  link: ObjectLink | null;
}

export interface HealthCheck {
  protocol: string | null;
  port: string | null;
  path: string | null;
}

export interface TargetGroupView {
  arn: string;
  name: string;
  protocol: string | null;
  port: number | null;
  targetType: string | null;
  healthCheck: HealthCheck | null;
  targets: TargetView[];
}

export interface LoadBalancerView {
  arn: string;
  name: string;
  dnsName: string;
  kind: LbKind | null;
  scheme: string | null;
  state: string | null;
  vpcId: string | null;
  zones: LbZone[];
  securityGroups: string[];
  listeners: ListenerView[];
  targetGroups: TargetGroupView[];
  gaps: NetworkGap[];
}

export interface LbRow {
  kind: SourceKind;
  namespace: string;
  name: string;
  class: string | null;
  hostnames: string[];
  ips: string[];
  ports: string[];
  group: string | null;
  loadBalancer: LoadBalancerView | null;
  matchedBy: MatchedBy | null;
  unmatched: Unmatched | null;
}

export interface UnclaimedLb {
  arn: string;
  name: string;
  dnsName: string;
  kind: LbKind | null;
  scheme: string | null;
  state: string | null;
  stack: string | null;
}

export interface NodeNet {
  name: string;
  ready: boolean;
  providerId: string | null;
  instanceId: string | null;
  fargate: boolean;
  instanceType: string | null;
  internalIp: string | null;
  zone: string | null;
  instanceState: string | null;
  subnetId: string | null;
}

export interface SubnetNet {
  id: string;
  name: string | null;
  zone: string | null;
  cidrs: string[];
  availableIps: number | null;
  capacity: number | null;
  nodeCount: number;
  /** VPC CNI가 아니면 null */
  podCount: number | null;
}

export interface PodNet {
  namespace: string;
  name: string;
  ip: string;
  node: string | null;
  hostNetwork: boolean;
  subnetId: string | null;
}

export interface PodsNet {
  vpcCni: boolean;
  items: PodNet[];
  outside: number;
  partial: boolean;
}

export interface PortRule {
  protocol: string;
  port: string | null;
  endPort: number | null;
}

export interface IpBlock {
  cidr: string;
  except: string[];
}

export interface Peer {
  podSelector: string | null;
  namespaceSelector: string | null;
  ipBlock: IpBlock | null;
}

export interface PolicyRule {
  peers: Peer[];
  ports: PortRule[];
}

export interface PolicyView {
  namespace: string;
  name: string;
  podSelector: string;
  types: string[];
  ingress: PolicyRule[];
  egress: PolicyRule[];
  createdAt: string | null;
}

export interface NamespacePolicies {
  name: string;
  policies: number;
  system: boolean;
}

export interface Network {
  vpcId: string | null;
  loadBalancers: LbRow[] | null;
  unclaimed: UnclaimedLb[];
  nodes: NodeNet[] | null;
  subnets: SubnetNet[] | null;
  pods: PodsNet | null;
  policies: PolicyView[] | null;
  namespaces: NamespacePolicies[] | null;
  /** VPC 다이어그램에서 강조할 리소스 ID: 노드의 인스턴스 ID와 로드 밸런서 ARN */
  highlight: string[];
  gaps: NetworkGap[];
}

export interface VpcOpen {
  vpcId: string;
  name: string;
  region: string;
  highlight?: VpcHighlight;
}
