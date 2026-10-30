import { can } from "./can";
import type { K8sRules } from "./types";

const rules = (resourceRules: K8sRules["resourceRules"], incomplete = false): K8sRules => ({ namespace: "ops", resourceRules, nonResourceRules: [], incomplete });

test("exact, wildcard, subresource, and resourceNames", () => {
  const r = rules([
    { verbs: ["get", "list"], apiGroups: [""], resources: ["pods", "pods/log"], resourceNames: [] },
    { verbs: ["*"], apiGroups: ["apps"], resources: ["deployments"], resourceNames: ["web"] },
    { verbs: ["patch"], apiGroups: ["*"], resources: ["*"], resourceNames: [] },
  ]);
  expect(can(r, { verb: "list", group: "", resource: "pods" })).toBe("yes");
  expect(can(r, { verb: "get", group: "", resource: "pods", subresource: "log" })).toBe("yes");
  expect(can(r, { verb: "get", group: "", resource: "pods", subresource: "exec" })).toBe("no");
  expect(can(r, { verb: "delete", group: "apps", resource: "deployments", name: "web" })).toBe("yes");
  expect(can(r, { verb: "delete", group: "apps", resource: "deployments", name: "api" })).toBe("no");
  expect(can(r, { verb: "delete", group: "apps", resource: "deployments" })).toBe("no"); // resourceNames never match a collection
  expect(can(r, { verb: "patch", group: "batch", resource: "jobs" })).toBe("yes");
  expect(can(r, { verb: "create", group: "", resource: "pods", subresource: "exec" })).toBe("no");
});

test("resources '*' matches subresources too, 'pods/*' matches any pod subresource", () => {
  const r = rules([{ verbs: ["create"], apiGroups: [""], resources: ["pods/*"], resourceNames: [] }]);
  expect(can(r, { verb: "create", group: "", resource: "pods", subresource: "exec" })).toBe("yes");
  expect(can(r, { verb: "create", group: "", resource: "pods" })).toBe("no");
  const all = rules([{ verbs: ["create"], apiGroups: [""], resources: ["*"], resourceNames: [] }]);
  expect(can(all, { verb: "create", group: "", resource: "pods", subresource: "exec" })).toBe("yes");
});

test("incomplete lists turn a no into unknown", () => {
  expect(can(rules([], true), { verb: "get", group: "", resource: "pods" })).toBe("unknown");
});

test("a match on an incomplete list is still yes", () => {
  const r = rules([{ verbs: ["get"], apiGroups: [""], resources: ["pods"], resourceNames: [] }], true);
  expect(can(r, { verb: "get", group: "", resource: "pods" })).toBe("yes");
});
