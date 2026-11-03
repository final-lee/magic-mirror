import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { renderWithClient } from "../test/utils";
import { argowfApi } from "./api";
import { WorkflowList } from "./WorkflowList";
import { WorkflowDetail } from "./WorkflowDetail";
import { failedPod, NodeTree } from "./NodeTree";
import { conn, detailOf, info, node, page, row } from "./shellFixtures";
import type { ArgoWfViewState, WfDetailWatchEvent, WfRow } from "./types";

vi.mock("./api", () => ({
  argowfApi: {
    workflow: vi.fn(),
    archivedWorkflow: vi.fn(),
    workflowAction: vi.fn(),
    archivedAction: vi.fn(),
    roleArn: vi.fn(),
    events: vi.fn(),
    logs: vi.fn(),
    logsStop: vi.fn(),
    workflows: vi.fn(),
    watch: vi.fn(),
    watchWorkflow: vi.fn(),
    watchStop: vi.fn(),
    manifest: vi.fn(),
    batchAction: vi.fn(),
  },
}));
const detail = detailOf();
const logOptions = { container: "main", follow: false, tailLines: 50, previous: false, sinceSeconds: null, timestamps: false };

function Detail(p: Partial<Parameters<typeof WorkflowDetail>[0]> & { target?: Parameters<typeof WorkflowDetail>[0]["target"] }) {
  return (
    <WorkflowDetail
      conn={conn}
      target={{ kind: "live", namespace: "prod", name: "prod-job" }}
      live
      kube={false}
      info={info}
      onClose={vi.fn()}
      onOpenWorkflow={vi.fn()}
      onOpenCron={vi.fn()}
      onOpenTemplate={vi.fn()}
      onResubmitYaml={vi.fn()}
      onTokenError={vi.fn()}
      {...p}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(argowfApi.workflow).mockResolvedValue(detail);
  vi.mocked(argowfApi.logs).mockResolvedValue(1);
  vi.mocked(argowfApi.workflowAction).mockResolvedValue(null);
  vi.mocked(argowfApi.watch).mockResolvedValue(7);
  vi.mocked(argowfApi.watchWorkflow).mockResolvedValue(8);
  vi.mocked(argowfApi.watchStop).mockResolvedValue(undefined);
});

function List({ rows, base = rows, onOpen = vi.fn() }: { rows: WfRow[]; base?: WfRow[]; onOpen?: (t: unknown) => void }) {
  const [saved, setSaved] = useState<ArgoWfViewState>({ phases: [], namespaces: [], sources: [] });
  return (
    <WorkflowList
      conn={conn}
      live
      namespace={null}
      info={info}
      identity="me@example.test"
      base={base}
      crons={[]}
      saved={saved}
      labelColumns={[]}
      onSave={setSaved}
      onLabelColumns={vi.fn()}
      onOpen={onOpen}
      onFindings={vi.fn()}
      onTokenError={vi.fn()}
    />
  );
}

test("요약과 칩 개수는 선택 전 기준이며 우선순위와 퍼지 검색을 지킨다", async () => {
  const rows = [
    row("done", "Succeeded", { finishedAt: new Date().toISOString() }),
    row("fail", "Failed", { finishedAt: new Date().toISOString() }),
    row("running", "Running", { labels: { team: "payments" } }),
  ];
  vi.mocked(argowfApi.workflows).mockResolvedValue(page(rows));
  renderWithClient(<List rows={rows} />);
  expect(await screen.findByText("running")).toBeInTheDocument();
  expect(screen.getByText(/24시간 성공/)).toHaveTextContent("1");
  expect(screen.getByText(/50%/)).toHaveTextContent("실패 1");
  // 실행 중 → 최근 실패 → 나머지(맨 위는 머리 줄 다음)
  expect(within(screen.getAllByRole("row")[1]).getByText("running")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Running 1" }));
  await waitFor(() => expect(argowfApi.workflows).toHaveBeenLastCalledWith(conn, expect.objectContaining({ phases: ["Running"] })));
  expect(screen.getByRole("button", { name: "Failed 1" })).toBeInTheDocument();
  expect(screen.queryByText("fail")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Workflow 검색"), { target: { value: "pay" } });
  expect(screen.getByText("running")).toBeInTheDocument();
});

test("목록의 보관 전용 행은 보관 상세로 연다", async () => {
  const open = vi.fn();
  const rows = [row("old", "Failed", { archived: true, uid: "archive-uid" })];
  vi.mocked(argowfApi.workflows).mockResolvedValue(page(rows));
  renderWithClient(<List rows={rows} onOpen={open} />);
  fireEvent.click(await screen.findByText("old"));
  expect(open).toHaveBeenCalledWith({ kind: "archived", uid: "archive-uid" });
});

test("실패 단계로 가장 먼저 끝난 Pod와 50줄 로그를 열고 위험 동작은 이름을 요구한다", async () => {
  renderWithClient(<Detail />);
  fireEvent.click(await screen.findByRole("button", { name: "실패 단계로" }));
  expect(screen.getByText(/Pod: first/)).toBeInTheDocument();
  await waitFor(() => expect(argowfApi.logs).toHaveBeenCalledWith(conn, "prod", "prod-job", "first", logOptions, expect.any(Function)));
  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "삭제" }));
  expect(screen.getByRole("button", { name: "적용" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/확인하려면/), { target: { value: "prod-job" } });
  expect(screen.getByRole("button", { name: "적용" })).toBeEnabled();
});

