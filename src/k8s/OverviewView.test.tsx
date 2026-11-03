import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/client";
import { onSsoExpired } from "../api/invoke";
import { SsoLoginContext, useSsoLogin, type SsoLogin } from "../lib/useSsoLogin";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { OverviewView } from "./OverviewView";
import {
  CORDONED, METRICS_UNAVAILABLE, NO_METRICS, SEC_NAMESPACE_USAGE, SUB_TOP_CPU, SUB_TOP_MEMORY, NO_SKEW, OFF, ON, REFRESH, REQUESTS_PARTIAL, SECTION_LABELS, SEC_NODEPOOLS, UP_TO_DATE, gapText, noRemoved, removedTitle, skewText,
} from "./text";
import type { K8sMetrics, K8sNodeView, K8sOverview, K8sPodUsage } from "./types";

vi.mock("./api", () => ({ k8sApi: { overview: vi.fn(), metrics: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
const T = { profile: "app", region: "r", cluster: "c" };

const node = (over: Partial<K8sNodeView> = {}): K8sNodeView => ({
  name: "ip-1", ready: true, unschedulable: false, pressures: [], instanceType: "m6i.large", zone: "ap-northeast-2a", groupKind: "managed", group: "ng-1",
  kubeletVersion: "v1.31.4", allocatable: { cpuMilli: 2000, memoryBytes: 8 * 1024 ** 3, pods: 29 }, requested: { cpuMilli: 500, memoryBytes: 2 * 1024 ** 3, pods: 5 }, usage: null, ...over,
});
const overview = (over: Partial<K8sOverview> = {}): K8sOverview => ({
  cluster: { version: "1.31", platformVersion: "eks.12", status: "ACTIVE", endpointPublic: true, endpointPrivate: false, publicCidrs: ["0.0.0.0/0"], logging: [], secretsEncrypted: true, oidcIssuer: null, authenticationMode: "API" },
  nodes: [node()], requestsPartial: false, metrics: false, nodegroups: [], fargateProfiles: [], nodePools: null,
  addons: [{ name: "coredns", version: "v1", latest: "v1", status: "ACTIVE", issues: [] }, { name: "vpc-cni", version: "v1", latest: "v2", status: "ACTIVE", issues: ["X: y"] }],
  insights: [], removedApis: [], nextVersion: "1.32", skew: [], gaps: [], ...over,
});

function setup() {
  const onOpenNode = vi.fn();
  render(withClientAndSso(<OverviewView target={T} context="ctx" ssoProfile="exec" live onOpenNode={onOpenNode} />, newQueryClient(), ssoLoginStub()));
  return { onOpenNode };
}

const noMetrics: K8sMetrics = { podsUnavailable: null, nodesUnavailable: null, pods: [], nodes: [] };
beforeEach(() => {
  vi.clearAllMocks();
  m.metrics.mockResolvedValue(noMetrics);
});

test("cluster, nodes, add-ons and upgrade checks", async () => {
  m.overview.mockResolvedValue(overview({ skew: [{ node: "ip-1", kubeletVersion: "v1.29.0", minorsBehind: 2 }] }));
  const { onOpenNode } = setup();
  expect(await screen.findByText("eks.12")).toBeInTheDocument();
  expect(screen.getByText(ON)).toBeInTheDocument(); // Secret 암호화
  expect(screen.getByText(OFF)).toBeInTheDocument(); // 로깅 없음
  expect(screen.getByText("500m / 2 (25%)")).toBeInTheDocument();
  expect(screen.getByText("2 GiB / 8 GiB (25%)")).toBeInTheDocument();
  expect(screen.getByText(NO_METRICS)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "ip-1" }));
  expect(onOpenNode).toHaveBeenCalledWith("ip-1");
  expect(screen.getByText(UP_TO_DATE)).toBeInTheDocument();
  expect(screen.getByText("v2")).toBeInTheDocument();
  expect(screen.getByText("X: y")).toBeInTheDocument();
  expect(screen.getByText(noRemoved("1.32"))).toBeInTheDocument();
  expect(screen.getByText(skewText(2), { exact: false })).toBeInTheDocument();
  expect(screen.queryByText(SEC_NODEPOOLS)).toBeNull();
  expect(m.overview).toHaveBeenCalledWith(T);
});

test("cordon, pressure, usage, partial requests, node pools, removed APIs, no skew", async () => {
  m.overview.mockResolvedValue(
    overview({
      nodes: [node({ unschedulable: true, pressures: ["MemoryPressure"], usage: { cpuMilli: 1000, memoryBytes: 1024 ** 3 } })],
      metrics: true, requestsPartial: true, nodePools: ["default"],
      removedApis: [{ kind: "FlowSchema", apiVersion: "flowcontrol.apiserver.k8s.io/v1beta3", replacement: "flowcontrol.apiserver.k8s.io/v1", removedIn: "1.32", namespace: null, name: "fs" }],
    }),
  );
  setup();
  expect(await screen.findByText(`Ready · ${CORDONED} · MemoryPressure`)).toBeInTheDocument();
  expect(screen.getByText("1 / 2 (50%)")).toBeInTheDocument();
  expect(screen.queryByText(NO_METRICS)).toBeNull();
  expect(screen.getByText(REQUESTS_PARTIAL)).toBeInTheDocument();
  expect(screen.getByText(SEC_NODEPOOLS)).toBeInTheDocument();
  expect(screen.getByText("default")).toBeInTheDocument();
  expect(screen.getByText(removedTitle("1.32"))).toBeInTheDocument();
  expect(screen.getByText("flowcontrol.apiserver.k8s.io/v1beta3")).toBeInTheDocument();
  expect(screen.getByText(NO_SKEW)).toBeInTheDocument();
});

test.each(["cluster", "nodes"] as const)("does not claim no skew when %s is unavailable", async (section) => {
  m.overview.mockResolvedValue(overview({
    [section]: null,
    skew: [],
    gaps: [{ section, error: { kind: "accessDenied", action: "read" } }],
  }));
  setup();
  expect(await screen.findByText(gapText(SECTION_LABELS[section]))).toBeInTheDocument();
  expect(screen.getByText(UP_TO_DATE)).toBeInTheDocument();
  expect(screen.queryByText(NO_SKEW)).toBeNull();
});

test("gaps show next to their section and refresh refetches", async () => {
  m.overview.mockResolvedValue(overview({ addons: null, gaps: [{ section: "addons", error: { kind: "accessDenied", action: "eks:ListAddons" } }] }));
  setup();
  expect(await screen.findByText(gapText(SECTION_LABELS.addons))).toBeInTheDocument();
  expect(screen.getByText("권한 없음 (eks:ListAddons)")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: REFRESH }));
  await vi.waitFor(() => expect(m.overview).toHaveBeenCalledTimes(2));
});

