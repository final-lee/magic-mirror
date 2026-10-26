import type { NodeKind, Tier } from "./types";

// SVG 안에서만 쓰는 고정 색(CSS 변수는 PNG로 내보낼 때 풀리지 않는다)
export const C = {
  bg: "#1b1b1e",
  text: "#e6e6e8",
  dim: "#9a9aa0",
  vpc: "#8c4fff",
  vpcFill: "#8c4fff0d",
  accent: "#0a84ff",
  route: "#ffb340",
  tile: "#2b2b2e",
  tileLine: "#4a4a4e",
  ok: "#30d158",
  bad: "#ff6b61",
  warn: "#ffd60a",
};

export const TIER_COLOR: Record<Tier, { stroke: string; fill: string; lane: string; text: string }> = {
  public: { stroke: "#4cc26a", fill: "#30d15814", lane: "#30d1580a", text: "#7fe09a" },
  private: { stroke: "#4c8dff", fill: "#0a84ff14", lane: "#0a84ff0a", text: "#8ab6ff" },
  isolated: { stroke: "#8e8e93", fill: "#8e8e9314", lane: "#8e8e930a", text: "#b4b4ba" },
};

export const KIND_BADGE: Record<NodeKind, { label: string; color: string }> = {
  ec2: { label: "EC2", color: "#f58536" },
  nat: { label: "NAT", color: "#8c4fff" },
  rds: { label: "RDS", color: "#3b48cc" },
  elb: { label: "ELB", color: "#8c4fff" },
  lambda: { label: "λ", color: "#ed7100" },
  vpce: { label: "VPCE", color: "#8c4fff" },
};

export const CHIP_BADGE_COLOR: Record<string, string> = {
  IGW: "#4cc26a",
  EIGW: "#4cc26a",
  VGW: "#8c4fff",
  TGW: "#8c4fff",
  EP: "#3f8624",
  PCX: "#e7157b",
};

export function stateColor(state: string): string {
  const s = state.toLowerCase();
  if (["running", "available", "active", "in-service", "attached", "ok"].includes(s)) return C.ok;
  if (["stopped", "failed", "deleted", "deleting", "terminated", "blackhole", "rejected", "inactive"].includes(s)) return C.bad;
  return C.warn;
}
