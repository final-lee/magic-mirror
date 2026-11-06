import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../api/client";
import type { Settings } from "../api/types";
import { renderWithClient } from "../test/utils";
import { kvApi } from "./api";
import { ARN, BULL_NOW, kvTarget, sampleBullFlow, sampleBullJob, sampleBullQueue, sampleBullQueueView, sampleBullTopology, sampleBullTransitions, sampleOverview, sampleTargetInfo, serverlessOverview } from "./fixtures";
import { KvTab } from "./KvTab";
import type { KvBullJobRow, KvBullQueue } from "./types";

vi.mock("./api", () => ({
  kvApi: {
    target: vi.fn(),
    open: vi.fn(),
    overview: vi.fn(),
    scan: vi.fn(),
    key: vi.fn(),
    slowlog: vi.fn(),
    clients: vi.fn(),
    bigkeys: vi.fn(),
    bigkeysStop: vi.fn(),
    bigkeysReport: vi.fn(async () => null),
    close: vi.fn(),
    forgetPassword: vi.fn(),
    bullQueues: vi.fn(),
    bullQueueSummaries: vi.fn(),
    bullQueue: vi.fn(),
    bullJobs: vi.fn(),
    bullJob: vi.fn(),
    bullFlow: vi.fn(),
    bullTransitions: vi.fn(),
    bullTopology: vi.fn(),
  },
}));
vi.mock("../api/client", () => ({ api: { getSettings: vi.fn(), saveSettings: vi.fn(), ssoLogin: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(async () => {}), openUrl: vi.fn() } }));
vi.mock("../explorer/api", () => ({ onMouseNav: vi.fn(async () => () => {}) }));

const m = vi.mocked(kvApi);
const lastOf = <T,>(items: T[]) => items[items.length - 1];
const lastSaved = () => lastOf(vi.mocked(api.saveSettings).mock.calls)[0];
const tail = (completed: number, failed: number) => ({ completed: [...Array(45).fill(0), ...Array(15).fill(completed)], failed: [...Array(45).fill(0), ...Array(15).fill(failed)] });
const emails = sampleBullQueue({ recent: tail(30, 0) });
const reports = sampleBullQueue({ name: "reports", workers: 0, counts: { ...emails.counts, wait: 220, active: 0, failed: 0 }, recent: tail(0, 0) });
const webhooks = sampleBullQueue({ name: "webhooks", paused: true, counts: { ...emails.counts, paused: 40, wait: 0 }, workers: 2, recent: tail(10, 1) });

function settings(extra: Partial<Settings> = {}): Settings {
  return { enabledServices: ["elasticache"], favorites: [], lastProfile: "prod", lastRegion: null, kvLogins: { [ARN]: { mode: "user", user: "app-reader", database: 0 } }, ...extra };
}

const job = (id: string, state: KvBullJobRow["state"], over: Partial<KvBullJobRow> = {}): KvBullJobRow => ({
  id, name: "send-welcome", state, timestamp: BULL_NOW - 600_000, processedOn: BULL_NOW - 590_000, finishedOn: BULL_NOW - 588_000,
  attemptsMade: 3, progress: "40", failedReason: "connect ECONNREFUSED 10.0.8.4:587", delayUntil: null, priority: null, ...over,
});

const menu = () => within(screen.getByRole("navigation", { name: "Valkey·Redis 메뉴" }));
const openBull = async () => {
  await screen.findByRole("navigation", { name: "Valkey·Redis 메뉴" });
  fireEvent.click(menu().getByRole("button", { name: "Bull" }));
};
const cardNames = () => [...document.querySelectorAll(".kv-qname")].map((e) => e.textContent);

