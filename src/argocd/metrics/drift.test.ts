import { describe, expect, it } from "vitest";
import type { ArgoAppRow, ArgoEvent } from "../types";
import { outOfSyncRanking, outOfSyncTrend, policyGaps } from "./drift";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-05T12:00:00Z");
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

const row = (name: string, values: Record<string, string>): ArgoAppRow => ({ name, namespace: "argocd", resourceVersion: "1", values, labels: {} });
const sync = (app: string, from: string, to: string, hours: number): ArgoEvent => ({
  at: ago(hours), server: "s", namespace: "argocd", app, kind: "sync", from, to, revision: null, phase: null, startedAt: null, finishedAt: null, initiatedBy: null, message: null,
});

describe("outOfSyncRanking", () => {
  it("measures from the last sync change and puts apps without a recorded change at the coverage lower bound", () => {
    const rows = [row("fresh", { sync: "OutOfSync" }), row("old", { sync: "OutOfSync" }), row("mystery", { sync: "OutOfSync" }), row("fine", { sync: "Synced" })];
    const events = [
      sync("old", "Synced", "OutOfSync", 30),
      // fresh는 한 번 동기화됐다가 다시 어긋났다: 마지막 전환부터 잰다
      sync("fresh", "Synced", "OutOfSync", 50), sync("fresh", "OutOfSync", "Synced", 40), sync("fresh", "Synced", "OutOfSync", 2),
    ];
    const ranking = outOfSyncRanking(rows, events, NOW, NOW - 100 * HOUR);
    expect(ranking.map((r) => r.row.name)).toEqual(["mystery", "old", "fresh"]);
    expect(ranking[0]).toMatchObject({ since: null, atLeast: true, durationMs: 100 * HOUR });
    expect(ranking[1]).toMatchObject({ durationMs: 30 * HOUR, atLeast: false });
    expect(ranking[2].durationMs).toBe(2 * HOUR);
  });

  it("does not trust a stale OutOfSync event when the latest recorded change left OutOfSync", () => {
    const ranking = outOfSyncRanking([row("a", { sync: "OutOfSync" })], [sync("a", "Synced", "OutOfSync", 9), sync("a", "OutOfSync", "Synced", 5)], NOW, null);
    expect(ranking[0]).toMatchObject({ since: null, atLeast: true, durationMs: 0 });
  });
});

describe("outOfSyncTrend", () => {
  it("rewinds sync transitions from the current count and leaves times before recording unknown", () => {
    const events = [sync("a", "Synced", "OutOfSync", 30), sync("b", "Synced", "OutOfSync", 10), sync("a", "OutOfSync", "Synced", 6), sync("c", "Synced", "Unknown", 5)];
    // 지금 b만 OutOfSync(1개). 48시간을 4칸(12시간)으로
    const trend = outOfSyncTrend(events, 1, NOW, 2, 4, NOW - 36 * HOUR);
    expect(trend.map((p) => p.count)).toEqual([null, 0, 1, 1, 1]);
    expect(trend[trend.length - 1]).toEqual({ at: NOW, count: 1 });
  });

  it("is unknown everywhere when nothing has been recorded", () => {
    expect(outOfSyncTrend([], 3, NOW, 1, 2, null).every((p) => p.count === null)).toBe(true);
  });
});

describe("policyGaps", () => {
  it("lists manual apps and automated apps missing selfHeal or prune, skipping rows that do not say", () => {
    const rows = [
      row("manual", { autoSync: "false" }),
      row("auto-all", { autoSync: "true", selfHeal: "true", autoPrune: "true" }),
      row("auto-no-heal", { autoSync: "true", selfHeal: "false", autoPrune: "true" }),
      row("auto-no-prune", { autoSync: "true", selfHeal: "true", autoPrune: "false" }),
      row("manual-no-heal", { autoSync: "false", selfHeal: "false", autoPrune: "false" }),
      row("old-row", { autoSync: "true" }),
    ];
    const gaps = policyGaps(rows);
    expect(gaps.autoSyncOff.map((r) => r.name)).toEqual(["manual", "manual-no-heal"]);
    expect(gaps.selfHealOff.map((r) => r.name)).toEqual(["auto-no-heal"]);
    expect(gaps.pruneOff.map((r) => r.name)).toEqual(["auto-no-prune"]);
  });
});
