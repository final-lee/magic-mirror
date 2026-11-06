import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderWithClient } from "../test/utils";
import { argocdApi } from "./api";
import { ArgoDetail } from "./ArgoDetail";
import { changeApi } from "./change/api";
import {
  ARGO_HARD_REFRESH, ARGO_NO_HISTORY, ARGO_NO_OPERATION, ARGO_REFRESH, ARGO_SYNC,
  ARGO_SYNC_RUNNING, ARGO_TREE_LABEL, CLOSE, SEC_ARGO_CONDITIONS, SEC_ARGO_DEST, SEC_ARGO_FAILED, SEC_ARGO_OPERATION,
  SEC_ARGO_SOURCES, TAB_ARGO_HISTORY, TAB_ARGO_RAW, TAB_ARGO_RESOURCES, TOKEN_INVALID, argoRefreshPending,
} from "./text";
import type { ArgoApp, ArgoHistoryEntry, ArgoTreeNode } from "./types";
import { readApi } from "./detail/api";
import { HIST_SERVER } from "./detail/text";
import { TAB_ARGO_MANAGE } from "./manage/text";
import { MANAGE_TARGET_REVISION } from "./manage/text";

vi.mock("./api", () => ({ argocdApi: { app: vi.fn(), tree: vi.fn(), events: vi.fn() } }));
vi.mock("./ops/api", () => ({ opsApi: { appActions: vi.fn().mockResolvedValue([]), resourceActions: vi.fn().mockResolvedValue([]), kubeContexts: vi.fn().mockResolvedValue([]) } }));
vi.mock("./change/api", () => ({ changeApi: { can: vi.fn(), preview: vi.fn(), apply: vi.fn() } }));
vi.mock("./detail/api", () => ({ readApi: { appLinks: vi.fn(), syncWindows: vi.fn(), history: vi.fn(), manifestsDiff: vi.fn() } }));
const m = vi.mocked(argocdApi);
const changes = vi.mocked(changeApi);
const read = vi.mocked(readApi);
const URL = "https://argocd.example";
const NOW = Date.parse("2026-10-30T12:00:00Z");
const SHA = "0123456789abcdef0123456789abcdef01234567";

const app = (over: Partial<ArgoApp> = {}): ArgoApp => ({
  name: "web",
  namespace: "argocd",
  project: "prod",
  destination: { server: "https://kubernetes.default.svc", name: null, namespace: "web", inCluster: true },
  sources: [
    { repoUrl: "https://git.example.com/charts.git", path: null, chart: "web-chart", targetRevision: "1.2.x", ref: null, helmValueFiles: ["$values/prod/web.yaml"] },
    { repoUrl: "https://git.example.com/values.git", path: null, chart: null, targetRevision: "main", ref: "values", helmValueFiles: [] },
  ],
  syncPolicy: { automated: true, prune: false, selfHeal: true, options: ["CreateNamespace=true"] },
  syncStatus: "OutOfSync",
  syncRevisions: [SHA, "1.2.3"],
  health: "Degraded",
  healthMessage: "pods are crashing",
  images: ["nginx:1.27"],
  conditions: [{ type: "ComparisonError", message: "line one\nline two of the failure", lastTransitionTime: "2026-10-30T11:00:00Z" }],
  operation: {
    phase: "Failed",
    message: "one or more objects failed to apply",
    startedAt: "2026-10-30T11:30:00Z",
    finishedAt: "2026-10-30T11:31:00Z",
    initiatedBy: "alice",
    revisions: [SHA],
    retryCount: 0, retryLimit: null, dryRun: false, prune: false, syncOptions: [], results: [],
    failedResults: [{ group: "apps", version: "v1", kind: "Deployment", namespace: "web", name: "web", status: "SyncFailed", message: "immutable field", hookPhase: null, hookType: null, syncPhase: null }],
  },
  resources: [
    { group: "apps", version: "v1", kind: "Deployment", namespace: "web", name: "web", status: "OutOfSync", hook: false, requiresPruning: false },
    { group: "", version: "v1", kind: "Service", namespace: "web", name: "web-svc", status: "Synced", hook: false, requiresPruning: true },
    { group: "batch", version: "v1", kind: "Job", namespace: "web", name: "migrate", status: "Synced", hook: true, requiresPruning: false },
  ],
  history: [
    { id: 7, revisions: [SHA], deployedAt: "2026-10-30T10:00:00Z", deployStartedAt: "2026-10-30T09:59:00Z", initiatedBy: "automated" },
    { id: 6, revisions: ["1.2.2"], deployedAt: "2026-10-29T10:00:00Z", deployStartedAt: null, initiatedBy: "bob" },
  ],
  appSet: "web-set",
  reconciledAt: "2026-10-30T11:59:00Z",
  refreshRequested: null,
  operationInProgress: false,
  raw: { kind: "Application", metadata: { name: "web" }, spec: { project: "prod" } },
  ...over,
});
const node = (uid: string, kind: string, name: string, over: Partial<ArgoTreeNode> = {}): ArgoTreeNode => ({
  uid, group: kind === "Deployment" || kind === "ReplicaSet" ? "apps" : "", version: "v1", kind, namespace: "web", name,
  parents: [], health: null, healthMessage: null, info: [], images: [], createdAt: null, ...over,
});
const TREE = [
  node("dep", "Deployment", "web", { health: "Degraded", healthMessage: "0/2 ready" }),
  node("rs", "ReplicaSet", "web-abc", { parents: ["dep"], health: "Progressing" }),
  node("pod", "Pod", "web-abc-1", { parents: ["rs"], health: "Healthy", info: ["Status Reason: Running"] }),
];

