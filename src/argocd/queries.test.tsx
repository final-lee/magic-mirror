import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { newQueryClient } from "../test/utils";
import { argocdApi } from "./api";
import { POLL_MS, argoKeys, isTokenError, useApps, useAppsets, useArgoApp, useArgoTree, useSession } from "./queries";
import { TOKEN_INVALID, TOKEN_MISSING } from "./text";

vi.mock("./api", () => ({ argocdApi: { session: vi.fn(), apps: vi.fn(), appsets: vi.fn(), app: vi.fn(), tree: vi.fn() } }));
const m = vi.mocked(argocdApi);
const URL = "https://argocd.example";

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
const intervalOf = (key: readonly unknown[]) => qc.getQueryCache().find({ queryKey: key })?.observers[0].options.refetchInterval;

beforeEach(() => {
  vi.resetAllMocks();
  qc = newQueryClient();
  m.session.mockResolvedValue({ url: URL, username: "admin", version: "v3" });
  m.apps.mockResolvedValue([]);
  m.appsets.mockResolvedValue([]);
  m.app.mockResolvedValue({} as never);
  m.tree.mockResolvedValue([]);
});

test("only the two token messages count as a token error", () => {
  expect(isTokenError({ kind: "other", message: TOKEN_INVALID })).toBe(true);
  expect(isTokenError({ kind: "other", message: TOKEN_MISSING })).toBe(true);
  expect(isTokenError({ kind: "other", message: "서버 오류" })).toBe(false);
  expect(isTokenError({ kind: "network", message: TOKEN_INVALID })).toBe(false);
  expect(isTokenError(null)).toBe(false);
  expect(isTokenError(undefined)).toBe(false);
});

test("apps and appsets poll every 10 seconds while live, and stop when not", async () => {
  expect(POLL_MS).toBe(10_000);
  const live = renderHook(() => [useApps(URL, true), useAppsets(URL, true)], { wrapper });
  await waitFor(() => expect(live.result.current.every((q) => q.isSuccess)).toBe(true));
  expect(intervalOf(argoKeys.apps(URL))).toBe(10_000);
  expect(intervalOf(argoKeys.appsets(URL))).toBe(10_000);
  live.unmount();

  qc = newQueryClient();
  const hidden = renderHook(() => [useApps(URL, false), useAppsets(URL, false)], { wrapper });
  await waitFor(() => expect(hidden.result.current.every((q) => q.isSuccess)).toBe(true));
  expect(intervalOf(argoKeys.apps(URL))).toBe(false);
  expect(intervalOf(argoKeys.appsets(URL))).toBe(false);
});

test("each server has its own cache entries", async () => {
  m.apps.mockImplementation(async (url) => [{ name: url, namespace: "argocd", resourceVersion: "1", values: {}, labels: {} }]);
  const a = renderHook(() => useApps("https://a", true), { wrapper });
  const b = renderHook(() => useApps("https://b", true), { wrapper });
  await waitFor(() => expect(a.result.current.isSuccess && b.result.current.isSuccess).toBe(true));
  expect(a.result.current.data?.[0].name).toBe("https://a");
  expect(b.result.current.data?.[0].name).toBe("https://b");
});

test("the app detail is keyed by the list's resourceVersion, so a new version reads it again", async () => {
  const { rerender } = renderHook(({ v }) => useArgoApp(URL, "argocd", "web", v), { wrapper, initialProps: { v: "1" } });
  await waitFor(() => expect(m.app).toHaveBeenCalledTimes(1));
  rerender({ v: "1" });
  rerender({ v: "2" });
  await waitFor(() => expect(m.app).toHaveBeenCalledTimes(2));
  expect(m.app).toHaveBeenCalledWith(URL, "argocd", "web");
});

test("the tree is read only when enabled", async () => {
  const { rerender } = renderHook(({ on }) => useArgoTree(URL, "argocd", "web", "1", on, true), { wrapper, initialProps: { on: false } });
  await Promise.resolve();
  expect(m.tree).not.toHaveBeenCalled();
  rerender({ on: true });
  await waitFor(() => expect(m.tree).toHaveBeenCalledWith(URL, "argocd", "web"));
  expect(intervalOf(argoKeys.tree(URL, "argocd", "web", "1"))).toBe(10_000);
});

test("the session is not asked while disabled and has no retries", async () => {
  const { rerender, result } = renderHook(({ on }) => useSession(URL, on), { wrapper, initialProps: { on: false } });
  await Promise.resolve();
  expect(m.session).not.toHaveBeenCalled();
  rerender({ on: true });
  await waitFor(() => expect(result.current.data?.username).toBe("admin"));
  expect(m.session).toHaveBeenCalledTimes(1);
});
