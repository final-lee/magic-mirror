import { fireEvent, render, screen } from "@testing-library/react";
import { layoutGraph } from "./graphLayout";
import { WfGraph } from "./WfGraph";
import { node } from "./shellFixtures";

const none = new Set<string>();
const defaults = { direction: "LR" as const, collapsed: none, hiddenPhases: none, hiddenTypes: none, showArtifacts: false };

// 마름모 DAG: a → (b, c) → d, d에는 부모가 둘이다
const diamond = () => [
  node("a", { type: "DAG", phase: "Succeeded", children: ["b", "c"], podName: null }),
  node("b", { phase: "Succeeded", children: ["d"] }),
  node("c", { phase: "Failed", children: ["d"] }),
  node("d", { phase: "Succeeded" }),
];
const ids = (c: HTMLElement) => [...c.querySelectorAll("[data-node-id]")].map((n) => n.getAttribute("data-node-id"));

test("층 배치: 부모 다음 층에 놓고 여러 부모가 있는 노드도 한 번만 그린다", () => {
  const graph = layoutGraph(diamond(), defaults);
  expect(graph.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "d"]);
  const x = Object.fromEntries(graph.nodes.map((n) => [n.id, n.x]));
  expect(x.a).toBeLessThan(x.b);
  expect(x.b).toBe(x.c);
  expect(x.c).toBeLessThan(x.d);
  expect(graph.edges.map((e) => e.id).sort()).toEqual(["a->b", "a->c", "b->d", "c->d"]);
  // 세로로 바꾸면 층이 아래로 간다
  const tb = layoutGraph(diamond(), { ...defaults, direction: "TB" });
  expect(tb.nodes.find((n) => n.id === "a")!.y).toBeLessThan(tb.nodes.find((n) => n.id === "d")!.y);
});

test("그래프는 노드를 한 번씩만 그리고 phase로 거르면 앞뒤를 이어 그린다", () => {
  const { container } = render(<WfGraph nodes={diamond()} selected={null} onSelect={vi.fn()} />);
  expect(ids(container).sort()).toEqual(["a", "b", "c", "d"]);
  fireEvent.click(screen.getByRole("checkbox", { name: "Failed" }));
  expect(ids(container).sort()).toEqual(["a", "b", "d"]);
  // c를 건너뛰어도 a→d 흐름이 이어진다(b를 거쳐서도 이어져 있다)
  expect(
    layoutGraph(diamond(), { ...defaults, hiddenPhases: new Set(["Failed"]) })
      .edges.map((e) => e.id)
      .sort(),
  ).toEqual(["a->b", "a->d", "b->d"]);
  fireEvent.click(screen.getByRole("checkbox", { name: "Failed" }));
  expect(ids(container)).toHaveLength(4);
});

test("노드를 누르면 그 노드를 고른다", () => {
  const onSelect = vi.fn();
  render(<WfGraph nodes={diamond()} selected={null} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: "c" }));
  expect(onSelect).toHaveBeenCalledWith("c");
});

test("StepGroup을 접으면 그 안의 노드가 숨고 다음 단계는 그룹에서 이어진다", () => {
  const nodes = [
    node("wf", { type: "Steps", phase: "Succeeded", children: ["wf[0]"], podName: null, name: "wf" }),
    node("g0", { type: "StepGroup", phase: "Succeeded", name: "wf[0]", displayName: "[0]", children: ["m1", "m2"], podName: null }),
    node("m1", { phase: "Succeeded", name: "wf[0].one", children: ["g1"] }),
    node("m2", { phase: "Succeeded", name: "wf[0].two", children: ["g1"] }),
    node("g1", { type: "StepGroup", phase: "Succeeded", name: "wf[1]", displayName: "[1]", podName: null }),
  ];
  nodes[0].children = ["g0"];
  const { container } = render(<WfGraph nodes={nodes} selected={null} onSelect={vi.fn()} />);
  expect(ids(container).sort()).toEqual(["g0", "g1", "m1", "m2", "wf"]);
  fireEvent.click(screen.getByRole("button", { name: "[0] 접기" }));
  expect(ids(container).sort()).toEqual(["g0", "g1", "wf"]);
  expect(screen.getByText("StepGroup · 2개 접힘")).toBeInTheDocument();
  expect(
    layoutGraph(nodes, { ...defaults, collapsed: new Set(["g0"]) })
      .edges.map((e) => e.id)
      .sort(),
  ).toEqual(["g0->g1", "wf->g0"]);
  fireEvent.click(screen.getByRole("button", { name: "[0] 펼치기" }));
  expect(ids(container)).toHaveLength(5);
});

test("아티팩트 노드는 켰을 때만 보이고 누르면 그 노드를 고른다", () => {
  const onSelect = vi.fn();
  const nodes = [node("a", { phase: "Succeeded", artifacts: [{ name: "report", direction: "output", key: "k", repository: "s3" }] })];
  const { container } = render(<WfGraph nodes={nodes} selected={null} onSelect={onSelect} />);
  expect(ids(container)).toEqual(["a"]);
  fireEvent.click(screen.getByRole("checkbox", { name: "아티팩트" }));
  expect(ids(container)).toEqual(["a", "artifact:a:output:report"]);
  fireEvent.click(screen.getByRole("button", { name: "report" }));
  expect(onSelect).toHaveBeenCalledWith("a");
});

test("확대·축소 버튼은 배율을 바꾼다", () => {
  render(<WfGraph nodes={diamond()} selected={null} onSelect={vi.fn()} />);
  expect(screen.getByText("100%")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "확대" }));
  expect(screen.getByText("125%")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "원래 크기" }));
  expect(screen.getByText("100%")).toBeInTheDocument();
});
