import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { Problems, columnsFor, valueKeys } from "./columns";
import { DEPLOYMENTS, NODES, PODS, SECRETS } from "./kinds";
import {
  COL_AGE, COL_CPU, COL_CPU_OF_ALLOCATABLE, COL_CPU_OF_LIMIT, COL_CPU_OF_REQUEST, COL_MEMORY, COL_MEMORY_OF_ALLOCATABLE, COL_MEMORY_OF_LIMIT, COL_MEMORY_OF_REQUEST,
  COL_NAME, COL_NAMESPACE, COL_PROBLEMS, COLUMN_LABELS, PROBLEM_LABELS,
} from "./text";
import type { K8sMetrics, K8sRow } from "./types";
import { buildUsageIndex } from "./usage";

const widget = { group: "mm.example.com", version: "v1", kind: "Widget", plural: "widgets", namespaced: true };

test("value keys per kind", () => {
  expect(valueKeys(PODS)).toEqual(["ready", "status", "restarts", "node", "ip"]);
  expect(valueKeys(DEPLOYMENTS)).toEqual(["ready", "upToDate", "available"]);
  expect(valueKeys(SECRETS)).toEqual(["type", "keys"]);
  expect(valueKeys(NODES)).toEqual(["status", "version", "instanceType", "zone", "group"]);
  expect(valueKeys(widget)).toEqual(["ready"]);
});

test("columns: name, namespace when all namespaces, values, problems, age", () => {
  const labels = (cols: ReturnType<typeof columnsFor>) => cols.map((c) => c.label);
  expect(labels(columnsFor(DEPLOYMENTS, true, 0))).toEqual([COL_NAME, COL_NAMESPACE, COLUMN_LABELS.ready, COLUMN_LABELS.upToDate, COLUMN_LABELS.available, COL_PROBLEMS, COL_AGE]);
  expect(labels(columnsFor(DEPLOYMENTS, false, 0))).not.toContain(COL_NAMESPACE);
  expect(labels(columnsFor(NODES, true, 0))).not.toContain(COL_NAMESPACE);
});

test("problems render as labelled badges", () => {
  render(<Problems problems={["crashLoopBackOff", "notReady"]} />);
  expect(screen.getByText(PROBLEM_LABELS.crashLoopBackOff)).toBeInTheDocument();
  expect(screen.getByText(PROBLEM_LABELS.notReady)).toBeInTheDocument();
});

test("age column sorts by creation time and renders relative age", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const ageCol = columnsFor(PODS, false, now).find((c) => c.key === "age")!;
  const r: K8sRow = { uid: "u", name: "p", namespace: "web", resourceVersion: "1", createdAt: "2026-10-30T11:15:00Z", labels: {}, values: {}, problems: [] };
  expect(ageCol.sort!(r)).toBe(Date.parse("2026-10-30T11:15:00Z"));
  render(<>{ageCol.render(r)}</>);
  expect(screen.getByText("45m")).toBeInTheDocument();
});

const podRow = (name: string, values: Record<string, string> = {}): K8sRow => ({ uid: name, name, namespace: "web", resourceVersion: "1", createdAt: null, labels: {}, values, problems: [] });
const usageOf = (m: Partial<K8sMetrics>) => buildUsageIndex({ podsUnavailable: null, nodesUnavailable: null, pods: [], nodes: [], ...m });
const labelsOf = (cols: ReturnType<typeof columnsFor>) => cols.map((c) => c.label);
const col = (cols: ReturnType<typeof columnsFor>, label: string) => cols.find((c) => c.label === label)!;
const text = (c: { render: (r: K8sRow) => ReactNode }, r: K8sRow) => render(<>{c.render(r)}</>).container.textContent;