function setup() {
  return renderWithClient(<KvTab target={kvTarget} active />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSettings).mockResolvedValue(settings());
  vi.mocked(api.saveSettings).mockResolvedValue(undefined);
  m.target.mockResolvedValue(sampleTargetInfo());
  m.open.mockResolvedValue(sampleOverview());
  m.overview.mockResolvedValue(sampleOverview());
  m.scan.mockResolvedValue({ keys: [], cursor: null, scanned: 0 });
  m.close.mockResolvedValue(null);
  m.bullQueues.mockResolvedValue({ queues: [emails, reports, webhooks], scanned: 1500, truncated: false, cursor: null });
  m.bullQueue.mockImplementation(async (_t, _p, name) => sampleBullQueueView({ queue: { ...emails, name } }));
  m.bullJobs.mockImplementation(async (_t, _p, _n, state) => ({ jobs: [job("184", state), job("183", state, { progress: '{"step":2}', failedReason: null })], total: 2 }));
  m.bullJob.mockImplementation(async (_t, _p, _n, id) => sampleBullJob({ id }));
  m.bullFlow.mockResolvedValue(sampleBullFlow());
  m.bullTransitions.mockResolvedValue(sampleBullTransitions());
  m.bullTopology.mockResolvedValue(sampleBullTopology());
});

describe("menu", () => {
  test("🐂 Bull is right after 키", async () => {
    setup();
    const nav = await screen.findByRole("navigation", { name: "Valkey·Redis 메뉴" });
    const labels = within(nav).getAllByRole("button").map((b) => b.textContent);
    expect(labels.slice(0, 3)).toEqual(["🔑키", "🐂Bull", "📊개요"]);
  });
});

