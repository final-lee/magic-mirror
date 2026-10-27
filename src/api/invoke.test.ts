import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { invoke, onSsoExpired } from "./invoke";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const raw = vi.mocked(tauriInvoke);

test("an ssoExpired failure with a profile is reported and still rethrown", async () => {
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(invoke("list_resources", { profile: "prod", region: "x" })).rejects.toEqual({ kind: "ssoExpired" });
  expect(seen).toEqual(["prod"]);
  off();
});

test("other failures, calls without a profile and successes are not reported", async () => {
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  raw.mockRejectedValueOnce({ kind: "accessDenied", action: "a" });
  await expect(invoke("get_account", { profile: "prod" })).rejects.toBeTruthy();
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(invoke("list_profiles")).rejects.toBeTruthy();
  raw.mockResolvedValueOnce("123");
  await expect(invoke("get_account", { profile: "prod" })).resolves.toBe("123");
  expect(seen).toEqual([]);
  off();
});

test("unsubscribed listeners are not called", async () => {
  const seen: string[] = [];
  onSsoExpired((p) => seen.push(p))();
  raw.mockRejectedValueOnce({ kind: "ssoExpired" });
  await expect(invoke("get_account", { profile: "prod" })).rejects.toBeTruthy();
  expect(seen).toEqual([]);
});