test("pod usage columns: usage, then percent of request and of limit, blank when not set", () => {
  const usage = usageOf({ pods: [{ namespace: "web", name: "api", cpuMilli: 450, memoryBytes: 90 * 1024 * 1024, containers: [], owners: [] }] });
  const cols = columnsFor(PODS, false, 0, usage);
  expect(labelsOf(cols)).toEqual([COL_NAME, ...valueKeys(PODS).map((k) => COLUMN_LABELS[k]), COL_CPU, COL_MEMORY, COL_CPU_OF_REQUEST, COL_CPU_OF_LIMIT, COL_MEMORY_OF_REQUEST, COL_MEMORY_OF_LIMIT, COL_PROBLEMS, COL_AGE]);
  const api = podRow("api", { cpuRequest: "500", cpuLimit: "1000", memoryRequest: String(100 * 1024 * 1024) });
  expect(text(col(cols, COL_CPU), api)).toBe("450m");
  expect(text(col(cols, COL_MEMORY), api)).toBe("90 MiB");
  expect(text(col(cols, COL_CPU_OF_REQUEST), api)).toBe("90%");
  expect(text(col(cols, COL_CPU_OF_LIMIT), api)).toBe("45%");
  expect(text(col(cols, COL_MEMORY_OF_REQUEST), api)).toBe("90%");
  expect(text(col(cols, COL_MEMORY_OF_LIMIT), api)).toBe("");
  // 사용량을 아직 모르는 Pod(방금 만든 것)는 비운다
  const fresh = podRow("fresh", { cpuRequest: "500" });
  expect(text(col(cols, COL_CPU), fresh)).toBe("");
  expect(text(col(cols, COL_CPU_OF_REQUEST), fresh)).toBe("");
});

test("usage over 90% is highlighted, exactly 90% is not", () => {
  const usage = usageOf({ pods: [{ namespace: "web", name: "hot", cpuMilli: 950, memoryBytes: 0, containers: [], owners: [] }, { namespace: "web", name: "edge", cpuMilli: 900, memoryBytes: 0, containers: [], owners: [] }] });
  const cpuReq = col(columnsFor(PODS, false, 0, usage), COL_CPU_OF_REQUEST);
  const hot = render(<>{cpuReq.render(podRow("hot", { cpuRequest: "1000" }))}</>).container.querySelector(".k8s-hot");
  expect(hot).toHaveTextContent("95%");
  expect(render(<>{cpuReq.render(podRow("edge", { cpuRequest: "1000" }))}</>).container.querySelector(".k8s-hot")).toBeNull();
});

test("pod percent cells draw the collected trend against today's request or limit, breaking where sampling stopped", () => {
  const usage = usageOf({ pods: [{ namespace: "web", name: "api", cpuMilli: 2000, memoryBytes: 50, containers: [], owners: [] }] });
  const hour = 3_600_000;
  const trendOf = (namespace: string, name: string) => (namespace === "web" && name === "api"
    ? { at: [0, 15_000, hour], cpu: [0.25, 0.5, 2], memory: [10, 20, 50], end: hour }
    : null);
  const cols = columnsFor(PODS, false, 0, usage, trendOf);
  const api = podRow("api", { cpuRequest: "1000", memoryRequest: "100" });
  const cpu = render(<>{col(cols, COL_CPU_OF_REQUEST).render(api)}</>).container;
  expect(cpu).toHaveTextContent("200%");
  const svg = cpu.querySelector("svg.k8s-trend")!;
  expect(svg).toHaveClass("hot");
  // 15초 간격의 두 값은 선으로, 한 시간 뒤의 값은 따로 점으로
  expect(svg.querySelectorAll("polyline")).toHaveLength(1);
  expect(svg.querySelectorAll("circle")).toHaveLength(1);
  // 최고 200%라 세로축이 200%까지 늘어나고 100% 점선은 가운데쯤에 온다
  expect(svg.querySelector("circle")!.getAttribute("cy")).toBe("1");
  expect(svg.querySelector(".k8s-trend-guide")!.getAttribute("y1")).toBe("9");
  const memory = render(<>{col(cols, COL_MEMORY_OF_REQUEST).render(api)}</>).container;
  expect(memory).toHaveTextContent("50%");
  expect(memory.querySelector("svg.k8s-trend")).not.toHaveClass("hot");
  // 기준(제한)이 없으면 칸도 그래프도 비운다
  expect(render(<>{col(cols, COL_CPU_OF_LIMIT).render(api)}</>).container.querySelector("svg")).toBeNull();
  // 아직 모으지 않은 Pod는 숫자만
  const other = usageOf({ pods: [{ namespace: "web", name: "new", cpuMilli: 100, memoryBytes: 0, containers: [], owners: [] }] });
  const fresh = render(<>{col(columnsFor(PODS, false, 0, other, trendOf), COL_CPU_OF_REQUEST).render(podRow("new", { cpuRequest: "1000" }))}</>).container;
  expect(fresh).toHaveTextContent("10%");
  expect(fresh.querySelector("svg")).toBeNull();
});

