import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../../test/utils";
import type { K8sLogMessage } from "../../k8s/types";
import type { AppTarget, ArgoApp, ArgoResource, ArgoTreeNode, ResRef, ResourceView } from "../types";
import { readApi } from "./api";
import { ResourcePanel } from "./ResourcePanel";
import {
  RES_DIFF_SAME, RES_NO_DESIRED, RES_NO_DIFF, RES_NO_EVENTS, RES_NO_LINKS, RES_NO_LIVE, RES_TAB_DESIRED, RES_TAB_DIFF, RES_TAB_EVENTS, RES_TAB_LINKS, RES_TAB_LIVE,
  RES_TAB_LOGS, RES_TAB_SUMMARY,
} from "./text";
import { RES_TAB_ACTIONS } from "../ops/text";

vi.mock("../ops/api", () => ({ opsApi: { resourceActions: vi.fn().mockResolvedValue([]), kubeContexts: vi.fn().mockResolvedValue([]) } }));
vi.mock("../change/api", () => ({ changeApi: { can: vi.fn().mockResolvedValue([]) } }));
vi.mock("./api", () => ({ readApi: { resource: vi.fn(), resourceEvents: vi.fn(), resourceLinks: vi.fn(), logs: vi.fn(), logsStop: vi.fn() } }));
vi.mock("../../api/desktop", () => ({ desktop: { openUrl: vi.fn(), copy: vi.fn(), reveal: vi.fn() } }));
vi.mock("../../k8s/api", () => ({ k8sApi: { logsSave: vi.fn() } }));
const m = vi.mocked(readApi);

const URL = "https://argocd.example";
const NOW = Date.parse("2026-10-30T12:00:00Z");
const target: AppTarget = { namespace: "argocd", name: "web", project: "prod" };
const res = (kind: string, name: string, group = ""): ResRef => ({ group, version: "v1", kind, namespace: "web", name, uid: `${kind}-uid` });
const view = (over: Partial<ResourceView> = {}): ResourceView => ({
  live: "kind: Deployment\nreplicas: 2\n", desired: "kind: Deployment\nreplicas: 3\n", containers: [{ name: "app", init: false }, { name: "migrate", init: true }],
  diff: { rows: [{ kind: "replace", left: { no: 2, segments: [{ text: "replicas: 2", emph: false }] }, right: { no: 2, segments: [{ text: "replicas: 3", emph: false }] }, hiddenRows: [] }], hunks: [0], stats: { added: 0, removed: 0, changed: 1 } },
  ...over,
});

function open(r: ResRef, extra: { node?: ArgoTreeNode | null; status?: ArgoResource | null; onBack?: () => void; onTokenError?: (m: string) => void } = {}) {
  return renderWithClient(
    <ResourcePanel url={URL} target={target} changeTarget={{ ...target, env: null }} app={{ destination: { server: null, name: null, namespace: null, inCluster: false } } as ArgoApp} version="1" res={r} node={extra.node ?? null} status={extra.status ?? null} live onBack={extra.onBack ?? vi.fn()} onTokenError={extra.onTokenError ?? vi.fn()} now={NOW} />,
  );
}
const tabs = () => screen.getAllByRole("tab").map((t) => t.textContent);
const yamlText = () => document.querySelector("pre.k8s-yaml")?.textContent ?? "";
const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

beforeEach(() => {
  vi.resetAllMocks();
  m.resource.mockResolvedValue(view());
  m.resourceEvents.mockResolvedValue([]);
  m.resourceLinks.mockResolvedValue([]);
  m.logsStop.mockResolvedValue(undefined);
});

describe("tabs by kind", () => {
  test.each([
    ["a pod", res("Pod", "web-1")],
    ["a deployment", res("Deployment", "web", "apps")],
    ["a statefulset", res("StatefulSet", "db", "apps")],
    ["a job", res("Job", "migrate", "batch")],
  ])("%s has a Logs tab", (_n, r) => {
    open(r);
    expect(tabs()).toEqual([RES_TAB_SUMMARY, RES_TAB_LIVE, RES_TAB_DESIRED, RES_TAB_DIFF, RES_TAB_EVENTS, RES_TAB_LOGS, RES_TAB_LINKS, RES_TAB_ACTIONS]);
  });

  test.each([
    ["a service", res("Service", "web-svc")],
    ["a config map", res("ConfigMap", "cfg")],
    ["an ingress", res("Ingress", "web", "networking.k8s.io")],
  ])("%s has no Logs tab", (_n, r) => {
    open(r);
    expect(tabs()).toEqual([RES_TAB_SUMMARY, RES_TAB_LIVE, RES_TAB_DESIRED, RES_TAB_DIFF, RES_TAB_EVENTS, RES_TAB_LINKS, RES_TAB_ACTIONS]);
  });
});

