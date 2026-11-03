import { CRONJOBS, DEPLOYMENTS, JOBS, NODES, PODS, SERVICES } from "./kinds";
import type { K8sMetrics, K8sPodUsage, K8sRow } from "./types";
import { HOT_PCT, buildUsageIndex, isHot, namespaceTotals, numValue, pct, podKey, top, unavailableFor, usageKindOf, workloadKey } from "./usage";

const pod = (namespace: string, name: string, cpuMilli: number, memoryBytes: number, owners: K8sPodUsage["owners"] = []): K8sPodUsage => ({
  namespace, name, cpuMilli, memoryBytes, containers: [{ name: "app", cpuMilli, memoryBytes }], owners,
});
const metrics = (over: Partial<K8sMetrics> = {}): K8sMetrics => ({ podsUnavailable: null, nodesUnavailable: null, pods: [], nodes: [], ...over });
const row = (values: Record<string, string>): K8sRow => ({ uid: "u", name: "p", namespace: "web", resourceVersion: "1", createdAt: null, labels: {}, values, problems: [] });

test("pct is usage over the base, blank without a base", () => {
  expect(pct(50, 200)).toBe(25);
  expect(pct(50, null)).toBeNull();
  expect(pct(50, 0)).toBeNull();
  expect(pct(300, 100)).toBe(300);
});

test("hot means strictly over 90%", () => {
  expect(HOT_PCT).toBe(90);
  expect(isHot(pct(90, 100))).toBe(false);
  expect(isHot(pct(91, 100))).toBe(true);
  expect(isHot(null)).toBe(false);
});

test("numValue reads integer texts and nothing else", () => {
  expect(numValue(row({ cpuRequest: "150" }), "cpuRequest")).toBe(150);
  expect(numValue(row({}), "cpuRequest")).toBeNull();
  expect(numValue(row({ cpuRequest: "x" }), "cpuRequest")).toBeNull();
});

test("pod usage is summed into every controller of its chain", () => {
  const rs = { kind: "ReplicaSet", name: "web-5d" };
  const dep = { kind: "Deployment", name: "web" };
  const idx = buildUsageIndex(metrics({
    pods: [pod("prod", "web-5d-a", 100, 1000, [rs, dep]), pod("prod", "web-5d-b", 50, 500, [rs, dep]), pod("dev", "web-5d-c", 7, 70, [rs, dep]), pod("prod", "lone", 1, 1)],
    nodes: [{ name: "n1", cpuMilli: 900, memoryBytes: 9000 }],
  }));
  expect(idx.pods.get(podKey("prod", "lone"))).toEqual({ cpuMilli: 1, memoryBytes: 1 });
  expect(idx.workloads.get(workloadKey("Deployment", "prod", "web"))).toEqual({ cpuMilli: 150, memoryBytes: 1500, pods: 2 });
  expect(idx.workloads.get(workloadKey("ReplicaSet", "prod", "web-5d"))).toEqual({ cpuMilli: 150, memoryBytes: 1500, pods: 2 });
  // 같은 이름이어도 네임스페이스가 다르면 따로 센다
  expect(idx.workloads.get(workloadKey("Deployment", "dev", "web"))?.pods).toBe(1);
  expect(idx.workloads.get(workloadKey("Deployment", "prod", "none"))).toBeUndefined();
  expect(idx.nodes.get("n1")).toEqual({ cpuMilli: 900, memoryBytes: 9000 });
  expect(idx.containers.get(podKey("prod", "lone"))).toEqual([{ name: "app", cpuMilli: 1, memoryBytes: 1 }]);
});

test("which kinds get usage columns, and which side's reason applies", () => {
  expect(usageKindOf(PODS)).toBe("pod");
  expect(usageKindOf(NODES)).toBe("node");
  expect(usageKindOf(DEPLOYMENTS)).toBe("workload");
  expect(usageKindOf(JOBS)).toBe("workload");
  expect(usageKindOf(CRONJOBS)).toBe("workload");
  expect(usageKindOf(SERVICES)).toBeNull();
  const idx = buildUsageIndex(metrics({ podsUnavailable: "notInstalled", nodesUnavailable: null }));
  expect(unavailableFor(PODS, idx)).toBe("notInstalled");
  expect(unavailableFor(DEPLOYMENTS, idx)).toBe("notInstalled");
  expect(unavailableFor(NODES, idx)).toBeNull();
  expect(unavailableFor(SERVICES, idx)).toBeNull();
});

test("namespace totals and the top list by cpu or memory", () => {
  const totals = namespaceTotals(metrics({ pods: [pod("a", "1", 100, 10), pod("a", "2", 100, 10), pod("b", "1", 150, 500), pod("c", "1", 150, 5)] }));
  expect(totals).toContainEqual({ namespace: "a", cpuMilli: 200, memoryBytes: 20, pods: 2 });
  expect(top(totals, "cpuMilli", 2).map((t) => t.namespace)).toEqual(["a", "b"]);
  expect(top(totals, "memoryBytes", 3).map((t) => t.namespace)).toEqual(["b", "a", "c"]);
  expect(namespaceTotals(metrics())).toEqual([]);
});