test("usage columns sort by value and put missing values last", () => {
  const usage = usageOf({ pods: [{ namespace: "web", name: "a", cpuMilli: 100, memoryBytes: 5, containers: [], owners: [] }, { namespace: "web", name: "b", cpuMilli: 300, memoryBytes: 1, containers: [], owners: [] }] });
  const cols = columnsFor(PODS, false, 0, usage);
  const cpu = col(cols, COL_CPU).sort!;
  expect([cpu(podRow("a")), cpu(podRow("b")), cpu(podRow("none"))]).toEqual([100, 300, null]);
  const pctLimit = col(cols, COL_CPU_OF_LIMIT).sort!;
  expect(pctLimit(podRow("a", { cpuLimit: "200" }))).toBe(50);
  expect(pctLimit(podRow("a"))).toBeNull();
});

test("node usage columns compare with allocatable", () => {
  const usage = usageOf({ nodes: [{ name: "n1", cpuMilli: 1000, memoryBytes: 4 * 1024 ** 3 }] });
  const cols = columnsFor(NODES, false, 0, usage);
  const n1 = { ...podRow("n1", { cpuAllocatable: "2000", memoryAllocatable: String(8 * 1024 ** 3) }), namespace: null };
  expect(text(col(cols, COL_CPU), n1)).toBe("1");
  expect(text(col(cols, COL_MEMORY), n1)).toBe("4 GiB");
  expect(text(col(cols, COL_CPU_OF_ALLOCATABLE), n1)).toBe("50%");
  expect(text(col(cols, COL_MEMORY_OF_ALLOCATABLE), n1)).toBe("50%");
  expect(labelsOf(cols)).not.toContain(COL_CPU_OF_REQUEST);
});

test("workload usage is the sum over its pods, only cpu and memory", () => {
  const owners = [{ kind: "ReplicaSet", name: "web-5d" }, { kind: "Deployment", name: "web" }];
  const usage = usageOf({ pods: [
    { namespace: "web", name: "p1", cpuMilli: 100, memoryBytes: 1024, containers: [], owners },
    { namespace: "web", name: "p2", cpuMilli: 250, memoryBytes: 2048, containers: [], owners },
  ] });
  const cols = columnsFor(DEPLOYMENTS, false, 0, usage);
  expect(labelsOf(cols)).toEqual([COL_NAME, COLUMN_LABELS.ready, COLUMN_LABELS.upToDate, COLUMN_LABELS.available, COL_CPU, COL_MEMORY, COL_PROBLEMS, COL_AGE]);
  expect(text(col(cols, COL_CPU), podRow("web"))).toBe("350m");
  expect(text(col(cols, COL_MEMORY), podRow("web"))).toBe("3 KiB");
  expect(text(col(cols, COL_CPU), podRow("idle"))).toBe("");
});

test("no usage columns when metrics are unavailable, missing, or the kind has none", () => {
  const plain = labelsOf(columnsFor(PODS, false, 0));
  expect(labelsOf(columnsFor(PODS, false, 0, null))).toEqual(plain);
  expect(labelsOf(columnsFor(PODS, false, 0, usageOf({ podsUnavailable: "notInstalled" })))).toEqual(plain);
  expect(labelsOf(columnsFor(SECRETS, false, 0, usageOf({})))).toEqual(labelsOf(columnsFor(SECRETS, false, 0)));
  // 노드는 Pod 쪽이 막혀도 노드 사용량을 읽었으면 보인다
  expect(labelsOf(columnsFor(NODES, false, 0, usageOf({ podsUnavailable: "forbidden" })))).toContain(COL_CPU);
  expect(labelsOf(columnsFor(NODES, false, 0, usageOf({ nodesUnavailable: "forbidden" })))).not.toContain(COL_CPU);
});
