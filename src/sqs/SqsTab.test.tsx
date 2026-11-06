import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/client";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { sqsApi } from "./api";
import { SqsTab } from "./SqsTab";
import type { FlowNode, SqsFlow, SqsFinding, SqsOverview, SqsQueue } from "./types";

vi.mock("./api", () => ({
  sqsApi: { overview: vi.fn(), queue: vi.fn(), flow: vi.fn(), regionFlow: vi.fn() },
}));
vi.mock("../api/client", () => ({ api: { resourceMetrics: vi.fn() } }));
// 메시지·변경 화면은 따로 시험한다. 여기서는 탭이 어떤 큐를 넘기는지만 본다.
vi.mock("./messages/Messages", () => ({ Messages: ({ queue }: { queue: SqsQueue }) => <div>메시지 화면 {queue.name}</div> }));
vi.mock("./change/QueueActions", () => ({ QueueActions: ({ queue }: { queue: SqsQueue }) => <div>작업 {queue.name}</div> }));
vi.mock("./change/DlqRedrive", () => ({ DlqRedrive: ({ queue }: { queue: SqsQueue }) => <div>재처리 {queue.name}</div> }));
vi.mock("./change/SqsChangeLog", () => ({ SqsChangeLog: ({ url }: { url: string | null }) => <div>기록 {url}</div> }));

const m = vi.mocked(sqsApi);
const arn = (name: string) => `arn:aws:sqs:ap-northeast-2:111122223333:${name}`;
const url = (name: string) => `https://sqs.ap-northeast-2.amazonaws.com/111122223333/${name}`;
const finding = (id: SqsFinding["id"], level: SqsFinding["level"], summary: string): SqsFinding => ({ id, level, summary, detail: null });

function queue(name: string, over: Partial<SqsQueue> = {}): SqsQueue {
  return {
    url: url(name), arn: arn(name), name, fifo: false, visible: 0, inFlight: 0, delayed: 0, visibilityTimeout: 30, retention: 345600, delay: 0, maxSize: 262144,
    waitTime: 0, redrive: null, redriveAllow: null, sseManaged: true, kmsKey: null, contentDedup: null, dedupScope: null, throughputLimit: null, policy: null,
    createdAt: null, modifiedAt: null, sources: [], isDlq: false, activity: null, tags: {}, findings: [], error: null, ...over,
  };
}

const orders = queue("orders", { redrive: { dlqArn: arn("orders-dlq"), maxReceiveCount: 5 }, findings: [finding("dlqBacklog", "fail", "DLQ orders-dlq에 3개가 쌓여 있어요")] });
const ordersDlq = queue("orders-dlq", { isDlq: true, visible: 3, sources: [arn("orders")], findings: [finding("dlqBacklog", "fail", "DLQ에 메시지가 쌓여 있어요")] });
const mails = queue("mails");
const overview = (queues: SqsQueue[]): SqsOverview => ({ queues, truncated: false, activityAt: null, activityError: null });

const node = (over: Partial<FlowNode>): FlowNode => ({ kind: "sns", id: "n", label: "n", state: null, allowedByPolicy: null, crossAccount: false, detail: [], jump: null, ...over });
const flow = (over: Partial<SqsFlow> = {}): SqsFlow => ({ producers: [], consumers: [], dlq: null, sources: [], policy: [], findings: [], gaps: [], iam: false, ...over });

function setup(props: { active?: boolean; focus?: { url: string; nonce: number } | null; onJump?: () => void } = {}) {
  const ui = (p: typeof props) => withClientAndSso(<SqsTab profile="personal" region="ap-northeast-2" active={p.active ?? true} focus={p.focus ?? null} onJump={p.onJump ?? vi.fn()} />, qc, ssoLoginStub());
  const qc = newQueryClient();
  const view = render(ui(props));
  return { ...view, rerenderWith: (p: typeof props) => view.rerender(ui(p)) };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.overview.mockResolvedValue(overview([mails, ordersDlq, orders]));
  m.queue.mockImplementation(async (_p, _r, u) => [mails, ordersDlq, orders].find((q) => q.url === u)!);
  m.flow.mockResolvedValue(flow());
  vi.mocked(api.resourceMetrics).mockReturnValue(new Promise(() => {}));
});

const row = (name: string) => screen.getByRole("option", { name: new RegExp(name) });

