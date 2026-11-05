import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../api/client";
import type { Settings } from "../api/types";
import { renderWithClient } from "../test/utils";
import { kvApi } from "./api";
import { ARN, BULL_NOW, clientRows, kvTarget, nodeInfo, sampleBullFlow, sampleBullJob, sampleBullQueue, sampleBullQueueView, sampleBullTopology, sampleBullTransitions, sampleOverview, sampleTargetInfo, serverlessOverview } from "./fixtures";
import { KvTab } from "./KvTab";
import type { KvClient, KvNode } from "./types";

vi.mock("./api", () => ({
  kvApi: {
    target: vi.fn(), open: vi.fn(), overview: vi.fn(), scan: vi.fn(), key: vi.fn(), slowlog: vi.fn(), clients: vi.fn(), bigkeys: vi.fn(), bigkeysStop: vi.fn(), close: vi.fn(), forgetPassword: vi.fn(),
    bullQueues: vi.fn(), bullQueue: vi.fn(), bullJobs: vi.fn(), bullJob: vi.fn(), bullFlow: vi.fn(), bullTransitions: vi.fn(), bullTopology: vi.fn(),
  },
}));
vi.mock("../api/client", () => ({ api: { getSettings: vi.fn(), saveSettings: vi.fn(), ssoLogin: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(async () => {}), openUrl: vi.fn() } }));
vi.mock("../explorer/api", () => ({ onMouseNav: vi.fn(async () => () => {}) }));

const m = vi.mocked(kvApi);
const settings = (): Settings => ({ enabledServices: ["elasticache"], favorites: [], lastProfile: "prod", lastRegion: null, kvLogins: { [ARN]: { mode: "user", user: "app-reader", database: 0 } } });
const menu = () => within(screen.getByRole("navigation", { name: "Valkey·Redis 메뉴" }));
const openMenu = (label: string) => fireEvent.click(menu().getByRole("button", { name: new RegExp(`^${label}$`) }));
const emails = sampleBullQueue();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSettings).mockResolvedValue(settings());
  vi.mocked(api.saveSettings).mockResolvedValue(undefined);
  m.target.mockResolvedValue(sampleTargetInfo());
  m.open.mockResolvedValue(sampleOverview());
  m.overview.mockResolvedValue(sampleOverview());
  m.scan.mockResolvedValue({ keys: [], cursor: null, scanned: 0 });
  m.clients.mockResolvedValue(clientRows);
  m.close.mockResolvedValue(null);
  m.bullQueues.mockResolvedValue({ queues: [emails], scanned: 10, truncated: false, cursor: null });
  m.bullQueue.mockResolvedValue(sampleBullQueueView());
  m.bullJobs.mockResolvedValue({ jobs: [], total: 0 });
  m.bullJob.mockImplementation(async (_t, _p, _n, id) => sampleBullJob({ id, parent: { queueKey: "bull:orders", id: "77" } }));
  m.bullFlow.mockResolvedValue(sampleBullFlow());
  m.bullTransitions.mockResolvedValue(sampleBullTransitions());
  m.bullTopology.mockResolvedValue(sampleBullTopology());
});

async function openBullView() {
  renderWithClient(<KvTab target={kvTarget} active />);
  await screen.findByRole("navigation", { name: "Valkey·Redis 메뉴" });
  openMenu("Bull");
}
async function openQueue() {
  await openBullView();
  fireEvent.click(await screen.findByRole("button", { name: "emails 개요" }));
  return screen.findByRole("group", { name: "상태 전이" });
}

