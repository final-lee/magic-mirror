import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../../test/utils";
import { changeApi } from "../change/api";
import { readApi } from "../detail/api";
import type { ArgoApp, ResRef } from "../types";
import { ActionBar } from "./ActionBar";
import { opsApi } from "./api";
import type { AppActionGroup } from "./types";

vi.mock("./api", () => ({ opsApi: { appActions: vi.fn() } }));
vi.mock("../change/api", () => ({ changeApi: { can: vi.fn() } }));
vi.mock("../detail/api", () => ({ readApi: { history: vi.fn(), manifestsDiff: vi.fn(), appDiff: vi.fn() } }));
const ops = vi.mocked(opsApi);
const change = vi.mocked(changeApi);
const read = vi.mocked(readApi);

const target = { namespace: "argocd", name: "web", project: "default", env: null };
const r = (kind: string, name: string): ResRef => ({ group: "apps", version: "v1", kind, namespace: "web", name, uid: null });
const group = (over: Partial<AppActionGroup> & Pick<AppActionGroup, "kind" | "action" | "resources">): AppActionGroup => ({ group: "apps", displayName: null, params: [], disabledCount: over.resources.filter((x) => x.disabled).length, ...over });
const GROUPS: AppActionGroup[] = [
  group({ kind: "Deployment", action: "restart", resources: [{ res: r("Deployment", "a"), disabled: false }, { res: r("Deployment", "b"), disabled: false }, { res: r("Deployment", "c"), disabled: true }] }),
  group({ kind: "Rollout", action: "pause", resources: [{ res: r("Rollout", "canary"), disabled: false }] }),
  group({ kind: "CronJob", action: "create-job", displayName: "Create Job", params: [{ name: "jobName", value: null, kind: "string", default: "manual" }], resources: [{ res: r("CronJob", "nightly"), disabled: false }] }),
  group({ kind: "Widget", action: "frob", displayName: "Frobnicate", resources: [{ res: r("Widget", "w"), disabled: true }] }),
];
const rev = (revision: string) => ({ revision, sourceIndex: 0, repoUrl: null, chart: null, path: null, targetRevision: null, metadata: null, chartDetails: null, oci: null });
const entry = (id: number, revision: string) => ({ id, deployedAt: null, deployStartedAt: null, initiatedBy: null, revisions: [rev(revision)] });
const app = (over: Partial<ArgoApp> = {}) => ({ name: "web", namespace: "argocd", sources: [{}], resources: [], syncPolicy: { automated: false }, operationInProgress: false, ...over }) as unknown as ArgoApp;

/** allow: 권한 이름 → 허용 여부(없으면 허용) */
function open(over: Partial<ArgoApp> = {}, allow: (action: string) => boolean = () => true) {
  change.can.mockImplementation(async (_u, checks) => checks.map((c) => allow(c.action)));
  const handlers = { onRefresh: vi.fn(), onChange: vi.fn() };
  renderWithClient(<ActionBar url="https://argocd.example" app={app(over)} target={target} version="1" pending={false} {...handlers} />);
  return handlers;
}
const button = (name: string | RegExp) => screen.findByRole("button", { name });

beforeEach(() => {
  vi.resetAllMocks();
  ops.appActions.mockResolvedValue(GROUPS);
  read.history.mockResolvedValue([entry(7, "new"), entry(6, "prev"), entry(5, "old")]);
  read.manifestsDiff.mockResolvedValue({ rows: [], hunks: [], stats: { added: 0, removed: 0, changed: 0 } });
});

test("workload actions show one button per kind with Korean names and counts", async () => {
  open();
  expect(await button("재시작 · Deployment 3")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "일시정지 · Rollout 1" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "지금 실행 · CronJob 1" })).toBeInTheDocument();
  // 모르는 액션은 서버 표시 이름
  expect(screen.getByRole("button", { name: "Frobnicate · Widget 1" })).toBeInTheDocument();
});

