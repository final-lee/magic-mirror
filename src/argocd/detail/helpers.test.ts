import type { AppDiffRow, ArgoHistoryEntry, ArgoResourceResult, ArgoWave } from "../types";
import { argoWebUrl, commitUrl, filterDiffRows, localOperations, logsKind, operationElapsedMs, operationRows, revisionPair } from "./helpers";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("commitUrl", () => {
  test.each([
    ["https://github.com/acme/web.git", `https://github.com/acme/web/commit/${SHA}`],
    ["git@github.com:acme/web.git", `https://github.com/acme/web/commit/${SHA}`],
    ["ssh://git@github.com:22/acme/web", `https://github.com/acme/web/commit/${SHA}`],
    ["https://user:token@github.company.com/acme/web.git/", `https://github.company.com/acme/web/commit/${SHA}`],
    ["https://gitlab.com/group/sub/web.git", `https://gitlab.com/group/sub/web/-/commit/${SHA}`],
    ["git@gitlab.company.com:group/web.git", `https://gitlab.company.com/group/web/-/commit/${SHA}`],
    ["https://bitbucket.org/acme/web.git", `https://bitbucket.org/acme/web/commits/${SHA}`],
  ])("%s links to the commit", (repo, expected) => {
    expect(commitUrl(repo, SHA)).toBe(expected);
  });

  test("short hashes link, anything that is not a commit hash or a known host does not", () => {
    expect(commitUrl("https://github.com/acme/web.git", "0123456")).toBe("https://github.com/acme/web/commit/0123456");
    expect(commitUrl("https://github.com/acme/web.git", "1.2.3")).toBeNull();
    expect(commitUrl("https://github.com/acme/web.git", "main")).toBeNull();
    expect(commitUrl("https://git.example.com/acme/web.git", SHA)).toBeNull();
    expect(commitUrl("oci://registry.example.com/charts/web", SHA)).toBeNull();
    expect(commitUrl("not a url", SHA)).toBeNull();
    expect(commitUrl(null, SHA)).toBeNull();
  });
});

test("the ArgoCD web UI address is the server address plus the application path", () => {
  expect(argoWebUrl("https://argocd.example/", "argocd", "web")).toBe("https://argocd.example/applications/argocd/web");
  expect(argoWebUrl("https://argocd.example", "team a", "web")).toBe("https://argocd.example/applications/team%20a/web");
});

test("logs exist for pods and for workloads that own pods only", () => {
  expect(logsKind({ group: "", kind: "Pod" })).toBe("pod");
  expect(logsKind({ group: "apps", kind: "Deployment" })).toBe("workload");
  expect(logsKind({ group: "apps", kind: "StatefulSet" })).toBe("workload");
  expect(logsKind({ group: "batch", kind: "Job" })).toBe("workload");
  expect(logsKind({ group: "argoproj.io", kind: "Rollout" })).toBe("workload");
  expect(logsKind({ group: "", kind: "Service" })).toBeNull();
  expect(logsKind({ group: "", kind: "ConfigMap" })).toBeNull();
  // 같은 이름이라도 group이 다르면 아니다
  expect(logsKind({ group: "example.io", kind: "Pod" })).toBeNull();
});

describe("diff filters", () => {
  const row = (name: string, changed: boolean, syncStatus: string | null): AppDiffRow => ({
    res: { group: "apps", version: "v1", kind: "Deployment", namespace: "web", name }, syncStatus, health: null, hook: false, live: "", target: "", changed,
    diff: { rows: [], hunks: [], stats: { added: 0, removed: 0, changed: 0 } },
  });
  const rows = [row("a", true, "OutOfSync"), row("b", false, "OutOfSync"), row("c", true, "Synced"), row("d", false, "Synced"), row("e", true, null)];
  const names = (f: { changedOnly: boolean; outOfSyncOnly: boolean }) => filterDiffRows(rows, f).map((r) => r.res.name);

  test("changed only keeps the rows whose lines differ, OutOfSync only keeps what the app reports OutOfSync, both together intersect", () => {
    expect(names({ changedOnly: false, outOfSyncOnly: false })).toEqual(["a", "b", "c", "d", "e"]);
    expect(names({ changedOnly: true, outOfSyncOnly: false })).toEqual(["a", "c", "e"]);
    expect(names({ changedOnly: false, outOfSyncOnly: true })).toEqual(["a", "b"]);
    expect(names({ changedOnly: true, outOfSyncOnly: true })).toEqual(["a"]);
  });
});