test("다시 제출은 파라미터를 보내고 새 Workflow를 연다", async () => {
  vi.mocked(argowfApi.workflowAction).mockResolvedValue("new-job");
  const open = vi.fn();
  renderWithClient(<Detail onOpenWorkflow={open} />);
  fireEvent.click(await screen.findByRole("button", { name: "다시 제출" }));
  fireEvent.change(screen.getByDisplayValue("alice"), { target: { value: "bob" } });
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith({ kind: "live", namespace: "prod", name: "new-job" }));
  expect(argowfApi.workflowAction).toHaveBeenCalledWith(conn, "prod", "prod-job", { kind: "resubmit", memoized: false, parameters: ["who=bob"] });
});

test("Retry는 바꾼 파라미터만 보내고 성공한 단계도 다시 옵션을 따른다", async () => {
  renderWithClient(<Detail />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  fireEvent.click(screen.getByLabelText("성공한 단계도 다시"));
  fireEvent.change(screen.getByDisplayValue("alice"), { target: { value: "carol" } });
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  await waitFor(() =>
    expect(argowfApi.workflowAction).toHaveBeenCalledWith(conn, "prod", "prod-job", {
      kind: "retry",
      restartSuccessful: true,
      nodeFieldSelector: null,
      parameters: ["who=carol"],
    }),
  );
});

test("실행 중인 Suspend 노드가 있으면 Resume을 켠다", async () => {
  vi.mocked(argowfApi.workflow).mockResolvedValue({
    ...detail,
    row: row("job", "Running"),
    nodes: [node("approval", { type: "Suspend", phase: "Running", podName: null })],
  });
  renderWithClient(<Detail target={{ kind: "live", namespace: "test", name: "job" }} />);
  expect(await screen.findByRole("button", { name: "Resume" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Suspend" })).toBeDisabled();
});

test("보관 Retry가 새 Workflow를 만들면 live 상세를 연다", async () => {
  vi.mocked(argowfApi.archivedWorkflow).mockResolvedValue(detail);
  vi.mocked(argowfApi.archivedAction).mockResolvedValue("retry-job");
  const open = vi.fn();
  renderWithClient(<Detail target={{ kind: "archived", uid: "uid" }} onOpenWorkflow={open} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith({ kind: "live", namespace: "prod", name: "retry-job" }));
  expect(argowfApi.archivedAction).toHaveBeenCalledWith(conn, "uid", "prod", {
    kind: "retry",
    restartSuccessful: false,
    nodeFieldSelector: null,
    parameters: [],
  });
});

test("상세는 감시로 받은 새 상태를 바로 보이고, 감시가 끊기면 3초마다 읽는다", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    vi.mocked(argowfApi.workflow).mockResolvedValue({ ...detail, row: row("job", "Running", { namespace: "test", message: "처음" }), nodes: [] });
    let send: (m: WfDetailWatchEvent) => void = () => {};
    vi.mocked(argowfApi.watchWorkflow).mockImplementation(async (_c, _ns, _n, _rv, cb) => {
      send = cb;
      return 8;
    });
    renderWithClient(<Detail target={{ kind: "live", namespace: "test", name: "job" }} />);
    expect(await screen.findByText("처음")).toBeInTheDocument();
    await waitFor(() => expect(argowfApi.watchWorkflow).toHaveBeenCalledTimes(1));
    expect(argowfApi.watchWorkflow).toHaveBeenCalledWith(conn, "test", "job", "1", expect.any(Function));
    act(() => send({ type: "detail", detail: { ...detail, row: row("job", "Running", { namespace: "test", message: "둘째" }), nodes: [] } }));
    expect(await screen.findByText("둘째")).toBeInTheDocument();
    expect(argowfApi.workflow).toHaveBeenCalledTimes(2);
    act(() => send({ type: "error", error: { kind: "other", message: "끊김" } }));
    await act(() => vi.advanceTimersByTimeAsync(3100));
    expect(argowfApi.workflow).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() => expect(argowfApi.watchWorkflow).toHaveBeenCalledTimes(2));
  } finally {
    vi.useRealTimers();
  }
});

test("감시 중에 지워지면 알린다", async () => {
  vi.mocked(argowfApi.workflow).mockResolvedValue({ ...detail, row: row("job", "Running", { namespace: "test", message: "원래 상태" }), nodes: [] });
  let send: (m: WfDetailWatchEvent) => void = () => {};
  vi.mocked(argowfApi.watchWorkflow).mockImplementation(async (_c, _ns, _n, _rv, cb) => {
    send = cb;
    return 8;
  });
  renderWithClient(<Detail target={{ kind: "live", namespace: "test", name: "job" }} />);
  await waitFor(() => expect(argowfApi.watchWorkflow).toHaveBeenCalled());
  act(() => send({ type: "deleted" }));
  expect(await screen.findByText("이 Workflow가 지워졌어요")).toBeInTheDocument();
  await waitFor(() => expect(argowfApi.watchStop).toHaveBeenCalledWith(8));
  act(() => send({ type: "detail", detail: { ...detail, row: row("job", "Running", { message: "늦은 상태" }), nodes: [] } }));
  expect(screen.getByText("원래 상태")).toBeInTheDocument();
  expect(screen.queryByText("늦은 상태")).not.toBeInTheDocument();
  expect(screen.getByText("이 Workflow가 지워졌어요")).toBeInTheDocument();
});

test("상세 감시를 다시 켜거나 서랍을 다시 열면 최신 상세를 읽은 버전부터 감시한다", async () => {
  const initial = { ...detail, row: row("job", "Running", { namespace: "test", resourceVersion: "10" }), nodes: [] };
  const fresh = { ...initial, row: { ...initial.row, resourceVersion: "20", message: "갱신됨" } };
  vi.mocked(argowfApi.workflow).mockResolvedValue(initial);
  function ToggleDetail() {
    const [live, setLive] = useState(true);
    const [open, setOpen] = useState(true);
    return (
      <>
        <button onClick={() => setLive((value) => !value)}>감시 전환</button>
        <button onClick={() => setOpen((value) => !value)}>서랍 전환</button>
        {open && <Detail live={live} target={{ kind: "live", namespace: "test", name: "job" }} />}
      </>
    );
  }
  renderWithClient(<ToggleDetail />);
  await waitFor(() => expect(argowfApi.watchWorkflow).toHaveBeenCalledWith(conn, "test", "job", "10", expect.any(Function)));
  fireEvent.click(screen.getByText("감시 전환"));
  await waitFor(() => expect(argowfApi.watchStop).toHaveBeenCalledWith(8));
  let resolveFetch!: (value: typeof fresh) => void;
  vi.mocked(argowfApi.workflow).mockImplementationOnce(() => new Promise((resolve) => (resolveFetch = resolve)));
  fireEvent.click(screen.getByText("감시 전환"));
  await waitFor(() => expect(resolveFetch).toBeDefined());
  expect(argowfApi.watchWorkflow).toHaveBeenCalledTimes(1);
  await act(async () => resolveFetch(fresh));
  await waitFor(() => expect(argowfApi.watchWorkflow).toHaveBeenLastCalledWith(conn, "test", "job", "20", expect.any(Function)));
  fireEvent.click(screen.getByText("서랍 전환"));
  vi.mocked(argowfApi.workflow).mockResolvedValue({ ...fresh, row: { ...fresh.row, resourceVersion: "30" } });
  fireEvent.click(screen.getByText("서랍 전환"));
  await waitFor(() => expect(argowfApi.watchWorkflow).toHaveBeenLastCalledWith(conn, "test", "job", "30", expect.any(Function)));
});

test("성공한 Retry의 지난 실패는 건너뛰고 실패 원인을 고른다", () => {
  const nodes = [
    node("recovered", { type: "Retry", phase: "Succeeded", children: ["old"], podName: null }),
    node("old", { finishedAt: "2026-01-01T00:01:00Z" }),
    node("failed", { type: "Retry", phase: "Failed", children: ["current"], podName: null }),
    node("current", { finishedAt: "2026-01-01T00:02:00Z" }),
  ];
  expect(failedPod(nodes)?.id).toBe("current");
  expect(failedPod(nodes.slice(0, 2))?.id).toBe("old");
  // DAG에서 children은 다음 작업으로 가는 흐름이다: 성공한 Retry 뒤에 이어진 작업의 실패는 빼면 안 된다
  const dag = [
    node("refunds", { type: "Retry", phase: "Succeeded", children: ["try0", "try1"], podName: null, boundaryId: "root" }),
    node("try0", { finishedAt: "2026-01-01T00:01:00Z", boundaryId: "root" }),
    node("try1", { phase: "Succeeded", children: ["load"], boundaryId: "root" }),
    node("load", { finishedAt: "2026-01-01T00:05:00Z", boundaryId: "root" }),
  ];
  expect(failedPod(dag)?.id).toBe("load");
});

test("DAG의 여러 부모가 참조하는 단계는 한 번만 보인다", () => {
  const nodes = [
    node("root", { type: "DAG", children: ["orders", "customers"], podName: null }),
    node("orders", { type: "TaskGroup", children: ["join"], podName: null }),
    node("customers", { type: "TaskGroup", children: ["join"], podName: null }),
    node("join"),
  ];
  render(<NodeTree detail={{ ...detail, nodes }} selected={null} onSelect={vi.fn()} />);
  expect(screen.getAllByRole("button", { name: /join/ })).toHaveLength(1);
  expect(screen.getByText("← customers")).toBeInTheDocument();
});