function setup(props: Partial<Parameters<typeof ArgoDetail>[0]> = {}) {
  const handlers = { onClose: vi.fn(), onTokenError: vi.fn() };
  renderWithClient(<ArgoDetail url={URL} namespace="argocd" name="web" resourceVersion="1" live now={NOW} {...handlers} {...props} />);
  return handlers;
}
const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
const loaded = () => screen.findByText("pods are crashing");

beforeEach(() => {
  vi.resetAllMocks();
  m.app.mockResolvedValue(app());
  m.tree.mockResolvedValue(TREE);
  m.events.mockResolvedValue([]);
  read.appLinks.mockResolvedValue([]);
  read.syncWindows.mockResolvedValue({ canSync: true, active: [], assigned: [] });
  read.history.mockResolvedValue([]);
  changes.can.mockResolvedValue([true, true]);
  changes.preview.mockResolvedValue({ title: "동기화", calls: [], diff: null, impact: [], warnings: [], blocked: null, confirmName: null, expectedVersion: "1" });
  changes.apply.mockResolvedValue({ message: "요청을 보냈어요" });
});

test("management draft survives a status-only resourceVersion update", async () => {
  const document = app({ raw: { metadata: { name: "web", resourceVersion: "1" }, spec: { project: "prod", source: { repoURL: "https://git.example", targetRevision: "main" } } } });
  m.app.mockResolvedValue(document);
  const props = { url: URL, namespace: "argocd", name: "web", live: false, onClose: vi.fn(), onTokenError: vi.fn() };
  const { qc, rerender } = renderWithClient(<ArgoDetail {...props} resourceVersion="1" />);
  await loaded();
  tab(TAB_ARGO_MANAGE);
  const input = await screen.findByLabelText(MANAGE_TARGET_REVISION);
  fireEvent.change(input, { target: { value: "draft" } });
  m.app.mockResolvedValue({ ...document, raw: { ...(document.raw as object), metadata: { name: "web", resourceVersion: "2" } } });
  rerender(<QueryClientProvider client={qc}><ArgoDetail {...props} resourceVersion="2" /></QueryClientProvider>);
  await waitFor(() => expect(m.app).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText(MANAGE_TARGET_REVISION)).toHaveValue("draft");
});

