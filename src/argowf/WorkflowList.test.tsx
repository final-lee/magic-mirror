import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { renderWithClient } from "../test/utils";
import { argowfApi } from "./api";
import { WorkflowList } from "./WorkflowList";
import { conn, info, page, row } from "./shellFixtures";
import { useWorkflowPages } from "./queries";
import { emptyQuery } from "./wfQuery";
import type { ArgoWfInfo, ArgoWfViewState, WfRow, WfWatchEvent } from "./types";

vi.mock("./api", () => ({ argowfApi: { workflows: vi.fn(), watch: vi.fn(), watchStop: vi.fn(), batchAction: vi.fn() } }));

let send: (m: WfWatchEvent) => void = () => {};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(argowfApi.watchStop).mockResolvedValue(undefined);
  vi.mocked(argowfApi.watch).mockImplementation(async (_c, _ns, _sel, _rv, cb) => {
    send = cb;
    return 7;
  });
});

function List({
  base = [],
  saved: initial,
  serverInfo = info,
  labelColumns = [],
  namespace = "test",
}: {
  base?: WfRow[];
  saved?: Partial<ArgoWfViewState>;
  serverInfo?: ArgoWfInfo;
  labelColumns?: string[];
  namespace?: string | null;
}) {
  const [saved, setSaved] = useState<ArgoWfViewState>({ phases: [], namespaces: [], sources: [], ...initial });
  return (
    <WorkflowList
      conn={conn}
      live
      namespace={namespace}
      info={serverInfo}
      identity="me@example.test"
      base={base}
      crons={[]}
      saved={saved}
      labelColumns={labelColumns}
      onSave={setSaved}
      onLabelColumns={vi.fn()}
      onOpen={vi.fn()}
      onFindings={vi.fn()}
      onTokenError={vi.fn()}
    />
  );
}

test("첫 페이지를 읽은 뒤 감시를 붙이고 upsert·delete를 목록에 반영한다", async () => {
  vi.mocked(argowfApi.workflows).mockResolvedValue(page([row("alpha", "Running"), row("beta", "Running")], null, "42"));
  renderWithClient(<List />);
  expect(await screen.findByText("alpha")).toBeInTheDocument();
  await waitFor(() => expect(argowfApi.watch).toHaveBeenCalledWith(conn, "test", null, "42", expect.any(Function)));
  act(() => send({ type: "upsert", row: row("gamma", "Running") }));
  expect(await screen.findByText("gamma")).toBeInTheDocument();
  act(() => send({ type: "upsert", row: row("alpha", "Failed", { message: "터졌어요" }) }));
  expect(await screen.findByText("터졌어요")).toBeInTheDocument();
  vi.mocked(argowfApi.workflows).mockResolvedValue(page([row("beta", "Succeeded", { archived: true })]));
  act(() => send({ type: "delete", uid: "beta", namespace: "test", name: "beta" }));
  await waitFor(() => expect(argowfApi.workflows).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("beta")).toBeInTheDocument();
  expect(screen.queryByText("gamma")).not.toBeInTheDocument();
});

test("삭제 감시는 필터 목록과 요약 기준 페이지를 모두 다시 읽는다", async () => {
  let archived = false;
  vi.mocked(argowfApi.workflows).mockImplementation(async () => page([row("beta", archived ? "Succeeded" : "Running", { archived })]));
  function Base() {
    const base = useWorkflowPages(conn, emptyQuery(null), true, { watch: false });
    return <div data-testid="base">{base.rows[0]?.archived ? "보관됨" : "실행 중"}</div>;
  }
  renderWithClient(
    <>
      <Base />
      <List />
    </>,
  );
  expect(await screen.findByText("beta")).toBeInTheDocument();
  await waitFor(() => expect(argowfApi.watch).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByTestId("base")).toHaveTextContent("실행 중"));
  archived = true;
  act(() => send({ type: "delete", uid: "beta", namespace: "test", name: "beta" }));
  await waitFor(() => expect(screen.getByTestId("base")).toHaveTextContent("보관됨"));
  expect(argowfApi.workflows).toHaveBeenCalledTimes(4);
});

test("감시가 오류로 끊기면 5초 폴링으로 돌아가고 10초 뒤 다시 붙는다", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    vi.mocked(argowfApi.workflows).mockResolvedValue(page([row("alpha", "Running")], null, "42"));
    renderWithClient(<List />);
    expect(await screen.findByText("alpha")).toBeInTheDocument();
    await waitFor(() => expect(argowfApi.watch).toHaveBeenCalledTimes(1));
    act(() => send({ type: "error", error: { kind: "other", message: "끊김" } }));
    expect(await screen.findByText(/5초마다 읽는 중/)).toBeInTheDocument();
    expect(argowfApi.watchStop).toHaveBeenCalledWith(7);
    const before = vi.mocked(argowfApi.workflows).mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(5100));
    expect(vi.mocked(argowfApi.workflows).mock.calls.length).toBeGreaterThan(before);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() => expect(argowfApi.watch).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/5초마다 읽는 중/)).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test("watch 호출이 실패해도 폴링으로 돌아간다", async () => {
  vi.mocked(argowfApi.watch).mockRejectedValue({ kind: "other", message: "안 됨" });
  vi.mocked(argowfApi.workflows).mockResolvedValue(page([row("alpha", "Running")]));
  renderWithClient(<List />);
  expect(await screen.findByText(/5초마다 읽는 중/)).toBeInTheDocument();
});

