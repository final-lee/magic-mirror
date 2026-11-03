import type { NodeKind, Tier } from "./types";

// SVG와 PNG 내보내기에서 같은 테마 색을 쓴다.
export const C = {
  bg: "var(--bg)",
  text: "var(--text)",
  dim: "var(--dim)",
  vpc: "var(--map-purple)",
  vpcFill: "var(--accent-soft)",
  accent: "var(--accent)",
  route: "var(--yellow)",
  tile: "var(--surface-2)",
  tileLine: "var(--line)",
  ok: "var(--green)",
  bad: "var(--red)",
  warn: "var(--yellow)",
  /** 호출한 쪽(예: EKS 탭)이 강조한 리소스 */
  highlight: "var(--badge-pink)",
};

export const TIER_COLOR: Record<Tier, { stroke: string; fill: string; lane: string; text: string }> = {
  public: { stroke: "var(--green)", fill: "var(--green-soft)", lane: "var(--green-soft)", text: "var(--green)" },
  private: { stroke: "var(--accent)", fill: "var(--accent-soft)", lane: "var(--accent-soft)", text: "var(--accent)" },
  isolated: { stroke: "var(--dim)", fill: "var(--hover)", lane: "var(--hover)", text: "var(--dim)" },
};

export const KIND_BADGE: Record<NodeKind, { label: string; color: string }> = {
  ec2: { label: "EC2", color: "var(--badge-orange)" },
  nat: { label: "NAT", color: "var(--badge-purple)" },
  rds: { label: "RDS", color: "var(--badge-blue)" },
  elb: { label: "ELB", color: "var(--badge-purple)" },
  lambda: { label: "λ", color: "var(--badge-orange)" },
  vpce: { label: "VPCE", color: "var(--badge-purple)" },
};

export const CHIP_BADGE_COLOR: Record<string, string> = {
  IGW: "var(--badge-green)",
  EIGW: "var(--badge-green)",
  VGW: "var(--badge-purple)",
  TGW: "var(--badge-purple)",
  EP: "var(--badge-green)",
  PCX: "var(--badge-pink)",
};

export function stateColor(state: string): string {
  const s = state.toLowerCase();
  if (["running", "available", "active", "in-service", "attached", "ok"].includes(s)) return C.ok;
  if (["stopped", "failed", "deleted", "deleting", "terminated", "blackhole", "rejected", "inactive"].includes(s)) return C.bad;
  return C.warn;
}
