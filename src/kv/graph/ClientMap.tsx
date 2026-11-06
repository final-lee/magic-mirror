import { useMemo } from "react";
import { formatCount } from "../format";
import * as t from "../text";
import type { KvClient } from "../types";
import { buildClientMap, type ClientMapNode } from "./clientModel";
import { shortAddress } from "./ClusterTopology";
import { GraphCanvas, GraphEdgeLine } from "../../components/graph/GraphCanvas";
import { layoutDag } from "../../components/graph/layout";
import { edgeWidth } from "./transitions";

/** 호스트는 많아서 한 줄(주소와 연결 수), 이름·노드는 두 줄 */
const SIZE: Record<ClientMapNode["kind"], { w: number; h: number }> = {
  host: { w: 176, h: 26 },
  name: { w: 236, h: 44 },
  node: { w: 236, h: 44 },
};
const LAYER: Record<ClientMapNode["kind"], number> = { host: 0, name: 1, node: 2 };
/** 간선이 이보다 많으면 수는 글 대신 마우스를 올렸을 때만 보인다 */
const LABELED_EDGES = 40;

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** 노드 상자의 둘째 줄 */
function subLine(n: ClientMapNode): string {
  const own = n.own ? ` · ${t.OWN_CLIENT}` : "";
  if (n.kind === "name") return `${t.CLIENT_MAP_CONNS(formatCount(n.connections))} · ${t.CLIENT_MAP_HOSTS(n.hosts)}${own}`;
  return `${t.CLIENT_MAP_CONNS(formatCount(n.connections))}${own}`;
}

/**
 * 클라이언트 지도: 호스트 → 연결 이름(Bull 연결은 큐 이름) → 노드(노드가 둘 이상일 때만). 간선의 굵기와 글은 연결 수.
 * 표와 같은 목록(찾기로 거른 것)을 그린다.
 */
export function ClientMap({ clients }: { clients: readonly KvClient[] }) {
  const map = useMemo(() => buildClientMap(clients), [clients]);
  const layout = useMemo(
    () =>
      layoutDag(
        map.nodes.map((n) => ({ id: n.id, ...SIZE[n.kind], layer: LAYER[n.kind] })),
        map.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
        { direction: "LR", gapMain: 120, gapCross: 6 },
      ),
    [map],
  );
  const placed = new Map(layout.nodes.map((n) => [n.id, n]));
  const nodeOf = new Map(map.nodes.map((n) => [n.id, n]));
  const edgeOf = new Map(map.edges.map((e) => [e.id, e]));
  const max = Math.max(0, ...map.edges.map((e) => e.count));
  const labeled = map.edges.length <= LABELED_EDGES;
  const legend = <span className="kvg-legend">{map.showNodes ? t.CLIENT_MAP_LEGEND_NODES : t.CLIENT_MAP_LEGEND}</span>;
  return (
    <div className="kv-cmap">
      <GraphCanvas width={layout.width} height={layout.height} label={t.CLIENT_MAP_TITLE} extra={legend} fill minHeight={360}>
        {layout.edges.map((e) => {
          const edge = edgeOf.get(e.id)!;
          const title = `${nodeOf.get(edge.from)!.label} → ${nodeOf.get(edge.to)!.label} · ${t.CLIENT_MAP_CONNS(formatCount(edge.count))}`;
          return <GraphEdgeLine key={e.id} path={e.path} mid={e.mid} tone="accent" width={edgeWidth(edge.count, max)} opacity={labeled ? 0.8 : 0.45} label={labeled ? formatCount(edge.count) : undefined} title={title} />;
        })}
        {map.nodes.map((n) => {
          const p = placed.get(n.id)!;
          const { w, h } = SIZE[n.kind];
          const label = n.kind === "node" ? shortAddress(n.label) : n.kind === "name" && n.bull ? `🐂 ${n.label}` : n.label;
          const tip = [n.kind === "node" ? n.label : label, ...n.raw.slice(0, 10), n.raw.length > 10 ? `… ${n.raw.length - 10}` : ""].filter(Boolean).join("\n");
          return (
            <g key={n.id} transform={`translate(${p.x},${p.y})`} className={`kvg-node${n.kind === "node" ? " accent" : ""}${n.folded > 1 ? " mute" : ""}`} role="group" aria-label={`${label} ${subLine(n)}`}>
              <rect width={w} height={h} rx={7} />
              {n.kind === "host" ? (
                <>
                  <text x={10} y={17} className="mono">
                    {cut(label, 18)}
                  </text>
                  <text x={w - 10} y={17} textAnchor="end" className="sub num">
                    {formatCount(n.connections)}
                    {n.own ? ` · ${t.OWN_CLIENT}` : ""}
                  </text>
                </>
              ) : (
                <>
                  <text x={10} y={18} className={n.bull ? undefined : "mono"}>
                    {cut(label, 30)}
                  </text>
                  <text x={10} y={34} className="sub num">
                    {subLine(n)}
                  </text>
                </>
              )}
              <title>{tip}</title>
            </g>
          );
        })}
      </GraphCanvas>
    </div>
  );
}
