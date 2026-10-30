import { matchesFilter, parseFilter, parseSelector } from "./selector";
import type { K8sRow } from "./types";

const row = (name: string, labels: Record<string, string>): K8sRow => ({ uid: name, name, namespace: "web", resourceVersion: "1", createdAt: null, labels, values: {}, problems: [] });

test("parses equality, set and existence requirements", () => {
  expect(parseSelector("app=web, tier!=db")).toEqual([
    { key: "app", op: "=", values: ["web"] },
    { key: "tier", op: "!=", values: ["db"] },
  ]);
  expect(parseSelector("app==web")).toEqual([{ key: "app", op: "=", values: ["web"] }]);
  expect(parseSelector("env in (prod, stage),team notin (x)")).toEqual([
    { key: "env", op: "in", values: ["prod", "stage"] },
    { key: "team", op: "notin", values: ["x"] },
  ]);
  expect(parseSelector("app.kubernetes.io/name,!canary")).toEqual([
    { key: "app.kubernetes.io/name", op: "exists", values: [] },
    { key: "canary", op: "!exists", values: [] },
  ]);
});

test("rejects malformed selectors", () => {
  for (const bad of ["app=", "=web", "app=web,", "env in ()", "env in (a", "a b", "app=we b", "-bad=x"]) {
    expect(parseSelector(bad)).toBeNull();
  }
});

test("validates label keys and values like Kubernetes", () => {
  const n63 = "a".repeat(63);
  const prefix253 = [..."abc"].map(() => "a".repeat(63)).join(".") + "." + "b".repeat(61);
  expect(prefix253).toHaveLength(253);
  for (const bad of ["a..b/key=x", "a.-b/key=x", "a-.b/key=x", `${"a".repeat(64)}=x`, `key=${"a".repeat(64)}`, `${prefix253}a/key=x`, `a/${"a".repeat(64)}=x`, "A.b/key=x"]) {
    expect(parseFilter(bad)).toEqual({ kind: "invalid" });
  }
  expect(parseFilter(`${n63}=${n63}`)).toEqual({ kind: "selector", reqs: [{ key: n63, op: "=", values: [n63] }] });
  expect(parseFilter(`${prefix253}/key=x`)).toEqual({ kind: "selector", reqs: [{ key: `${prefix253}/key`, op: "=", values: ["x"] }] });
  expect(parseFilter("a.b-c.d/key=x").kind).toBe("selector");
});

test("parseFilter decides between a name and a selector", () => {
  expect(parseFilter("  ")).toEqual({ kind: "none" });
  expect(parseFilter("Api")).toEqual({ kind: "name", text: "api" });
  expect(parseFilter("app=web")).toEqual({ kind: "selector", reqs: [{ key: "app", op: "=", values: ["web"] }] });
  expect(parseFilter("env in (a)")).toEqual({ kind: "selector", reqs: [{ key: "env", op: "in", values: ["a"] }] });
  expect(parseFilter("app=")).toEqual({ kind: "invalid" });
});

test("matches rows", () => {
  const r = row("api-7d", { app: "web", env: "prod" });
  expect(matchesFilter(r, parseFilter("API"))).toBe(true);
  expect(matchesFilter(r, parseFilter("app=web,env in (prod)"))).toBe(true);
  expect(matchesFilter(r, parseFilter("app!=web"))).toBe(false);
  // 키가 없으면 != 와 notin 은 맞는다(쿠버네티스와 같다)
  expect(matchesFilter(r, parseFilter("tier!=db,tier notin (db)"))).toBe(true);
  expect(matchesFilter(r, parseFilter("!env"))).toBe(false);
  // 레이블 이름 하나만 쓴 필터는 이름 검색이다. 존재 요구는 셀렉터 안에서(parseSelector) 쓴다.
  expect(matchesFilter(r, { kind: "selector", reqs: parseSelector("env")! })).toBe(true);
  expect(matchesFilter(r, { kind: "none" })).toBe(true);
  expect(matchesFilter(r, { kind: "invalid" })).toBe(true);
});
