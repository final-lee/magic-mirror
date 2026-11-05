import { describe, expect, it } from "vitest";
import type { ArgoAppRow } from "../types";
import { destinationOf, podsOfTree, sumUsage, topUsage, type UsageRow } from "./appUsage";
import type { Bounds, PodReading } from "./types";

const none: Bounds = { cpuRequest: null, cpuLimit: null, memoryRequest: null, memoryLimit: null };
const pod = (name: string, cpu: number | null, mem: number | null, bounds: Partial<Bounds> = {}): PodReading => ({ namespace: "web", name, cpuMilli: cpu, memoryBytes: mem, bounds: { ...none, ...bounds } });

describe("sumUsage", () => {
  it("adds usage over pods that report and compares it with their summed requests and limits", () => {
    const sum = sumUsage([
      pod("a", 100, 100, { cpuRequest: 200, cpuLimit: 500, memoryRequest: 128, memoryLimit: 256 }),
      pod("b", 50, 60, { cpuRequest: 200, cpuLimit: 500, memoryRequest: 128, memoryLimit: 256 }),
    ]);
    expect(sum).toEqual({ pods: 2, reporting: 2, cpuMilli: 150, memoryBytes: 160, cpuRequest: 400, cpuLimit: 1000, memoryRequest: 256, memoryLimit: 512 });
  });

  it("leaves a bound empty when any reporting pod has none, and ignores pods metrics-server has not seen yet", () => {
    const sum = sumUsage([pod("a", 10, 10, { cpuRequest: 100 }), pod("b", 20, 20, {}), pod("new", null, null, { cpuRequest: 100 })]);
    expect(sum.pods).toBe(3);
    expect(sum.reporting).toBe(2);
    expect(sum.cpuMilli).toBe(30);
    expect(sum.cpuRequest).toBeNull();
    const onlyNew = sumUsage([pod("new", null, null, { cpuRequest: 100 })]);
    expect(onlyNew).toMatchObject({ reporting: 0, cpuMilli: 0, cpuRequest: null });
  });
});

describe("podsOfTree", () => {
  it("takes core Pods with a namespace and skips other kinds, other groups and cluster-scoped nodes", () => {
    const nodes = [
      { group: "", kind: "Pod", namespace: "web", name: "api-1" },
      { group: "apps", kind: "Deployment", namespace: "web", name: "api" },
      { group: "example.io", kind: "Pod", namespace: "web", name: "odd" },
      { group: "", kind: "Pod", namespace: null, name: "no-namespace" },
    ];
    expect(podsOfTree(nodes)).toEqual([{ namespace: "web", name: "api-1" }]);
  });
});

describe("destinationOf", () => {
  const row = (destination?: string): ArgoAppRow => ({ name: "a", namespace: "argocd", resourceVersion: "1", labels: {}, values: destination === undefined ? {} : { destination } });
  it("tells a server address from a cluster name and recognises both spellings of in-cluster", () => {
    expect(destinationOf(row("https://x.eks.amazonaws.com"))).toEqual({ server: "https://x.eks.amazonaws.com", name: null, inCluster: false });
    expect(destinationOf(row("prd"))).toEqual({ server: null, name: "prd", inCluster: false });
    expect(destinationOf(row("https://kubernetes.default.svc"))).toMatchObject({ inCluster: true });
    expect(destinationOf(row("in-cluster"))).toMatchObject({ inCluster: true, server: null });
    expect(destinationOf(row())).toEqual({ server: null, name: null, inCluster: false });
  });
});

describe("topUsage", () => {
  it("sorts by the chosen resource, ties by key, and cuts at the limit", () => {
    const rows: UsageRow[] = [
      { key: "argocd/b", namespace: "argocd", name: "b", sum: { ...sumUsage([pod("p", 50, 900)]) } },
      { key: "argocd/a", namespace: "argocd", name: "a", sum: { ...sumUsage([pod("p", 50, 100)]) } },
      { key: "argocd/c", namespace: "argocd", name: "c", sum: { ...sumUsage([pod("p", 500, 10)]) } },
    ];
    expect(topUsage(rows, "cpuMilli", 2).map((r) => r.name)).toEqual(["c", "a"]);
    expect(topUsage(rows, "memoryBytes", 5).map((r) => r.name)).toEqual(["b", "a", "c"]);
  });
});
