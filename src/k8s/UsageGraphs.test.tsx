import { act, render, screen } from "@testing-library/react";
import { UsageGraphs } from "./UsageGraphs";
import { METRICS_UNAVAILABLE, USAGE_GRAPH_EMPTY, USAGE_GRAPH_WAITING } from "./text";
import type { K8sMetrics, K8sObjectView, K8sPodUsage, ObjectRef } from "./types";
import { historyKey, recordUsage, resetUsageHistory } from "./usageHistory";

const target = { profile: "p", region: "r", cluster: "c" };
const key = historyKey(target, "ctx");
const objectRef: ObjectRef = { kind: { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true }, namespace: "app", name: "web" };
const deployment: ObjectRef = { ...objectRef, kind: { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true } };
const view = { containers: [{ name: "web", init: false, state: "running", cpuRequest: 500, memoryLimit: 1073741824 }] } as K8sObjectView;
const T0 = new Date(2026, 10, 3, 10, 0).getTime();

function pod(name: string, cpuMilli: number, memoryBytes: number, owner = "web"): K8sPodUsage {
  return {
    namespace: "app", name, cpuMilli, memoryBytes,
    containers: [{ name: "web", cpuMilli, memoryBytes }],
    owners: [{ kind: "ReplicaSet", name: `${owner}-1` }, { kind: "Deployment", name: owner }],
  };
}

const metrics = (...pods: K8sPodUsage[]): K8sMetrics => ({ podsUnavailable: null, nodesUnavailable: null, pods, nodes: [] });

beforeEach(() => resetUsageHistory());

function setup(ref = objectRef, objectView = view) {
  return render(<UsageGraphs target={target} context="ctx" objectRef={ref} view={objectView} />);
}

test("before the first sample it says values are still being collected", () => {
  setup();
  expect(screen.getByText(USAGE_GRAPH_WAITING)).toBeInTheDocument();
});

test("explains why usage cannot be collected", () => {
  recordUsage(key, T0, { ...metrics(), podsUnavailable: "notInstalled" });
  setup();
  expect(screen.getByText(METRICS_UNAVAILABLE.notInstalled)).toBeInTheDocument();
});

test("a pod shows its containers with request and limit lines and follows new samples", () => {
  recordUsage(key, T0, metrics(pod("web", 250, 536870912)));
  setup();
  expect(screen.getAllByText("web 요청: 500m")).toHaveLength(2);
  expect(screen.getAllByText("web 제한: 1 GiB")).toHaveLength(2);
  expect(screen.getByText("0.5 GiB")).toBeInTheDocument();
  // 축 끝은 마지막으로 모은 시각, 시작은 한 시간 전
  expect(screen.getAllByText("10:00")).toHaveLength(2);
  expect(screen.getAllByText("09:00")).toHaveLength(2);

  act(() => recordUsage(key, T0 + 60_000, metrics(pod("web", 2000, 536870912))));
  expect(screen.getAllByText("10:01")).toHaveLength(2);
  expect(screen.getByText("2 코어")).toBeInTheDocument();
});

test("a pod with nothing collected yet says so per chart", () => {
  recordUsage(key, T0, metrics(pod("other", 100, 100)));
  setup();
  expect(screen.getAllByText(USAGE_GRAPH_EMPTY)).toHaveLength(2);
});

test("lines break where sampling stopped", () => {
  recordUsage(key, T0, metrics(pod("web", 100, 100)));
  recordUsage(key, T0 + 15_000, metrics(pod("web", 100, 100)));
  recordUsage(key, T0 + 10 * 60_000, metrics(pod("web", 100, 100)));
  recordUsage(key, T0 + 10 * 60_000 + 15_000, metrics(pod("web", 100, 100)));
  const { container } = setup();
  const cpu = container.querySelector("svg[aria-label='CPU']")!;
  expect(cpu.querySelectorAll("polyline")).toHaveLength(2);
});

test("a workload draws one line per pod it controls and sums only complete template values", () => {
  recordUsage(key, T0, metrics(pod("web-a", 100, 100), pod("web-b", 200, 200), pod("api-a", 300, 300, "api")));
  const template = { containers: [
    { name: "one", state: "template", init: false, cpuRequest: 250, memoryLimit: 512 },
    { name: "two", state: "template", init: false, cpuRequest: 500, memoryLimit: null },
  ] } as K8sObjectView;
  const { container } = setup(deployment, template);
  const legend = [...container.querySelectorAll(".k8s-usage-legend")[0].querySelectorAll("span")].map((s) => s.textContent);
  expect(legend).toEqual(["web-a", "web-b"]);
  expect(screen.getAllByText("Pod 요청: 750m")).toHaveLength(2);
  expect(screen.queryByText(/Pod 제한/)).not.toBeInTheDocument();
});

test("a node draws its own line against allocatable", () => {
  const node: ObjectRef = { kind: { group: "", version: "v1", kind: "Node", plural: "nodes", namespaced: false }, namespace: null, name: "ip-1" };
  recordUsage(key, T0, { ...metrics(), nodes: [{ name: "ip-1", cpuMilli: 1000, memoryBytes: 2 * 1024 ** 3 }] });
  const nodeView = { containers: [], row: { values: { cpuAllocatable: "2000", memoryAllocatable: String(8 * 1024 ** 3) } } } as unknown as K8sObjectView;
  const { container } = setup(node, nodeView);
  expect([...container.querySelectorAll(".k8s-usage-legend span")].map((s) => s.textContent)).toEqual(["ip-1", "ip-1"]);
  expect(screen.getAllByText("할당 가능: 2 코어")).toHaveLength(2);
  expect(screen.getAllByText("할당 가능: 8 GiB")).toHaveLength(2);
});
