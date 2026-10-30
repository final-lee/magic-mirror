import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { k8sApi } from "./api";
import { closeK8s, k8sKeys, refreshK8s, useK8sContext, useK8sRules, useK8sSession } from "./queries";

vi.mock("./api", () => ({ k8sApi: { context: vi.fn(), open: vi.fn(), close: vi.fn(), rules: vi.fn(), watch: vi.fn(), unwatch: vi.fn() } }));
const api = vi.mocked(k8sApi);

const T = { profile: "app", region: "r", cluster: "prod" };
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (qc: QueryClient) => ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  api.close.mockResolvedValue(null);
});

test("closeK8s removes the target's queries and closes once", async () => {
  const qc = client();
  qc.setQueryData(k8sKeys.session(T, "ctx"), { context: "ctx" });
  qc.setQueryData(k8sKeys.root({ ...T, cluster: "other" }), 1);
  await closeK8s(qc, T, "prod-ro");
  expect(qc.getQueryData(k8sKeys.session(T, "ctx"))).toBeUndefined();
  expect(qc.getQueryData(k8sKeys.root({ ...T, cluster: "other" }))).toBe(1);
  expect(api.close).toHaveBeenCalledTimes(1);
  expect(api.close).toHaveBeenCalledWith(T, "prod-ro");
});

test("closeK8s ignores a close error", async () => {
  api.close.mockRejectedValue({ kind: "other" });
  await expect(closeK8s(client(), T, "p")).resolves.toBeUndefined();
});

test("refreshK8s closes and re-runs the context query", async () => {
  const qc = client();
  api.context.mockResolvedValue({ chosen: null } as never);
  const { result } = renderHook(() => useK8sContext(T, null, null), { wrapper: wrap(qc) });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(api.context).toHaveBeenCalledTimes(1);
  await refreshK8s(qc, T, "p");
  expect(api.close).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(api.context).toHaveBeenCalledTimes(2));
});

test("session waits for a context; rules wait for enabled and a namespace", async () => {
  const qc = client();
  renderHook(() => useK8sSession(T, null, null, "p"), { wrapper: wrap(qc) });
  renderHook(() => useK8sRules(T, "ctx", "ops", "p", false), { wrapper: wrap(qc) });
  renderHook(() => useK8sRules(T, "ctx", null, "p", true), { wrapper: wrap(qc) });
  expect(api.open).not.toHaveBeenCalled();
  expect(api.rules).not.toHaveBeenCalled();
  api.open.mockResolvedValue({ context: "ctx" } as never);
  api.rules.mockResolvedValue({ namespace: "ops" } as never);
  renderHook(() => useK8sSession(T, "~/kc", "ctx", "p"), { wrapper: wrap(qc) });
  renderHook(() => useK8sRules(T, "ctx", "ops", "p", true), { wrapper: wrap(qc) });
  await waitFor(() => expect(api.open).toHaveBeenCalledWith(T, "~/kc", "ctx", "p"));
  await waitFor(() => expect(api.rules).toHaveBeenCalledWith(T, "ops", "p"));
});

test("rules are cached per context", async () => {
  const qc = client();
  api.rules.mockResolvedValue({ namespace: "ops" } as never);
  renderHook(() => useK8sRules(T, "a", "ops", "p", true), { wrapper: wrap(qc) });
  renderHook(() => useK8sRules(T, "b", "ops", "p", true), { wrapper: wrap(qc) });
  await waitFor(() => expect(api.rules).toHaveBeenCalledTimes(2));
  expect(k8sKeys.rules(T, "a", "ops")).not.toEqual(k8sKeys.rules(T, "b", "ops"));
});

test("closeK8s drops queries only after close finishes", async () => {
  const qc = client();
  qc.setQueryData(k8sKeys.session(T, "ctx"), { context: "ctx" });
  let release!: () => void;
  api.close.mockReturnValue(new Promise((r) => (release = () => r(null))));
  const done = closeK8s(qc, T, "p");
  expect(qc.getQueryData(k8sKeys.session(T, "ctx"))).toBeDefined();
  release();
  await done;
  expect(qc.getQueryData(k8sKeys.session(T, "ctx"))).toBeUndefined();
});

test("refreshK8s closes, then reopens a mounted session and refetches the context, with no watch in between", async () => {
  const qc = client();
  const log: string[] = [];
  api.context.mockResolvedValue({ chosen: "ctx" } as never);
  api.open.mockImplementation(async () => {
    log.push("open");
    return { context: "ctx" } as never;
  });
  api.close.mockImplementation(async () => {
    log.push("close");
    return null;
  });
  const { result } = renderHook(
    () => ({ ctx: useK8sContext(T, null, null), session: useK8sSession(T, null, "ctx", "p") }),
    { wrapper: wrap(qc) },
  );
  await waitFor(() => expect(result.current.session.isSuccess).toBe(true));
  await waitFor(() => expect(result.current.ctx.isSuccess).toBe(true));
  log.length = 0;
  await refreshK8s(qc, T, "p");
  await waitFor(() => expect(api.open).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(api.context).toHaveBeenCalledTimes(2));
  expect(log).toEqual(["close", "open"]);
  expect(api.watch).not.toHaveBeenCalled();
});
