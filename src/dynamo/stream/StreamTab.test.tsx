import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithClient } from "../../test/utils";
import { finding, table } from "../fixtures";
import { streamApi } from "./api";
import { POLL_INTERVAL_MS } from "./session";
import { StreamTab } from "./StreamTab";
import type { Connections, Esm, StreamPoll, StreamRecord } from "./types";

vi.mock("./api", () => ({ streamApi: { connections: vi.fn(), start: vi.fn(), poll: vi.fn(), stop: vi.fn() } }));

const api = vi.mocked(streamApi);

const FUNCTION_ARN = "arn:aws:lambda:ap-northeast-2:111111111111:function:order-worker:live";
const STREAM = { arn: "arn:aws:dynamodb:ap-northeast-2:111111111111:table/orders/stream/1", viewType: "NEW_AND_OLD_IMAGES" };
const orders = table("orders", { stream: STREAM });

const esm = (over: Partial<Esm> = {}): Esm => ({
  id: "m1",
  function: FUNCTION_ARN,
  state: "Enabled",
  batchSize: 100,
  startingPosition: "LATEST",
  parallelization: 1,
  bisect: false,
  retries: -1,
  maxAge: null,
  failureDestination: null,
  filters: [],
  iteratorAgeMs: 4000,
  ...over,
});

const connections = (over: Partial<Connections> = {}): Connections => ({ stream: STREAM, esms: [], pipes: [], kinesis: [], replicas: [], gaps: [], findings: [], ...over });

const record = (id: string, over: Partial<StreamRecord> = {}): StreamRecord => ({
  id,
  event: "INSERT",
  time: 1_700_000_000,
  keys: { pk: { S: `order#${id}` } },
  size: 40,
  oldImage: null,
  newImage: null,
  ...over,
});
const page = (...records: StreamRecord[]): StreamPoll => ({ records, shards: 1, behind: 0 });

const flush = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