test("a group with nothing runnable is disabled with a reason, and a missing action permission disables it", async () => {
  open({}, (a) => a !== "action/apps/Rollout/pause");
  const widget = await button("Frobnicate · Widget 1");
  await waitFor(() => expect(screen.getByRole("button", { name: "재시작 · Deployment 3" })).toBeEnabled());
  expect(widget).toBeDisabled();
  expect(widget.getAttribute("title")).toMatch(/실행할 수 있는 리소스가 없어요/);
  expect(screen.getByRole("button", { name: "일시정지 · Rollout 1" })).toBeDisabled();
});

test("the batch form preselects runnable resources, greys the disabled one and sends the chosen ones with params", async () => {
  const { onChange } = open();
  const restart = await button("재시작 · Deployment 3");
  await waitFor(() => expect(restart).toBeEnabled());
  fireEvent.click(restart);
  expect(screen.getByLabelText("a 선택")).toBeChecked();
  expect(screen.getByLabelText("c 선택")).toBeDisabled();
  fireEvent.click(screen.getByLabelText("b 선택"));
  fireEvent.click(screen.getByRole("button", { name: "미리 보기" }));
  expect(onChange).toHaveBeenCalledWith({ kind: "resourceActionBatch", action: "restart", resources: [r("Deployment", "a")], params: [] });

  const job = screen.getByRole("button", { name: "지금 실행 · CronJob 1" });
  await waitFor(() => expect(job).toBeEnabled());
  fireEvent.click(job);
  fireEvent.change(screen.getByLabelText("jobName"), { target: { value: "adhoc" } });
  fireEvent.click(screen.getByRole("button", { name: "미리 보기" }));
  expect(onChange).toHaveBeenLastCalledWith({ kind: "resourceActionBatch", action: "create-job", resources: [r("CronJob", "nightly")], params: [{ name: "jobName", value: "adhoc" }] });
});

test("rollback targets the previous deployment, with the auto-sync choice when auto-sync is on", async () => {
  const { onChange } = open({ syncPolicy: { automated: true } as ArgoApp["syncPolicy"] });
  const rollback = await button("이전 버전으로 롤백…");
  await waitFor(() => expect(rollback).toBeEnabled());
  fireEvent.click(rollback);
  expect(await screen.findByRole("dialog", { name: "롤백 · 이력 6" })).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("자동 동기화 끄고 롤백"));
  fireEvent.click(screen.getByRole("button", { name: "미리 보기" }));
  expect(onChange).toHaveBeenCalledWith({ kind: "rollback", id: 6, prune: false, dryRun: false, disableAutoSync: true });
});

test("auto-sync toggles by patch and refresh goes straight through", async () => {
  const { onChange, onRefresh } = open();
  const on = await button("자동 동기화 켜기");
  await waitFor(() => expect(on).toBeEnabled());
  fireEvent.click(on);
  expect(onChange).toHaveBeenCalledWith({ kind: "appPatch", patch: { spec: { syncPolicy: { automated: { prune: false, selfHeal: false } } } } });
  fireEvent.click(screen.getByRole("button", { name: "Hard refresh" }));
  expect(onRefresh).toHaveBeenCalledWith(true);
});

test("terminate shows only while an operation runs; a running operation blocks sync and rollback", async () => {
  open();
  await button("Sync…");
  expect(screen.queryByRole("button", { name: "작업 중단" })).toBeNull();
});

test("while running: terminate is offered, sync and rollback are blocked", async () => {
  const { onChange } = open({ operationInProgress: true });
  const stop = await button("작업 중단");
  await waitFor(() => expect(stop).toBeEnabled());
  fireEvent.click(stop);
  expect(onChange).toHaveBeenCalledWith({ kind: "terminate" });
  expect(screen.getByRole("button", { name: "Sync…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "이전 버전으로 롤백…" })).toBeDisabled();
});

test("without sync, update and delete permissions the controls are disabled with the denial reason", async () => {
  open({}, (a) => a === "get");
  const sync = await button("Sync…");
  await waitFor(() => expect(change.can).toHaveBeenCalled());
  await waitFor(() => expect(sync.getAttribute("title")).toBeTruthy());
  expect(sync).toBeDisabled();
  for (const name of ["자동 동기화 켜기", "앱 삭제…"]) expect(screen.getByRole("button", { name })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  expect(within(screen.getByRole("toolbar", { name: "앱 작업" })).getAllByRole("group").length).toBeGreaterThanOrEqual(4);
});
