import { CONFIGMAPS, DEPLOYMENTS, NODES, PODS } from "../kinds";
import { NAMESPACES } from "../targets";
import type { K8sKindRef, K8sLink, K8sObjectView } from "../types";
import { hasRelations } from "./logic";

const link = (): K8sLink => ({ group: "apps", version: "v1", kind: "ReplicaSet", name: "rs", namespace: "prod", uid: "u", controller: true, problems: [] });
const view = (over: Partial<K8sObjectView> = {}) => ({ owners: [], children: [], ...over }) as unknown as K8sObjectView;
const widget: K8sKindRef = { group: "mm.example.com", version: "v1", kind: "Widget", plural: "widgets", namespaced: true };

test("kinds the backend computes relations for have the tab before the object is read", () => {
  for (const kind of [PODS, DEPLOYMENTS, NODES, CONFIGMAPS]) {
    expect(hasRelations(kind, undefined)).toBe(true);
  }
});

test("other kinds have it only once the object shows owners or children", () => {
  expect(hasRelations(NAMESPACES, view())).toBe(false);
  expect(hasRelations(widget, undefined)).toBe(false);
  expect(hasRelations(widget, view())).toBe(false);
  expect(hasRelations(widget, view({ owners: [link()] }))).toBe(true);
  expect(hasRelations(widget, view({ children: [link()] }))).toBe(true);
});

test("a custom kind with the same name as a built-in one in another group is not mistaken for it", () => {
  expect(hasRelations({ ...DEPLOYMENTS, group: "mm.example.com" }, view())).toBe(false);
});
