import { layoutDag, type LayoutEdge, type LayoutNode, type PlacedNode } from "./layout";

const node = (id: string, over: Partial<LayoutNode> = {}): LayoutNode => ({ id, w: 100, h: 40, ...over });
const edge = (from: string, to: string): LayoutEdge => ({ id: `${from}>${to}`, from, to });
const layerOf = (l: ReturnType<typeof layoutDag>) => Object.fromEntries(l.nodes.map((n) => [n.id, n.layer]));
const at = (l: ReturnType<typeof layoutDag>, id: string) => l.nodes.find((n) => n.id === id)!;
const overlap = (a: PlacedNode, b: PlacedNode) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function noOverlaps(l: ReturnType<typeof layoutDag>) {
  for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) expect(overlap(l.nodes[i], l.nodes[j])).toBe(false);
}

describe("layers", () => {
  test("a chain gets one layer per step, left to right", () => {
    const l = layoutDag([node("a"), node("b"), node("c")], [edge("a", "b"), edge("b", "c")], { direction: "LR" });
    expect(layerOf(l)).toEqual({ a: 0, b: 1, c: 2 });
    expect(at(l, "a").x).toBeLessThan(at(l, "b").x);
    expect(at(l, "b").x).toBeLessThan(at(l, "c").x);
  });

  test("a node goes below its deepest parent (longest path)", () => {
    const l = layoutDag([node("a"), node("b"), node("c"), node("d")], [edge("a", "b"), edge("b", "c"), edge("a", "c"), edge("c", "d")], { direction: "LR" });
    expect(layerOf(l)).toEqual({ a: 0, b: 1, c: 2, d: 3 });
  });

  test("a diamond has its two middle nodes in one layer, stacked", () => {
    const l = layoutDag([node("a"), node("b"), node("c"), node("d")], [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")], { direction: "LR" });
    expect(layerOf(l)).toEqual({ a: 0, b: 1, c: 1, d: 2 });
    expect(at(l, "b").x).toBe(at(l, "c").x);
    expect(at(l, "b").y).not.toBe(at(l, "c").y);
    noOverlaps(l);
  });

  test("top to bottom swaps the axes", () => {
    const l = layoutDag([node("a"), node("b")], [edge("a", "b")], { direction: "TB" });
    expect(at(l, "a").y).toBeLessThan(at(l, "b").y);
    expect(at(l, "a").x).toBe(at(l, "b").x);
  });

  test("a pinned layer wins over the longest path", () => {
    const l = layoutDag([node("a", { layer: 0 }), node("b", { layer: 3 }), node("c")], [edge("a", "c")], { direction: "LR" });
    expect(layerOf(l)).toEqual({ a: 0, b: 3, c: 1 });
  });

  test("nodes without edges sit in the first layer and are all placed", () => {
    const l = layoutDag([node("a"), node("b"), node("c")], [], { direction: "LR" });
    expect(l.nodes).toHaveLength(3);
    expect(new Set(Object.values(layerOf(l)))).toEqual(new Set([0]));
    noOverlaps(l);
  });
});

describe("order", () => {
  test("children follow their parents' order so the lines do not cross", () => {
    // a1·a2가 위아래 순서일 때 그 자식 b1·b2가 입력 순서와 반대로 들어와도 같은 순서로 놓인다
    const l = layoutDag([node("a1"), node("a2"), node("b2"), node("b1")], [edge("a1", "b1"), edge("a2", "b2")], { direction: "LR" });
    expect(at(l, "a1").y < at(l, "a2").y).toBe(at(l, "b1").y < at(l, "b2").y);
  });

  test("a child between two parents sits between them", () => {
    const l = layoutDag([node("p1"), node("p2"), node("c")], [edge("p1", "c"), edge("p2", "c")], { direction: "LR" });
    const [lo, hi] = [at(l, "p1").y, at(l, "p2").y].sort((x, y) => x - y);
    expect(at(l, "c").y).toBeGreaterThan(lo - 1);
    expect(at(l, "c").y).toBeLessThan(hi + 1);
  });
});

describe("geometry", () => {
  test("no two nodes overlap, with mixed sizes and a wide layer", () => {
    const nodes = [node("r", { w: 160, h: 60 }), ...Array.from({ length: 12 }, (_, i) => node(`c${i}`, { w: 120 + (i % 3) * 30, h: 30 + (i % 4) * 10 })), node("z")];
    const edges = [...nodes.slice(1, 13).map((n) => edge("r", n.id)), edge("c3", "z"), edge("c7", "z")];
    for (const direction of ["LR", "TB"] as const) noOverlaps(layoutDag(nodes, edges, { direction }));
  });

  test("the canvas size covers every node with the padding", () => {
    const l = layoutDag([node("a"), node("b")], [edge("a", "b")], { direction: "LR", pad: 10 });
    for (const n of l.nodes) {
      expect(n.x + n.w + 10).toBeLessThanOrEqual(l.width);
      expect(n.y + n.h + 10).toBeLessThanOrEqual(l.height);
      expect(n.x).toBeGreaterThanOrEqual(10);
      expect(n.y).toBeGreaterThanOrEqual(10);
    }
  });

  test("an edge leaves the right side of its source and arrives at the left side of its target", () => {
    const l = layoutDag([node("a"), node("b")], [edge("a", "b")], { direction: "LR" });
    const a = at(l, "a");
    const b = at(l, "b");
    expect(l.edges[0].path.startsWith(`M${a.x + a.w},${a.y + a.h / 2} `)).toBe(true);
    expect(l.edges[0].path.endsWith(` ${b.x},${b.y + b.h / 2}`)).toBe(true);
    expect(l.edges[0].mid.x).toBeGreaterThan(a.x + a.w);
    expect(l.edges[0].mid.x).toBeLessThan(b.x);
  });
});

describe("robustness", () => {
  test("cycles do not hang: every node is placed and one edge is turned around", () => {
    const l = layoutDag([node("a"), node("b"), node("c")], [edge("a", "b"), edge("b", "c"), edge("c", "a")], { direction: "LR" });
    expect(l.nodes).toHaveLength(3);
    expect(l.edges).toHaveLength(3);
    expect(l.edges.filter((e) => e.back)).toHaveLength(1);
    expect(layerOf(l)).toEqual({ a: 0, b: 1, c: 2 });
    noOverlaps(l);
  });

  test("a retry loop (active → waiting → active) keeps a forward flow", () => {
    const l = layoutDag([node("waiting"), node("active"), node("done")], [edge("waiting", "active"), edge("active", "waiting"), edge("active", "done")], { direction: "LR" });
    expect(layerOf(l)).toEqual({ waiting: 0, active: 1, done: 2 });
    expect(l.edges.some((e) => e.back)).toBe(true);
  });

  test("a big cyclic graph finishes", () => {
    const nodes = Array.from({ length: 300 }, (_, i) => node(`n${i}`));
    const edges = nodes.flatMap((n, i) => [edge(n.id, `n${(i + 1) % 300}`), edge(n.id, `n${(i * 7 + 3) % 300}`)]);
    const l = layoutDag(nodes, edges, { direction: "LR" });
    expect(l.nodes).toHaveLength(300);
    noOverlaps(l);
  });

  test("self loops, unknown ends and repeated ids are ignored", () => {
    const l = layoutDag([node("a"), node("b")], [edge("a", "a"), edge("a", "x"), edge("a", "b"), edge("a", "b")], { direction: "LR" });
    expect(l.edges).toHaveLength(1);
    expect(layerOf(l)).toEqual({ a: 0, b: 1 });
  });

  test("nothing to lay out is an empty drawing", () => {
    const l = layoutDag([], [], { direction: "LR" });
    expect(l).toMatchObject({ nodes: [], edges: [], width: 0, height: 0 });
  });
});