describe("overview", () => {
  test("status, the failed operation with its failed resources, the whole condition text, sources and policy", async () => {
    setup();
    await loaded();
    expect(m.app).toHaveBeenCalledWith(URL, "argocd", "web");
    // 커밋 해시는 7자로
    expect(screen.getAllByText("0123456, 1.2.3").length).toBeGreaterThan(0);
    const cond = screen.getByRole("region", { name: SEC_ARGO_CONDITIONS });
    expect(within(cond).getByText("ComparisonError")).toBeInTheDocument();
    expect(within(cond).getByText(/line one\s+line two of the failure/)).toBeInTheDocument();
    expect(cond.querySelector(".argo-cond")).toHaveClass("argo-cond-err");
    const op = screen.getByRole("region", { name: SEC_ARGO_OPERATION });
    expect(within(op).getByText("Failed")).toHaveClass("argo-bad");
    expect(within(op).getByText("one or more objects failed to apply")).toBeInTheDocument();
    expect(within(op).getByText("alice")).toBeInTheDocument();
    const failed = within(op).getByRole("region", { name: SEC_ARGO_FAILED });
    expect(within(failed).getByText("Deployment/web/web")).toBeInTheDocument();
    expect(within(failed).getByText("SyncFailed")).toBeInTheDocument();
    expect(within(failed).getByText("immutable field")).toBeInTheDocument();
    expect(screen.getByText("OutOfSync")).toHaveClass("argo-warn");
    expect(screen.getByText("Degraded")).toHaveClass("argo-bad");
    expect(screen.getByText("web-set")).toBeInTheDocument();
    expect(screen.getByText("CreateNamespace=true")).toBeInTheDocument();
    expect(screen.getByText("nginx:1.27")).toBeInTheDocument();
  });

  test("every source is listed with its chart, target revision, ref and values files", async () => {
    setup();
    await loaded();
    const sources = screen.getByRole("region", { name: SEC_ARGO_SOURCES });
    expect(within(sources).getByText("https://git.example.com/charts.git")).toBeInTheDocument();
    expect(within(sources).getByText("https://git.example.com/values.git")).toBeInTheDocument();
    expect(within(sources).getByText("web-chart")).toBeInTheDocument();
    expect(within(sources).getByText("1.2.x")).toBeInTheDocument();
    expect(within(sources).getByText("main")).toBeInTheDocument();
    expect(within(sources).getByText("values")).toBeInTheDocument();
    expect(within(sources).getByText("$values/prod/web.yaml")).toBeInTheDocument();
  });

  test("a target revision that is a commit hash is shown as 7 characters", async () => {
    m.app.mockResolvedValue(app({ sources: [{ repoUrl: "https://git.example.com/a.git", path: "deploy", chart: null, targetRevision: SHA, ref: null, helmValueFiles: [] }] }));
    setup();
    await loaded();
    expect(within(screen.getByRole("region", { name: SEC_ARGO_SOURCES })).getByText("0123456")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: SEC_ARGO_SOURCES })).getByText("deploy")).toBeInTheDocument();
  });

  test("the destination marks the cluster Argo runs in", async () => {
    setup();
    await loaded();
    expect(within(screen.getByRole("region", { name: SEC_ARGO_DEST })).getByText("이 클러스터")).toBeInTheDocument();
  });

  test("a refresh request the controller has not handled yet is noted", async () => {
    m.app.mockResolvedValue(app({ refreshRequested: "hard" }));
    setup();
    expect(await screen.findByText(argoRefreshPending("hard"))).toBeInTheDocument();
  });

  test("without any operation it says there is no record, and no conditions means no condition section", async () => {
    m.app.mockResolvedValue(app({ operation: null, conditions: [] }));
    setup();
    expect(await screen.findByText(ARGO_NO_OPERATION)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: SEC_ARGO_CONDITIONS })).toBeNull();
  });
});

