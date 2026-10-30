import { BUILTIN, CATEGORIES, DEPLOYMENTS, NODES, SECRETS, customCategories, isSecret, resolveLink, sameKind } from "./kinds";
import { CAT_CLUSTER, CAT_WORKLOADS } from "./text";
import type { K8sKind } from "./types";

const kind = (group: string, k: string, plural: string, custom: boolean, version = "v1"): K8sKind => ({ group, version, kind: k, plural, namespaced: true, verbs: ["list", "watch"], custom });

test("categories hold the spec's built-in kinds", () => {
  expect(CATEGORIES[0].label).toBe(CAT_WORKLOADS);
  expect(CATEGORIES[0].kinds.map((k) => k.kind)).toEqual(["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"]);
  expect(CATEGORIES.find((c) => c.label === CAT_CLUSTER)!.kinds).toContainEqual(NODES);
  expect(BUILTIN).toContainEqual(SECRETS);
  expect(NODES.namespaced).toBe(false);
});

test("custom kinds are grouped by API group", () => {
  const cats = customCategories([kind("b.example.com", "Bee", "bees", true), kind("a.example.com", "Zed", "zeds", true), kind("a.example.com", "Ant", "ants", true), kind("apps", "Deployment", "deployments", false)]);
  expect(cats.map((c) => c.label)).toEqual(["a.example.com", "b.example.com"]);
  expect(cats[0].kinds.map((k) => k.kind)).toEqual(["Ant", "Zed"]);
  expect(cats[0].kinds[0]).toEqual({ group: "a.example.com", version: "v1", kind: "Ant", plural: "ants", namespaced: true });
});

test("links resolve to built-in kinds first, then discovered ones, else null", () => {
  expect(resolveLink({ group: "apps", kind: "Deployment" }, [])).toEqual(DEPLOYMENTS);
  const widget = kind("mm.example.com", "Widget", "widgets", true, "v2");
  expect(resolveLink({ group: "mm.example.com", kind: "Widget" }, [widget])).toEqual({ group: "mm.example.com", version: "v2", kind: "Widget", plural: "widgets", namespaced: true });
  expect(resolveLink({ group: "x.io", kind: "Thing" }, [widget])).toBeNull();
});

test("sameKind and isSecret", () => {
  expect(sameKind(DEPLOYMENTS, { ...DEPLOYMENTS })).toBe(true);
  expect(sameKind(DEPLOYMENTS, SECRETS)).toBe(false);
  expect(isSecret(SECRETS)).toBe(true);
  expect(isSecret(DEPLOYMENTS)).toBe(false);
});
