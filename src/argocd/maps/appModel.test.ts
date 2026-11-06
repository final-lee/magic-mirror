import { expect, it } from "vitest";
import type { ArgoAppRow, ArgoEvent, ArgoTreeNode } from "../types";
import { appHierarchy, appSetSiblings, appTimeline, appVersion, resourceGraph } from "./appModel";

const row = (name: string, values: Record<string, string> = {}): ArgoAppRow => ({ name, namespace: "argocd", resourceVersion: "1", labels: {}, values: { sync: "Synced", health: "Healthy", ...values } });
const ref = (name: string) => ({ group: "argoproj.io", version: "v1alpha1", kind: "Application", name });
const node = (uid: string, parents: string[]): ArgoTreeNode => ({ uid, name: uid, group: "apps", version: "v1", kind: "Deployment", namespace: "web", parents, health: "Healthy", healthMessage: null, images: [], info: [], createdAt: null });

it("keeps ancestor paths and descendants, excludes unrelated siblings, and rolls up state", () => {
  const parent = row("parent"); const selected = row("selected"); const child = row("child", { operation: "Failed" }); const sibling = row("sibling");
  parent.resources = [ref("selected"), ref("sibling")]; selected.resources = [ref("child")];
  const roots = appHierarchy([parent, selected, child, sibling], selected);
  expect(roots[0].row.name).toBe("parent"); expect(roots[0].level).toBe("err");
  expect(roots[0].children.map(b => b.row.name)).toEqual(["selected"]);
  expect(roots[0].children[0].children[0].row.name).toBe("child");
});
it("limits siblings and version groups to the selected app's owner and environment group", () => {
  const a = row("web-dev", { appSet: "fleet", revision: "a" }); const b = row("web-prd", { appSet: "fleet", revision: "b" }); const c = row("other-prd", { appSet: "other", revision: "c" });
  expect(appSetSiblings([a, b, c], a, "fleet").map(r => r.name)).toEqual(["web-dev", "web-prd"]);
  expect(appSetSiblings([a, b, c], a, null)).toEqual([]);
  const group = appVersion([a, b, c], a, new Map(), new Map());
  expect(group?.cells.prd?.[0].row.name).toBe("web-prd"); expect(group?.cells.prd?.[0].drift).toBe(true);
});
it("filters operation and server history to a single app and range", () => {
  const now = Date.parse("2026-11-05T12:00:00Z"); const at = "2026-11-05T11:00:00Z";
  const event = (app: string): ArgoEvent => ({ at, server: "s", namespace: "argocd", app, kind: "operation", from: null, to: null, revision: "x", phase: "Failed", startedAt: at, finishedAt: at, initiatedBy: null, message: null });
  const history = [{ id: 1, revisions: ["r"], deployedAt: "2026-11-05T10:00:00Z", deployStartedAt: null, initiatedBy: null }];
  const items = appTimeline([event("a"), event("b")], { name: "a", namespace: "argocd" }, history, now, 1);
  expect(items).toHaveLength(2); expect(items.every(i => i.app === "a")).toBe(true); expect(items.some(i => i.failed)).toBe(true);
});
it("layers managed resources under the application and follows parentRefs", () => {
  const graph = resourceGraph([node("deployment", []), node("replica", ["deployment"]), node("pod", ["replica"])], [{ group: "apps", version: "v1", kind: "Deployment", namespace: "web", name: "deployment", status: "OutOfSync", hook: true, requiresPruning: true }]);
  expect(graph.vertices.map(v => [v.row.name, v.layer])).toEqual([["deployment", 1], ["replica", 2], ["pod", 3]]);
  expect(graph.edges).toEqual([{ from: "app", to: "deployment" }, { from: "deployment", to: "replica" }, { from: "replica", to: "pod" }]);
  expect(graph.vertices[0].row).toMatchObject({ sync: "OutOfSync", hook: true, requiresPruning: true });
});