describe("resource tree", () => {
  test("is read only when the tab is opened and nests parent → child with Health and Sync", async () => {
    setup();
    await loaded();
    expect(m.tree).not.toHaveBeenCalled();
    tab(TAB_ARGO_RESOURCES);
    const items = await screen.findAllByRole("treeitem");
    expect(m.tree).toHaveBeenCalledWith(URL, "argocd", "web");
    expect(within(screen.getByRole("tree", { name: ARGO_TREE_LABEL })).getAllByRole("treeitem")).toHaveLength(5);
    expect(items.slice(0, 3).map((i) => [i.getAttribute("aria-level"), i.querySelector(".mono")?.textContent])).toEqual([
      ["1", "web"],
      ["2", "web-abc"],
      ["3", "web-abc-1"],
    ]);
    expect(within(items[0]).getByText("Degraded")).toHaveClass("argo-bad");
    expect(within(items[0]).getByText("OutOfSync")).toHaveClass("argo-warn");
    expect(within(items[0]).getByText("0/2 ready")).toBeInTheDocument();
    expect(within(items[2]).getByText("Status Reason: Running")).toBeInTheDocument();
    // 트리에 없는 리소스(Service, hook Job)는 Sync만 달고 뒤에 붙는다
    expect(within(items[3]).getByText("web-svc")).toBeInTheDocument();
    expect(within(items[3]).getByText("삭제 예정")).toBeInTheDocument();
    expect(within(items[4]).getByText("migrate")).toBeInTheDocument();
    expect(within(items[4]).getByText("hook")).toBeInTheDocument();
  });

  test("a failed tree read shows the error and Retry reads again", async () => {
    m.tree.mockRejectedValueOnce({ kind: "other", message: "tree unavailable" });
    setup();
    await loaded();
    tab(TAB_ARGO_RESOURCES);
    expect(await screen.findByText("tree unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("tree")).toBeInTheDocument();
  });
});

describe("history tab", () => {
  const entry = (id: number, revision: string, over: Partial<ArgoHistoryEntry> = {}): ArgoHistoryEntry => ({
    id, deployedAt: null, deployStartedAt: null, initiatedBy: null,
    revisions: [{ revision, sourceIndex: 0, repoUrl: null, chart: null, path: null, targetRevision: null, metadata: null, chartDetails: null, oci: null }], ...over,
  });

  test("lists every deployment the server kept with short revisions, ages and who asked", async () => {
    read.history.mockResolvedValue([entry(7, SHA, { deployedAt: "2026-10-30T10:00:00Z", initiatedBy: "automated" }), entry(6, "1.2.2", { deployedAt: "2026-10-29T10:00:00Z", initiatedBy: "bob" })]);
    setup();
    await loaded();
    tab(TAB_ARGO_HISTORY);
    expect(read.history).toHaveBeenCalledWith(URL, "argocd", "web");
    const table = await screen.findByRole("table", { name: HIST_SERVER });
    const rows = within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").slice(1).map((c) => c.textContent));
    expect(rows).toEqual([
      ["7", "0123456", "2h", "자동", "롤백…"],
      ["6", "1.2.2", "26h", "bob", "롤백…"],
    ]);
  });

  test("an app without history says so", async () => {
    read.history.mockResolvedValue([]);
    setup();
    await loaded();
    tab(TAB_ARGO_HISTORY);
    expect(await screen.findByText(ARGO_NO_HISTORY)).toBeInTheDocument();
  });
});

test("the YAML/JSON tab shows the whole Application, JSON with 2-space indent", async () => {
  setup();
  await loaded();
  tab(TAB_ARGO_RAW);
  const pre = document.querySelector("pre.argo-raw") as HTMLElement;
  expect(pre.textContent).toBe(JSON.stringify({ kind: "Application", metadata: { name: "web" }, spec: { project: "prod" } }, null, 2));
  expect(pre.textContent).toContain('\n  "kind": "Application"');
});

test("권한이 없으면 새로고침과 동기화를 막아요", async () => {
  changes.can.mockResolvedValue([false, false]);
  setup(); await loaded();
  await waitFor(() => expect(screen.getByRole("button", { name: ARGO_REFRESH })).toBeDisabled());
  expect(screen.getByRole("button", { name: ARGO_SYNC })).toBeDisabled();
});

test("새로고침은 미리 보기 없이 실행해요", async () => {
  setup(); await loaded();
  await waitFor(() => expect(screen.getByRole("button", { name: ARGO_HARD_REFRESH })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: ARGO_HARD_REFRESH }));
  await screen.findByText("요청을 보냈어요");
  expect(changes.apply).toHaveBeenCalledWith(URL, expect.objectContaining({ name: "web" }), { kind: "refresh", hard: true }, null, null);
  expect(changes.preview).not.toHaveBeenCalled();
});

test("작업 중에는 동기화를 막아요", async () => {
  m.app.mockResolvedValue(app({ operationInProgress: true }));
  setup(); await loaded();
  expect(screen.getByRole("button", { name: ARGO_SYNC })).toHaveAttribute("title", ARGO_SYNC_RUNNING);
});

describe("reading the app", () => {
  test("the action bar sits under the header on every tab and each action exists exactly once", async () => {
    setup();
    await loaded();
    for (const name of [TAB_ARGO_RESOURCES, TAB_ARGO_HISTORY, TAB_ARGO_RAW]) {
      tab(name);
      expect(screen.getByRole("toolbar", { name: "앱 작업" })).toBeInTheDocument();
      for (const label of [ARGO_SYNC, ARGO_REFRESH, ARGO_HARD_REFRESH]) expect(screen.getAllByRole("button", { name: label })).toHaveLength(1);
    }
    expect(within(screen.getByRole("toolbar", { name: "앱 작업" })).getAllByRole("button", { name: ARGO_SYNC })).toHaveLength(1);
  });

  test("a failed read shows the error, keeps Sync off, and closing still works", async () => {
    m.app.mockRejectedValue({ kind: "other", message: "application not found" });
    const h = setup();
    expect(await screen.findByText("application not found")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ARGO_SYNC })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: CLOSE }));
    expect(h.onClose).toHaveBeenCalled();
    expect(h.onTokenError).not.toHaveBeenCalled();
  });

  test("a token error from the read is reported with its message", async () => {
    m.app.mockRejectedValue({ kind: "other", message: TOKEN_INVALID });
    const h = setup();
    await waitFor(() => expect(h.onTokenError).toHaveBeenCalledWith(TOKEN_INVALID));
  });

  test("a token error from the tree is reported too", async () => {
    m.tree.mockRejectedValue({ kind: "other", message: TOKEN_INVALID });
    const h = setup();
    await loaded();
    tab(TAB_ARGO_RESOURCES);
    await waitFor(() => expect(h.onTokenError).toHaveBeenCalledWith(TOKEN_INVALID));
  });
});

test("the header names the app and covers the given share of the list", async () => {
  setup({ widthPct: 55 });
  const aside = screen.getByRole("complementary", { name: "Application 상세" });
  expect(aside).toHaveTextContent("argocd/web");
  expect(aside).toHaveStyle({ width: "55%" });
  await loaded();
});
