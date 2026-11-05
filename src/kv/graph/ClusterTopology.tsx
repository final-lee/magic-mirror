import { useMemo } from "react";
import { formatBytes } from "../../lib/format";
import { formatCount } from "../format";
import * as t from "../text";
import type { KvClient } from "../types";
import { buildClusterTopology, type ClusterTopology as Topology, type TopoNode } from "./clusterModel";
import { GraphCanvas, GraphEdgeLine } from "./GraphCanvas";
import type { KvOverview } from "../types";

const HOST_W = 176;
const HOST_H = 26;
const HOST_GAP = 4;
const NODE_W = 292;
const NODE_H = 64;
const NODE_GAP = 30;
const GROUP_PAD = 14;
const GROUP_HEAD = 24;
const GROUP_GAP = 20;
const PAD = 24;
const COL_GAP = 190;

/** 긴 호스트 이름은 첫 마디만(IP는 그대로): `cart-0001-001.cart.x1y2z3…:6379` → `cart-0001-001:6379` */
export function shortAddress(addr: string): string {
  if (/^[\d.:[\]]+$/.test(addr)) return addr;
  const at = addr.lastIndexOf(":");
  const host = at > 0 ? addr.slice(0, at) : addr;
  const port = at > 0 ? addr.slice(at) : "";
  return `${host.split(".")[0]}${port}`;
}

const compact = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : formatCount(n));

interface Geometry {
  width: number;
  height: number;
  groups: { id: string; label: string; x: number; y: number; w: number; h: number; nodes: { node: TopoNode; x: number; y: number }[] }[];
  hosts: { id: string; x: number; y: number }[];
  nodePos: Map<string, { x: number; y: number }>;
}

/** 호스트는 왼쪽 열에 위에서부터, 샤드(복제 그룹)는 오른쪽 열에 위에서부터 쌓는다. 샤드 안은 기본 노드가 위, 복제 노드가 그 아래. */
function place(topology: Topology): Geometry {
  const hostsH = topology.hosts.length * (HOST_H + HOST_GAP) - (topology.hosts.length > 0 ? HOST_GAP : 0);
  const gx = PAD + (topology.hosts.length > 0 ? HOST_W + COL_GAP : 0);
  let y = PAD;
  const nodePos = new Map<string, { x: number; y: number }>();
  const groups = topology.groups.map((g) => {
    const h = GROUP_HEAD + g.nodes.length * NODE_H + (g.nodes.length - 1) * NODE_GAP + GROUP_PAD * 2 - GROUP_HEAD / 2;
    const placed = g.nodes.map((node, i) => {
      const pos = { x: gx + GROUP_PAD, y: y + GROUP_HEAD + i * (NODE_H + NODE_GAP) };
      nodePos.set(node.address, pos);
      return { node, ...pos };
    });
    const box = { id: g.id, label: g.label, x: gx, y, w: NODE_W + GROUP_PAD * 2, h, nodes: placed };
    y += h + GROUP_GAP;
    return box;
  });
  const groupsH = y - GROUP_GAP - PAD;
  // 호스트 열은 샤드 열보다 짧으면 가운데로 맞춘다
  const hostTop = PAD + Math.max(0, (groupsH - hostsH) / 2);
  return {
    width: gx + NODE_W + GROUP_PAD * 2 + PAD,
    height: Math.max(groupsH, hostsH) + PAD * 2,
    groups,
    hosts: topology.hosts.map((h, i) => ({ id: h.id, x: PAD, y: hostTop + i * (HOST_H + HOST_GAP) })),
    nodePos,
  };
}

interface Props {
  overview: KvOverview;
  /** CLIENT LIST. 아직 읽는 중이거나 읽지 못했으면 null */
  clients: readonly KvClient[] | null;
  /** 안내(읽는 중, 못 읽음, 서버리스) */
  note?: string;
}

/**
 * 토폴로지 그래프: 샤드(클러스터 모드가 아니면 복제 그룹)를 묶음으로, 기본 노드 → 복제 노드(복제 지연이 간선의 글)로 그리고 기본 노드에 슬롯 범위, 노드마다 메모리·초당 명령·연결 수를 보인다.
 * 왼쪽에는 클라이언트 호스트(연결이 많은 20개, 나머지는 하나로 접음)와 그 호스트가 각 노드에 연 연결 수(간선의 굵기와 글).
 */
