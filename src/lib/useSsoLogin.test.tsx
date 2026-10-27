import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "../api/client";
import { reportSsoExpired } from "../api/invoke";
import type { ProfileInfo } from "../api/types";
import { useSsoLogin } from "./useSsoLogin";

vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn(), ssoLoginCancel: vi.fn() } }));
const m = vi.mocked(api);

const PROFILES: ProfileInfo[] = [
  { name: "base", region: null, ssoLogin: "base", ssoKey: "session:corp" },
  { name: "admin", region: null, ssoLogin: "base", ssoKey: "session:corp" },
  { name: "keys", region: null, ssoLogin: null, ssoKey: null },
];

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useSsoLogin(PROFILES), { wrapper });
  return { hook, invalidate };
}

beforeEach(() => vi.clearAllMocks());

test("an expiry report starts one login per SSO session", async () => {
  const d = deferred();
  m.ssoLogin.mockReturnValue(d.promise);
  const { hook } = setup();
  act(() => {
    reportSsoExpired("admin");
    reportSsoExpired("base");
    reportSsoExpired("admin");
  });
  expect(m.ssoLogin).toHaveBeenCalledTimes(1);
  expect(m.ssoLogin).toHaveBeenCalledWith("base");
  expect(hook.result.current.entries).toEqual([{ key: "session:corp", profile: "admin", target: "base", status: { kind: "running" } }]);
  await act(async () => d.resolve());
});

test("success clears the entry and reloads every profile of the session", async () => {
  m.ssoLogin.mockResolvedValue(undefined);
  const { hook, invalidate } = setup();
  act(() => reportSsoExpired("admin"));
  await waitFor(() => expect(hook.result.current.entries).toEqual([]));
  const predicate = (invalidate.mock.calls[0][0] as unknown as { predicate: (q: { queryKey: unknown[] }) => boolean }).predicate;
  expect(predicate({ queryKey: ["resources", "base", "x"] })).toBe(true);
  expect(predicate({ queryKey: ["account", "admin"] })).toBe(true);
  expect(predicate({ queryKey: ["account", "keys"] })).toBe(false);
  expect(predicate({ queryKey: ["settings"] })).toBe(false);
});

test("a failure is not retried automatically, but re-selecting the profile or a manual start retries", async () => {
  m.ssoLogin.mockRejectedValueOnce({ kind: "other", message: "aws CLI를 찾을 수 없어요" });
  const { hook } = setup();
  act(() => reportSsoExpired("base"));
  await waitFor(() => expect(hook.result.current.statusFor("base")).toEqual({ kind: "failed", message: "aws CLI를 찾을 수 없어요" }));
  act(() => reportSsoExpired("base"));
  expect(m.ssoLogin).toHaveBeenCalledTimes(1);

  m.ssoLogin.mockResolvedValue(undefined);
  act(() => hook.result.current.rearm("admin"));
  expect(hook.result.current.statusFor("base")).toBeNull();
  act(() => reportSsoExpired("base"));
  expect(m.ssoLogin).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(hook.result.current.entries).toEqual([]));

  m.ssoLogin.mockRejectedValueOnce({ kind: "other", message: "x" });
  act(() => reportSsoExpired("base"));
  await waitFor(() => expect(hook.result.current.statusFor("base")?.kind).toBe("failed"));
  let ok = true;
  await act(async () => {
    ok = await hook.result.current.start("base", { manual: true });
  });
  expect(m.ssoLogin).toHaveBeenCalledTimes(4);
  expect(ok).toBe(true);
});

test("cancel stops the login and keeps it from reopening", async () => {
  const d = deferred();
  m.ssoLogin.mockReturnValue(d.promise);
  m.ssoLoginCancel.mockResolvedValue(undefined);
  const { hook } = setup();
  act(() => reportSsoExpired("admin"));
  act(() => hook.result.current.cancel("session:corp"));
  expect(m.ssoLoginCancel).toHaveBeenCalledWith("base");
  await act(async () => d.reject({ kind: "other", message: "로그인을 취소했어요" }));
  expect(hook.result.current.statusFor("admin")).toEqual({ kind: "cancelled" });
  act(() => reportSsoExpired("admin"));
  expect(m.ssoLogin).toHaveBeenCalledTimes(1);
});

test("dismissing a failure keeps it closed; non-SSO profiles never log in automatically", async () => {
  m.ssoLogin.mockRejectedValueOnce({ kind: "other", message: "x" });
  const { hook } = setup();
  act(() => reportSsoExpired("keys"));
  expect(m.ssoLogin).not.toHaveBeenCalled();
  act(() => reportSsoExpired("base"));
  await waitFor(() => expect(hook.result.current.statusFor("base")?.kind).toBe("failed"));
  act(() => hook.result.current.dismiss("session:corp"));
  expect(hook.result.current.statusFor("base")).toEqual({ kind: "cancelled" });
});

test("a manual start joins the running login", async () => {
  const d = deferred();
  m.ssoLogin.mockReturnValue(d.promise);
  const { hook } = setup();
  act(() => reportSsoExpired("admin"));
  let joined: Promise<boolean> = Promise.resolve(false);
  act(() => {
    joined = hook.result.current.start("base", { manual: true });
  });
  expect(m.ssoLogin).toHaveBeenCalledTimes(1);
  await act(async () => d.resolve());
  await expect(joined).resolves.toBe(true);
});