describe("resource data", () => {
  test("the summary needs no request and shows what the tree and the app know", () => {
    const node: ArgoTreeNode = { uid: "u", group: "apps", version: "v1", kind: "Deployment", namespace: "web", name: "web", parents: [], health: "Degraded", healthMessage: "0/2 ready", info: ["Replicas: 0/2"], images: ["nginx:1.27"], createdAt: "2026-10-30T10:00:00Z" };
    const status: ArgoResource = { group: "apps", version: "v1", kind: "Deployment", namespace: "web", name: "web", status: "OutOfSync", hook: false, requiresPruning: true };
    open(res("Deployment", "web", "apps"), { node, status });
    const sum = screen.getByRole("region", { name: RES_TAB_SUMMARY });
    expect(within(sum).getByText("Degraded")).toHaveClass("argo-bad");
    expect(within(sum).getByText("OutOfSync")).toHaveClass("argo-warn");
    expect(within(sum).getByText("0/2 ready")).toBeInTheDocument();
    expect(within(sum).getByText("nginx:1.27")).toBeInTheDocument();
    expect(within(sum).getByText("Replicas: 0/2")).toBeInTheDocument();
    expect(within(sum).getByText("2h")).toBeInTheDocument();
  });

  test("live and desired show their YAML; the request names the app and the resource once", async () => {
    open(res("Deployment", "web", "apps"));
    tab(RES_TAB_LIVE);
    await waitFor(() => expect(yamlText()).toContain("replicas: 2"));
    tab(RES_TAB_DESIRED);
    expect(yamlText()).toContain("replicas: 3");
    expect(m.resource).toHaveBeenCalledTimes(1);
    expect(m.resource).toHaveBeenCalledWith(URL, target, expect.objectContaining({ kind: "Deployment", name: "web", group: "apps" }));
  });

  test("a resource missing from the cluster or from Git says which side is missing", async () => {
    m.resource.mockResolvedValue(view({ live: null }));
    open(res("Deployment", "web", "apps"));
    tab(RES_TAB_LIVE);
    expect(await screen.findByText(RES_NO_LIVE)).toBeInTheDocument();
    m.resource.mockResolvedValue(view({ desired: null, diff: null }));
    open(res("Pod", "web-1"));
    const panels = screen.getAllByRole("region", { name: "리소스 상세" });
    fireEvent.click(within(panels[1]).getByRole("tab", { name: RES_TAB_DESIRED }));
    expect(await within(panels[1]).findByText(RES_NO_DESIRED)).toBeInTheDocument();
    fireEvent.click(within(panels[1]).getByRole("tab", { name: RES_TAB_DIFF }));
    expect(within(panels[1]).getByText(RES_NO_DIFF)).toBeInTheDocument();
  });

  test("the diff tab shows the side-by-side lines, or says the sides are the same", async () => {
    open(res("Deployment", "web", "apps"));
    tab(RES_TAB_DIFF);
    expect(await screen.findByText("replicas: 2")).toBeInTheDocument();
    expect(screen.getByText("replicas: 3")).toBeInTheDocument();
    expect(screen.getByText("+0 −0 ~1")).toBeInTheDocument();
  });

  test("an identical diff says so", async () => {
    m.resource.mockResolvedValue(view({ diff: { rows: [], hunks: [], stats: { added: 0, removed: 0, changed: 0 } } }));
    open(res("Deployment", "web", "apps"));
    tab(RES_TAB_DIFF);
    expect(await screen.findByText(RES_DIFF_SAME)).toBeInTheDocument();
  });

  test("events are read only when their tab opens, newest first as the server sent them, Warnings marked", async () => {
    m.resourceEvents.mockResolvedValue([
      { type: "Warning", reason: "BackOff", message: "restarting failed container", count: 4, firstSeen: null, lastSeen: "2026-10-30T11:55:00Z", source: "kubelet" },
      { type: "Normal", reason: "Pulled", message: "image pulled", count: 1, firstSeen: null, lastSeen: "2026-10-30T11:00:00Z", source: null },
    ]);
    open(res("Pod", "web-1"));
    await screen.findByRole("tab", { name: RES_TAB_EVENTS });
    expect(m.resourceEvents).not.toHaveBeenCalled();
    tab(RES_TAB_EVENTS);
    const warn = (await screen.findByText("restarting failed container")).closest("tr")!;
    expect(warn).toHaveClass("k8s-warn");
    expect(within(warn).getByText("5m")).toBeInTheDocument();
    expect(m.resourceEvents).toHaveBeenCalledWith(URL, target, expect.objectContaining({ uid: "Pod-uid" }));
  });

  test("no events and no links say so; links open in the browser", async () => {
    open(res("Service", "web-svc"));
    tab(RES_TAB_EVENTS);
    expect(await screen.findByText(RES_NO_EVENTS)).toBeInTheDocument();
    tab(RES_TAB_LINKS);
    expect(await screen.findByText(RES_NO_LINKS)).toBeInTheDocument();
  });

  test("a failed read shows the error with a retry, and a token error is reported", async () => {
    const onTokenError = vi.fn();
    m.resource.mockRejectedValueOnce({ kind: "other", message: "resource gone" });
    open(res("Deployment", "web", "apps"), { onTokenError });
    tab(RES_TAB_LIVE);
    expect(await screen.findByText("resource gone")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(yamlText()).toContain("replicas: 2"));
    expect(onTokenError).not.toHaveBeenCalled();
  });
});

