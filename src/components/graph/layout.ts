// 층을 나눈 방향 그래프(DAG) 배치. ElastiCache 탭의 그래프들(작업 흐름, 상태 전이, 큐 지도)과 EKS 관계 지도가 함께 쓴다.
// 순서: 사이클 끊기 → 가장 긴 경로로 층 나누기(고정한 층은 그대로) → 무게중심으로 층 안 순서 다듬기 → 좌표 → 곡선 경로.
export type Direction = "LR" | "TB";

export interface LayoutNode {
  id: string;
  /** 크기(주 방향과 상관없이 화면의 너비·높이) */
  w: number;
  h: number;
  /** 주면 이 층에 고정한다(0부터). 없으면 가장 긴 경로로 정한다 */
  layer?: number;
}
export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
}
export interface LayoutOptions {
  direction: Direction;
  /** 층 사이 간격(주 방향)과 한 층 안의 노드 사이 간격 */
  gapMain?: number;
  gapCross?: number;
  pad?: number;
}
export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
}
export interface PlacedEdge {
  id: string;
  from: string;
  to: string;
  /** SVG path(곡선) */
  path: string;
  /** 곡선 가운데(라벨 자리) */
  mid: { x: number; y: number };
  /** 사이클을 끊느라 방향을 뒤집어 층을 정한 간선 */
  back: boolean;
}
export interface Layout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

const SWEEPS = 4;