test("a failed overview shows the error", async () => {
  m.overview.mockRejectedValue({ kind: "other", message: "먼저 연결해 주세요" });
  setup();
  expect(await screen.findByText("먼저 연결해 주세요")).toBeInTheDocument();
});

test.each([
  ["cluster", "app"], ["nodegroups", "app"], ["fargate", "app"],
  ["addons", "app"], ["insights", "app"], ["nodes", "exec"],
  ["metrics", "exec"], ["nodePools", "exec"], ["removedApis", "exec"],
] as const)("managed SSO retries the %s gap using %s", async (section, profile) => {
  m.overview.mockResolvedValueOnce(overview({ gaps: [{ section, error: { kind: "ssoExpired" } }] }))
    .mockResolvedValueOnce(overview());
  const qc = newQueryClient();
  const manager = ssoLoginStub();
  const at = Date.now() + 1000;
  const ui = (successProfile: string | null) => withClientAndSso(
    <OverviewView target={T} context="ctx" ssoProfile="exec" live onOpenNode={vi.fn()} />,
    qc, { ...manager, lastSuccessAt: (p) => p === successProfile ? at : null },
  );
  const rendered = render(ui(null));
  expect(await screen.findByText(`SSO 세션이 만료됐어요 (${profile})`)).toBeInTheDocument();
  rendered.rerender(ui(profile === "app" ? "exec" : "app"));
  expect(m.overview).toHaveBeenCalledTimes(1);
  rendered.rerender(ui(profile));
  await vi.waitFor(() => expect(m.overview).toHaveBeenCalledTimes(2));
});

test("managed SSO retries a failed overview with the app profile", async () => {
  m.overview.mockRejectedValueOnce({ kind: "ssoExpired" }).mockResolvedValueOnce(overview());
  const qc = newQueryClient();
  const manager = ssoLoginStub();
  const at = Date.now() + 1000;
  const ui = (successProfile: string | null) => withClientAndSso(
    <OverviewView target={T} context="ctx" ssoProfile="exec" live onOpenNode={vi.fn()} />,
    qc, { ...manager, lastSuccessAt: (p) => p === successProfile ? at : null },
  );
  const rendered = render(ui(null));
  await screen.findByText("SSO 세션이 만료됐어요 (app)");
  rendered.rerender(ui("exec"));
  expect(m.overview).toHaveBeenCalledTimes(1);
  rendered.rerender(ui("app"));
  await vi.waitFor(() => expect(m.overview).toHaveBeenCalledTimes(2));
});

