import { describe, expect, it } from "vitest";
import type { ArgoAppRow, ArgoEvent, ArgocdNotify } from "../types";
import { NotifyState, envAllowed } from "./rules";

const MIN = 60_000;
const T0 = Date.parse("2026-11-05T12:00:00Z");
const on: ArgocdNotify = { enabled: true, envs: [], outOfSyncMinutes: 30 };
const prd = () => "prd";

const event = (over: Partial<ArgoEvent>): ArgoEvent => ({
  at: new Date(T0).toISOString(), server: "s", namespace: "argocd", app: "web", kind: "health", from: "Healthy", to: "Degraded", revision: null, phase: null,
  startedAt: null, finishedAt: null, initiatedBy: null, message: null, ...over,
});
const row = (name: string, sync: string): ArgoAppRow => ({ name, namespace: "argocd", resourceVersion: "1", values: { sync }, labels: {} });

describe("health and operation events", () => {
  it("notifies when health becomes Degraded and when an operation ends Failed or Error", () => {
    const state = new NotifyState();
    expect(state.event(event({}), on, prd)).toEqual({ kind: "degraded", namespace: "argocd", app: "web" });
    expect(state.event(event({ kind: "operation", from: null, to: null, phase: "Failed", message: "boom", at: "2026-11-05T12:01:00Z" }), on, prd)).toEqual({ kind: "operation", namespace: "argocd", app: "web", phase: "Failed", message: "boom" });
    expect(state.event(event({ kind: "operation", from: null, to: null, phase: "Error", at: "2026-11-05T12:02:00Z" }), on, prd)).toMatchObject({ kind: "operation", phase: "Error" });
  });

  it("stays quiet for recoveries, successful operations and other health changes", () => {
    const state = new NotifyState();
    expect(state.event(event({ from: "Degraded", to: "Healthy" }), on, prd)).toBeNull();
    expect(state.event(event({ to: "Progressing", at: "2026-11-05T12:01:00Z" }), on, prd)).toBeNull();
    expect(state.event(event({ kind: "operation", from: null, to: null, phase: "Succeeded", at: "2026-11-05T12:02:00Z" }), on, prd)).toBeNull();
  });

  it("notifies once even if the same recorded event is delivered again", () => {
    const state = new NotifyState();
    expect(state.event(event({}), on, prd)).not.toBeNull();
    expect(state.event(event({}), on, prd)).toBeNull();
  });

  it("does nothing when disabled, and applies the environment filter (empty = every environment)", () => {
    const state = new NotifyState();
    expect(state.event(event({}), { ...on, enabled: false }, prd)).toBeNull();
    const onlyPrd: ArgocdNotify = { ...on, envs: ["prd"] };
    expect(state.event(event({ app: "dev-web", at: "2026-11-05T12:01:00Z" }), onlyPrd, (_, name) => (name.startsWith("dev") ? "dev" : "prd"))).toBeNull();
    expect(state.event(event({ app: "web", at: "2026-11-05T12:02:00Z" }), onlyPrd, (_, name) => (name.startsWith("dev") ? "dev" : "prd"))).not.toBeNull();
    expect(envAllowed({ ...on, envs: [] }, "anything")).toBe(true);
    expect(envAllowed(onlyPrd, "stg")).toBe(false);
  });
});

describe("OutOfSync that lasts", () => {
  it("fires once the configured minutes pass, and only once per episode", () => {
    const state = new NotifyState();
    state.row(row("web", "OutOfSync"), T0);
    expect(state.due(on, T0 + 29 * MIN, prd)).toEqual([]);
    expect(state.due(on, T0 + 31 * MIN, prd)).toEqual([{ kind: "outOfSync", namespace: "argocd", app: "web", minutes: 31 }]);
    expect(state.due(on, T0 + 60 * MIN, prd)).toEqual([]);
    // 행이 계속 갱신돼도 같은 에피소드다
    state.row(row("web", "OutOfSync"), T0 + 61 * MIN);
    expect(state.due(on, T0 + 90 * MIN, prd)).toEqual([]);
  });

  it("starts a new episode after the app syncs and drifts again", () => {
    const state = new NotifyState();
    state.row(row("web", "OutOfSync"), T0);
    expect(state.due(on, T0 + 40 * MIN, prd)).toHaveLength(1);
    state.row(row("web", "Synced"), T0 + 45 * MIN);
    state.row(row("web", "OutOfSync"), T0 + 50 * MIN);
    expect(state.due(on, T0 + 70 * MIN, prd)).toEqual([]);
    expect(state.due(on, T0 + 81 * MIN, prd)).toHaveLength(1);
  });

  it("forgets an app that synced before the time was up, or that was deleted", () => {
    const state = new NotifyState();
    state.row(row("quick", "OutOfSync"), T0);
    state.row(row("quick", "Synced"), T0 + 10 * MIN);
    state.row(row("gone", "OutOfSync"), T0);
    state.remove("argocd", "gone");
    expect(state.due(on, T0 + 120 * MIN, prd)).toEqual([]);
  });

  it("takes the start from the recorded sync event, and ends the episode on a transition away from OutOfSync", () => {
    const state = new NotifyState();
    state.event(event({ kind: "sync", from: "Synced", to: "OutOfSync", at: new Date(T0 - 20 * MIN).toISOString() }), on, prd);
    expect(state.due(on, T0 + 11 * MIN, prd)).toEqual([{ kind: "outOfSync", namespace: "argocd", app: "web", minutes: 31 }]);
    state.event(event({ kind: "sync", from: "OutOfSync", to: "Synced", at: new Date(T0 + 12 * MIN).toISOString() }), on, prd);
    state.row(row("web", "Synced"), T0 + 12 * MIN);
    expect(state.due(on, T0 + 200 * MIN, prd)).toEqual([]);
  });

  it("respects the environment filter and the enabled switch, using the setting's minutes", () => {
    const state = new NotifyState();
    state.row(row("dev-web", "OutOfSync"), T0);
    state.row(row("web", "OutOfSync"), T0);
    const envOf = (_: string, name: string) => (name.startsWith("dev") ? "dev" : "prd");
    expect(state.due({ ...on, enabled: false }, T0 + 60 * MIN, envOf)).toEqual([]);
    const fired = state.due({ ...on, envs: ["prd"], outOfSyncMinutes: 10 }, T0 + 15 * MIN, envOf);
    expect(fired.map((n) => n.app)).toEqual(["web"]);
  });
});
