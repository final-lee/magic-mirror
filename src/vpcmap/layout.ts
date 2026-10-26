import type { GatewayInfo, NodeKind, NodeResource, PeeringInfo, SubnetInfo, Tier, VpcTopology } from "./types";

// ── 치수 상수 ──
export const PAD = 28; // 캔버스 바깥 여백
export const TOP_BAND = 24; // VPC 위 테두리 위로 튀어나오는 게이트웨이 칩 공간
export const VPC_HEADER = 48; // VPC 제목 줄
export const AZ_HEADER = 32; // AZ 이름 줄
export const LABEL_W = 92; // 왼쪽 tier 라벨 열
export const COL_PAD = 12; // 칸 안쪽 여백
export const LANE_PAD = 10; // tier 행 위아래 여백
export const SUBNET_W = 268;
export const COL_W = SUBNET_W + COL_PAD * 2;
export const SUBNET_PAD = 10;
export const SUBNET_HEADER = 46;
export const SUBNET_GAP = 12;
export const TILE_W = 56;
export const TILE_H = 62;
export const TILE_GAP = 8;
export const TILES_PER_ROW = 4;
export const MAX_TILES = 12;
export const CHIP_H = 30;
export const CHIP_GAP = 10;
export const BAND_HEADER = 28;
export const BAND_PAD = 14;
export const MIN_VPC_W = 560;
export const LEGEND_H = 26;
export const ROUTE_LEGEND_LABEL = "기본 경로 대상";

export const TIER_ORDER: Tier[] = ["public", "private", "isolated"];
export const TIER_LABEL: Record<Tier, string> = { public: "퍼블릭", private: "프라이빗", isolated: "격리" };
const KIND_ORDER: NodeKind[] = ["elb", "nat", "ec2", "rds", "lambda", "vpce"];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface TileLayout extends Box {
  key: string;
  subnetId: string;
  /** 일반 타일이면 리소스, "+N" 타일이면 null */
  resource: NodeResource | null;
  overflow: number;
}
export interface SubnetLayout extends Box {
  subnet: SubnetInfo;
  tiles: TileLayout[];
}
export interface ChipLayout extends Box {
  key: string;
  band: "top" | "bottom";
  kind: "gateway" | "peering";
  id: string;
  badge: string;
  text: string;
  gateway: GatewayInfo | null;
  peering: PeeringInfo | null;
}
export type LegendKey = Tier | "route";
export interface LegendItem {
  key: LegendKey;
  label: string;
  /** 색 견본의 x (범례 박스 기준이 아닌 절대 좌표) */
  x: number;
  textX: number;
}
export interface LegendLayout extends Box {
  items: LegendItem[];
}
export interface Layout {
  width: number;
  height: number;
  vpc: Box;
  azHeaders: (Box & { az: string })[];
  lanes: (Box & { tier: Tier; label: string })[];
  subnets: SubnetLayout[];
  chips: ChipLayout[];
  /** 아래쪽 "외부 연결" 띠 (칩이 없으면 null) */
  band: Box | null;
  /** VPC 안쪽 오른쪽 아래 범례 (PNG 내보내기에도 포함된다) */
  legend: LegendLayout;
}

const ellipsize = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function chipWidth(badge: string, text: string) {
  return Math.round(18 + badge.length * 7 + 10 + text.length * 6.4 + 6);
}

function gatewayChip(g: GatewayInfo): Pick<ChipLayout, "badge" | "text"> {
  switch (g.kind) {
    case "igw":
      return { badge: "IGW", text: ellipsize(g.name || g.id, 28) };
    case "eigw":
      return { badge: "EIGW", text: ellipsize(g.name || g.id, 28) };
    case "vgw":
      return { badge: "VGW", text: ellipsize(g.name || g.id, 28) };
    case "tgw":
      return { badge: "TGW", text: ellipsize(g.label || g.name || g.id, 28) };
    case "vpce-gateway":
      return { badge: "EP", text: ellipsize(`${g.label || g.name || g.id} endpoint`, 28) };
  }
}