test.each([
  ["cluster", "app"], ["nodegroups", "app"], ["fargate", "app"], ["addons", "app"], ["insights", "app"],
  ["nodes", "exec"], ["metrics", "exec"], ["nodePools", "exec"], ["removedApis", "exec"],
] as const)("an SSO-expired %s gap reports %s to the login manager", async (section, profile) => {
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  m.overview.mockResolvedValue(overview({ gaps: [{ section, error: { kind: "ssoExpired" } }] }));
  setup();
  await screen.findByText(`SSO 세션이 만료됐어요 (${profile})`);
  expect(seen).toEqual([profile]);
  off();
});

test("SSO-expired gaps are reported once per profile and once per new response", async () => {
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  const expired = (section: "cluster" | "addons" | "nodes") => ({ section, error: { kind: "ssoExpired" } as const });
  m.overview.mockResolvedValueOnce(overview({ gaps: [expired("cluster"), expired("addons"), expired("nodes")] })).mockResolvedValueOnce(overview({ gaps: [expired("addons")] }));
  setup();
  await screen.findAllByText("SSO 세션이 만료됐어요 (app)");
  expect(seen.sort()).toEqual(["app", "exec"]);
  fireEvent.click(screen.getByRole("button", { name: REFRESH }));
  await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(seen.sort()).toEqual(["app", "app", "exec"]));
  off();
});

test("other gaps are not reported as SSO expiry", async () => {
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  m.overview.mockResolvedValue(overview({ addons: null, gaps: [{ section: "addons", error: { kind: "accessDenied", action: "eks:ListAddons" } }] }));
  setup();
  await screen.findByText("권한 없음 (eks:ListAddons)");
  expect(seen).toEqual([]);
  off();
});

test("an unreadable metrics API is not shown as a missing metrics-server", async () => {
  m.overview.mockResolvedValue(overview({ metrics: false, gaps: [{ section: "metrics", error: { kind: "network", message: "timeout" } }] }));
  setup();
  await screen.findByText(gapText(SECTION_LABELS.metrics));
  expect(screen.queryByText(NO_METRICS)).toBeNull();
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("SSO-expired gaps and the login manager", () => {
  const PROFILES = [{ name: "app", region: null, ssoLogin: "app", ssoKey: "session:app" }];
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const expiredAddons = () => overview({ addons: null, gaps: [{ section: "addons", error: { kind: "ssoExpired" } }] });

  function harness() {
    const qc = newQueryClient();
    const sso = { current: null as unknown as SsoLogin };
    const Manager = ({ show }: { show: boolean }) => {
      sso.current = useSsoLogin(PROFILES, "app");
      return (
        <SsoLoginContext.Provider value={sso.current}>
          {show && <OverviewView target={T} context="ctx" ssoProfile="exec" live onOpenNode={vi.fn()} />}
        </SsoLoginContext.Provider>
      );
    };
    const ui = (show: boolean) => <QueryClientProvider client={qc}><Manager show={show} /></QueryClientProvider>;
    return { sso, ...render(ui(true)), ui };
  }

  test("a cached response shown again after the login is not reported again", async () => {
    const login = deferred();
    vi.mocked(api.ssoLogin).mockReturnValue(login.promise);
    m.overview.mockResolvedValue(expiredAddons());
    const h = harness();
    await waitFor(() => expect(h.sso.current.entries[0]?.status.kind).toBe("running"));
    h.rerender(h.ui(false)); // 로그인 중에 다른 화면으로
    await act(async () => login.resolve());
    await waitFor(() => expect(h.sso.current.entries).toEqual([]));
    h.rerender(h.ui(true)); // 60초 안에 돌아옴: 캐시된 만료 응답
    await screen.findByText("SSO 세션이 만료됐어요 (app)");
    await wait(20);
    expect(m.overview).toHaveBeenCalledTimes(1);
    expect(h.sso.current.entries).toEqual([]);
    expect(api.ssoLogin).toHaveBeenCalledTimes(1);
  });

  test("an expiry response that finishes after the login, for a request started before it, is ignored", async () => {
    vi.mocked(api.ssoLogin).mockResolvedValue(undefined as never);
    const response = deferred<K8sOverview>();
    m.overview.mockReturnValue(response.promise);
    const h = harness();
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(1));
    await wait(10);
    await act(async () => void (await h.sso.current.start("app", { manual: true })));
    await wait(10);
    await act(async () => response.resolve(expiredAddons()));
    await screen.findByText("SSO 세션이 만료됐어요 (app)");
    expect(h.sso.current.entries).toEqual([]);
    expect(api.ssoLogin).toHaveBeenCalledTimes(1);
  });

  test("a new request started after the login that is still expired is reported", async () => {
    const login = deferred();
    vi.mocked(api.ssoLogin).mockReturnValue(login.promise);
    // 실제 요청처럼 시간이 걸려서, 로그인 흐름이 끝난 뒤에 응답이 온다
    m.overview.mockImplementation(async () => { await wait(30); return expiredAddons(); });
    const h = harness();
    await screen.findByText("SSO 세션이 만료됐어요 (app)");
    await waitFor(() => expect(h.sso.current.entries[0]?.status.kind).toBe("running"));
    await act(async () => login.resolve());
    // 로그인 뒤 ErrorState의 onLoggedIn이 새 요청을 보내고, 그 요청도 만료로 끝난다
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(h.sso.current.entries[0]?.status).toMatchObject({ kind: "failed", afterSuccess: true }));
    expect(api.ssoLogin).toHaveBeenCalledTimes(1);
  });
});

