import type { DetailData } from "../lib/detail";
import { TIER_LABEL } from "./layout";
import type { GatewayInfo, NodeResource, PeeringInfo, RouteInfo, SubnetInfo, VpcTopology } from "./types";

const KIND_NAME: Record<NodeResource["kind"], string> = {
  ec2: "EC2 인스턴스",
  nat: "NAT 게이트웨이",
  rds: "RDS",
  elb: "로드 밸런서",
  lambda: "Lambda 함수",
  vpce: "인터페이스 엔드포인트",
};

const isDefaultRoute = (r: RouteInfo) => r.destination === "0.0.0.0/0" || r.destination === "::/0";

/** 서브넷의 라우팅 테이블에서 기본 경로가 가리키는 대상 id들 (blackhole 제외) */
export function defaultRouteTargets(t: VpcTopology, subnet: SubnetInfo | null): string[] {
  if (!subnet) return [];
  const rt = t.routeTables.find((r) => r.id === subnet.routeTableId);
  return (rt?.routes ?? []).filter((r) => isDefaultRoute(r) && r.state !== "blackhole" && r.targetKind !== "local").map((r) => r.target);
}

/** 게이트웨이 칩이 라우트 대상과 같은지 (TGW attachment는 name/label에 TGW id가 들어온다) */
export function gatewayMatchesTarget(g: GatewayInfo, target: string) {
  return g.id === target || g.label === target || g.name.includes(target);
}

export function subnetDetail(t: VpcTopology, s: SubnetInfo): DetailData {
  const rt = t.routeTables.find((r) => r.id === s.routeTableId);
  const rows = [
    { label: "Subnet ID", value: s.id },
    { label: "AZ", value: s.az },
    { label: "CIDR", value: s.cidr },
    { label: "구분", value: TIER_LABEL[s.tier] },
  ];
  if (s.availableIps !== null) rows.push({ label: "남은 IP", value: String(s.availableIps) });
  if (rt) rows.push({ label: "라우팅 테이블", value: `${rt.id}${rt.name && rt.name !== rt.id ? ` (${rt.name})` : ""}${rt.main ? " · main" : ""}` });
  (rt?.routes ?? []).forEach((r, i) => {
    rows.push({ label: `경로 ${i + 1}`, value: `${r.destination} → ${r.target}${r.state !== "active" ? ` (${r.state})` : ""}` });
  });
  return {
    title: s.name || s.id,
    subtitle: `서브넷 · ${TIER_LABEL[s.tier]}`,
    rows,
    tags: s.tags,
    copy: { label: "ID", value: s.id },
    consoleUrl: null,
    raw: null,
  };
}

export function resourceNodeDetail(r: NodeResource): DetailData {
  return {
    title: r.name || r.id,
    subtitle: KIND_NAME[r.kind],
    rows: [{ label: "State", value: r.state }, ...r.fields],
    tags: {},
    copy: { label: "ID", value: r.id },
    consoleUrl: r.consoleUrl,
    raw: null,
  };
}

export function gatewayDetail(g: GatewayInfo): DetailData {
  const rows = [
    { label: "ID", value: g.id },
    { label: "종류", value: g.kind },
    { label: "State", value: g.state },
  ];
  if (g.label) rows.push({ label: "Label", value: g.label });
  return { title: g.name || g.id, subtitle: "게이트웨이", rows, tags: {}, copy: { label: "ID", value: g.id }, consoleUrl: null, raw: null };
}

export function peeringDetail(p: PeeringInfo): DetailData {
  const rows = [
    { label: "Peering ID", value: p.id },
    { label: "상대 VPC", value: p.peerVpcId },
  ];
  if (p.peerCidr) rows.push({ label: "상대 CIDR", value: p.peerCidr });
  if (p.peerOwnerId) rows.push({ label: "상대 계정", value: p.peerOwnerId });
  if (p.peerRegion) rows.push({ label: "상대 리전", value: p.peerRegion });
  rows.push({ label: "Status", value: p.status });
  return { title: p.id, subtitle: "VPC 피어링", rows, tags: {}, copy: { label: "ID", value: p.id }, consoleUrl: null, raw: null };
}
