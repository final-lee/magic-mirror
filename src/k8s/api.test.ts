import { invoke } from "@tauri-apps/api/core";
import { onSsoExpired } from "../api/invoke";
import { k8sApi } from "./api";
import { NAMESPACES } from "./targets";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class { onmessage: ((m: unknown) => void) | null = null } }));

const T = { profile: "app", region: "ap-northeast-2", cluster: "prod" };

beforeEach(() => vi.clearAllMocks());

test("open passes the exec profile at the top level for SSO reporting", async () => {
  vi.mocked(invoke).mockResolvedValue({});
  await k8sApi.open(T, null, "ctx", "prod-ro");
  expect(invoke).toHaveBeenCalledWith("k8s_open", { target: T, kubeconfig: null, context: "ctx", profile: "prod-ro" });
});

test("an ssoExpired from open reports the exec profile, not the app profile", async () => {
  vi.mocked(invoke).mockRejectedValue({ kind: "ssoExpired" });
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  await expect(k8sApi.open(T, null, "ctx", "prod-ro")).rejects.toEqual({ kind: "ssoExpired" });
  off();
  expect(seen).toEqual(["prod-ro"]);
});

test("context does not pass a top-level profile", async () => {
  vi.mocked(invoke).mockResolvedValue({});
  await k8sApi.context(T, "~/kc", "saved");
  expect(invoke).toHaveBeenCalledWith("k8s_context", { target: T, kubeconfig: "~/kc", saved: "saved" });
});

test("close, rules and unwatch wire", async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  await k8sApi.close(T, "p");
  await k8sApi.rules(T, "ops", "p");
  await k8sApi.unwatch(3);
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["k8s_close", { target: T, profile: "p" }],
    ["k8s_rules", { target: T, namespace: "ops", profile: "p" }],
    ["k8s_unwatch", { watchId: 3 }],
  ]);
});

test("watch hands a Channel whose messages reach the callback", async () => {
  vi.mocked(invoke).mockResolvedValue(7);
  const got: unknown[] = [];
  const id = await k8sApi.watch(T, NAMESPACES, null, "prod-ro", (m) => got.push(m));
  expect(id).toBe(7);
  const args = vi.mocked(invoke).mock.lastCall![1] as { onEvent: { onmessage: (m: unknown) => void } };
  args.onEvent.onmessage({ type: "reset", rows: [] });
  expect(got).toEqual([{ type: "reset", rows: [] }]);
});

test("K2 reads pass the exec profile at the top level", async () => {
  vi.mocked(invoke).mockResolvedValue({});
  const kind = { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true };
  await k8sApi.kinds(T, "prod-ro");
  expect(invoke).toHaveBeenLastCalledWith("k8s_kinds", { target: T, profile: "prod-ro" });
  await k8sApi.get(T, kind, "web", "api", "prod-ro");
  expect(invoke).toHaveBeenLastCalledWith("k8s_get", { target: T, kind, namespace: "web", name: "api", profile: "prod-ro" });
  await k8sApi.secretValue(T, "web", "db", "password", "prod-ro");
  expect(invoke).toHaveBeenLastCalledWith("k8s_secret_value", { target: T, namespace: "web", name: "db", key: "password", profile: "prod-ro" });
});

test("overview reports SSO expiry for the app profile", async () => {
  vi.mocked(invoke).mockResolvedValue({});
  await k8sApi.overview(T);
  expect(invoke).toHaveBeenLastCalledWith("k8s_overview", { target: T, profile: "app" });
});