export function ClusterTopology({ overview, clients, note }: Props) {
  const topology = useMemo(() => buildClusterTopology(overview, clients), [overview, clients]);
  const geo = useMemo(() => place(topology), [topology]);
  const hostPos = new Map(geo.hosts.map((h) => [h.id, h]));
  const maxLink = Math.max(1, ...topology.hosts.flatMap((h) => h.links.map((l) => l.count)));
  const labelLinks = topology.hosts.length <= 12;
  return (
    <div className="kv-topology">
      {note && <p className="kvg-note">{note}</p>}
      <GraphCanvas width={geo.width} height={geo.height} label={t.TOPOLOGY_TITLE} minHeight={320}>
        {geo.groups.map((g) => (
          <g key={g.id} className="kvg-group" transform={`translate(${g.x},${g.y})`} role="group" aria-label={g.label}>
            <rect width={g.w} height={g.h} rx={10} />
            <text x={GROUP_PAD} y={17}>
              {g.label}
              {(() => {
                const slots = g.nodes.find((n) => n.node.role === "primary")?.node.slots;
                return slots ? ` · 슬롯 ${slots}` : "";
              })()}
            </text>
          </g>
        ))}
        {topology.hosts.flatMap((h) =>
          h.links.flatMap((l) => {
            const from = hostPos.get(h.id);
            const to = geo.nodePos.get(l.node);
            if (!from || !to) return [];
            const sx = from.x + HOST_W;
            const sy = from.y + HOST_H / 2;
            const tx = to.x;
            const ty = to.y + NODE_H / 2;
            const bend = (tx - sx) / 2;
            return [
              <GraphEdgeLine
                key={`${h.id}>${l.node}`}
                path={`M${sx},${sy} C${sx + bend},${sy} ${tx - bend},${ty} ${tx},${ty}`}
                mid={{ x: (sx + tx) / 2 + (ty > sy ? 0 : 0), y: (sy + ty) / 2 }}
                tone="accent"
                width={0.8 + Math.min(2.6, (l.count / maxLink) * 2.6)}
                opacity={labelLinks ? 0.8 : 0.4}
                label={labelLinks || l.count >= 9 ? String(l.count) : undefined}
                title={`${h.label} → ${shortAddress(l.node)} · 연결 ${l.count}개`}
              />,
            ];
          }),
        )}
        {topology.groups.flatMap((g) => {
          const primary = g.nodes.find((n) => n.role === "primary");
          return g.nodes.flatMap((n) => {
            if (!primary || n.role !== "replica") return [];
            const a = geo.nodePos.get(primary.address)!;
            const b = geo.nodePos.get(n.address)!;
            const x = a.x + NODE_W / 2;
            const lag = n.lagSeconds;
            return [
              <GraphEdgeLine
                key={`${primary.address}>${n.address}`}
                path={`M${x},${a.y + NODE_H} L${x},${b.y}`}
                mid={{ x, y: (a.y + NODE_H + b.y) / 2 }}
                tone={lag !== null && lag >= 5 ? "bad" : lag !== null && lag >= 1 ? "warn" : "good"}
                width={1.8}
                label={lag === null ? "복제" : `복제 지연 ${lag}초`}
              />,
            ];
          });
        })}
        {topology.hosts.map((h) => {
          const p = hostPos.get(h.id)!;
          return (
            <g key={h.id} transform={`translate(${p.x},${p.y})`} className={`kvg-node${h.folded > 1 ? " mute" : ""}`} role="group" aria-label={`클라이언트 ${h.label}`}>
              <rect width={HOST_W} height={HOST_H} rx={7} />
              <text x={10} y={17} className="mono">
                {h.label}
              </text>
              <text x={HOST_W - 10} y={17} textAnchor="end" className="sub num">
                {formatCount(h.connections)}
                {h.own ? " · 이 앱" : ""}
              </text>
              <title>{`${h.label} · 연결 ${h.connections}개`}</title>
            </g>
          );
        })}
        {geo.groups.flatMap((g) =>
          g.nodes.map(({ node, x, y }) => {
            const pct = node.maxMemory && node.usedMemory !== null ? node.usedMemory / node.maxMemory : null;
            return (
              <g key={node.address} transform={`translate(${x},${y})`} className={`kvg-node ${node.role === "primary" ? "accent" : ""}`} role="group" aria-label={`${node.role === "primary" ? "기본" : "복제"} 노드 ${shortAddress(node.address)}`}>
                <rect width={NODE_W} height={NODE_H} rx={8} />
                <text x={10} y={18} className="mono">
                  {shortAddress(node.address)}
                </text>
                <text x={NODE_W - 10} y={18} textAnchor="end" className="sub">
                  {node.role === "primary" ? `기본${node.slots ? ` · ${node.slots}` : ""}` : "복제"}
                </text>
                <text x={10} y={36} className="sub num">
                  {node.usedMemory === null ? "" : `메모리 ${formatBytes(node.usedMemory)}${node.maxMemory ? ` / ${formatBytes(node.maxMemory)}` : ""}`}
                </text>
                <text x={10} y={50} className="sub num">
                  {node.opsPerSec === null ? "" : `초당 ${compact(node.opsPerSec)}회`}
                  {node.connections === null ? "" : ` · 연결 ${formatCount(node.connections)}`}
                </text>
                {pct !== null && (
                  <g transform={`translate(10,${NODE_H - 8})`}>
                    <rect width={NODE_W - 20} height={3} rx={1.5} className="kvg-meter-bg" />
                    <rect width={Math.min(1, pct) * (NODE_W - 20)} height={3} rx={1.5} className={pct >= 0.9 ? "kvg-meter-hot" : pct >= 0.75 ? "kvg-meter-warm" : "kvg-meter-ok"} />
                  </g>
                )}
                <title>{node.address}</title>
              </g>
            );
          }),
        )}
      </GraphCanvas>
    </div>
  );
}
