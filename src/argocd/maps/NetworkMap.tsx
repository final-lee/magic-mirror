import { useMemo } from "react";
import { MAP_TEXT } from "../text";
import type { ArgoTreeNode, ResRef } from "../types";
import { networkGraph } from "./network";
import "./maps.css";

export function NetworkMap({ nodes, onOpen }: { nodes: ArgoTreeNode[]; onOpen: (res: ResRef) => void }) {
  const graph = useMemo(() => networkGraph(nodes), [nodes]);
  const columns = [0, 1, 2, 3].map(layer => graph.vertices.filter(v => v.layer === layer));
  const positions = new Map(columns.flatMap((column, x) => column.map((v, y) => [v.id, { x: x * 220 + 8, y: y * 62 + 35 }] as const)));
  const height = Math.max(100, ...columns.map(c => c.length * 62 + 40));
  if (!graph.vertices.length) return <div className="empty">{MAP_TEXT.noNetwork}</div>;
  return <div className="argo-map-graph"><svg width="880" height={height} role="img" aria-label={MAP_TEXT.network}>
    {[MAP_TEXT.external, MAP_TEXT.ingress, MAP_TEXT.service, MAP_TEXT.pod].map((label, i) => <text className="argo-map-heading" key={label} x={i * 220 + 8} y={20}>{label}</text>)}
    {graph.edges.map(e => { const a = positions.get(e.from)!; const b = positions.get(e.to)!; return <path className="argo-map-edge" key={`${e.from}:${e.to}`} d={`M ${a.x + 190} ${a.y + 21} C ${a.x + 205} ${a.y + 21}, ${b.x - 15} ${b.y + 21}, ${b.x} ${b.y + 21}`} />; })}
    {graph.vertices.map(v => { const p = positions.get(v.id)!; const health = v.node?.health; const tone = health === "Degraded" || health === "Missing" ? "err" : health && health !== "Healthy" ? "warn" : "ok"; return <g key={v.id} transform={`translate(${p.x},${p.y})`} className={`argo-map-node ${tone}`} role={v.node ? "button" : undefined} tabIndex={v.node ? 0 : undefined} onClick={() => v.node && onOpen(v.node)} onKeyDown={e => { if (v.node && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(v.node); } }}><title>{v.label}</title><rect width="190" height="42" rx="5"/><text x="9" y="26">{v.label.length > 26 ? `${v.label.slice(0, 25)}…` : v.label}</text></g>; })}
  </svg></div>;
}
