import type { WfArtifact, WfNode } from "./types";

export type GraphDirection = "LR" | "TB";

export const NODE_W = 176;
export const NODE_H = 36;
const GAP_MAIN = 56;
const GAP_CROSS = 14;
const PAD = 24;

export interface GraphOptions {
  direction: GraphDirection;
  /** 접어 둔 그룹 노드(StepGroup·TaskGroup)의 id */
  collapsed: ReadonlySet<string>;
  /** 숨길 phase·노드 종류. 숨긴 노드는 앞뒤를 이어 그린다 */
  hiddenPhases: ReadonlySet<string>;
  hiddenTypes: ReadonlySet<string>;
  /** 출력·입력 아티팩트를 노드 뒤에 작은 노드로 그린다 */
  showArtifacts: boolean;
}

export interface GraphNode {
  /** 화면에서 쓰는 id. 아티팩트 노드는 `artifact:<노드>:<방향>:<이름>` */
  id: string;
  /** 눌렀을 때 고르는 실제 노드(아티팩트 노드는 그것이 딸린 노드) */
  nodeId: string;
  label: string;
  type: string;
  phase: string;
  x: number;
  y: number;
  /** 접을 수 있는 그룹 노드 */
  collapsible: boolean;
  collapsed: boolean;
  /** 접어서 가려진 노드 수 */
  hidden: number;
  artifact: WfArtifact | null;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  path: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

/** 접을 수 있는 노드: 한 단계의 병렬 묶음(StepGroup)과 withItems로 펼쳐진 작업 묶음(TaskGroup) */
export const isGroupNode = (node: WfNode) => node.type === "StepGroup" || node.type === "TaskGroup";

/**
 * n이 그룹 g에 든 노드인가. 그룹의 `children`에는 포함된 노드와 다음 단계가 섞여 있어(DAG) 구조로는 못 가르고, 이름 규칙으로 안다:
 * StepGroup `wf[0]`의 안은 `wf[0].이름`, TaskGroup `wf.task`의 안은 `wf.task(0:값)`.
 */
export const isMember = (group: WfNode, node: WfNode) =>
  node.id !== group.id && (node.name.startsWith(`${group.name}.`) || node.name.startsWith(`${group.name}(`));

/** 노드 목록을 층으로 나눠 놓는다. 부모(`children`의 반대) 중 가장 깊은 층의 다음 층에 놓고, 같은 층 안은 부모 순서를 따른다. */
export function layoutGraph(nodes: readonly WfNode[], options: GraphOptions): Graph {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // 접힌 그룹 안의 노드 → 그 그룹. 그룹이 겹쳐 접혀 있으면 가장 바깥 그룹이 이긴다
  const hiddenBy = new Map<string, string>();
  for (const group of nodes) {
    if (!options.collapsed.has(group.id) || !isGroupNode(group)) continue;
    for (const n of nodes) if (isMember(group, n)) hiddenBy.set(n.id, group.id);
  }
  const owner = (id: string) => {
    const seen = new Set<string>();
    let at = id;
    while (hiddenBy.has(at) && !seen.has(at)) {
      seen.add(at);
      at = hiddenBy.get(at)!;
    }
    return at;
  };
  const filtered = (n: WfNode) => options.hiddenPhases.has(n.phase) || options.hiddenTypes.has(n.type);
  const visible = nodes.filter((n) => owner(n.id) === n.id && !filtered(n));
  const shown = new Set(visible.map((n) => n.id));

  // 접힌 그룹은 안의 노드들이 가진 흐름도 대신 이어 준다
  const ownedBy = new Map<string, WfNode[]>();
  for (const n of nodes) ownedBy.set(owner(n.id), [...(ownedBy.get(owner(n.id)) ?? []), n]);
  // 가려진 노드를 건너뛰어 보이는 노드끼리 잇는다
  const successors = (from: WfNode): string[] => {
    const out = new Set<string>();
    const walked = new Set<string>([from.id]);
    const walk = (n: WfNode) => {
      for (const childId of n.children) {
        const id = owner(childId);
        const child = byId.get(id);
        if (!child || walked.has(id)) continue;
        if (shown.has(id)) out.add(id);
        else {
          walked.add(id);
          walk(child);
        }
      }
    };
    for (const member of ownedBy.get(from.id) ?? [from]) walk(member);
    return [...out];
  };
  const edgesOf = new Map(visible.map((n) => [n.id, successors(n)]));
  const parents = new Map<string, string[]>();
  for (const [from, tos] of edgesOf) for (const to of tos) parents.set(to, [...(parents.get(to) ?? []), from]);

  const layerOf = new Map<string, number>();
  const visiting = new Set<string>();
  const layer = (id: string): number => {
    const known = layerOf.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = Math.max(-1, ...(parents.get(id) ?? []).map(layer)) + 1;
    visiting.delete(id);
    layerOf.set(id, value);
    return value;
  };
  for (const n of visible) layer(n.id);

  interface Slot {
    id: string;
    node: WfNode;
    artifact: WfArtifact | null;
    layer: number;
    parentIds: string[];
  }
  const slots: Slot[] = visible.map((node) => ({ id: node.id, node, artifact: null, layer: layerOf.get(node.id)!, parentIds: parents.get(node.id) ?? [] }));
  if (options.showArtifacts) {
    for (const node of visible) {
      for (const artifact of node.artifacts) {
        slots.push({
          id: `artifact:${node.id}:${artifact.direction}:${artifact.name}`,
          node,
          artifact,
          layer: layerOf.get(node.id)! + 1,
          parentIds: [node.id],
        });
      }
    }
  }
  const layers: Slot[][] = [];
  for (const slot of slots) (layers[slot.layer] ??= []).push(slot);
  const order = new Map<string, number>();
  layers.forEach((row, li) => {
    if (li > 0) {
      const mean = (s: Slot) => (s.parentIds.length ? s.parentIds.reduce((sum, p) => sum + (order.get(p) ?? 0), 0) / s.parentIds.length : 0);
      // 정렬은 안정적이라 같은 값이면 원래 순서
      row.sort((a, b) => mean(a) - mean(b));
    }
    row.forEach((s, i) => order.set(s.id, i));
  });

  const horizontal = options.direction === "LR";
  const main = (horizontal ? NODE_W : NODE_H) + GAP_MAIN;
  const cross = (horizontal ? NODE_H : NODE_W) + GAP_CROSS;
  const pos = new Map<string, { x: number; y: number }>();
  const graphNodes: GraphNode[] = [];
  for (const row of layers) {
    for (const slot of row ?? []) {
      const a = PAD + slot.layer * main;
      const b = PAD + order.get(slot.id)! * cross;
      const at = horizontal ? { x: a, y: b } : { x: b, y: a };
      pos.set(slot.id, at);
      const { node, artifact } = slot;
      const collapsed = artifact === null && options.collapsed.has(node.id) && isGroupNode(node);
      graphNodes.push({
        id: slot.id,
        nodeId: node.id,
        label: artifact ? artifact.name : node.displayName,
        type: artifact ? "Artifact" : node.type,
        phase: artifact ? "" : node.phase,
        ...at,
        collapsible: artifact === null && isGroupNode(node),
        collapsed,
        hidden: collapsed ? nodes.filter((n) => owner(n.id) === node.id && n.id !== node.id).length : 0,
        artifact,
      });
    }
  }
  const edges: GraphEdge[] = [];
  const link = (from: string, to: string) => {
    const a = pos.get(from)!;
    const b = pos.get(to)!;
    const path = horizontal
      ? `M${a.x + NODE_W},${a.y + NODE_H / 2} C${(a.x + NODE_W + b.x) / 2},${a.y + NODE_H / 2} ${(a.x + NODE_W + b.x) / 2},${b.y + NODE_H / 2} ${b.x},${b.y + NODE_H / 2}`
      : `M${a.x + NODE_W / 2},${a.y + NODE_H} C${a.x + NODE_W / 2},${(a.y + NODE_H + b.y) / 2} ${b.x + NODE_W / 2},${(a.y + NODE_H + b.y) / 2} ${b.x + NODE_W / 2},${b.y}`;
    edges.push({ id: `${from}->${to}`, from, to, path });
  };
  for (const [from, tos] of edgesOf) for (const to of tos) link(from, to);
  for (const slot of slots) if (slot.artifact) link(slot.node.id, slot.id);
  const width = Math.max(0, ...graphNodes.map((n) => n.x + NODE_W)) + PAD;
  const height = Math.max(0, ...graphNodes.map((n) => n.y + NODE_H)) + PAD;
  return { nodes: graphNodes, edges, width, height };
}
