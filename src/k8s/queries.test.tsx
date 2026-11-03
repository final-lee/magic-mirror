import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { k8sApi } from "./api";
import { closeK8s, k8sKeys, refreshK8s, useK8sContext, useK8sKinds, useK8sMetrics, useK8sObject, useK8sOverview, useK8sRules, useK8sSession } from "./queries";

vi.mock("./api", () => ({ k8sApi: { context: vi.fn(), open: vi.fn(), close: vi.fn(), rules: vi.fn(), kinds: vi.fn(), get: vi.fn(), secretValue: vi.fn(), overview: vi.fn(), metrics: vi.fn(), watch: vi.fn(), unwatch: vi.fn() } }));
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

const DEPLOY = { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true };

test("K2 keys live under the target and include the context", () => {
  const ref = { kind: DEPLOY, namespace: "web", name: "api" };
  expect(k8sKeys.kinds(T, "ctx")).toEqual(["k8s", "app|r|prod", "kinds", "ctx"]);
  expect(k8sKeys.object(T, "ctx", ref, "7")).toEqual(["k8s", "app|r|prod", "object", "ctx", "apps/v1/deployments", "web", "api", "7"]);
  expect(k8sKeys.overview(T, "ctx")).toEqual(["k8s", "app|r|prod", "overview", "ctx"]);
});

test("useK8sObject reads once per resourceVersion and waits for enabled", async () => {
  const qc = client();
  api.get.mockResolvedValue({ yaml: "a" } as never);
  const ref = { kind: DEPLOY, namespace: "web", name: "api" };
  const { rerender } = renderHook(({ rv, on }) => useK8sObject(T, "ctx", ref, rv, "p", on), { wrapper: wrap(qc), initialProps: { rv: "1", on: false } });
  expect(api.get).not.toHaveBeenCalled();
  rerender({ rv: "1", on: true });
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
  expect(api.get).toHaveBeenCalledWith(T, DEPLOY, "web", "api", "p");
  rerender({ rv: "2", on: true });
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
});

test("useK8sKinds and useK8sOverview need a context and enabled", async () => {
  const qc = client();
  api.kinds.mockResolvedValue([]);
  api.overview.mockResolvedValue({ gaps: [] } as never);
  renderHook(() => useK8sKinds(T, null, "p", true), { wrapper: wrap(qc) });
  renderHook(() => useK8sOverview(T, "ctx", "p", false), { wrapper: wrap(qc) });
  await new Promise((r) => setTimeout(r, 0));
  expect(api.kinds).not.toHaveBeenCalled();
  expect(api.overview).not.toHaveBeenCalled();
  const k = renderHook(() => useK8sKinds(T, "ctx", "p", true), { wrapper: wrap(qc) });
  await waitFor(() => expect(k.result.current.isSuccess).toBe(true));
  expect(api.kinds).toHaveBeenCalledWith(T, "p");
});

test("refreshK8s removes K2 data so it is read again on the new connection", async () => {
  const qc = client();
  qc.setQueryData(k8sKeys.kinds(T, "ctx"), []);
  qc.setQueryData(k8sKeys.overview(T, "ctx"), { gaps: [] });
  qc.setQueryData(k8sKeys.object(T, "ctx", { kind: DEPLOY, namespace: "web", name: "api" }, "1"), { yaml: "" });
  await refreshK8s(qc, T, "p");
  expect(qc.getQueryData(k8sKeys.kinds(T, "ctx"))).toBeUndefined();
  expect(qc.getQueryData(k8sKeys.overview(T, "ctx"))).toBeUndefined();
  expect(qc.getQueriesData({ queryKey: [...k8sKeys.root(T), "object"] })).toEqual([]);
});

test("useK8sMetrics polls every 15 s only while enabled, with a key per namespace", async () => {
  const qc = client();
  api.metrics.mockResolvedValue({ podsUnavailable: null, nodesUnavailable: null, pods: [], nodes: [] });
  renderHook(() => useK8sMetrics(T, "ctx", "web", "p", false), { wrapper: wrap(qc) });
  renderHook(() => useK8sMetrics(T, null, "web", "p", true), { wrapper: wrap(qc) });
  await new Promise((r) => setTimeout(r, 0));
  expect(api.metrics).not.toHaveBeenCalled();
  const on = renderHook(() => useK8sMetrics(T, "ctx", "web", "p", true), { wrapper: wrap(qc) });
  await waitFor(() => expect(on.result.current.isSuccess).toBe(true));
  expect(api.metrics).toHaveBeenCalledWith(T, "web", "p");
  const observer = qc.getQueryCache().find({ queryKey: k8sKeys.metrics(T, "ctx", "web") })?.observers[0];
  expect(observer?.options.refetchInterval).toBe(15_000);
  expect(observer?.options.refetchIntervalInBackground).toBe(false);
  expect(k8sKeys.metrics(T, "ctx", "web")).not.toEqual(k8sKeys.metrics(T, "ctx", null));
  expect(k8sKeys.metrics(T, "ctx", null).slice(0, 2)).toEqual(k8sKeys.root(T));
});
