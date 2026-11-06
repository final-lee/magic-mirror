import { useMemo } from "react";
import { GraphCanvas, GraphEdgeLine, type Tone } from "../../components/graph/GraphCanvas";
import { layoutDag } from "../../components/graph/layout";
import { resolveLink } from "../kinds";
import { statusTone } from "../status";
import type { K8sKind, ObjectRef } from "../types";
import { buildRelationMap, type MapNode } from "./mapModel";
import { EDGE_LABELS, MAP_INWARD, MAP_LABEL, MAP_OUTWARD, ROLE_LABELS, XRAY_CURRENT, XRAY_MISSING, XRAY_MISSING_TITLE, xrayOpen } from "./text";
import type { K8sXray, XrayEdge } from "./types";

const NODE_W = 216;
const NODE_H = 46;
const NAME_MAX = 28;

/** 관계마다 선의 색과 모양 */
const EDGE_STYLE: Record<XrayEdge, { tone: Tone; dashed?: boolean; dotted?: boolean }> = {
  owner: { tone: "dim" },
  reference: { tone: "accent", dashed: true },
  selector: { tone: "good", dotted: true },
  target: { tone: "warn" },
};

const LEGEND = (
  <span className="kvg-legend" aria-hidden="true">
    <span>{MAP_INWARD}</span>
    <span>{MAP_OUTWARD}</span>
    <span className="xray-legend-line owner">{EDGE_LABELS.owner}</span>
    <span className="xray-legend-line reference">{EDGE_LABELS.reference}</span>
    <span className="xray-legend-line selector">{EDGE_LABELS.selector}</span>
    <span className="xray-legend-line target">{EDGE_LABELS.target}</span>
  </span>
);

function toneOf(n: MapNode): string {
  if (n.current) return "focus";
  if (n.presence === "missing") return "mute";
  if (n.problems.length > 0) return "bad";
  const tone = n.status ? statusTone(n.status) : "plain";
  return tone === "bad" ? "bad" : tone === "warn" ? "warn" : tone === "ok" ? "good" : "";
}

const shorten = (s: string) => (s.length > NAME_MAX ? `${s.slice(0, NAME_MAX - 1)}…` : s);

/** 관계 지도: 지금 보는 객체를 가운데에, 가리키는 쪽을 왼쪽, 가리켜지는 쪽을 오른쪽에 두고 관계마다 다른 선으로 잇는다. 노드를 누르면 그 객체를 연다 */
export function XrayMap({ xray, objectRef, kinds, onOpen }: { xray: K8sXray; objectRef: ObjectRef; kinds: K8sKind[]; onOpen: (ref: ObjectRef) => void }) {
  const map = useMemo(() => buildRelationMap(xray, objectRef), [xray, objectRef]);
  const layout = useMemo(() => {
    const min = Math.min(0, ...map.nodes.map((n) => n.column));
    return layoutDag(
      map.nodes.map((n) => ({ id: n.id, w: NODE_W, h: NODE_H, layer: n.column - min })),
      map.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
      { direction: "LR", gapMain: 80, gapCross: 12 },
    );
  }, [map]);
  const placed = new Map(layout.nodes.map((p) => [p.id, p]));
  const edgeOf = new Map(map.edges.map((e) => [e.id, e]));
  return (
    <GraphCanvas width={layout.width} height={layout.height} label={MAP_LABEL} extra={LEGEND} minHeight={320}>
      {layout.edges.map((p) => {
        const e = edgeOf.get(p.id)!;
        const style = EDGE_STYLE[e.edge];
        const roles = e.roles.map((r) => ROLE_LABELS[r] ?? r).join(", ");
        return <GraphEdgeLine key={p.id} path={p.path} mid={p.mid} tone={style.tone} dashed={style.dashed} dotted={style.dotted} label={roles || undefined} title={EDGE_LABELS[e.edge]} />;
      })}
      {map.nodes.map((n) => {
        const p = placed.get(n.id)!;
        const kind = n.current ? null : resolveLink(n, kinds);
        const openable = kind !== null && n.presence !== "missing";
        const open = () => kind && onOpen({ kind, namespace: kind.namespaced ? n.namespace : null, name: n.name });
        const title = [`${n.kind} ${n.namespace ? `${n.namespace}/` : ""}${n.name}`, n.status, n.current ? XRAY_CURRENT : null, n.presence === "missing" ? XRAY_MISSING_TITLE : null].filter(Boolean).join("\n");
        return (
          <g
            key={n.id}
            transform={`translate(${p.x},${p.y})`}
            className={`kvg-node xray-node ${toneOf(n)}`}
            role={openable ? "button" : "group"}
            tabIndex={openable ? 0 : undefined}
            aria-label={openable ? xrayOpen(n.kind, n.name) : `${n.kind} ${n.name}`}
            aria-current={n.current ? "true" : undefined}
            onClick={openable ? open : undefined}
            onKeyDown={openable ? (ev) => ev.key === "Enter" && open() : undefined}
          >
            <rect width={NODE_W} height={NODE_H} rx={8} />
            <text x={10} y={17} className="sub">
              {n.kind}
            </text>
            <text x={NODE_W - 10} y={17} textAnchor="end" className="sub">
              {n.presence === "missing" ? XRAY_MISSING : n.current ? XRAY_CURRENT : n.status ?? ""}
            </text>
            <text x={10} y={35} className="mono">
              {shorten(n.name)}
            </text>
            <title>{title}</title>
          </g>
        );
      })}
    </GraphCanvas>
  );
}
