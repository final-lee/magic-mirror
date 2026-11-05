import { STATE_LABEL } from "../bull";
import type { KvBullFlow, KvBullFlowEdge, KvBullFlowNode, KvBullFlowState } from "../types";
import { layoutDag, type Direction, type Layout } from "./layout";
import type { Tone } from "./GraphCanvas";

export const FLOW_NODE_W = 208;
export const FLOW_NODE_H = 58;

export const flowStateLabel = (s: KvBullFlowState) => (s === "missing" ? "없음" : s === "unknown" ? "알 수 없음" : STATE_LABEL[s]);

/** 노드 테두리 색: 완료 초록, 실패 빨강, 처리 중 파랑, 사라진 작업은 흐리게 */
export function flowNodeTone(s: KvBullFlowState): "good" | "bad" | "accent" | "warn" | "mute" | "plain" {
  if (s === "completed") return "good";
  if (s === "failed") return "bad";
  if (s === "active") return "accent";
  if (s === "missing" || s === "unknown") return "mute";
  if (s === "waitingChildren" || s === "delayed") return "warn";
  return "plain";
}

/** 간선: 끝난 자식은 초록 실선, 실패는 빨강 실선, 기다리는 자식은 점선, 무시된 실패는 점 점선 */
export function flowEdgeStyle(status: KvBullFlowEdge["status"]): { tone: Tone; dashed: boolean; dotted: boolean } {
  return { tone: status === "done" ? "good" : status === "failed" ? "bad" : status === "pending" ? "warn" : "dim", dashed: status === "pending", dotted: status === "ignored" };
}

/** 노드에 붙는 글: 큐 이름과 작업 id. 흐름이 큐를 건너는 노드를 알아보도록 늘 `queue · #id`다 */
export const flowNodeId = (n: Pick<KvBullFlowNode, "queue" | "id">) => `${n.queue} · #${n.id}`;

/** 흐름을 부모(왼쪽)→자식(오른쪽) 층으로 놓는다. 크기가 같은 노드들이라 위치만 정한다. */
export function layoutFlow(flow: Pick<KvBullFlow, "nodes" | "edges">, direction: Direction = "LR"): Layout {
  return layoutDag(
    flow.nodes.map((n) => ({ id: n.key, w: FLOW_NODE_W, h: FLOW_NODE_H })),
    flow.edges.map((e) => ({ id: `${e.parent}>${e.child}`, from: e.parent, to: e.child })),
    { direction, gapMain: 84, gapCross: 16 },
  );
}