describe("queue list", () => {
  test("finds the queues under the prefix and shows a card for each", async () => {
    setup();
    await openBull();
    await screen.findByText("webhooks");
    expect(m.bullQueues).toHaveBeenCalledWith(kvTarget, "bull", null);
    expect(screen.getByText("큐 3개 · 훑은 키 1,500개")).toBeInTheDocument();
    const emailsCard = screen.getByRole("button", { name: "emails 개요" });
    expect(emailsCard).toHaveTextContent("BullMQ 5.12.0");
    expect(emailsCard).toHaveTextContent("완료 18,420");
    expect(emailsCard).toHaveTextContent("실패 7");
    expect(emailsCard).toHaveTextContent("워커 3");
    expect(within(emailsCard).getByRole("img", { name: "emails 최근 60분" })).toBeInTheDocument();
    expect(within(emailsCard).getByRole("img", { name: /대기 12, 처리 중 3, 지연 4/ })).toBeInTheDocument();
  });

  test("problem queues come first with a coloured border and the reason", async () => {
    setup();
    await openBull();
    await screen.findByText("webhooks");
    expect(cardNames()).toEqual(["reports", "webhooks", "emails"]);
    const stalled = screen.getByRole("button", { name: "reports 개요" });
    expect(stalled).toHaveClass("danger");
    expect(stalled).toHaveTextContent("문제 있음");
    expect(stalled).toHaveTextContent("대기 중인 작업이 있는데 워커가 없어요");
    expect(stalled).toHaveTextContent("워커 없음");
    const flaky = screen.getByRole("button", { name: "webhooks 개요" });
    expect(flaky).toHaveClass("warn");
    expect(flaky).toHaveTextContent("일시정지");
    expect(screen.getByRole("button", { name: "emails 개요" })).not.toHaveClass("warn", "danger");
  });

  test("a worker count that cannot be read says unknown, not none", async () => {
    m.bullQueues.mockResolvedValue({ queues: [{ ...emails, workers: null }], scanned: 10, truncated: false, cursor: null });
    setup();
    await openBull();
    expect(await screen.findByRole("button", { name: "emails 개요" })).toHaveTextContent("워커 알 수 없음");
  });

  test("a partial find says so and [이어서 찾기] continues from the cursor", async () => {
    m.bullQueues
      .mockResolvedValueOnce({ queues: [emails], scanned: 500_000, truncated: true, cursor: "c9" })
      .mockResolvedValueOnce({ queues: [reports, emails], scanned: 120_000, truncated: false, cursor: null });
    setup();
    await openBull();
    expect(await screen.findByText("일부만 찾았어요")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "이어서 찾기" }));
    await waitFor(() => expect(m.bullQueues).toHaveBeenLastCalledWith(kvTarget, "bull", "c9"));
    expect(await screen.findByText("큐 2개 · 훑은 키 620,000개")).toBeInTheDocument();
    expect(screen.queryByText("일부만 찾았어요")).not.toBeInTheDocument();
  });

  test("no queues under the prefix says which prefix was searched", async () => {
    m.bullQueues.mockResolvedValue({ queues: [], scanned: 4, truncated: false, cursor: null });
    setup();
    await openBull();
    expect(await screen.findByText(/prefix "bull"에서 큐를 찾지 못했어요/)).toBeInTheDocument();
  });

  test("the prefix is remembered per target, and a new one searches again", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings({ kvBullPrefixes: { [ARN]: "{app}" } }));
    const user = userEvent.setup();
    setup();
    await openBull();
    await screen.findByText("webhooks");
    expect(m.bullQueues).toHaveBeenCalledWith(kvTarget, "{app}", null);
    await user.clear(screen.getByRole("textbox", { name: "prefix" }));
    await user.type(screen.getByRole("textbox", { name: "prefix" }), "jobs{Enter}");
    await waitFor(() => expect(m.bullQueues).toHaveBeenLastCalledWith(kvTarget, "jobs", null));
    await waitFor(() => expect(lastSaved().kvBullPrefixes).toEqual({ [ARN]: "jobs" }));
  });

  test("a queue fails to read: the error shows with a retry", async () => {
    m.bullQueues.mockRejectedValueOnce({ kind: "other", message: "NOPERM scan" });
    setup();
    await openBull();
    expect(await screen.findByText("NOPERM scan")).toBeInTheDocument();
  });

  test("every 5 seconds it re-reads only the queues it found, never the keyspace, and the toggle turns that off", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      m.bullQueueSummaries.mockResolvedValue([{ ...emails, workers: null }, reports, webhooks]);
      setup();
      await openBull();
      await screen.findByText("webhooks");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      expect(m.bullQueueSummaries).toHaveBeenCalledTimes(1);
      expect(m.bullQueueSummaries).toHaveBeenCalledWith(kvTarget, "bull", ["emails", "reports", "webhooks"]);
      expect(await screen.findByRole("button", { name: "emails 개요" })).toHaveTextContent("워커 알 수 없음");
      fireEvent.click(screen.getByRole("checkbox", { name: "5초마다 다시 읽기" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
      });
      expect(m.bullQueueSummaries).toHaveBeenCalledTimes(1);
      expect(m.bullQueues).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("[다시 읽기] sweeps the keyspace again and its result replaces the timer's", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      m.bullQueueSummaries.mockResolvedValue([emails, reports, webhooks]);
      setup();
      await openBull();
      await screen.findByText("webhooks");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      m.bullQueues.mockResolvedValue({ queues: [emails, reports, webhooks, sampleBullQueue({ name: "invoices" })], scanned: 1600, truncated: false, cursor: null });
      fireEvent.click(within(screen.getByRole("region", { name: "Bull 큐" })).getByRole("button", { name: "다시 읽기" }));
      expect(await screen.findByText("invoices")).toBeInTheDocument();
      expect(m.bullQueues).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a first sweep cut short before any queue turned up says to keep looking, not that the prefix is wrong", async () => {
    m.bullQueues.mockResolvedValue({ queues: [], scanned: 5_000_000, truncated: true, cursor: "c1" });
    setup();
    await openBull();
    expect(await screen.findByText("아직 키의 일부만 훑었어요. [이어서 찾기]로 나머지를 찾아 주세요")).toBeInTheDocument();
    expect(screen.queryByText(/에서 큐를 찾지 못했어요/)).not.toBeInTheDocument();
  });
});

