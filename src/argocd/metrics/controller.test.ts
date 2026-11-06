import { describe, expect, it } from "vitest";
import { HISTORY_POINTS, appendPoint, bucketsOf, latencyOf, pointOf, quantile, type ControllerPoint } from "./controller";
import type { ControllerScrape, PromSeries } from "./types";

const bucket = (le: string, value: number, delta: number | null, component = "controller", name = "argocd_app_reconcile_bucket"): PromSeries => ({ component, name, labels: { le }, value, delta });

describe("quantile", () => {
  const buckets = [{ le: 0.25, count: 6 }, { le: 1, count: 9 }, { le: Infinity, count: 10 }];

  it("interpolates inside the bucket that holds the rank", () => {
    expect(quantile(0.5, buckets)).toBeCloseTo(0.25 * (5 / 6));
    expect(quantile(0.8, buckets)).toBeCloseTo(0.25 + 0.75 * ((8 - 6) / 3));
  });

  it("answers the highest finite bound when the rank falls in the +Inf bucket", () => {
    expect(quantile(0.95, buckets)).toBe(1);
  });

  it("is null without observations or without a +Inf bucket", () => {
    expect(quantile(0.5, [{ le: 1, count: 0 }, { le: Infinity, count: 0 }])).toBeNull();
    expect(quantile(0.5, [{ le: 1, count: 3 }])).toBeNull();
    expect(quantile(0.5, [])).toBeNull();
  });

  it("does not depend on bucket order", () => {
    expect(quantile(0.5, [...buckets].reverse())).toBe(quantile(0.5, buckets));
  });
});

describe("bucketsOf and latencyOf", () => {
  // 서버 두 곳의 버킷이 le마다 더해진 상태로 오지만 여러 컴포넌트가 같은 이름을 줄 수도 있다
  const series = [bucket("0.5", 100, 2), bucket("1", 150, 8), bucket("+Inf", 200, 10)];

  it("takes only observations since the previous read when deltas exist", () => {
    expect(bucketsOf(series, "argocd_app_reconcile", "delta")).toEqual([{ le: 0.5, count: 2 }, { le: 1, count: 8 }, { le: Infinity, count: 10 }]);
    const windowed = latencyOf(series, "argocd_app_reconcile");
    expect(windowed).toMatchObject({ cumulative: false });
    // 10건 중 중앙값은 두 번째 버킷(0.5~1)
    expect(windowed?.p50).toBeCloseTo(0.5 + 0.5 * ((5 - 2) / 6));
  });

  it("falls back to the cumulative histogram on the first read", () => {
    const first = series.map((s) => ({ ...s, delta: null }));
    expect(bucketsOf(first, "argocd_app_reconcile", "delta")).toBeNull();
    expect(latencyOf(first, "argocd_app_reconcile")).toMatchObject({ cumulative: true });
  });

  it("reports no latency (not the lifetime value) when nothing was observed since the previous read", () => {
    const quiet = series.map((s) => ({ ...s, delta: 0 }));
    expect(latencyOf(quiet, "argocd_app_reconcile")).toEqual({ p50: null, p95: null, cumulative: false });
  });

  it("is null when the family is absent", () => {
    expect(latencyOf(series, "argocd_git_request_duration_seconds")).toBeNull();
  });
});

describe("pointOf", () => {
  const scrape: ControllerScrape = {
    at: 1_000_000,
    components: [
      { component: "controller", service: "c", ok: true, error: null, intervalMs: 30_000 },
      { component: "repo-server", service: "r", ok: true, error: null, intervalMs: 60_000 },
      { component: "appset-controller", service: "a", ok: true, error: null, intervalMs: 30_000 },
      { component: "server", service: "s", ok: false, error: "없어요", intervalMs: null },
    ],
    series: [
      bucket("0.5", 10, 5), bucket("+Inf", 10, 5),
      { component: "controller", name: "argocd_app_sync_total", labels: { phase: "Succeeded" }, value: 120, delta: 6 },
      { component: "controller", name: "argocd_app_sync_total", labels: { phase: "Failed" }, value: 4, delta: 0 },
      { component: "repo-server", name: "argocd_git_request_total", labels: { request_type: "ls-remote" }, value: 900, delta: 30 },
      { component: "controller", name: "argocd_cluster_info", labels: { name: "prd", server: "https://prd", k8s_version: "v1.36" }, value: 1, delta: null },
      { component: "controller", name: "argocd_cluster_connection_status", labels: { server: "https://prd" }, value: 0, delta: null },
      { component: "controller", name: "argocd_cluster_api_resource_objects", labels: { server: "https://prd" }, value: 700, delta: null },
      { component: "controller", name: "workqueue_depth", labels: { name: "app_reconciliation_queue" }, value: 7, delta: null },
      { component: "appset-controller", name: "workqueue_depth", labels: { name: "applicationset" }, value: 0, delta: null },
      { component: "controller", name: "argocd_kubectl_exec_pending", labels: { command: "apply" }, value: 2, delta: null },
      { component: "controller", name: "argocd_kubectl_exec_pending", labels: { command: "auth" }, value: 1, delta: null },
      { component: "appset-controller", name: "controller_runtime_reconcile_errors_total", labels: { controller: "applicationset" }, value: 3, delta: 3 },
    ],
  };

  it("derives rates from each component's own interval and sums gauges", () => {
    const point = pointOf(scrape);
    // 30초 사이 6건 → 분당 12, 실패는 0
    expect(point.syncByPhase).toEqual([{ key: "Failed", total: 4, perMin: 0 }, { key: "Succeeded", total: 120, perMin: 12 }]);
    // 60초 사이 30건 → 분당 30
    expect(point.gitRequests).toEqual([{ key: "ls-remote", total: 900, perMin: 30 }]);
    expect(point.execPending).toBe(3);
    expect(point.appsetErrors).toEqual({ total: 3, perMin: 6 });
    expect(point.queues.map((q) => [q.component, q.name, q.depth])).toEqual([["appset-controller", "applicationset", 0], ["controller", "app_reconciliation_queue", 7]]);
    expect(point.reconcile?.cumulative).toBe(false);
    expect(point.components.find((c) => c.component === "server")?.error).toBe("없어요");
  });

  it("joins cluster info, connection and cache numbers by server", () => {
    expect(pointOf(scrape).clusters).toEqual([{ server: "https://prd", name: "prd", version: "v1.36", connected: false, objects: 700, resources: null, cacheAgeSeconds: null, eventsPerMin: null }]);
  });

  it("has no rates on the first read", () => {
    const first = pointOf({ ...scrape, series: scrape.series.map((s) => ({ ...s, delta: null })), components: scrape.components.map((c) => ({ ...c, intervalMs: null })) });
    expect(first.syncByPhase.every((s) => s.perMin === null)).toBe(true);
    expect(first.appsetErrors).toEqual({ total: 3, perMin: null });
  });
});

describe("appendPoint", () => {
  it("keeps only the most recent points", () => {
    const point = (at: number): ControllerPoint => ({ at, reconcile: null, syncByPhase: [], gitLatency: null, gitRequests: [], repoPending: null, clusters: [], queues: [], execPending: null, appsetErrors: null, components: [] });
    let history: ControllerPoint[] = [];
    for (let i = 0; i < HISTORY_POINTS + 5; i++) history = appendPoint(history, point(i));
    expect(history).toHaveLength(HISTORY_POINTS);
    expect(history[0].at).toBe(5);
    expect(history[history.length - 1].at).toBe(HISTORY_POINTS + 4);
  });
});
