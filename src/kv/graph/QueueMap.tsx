import { useMemo } from "react";
import type { Attention } from "../bull";
import * as bt from "../bullText";
import { formatCount } from "../format";
import { KvError } from "../KvError";
import { useKvBullTopology } from "../queries";
import * as t from "../text";
import type { KvTarget } from "../types";
import { GraphCanvas, GraphEdgeLine } from "./GraphCanvas";
import { layoutDag } from "./layout";
import { buildQueueMap, type MapEdge } from "./queueModel";
import { edgeWidth } from "./transitions";

const QUEUE_W = 214;
const QUEUE_H = 66;
const HOST_W = 150;
const HOST_H = 44;

const LEGEND = (
  <span className="kvg-legend" aria-hidden="true">
    <span>
      <i style={{ borderColor: "var(--red)" }} />
      문제 있음
    </span>
    <span>
      <i style={{ borderColor: "var(--yellow)" }} />
      주의
    </span>
    <span>━ 부모→자식 큐(작업 수)</span>
    <span>┅ 워커 호스트→맡은 큐(워커 수)</span>
  </span>
);

interface Props {
  target: KvTarget;
  prefix: string;
  /** 카드가 계산한 건강 상태(최근 처리량까지 본 것). 지도가 같은 색을 쓴다 */
  attention: ReadonlyMap<string, Attention>;
  onOpenQueue: (name: string) => void;
}

/**
 * 큐 지도: 큐(건강 상태 색, 상태별 수), 부모→자식 큐 연결(샘플한 작업의 parentKey로 센 작업 수), 워커 호스트(호스트마다 한 노드)와
 * 호스트→맡은 큐 연결. 큐를 누르면 그 큐의 상세로 간다.
 */
export function QueueMap({ target, prefix, attention, onOpenQueue }: Props) {
  const q = useKvBullTopology(target, prefix, true);
  const map = useMemo(() => (q.data ? buildQueueMap(q.data, attention) : null), [q.data, attention]);
  const layout = useMemo(
    () =>
      map
        ? layoutDag(
            map.nodes.map((n) => ({ id: n.id, w: n.kind === "queue" ? QUEUE_W : HOST_W, h: n.kind === "queue" ? QUEUE_H : HOST_H, layer: n.kind === "host" ? 0 : undefined })),
            map.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
            { direction: "LR", gapMain: 90, gapCross: 14 },
          )
        : null,
    [map],
  );
  if (!q.data || !map || !layout) {
    return q.isError ? <KvError error={q.error} target={target} /> : <div className="empty">{bt.SEARCHING}</div>;
  }
  const placed = new Map(layout.nodes.map((n) => [n.id, n]));
  const nodeName = new Map(map.nodes.map((n) => [n.id, n.kind === "host" ? n.host : n.name]));
  const edgeOf = new Map<string, MapEdge>(map.edges.map((e) => [e.id, e]));
  const maxLink = Math.max(0, ...map.edges.filter((e) => e.kind === "link").map((e) => e.value));
  const maxWorker = Math.max(0, ...map.edges.filter((e) => e.kind === "worker").map((e) => e.value));
  if (map.nodes.length === 0) return <div className="empty">{t.MAP_EMPTY}</div>;
  return (
    <div className="kv-qmap">
      {q.isError && <KvError compact error={q.error} target={target} />}
      <p className="kvg-note">
        {t.MAP_SAMPLED(formatCount(q.data.sampled))}
        {!map.workersKnown && ` · ${t.MAP_NO_WORKERS}`}
      </p>
      <GraphCanvas width={layout.width} height={layout.height} label={bt.BULL_TITLE + " " + t.MAP_MAP} extra={LEGEND} fill minHeight={360}>
        {layout.edges.map((e) => {
          const edge = edgeOf.get(e.id)!;
          const link = edge.kind === "link";
          return (
            <GraphEdgeLine
              key={e.id}
              path={e.path}
              mid={e.mid}
              tone={link ? "accent" : "dim"}
              width={link ? edgeWidth(edge.value, maxLink) : 1 + Math.min(2, (edge.value / Math.max(1, maxWorker)) * 2)}
              dotted={!link}
              opacity={link ? 1 : 0.4}
              label={link ? `작업 ${formatCount(edge.value)}` : undefined}
              title={link ? undefined : `${nodeName.get(edge.from)} → ${nodeName.get(edge.to)} · 워커 ${edge.value}개`}
            />
          );
        })}
        {map.nodes.map((n) => {
          const p = placed.get(n.id)!;
          if (n.kind === "host") {
            return (
              <g key={n.id} transform={`translate(${p.x},${p.y})`} className="kvg-node" role="group" aria-label={`워커 호스트 ${n.host}`}>
                <rect width={HOST_W} height={HOST_H} rx={7} />
                <text x={10} y={18} className="mono">
                  {n.host}
                </text>
                <text x={10} y={34} className="sub">
                  워커 {n.workers}개 · 큐 {n.queues.length}개
                </text>
                <title>{`${n.host}\n${n.queues.join(", ")}`}</title>
              </g>
            );
          }
          const tone = n.attention === "danger" ? "bad" : n.attention === "warn" ? "warn" : "plain";
          const open = n.counts.wait + n.counts.prioritized;
          return (
            <g
              key={n.id}
              transform={`translate(${p.x},${p.y})`}
              className={`kvg-node ${tone}${n.paused ? " mute" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={`${n.name} 큐 열기`}
              onClick={() => onOpenQueue(n.name)}
              onKeyDown={(e) => e.key === "Enter" && onOpenQueue(n.name)}
            >
              <rect width={QUEUE_W} height={QUEUE_H} rx={8} />
              <text x={10} y={19} className="mono">
                {n.name.length > 22 ? `${n.name.slice(0, 21)}…` : n.name}
              </text>
              <text x={QUEUE_W - 10} y={19} textAnchor="end" className="sub">
                {n.paused ? bt.PAUSED_BADGE : bt.FLAVOR[n.flavor]}
              </text>
              <text x={10} y={37} className="sub num">
                대기 {formatCount(open)} · 처리 {formatCount(n.counts.active)} · 지연 {formatCount(n.counts.delayed)}
              </text>
              <text x={10} y={53} className="sub num">
                완료 {formatCount(n.counts.completed)} · 실패 {formatCount(n.counts.failed)} · 워커 {n.workers === null ? "?" : n.workers}
              </text>
              <title>{n.attention ? `${n.name} · ${bt.ATTENTION[n.attention]}` : n.name}</title>
            </g>
          );
        })}
      </GraphCanvas>
    </div>
  );
}