export function layoutTopology(t: VpcTopology): Layout {
  const azs = t.azs;
  const colCount = Math.max(1, azs.length);

  // 1) 서브넷별 타일
  const tilesBySubnet = new Map<string, NodeResource[]>();
  for (const r of t.resources) {
    for (const id of r.subnetIds) {
      const list = tilesBySubnet.get(id) ?? [];
      list.push(r);
      tilesBySubnet.set(id, list);
    }
  }
  const sortedRes = (id: string) =>
    [...(tilesBySubnet.get(id) ?? [])].sort(
      (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
  const subnetHeight = (s: SubnetInfo) => {
    const n = Math.min(tilesBySubnet.get(s.id)?.length ?? 0, MAX_TILES);
    const rows = Math.ceil(n / TILES_PER_ROW);
    return SUBNET_HEADER + (rows > 0 ? rows * TILE_H + (rows - 1) * TILE_GAP : 0) + SUBNET_PAD;
  };

  // 2) 존재하는 tier 행과 칸(AZ×tier)별 서브넷
  const tiers = TIER_ORDER.filter((tier) => t.subnets.some((s) => s.tier === tier));
  const cell = (tier: Tier, az: string) => t.subnets.filter((s) => s.tier === tier && s.az === az);
  const cellHeight = (list: SubnetInfo[]) =>
    list.reduce((sum, s) => sum + subnetHeight(s), 0) + Math.max(0, list.length - 1) * SUBNET_GAP;
  const laneHeights = tiers.map((tier) => Math.max(0, ...azs.map((az) => cellHeight(cell(tier, az)))) + LANE_PAD * 2);

  // 3) 칩 크기 (위: igw/eigw/vgw, 아래: 나머지)
  const topGws = t.gateways.filter((g) => g.kind === "igw" || g.kind === "eigw" || g.kind === "vgw");
  const bottomGws = t.gateways.filter((g) => !topGws.includes(g));
  const topChips = topGws.map((g) => {
    const c = gatewayChip(g);
    return { g, ...c, w: chipWidth(c.badge, c.text) };
  });
  const bottomItems = [
    ...bottomGws.map((g) => {
      const c = gatewayChip(g);
      return { key: `gw:${g.id}`, id: g.id, kind: "gateway" as const, g, p: null as PeeringInfo | null, ...c, w: chipWidth(c.badge, c.text) };
    }),
    ...t.peerings.map((p) => {
      const badge = "PCX";
      const text = ellipsize(`→ ${p.peerVpcId}${p.peerCidr ? ` ${p.peerCidr}` : ""}`, 34);
      return { key: `pcx:${p.id}`, id: p.id, kind: "peering" as const, g: null as GatewayInfo | null, p, badge, text, w: chipWidth(badge, text) };
    }),
  ];

  // 4) VPC 폭
  const topWidth = topChips.reduce((s, c) => s + c.w, 0) + Math.max(0, topChips.length - 1) * CHIP_GAP;
  const vpcW = Math.max(LABEL_W + colCount * COL_W + COL_PAD, MIN_VPC_W, topChips.length ? topWidth + 280 : 0);
  const vpcX = PAD;
  const vpcY = PAD + TOP_BAND;

  // 5) 가로줄/AZ 헤더/서브넷 배치
  const azHeaders = azs.map((az, i) => ({ az, x: vpcX + LABEL_W + i * COL_W, y: vpcY + VPC_HEADER, w: COL_W, h: AZ_HEADER }));
  let y = vpcY + VPC_HEADER + AZ_HEADER;
  const lanes: Layout["lanes"] = [];
  const subnets: SubnetLayout[] = [];
  tiers.forEach((tier, ti) => {
    lanes.push({ tier, label: TIER_LABEL[tier], x: vpcX + 8, y, w: vpcW - 16, h: laneHeights[ti] });
    azs.forEach((az, ai) => {
      let sy = y + LANE_PAD;
      for (const s of cell(tier, az)) {
        const h = subnetHeight(s);
        const sx = vpcX + LABEL_W + ai * COL_W + COL_PAD;
        const res = sortedRes(s.id);
        const shown = res.length > MAX_TILES ? res.slice(0, MAX_TILES - 1) : res;
        const tiles: TileLayout[] = shown.map((r, i) => ({
          key: `${s.id}:${r.id}`,
          subnetId: s.id,
          resource: r,
          overflow: 0,
          ...tilePos(sx, sy, i),
        }));
        if (res.length > MAX_TILES) {
          tiles.push({
            key: `${s.id}:+more`,
            subnetId: s.id,
            resource: null,
            overflow: res.length - (MAX_TILES - 1),
            ...tilePos(sx, sy, MAX_TILES - 1),
          });
        }
        subnets.push({ subnet: s, x: sx, y: sy, w: SUBNET_W, h, tiles });
        sy += h + SUBNET_GAP;
      }
    });
    y += laneHeights[ti] + 6;
  });
  if (tiers.length === 0) y += 24;

  // 6) 칩 배치
  const chips: ChipLayout[] = [];
  let cx = vpcX + vpcW - 24;
  for (const c of [...topChips].reverse()) {
    cx -= c.w;
    chips.push({
      key: `gw:${c.g.id}`, band: "top", kind: "gateway", id: c.g.id, badge: c.badge, text: c.text,
      gateway: c.g, peering: null, x: cx, y: vpcY - CHIP_H / 2, w: c.w, h: CHIP_H,
    });
    cx -= CHIP_GAP;
  }

  let band: Box | null = null;
  let bandBottom = y;
  if (bottomItems.length > 0) {
    const bandY = y + 4;
    const maxX = vpcX + vpcW - BAND_PAD * 2;
    let bx = vpcX + BAND_PAD * 2;
    let by = bandY + BAND_HEADER;
    for (const it of bottomItems) {
      if (bx + it.w > maxX && bx > vpcX + BAND_PAD * 2) {
        bx = vpcX + BAND_PAD * 2;
        by += CHIP_H + CHIP_GAP;
      }
      chips.push({
        key: it.key, band: "bottom", kind: it.kind, id: it.id, badge: it.badge, text: it.text,
        gateway: it.g, peering: it.p, x: bx, y: by, w: it.w, h: CHIP_H,
      });
      bx += it.w + CHIP_GAP;
    }
    const bandH = by + CHIP_H + BAND_PAD - bandY;
    band = { x: vpcX + 8, y: bandY, w: vpcW - 16, h: bandH };
    bandBottom = bandY + bandH + 6;
  }

  const vpcH = bandBottom + 10 + LEGEND_H + 8 - vpcY;
  const legend = layoutLegend(vpcX + vpcW - 14, vpcY + vpcH - LEGEND_H - 8);
  return {
    width: vpcX + vpcW + PAD,
    height: vpcY + vpcH + PAD,
    vpc: { x: vpcX, y: vpcY, w: vpcW, h: vpcH },
    azHeaders,
    lanes,
    subnets,
    chips,
    band,
    legend,
  };
}

const textW = (s: string) => Math.round(s.length * 11.5);

function layoutLegend(right: number, y: number): LegendLayout {
  const entries: { key: LegendKey; label: string }[] = [
    ...TIER_ORDER.map((tier) => ({ key: tier as LegendKey, label: TIER_LABEL[tier] })),
    { key: "route", label: ROUTE_LEGEND_LABEL },
  ];
  const widths = entries.map((e) => 12 + 6 + textW(e.label));
  const gap = 14;
  const inner = widths.reduce((a, b) => a + b, 0) + gap * (entries.length - 1);
  const w = inner + 20;
  const x = right - w;
  let cx = x + 10;
  const items = entries.map((e, i) => {
    const item = { key: e.key, label: e.label, x: cx, textX: cx + 18 };
    cx += widths[i] + gap;
    return item;
  });
  return { x, y, w, h: LEGEND_H, items };
}

function tilePos(sx: number, sy: number, i: number) {
  const col = i % TILES_PER_ROW;
  const row = Math.floor(i / TILES_PER_ROW);
  return {
    x: sx + SUBNET_PAD + col * (TILE_W + TILE_GAP),
    y: sy + SUBNET_HEADER + row * (TILE_H + TILE_GAP),
    w: TILE_W,
    h: TILE_H,
  };
}