describe("flow graph in the job overlay", () => {
  async function openJob() {
    m.bullJobs.mockResolvedValue({ jobs: [{ id: "185", name: "send-receipt", state: "failed", timestamp: BULL_NOW, processedOn: null, finishedOn: null, attemptsMade: 1, progress: null, failedReason: "x", delayUntil: null, priority: null }], total: 1 });
    await openQueue();
    fireEvent.click(await screen.findByRole("button", { name: "185" }));
    return within(await screen.findByRole("complementary", { name: "상세" }));
  }

  test("a job with a parent draws the whole flow: the nodes, the focus and the edge styles", async () => {
    const detail = await openJob();
    await waitFor(() => expect(m.bullFlow).toHaveBeenCalledWith(kvTarget, "bull", "emails", "185"));
    const graph = within(await detail.findByRole("img", { name: "작업 흐름 그래프" }));
    expect(graph.getByRole("button", { name: /send-receipt emails · #185 완료/ })).toHaveAttribute("aria-current", "true");
    expect(graph.getByRole("button", { name: /place-order orders · #77 자식 기다림/ })).toBeInTheDocument();
    expect(graph.getByRole("button", { name: /charge-card payments · #301 실패/ })).toBeInTheDocument();
    expect(graph.getByText("orders · #77")).toBeInTheDocument();
    expect(graph.getByText(/남음 1 · 끝 1 · 실패 1/)).toBeInTheDocument();
    const edges = [...document.querySelectorAll(".kvg-flow .kvg-edge")].map((e) => e.getAttribute("class"));
    expect(edges.filter((c) => c!.includes("kvg-tone-good"))).toHaveLength(1);
    expect(edges.filter((c) => c!.includes("kvg-tone-bad"))).toHaveLength(1);
    expect(edges.filter((c) => c!.includes("kvg-tone-warn"))).toHaveLength(1);
    expect(document.querySelectorAll(".kvg-flow .kvg-edge path[stroke-dasharray='6 4']")).toHaveLength(1);
  });

  test("clicking a node opens that job, in another queue too", async () => {
    const detail = await openJob();
    m.bullJob.mockImplementation(async (_t, _p, _n, id) => sampleBullJob({ id, name: id === "301" ? "charge-card" : "x" }));
    fireEvent.click(await detail.findByRole("button", { name: /charge-card payments · #301/ }));
    await waitFor(() => expect(m.bullJob).toHaveBeenLastCalledWith(kvTarget, "bull", "payments", "301"));
    await waitFor(() => expect(m.bullQueue).toHaveBeenLastCalledWith(kvTarget, "bull", "payments"));
    expect(await screen.findByRole("heading", { name: "#301 charge-card" })).toBeInTheDocument();
  });

  test("a job that is gone from the flow is drawn but cannot be opened", async () => {
    const base = sampleBullFlow();
    m.bullFlow.mockResolvedValue({ ...base, nodes: base.nodes.map((n) => (n.id === "412" ? { ...n, state: "missing" as const } : n)) });
    const detail = await openJob();
    await detail.findByRole("img", { name: "작업 흐름 그래프" });
    expect(screen.queryByRole("button", { name: /ship shipping · #412/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/ship shipping · #412 없음/)).toBeInTheDocument();
  });

  test("[크게 보기] shows the flow over the whole queue screen, and a node there opens its job and closes it", async () => {
    const detail = await openJob();
    await detail.findByRole("img", { name: "작업 흐름 그래프" });
    fireEvent.click(detail.getByRole("button", { name: "크게 보기" }));
    const big = within(await screen.findByRole("dialog", { name: /흐름 그래프 emails · #185/ }));
    m.bullJob.mockImplementation(async (_t, _p, _n, id) => sampleBullJob({ id, name: "ship" }));
    fireEvent.click(await big.findByRole("button", { name: /ship shipping · #412/ }));
    expect(screen.queryByRole("dialog", { name: /흐름 그래프/ })).not.toBeInTheDocument();
    await waitFor(() => expect(m.bullJob).toHaveBeenLastCalledWith(kvTarget, "bull", "shipping", "412"));
  });

  test("the big view closes with 닫기", async () => {
    const detail = await openJob();
    await detail.findByRole("img", { name: "작업 흐름 그래프" });
    fireEvent.click(detail.getByRole("button", { name: "크게 보기" }));
    const big = within(await screen.findByRole("dialog"));
    fireEvent.click(big.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("a job without a flow reads none", async () => {
    m.bullJob.mockImplementation(async (_t, _p, _n, id) => sampleBullJob({ id, parent: null, children: [] }));
    await openJob();
    expect(m.bullFlow).not.toHaveBeenCalled();
    expect(screen.queryByRole("img", { name: "작업 흐름 그래프" })).not.toBeInTheDocument();
  });

  test("a truncated flow says only the first nodes were drawn", async () => {
    m.bullFlow.mockResolvedValue(sampleBullFlow({ truncated: true }));
    const detail = await openJob();
    expect(await detail.findByText("흐름이 커서 앞쪽 노드만 그렸어요")).toBeInTheDocument();
  });
});

describe("상태 전이 in the queue detail", () => {
  test("draws a node per state with the current count, and an edge per pair with its count", async () => {
    const panel = within(await openQueue());
    await waitFor(() => expect(m.bullTransitions).toHaveBeenCalledWith(kvTarget, "bull", "emails", 60));
    const graph = within(await panel.findByRole("img", { name: "상태 전이" }));
    expect(graph.getByRole("group", { name: "대기 12" })).toBeInTheDocument();
    expect(graph.getByRole("group", { name: "처리 중 3" })).toBeInTheDocument();
    expect(graph.getByRole("group", { name: "실패 7" })).toBeInTheDocument();
    expect(graph.getByText("990")).toBeInTheDocument();
    expect(graph.getByText("930")).toBeInTheDocument();
    expect(panel.getByText("이벤트 5,000개 · 전이 3,035회")).toBeInTheDocument();
  });

  test("stalled and retries-exhausted are highlighted", async () => {
    const panel = within(await openQueue());
    await panel.findByRole("img", { name: "상태 전이" });
    expect(panel.getByRole("note", { name: "정체 3" })).toBeInTheDocument();
    expect(panel.getByRole("note", { name: "재시도 소진 6" })).toBeInTheDocument();
    expect(panel.getAllByText("정체 3")).toHaveLength(2);
    expect(document.querySelectorAll(".kv-transitions .kvg-tone-bad path[stroke-dasharray]")).toHaveLength(1);
    expect(panel.getByText(/그 밖의 이벤트 progress 700/)).toBeInTheDocument();
  });

  test("the window picker reads another window", async () => {
    const panel = within(await openQueue());
    expect(await panel.findByRole("button", { name: "1시간" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(panel.getByRole("button", { name: "6시간" }));
    await waitFor(() => expect(m.bullTransitions).toHaveBeenLastCalledWith(kvTarget, "bull", "emails", 360));
    fireEvent.click(panel.getByRole("button", { name: "15분" }));
    await waitFor(() => expect(m.bullTransitions).toHaveBeenLastCalledWith(kvTarget, "bull", "emails", 15));
  });

  test("says how little the stream holds when it was trimmed", async () => {
    m.bullTransitions.mockResolvedValue(sampleBullTransitions({ firstAt: BULL_NOW - 18 * 60_000 }));
    const panel = within(await openQueue());
    expect(await panel.findByText("스트림에 남은 최근 18분만 보여요")).toBeInTheDocument();
  });

  test("says when the read cap was hit, and when there were no events", async () => {
    m.bullTransitions.mockResolvedValue(sampleBullTransitions({ truncated: true, events: 20_000 }));
    const panel = within(await openQueue());
    expect(await panel.findByText(/앞쪽 20,000개만 읽었어요/)).toBeInTheDocument();
    m.bullTransitions.mockResolvedValue(sampleBullTransitions({ events: 0, firstAt: null, pairs: [] }));
    fireEvent.click(panel.getByRole("button", { name: "6시간" }));
    expect(await panel.findByText(/이 구간에 이벤트가 없어요/)).toBeInTheDocument();
  });

  test("the 5-second refresh of the queue does not read the events again", async () => {
    await openQueue();
    await waitFor(() => expect(m.bullTransitions).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByRole("button", { name: "다시 읽기" })[1]);
    await waitFor(() => expect(m.bullQueue).toHaveBeenCalledTimes(2));
    expect(m.bullTransitions).toHaveBeenCalledTimes(1);
  });

  test("a failure shows its error", async () => {
    m.bullTransitions.mockRejectedValue({ kind: "other", message: "XRANGE 권한이 없어요" });
    const panel = within(await openQueue());
    expect(await panel.findByText("XRANGE 권한이 없어요")).toBeInTheDocument();
  });
});

describe("큐 지도", () => {
  const toMap = async () => {
    await openBullView();
    await screen.findByRole("button", { name: "emails 개요" });
    fireEvent.click(screen.getByRole("button", { name: "지도" }));
    return within(await screen.findByRole("img", { name: /Bull 큐 지도/ }));
  };

  test("[카드 | 지도] switches the view, and cards are the default", async () => {
    await openBullView();
    expect(await screen.findByRole("button", { name: "카드" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("img", { name: /큐 지도/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "지도" }));
    expect(await screen.findByRole("img", { name: /큐 지도/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "카드" }));
    expect(screen.getByRole("button", { name: "emails 개요" })).toBeInTheDocument();
  });

  test("draws the queues, the parent → child links and the worker hosts with their workers", async () => {
    const map = await toMap();
    await waitFor(() => expect(m.bullTopology).toHaveBeenCalledWith(kvTarget, "bull"));
    expect(await map.findByRole("button", { name: "orders 큐 열기" })).toBeInTheDocument();
    expect(map.getByRole("button", { name: "payments 큐 열기" })).toBeInTheDocument();
    expect(map.getByRole("group", { name: "워커 호스트 10.0.4.8" })).toHaveTextContent("워커 2개 · 큐 2개");
    expect(map.getAllByText("작업 40")).toHaveLength(2);
    expect(map.getAllByText(/워커 [0-9]+개 · 큐/).length).toBeGreaterThanOrEqual(3);
  });

  test("a queue with waiting jobs and no worker has the red border; clicking a queue opens it", async () => {
    const map = await toMap();
    const reports = await map.findByRole("button", { name: "reports 큐 열기" });
    expect(reports.getAttribute("class")).toContain("bad");
    fireEvent.click(map.getByRole("button", { name: "emails 큐 열기" }));
    expect(await screen.findByRole("group", { name: "상태별 작업 수" })).toBeInTheDocument();
    expect(m.bullQueue).toHaveBeenLastCalledWith(kvTarget, "bull", "emails");
  });

  test("without the worker list there are no hosts and the page says why", async () => {
    m.bullTopology.mockResolvedValue(sampleBullTopology({ workers: null }));
    const map = await toMap();
    await map.findByRole("button", { name: "orders 큐 열기" });
    expect(screen.getByText(/워커를 읽을 수 없어 워커 호스트는 그리지 않아요/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /워커 호스트/ })).not.toBeInTheDocument();
  });

  test("says how many jobs were sampled", async () => {
    await toMap();
    expect(await screen.findByText("작업 120개의 부모 키를 읽어 큐를 이었어요")).toBeInTheDocument();
  });
});

describe("토폴로지 in the overview", () => {
  const nodes: KvNode[] = [
    { id: "a1", address: "a1.cart.cache.amazonaws.com:6379", role: "primary", shard: "0001", slots: "0-8191" },
    { id: "a2", address: "a2.cart.cache.amazonaws.com:6379", role: "replica", shard: "0001", slots: null },
    { id: "b1", address: "b1.cart.cache.amazonaws.com:6379", role: "primary", shard: "0002", slots: "8192-16383" },
    { id: "b2", address: "b2.cart.cache.amazonaws.com:6379", role: "replica", shard: "0002", slots: null },
  ];
  const cluster = sampleOverview({ mode: "cluster", nodes, info: nodes.map((n, i) => nodeInfo(n.address, { role: n.role === "primary" ? "master" : "slave", replicationLagSeconds: n.role === "replica" ? i : null })) });
  const c = (node: string, addr: string): KvClient => ({ ...clientRows[0], node, addr, id: addr });

  async function open() {
    renderWithClient(<KvTab target={kvTarget} active />);
    await screen.findByRole("navigation", { name: "Valkey·Redis 메뉴" });
    openMenu("개요");
    return screen.findByRole("img", { name: "토폴로지" });
  }

  test("shards are groups with slots on the primary, the primary → replica edge says the lag, and nodes show memory and ops", async () => {
    m.open.mockResolvedValue(cluster);
    m.clients.mockResolvedValue([c(nodes[0].address, "10.0.4.7:1"), c(nodes[0].address, "10.0.4.7:2"), c(nodes[2].address, "10.0.4.8:3")]);
    const graph = within(await open());
    expect(graph.getByRole("group", { name: "샤드 0001" })).toHaveTextContent("샤드 0001 · 슬롯 0-8191");
    expect(graph.getByRole("group", { name: "샤드 0002" })).toHaveTextContent("슬롯 8192-16383");
    expect(graph.getByRole("group", { name: "기본 노드 a1:6379" })).toHaveTextContent(/메모리 412\.0 MB \/ 1\.0 GB/);
    expect(graph.getByRole("group", { name: "기본 노드 a1:6379" })).toHaveTextContent(/초당 4\.2k?회|초당 4,210회/);
    expect(graph.getByRole("group", { name: "복제 노드 a2:6379" })).toBeInTheDocument();
    expect(graph.getByText("복제 지연 1초")).toBeInTheDocument();
    expect(graph.getByText("복제 지연 3초")).toBeInTheDocument();
  });

  test("client hosts are drawn with their connection counts and linked to the nodes they use", async () => {
    m.open.mockResolvedValue(cluster);
    m.clients.mockResolvedValue([c(nodes[0].address, "10.0.4.7:1"), c(nodes[0].address, "10.0.4.7:2"), c(nodes[2].address, "10.0.4.7:3"), c(nodes[2].address, "10.0.4.8:4")]);
    const graph = within(await open());
    expect(await graph.findByRole("group", { name: "클라이언트 10.0.4.7" })).toHaveTextContent("연결 3개");
    expect(graph.getByRole("group", { name: "클라이언트 10.0.4.8" })).toHaveTextContent("연결 1개");
    expect(graph.getByText("2")).toBeInTheDocument();
    expect(document.querySelector(".kv-topology title")).not.toBeNull();
    expect([...document.querySelectorAll(".kv-topology title")].some((t) => t.textContent === "10.0.4.7 → a1:6379 · 연결 2개")).toBe(true);
  });

  test("more than 20 hosts fold into one node", async () => {
    m.open.mockResolvedValue(cluster);
    m.clients.mockResolvedValue(Array.from({ length: 26 }, (_, i) => c(nodes[0].address, `10.9.0.${i}:1`)));
    const graph = within(await open());
    expect(await graph.findByRole("group", { name: "클라이언트 기타 6호스트" })).toHaveTextContent("연결 6개");
  });

  test("a serverless cache draws its one node and says clients cannot be read", async () => {
    m.target.mockResolvedValue(sampleTargetInfo({ arn: "arn:serverless", serverless: true, kind: "serverlessCache", users: null, userGroupIds: [] }));
    vi.mocked(api.getSettings).mockResolvedValue({ ...settings(), kvLogins: { "arn:serverless": { mode: "none", user: "", database: 0 } } });
    m.open.mockResolvedValue(serverlessOverview());
    const graph = within(await open());
    expect(graph.getByRole("group", { name: "서버리스" })).toBeInTheDocument();
    expect(screen.getAllByText("서버리스 캐시는 클라이언트 목록을 볼 수 없어요").length).toBeGreaterThan(0);
    expect(m.clients).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: /클라이언트 / })).not.toBeInTheDocument();
  });

  test("when the client list fails the graph is drawn without hosts, with a note", async () => {
    m.clients.mockRejectedValue({ kind: "other", message: "NOPERM client" });
    await open();
    expect(await screen.findByText("클라이언트 목록을 읽지 못해 클라이언트 호스트는 그리지 않아요")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "복제 그룹" })).toBeInTheDocument();
  });
});
