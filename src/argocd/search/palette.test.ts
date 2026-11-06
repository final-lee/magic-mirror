import { newQueryClient } from "../../test/utils";
import { argoKeys } from "../queries";
import type { ArgoAppRow, ArgoTreeNode } from "../types";
import { argoPaletteItems } from "./palette";

const A = { name: "prod", url: "https://argocd.a" };
const B = { name: "staging", url: "https://argocd.b" };
const row = (name: string): ArgoAppRow => ({
  name,
  namespace: "argocd",
  resourceVersion: "1",
  values: { destination: "https://kubernetes.default.svc", destNamespace: "shop", project: "default" },
  labels: {},
  resources: [{ group: "apps", version: "v1", kind: "Deployment", namespace: "shop", name: "api" }],
});
const pod: ArgoTreeNode = { uid: "p", group: "", version: "v1", kind: "Pod", namespace: "shop", name: "api-1", parents: [], health: null, healthMessage: null, info: [], images: [], createdAt: null };

test("builds items only for servers whose app list is cached: apps, resources and trees already opened", () => {
  const qc = newQueryClient();
  qc.setQueryData(argoKeys.apps(A.url), [row("web")]);
  qc.setQueryData(argoKeys.tree(A.url, "argocd", "web", "1"), [pod]);
  const items = argoPaletteItems(qc, [A, B]);
  expect(items.map((i) => [i.kind, i.name, i.app])).toEqual([
    [null, "web", null],
    ["Deployment", "api", "web"],
    ["Pod", "api-1", "web"],
  ]);
  expect(items.every((i) => i.jump.url === A.url)).toBe(true);
  expect(items[0].jump).toEqual({ url: A.url, namespace: "argocd", name: "web", resource: null });
  expect(items[2].jump.resource).toEqual({ group: "", kind: "Pod", namespace: "shop", name: "api-1" });
});

test("a resource several apps manage gets one item per app so either can be opened", () => {
  const qc = newQueryClient();
  qc.setQueryData(argoKeys.apps(B.url), [row("web"), row("web-copy")]);
  const items = argoPaletteItems(qc, [B]).filter((i) => i.kind === "Deployment");
  expect(items.map((i) => i.jump.name)).toEqual(["web", "web-copy"]);
  expect(new Set(items.map((i) => i.key)).size).toBe(2);
});