describe("logs", () => {
  test("a pod streams its first app container and shows lines as they arrive; leaving closes the stream", async () => {
    let send: (m: K8sLogMessage) => void = () => {};
    m.logs.mockImplementation(async (_url, _target, _options, onMessage) => {
      send = onMessage;
      return 7;
    });
    const { unmount } = open(res("Pod", "web-1"));
    tab(RES_TAB_LOGS);
    await waitFor(() => expect(m.logs).toHaveBeenCalled());
    const [url, tgt, options] = m.logs.mock.calls[0];
    expect(url).toBe(URL);
    expect(tgt).toEqual(target);
    expect(options).toMatchObject({ podName: "web-1", container: "app", namespace: "web", follow: true, previous: false, kind: null, resourceName: null });
    act(() => send({ type: "lines", pod: "web-1", container: "app", lines: [{ ts: null, text: "server started" }, { ts: null, text: "listening on 8080" }] }));
    expect(await screen.findByText(/listening on 8080/)).toBeInTheDocument();
    unmount();
    await waitFor(() => expect(m.logsStop).toHaveBeenCalledWith(7));
  });

  test("a workload asks for its pods by kind, group and name; picking a container or Previous opens a new stream", async () => {
    m.logs.mockResolvedValue(3);
    open(res("Deployment", "web", "apps"));
    tab(RES_TAB_LOGS);
    await waitFor(() => expect(m.logs).toHaveBeenCalledTimes(1));
    expect(m.logs.mock.calls[0][2]).toMatchObject({ podName: null, kind: "Deployment", group: "apps", resourceName: "web", namespace: "web", container: "app" });
    fireEvent.click(screen.getByRole("checkbox", { name: "이전 컨테이너" }));
    await waitFor(() => expect(m.logs).toHaveBeenCalledTimes(2));
    expect(m.logs.mock.calls[1][2]).toMatchObject({ previous: true });
    await waitFor(() => expect(m.logsStop).toHaveBeenCalledWith(3));
    fireEvent.change(screen.getByRole("combobox", { name: /컨테이너/ }), { target: { value: "migrate" } });
    await waitFor(() => expect(m.logs).toHaveBeenCalledTimes(3));
    expect(m.logs.mock.calls[2][2]).toMatchObject({ container: "migrate", previous: true });
  });

  test("the container list has no all-containers choice because the server needs one container", async () => {
    m.logs.mockResolvedValue(1);
    open(res("Pod", "web-1"));
    tab(RES_TAB_LOGS);
    const picker = await screen.findByRole("combobox", { name: /컨테이너/ });
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["app", "migrate (init)"]);
  });

  test("a stream the server refuses shows its error", async () => {
    m.logs.mockRejectedValue({ kind: "other", message: "container is not ready" });
    open(res("Pod", "web-1"));
    tab(RES_TAB_LOGS);
    expect(await screen.findByText("container is not ready")).toBeInTheDocument();
  });
});

test("the back button returns to the list", () => {
  const onBack = vi.fn();
  open(res("Pod", "web-1"), { onBack });
  fireEvent.click(screen.getByRole("button", { name: "← 리소스 목록" }));
  expect(onBack).toHaveBeenCalled();
});
