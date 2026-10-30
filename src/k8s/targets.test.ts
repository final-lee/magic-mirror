import { chooseContext, k8sTabId, ssoProfileOf, targetKey } from "./targets";

const T = { profile: "app", region: "ap-northeast-2", cluster: "prod" };
const cand = { name: "c", cluster: "x", user: "u", namespace: null, execProfile: "cand-p" };
const session = { context: "c", execProfile: "sess-p", identity: { username: "a", groups: [], arn: null, source: "kubeconfig" as const }, serverVersion: "v1" };

test("keys and tab id", () => {
  expect(targetKey(T)).toBe("app|ap-northeast-2|prod");
  expect(k8sTabId(T)).toBe("k8s:ap-northeast-2:prod");
});

test("ssoProfileOf falls back session -> candidate -> target", () => {
  expect(ssoProfileOf(T, cand, session)).toBe("sess-p");
  expect(ssoProfileOf(T, cand, { ...session, execProfile: null })).toBe("cand-p");
  expect(ssoProfileOf(T, cand, null)).toBe("cand-p");
  expect(ssoProfileOf(T, { ...cand, execProfile: null }, null)).toBe("app");
  expect(ssoProfileOf(T, null, undefined)).toBe("app");
});

const first = "arn:aws:eks:ap-northeast-2:111111111111:cluster/prod";
const both = [first, "prod-admin"];

test("chooseContext", () => {
  expect(chooseContext(both, "prod-admin")).toEqual(["prod-admin", null]);
  expect(chooseContext(both, "gone")).toEqual([null, "gone"]);
  expect(chooseContext(both, null)).toEqual([null, null]);
  expect(chooseContext([first], null)).toEqual([first, null]);
  expect(chooseContext([first], "gone")).toEqual([first, "gone"]);
});
