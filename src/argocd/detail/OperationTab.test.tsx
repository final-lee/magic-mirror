import { act, screen, waitFor, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { renderWithClient } from "../../test/utils";
import { ARGO_NO_OPERATION } from "../text";
import type { ArgoApp, ArgoOperation, ArgoResourceResult, ResRef } from "../types";
import { readApi } from "./api";
import { OperationTab } from "./OperationTab";
import { OP_NO_RESULTS, OP_RESULTS } from "./text";

vi.mock("./api", () => ({ readApi: { operationWaves: vi.fn() } }));
const m = vi.mocked(readApi);
const URL = "https://argocd.example";
const NOW = Date.parse("2026-10-30T12:00:00Z");
const SHA = "0123456789abcdef0123456789abcdef01234567";

const result = (name: string, over: Partial<ArgoResourceResult> = {}): ArgoResourceResult => ({
  group: "apps", version: "v1", kind: "Deployment", namespace: "web", name, status: "Synced", message: null, hookPhase: null, hookType: null, syncPhase: "Sync", ...over,
});
const operation = (over: Partial<ArgoOperation> = {}): ArgoOperation => ({
  phase: "Running", message: "waiting for healthy state of apps/Deployment/web", startedAt: "2026-10-30T11:58:30Z", finishedAt: null, initiatedBy: "alice", revisions: [SHA],
  retryCount: 2, retryLimit: 5, dryRun: false, prune: true, syncOptions: ["CreateNamespace=true"], failedResults: [], results: [], ...over,
});
const appOf = (op: ArgoOperation | null) => ({ name: "web", namespace: "argocd", operation: op }) as unknown as ArgoApp;

function open(op: ArgoOperation | null, onOpen: (r: ResRef) => void = vi.fn(), now: number | null = NOW, terminate = { allowed: true, reason: null as string | null, onTerminate: vi.fn() }) {
  return renderWithClient(<OperationTab url={URL} app={appOf(op)} now={now ?? undefined} onOpen={onOpen} onTokenError={vi.fn()} terminate={terminate} />);
}

beforeEach(() => {
  vi.resetAllMocks();
  m.operationWaves.mockResolvedValue([]);
});

test("a running operation shows phase, message, who, elapsed time, retries and options", () => {
  open(operation());
  expect(screen.getByText("Running")).toHaveClass("argo-warn");
  expect(screen.getByText(/waiting for healthy state/)).toBeInTheDocument();
  expect(screen.getByText("alice")).toBeInTheDocument();
  expect(screen.getByText("1분 30초")).toBeInTheDocument();
  expect(screen.getByText("2 / 5회")).toBeInTheDocument();
  expect(screen.getByText("Prune, CreateNamespace=true")).toBeInTheDocument();
  expect(screen.getByText("0123456")).toBeInTheDocument();
});

test("a finished operation measures start to finish and shows no retries when there is no strategy", () => {
  open(operation({ phase: "Succeeded", finishedAt: "2026-10-30T11:58:45Z", retryCount: 0, retryLimit: null }));
  expect(screen.getByText("15초")).toBeInTheDocument();
  expect(screen.queryByText(/회$/)).toBeNull();
});

test("the elapsed time of a running operation keeps counting without a new read", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(NOW);
    open(operation(), vi.fn(), null);
    expect(screen.getByText("1분 30초")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.getByText("1분 35초")).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test("results run in phase and wave order with hook phases; waves come from the revision's manifests", async () => {
  m.operationWaves.mockResolvedValue([
    { group: "apps", kind: "Deployment", namespace: "web", name: "web", wave: 2, hook: null },
    { group: "", kind: "ConfigMap", namespace: "web", name: "cfg", wave: -1, hook: null },
    { group: "batch", kind: "Job", namespace: "web", name: "migrate", wave: 0, hook: "PreSync" },
  ]);
  open(
    operation({
      results: [
        result("web"),
        result("notify", { group: "batch", kind: "Job", syncPhase: "PostSync", hookType: "PostSync", hookPhase: "Running", status: "Running" }),
        result("cfg", { group: "", kind: "ConfigMap" }),
        result("migrate", { group: "batch", kind: "Job", syncPhase: "PreSync", hookType: "PreSync", hookPhase: "Succeeded", message: "job completed" }),
      ],
    }),
  );
  const table = await screen.findByRole("table", { name: OP_RESULTS });
  await waitFor(() => expect(within(table).getAllByRole("row")[2]).toHaveTextContent("-1"));
  expect(m.operationWaves).toHaveBeenCalledWith(URL, "argocd", "web", [SHA]);
  const rows = within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
  expect(rows).toEqual([
    ["0", "PreSync", "Job", "migrate web", "Synced", "PreSync Succeeded", "job completed"],
    ["-1", "Sync", "ConfigMap", "cfg web", "Synced", "", ""],
    ["2", "Sync", "Deployment", "web web", "Synced", "", ""],
    ["–", "PostSync", "Job", "notify web", "Running", "PostSync Running", ""],
  ]);
});

test("an operation without results says so and asks for no waves", () => {
  open(operation({ results: [] }));
  expect(screen.getByText(OP_NO_RESULTS)).toBeInTheDocument();
  expect(m.operationWaves).not.toHaveBeenCalled();
});

test("no operation at all says there is no record", () => {
  open(null);
  expect(screen.getByText(ARGO_NO_OPERATION)).toBeInTheDocument();
});

test("a result name opens that resource", async () => {
  const onOpen = vi.fn();
  open(operation({ results: [result("web")] }), onOpen);
  fireEvent.click(await screen.findByRole("button", { name: "web" }));
  expect(onOpen).toHaveBeenCalledWith({ group: "apps", version: "v1", kind: "Deployment", namespace: "web", name: "web" });
});

describe("terminate", () => {
  test("is offered only while the operation is running", () => {
    open(operation({ phase: "Succeeded", finishedAt: "2026-10-30T11:58:45Z" }));
    expect(screen.queryByRole("button", { name: "작업 중단" })).toBeNull();
  });

  test("asks for the change while running and is disabled with the reason when not allowed", () => {
    const onTerminate = vi.fn();
    const { unmount } = open(operation(), vi.fn(), NOW, { allowed: true, reason: null, onTerminate });
    fireEvent.click(screen.getByRole("button", { name: "작업 중단" }));
    expect(onTerminate).toHaveBeenCalledTimes(1);
    unmount();
    open(operation(), vi.fn(), NOW, { allowed: false, reason: "권한 없음", onTerminate });
    const button = screen.getByRole("button", { name: "작업 중단" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "권한 없음");
  });
});