describe("SqsTab 목록", () => {
  it("원본 큐 아래에 DLQ를 들여 쓰고, 문제 있는 큐만 거를 수 있다", async () => {
    setup();
    await screen.findByRole("option", { name: /orders-dlq/ });
    expect(screen.getAllByRole("option").map((o) => o.textContent?.match(/^(mails|orders-dlq|orders)/)?.[1])).toEqual(["mails", "orders", "orders-dlq"]);
    expect(row("orders-dlq")).toHaveClass("nested");

    fireEvent.click(screen.getByRole("button", { name: /문제 있는 큐만/ }));
    expect(screen.queryByRole("option", { name: /mails/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("큐를 고르면 그 큐의 진단을 보이고, 흐름·메시지·기록 탭이 그 큐를 받는다", async () => {
    setup();
    fireEvent.click(await screen.findByRole("option", { name: /orders-dlq/ }));
    expect(await screen.findByText("DLQ에 메시지가 쌓여 있어요")).toBeInTheDocument();
    expect(screen.getByText("재처리 orders-dlq")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "메시지" }));
    expect(screen.getByText("메시지 화면 orders-dlq")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "기록" }));
    expect(screen.getByText(`기록 ${url("orders-dlq")}`)).toBeInTheDocument();
  });

  it("리소스 목록에서 연 큐(focus)를 고르고, 같은 큐를 다시 열어도 개요로 돌아온다", async () => {
    const { rerenderWith } = setup({ focus: { url: url("mails"), nonce: 1 } });
    expect(await screen.findByRole("heading", { name: "mails" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "흐름" }));
    expect(screen.getByRole("tab", { name: "흐름" })).toHaveAttribute("aria-selected", "true");

    rerenderWith({ focus: { url: url("mails"), nonce: 2 } });
    await waitFor(() => expect(screen.getByRole("tab", { name: "개요" })).toHaveAttribute("aria-selected", "true"));
  });

  it("큐 목록을 읽지 못하면 오류를 보인다", async () => {
    m.overview.mockRejectedValueOnce({ kind: "other", message: "권한이 없어요" });
    setup();
    expect(await screen.findByText(/권한이 없어요/)).toBeInTheDocument();
  });
});

describe("SqsTab 흐름", () => {
  it("정책이 허용하지 않는 생산자를 빨갛게 알리고, IAM 계산은 버튼을 눌러야 읽는다", async () => {
    m.flow.mockImplementation(async (_p, _r, _u, withIam) =>
      flow({
        iam: withIam,
        producers: [node({ kind: "sns", id: "t1", label: "alerts", allowedByPolicy: false }), node({ kind: "rule", id: "r1", label: "nightly", allowedByPolicy: true, crossAccount: true })],
        consumers: withIam ? [node({ kind: "principal", id: "role", label: "worker-role" })] : [],
        findings: [finding("subscriptionDenied", "fail", "큐 정책이 SNS 토픽 alerts를 허용하지 않아요")],
        gaps: [{ section: "Pipes", error: "권한이 없어요" }],
      }),
    );
    setup({ focus: { url: url("mails"), nonce: 1 } });
    fireEvent.click(await screen.findByRole("tab", { name: "흐름" }));

    const denied = (await screen.findByText("alerts")).closest(".sqs-node") as HTMLElement;
    expect(within(denied).getByText("정책이 허용하지 않아요")).toBeInTheDocument();
    const cross = screen.getByText("nightly").closest(".sqs-node") as HTMLElement;
    expect(within(cross).getByText("다른 계정")).toBeInTheDocument();
    expect(screen.getByText("큐 정책이 SNS 토픽 alerts를 허용하지 않아요")).toBeInTheDocument();
    expect(screen.getByText("Pipes: 권한이 없어요")).toBeInTheDocument();
    expect(m.flow).toHaveBeenCalledTimes(1);
    expect(m.flow).toHaveBeenLastCalledWith("personal", "ap-northeast-2", url("mails"), false);

    fireEvent.click(screen.getByRole("button", { name: "IAM으로 계산" }));
    expect(await screen.findByText("worker-role")).toBeInTheDocument();
    expect(m.flow).toHaveBeenLastCalledWith("personal", "ap-northeast-2", url("mails"), true);
  });

  it("노드의 이동 버튼은 큐는 탭 안에서, 나머지는 앱으로 넘긴다", async () => {
    const onJump = vi.fn();
    m.flow.mockResolvedValue(
      flow({
        producers: [node({ kind: "sns", id: "t1", label: "alerts", jump: { kind: "resource", service: "sns", type: "topics", id: arn("alerts") } })],
        sources: [node({ kind: "queue", id: arn("orders"), label: "orders", jump: { kind: "queue", url: url("orders") } })],
      }),
    );
    setup({ focus: { url: url("orders-dlq"), nonce: 1 }, onJump });
    fireEvent.click(await screen.findByRole("tab", { name: "흐름" }));

    fireEvent.click(await screen.findByRole("button", { name: "alerts 열기" }));
    expect(onJump).toHaveBeenCalledWith({ kind: "resource", service: "sns", type: "topics", id: arn("alerts") });

    fireEvent.click(screen.getByRole("button", { name: "orders 열기" }));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: "orders" })).toBeInTheDocument();
  });
});

describe("SqsTab 폴링", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("보일 때만 목록은 30초, 고른 큐는 5초마다 다시 읽는다", async () => {
    const { rerenderWith } = setup({ focus: { url: url("mails"), nonce: 1 } });
    await screen.findByRole("heading", { name: "mails" });
    await waitFor(() => expect(m.queue).toHaveBeenCalledTimes(1));
    await act(() => vi.advanceTimersByTimeAsync(5_100));
    expect(m.queue).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(25_000));
    expect(m.overview).toHaveBeenCalledTimes(2);

    // 다른 탭으로 가면 멈춘다
    rerenderWith({ active: false, focus: { url: url("mails"), nonce: 1 } });
    const queueCalls = m.queue.mock.calls.length;
    const overviewCalls = m.overview.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(m.queue).toHaveBeenCalledTimes(queueCalls);
    expect(m.overview).toHaveBeenCalledTimes(overviewCalls);
  });
});
