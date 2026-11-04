import { CRDS, DEPLOYMENTS, NODES, PODS, SECRETS, SERVICES } from "../kinds";
import type { K8sKind } from "../types";
import { closestNames, editDistance, resolveKind, suggestKinds } from "./aliases";

/** API 서버가 주는 모양: 짧은 이름·단수 이름이 붙어 있다 */
const served = (ref: typeof PODS, shortNames: string[], singularName: string, custom = false): K8sKind => ({ ...ref, verbs: ["list", "watch"], custom, shortNames, singularName });
const CLUSTER: K8sKind[] = [
  served(PODS, ["po"], "pod"),
  served(DEPLOYMENTS, ["deploy"], "deployment"),
  served(SERVICES, ["svc"], "service"),
  served(NODES, ["no"], "node"),
  served(SECRETS, [], "secret"),
  served(CRDS, ["crd", "crds"], "customresourcedefinition"),
  { group: "", version: "v1", kind: "Event", plural: "events", namespaced: true, verbs: [], custom: false, shortNames: ["ev"], singularName: "event" },
  { group: "events.k8s.io", version: "v1", kind: "Event", plural: "events", namespaced: true, verbs: [], custom: false, shortNames: ["ev"], singularName: "event" },
  { group: "mm.example.com", version: "v1", kind: "Widget", plural: "widgets", namespaced: true, verbs: [], custom: true, shortNames: ["wd"], singularName: "widget" },
  { group: "acme.io", version: "v1", kind: "Widget", plural: "widgets", namespaced: true, verbs: [], custom: true, shortNames: ["wd"], singularName: "widget" },
  { group: "solo.io", version: "v1alpha1", kind: "Gateway", plural: "gateways", namespaced: true, verbs: [], custom: true, shortNames: ["gw"], singularName: "gateway" },
];
const plural = (input: string, kinds = CLUSTER) => {
  const r = resolveKind(input, kinds);
  return r.ok ? r.kind.plural : r;
};

describe("resolveKind with discovery data", () => {
  test.each([
    ["pods", "pods"], ["pod", "pods"], ["po", "pods"], ["Pod", "pods"], ["PODS", "pods"],
    ["deploy", "deployments"], ["deployment", "deployments"], ["deployments", "deployments"], ["dp", "deployments"],
    ["svc", "services"], ["no", "nodes"], ["node", "nodes"], ["crd", "customresourcedefinitions"], ["crds", "customresourcedefinitions"],
    // 서버가 짧은 이름을 주지 않아도(Secret) k9s의 별칭으로 연다
    ["sec", "secrets"], ["secret", "secrets"],
    // 사용자 정의 리소스는 서버가 준 별칭으로
    ["gw", "gateways"], ["gateway", "gateways"],
  ])("%s → %s", (input, expected) => {
    expect(plural(input)).toBe(expected);
  });

  test("a name qualified with its group points at that group's kind", () => {
    const apps = resolveKind("deployments.apps", CLUSTER);
    expect(apps.ok && apps.kind.group).toBe("apps");
    const events = resolveKind("events.events.k8s.io", CLUSTER);
    expect(events.ok && events.kind.group).toBe("events.k8s.io");
    const withVersion = resolveKind("deployments.v1.apps", CLUSTER);
    expect(withVersion.ok && withVersion.kind.group).toBe("apps");
    const widget = resolveKind("widget.acme.io", CLUSTER);
    expect(widget.ok && widget.kind.group).toBe("acme.io");
  });

  test("a name in the core group and in another group goes to the core one", () => {
    const events = resolveKind("events", CLUSTER);
    expect(events.ok && events.kind.group).toBe("");
  });

  test("the same custom name in two groups is ambiguous and lists both, never guesses", () => {
    const widget = resolveKind("wd", CLUSTER);
    expect(widget).toEqual({ ok: false, reason: "ambiguous", options: expect.arrayContaining([expect.objectContaining({ group: "mm.example.com" }), expect.objectContaining({ group: "acme.io" })]) });
    expect(widget.ok === false && widget.options).toHaveLength(2);
  });

  test("a built-in name beats a custom kind with the same short name", () => {
    const hijack: K8sKind = { group: "evil.io", version: "v1", kind: "Pod", plural: "pods", namespaced: true, verbs: [], custom: true, shortNames: ["po"], singularName: "pod" };
    const r = resolveKind("po", [...CLUSTER, hijack]);
    expect(r.ok && r.kind.group).toBe("");
  });

  test("unknown and empty names are not resolved", () => {
    expect(resolveKind("nonsense", CLUSTER)).toEqual({ ok: false, reason: "unknown", options: [] });
    expect(resolveKind("  ", CLUSTER)).toEqual({ ok: false, reason: "unknown", options: [] });
    // 서버에 없는 종류는 내장 별칭이어도 열지 못한다
    expect(resolveKind("cm", CLUSTER).ok).toBe(false);
  });
});

describe("resolveKind before the kinds are known", () => {
  test("built-in kinds still open by their k9s names", () => {
    for (const [input, expected] of [["po", "pods"], ["deploy", "deployments"], ["svc", "services"], ["no", "nodes"], ["cm", "configmaps"], ["sec", "secrets"], ["ing", "ingresses"], ["crd", "customresourcedefinitions"], ["pvc", "persistentvolumeclaims"], ["sts", "statefulsets"]]) {
      expect(plural(input, [])).toBe(expected);
    }
    expect(plural("gw", [])).toMatchObject({ reason: "unknown" });
  });
});

describe("closest matches", () => {
  test("a typo with letters in the right order finds its kind", () => {
    expect(closestNames("depoy", CLUSTER)[0]).toMatch(/^deploy/);
    expect(suggestKinds("dep", CLUSTER)[0].kind.plural).toBe("deployments");
  });

  test("a typo with swapped letters falls back to edit distance", () => {
    expect(closestNames("dpeloy", CLUSTER)).toContain("deploy");
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
  });

  test("far-off text has no suggestions", () => {
    expect(closestNames("zzzzzzzz", CLUSTER)).toEqual([]);
  });

  test("completions show one name per kind: the best-matching one, with the others as hints", () => {
    const hit = suggestKinds("po", CLUSTER)[0];
    expect(hit.kind.plural).toBe("pods");
    expect(hit.name).toBe("po");
    expect(hit.others).toEqual(expect.arrayContaining(["pods", "pod"]));
    expect(suggestKinds("po", CLUSTER).filter((h) => h.kind.plural === "pods")).toHaveLength(1);
  });

  test("group-qualified names only show up when the query has a dot", () => {
    expect(suggestKinds("deploy", CLUSTER).every((h) => !h.name.includes("."))).toBe(true);
    expect(suggestKinds("deployments.ap", CLUSTER)[0].name).toBe("deployments.apps");
  });
});