async function renderTab({ table: t = orders, onOpenLambda }: { table?: typeof orders; onOpenLambda?: (arn: string) => void } = {}) {
  const view = renderWithClient(<StreamTab profile="personal" region="ap-northeast-2" table={t} active openItems={() => {}} onOpenLambda={onOpenLambda} />);
  await flush();
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  api.connections.mockResolvedValue(connections());
  api.start.mockResolvedValue({ streamId: "s1" });
  api.stop.mockResolvedValue(undefined);
  api.poll.mockResolvedValue(page());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("연결 그림", () => {
  it("ESM 노드에 함수 이름·상태·지연을 보이고, 이동 버튼은 함수 ARN을 넘긴다", async () => {
    api.connections.mockResolvedValue(connections({ esms: [esm()] }));
    const onOpenLambda = vi.fn();
    await renderTab({ onOpenLambda });

    expect(screen.getByText("Lambda order-worker")).toBeInTheDocument();
    expect(screen.getByText("Enabled · 배치 100 · 지연 4초")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Lambda 상세 열기" }));
    expect(onOpenLambda).toHaveBeenCalledWith(FUNCTION_ARN);
  });

  it("이동할 곳이 없으면 이동 버튼을 그리지 않는다", async () => {
    api.connections.mockResolvedValue(connections({ esms: [esm()] }));
    await renderTab();

    expect(screen.queryByRole("button", { name: "Lambda 상세 열기" })).not.toBeInTheDocument();
  });

  it("Pipe·Kinesis·복제본과 복제 지연을 보인다", async () => {
    api.connections.mockResolvedValue(
      connections({
        pipes: [{ name: "to-queue", state: "RUNNING", target: "arn:aws:sqs:q" }],
        kinesis: [{ arn: "arn:aws:kinesis:s", state: "ACTIVE", precision: "MICROSECOND" }],
        replicas: [{ region: "us-east-1", status: "ACTIVE", class: null, latencyMs: 2500 }],
      }),
    );
    await renderTab();

    expect(screen.getByText("Pipe to-queue")).toBeInTheDocument();
    expect(screen.getByText("ACTIVE · MICROSECOND")).toBeInTheDocument();
    expect(screen.getByText("↔ us-east-1")).toBeInTheDocument();
    expect(screen.getByText("ACTIVE · STANDARD · 3초")).toBeInTheDocument();
  });

  it("소비자가 없으면 그렇게 말한다", async () => {
    await renderTab();
    expect(screen.getByText("연결된 소비자가 없어요.")).toBeInTheDocument();
  });

  it("읽지 못한 소비자 출처가 있으면 소비자가 없다고 하지 않는다", async () => {
    api.connections.mockResolvedValue(connections({ gaps: [{ section: "lambda", error: "lambda:ListEventSourceMappings 권한이 없어요" }] }));
    await renderTab();

    expect(screen.queryByText("연결된 소비자가 없어요.")).not.toBeInTheDocument();
    expect(screen.getByText(/읽지 못한 연결: Lambda 매핑 — lambda:ListEventSourceMappings 권한이 없어요/)).toBeInTheDocument();
  });

  it("연결 진단을 보인다", async () => {
    api.connections.mockResolvedValue(connections({ findings: [finding("warn", "order-worker 스트림 처리 지연이 400초예요")] }));
    await renderTab();

    expect(screen.getByText("연결 진단")).toBeInTheDocument();
    expect(screen.getByText("order-worker 스트림 처리 지연이 400초예요")).toBeInTheDocument();
  });

  it("스트림이 꺼져 있으면 안내만 보이고 실시간 레코드 카드는 없다", async () => {
    api.connections.mockResolvedValue(connections({ stream: null }));
    await renderTab({ table: table("orders") });

    expect(screen.getByText("이 테이블의 스트림이 꺼져 있어요.")).toBeInTheDocument();
    expect(screen.queryByText("실시간 레코드")).not.toBeInTheDocument();
  });
});

describe("실시간 레코드", () => {
  const start = async () => {
    await renderTab();
    fireEvent.click(screen.getByRole("button", { name: "읽기 시작" }));
    await flush();
  };
  const rows = () => screen.queryAllByText(/order#/, { selector: "summary code" }).map((el) => el.textContent);

  it("시작하면 2초마다 읽어 최근 레코드를 위에 보인다", async () => {
    api.poll.mockResolvedValueOnce(page(record("1"))).mockResolvedValueOnce(page(record("2")));
    await start();
    expect(screen.getByText("표시할 레코드가 없어요.")).toBeInTheDocument();

    await flush(POLL_INTERVAL_MS);
    await flush(POLL_INTERVAL_MS);
    expect(rows()).toEqual(["pk=order#2", "pk=order#1"]);
  });

  it("지금부터를 기본으로 읽고, 24시간 전부터를 고르면 많이 읽을 수 있다고 안내한다", async () => {
    await renderTab();
    expect(screen.queryByText(/많은 레코드를 읽을 수 있어요/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("시작 위치"), { target: { value: "TRIM_HORIZON" } });
    expect(screen.getByText(/많은 레코드를 읽을 수 있어요/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "읽기 시작" }));
    await flush();
    expect(api.start).toHaveBeenCalledWith("personal", "ap-northeast-2", "orders", "TRIM_HORIZON");
    expect(screen.getByLabelText("시작 위치")).toBeDisabled();
  });

  it("일시정지하는 동안 목록은 그대로이고 읽기는 계속되며, 재개하면 그동안 읽은 레코드가 나타난다", async () => {
    api.poll.mockResolvedValueOnce(page(record("1"))).mockResolvedValueOnce(page(record("2")));
    await start();
    await flush(POLL_INTERVAL_MS);
    expect(rows()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "일시정지" }));
    await flush(POLL_INTERVAL_MS);
    expect(api.poll).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "재개" }));
    expect(rows()).toHaveLength(2);
  });

  it("중지하면 세션을 지우고 다시 시작할 수 있다", async () => {
    await start();
    fireEvent.click(screen.getByRole("button", { name: "읽기 중지" }));

    expect(api.stop.mock.calls).toEqual([["s1"]]);
    expect(screen.getByRole("button", { name: "읽기 시작" })).toBeInTheDocument();
  });

  it("종류 칩으로 거르고 필터로 찾는다", async () => {
    api.poll.mockResolvedValueOnce(page(record("1"), record("2", { event: "REMOVE", oldImage: { status: { S: "CANCELLED" } } }), record("3", { event: "MODIFY", newImage: { status: { S: "SHIPPED" } } })));
    await start();
    await flush(POLL_INTERVAL_MS);
    expect(rows()).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    expect(rows()).toHaveLength(2);
    expect(screen.getByRole("button", { name: "삭제" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.change(screen.getByLabelText("레코드 필터"), { target: { value: "shipped" } });
    expect(rows()).toEqual(["pk=order#3"]);
  });

  it("레코드를 펼치면 바뀐 속성을 이전·새 이미지로 맞대 보이고, 이미지가 없으면 그렇게 말한다", async () => {
    api.poll.mockResolvedValueOnce(
      page(
        record("1", { event: "MODIFY", oldImage: { status: { S: "NEW" }, id: { S: "1" } }, newImage: { status: { S: "PAID" }, id: { S: "1" } } }),
        record("2", { event: "MODIFY" }),
      ),
    );
    await start();
    await flush(POLL_INTERVAL_MS);

    const [keysOnly, withImages] = screen.getAllByText(/order#/, { selector: "summary code" }).map((el) => el.closest("details")!);
    expect(within(keysOnly).getByText("이미지 없음")).toBeInTheDocument();
    const changed = within(withImages).getByText("status").closest("tr")!;
    const unchanged = within(withImages).getByText("id").closest("tr")!;
    expect(changed).toHaveClass("ddb-changed");
    expect(unchanged).not.toHaveClass("ddb-changed");
    expect(within(changed).getByText("NEW")).toBeInTheDocument();
    expect(within(changed).getByText("PAID")).toBeInTheDocument();
  });

  it("새 레코드가 와도 펼쳐 둔 레코드는 그대로 펼쳐져 있다", async () => {
    api.poll.mockResolvedValueOnce(page(record("1", { newImage: { a: { S: "x" } } }))).mockResolvedValueOnce(page(record("2")));
    await start();
    await flush(POLL_INTERVAL_MS);
    const first = screen.getByText(/order#1/, { selector: "summary code" }).closest("details")!;
    first.open = true;

    await flush(POLL_INTERVAL_MS);
    expect(rows()).toHaveLength(2);
    expect(screen.getByText(/order#1/, { selector: "summary code" }).closest("details")).toBe(first);
    expect(first.open).toBe(true);
  });

  it("읽다가 실패하면 오류를 보이고 멈춘다", async () => {
    api.poll.mockRejectedValueOnce({ kind: "other", message: "스트림 세션이 끝났어요" });
    await start();
    await flush(POLL_INTERVAL_MS);

    expect(screen.getByText(/스트림 세션이 끝났어요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "읽기 시작" })).toBeInTheDocument();
    expect(api.stop.mock.calls).toEqual([["s1"]]);
  });
});
