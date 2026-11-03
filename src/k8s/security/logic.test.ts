import { FINDINGS, READ_ONLY, ALLOWED, escalationFix, finding, report, saFix } from "./fixtures";
import {
  DEFAULT_SETTING, NO_FILTER, countFindings, filterFindings, fixBlock, fixChange, groupByCheck, groupGaps, hiddenSystemCount, isEnabled, skippedTitles, targetLabel,
  targetLinks, visibleFindings, withCheck, withChecks, withIncludeSystem,
} from "./logic";
import { CATEGORIES, CHECKS, CHECK_BY_ID } from "./text";
import type { SecurityGap } from "./types";

const ids = (list: { id: string }[]) => list.map((f) => f.id);

describe("which findings are visible", () => {
  test("by default every check is on and system namespaces are left out", () => {
    const visible = visibleFindings(FINDINGS, DEFAULT_SETTING);
    expect(visible.some((f) => f.system)).toBe(false);
    expect(visible).toHaveLength(FINDINGS.length - 1);
    expect(hiddenSystemCount(FINDINGS, DEFAULT_SETTING)).toBe(1);
  });

  test("including system namespaces shows them and hides nothing", () => {
    const setting = withIncludeSystem(DEFAULT_SETTING, true);
    expect(visibleFindings(FINDINGS, setting)).toHaveLength(FINDINGS.length);
    expect(hiddenSystemCount(FINDINGS, setting)).toBe(0);
  });

  test("a disabled check disappears whatever the namespace and is not counted as hidden system", () => {
    const setting = withCheck(DEFAULT_SETTING, "privileged", false);
    const visible = visibleFindings(FINDINGS, setting);
    expect(visible.some((f) => f.check === "privileged")).toBe(false);
    // 시스템 네임스페이스의 privileged는 항목이 꺼져서 숨은 것이라 시스템 때문에 숨긴 수에 세지 않는다
    expect(hiddenSystemCount(FINDINGS, setting)).toBe(0);
    expect(isEnabled(setting, "privileged")).toBe(false);
    expect(isEnabled(setting, "hostPath")).toBe(true);
  });
});

describe("settings updates", () => {
  test("turning a check off and on again restores the previous setting without duplicates", () => {
    const off = withCheck(withCheck(DEFAULT_SETTING, "hostPath", false), "hostPath", false);
    expect(off.disabled).toEqual(["hostPath"]);
    expect(withCheck(off, "hostPath", true)).toEqual(DEFAULT_SETTING);
  });

  test("other settings and unknown names are kept", () => {
    const base = { disabled: ["futureCheck"], includeSystem: true };
    expect(withCheck(base, "privileged", false)).toEqual({ disabled: ["futureCheck", "privileged"], includeSystem: true });
    expect(withIncludeSystem(base, false)).toEqual({ disabled: ["futureCheck"], includeSystem: false });
  });

  test("a whole category can be switched off and on", () => {
    const cluster = CHECKS.filter((c) => c.category === "cluster").map((c) => c.id);
    const off = withChecks(DEFAULT_SETTING, cluster, false);
    expect(off.disabled).toHaveLength(6);
    expect(withChecks(off, cluster.slice(0, 2), true).disabled).toHaveLength(4);
    expect(withChecks(off, cluster, true)).toEqual(DEFAULT_SETTING);
    // 이미 꺼진 것을 다시 꺼도 겹치지 않는다
    expect(withChecks(off, cluster, false).disabled).toHaveLength(6);
  });
});

test("counts findings by severity and by the category of their check", () => {
  const counts = countFindings(visibleFindings(FINDINGS, DEFAULT_SETTING));
  expect(counts.total).toBe(7);
  expect(counts.severity).toEqual({ high: 5, medium: 1, low: 1 });
  expect(counts.category).toEqual({ cluster: 1, permissions: 3, workloads: 3 });
});