describe("queue detail", () => {
  async function openQueue(name = "emails") {
    setup();
    await openBull();
    fireEvent.click(await screen.findByRole("button", { name: `${name} 개요` }));
    return screen.findByRole("group", { name: "상태별 작업 수" });
  }

  test("opens from a card with the counts of every state and the facts", async () => {
    // "…전"·"…뒤"는 지금 시각과 비교한다: 시계를 fixture의 지금(BULL_NOW)에 맞춘다
    vi.useFakeTimers({ toFake: ["Date"], now: BULL_NOW });
    try {
      const tiles = within(await openQueue());
      expect(m.bullQueue).toHaveBeenCalledWith(kvTarget, "bull", "emails");
      expect(tiles.getByRole("button", { name: /대기\s*12/ })).toBeInTheDocument();
      expect(tiles.getByRole("button", { name: /처리 중\s*3/ })).toBeInTheDocument();
      expect(tiles.getByRole("button", { name: /실패\s*7/ })).toBeInTheDocument();
      expect(tiles.getByRole("button", { name: /완료\s*18,420/ })).toBeInTheDocument();
      const fact = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling;
      expect(fact("반복 작업")).toHaveTextContent("2");
      expect(fact("워커")).toHaveTextContent("3");
      expect(fact("가장 오래 기다린 작업")).toHaveTextContent(/전$/);
      expect(fact("다음 지연 작업")).toHaveTextContent(/뒤$/);
      expect(within(screen.getByRole("navigation", { name: "현재 위치" })).getByText("emails")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test("shows the throughput, the timing percentiles with their distribution, the failure reasons and the workers", async () => {
    await openQueue();
    expect(screen.getByRole("img", { name: /최근 60분\(분당\): 완료 450건, 실패 0건/ })).toBeInTheDocument();
    const wait = screen.getByText("대기 시간").parentElement!;
    expect(wait).toHaveTextContent("p50120ms");
    expect(wait).toHaveTextContent("p951.8초");
    expect(wait).toHaveTextContent("최대4.2초");
    expect(within(wait).getByRole("group", { name: "대기 시간 분포" })).toHaveTextContent("≤ 100ms41");
    expect(screen.getByText("처리 시간").parentElement).toHaveTextContent("p50340ms");
    expect(screen.getByText("최근 끝난 작업 100개 기준")).toBeInTheDocument();
    const reasons = screen.getByRole("table", { name: "실패 이유" });
    expect(reasons).toHaveTextContent("connect ECONNREFUSED 10.0.8.4:587");
    expect(reasons).toHaveTextContent("5");
    const workers = screen.getByRole("table", { name: "워커" });
    expect(workers).toHaveTextContent("bull:ZW1haWxz:w:mailer-1");
    expect(workers).toHaveTextContent("10.0.4.7:51200");
    expect(workers).toHaveTextContent("2시간");
  });

  test("the 24 hour chart shows when the queue has metrics", async () => {
    m.bullQueue.mockResolvedValue(sampleBullQueueView({ daily: { start: BULL_NOW - 1439 * 60_000, completed: Array(1440).fill(2), failed: Array(1440).fill(0) } }));
    await openQueue();
    expect(screen.getByRole("img", { name: /최근 24시간\(10분당\): 완료 2,880건/ })).toBeInTheDocument();
  });

  test("without metrics there is no 24 hour chart, and without samples the timing says so", async () => {
    m.bullQueue.mockResolvedValue(sampleBullQueueView({ daily: null, waitMs: null, processMs: null, samples: 0, waitHistogram: [], processHistogram: [], failedReasons: [], workers: null }));
    await openQueue();
    expect(screen.queryByRole("img", { name: /24시간/ })).not.toBeInTheDocument();
    expect(screen.getAllByText("끝난 작업이 없어요")).toHaveLength(2);
    expect(screen.getByText("최근 실패가 없어요")).toBeInTheDocument();
    expect(screen.getByText("서버리스 캐시는 연결 목록을 볼 수 없어 워커 수를 알 수 없어요")).toBeInTheDocument();
  });

  test("the job table opens on failed (there are failures), and a state tile switches it", async () => {
    await openQueue();
    await waitFor(() => expect(m.bullJobs).toHaveBeenCalledWith(kvTarget, "bull", "emails", "failed", 0, 50));
    const table = await screen.findByRole("table", { name: "작업 표" });
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("send-welcome");
    expect(rows[1]).toHaveTextContent("184");
    expect(rows[1]).toHaveTextContent("connect ECONNREFUSED");
    expect(within(rows[1]).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    expect(rows[2]).toHaveTextContent('{"step":2}');
    fireEvent.click(within(screen.getByRole("group", { name: "상태별 작업 수" })).getByRole("button", { name: /^대기/ }));
    await waitFor(() => expect(m.bullJobs).toHaveBeenCalledWith(kvTarget, "bull", "emails", "wait", 0, 50));
    expect(screen.getByRole("button", { name: /^대기/ })).toHaveAttribute("aria-pressed", "true");
  });

  test("delayed and prioritized jobs show when they run and their priority", async () => {
    m.bullJobs.mockResolvedValue({ jobs: [job("9", "delayed", { delayUntil: BULL_NOW + 60_000, failedReason: null }), job("10", "prioritized", { priority: 3, failedReason: null })], total: 2 });
    await openQueue();
    const table = await screen.findByRole("table", { name: "작업 표" });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("까지");
    expect(within(table).getAllByRole("row")[2]).toHaveTextContent("우선순위 3");
  });

  test("more jobs are read 50 at a time", async () => {
    m.bullJobs
      .mockResolvedValueOnce({ jobs: [job("1", "failed")], total: 120 })
      .mockResolvedValueOnce({ jobs: [job("2", "failed")], total: 120 });
    await openQueue();
    expect(await screen.findByText("1개 / 120개")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "더 읽기" }));
    await waitFor(() => expect(m.bullJobs).toHaveBeenLastCalledWith(kvTarget, "bull", "emails", "failed", 1, 50));
    expect(await screen.findByText("2개 / 120개")).toBeInTheDocument();
  });

  test("a queue with no jobs in the state says so", async () => {
    m.bullJobs.mockResolvedValue({ jobs: [], total: 0 });
    await openQueue();
    expect(await screen.findByText("작업이 없어요")).toBeInTheDocument();
  });

  test("[큐 목록] goes back to the list, and the history does too", async () => {
    await openQueue();
    fireEvent.click(screen.getByRole("button", { name: /큐 목록/ }));
    expect(await screen.findByRole("button", { name: "reports 개요" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(await screen.findByRole("group", { name: "상태별 작업 수" })).toBeInTheDocument();
  });

  test("the queue that cannot be read shows its error", async () => {
    m.bullQueue.mockRejectedValue({ kind: "other", message: "큐 키를 읽을 권한이 없어요" });
    setup();
    await openBull();
    fireEvent.click(await screen.findByRole("button", { name: "emails 개요" }));
    expect(await screen.findByText("큐 키를 읽을 권한이 없어요")).toBeInTheDocument();
  });
});

describe("job detail", () => {
  async function openJob(over = {}) {
    m.bullJob.mockResolvedValue(sampleBullJob(over));
    setup();
    await openBull();
    fireEvent.click(await screen.findByRole("button", { name: "emails 개요" }));
    fireEvent.click(await screen.findByRole("button", { name: "184" }));
    return screen.findByRole("complementary", { name: "상세" });
  }

  test("opens over the queue (the right 70%) with the timeline, attempts and progress", async () => {
    const detail = within(await openJob());
    expect(m.bullJob).toHaveBeenCalledWith(kvTarget, "bull", "emails", "184");
    expect(await detail.findByRole("heading", { name: "#184 send-welcome" })).toBeInTheDocument();
    expect(await detail.findByText("emails · 실패")).toBeInTheDocument();
    const timeline = detail.getByRole("list", { name: "시간선" });
    expect(timeline).toHaveTextContent("만듦");
    expect(timeline).toHaveTextContent("대기 10초");
    expect(timeline).toHaveTextContent("시작");
    expect(timeline).toHaveTextContent("처리 2.0초");
    expect(timeline).toHaveTextContent("끝");
    expect(detail.getByText("시도 횟수").nextElementSibling).toHaveTextContent("3");
    expect(detail.getByRole("progressbar", { name: "진행률" })).toHaveAttribute("aria-valuenow", "40");
    expect(detail.getByRole("alert")).toHaveTextContent("connect ECONNREFUSED 10.0.8.4:587");
    // 큐 상세는 그대로 아래에 있다
    expect(screen.getByRole("group", { name: "상태별 작업 수" })).toBeInTheDocument();
  });

  test("shows the data, options, stacktrace and logs; JSON as a tree", async () => {
    const detail = within(await openJob({ returnvalue: '{"sent":true}' }));
    expect(await detail.findByText('"template"')).toBeInTheDocument();
    expect(detail.getByText('"welcome"')).toBeInTheDocument();
    expect(detail.getByText('"attempts"')).toBeInTheDocument();
    expect(detail.getByText('"sent"')).toBeInTheDocument();
    expect(detail.getByText(/Error: connect ECONNREFUSED 10.0.8.4:587\s+at TCPConnectWrap/)).toBeInTheDocument();
    expect(detail.getByText(/connecting to smtp\s+retrying in 2s/)).toBeInTheDocument();
    expect(detail.getByText("최근 100줄", { exact: false })).toBeInTheDocument();
  });

  test("data that does not parse is shown as text, with the truncation note", async () => {
    const detail = within(await openJob({ data: "plain text payload", dataTruncated: true }));
    expect(await detail.findByText("plain text payload")).toBeInTheDocument();
    expect(detail.getByText("앞 1MiB만 보여요")).toBeInTheDocument();
  });

  test("a job that is still waiting has no finish time", async () => {
    const detail = within(await openJob({ state: "wait", processedOn: null, finishedOn: null, failedReason: null, stacktrace: [], logs: [], progress: null }));
    const timeline = await detail.findByRole("list", { name: "시간선" });
    expect(within(timeline).getAllByText("—")).toHaveLength(2);
    expect(detail.queryByRole("alert")).not.toBeInTheDocument();
    expect(detail.queryByText("진행률")).not.toBeInTheDocument();
  });

  test("the flow: the parent opens the parent job in its own queue", async () => {
    const detail = within(
      await openJob({ parent: { queueKey: "bull:orders", id: "77" }, children: [{ key: "bull:emails:185", done: true, result: '"ok"' }, { key: "bull:emails:186", done: false, result: null }] }),
    );
    expect(await detail.findByText("끝남")).toBeInTheDocument();
    expect(detail.getByText("남음")).toBeInTheDocument();
    m.bullJob.mockResolvedValue(sampleBullJob({ id: "77", name: "place-order" }));
    fireEvent.click(detail.getByRole("button", { name: "bull:orders:77" }));
    await waitFor(() => expect(m.bullQueue).toHaveBeenCalledWith(kvTarget, "bull", "orders"));
    await waitFor(() => expect(m.bullJob).toHaveBeenLastCalledWith(kvTarget, "bull", "orders", "77"));
    expect(await screen.findByRole("heading", { name: "#77 place-order" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "현재 위치" })).getByText("orders")).toBeInTheDocument();
  });

  test("a child opens its job in the same queue", async () => {
    const detail = within(await openJob({ children: [{ key: "bull:emails:185", done: true, result: "1" }] }));
    m.bullJob.mockResolvedValue(sampleBullJob({ id: "185", name: "child" }));
    fireEvent.click(await detail.findByRole("button", { name: "bull:emails:185" }));
    expect(await screen.findByRole("heading", { name: "#185 child" })).toBeInTheDocument();
  });

  test("closing the job leaves the queue, and back/forward walk the history", async () => {
    const detail = within(await openJob());
    fireEvent.click(detail.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("complementary", { name: "상세" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "상태별 작업 수" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(await screen.findByRole("complementary", { name: "상세" })).toBeInTheDocument();
  });

  test("a job that cannot be read shows why", async () => {
    m.bullJob.mockRejectedValue({ kind: "other", message: "작업 184를 찾지 못했어요" });
    setup();
    await openBull();
    fireEvent.click(await screen.findByRole("button", { name: "emails 개요" }));
    fireEvent.click(await screen.findByRole("button", { name: "184" }));
    expect(await screen.findByText("작업 184를 찾지 못했어요")).toBeInTheDocument();
  });
});

describe("serverless", () => {
  test("queues are found as on any cache; the worker count is unknown", async () => {
    const info = sampleTargetInfo({ arn: "arn:aws:elasticache:ap-northeast-2:123456789012:serverlesscache:feature-flags", identifier: "feature-flags", kind: "serverlessCache", serverless: true, userGroupIds: [], users: null });
    vi.mocked(api.getSettings).mockResolvedValue(settings({ kvLogins: { [info.arn]: { mode: "none", user: "", database: 0 } } }));
    m.target.mockResolvedValue(info);
    m.open.mockResolvedValue(serverlessOverview());
    const queues: KvBullQueue[] = [{ ...emails, workers: null }];
    m.bullQueues.mockResolvedValue({ queues, scanned: 10, truncated: false, cursor: null });
    m.bullQueue.mockResolvedValue(sampleBullQueueView({ queue: queues[0], workers: null }));
    setup();
    await openBull();
    fireEvent.click(await screen.findByRole("button", { name: "emails 개요" }));
    expect(await screen.findByText("서버리스 캐시는 연결 목록을 볼 수 없어 워커 수를 알 수 없어요")).toBeInTheDocument();
  });
});