const podUsage = (namespace: string, name: string, cpuMilli: number, memoryBytes: number): K8sPodUsage => ({ namespace, name, cpuMilli, memoryBytes, containers: [], owners: [] });

test("namespace usage: top by cpu and by memory, summed over pods, read for all namespaces", async () => {
  m.overview.mockResolvedValue(overview({ metrics: true }));
  m.metrics.mockResolvedValue({ ...noMetrics, pods: [
    podUsage("web", "a", 300, 100 * 1024 ** 2), podUsage("web", "b", 200, 100 * 1024 ** 2), podUsage("db", "c", 400, 2 * 1024 ** 3), podUsage("ops", "d", 50, 1024 ** 2),
  ] });
  setup();
  const cpu = await screen.findByRole("table", { name: SUB_TOP_CPU });
  expect(screen.getByText(SEC_NAMESPACE_USAGE)).toBeInTheDocument();
  expect(m.metrics).toHaveBeenCalledWith(T, null, "exec");
  const body = (t: HTMLElement) => within(t).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
  // CPU 순: web 500m(Pod 2), db 400m, ops 50m
  expect(body(cpu)).toEqual([["web", "500m", "200 MiB", "2"], ["db", "400m", "2 GiB", "1"], ["ops", "50m", "1 MiB", "1"]]);
  // 메모리 순: db, web, ops
  expect(body(screen.getByRole("table", { name: SUB_TOP_MEMORY })).map((r) => r[0])).toEqual(["db", "web", "ops"]);
});

test("namespace usage is limited to the top 10 namespaces", async () => {
  m.overview.mockResolvedValue(overview({ metrics: true }));
  m.metrics.mockResolvedValue({ ...noMetrics, pods: Array.from({ length: 12 }, (_, i) => podUsage(`ns${String(i).padStart(2, "0")}`, "p", 100 + i, 1024)) });
  setup();
  const cpu = await screen.findByRole("table", { name: SUB_TOP_CPU });
  expect(within(cpu).getAllByRole("row")).toHaveLength(11);
  expect(within(cpu).queryByText("ns00")).toBeNull();
});

test("without metrics-server there is one hint and no usage tables", async () => {
  m.overview.mockResolvedValue(overview({ metrics: false }));
  m.metrics.mockResolvedValue({ ...noMetrics, podsUnavailable: "notInstalled", nodesUnavailable: "notInstalled" });
  setup();
  expect(await screen.findByText(NO_METRICS)).toBeInTheDocument();
  await vi.waitFor(() => expect(m.metrics).toHaveBeenCalled());
  expect(screen.queryByText(SEC_NAMESPACE_USAGE)).toBeNull();
  expect(screen.queryByText(METRICS_UNAVAILABLE.notInstalled)).toBeNull();
  expect(screen.queryByRole("table", { name: SUB_TOP_CPU })).toBeNull();
});

test("forbidden pod metrics with readable node metrics explains itself in the usage section", async () => {
  m.overview.mockResolvedValue(overview({ metrics: true }));
  m.metrics.mockResolvedValue({ ...noMetrics, podsUnavailable: "forbidden" });
  setup();
  expect(await screen.findByText(METRICS_UNAVAILABLE.forbidden)).toBeInTheDocument();
  expect(screen.queryByRole("table", { name: SUB_TOP_CPU })).toBeNull();
});

test("a tab that is not visible does not read usage", async () => {
  m.overview.mockResolvedValue(overview({ metrics: true }));
  render(withClientAndSso(<OverviewView target={T} context="ctx" ssoProfile="exec" live visible={false} onOpenNode={vi.fn()} />, newQueryClient(), ssoLoginStub()));
  expect(await screen.findByText("eks.12")).toBeInTheDocument();
  expect(m.metrics).not.toHaveBeenCalled();
});