/** 깊이 우선으로 돌며 뒤로 가는 간선(사이클을 만드는 간선)의 id를 모은다 */
function backEdges(ids: readonly string[], out: ReadonlyMap<string, LayoutEdge[]>): Set<string> {
  const state = new Map<string, 0 | 1 | 2>(); // 1 = 지금 걷는 길 위, 2 = 끝남
  const back = new Set<string>();
  for (const start of ids) {
    if (state.get(start)) continue;
    // 재귀 대신 명시적 스택(간선이 많아도 호출 깊이가 늘지 않는다)
    const stack: { id: string; i: number }[] = [{ id: start, i: 0 }];
    state.set(start, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const edges = out.get(top.id) ?? [];
      if (top.i >= edges.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const e = edges[top.i++];
      const seen = state.get(e.to);
      if (seen === 1) back.add(e.id);
      else if (!seen) {
        state.set(e.to, 1);
        stack.push({ id: e.to, i: 0 });
      }
    }
  }
  return back;
}

/** 곡선(3차 베지어)의 t=0.5 점 */
const cubicMid = (p0: number, p1: number, p2: number, p3: number) => (p0 + 3 * p1 + 3 * p2 + p3) / 8;

export function layoutDag(inputNodes: readonly LayoutNode[], inputEdges: readonly LayoutEdge[], options: LayoutOptions): Layout {
  const { direction } = options;
  const gapMain = options.gapMain ?? 72;
  const gapCross = options.gapCross ?? 18;
  const pad = options.pad ?? 24;
  const known = new Map(inputNodes.map((n) => [n.id, n]));
  const ids = [...known.keys()];
  // 모르는 끝, 자기 자신으로 가는 간선, 같은 id는 버린다
  const edgeIds = new Set<string>();
  const edges = inputEdges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to && !edgeIds.has(e.id) && edgeIds.add(e.id));

  const out = new Map<string, LayoutEdge[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const back = backEdges(ids, out);
  // 층·순서를 정할 때는 뒤집은 간선을 쓴다
  const dir = edges.map((e) => (back.has(e.id) ? { ...e, from: e.to, to: e.from } : e));
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of dir) {
    preds.get(e.to)!.push(e.from);
    succs.get(e.from)!.push(e.to);
  }

  // 층: 위상 순서(Kahn)로 가장 긴 경로. 고정한 노드는 그 층에 둔다.
  const indeg = new Map(ids.map((id) => [id, preds.get(id)!.length]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const layerOf = new Map<string, number>();
  for (const id of ids) layerOf.set(id, known.get(id)!.layer ?? 0);
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const pinned = known.get(id)!.layer;
    if (pinned !== undefined) layerOf.set(id, pinned);
    for (const next of succs.get(id)!) {
      if (known.get(next)!.layer === undefined) layerOf.set(next, Math.max(layerOf.get(next)!, layerOf.get(id)! + 1));
      indeg.set(next, indeg.get(next)! - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  const depth = Math.max(-1, ...layerOf.values());
  const layers: string[][] = Array.from({ length: depth + 1 }, () => []);
  for (const id of ids) layers[layerOf.get(id)!].push(id);

  // 순서: 이웃 위치의 평균(무게중심)으로 위→아래, 아래→위를 번갈아 다듬는다
  const posOf = new Map<string, number>();
  const refresh = () => {
    for (const layer of layers) layer.forEach((id, i) => posOf.set(id, (i + 0.5) / layer.length));
  };
  refresh();
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? layers : [...layers].reverse();
    for (const layer of order) {
      const key = new Map<string, number>();
      for (const id of layer) {
        const around = (down ? preds : succs).get(id)!;
        key.set(id, around.length === 0 ? posOf.get(id)! : around.reduce((s, n) => s + posOf.get(n)!, 0) / around.length);
      }
      layer.sort((a, b) => key.get(a)! - key.get(b)!);
      layer.forEach((id, i) => posOf.set(id, (i + 0.5) / layer.length));
    }
  }

  // 좌표: 층마다 주 방향 위치를 정하고, 층 안은 가운데 맞춤으로 늘어놓는다
  const main = (n: LayoutNode) => (direction === "LR" ? n.w : n.h);
  const cross = (n: LayoutNode) => (direction === "LR" ? n.h : n.w);
  const totals = layers.map((layer) => layer.reduce((s, id) => s + cross(known.get(id)!), 0) + Math.max(0, layer.length - 1) * gapCross);
  const widest = Math.max(0, ...totals);
  const placed = new Map<string, PlacedNode>();
  let at = pad;
  layers.forEach((layer, li) => {
    const thick = Math.max(0, ...layer.map((id) => main(known.get(id)!)));
    let c = pad + (widest - totals[li]) / 2;
    for (const id of layer) {
      const n = known.get(id)!;
      const m = at + (thick - main(n)) / 2;
      placed.set(id, direction === "LR" ? { id, x: m, y: c, w: n.w, h: n.h, layer: li } : { id, x: c, y: m, w: n.w, h: n.h, layer: li });
      c += cross(n) + gapCross;
    }
    at += thick + gapMain;
  });

  const pathOf = (e: LayoutEdge, isBack: boolean): PlacedEdge => {
    const a = placed.get(e.from)!;
    const b = placed.get(e.to)!;
    // LR은 오른쪽 가운데 → 왼쪽 가운데, TB는 아래 가운데 → 위 가운데. 거꾸로 가는 간선은 같은 점에서 크게 돌아간다.
    const s = direction === "LR" ? { x: a.x + a.w, y: a.y + a.h / 2 } : { x: a.x + a.w / 2, y: a.y + a.h };
    const t = direction === "LR" ? { x: b.x, y: b.y + b.h / 2 } : { x: b.x + b.w / 2, y: b.y };
    const forward = direction === "LR" ? t.x > s.x : t.y > s.y;
    const bend = forward ? Math.max(24, Math.abs(direction === "LR" ? t.x - s.x : t.y - s.y) / 2) : 70;
    const c1 = direction === "LR" ? { x: s.x + bend, y: s.y } : { x: s.x, y: s.y + bend };
    const c2 = direction === "LR" ? { x: t.x - bend, y: t.y } : { x: t.x, y: t.y - bend };
    return {
      id: e.id,
      from: e.from,
      to: e.to,
      path: `M${s.x},${s.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${t.x},${t.y}`,
      mid: { x: cubicMid(s.x, c1.x, c2.x, t.x), y: cubicMid(s.y, c1.y, c2.y, t.y) },
      back: isBack,
    };
  };

  const nodes = ids.map((id) => placed.get(id)!);
  return {
    nodes,
    edges: edges.map((e) => pathOf(e, back.has(e.id))),
    width: nodes.length === 0 ? 0 : Math.max(...nodes.map((n) => n.x + n.w)) + pad,
    height: nodes.length === 0 ? 0 : Math.max(...nodes.map((n) => n.y + n.h)) + pad,
  };
}
