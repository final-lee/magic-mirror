import { forwardUrl, needsTypedName, parsePort, streamPermission } from "./streams";
import { SHELL_PERMISSION_CHECKING, noStreamPermission } from "./text";
import type { K8sRules } from "./types";

const rules = (resourceRules: K8sRules["resourceRules"], incomplete = false): K8sRules => ({ namespace: "dev", resourceRules, nonResourceRules: [], incomplete });
const grant = (resources: string[], resourceNames: string[] = []) => ({ verbs: ["create"], apiGroups: [""], resources, resourceNames });

test("kube-system and namespaces with prod in the name need the pod name typed", () => {
  expect(needsTypedName("kube-system")).toBe(true);
  expect(needsTypedName("shop-prod")).toBe(true);
  expect(needsTypedName("Prod-api")).toBe(true);
  expect(needsTypedName("dev")).toBe(false);
  expect(needsTypedName("kube-public")).toBe(false);
});

test("each stream needs its own pods subresource; wildcards and incomplete rules do not block", () => {
  const r = rules([grant(["pods/exec"])]);
  expect(streamPermission(r, "exec").allowed).toBe(true);
  expect(streamPermission(r, "attach")).toEqual({ allowed: false, reason: noStreamPermission("pods/attach") });
  expect(streamPermission(r, "portforward")).toEqual({ allowed: false, reason: noStreamPermission("pods/portforward") });
  expect(streamPermission(rules([grant(["pods/*"])]), "portforward").allowed).toBe(true);
  // 목록이 불완전해서 모르는 경우는 서버가 가리도록 둔다
  expect(streamPermission(rules([], true), "exec").allowed).toBe(true);
});

test("a rule limited to other pod names does not open this pod", () => {
  const r = rules([grant(["pods/exec"], ["web-1"])]);
  expect(streamPermission(r, "exec", "web-1").allowed).toBe(true);
  expect(streamPermission(r, "exec", "web-2").allowed).toBe(false);
});

test("rules not read yet: not allowed, with the reason", () => {
  expect(streamPermission(undefined, "exec")).toEqual({ allowed: false, reason: SHELL_PERMISSION_CHECKING });
});

test("ports parse to 1..65535 only", () => {
  expect(parsePort("8080")).toBe(8080);
  expect(parsePort(" 80 ")).toBe(80);
  for (const bad of ["", "0", "65536", "-1", "80a", "8.0"]) expect(parsePort(bad)).toBeNull();
  expect(forwardUrl({ localPort: 8080 })).toBe("http://127.0.0.1:8080");
});
