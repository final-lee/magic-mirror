import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { newQueryClient } from "../test/utils";
import { argocdApi } from "./api";
import { argoKeys, useApps, useAppsWatch, useAppsets } from "./queries";
import type { ArgoAppRow, ArgoWatchEvent } from "./types";

vi.mock("./api", () => ({ argocdApi: { apps: vi.fn(), appsets: vi.fn(), watchApps: vi.fn(), watchAppsets: vi.fn(), watchStop: vi.fn() } }));
const api = vi.mocked(argocdApi);
const url = "https://server";
const row = (name: string): ArgoAppRow => ({ name, namespace: "n", resourceVersion: "1", values: {}, labels: {} });
test("one apps watch updates the list and retries with polling after an error", async () => {
  const qc = newQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  let receive: (event: ArgoWatchEvent<ArgoAppRow>) => void = () => {};
  api.apps.mockResolvedValue([row("a")]);
  api.watchApps.mockImplementation(async (_url, cb) => { receive = cb; return 1; });
  api.watchStop.mockResolvedValue();
  const hook = renderHook(() => { useAppsWatch(url, true); return useApps(url, true); }, { wrapper });
  await waitFor(() => expect(hook.result.current.data).toHaveLength(1));
  await waitFor(() => expect(api.watchApps).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(qc.getQueryCache().find({ queryKey: argoKeys.apps(url) })?.observers[0].options.refetchInterval).toBe(false));
  act(() => receive({ type: "upsert", row: row("b") }));
  await waitFor(() => expect(hook.result.current.data).toHaveLength(2));
  act(() => receive({ type: "delete", namespace: "n", name: "a" }));
  await waitFor(() => expect(hook.result.current.data?.map((r) => r.name)).toEqual(["b"]));
  act(() => receive({ type: "error", error: "closed" }));
  await waitFor(() => expect(qc.getQueryCache().find({ queryKey: argoKeys.apps(url) })?.observers[0].options.refetchInterval).toBe(10_000));
  await waitFor(() => expect(api.watchApps).toHaveBeenCalledTimes(2), { timeout: 6500 });
  hook.unmount();
}, 8000);

test("restarting the watch replaces stale rows with a fresh snapshot", async () => {
  vi.clearAllMocks();
  const qc = newQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  api.apps.mockResolvedValueOnce([row("deleted")]).mockResolvedValue([row("remaining")]);
  api.watchApps.mockResolvedValue(10);
  api.watchStop.mockResolvedValue();
  const hook = renderHook(({ live }) => { useAppsWatch(url, live); return useApps(url, live); }, { wrapper, initialProps: { live: true } });
  await waitFor(() => expect(api.watchApps).toHaveBeenCalled());
  hook.rerender({ live: false });
  hook.rerender({ live: true });
  await waitFor(() => expect(hook.result.current.data?.map(r => r.name)).toEqual(["remaining"]));
  hook.unmount();
});

test("restarting the ApplicationSet watch removes deleted sets", async () => {
  vi.clearAllMocks();
  const qc = newQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const set = { name: "deleted", namespace: "n", status: null, message: null, generators: [] };
  api.appsets.mockResolvedValueOnce([set]).mockResolvedValue([]);
  api.watchAppsets.mockResolvedValue(11);
  api.watchStop.mockResolvedValue();
  const hook = renderHook(({ live }) => useAppsets(url, live), { wrapper, initialProps: { live: true } });
  await waitFor(() => expect(api.watchAppsets).toHaveBeenCalled());
  hook.rerender({ live: false });
  hook.rerender({ live: true });
  await waitFor(() => expect(hook.result.current.data).toEqual([]));
  hook.unmount();
});