describe("filtering", () => {
  const visible = visibleFindings(FINDINGS, DEFAULT_SETTING);

  test("severity and category narrow the list together", () => {
    expect(filterFindings(visible, { ...NO_FILTER, severity: "medium" }).map((f) => f.check)).toEqual(["privilegeEscalation"]);
    const high = filterFindings(visible, { ...NO_FILTER, severity: "high", category: "permissions" });
    expect(high.map((f) => f.check).sort()).toEqual(["adminSubject", "anonymousAccess", "secretsReadAll"]);
  });

  test("the text search looks at the check title, message, target and namespace, ignoring case", () => {
    expect(filterFindings(visible, { ...NO_FILTER, query: "SECRET" }).map((f) => f.check)).toEqual(["secretsReadAll"]);
    expect(filterFindings(visible, { ...NO_FILTER, query: "ci/runner" })).toHaveLength(1);
    expect(filterFindings(visible, { ...NO_FILTER, query: "dev" }).map((f) => f.check)).toEqual(["privileged", "privilegeEscalation", "saTokenAutomount"]);
    expect(filterFindings(visible, { ...NO_FILTER, query: "모든 IP" }).map((f) => f.check)).toEqual(["clusterPublicEndpoint"]);
    expect(filterFindings(visible, { ...NO_FILTER, query: "   " })).toHaveLength(visible.length);
    expect(filterFindings(visible, { ...NO_FILTER, query: "nothing-matches" })).toEqual([]);
  });
});

describe("grouping by check", () => {
  test("groups are ordered by their most severe finding, then by the order of the checks", () => {
    const list = [
      finding({ id: "a", check: "hostPath", severity: "medium" }),
      finding({ id: "b", check: "privileged", severity: "high" }),
      finding({ id: "c", check: "hostPath", severity: "high" }),
      finding({ id: "d", check: "imageLatest", severity: "low" }),
      finding({ id: "e", check: "adminSubject", severity: "high" }),
    ];
    const groups = groupByCheck(list);
    // 둘 다 high인 adminSubject·privileged·hostPath는 점검 항목 순서(권한 → 워크로드의 privileged → hostPath)다
    expect(groups.map((g) => g.check)).toEqual(["adminSubject", "privileged", "hostPath", "imageLatest"]);
    expect(groups[2].severity).toBe("high");
    expect(ids(groups[2].findings)).toEqual(["a", "c"]);
  });

  test("no findings means no groups", () => {
    expect(groupByCheck([])).toEqual([]);
  });
});

describe("target labels and links", () => {
  test("labels read naturally for objects, subjects and AWS resources", () => {
    expect(targetLabel({ type: "object", kind: { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true }, namespace: "dev", name: "web" })).toBe("Deployment dev/web");
    expect(targetLabel({ type: "object", kind: { group: "", version: "v1", kind: "Namespace", plural: "namespaces", namespaced: false }, namespace: null, name: "dev" })).toBe("Namespace dev");
    expect(targetLabel({ type: "subject", subject: { kind: "serviceAccount", name: "runner", namespace: "ci" } })).toBe("ServiceAccount ci/runner");
    expect(targetLabel({ type: "subject", subject: { kind: "iam", name: "arn:aws:iam::1:role/ops", namespace: null } })).toBe("IAM 주체 arn:aws:iam::1:role/ops");
    expect(targetLabel({ type: "aws", resource: "nodegroup", name: "ng-a" })).toBe("노드그룹 ng-a");
    expect(targetLabel({ type: "aws", resource: "mystery", name: "x" })).toBe("mystery x");
  });

  test("an object opens in the workloads view, a service account opens as an object and in access, an IAM principal in IAM and access", () => {
    const object = targetLinks(FINDINGS[0]);
    expect(object).toEqual([{ type: "object", ref: { kind: expect.objectContaining({ kind: "Deployment" }), namespace: "dev", name: "web" }, label: "object" }]);
    const sa = targetLinks(FINDINGS.find((f) => f.check === "secretsReadAll")!);
    expect(sa.map((l) => l.type)).toEqual(["object", "access"]);
    expect(sa[0]).toMatchObject({ ref: { kind: { kind: "ServiceAccount" }, namespace: "ci", name: "runner" }, label: "serviceAccount" });
    const iam = targetLinks(FINDINGS.find((f) => f.check === "adminSubject")!);
    expect(iam).toEqual([{ type: "iam", arn: "arn:aws:iam::1:role/ops" }, { type: "access" }]);
  });

  test("users and groups only link to the access screen and AWS resources have no link", () => {
    expect(targetLinks(finding({ target: { type: "subject", subject: { kind: "user", name: "alice", namespace: null } } }))).toEqual([{ type: "access" }]);
    expect(targetLinks(finding({ target: { type: "subject", subject: { kind: "group", name: "devs", namespace: null } } }))).toEqual([{ type: "access" }]);
    expect(targetLinks(FINDINGS.find((f) => f.check === "clusterPublicEndpoint")!)).toEqual([]);
  });
});

