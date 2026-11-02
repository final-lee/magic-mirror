import { render, screen, within } from "@testing-library/react";
import { ArgoTree, buildTreeRows } from "./ArgoTree";
import { ARGO_HOOK, ARGO_NO_RESOURCES, ARGO_PRUNING, ARGO_TREE_LABEL } from "./text";
import type { ArgoResource, ArgoTreeNode } from "./types";

const node = (uid: string, kind: string, name: string, over: Partial<ArgoTreeNode> = {}): ArgoTreeNode => ({
  uid, group: kind === "Deployment" || kind === "ReplicaSet" ? "apps" : "", version: "v1", kind, namespace: "web", name,
  parents: [], health: null, healthMessage: null, info: [], images: [], createdAt: null, ...over,
});
const res = (group: string, kind: string, name: string, over: Partial<ArgoResource> = {}): ArgoResource => ({
  group, version: "v1", kind, namespace: "web", name, status: "Synced", hook: false, requiresPruning: false, ...over,
});

const NODES = [
  node("pod-1", "Pod", "web-abc-1", { parents: ["rs-1"], health: "Healthy", info: ["Status Reason: Running", "Containers: 1/1"] }),
  node("rs-1", "ReplicaSet", "web-abc", { parents: ["dep-1"], health: "Progressing", healthMessage: "Waiting for rollout" }),
  node("dep-1", "Deployment", "web", { health: "Degraded", healthMessage: "0/2 ready" }),
  node("svc-1", "Service", "web-svc", { health: "Healthy" }),
];
const RESOURCES = [
  res("apps", "Deployment", "web", { status: "OutOfSync" }),
  res("", "Service", "web-svc", { requiresPruning: true }),
  res("batch", "Job", "migrate", { hook: true }),
];

test("rows nest parent → child in order with their depth", () => {
  const rows = buildTreeRows(NODES, RESOURCES);
  expect(rows.slice(0, 4).map((r) => [r.depth, r.kind, r.name])).toEqual([
    [0, "Deployment", "web"],
    [1, "ReplicaSet", "web-abc"],
    [2, "Pod", "web-abc-1"],
    [0, "Service", "web-svc"],
  ]);
});

test("Sync, hook and pruning marks attach from app.resources to the same group/kind/namespace/name", () => {
  const rows = buildTreeRows(NODES, RESOURCES);
  const byName = (n: string) => rows.find((r) => r.name === n)!;
  expect(byName("web").sync).toBe("OutOfSync");
  expect(byName("web-svc").sync).toBe("Synced");
  expect(byName("web-svc").requiresPruning).toBe(true);
  // 트리에 없는 리소스(hook Job)는 맨 끝에 Sync만 달고 붙는다
  expect(rows[rows.length - 1]).toMatchObject({ depth: 0, kind: "Job", name: "migrate", health: null, sync: "Synced", hook: true });
  // ReplicaSet은 resources에 없으니 Sync가 없다
  expect(byName("web-abc").sync).toBeNull();
  // 같은 이름이라도 group이 다르면 붙지 않는다
  const other = buildTreeRows([node("d", "Deployment", "web", { group: "extensions" })], [res("apps", "Deployment", "web")]);
  expect(other[0].sync).toBeNull();
});

test("a node whose parent is missing is a top row; siblings sort by kind then name", () => {
  const rows = buildTreeRows([node("b", "Service", "b"), node("a", "Service", "a"), node("c", "ConfigMap", "z", { parents: ["gone"] })], []);
  expect(rows.map((r) => `${r.depth}:${r.kind}/${r.name}`)).toEqual(["0:ConfigMap/z", "0:Service/a", "0:Service/b"]);
});

test("a parent cycle still lists every node once", () => {
  const rows = buildTreeRows([node("a", "ReplicaSet", "a", { parents: ["b"] }), node("b", "ReplicaSet", "b", { parents: ["a"] }), node("self", "Pod", "self", { parents: ["self"] })], []);
  expect(rows.map((r) => r.name).sort()).toEqual(["a", "b", "self"]);
});

test("the rendered tree shows levels, Health colors, messages, info and marks", () => {
  render(<ArgoTree nodes={NODES} resources={RESOURCES} />);
  const items = within(screen.getByRole("tree", { name: ARGO_TREE_LABEL })).getAllByRole("treeitem");
  expect(items.map((i) => i.getAttribute("aria-level"))).toEqual(["1", "2", "3", "1", "1"]);
  const dep = items[0];
  expect(dep).toHaveTextContent("Deployment");
  expect(within(dep).getByText("Degraded")).toHaveClass("argo-bad");
  expect(within(dep).getByText("OutOfSync")).toHaveClass("argo-warn");
  expect(within(dep).getByText("0/2 ready")).toBeInTheDocument();
  expect(within(items[1]).getByText("Progressing")).toHaveClass("argo-warn");
  expect(within(items[1]).getByText("Waiting for rollout")).toBeInTheDocument();
  expect(within(items[2]).getByText("Healthy")).toHaveClass("argo-ok");
  expect(within(items[2]).getByText("Status Reason: Running")).toBeInTheDocument();
  expect(within(items[2]).getByText("Containers: 1/1")).toBeInTheDocument();
  expect(within(items[3]).getByText(ARGO_PRUNING)).toBeInTheDocument();
  expect(within(items[4]).getByText(ARGO_HOOK)).toBeInTheDocument();
  expect(within(items[4]).getByText("migrate")).toBeInTheDocument();
});

test("no nodes and no resources says so", () => {
  render(<ArgoTree nodes={[]} resources={[]} />);
  expect(screen.getByText(ARGO_NO_RESOURCES)).toBeInTheDocument();
});
