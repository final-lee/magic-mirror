import type { K8sMetrics, ObjectRef } from "./types";
import { HISTORY_MS, forgetUsage, historyKey, recordUsage, resetUsageHistory, usageOf } from "./usageHistory";

const target = { profile: "p", region: "r", cluster: "c" };
const key = historyKey(target, "ctx");
const podRef = (name: string): ObjectRef => ({ kind: { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true }, namespace: "app", name });

function metrics(...pods: [string, number][]): K8sMetrics {
  return {
    podsUnavailable: null, nodesUnavailable: null, nodes: [],
    pods: pods.map(([name, cpuMilli]) => ({
      namespace: "app", name, cpuMilli, memoryBytes: 1,
      containers: [{ name: "main", cpuMilli, memoryBytes: 1 }, { name: "side", cpuMilli: 0, memoryBytes: 1 }],
      owners: [],
    })),
  };
}

const cpuPoints = (name: string) => usageOf(key, podRef(name)).cpu.map((s) => [s.name, s.points]);

beforeEach(() => resetUsageHistory());

test("keeps one value per container in cores and skips samples taken too close together or out of order", () => {
  recordUsage(key, 0, metrics(["web", 250]));
  recordUsage(key, 5_000, metrics(["web", 900]));
  recordUsage(key, 15_000, metrics(["web", 500]));
  recordUsage(key, 14_000, metrics(["web", 700]));
  expect(cpuPoints("web")).toEqual([["main", [[0, 0.25], [15_000, 0.5]]], ["side", [[0, 0], [15_000, 0]]]]);
  expect(usageOf(key, podRef("web")).lastAt).toBe(15_000);
});

test("forgets values older than the history window and pods that have no values left", () => {
  recordUsage(key, 0, metrics(["old", 100], ["web", 100]));
  recordUsage(key, HISTORY_MS / 2, metrics(["web", 200]));
  recordUsage(key, HISTORY_MS + 1, metrics(["web", 300]));
  expect(cpuPoints("old")).toEqual([]);
  expect(cpuPoints("web")[0]).toEqual(["main", [[HISTORY_MS / 2, 0.2], [HISTORY_MS + 1, 0.3]]]);
});

test("closing a target forgets only that target's history", () => {
  const other = historyKey({ ...target, cluster: "other" }, "ctx");
  recordUsage(key, 0, metrics(["web", 100]));
  recordUsage(other, 0, metrics(["web", 100]));
  forgetUsage(target);
  expect(usageOf(key, podRef("web")).lastAt).toBeNull();
  expect(usageOf(other, podRef("web")).lastAt).toBe(0);
});
