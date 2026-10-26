// 백엔드 계약(.superpowers/sdd/p3/contract.md)과 1:1로 맞춘 타입
export type Tier = "public" | "private" | "isolated";
export type TargetKind = "local" | "igw" | "nat" | "tgw" | "vgw" | "pcx" | "eigw" | "vpce" | "eni" | "instance" | "other";
export type GatewayKind = "igw" | "eigw" | "vgw" | "tgw" | "vpce-gateway";
export type NodeKind = "ec2" | "nat" | "rds" | "elb" | "lambda" | "vpce";

export interface VpcInfo {
  id: string;
  name: string;
  cidrs: string[];
  isDefault: boolean;
  state: string;
}
export interface SubnetInfo {
  id: string;
  name: string;
  az: string;
  cidr: string;
  tier: Tier;
  routeTableId: string | null;
  availableIps: number | null;
  tags: Record<string, string>;
}
export interface RouteInfo {
  destination: string;
  target: string;
  targetKind: TargetKind;
  state: string;
}
export interface RouteTableInfo {
  id: string;
  name: string;
  main: boolean;
  subnetIds: string[];
  routes: RouteInfo[];
}
export interface GatewayInfo {
  id: string;
  name: string;
  kind: GatewayKind;
  label: string;
  state: string;
}
export interface PeeringInfo {
  id: string;
  peerVpcId: string;
  peerCidr: string | null;
  peerOwnerId: string | null;
  peerRegion: string | null;
  status: string;
}
export interface NodeResource {
  id: string;
  name: string;
  kind: NodeKind;
  subnetIds: string[];
  state: string;
  fields: { label: string; value: string }[];
  consoleUrl: string | null;
}
export interface VpcTopology {
  vpc: VpcInfo;
  azs: string[];
  subnets: SubnetInfo[];
  routeTables: RouteTableInfo[];
  gateways: GatewayInfo[];
  peerings: PeeringInfo[];
  resources: NodeResource[];
  warnings: string[];
}
