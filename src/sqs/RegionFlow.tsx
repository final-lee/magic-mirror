import { useMemo } from "react";
import { ErrorState } from "../components/ErrorState";
import { GraphCanvas, GraphEdgeLine } from "../components/graph/GraphCanvas";
import { layoutDag } from "../components/graph/layout";
import { queueHealth } from "./group";
import { useSqsRegionFlow } from "./queries";
import * as t from "./text";
import type { FlowNode, SqsJump, SqsQueue, SqsRegionFlow } from "./types";

const NODE_W = 210;
const NODE_H = 54;
const LABEL_MAX = 24;

interface Props {
  profile: string;
  region: string;
  /** 노드의 건강 색을 칠하고 큐 노드를 목록의 큐와 잇는 데 쓴다 */
  queues: SqsQueue[];
  onJump: (jump: SqsJump) => void;
}

const LEGEND = (
  <span className="kvg-legend" aria-hidden="true">
    <span>
      <i style={{ borderColor: "var(--red)" }} />
      {t.MAP_LEGEND.fail}
    </span>
    <span>
      <i style={{ borderColor: "var(--yellow)" }} />
      {t.MAP_LEGEND.warn}
    </span>
    <span>┅ {t.MAP_LEGEND.dlq}</span>
  </span>
);

/** 큐 노드를 누르면 같은 탭의 그 큐로, 그 밖은 노드가 가진 이동 길로 간다. 길이 없으면 누를 수 없다 */
function jumpOf(node: FlowNode, byArn: ReadonlyMap<string, SqsQueue>): SqsJump | null {
  if (node.jump) return node.jump;
  const q = node.kind === "queue" ? byArn.get(node.id) : undefined;
  return q ? { kind: "queue", url: q.url } : null;
}

/** 리전 지도에서 노드 종류와 큐 연결 방향에 따라 고정 레인을 정한다. */
export function regionFlowLanes(nodes: FlowNode[], edges: SqsRegionFlow["edges"], queues: SqsQueue[]): Map<string, number> {
  const queueIds = new Set(nodes.filter((n) => n.kind === "queue").map((n) => n.id));
  const dlqs = new Set(queues.filter((q) => q.isDlq).map((q) => q.arn));
  return new Map(nodes.map((node) => {
    if (node.kind === "queue") {
      const hasConsumer = edges.some((e) => e.from === node.id && (e.kind === "esm" || e.kind === "subscription"));
      return [node.id, dlqs.has(node.id) && !hasConsumer ? 2 : 1];
    }
    if (node.kind === "pipe") {
      return [node.id, edges.some((e) => e.from === node.id && queueIds.has(e.to)) ? 0 : 2];
    }
    return [node.id, node.kind === "lambda" ? 2 : 0];
  }));
}

/** 리전 전체 흐름 지도: 생산자(SNS) → 큐 → 소비자(Lambda·Pipe), 큐 → DLQ. 팬아웃을 한눈에 본다 */
export function RegionFlow({ profile, region, queues, onJump }: Props) {
  const q = useSqsRegionFlow(profile, region, true);
  const flow = q.data;
  const byArn = useMemo(() => new Map(queues.map((x) => [x.arn, x])), [queues]);
  const layout = useMemo(() => {
    if (!flow) return null;
    const ids = new Set(flow.nodes.map((n) => n.id));
    const edges = flow.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ ...e, id: `${e.kind}:${e.from}>${e.to}` }));
    const lanes = regionFlowLanes(flow.nodes, edges, queues);
    const placed = layoutDag(
      flow.nodes.map((n) => ({ id: n.id, w: NODE_W, h: NODE_H, layer: lanes.get(n.id) })),
      edges,
      { direction: "LR", gapMain: 90, gapCross: 14 },
    );
    return { placed, edges };
  }, [flow, queues]);

  if (!flow || !layout) {
    return q.isError ? <ErrorState error={q.error} profile={profile} onRetry={() => void q.refetch()} /> : <div className="empty">{t.MAP_LOADING}</div>;
  }
  const at = new Map(layout.placed.nodes.map((n) => [n.id, n]));
  const edgeOf = new Map(layout.edges.map((e) => [e.id, e]));
  const nodeOf = new Map(flow.nodes.map((n) => [n.id, n]));
  return (
    <div className="sqs-map">
      {q.isError && <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} />}
      {flow.gaps.length > 0 && (
        <div className="notice sqs-gaps" role="status">
          <b>{t.FLOW_GAPS}</b>
          <ul>
            {flow.gaps.map((g, i) => (
              <li key={`${g.section}-${i}`}>{t.gap(g.section, g.error)}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="kvg-note">{t.MAP_NOTE}</p>
      {flow.nodes.length === 0 ? (
        <div className="empty">{t.MAP_EMPTY}</div>
      ) : (
        <GraphCanvas width={layout.placed.width} height={layout.placed.height} label={t.MAP_LABEL} extra={LEGEND} fill minHeight={360}>
          {layout.placed.edges.map((e) => {
            const edge = edgeOf.get(e.id)!;
            const dlq = edge.kind === "dlq";
            return (
              <GraphEdgeLine
                key={e.id}
                path={e.path}
                mid={e.mid}
                tone={dlq ? "warn" : "accent"}
                dotted={dlq}
                label={t.MAP_EDGE[edge.kind]}
                title={`${nodeOf.get(edge.from)?.label} → ${nodeOf.get(edge.to)?.label}`}
              />
            );
          })}
          {flow.nodes.map((n) => {
            const p = at.get(n.id)!;
            const kind = t.NODE_KIND[n.kind];
            const queue = n.kind === "queue" ? byArn.get(n.id) : undefined;
            const health = queue ? queueHealth(queue) : "ok";
            const tone = health === "fail" ? "bad" : health === "warn" ? "warn" : "plain";
            const jump = jumpOf(n, byArn);
            const go = () => jump && onJump(jump);
            return (
              <g
                key={n.id}
                transform={`translate(${p.x},${p.y})`}
                className={`kvg-node ${tone}${n.crossAccount ? " mute" : ""}`}
                role={jump ? "button" : "group"}
                tabIndex={jump ? 0 : undefined}
                aria-label={jump ? t.mapNodeOpen(n.label) : n.label}
                onClick={go}
                onKeyDown={(e) => {
                  if (e.key === "Enter") go();
                }}
              >
                <rect width={NODE_W} height={NODE_H} rx={8} />
                <text x={10} y={20} className="mono">
                  {n.label.length > LABEL_MAX ? `${n.label.slice(0, LABEL_MAX - 1)}…` : n.label}
                </text>
                <text x={10} y={38} className="sub">
                  {[`${kind.icon} ${kind.label}`, n.crossAccount ? t.CROSS_ACCOUNT : null, n.state].filter(Boolean).join(" · ")}
                </text>
                <title>{n.label}</title>
              </g>
            );
          })}
        </GraphCanvas>
      )}
    </div>
  );
}