describe("operation rows", () => {
  const result = (name: string, over: Partial<ArgoResourceResult> = {}): ArgoResourceResult => ({
    group: "apps", version: "v1", kind: "Deployment", namespace: "web", name, status: "Synced", message: null, hookPhase: null, hookType: null, syncPhase: "Sync", ...over,
  });
  const wave = (name: string, n: number, hook: string | null = null, kind = "Deployment"): ArgoWave => ({ group: "apps", kind, namespace: "web", name, wave: n, hook });

  test("run in phase order, then sync wave, then kind and name; waves come from the rendered manifests", () => {
    const results = [
      result("post", { syncPhase: "PostSync", kind: "Job", group: "batch" }),
      result("late", { syncPhase: "Sync" }),
      result("early", { syncPhase: "Sync" }),
      result("migrate", { syncPhase: "PreSync", kind: "Job", group: "batch", hookType: "PreSync", hookPhase: "Succeeded" }),
      result("fail", { syncPhase: "SyncFail", kind: "Job", group: "batch" }),
    ];
    const waves = [wave("late", 2), wave("early", -1), { ...wave("migrate", 0, "PreSync", "Job"), group: "batch" }];
    const rows = operationRows(results, waves);
    expect(rows.map((r) => r.result.name)).toEqual(["migrate", "early", "late", "post", "fail"]);
    expect(rows.map((r) => r.wave)).toEqual([0, -1, 2, null, null]);
    expect(rows[0].hook).toBe("PreSync");
  });

  test("without wave data the wave is unknown and the hook kind still comes from the result", () => {
    const rows = operationRows([result("a", { hookType: "Sync" })], undefined);
    expect(rows[0]).toMatchObject({ wave: null, hook: "Sync" });
  });
});

describe("operation elapsed time", () => {
  const NOW = Date.parse("2026-10-30T12:00:00Z");
  test("a finished operation measures start to finish and a running one start to now", () => {
    expect(operationElapsedMs({ startedAt: "2026-10-30T11:30:00Z", finishedAt: "2026-10-30T11:31:05Z" }, NOW)).toBe(65_000);
    expect(operationElapsedMs({ startedAt: "2026-10-30T11:59:00Z", finishedAt: null }, NOW)).toBe(60_000);
  });
  test("no start time means unknown, and a clock behind the start never goes negative", () => {
    expect(operationElapsedMs({ startedAt: null, finishedAt: null }, NOW)).toBeNull();
    expect(operationElapsedMs({ startedAt: "2026-10-30T12:00:05Z", finishedAt: null }, NOW)).toBe(0);
  });
});

test("local operation records are this app's finished operations, newest first", () => {
  const event = (at: string, over: Partial<{ kind: "sync" | "health" | "operation"; namespace: string; app: string }> = {}) => ({
    at, server: "s", namespace: "argocd", app: "web", kind: "operation" as const, from: null, to: null, revision: null, phase: "Succeeded", startedAt: null, finishedAt: null, initiatedBy: null, message: null, ...over,
  });
  const out = localOperations([event("2026-10-30T10:00:00Z"), event("2026-10-30T11:00:00Z"), event("2026-10-30T12:00:00Z", { kind: "sync" }), event("2026-10-30T09:00:00Z", { app: "other" }), event("2026-10-30T08:00:00Z", { namespace: "x" })], "argocd", "web");
  expect(out.map((e) => e.at)).toEqual(["2026-10-30T11:00:00Z", "2026-10-30T10:00:00Z"]);
});

describe("revision pairs", () => {
  const entry = (id: number): ArgoHistoryEntry => ({ id, deployedAt: null, deployStartedAt: null, initiatedBy: null, revisions: [] });
  const entries = [entry(9), entry(7), entry(5)];
  test("two picks compare oldest to newest whichever was picked first", () => {
    expect(revisionPair(entries, [9, 5])).toMatchObject({ from: { id: 5 }, to: { id: 9 } });
    expect(revisionPair(entries, [5, 9])).toMatchObject({ from: { id: 5 }, to: { id: 9 } });
  });
  test("fewer or more than two, or a pick that left the history, is no pair", () => {
    expect(revisionPair(entries, [9])).toBeNull();
    expect(revisionPair(entries, [9, 7, 5])).toBeNull();
    expect(revisionPair(entries, [9, 1])).toBeNull();
  });
});
