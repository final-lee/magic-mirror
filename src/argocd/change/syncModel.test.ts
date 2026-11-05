import type { ArgoResource } from "../types";
import { buildSync, initialDraft, outOfSyncKeys, parseRetry, resourceKey } from "./syncModel";

const res = (kind: string, name: string, over: Partial<ArgoResource> = {}): ArgoResource => ({ group: kind === "Deployment" ? "apps" : "", version: "v1", kind, namespace: "web", name, status: "Synced", hook: false, requiresPruning: false, ...over });
const resources = [res("Deployment", "web", { status: "OutOfSync" }), res("Service", "web-svc"), res("Job", "migrate", { hook: true, status: "OutOfSync" })];

describe("sync draft → change", () => {
  test("no selection syncs the whole app; a selection sends only those resources", () => {
    expect(buildSync(initialDraft, resources).change?.resources).toBeNull();
    const picked = buildSync({ ...initialDraft, selected: [resourceKey(resources[1])] }, resources).change;
    expect(picked?.resources).toEqual([{ group: "", version: "v1", kind: "Service", namespace: "web", name: "web-svc", uid: null }]);
  });

  test("OutOfSync quick select skips hooks and synced resources", () => {
    expect(outOfSyncKeys(resources)).toEqual(["apps/Deployment/web/web"]);
  });

  test("options and the revision are carried over; an empty revision is null", () => {
    const change = buildSync({ ...initialDraft, revision: " abc ", options: { ...initialDraft.options, prune: true, serverSideApply: true } }, resources).change;
    expect(change).toMatchObject({ kind: "sync", revision: "abc", prune: true, serverSideApply: true, dryRun: false, retry: null });
    expect(buildSync(initialDraft, resources).change?.revision).toBeNull();
  });
});

describe("retry", () => {
  test("limit alone, or with backoff duration, factor and max duration", () => {
    expect(parseRetry({ limit: "3", duration: "", factor: "", maxDuration: "" }).retry).toEqual({ limit: 3 });
    expect(parseRetry({ limit: "5", duration: "10s", factor: "2", maxDuration: "3m" }).retry).toEqual({ limit: 5, backoff: { duration: "10s", factor: 2, maxDuration: "3m" } });
    expect(parseRetry({ limit: "", duration: "10s", factor: "", maxDuration: "" }).retry).toBeNull();
  });

  test.each([
    [{ limit: "-1", duration: "", factor: "", maxDuration: "" }],
    [{ limit: "2", duration: "", factor: "0", maxDuration: "" }],
    [{ limit: "2", duration: "soon", factor: "", maxDuration: "" }],
  ])("%j is refused with a reason and no change", (retry) => {
    expect(parseRetry(retry).problem).not.toBeNull();
    expect(buildSync({ ...initialDraft, retry }, resources).change).toBeNull();
  });
});
