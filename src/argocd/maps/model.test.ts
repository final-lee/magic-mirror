import { describe, expect, it } from "vitest";
import type { ArgoAppRow, ArgoEvent } from "../types";
import { appForest, matrix, normalizeAppName, timeline, versions } from "./model";

const app = (name: string, values: Record<string, string> = {}): ArgoAppRow => ({ name, namespace: "argocd", resourceVersion: "1", labels: {}, values: { sync: "Synced", health: "Healthy", ...values } });

describe("fleet maps", () => {
  it("removes whole environment tokens, not substrings, and groups versions", () => {
    expect(normalizeAppName("production-frontend-dev2")).toBe("frontend");
    expect(normalizeAppName("prodify-preview-api")).toBe("prodify-api");
    const rows = [app("api-dev", { revision: "a" }), app("api-stg", { revision: "b" }), app("api-prd", { revision: "a" })];
    const [group] = versions(rows, new Map(), new Map());
    expect(group.cells.dev?.[0].drift).toBe(false);
    expect(group.cells.stg?.[0].drift).toBe(true);
    expect(group.cells.prd?.[0].drift).toBe(true);
    expect(group.drift).toBe(true);
  });
  it("uses ApplicationSet identity and avoids claiming drift from missing data", () => {
    const rows = [app("blue-dev", { appSet: "fleet", revision: "abc" }), app("green-prd", { appSet: "fleet", revision: "abc" })];
    expect(versions(rows, new Map(), new Map())[0].drift).toBe(false);
  });
  it("aggregates cells using list severity and exclusive tallies", () => {
    const rows = [app("a-dev", { destination: "c" }), app("b-dev", { destination: "c", sync: "OutOfSync" }), app("c-dev", { destination: "c", operation: "Failed" })];
    const cell = matrix(rows, "cluster").cells.get(JSON.stringify(["dev", "c"]));
    expect(cell?.level).toBe("err");
    expect(cell?.tally).toEqual({ err: 1, outOfSync: 1, caution: 0, ok: 1 });
  });
  it("rolls child state up and terminates a cyclic app hierarchy", () => {
    const a = app("a"); const b = app("b", { operation: "Failed" });
    a.resources = [{ group: "argoproj.io", version: "v1alpha1", kind: "Application", name: "b" }];
    b.resources = [{ group: "argoproj.io", version: "v1alpha1", kind: "Application", name: "a" }];
    const [root] = appForest([a, b]);
    expect(root.level).toBe("err");
    expect(root.children[0].children[0].cycle).toBe(true);
  });
  it("filters the time range and combines operation events with server history", () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    const event = (at: string, phase: string): ArgoEvent => ({ at, server: "s", namespace: "argocd", app: "api", kind: "operation", from: null, to: null, revision: "abc", phase, startedAt: at, finishedAt: at, initiatedBy: "lee", message: null });
    const events = [event("2026-11-05T10:00:00Z", "Failed"), event("2026-10-01T10:00:00Z", "Succeeded")];
    const history = new Map([["argocd/api", [{ id: 1, revisions: ["xyz"], deployedAt: "2026-11-05T11:00:00Z", deployStartedAt: "2026-11-05T10:59:00Z", initiatedBy: "kim" }]]]);
    const result = timeline(events, history, now, 1);
    expect(result).toHaveLength(2); expect(result[0].failed).toBe(true); expect(result[1].revision).toBe("xyz");
  });
});