describe("the fix", () => {
  test("turns into an apply change of the partial object, never forced", () => {
    expect(fixChange(saFix)).toEqual({ kind: saFix.kind, namespace: "dev", name: "default", type: "apply", object: saFix.object, force: false });
    expect(fixChange(escalationFix)).toMatchObject({ type: "apply", force: false, name: "web", kind: { kind: "Deployment" } });
  });

  test("the button is disabled only when patch is certainly denied", () => {
    expect(fixBlock(saFix, undefined)).toBeUndefined();
    expect(fixBlock(saFix, ALLOWED)).toBeUndefined();
    expect(fixBlock(saFix, READ_ONLY)).toBe("serviceaccounts에 patch 권한이 없어요");
    // 규칙이 불완전하면 서버 판단에 맡긴다
    expect(fixBlock(saFix, { ...READ_ONLY, incomplete: true })).toBeUndefined();
    // 같은 규칙이라도 다른 API 그룹의 리소스에는 맞지 않는다
    const rules = { ...ALLOWED, resourceRules: [{ verbs: ["patch"], apiGroups: [""], resources: ["serviceaccounts"], resourceNames: [] }] };
    expect(fixBlock(saFix, rules)).toBeUndefined();
    expect(fixBlock(escalationFix, rules)).toBe("deployments에 patch 권한이 없어요");
  });
});

describe("what could not be read", () => {
  test("skipped checks are listed by title unless the user turned them off", () => {
    const r = report({ skipped: ["privileged", "hostPath"] });
    expect(skippedTitles(r, DEFAULT_SETTING)).toEqual([CHECK_BY_ID.privileged.title, CHECK_BY_ID.hostPath.title]);
    expect(skippedTitles(r, withCheck(DEFAULT_SETTING, "hostPath", false))).toEqual([CHECK_BY_ID.privileged.title]);
  });

  test("gaps with the same reason are merged and truncated lists are reported apart from errors", () => {
    const denied = { kind: "accessDenied", action: "eks:DescribeCluster" } as const;
    const gaps: SecurityGap[] = [
      { section: "cluster", subject: null, error: denied, partial: false },
      { section: "versions", subject: null, error: denied, partial: false },
      { section: "rbac", subject: null, error: { kind: "other", message: "x" }, partial: false },
      { section: "pods", subject: null, error: { kind: "other", message: "잘림" }, partial: true },
      { section: "pods", subject: null, error: { kind: "other", message: "잘림" }, partial: true },
    ];
    const grouped = groupGaps(gaps);
    expect(grouped.errors.map((g) => g.sections)).toEqual([["cluster", "versions"], ["rbac"]]);
    expect(grouped.partial).toEqual(["pods"]);
  });
});

test("the check catalog lists every check once, in the categories the backend uses (6 cluster, 10 permission, 12 workload)", () => {
  expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length);
  expect(CATEGORIES.map((c) => CHECKS.filter((x) => x.category === c).length)).toEqual([6, 10, 12]);
  for (const c of CHECKS) {
    expect(c.title.length).toBeGreaterThan(0);
    expect(c.why.length).toBeGreaterThan(20);
    expect(c.remedy.length).toBeGreaterThan(10);
  }
});
