import { describe, expect, it } from "vitest";
import type { ArgoEvent } from "../types";
import { DAY_MS, computeStats, coverageStartOf, deploysOf, groupStats, incidentsOf, percentile } from "./dora";
import type { DeployRecord } from "./types";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const ago = (days: number, hours = 0) => new Date(NOW - days * DAY_MS - hours * 3_600_000).toISOString();

const event = (over: Partial<ArgoEvent>): ArgoEvent => ({
  at: ago(0), server: "s", namespace: "argocd", app: "web", kind: "operation", from: null, to: null, revision: null, phase: null,
  startedAt: null, finishedAt: null, initiatedBy: null, message: null, ...over,
});
const op = (app: string, phase: string, daysAgo: number, seconds = 30, revision: string | null = null) =>
  event({ app, phase, revision, finishedAt: ago(daysAgo), startedAt: new Date(NOW - daysAgo * DAY_MS - seconds * 1000).toISOString(), at: ago(daysAgo) });
const record = (app: string, daysAgo: number, seconds = 30, revision: string | null = null): DeployRecord => ({
  namespace: "argocd", app, id: 1, revision, deployedAt: ago(daysAgo), startedAt: new Date(NOW - daysAgo * DAY_MS - seconds * 1000).toISOString(),
});
const health = (app: string, to: string, daysAgo: number, hours = 0) => event({ kind: "health", app, to, at: ago(daysAgo, hours) });

describe("percentile", () => {
  it("interpolates between ranks and handles tiny inputs", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0.95)).toBeCloseTo(38.5);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("deploysOf", () => {
  it("counts a server-history deploy and its local operation event once", () => {
    const deploys = deploysOf([op("web", "Succeeded", 2, 30, "abc")], [record("web", 2, 30, "abc")]);
    expect(deploys).toHaveLength(1);
    expect(deploys[0]).toMatchObject({ app: "argocd/web", ok: true, durationMs: 30_000 });
  });

  it("fills a missing duration or revision from the other side and keeps different revisions apart", () => {
    const noStart = event({ app: "web", phase: "Succeeded", finishedAt: ago(1), at: ago(1) });
    const merged = deploysOf([noStart], [record("web", 1, 12, "abc")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ durationMs: 12_000, revision: "abc" });
    const apart = deploysOf([op("web", "Succeeded", 1, 5, "aaa")], [record("web", 1, 5, "bbb")]);
    expect(apart).toHaveLength(2);
  });

  it("ignores operations that have not finished and takes history-only deploys as successes", () => {
    const deploys = deploysOf([op("web", "Running", 1)], [record("api", 3)]);
    expect(deploys.map((d) => [d.app, d.ok])).toEqual([["argocd/api", true]]);
  });
});

describe("incidentsOf", () => {
  it("runs from Degraded to the next Healthy even through Progressing, and leaves an unresolved one open", () => {
    const incidents = incidentsOf([
      health("web", "Degraded", 3), health("web", "Progressing", 3, -1), health("web", "Healthy", 3, -2),
      health("api", "Degraded", 1),
      health("api", "Degraded", 0, 5),
    ]);
    expect(incidents).toHaveLength(2);
    const web = incidents.find((i) => i.app === "argocd/web");
    expect(web && web.end !== null ? web.end - web.start : null).toBe(2 * 3_600_000);
    expect(incidents.find((i) => i.app === "argocd/api")?.end).toBeNull();
  });

  it("ignores a Healthy that follows no Degraded", () => {
    expect(incidentsOf([health("web", "Healthy", 1)])).toEqual([]);
  });
});

describe("computeStats", () => {
  const events = [
    health("web", "Degraded", 2), health("web", "Healthy", 2, -1),
    op("web", "Succeeded", 5, 20), op("web", "Succeeded", 4, 40), op("web", "Failed", 3, 60), op("web", "Error", 2, 10), op("web", "Succeeded", 1, 100),
  ];
  const coverage = coverageStartOf([...events, health("web", "Healthy", 6)]);

  it("derives frequency, failure rate, restore time and sync duration for the window", () => {
    const stats = computeStats(deploysOf(events, []), incidentsOf(events), 7, NOW, coverage, null);
    expect(stats.deployments).toBe(3);
    expect(stats.failures).toBe(2);
    expect(stats.failureRate).toBeCloseTo(2 / 5);
    expect(stats.restoreMedianMs).toBe(3_600_000);
    expect(stats.restores).toBe(1);
    expect(stats.openIncidents).toBe(0);
    expect(stats.syncP50Ms).toBe(40_000);
    expect(stats.syncP95Ms).toBeCloseTo(92_000);
    // 관측 기간(6일)에 걸친 하루 평균
    expect(stats.perDay).toBeCloseTo(3 / 6);
  });

  it("only counts what ended inside the window", () => {
    const stats = computeStats(deploysOf(events, []), incidentsOf(events), 7, NOW, coverage, null);
    const narrow = computeStats(deploysOf(events, []), incidentsOf(events), 7, NOW - 4 * DAY_MS, coverage, null);
    expect(narrow.deployments).toBe(2);
    expect(stats.deployments).toBeGreaterThan(narrow.deployments);
  });

  it("does not report a failure rate without local recording, even when server history has deploys", () => {
    const stats = computeStats(deploysOf([], [record("web", 2), record("web", 3)]), [], 30, NOW, null, NOW - 3 * DAY_MS);
    expect(stats.deployments).toBe(2);
    expect(stats.failureRate).toBeNull();
    expect(stats.restoreMedianMs).toBeNull();
  });

  it("measures history deploys from before recording started against the later local failure rate only", () => {
    const old = record("web", 20);
    const recorded = [op("web", "Failed", 1), op("web", "Succeeded", 0, 5)];
    const stats = computeStats(deploysOf(recorded, [old]), [], 30, NOW, coverageStartOf(recorded), null);
    expect(stats.deployments).toBe(2);
    expect(stats.failureRate).toBeCloseTo(1 / 2);
  });
});

describe("groupStats", () => {
  it("groups by the resolver, shows apps without a known group under an empty key and sorts by deploys", () => {
    const events = [op("web", "Succeeded", 1), op("web", "Succeeded", 2), op("api", "Succeeded", 1), op("gone", "Failed", 1)];
    const envOf = (app: string) => (app.endsWith("/web") ? "prd" : app.endsWith("/api") ? "dev" : null);
    const rows = groupStats(deploysOf(events, []), [], "env", envOf, 30, NOW, coverageStartOf(events));
    expect(rows.map((r) => [r.key, r.stats.deployments])).toEqual([["prd", 2], ["dev", 1], ["", 0]]);
    const byApp = groupStats(deploysOf(events, []), [], "app", envOf, 30, NOW, coverageStartOf(events));
    expect(byApp[0].key).toBe("argocd/web");
  });
});