test("[더 보기]는 continue 토큰으로 다음 페이지를 이어 붙인다", async () => {
  vi.mocked(argowfApi.workflows).mockImplementation(async (_c, q) =>
    q.continueToken === "t1" ? page([row("second", "Succeeded")]) : page([row("first", "Succeeded")], "t1"),
  );
  renderWithClient(<List />);
  expect(await screen.findByText("first")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "더 보기" }));
  expect(await screen.findByText("second")).toBeInTheDocument();
  expect(screen.getByText("first")).toBeInTheDocument();
  expect(argowfApi.workflows).toHaveBeenLastCalledWith(conn, expect.objectContaining({ continueToken: "t1", limit: 200, namespace: "test" }));
  expect(screen.queryByRole("button", { name: "더 보기" })).not.toBeInTheDocument();
});

test("레이블 칩은 labelSelector로, 이름·날짜는 그대로 서버 조건이 된다", async () => {
  vi.mocked(argowfApi.workflows).mockResolvedValue(page([row("alpha", "Running", { labels: { team: "a", env: "dev" } })]));
  renderWithClient(<List saved={{ labels: ["team=a", "team=b", "env=dev"] }} />);
  await screen.findByText("alpha");
  expect(argowfApi.workflows).toHaveBeenCalledWith(conn, expect.objectContaining({ labelSelector: "team in (a,b),env=dev", namespace: "test" }));
  fireEvent.change(screen.getByLabelText("이름 조건"), { target: { value: "exact" } });
  fireEvent.change(screen.getByLabelText("이름 값"), { target: { value: "alpha" } });
  fireEvent.change(screen.getByLabelText("만든 뒤"), { target: { value: "2026-01-01" } });
  await waitFor(() =>
    expect(argowfApi.workflows).toHaveBeenLastCalledWith(
      conn,
      expect.objectContaining({ name: { mode: "exact", value: "alpha" }, createdAfter: new Date("2026-01-01").toISOString() }),
    ),
  );
});

test("레이블 열의 값을 누르면 그 레이블 필터가 붙는다", async () => {
  vi.mocked(argowfApi.workflows).mockResolvedValue(page([row("alpha", "Running", { labels: { team: "payments" } })]));
  renderWithClient(<List labelColumns={["team"]} />);
  fireEvent.click(await screen.findByRole("button", { name: "payments" }));
  await waitFor(() => expect(argowfApi.workflows).toHaveBeenLastCalledWith(conn, expect.objectContaining({ labelSelector: "team=payments" })));
});

test("서버 info의 열과 내 것만을 보인다", async () => {
  vi.mocked(argowfApi.workflows).mockResolvedValue(
    page([row("mine", "Succeeded", { creator: "me@example.test", labels: { owner: "x" } }), row("theirs", "Succeeded", { creator: "you@example.test" })]),
  );
  renderWithClient(<List serverInfo={{ ...info, columns: [{ name: "담당", type: "label", key: "owner" }] }} />);
  expect(await screen.findByRole("columnheader", { name: "담당" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "내 것만" }));
  expect(screen.getByText("mine")).toBeInTheDocument();
  expect(screen.queryByText("theirs")).not.toBeInTheDocument();
});

test("실행 중 행은 예상 시간 대비 진행 막대를 보인다", async () => {
  vi.mocked(argowfApi.workflows).mockResolvedValue(
    page([row("alpha", "Running", { estimatedDuration: 120 }), row("done", "Succeeded", { estimatedDuration: 120 })]),
  );
  renderWithClient(<List />);
  const bar = await screen.findByRole("progressbar", { name: "예상 진행" });
  expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThan(40);
  expect(screen.getAllByRole("progressbar")).toHaveLength(1);
});

test("여러 개를 골라 일괄 동작하고 결과 표를 보이며, prod가 하나라도 있으면 선택 개수를 쳐야 한다", async () => {
  vi.mocked(argowfApi.workflows).mockResolvedValue(page([row("dev-a", "Running"), row("prod-b", "Running", { namespace: "prod" })]));
  vi.mocked(argowfApi.batchAction).mockResolvedValue([
    { namespace: "test", name: "dev-a", ok: true, error: null, created: null },
    { namespace: "prod", name: "prod-b", ok: false, error: "권한이 없어요", created: null },
  ]);
  renderWithClient(<List namespace={null} />);
  fireEvent.click(await screen.findByLabelText("dev-a 선택"));
  fireEvent.click(screen.getByLabelText("prod-b 선택"));
  const bar = screen.getByRole("toolbar", { name: "선택한 Workflow 동작" });
  fireEvent.click(within(bar).getByRole("button", { name: "Stop" }));
  const apply = screen.getByRole("button", { name: "적용" });
  expect(apply).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/확인하려면/), { target: { value: "선택한 2개" } });
  fireEvent.click(apply);
  const dialog = await screen.findByRole("dialog", { name: "일괄 동작 결과" });
  expect(argowfApi.batchAction).toHaveBeenCalledWith(
    conn,
    [
      { namespace: "test", name: "dev-a" },
      { namespace: "prod", name: "prod-b" },
    ],
    { kind: "stop", nodeFieldSelector: null, message: null },
  );
  expect(within(dialog).getByText("권한이 없어요")).toBeInTheDocument();
  expect(within(dialog).getByText("성공")).toBeInTheDocument();
});

test("prod가 없으면 일괄 Suspend는 이름 입력 없이 적용된다", async () => {
  vi.mocked(argowfApi.workflows).mockResolvedValue(page([row("dev-a", "Running")]));
  vi.mocked(argowfApi.batchAction).mockResolvedValue([{ namespace: "test", name: "dev-a", ok: true, error: null, created: null }]);
  renderWithClient(<List />);
  fireEvent.click(await screen.findByLabelText("dev-a 선택"));
  fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: "Suspend" }));
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  await waitFor(() => expect(argowfApi.batchAction).toHaveBeenCalledWith(conn, [{ namespace: "test", name: "dev-a" }], { kind: "suspend" }));
});
