import { formatCount } from "../format";
import { flowEdgeStyle, flowNodeId, flowNodeTone, flowStateLabel, FLOW_NODE_H, FLOW_NODE_W, layoutFlow } from "./flowModel";
import { GraphCanvas, GraphEdgeLine } from "./GraphCanvas";
import type { KvBullFlow } from "../types";
import { useMemo } from "react";

const text = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

interface Props {
  flow: KvBullFlow;
  /** 노드를 누르면 그 작업을 연다(다른 큐여도). 사라진(missing) 작업은 누를 수 없다 */
  onOpen: (queue: string, id: string) => void;
  /** 크게 보기(화면을 채운다) */
  big?: boolean;
  frameHeight?: number;
}

const LEGEND = (
  <span className="kvg-legend" aria-hidden="true">
    <span>
      <i style={{ borderColor: "var(--green)" }} />
      완료
    </span>
    <span>
      <i style={{ borderColor: "var(--red)" }} />
      실패
    </span>
    <span>
      <i style={{ borderColor: "var(--accent)" }} />
      처리 중
    </span>
    <span>
      <i style={{ borderStyle: "dashed" }} />
      사라짐
    </span>
    <span>━ 끝난 자식 · ┅ 기다리는 자식</span>
  </span>
);

/**
 * 작업 흐름 그래프: 부모 → 자식(왼쪽 → 오른쪽). 노드는 작업 이름과 `큐 · #id`, 상태, 자식 수를 보이고 지금 보는 작업은 파랑 테두리다.
 * 간선은 자식의 상태로 모양이 다르다(끝남 초록 실선, 실패 빨강, 기다림 점선, 무시된 실패 흐린 점선).
 */
export function FlowGraph({ flow, onOpen, big = false, frameHeight = 280 }: Props) {
  const layout = useMemo(() => layoutFlow(flow), [flow]);
  const nodes = new Map(flow.nodes.map((n) => [n.key, n]));
  const placed = new Map(layout.nodes.map((n) => [n.id, n]));
  const status = new Map(flow.edges.map((e) => [`${e.parent}>${e.child}`, e.status]));
  return (
    <div className="kvg-flow">
      <GraphCanvas width={layout.width} height={layout.height} label="작업 흐름 그래프" extra={LEGEND} frameHeight={frameHeight} className={big ? "big" : ""}>
        {layout.edges.map((e) => {
          const s = flowEdgeStyle(status.get(e.id) ?? "pending");
          return <GraphEdgeLine key={e.id} path={e.path} {...s} title={`${nodes.get(e.from)?.name} → ${nodes.get(e.to)?.name}`} />;
        })}
        {flow.nodes.map((n) => {
          const p = placed.get(n.key)!;
          const tone = flowNodeTone(n.state);
          const open = n.state !== "missing";
          const hasChildren = n.pending + n.done + n.failed > 0;
          const label = `${n.name || "작업"} ${flowNodeId(n)} ${flowStateLabel(n.state)}`;
          return (
            <g
              key={n.key}
              transform={`translate(${p.x},${p.y})`}
              className={`kvg-node ${tone}${n.key === flow.focus ? " focus" : ""}`}
              role={open ? "button" : undefined}
              tabIndex={open ? 0 : undefined}
              aria-label={label}
              aria-current={n.key === flow.focus ? "true" : undefined}
              onClick={open ? () => onOpen(n.queue, n.id) : undefined}
              onKeyDown={open ? (e) => e.key === "Enter" && onOpen(n.queue, n.id) : undefined}
            >
              <rect width={FLOW_NODE_W} height={FLOW_NODE_H} rx={7} />
              <text x={10} y={17}>
                {text(n.name || "(이름 없음)", 26)}
              </text>
              <text x={10} y={32} className="sub mono">
                {text(flowNodeId(n), 32)}
              </text>
              <text x={10} y={47} className="sub num">
                {flowStateLabel(n.state)}
                {hasChildren ? ` · 남음 ${formatCount(n.pending)} · 끝 ${formatCount(n.done)} · 실패 ${formatCount(n.failed)}` : ""}
              </text>
              <title>{n.failedReason ? `${label}\n${n.failedReason}` : label}</title>
            </g>
          );
        })}
      </GraphCanvas>
      {flow.truncated && <p className="kvg-note warn">흐름이 커서 앞쪽 노드만 그렸어요</p>}
    </div>
  );
}
