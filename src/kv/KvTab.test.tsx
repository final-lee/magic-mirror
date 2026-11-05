import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../api/client";
import type { Settings } from "../api/types";
import { findFor } from "../test/find";
import { renderWithClient } from "../test/utils";
import { kvApi } from "./api";
import { ARN, bigKeys, clientRows, kvTarget, name, sampleKeys, sampleKeyView, sampleOverview, sampleTargetInfo, serverlessOverview, slowEntries } from "./fixtures";
import { KvTab } from "./KvTab";
import { secondsLeft } from "./BigKeys";
import type { KvBigKeysMessage, KvLoginSaved } from "./types";

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
const SAVED: KvLoginSaved = { mode: "user", user: "app-reader", database: 0 };
const NETWORK = { kind: "network", message: "엔드포인트에 연결하지 못했어요(master.sessions.x1y2z3.apn2.cache.amazonaws.com:6379). VPN이 켜져 있는지 확인하세요" };

function settingsWith(kvLogins?: Record<string, KvLoginSaved>): Settings {
  return { enabledServices: ["elasticache"], favorites: [], lastProfile: "prod", lastRegion: null, ...(kvLogins ? { kvLogins } : {}) };
}
const remembered = (login: KvLoginSaved = SAVED, arn = ARN) => vi.mocked(api.getSettings).mockResolvedValue(settingsWith({ [arn]: login }));

const topBar = () => within(screen.getByRole("group", { name: "연결 정보" }));
const menu = () => within(screen.getByRole("navigation", { name: "Valkey·Redis 메뉴" }));
const openMenu = (label: string) => fireEvent.click(menu().getByRole("button", { name: new RegExp(`^${label}$`) }));
const connected = () => screen.findByRole("navigation", { name: "Valkey·Redis 메뉴" });
const tree = () => within(screen.getByRole("tree", { name: "키 목록" }));
const item = (label: RegExp | string) => tree().getByRole("treeitem", { name: label });

function setup(active = true) {
  return renderWithClient(
    <div hidden={!active}>
      <KvTab target={kvTarget} active={active} />
    </div>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  remembered();
  vi.mocked(api.saveSettings).mockResolvedValue(undefined);
  m.target.mockResolvedValue(sampleTargetInfo());
  m.open.mockResolvedValue(sampleOverview());
  m.overview.mockResolvedValue(sampleOverview());
  m.scan.mockResolvedValue({ keys: sampleKeys, cursor: null, scanned: 1200 });
  m.key.mockResolvedValue(sampleKeyView());
  m.slowlog.mockResolvedValue(slowEntries);
  m.clients.mockResolvedValue(clientRows);
  m.bigkeys.mockResolvedValue(null);
  m.bigkeysStop.mockResolvedValue(null);
  m.close.mockResolvedValue(null);
  m.forgetPassword.mockResolvedValue(null);
});

describe("connecting", () => {
  test("a remembered login connects at once, without the password (the keychain has it)", async () => {
    setup();
    await connected();
    expect(m.open).toHaveBeenCalledTimes(1);
    expect(m.open).toHaveBeenCalledWith(kvTarget, { mode: "user", user: "app-reader", database: 0, password: null, rememberPassword: false });
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  test("the top bar shows the engine, mode, nodes, login and state", async () => {
    setup();
    await connected();
    const bar = topBar();
    expect(bar.getByText("sessions")).toBeInTheDocument();
    expect(bar.getByText("valkey 8.0.1")).toBeInTheDocument();
    expect(bar.getByText("단일 엔드포인트")).toBeInTheDocument();
    expect(bar.getByText("노드 3개")).toBeInTheDocument();
    expect(bar.getByText("app-reader")).toBeInTheDocument();
    expect(bar.getByRole("button", { name: "바꾸기" })).toBeInTheDocument();
    expect(bar.getByText("연결됨")).toBeInTheDocument();
    expect(bar.getByRole("combobox", { name: "DB 번호" })).toHaveValue("0");
  });

  test("a first visit asks for the login with the user list, then connects and remembers the mode, user and database (never the password)", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settingsWith());
    const user = userEvent.setup();
    setup();
    expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
    expect(m.open).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /app-reader/ })).toBeChecked();
    await user.type(screen.getByLabelText("비밀번호"), "s3cret");
    await user.click(screen.getByRole("button", { name: "연결" }));
    await connected();
    expect(m.open).toHaveBeenCalledWith(kvTarget, { mode: "user", user: "app-reader", database: 0, password: "s3cret", rememberPassword: true });
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    const saved = lastSaved();
    expect(saved.kvLogins).toEqual({ [ARN]: SAVED });
    expect(JSON.stringify(vi.mocked(api.saveSettings).mock.calls)).not.toContain("s3cret");
  });

  test("a refresh after the first connection does not send the password again", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settingsWith());
    const user = userEvent.setup();
    setup();
    await user.type(await screen.findByLabelText("비밀번호"), "s3cret");
    await user.click(screen.getByRole("button", { name: "연결" }));
    await connected();
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(m.overview).toHaveBeenCalled());
    expect(m.open).toHaveBeenCalledTimes(1);
  });

  test("a refused login (loginRequired) shows the prompt with the reason, and a new login connects again", async () => {
    m.open.mockRejectedValueOnce({ kind: "loginRequired", message: "비밀번호가 맞지 않아요" });
    const user = userEvent.setup();
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("비밀번호가 맞지 않아요");
    expect(topBar().getByText("연결 안 됨")).toBeInTheDocument();
    await user.type(screen.getByLabelText("비밀번호"), "right");
    await user.click(screen.getByRole("button", { name: "연결" }));
    await connected();
    expect(m.open).toHaveBeenCalledTimes(2);
    expect(m.open).toHaveBeenLastCalledWith(kvTarget, expect.objectContaining({ user: "app-reader", password: "right" }));
  });

  test("a network failure says what to check, with 다시 시도", async () => {
    m.open.mockRejectedValueOnce(NETWORK);
    setup();
    expect(await screen.findByText(`네트워크 오류: ${NETWORK.message}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
    expect(topBar().getByText("연결 안 됨")).toBeInTheDocument();
  });

  test("an unreadable target shows its error and nothing else", async () => {
    m.target.mockRejectedValue({ kind: "accessDenied", action: "elasticache:DescribeReplicationGroups" });
    setup();
    expect(await screen.findByText("권한 없음 (elasticache:DescribeReplicationGroups)")).toBeInTheDocument();
    expect(m.open).not.toHaveBeenCalled();
  });

  test("[바꾸기] opens the prompt over the screen with a way back", async () => {
    const user = userEvent.setup();
    setup();
    await connected();
    await user.click(topBar().getByRole("button", { name: "바꾸기" }));
    expect(screen.getByRole("heading", { name: "로그인" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^사용자/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("heading", { name: "로그인" })).not.toBeInTheDocument();
    expect(m.open).toHaveBeenCalledTimes(1);
  });

  test("changing the database reconnects with it and remembers it", async () => {
    m.open.mockResolvedValueOnce(sampleOverview()).mockResolvedValueOnce(sampleOverview({ database: 1, dbsize: 12 }));
    setup();
    await connected();
    fireEvent.change(topBar().getByRole("combobox", { name: "DB 번호" }), { target: { value: "1" } });
    await waitFor(() => expect(m.open).toHaveBeenCalledTimes(2));
    expect(m.open).toHaveBeenLastCalledWith(kvTarget, { mode: "user", user: "app-reader", database: 1, password: null, rememberPassword: false });
    await waitFor(() => expect(lastSaved().kvLogins).toEqual({ [ARN]: { ...SAVED, database: 1 } }));
    expect(await screen.findByText(/전체 약 12개/)).toBeInTheDocument();
  });

  test("the saved password can be forgotten from the top bar", async () => {
    setup();
    await connected();
    fireEvent.click(topBar().getByRole("button", { name: "저장한 비밀번호 지우기" }));
    await waitFor(() => expect(m.forgetPassword).toHaveBeenCalledWith(kvTarget, "app-reader"));
    expect(await screen.findByText("저장한 비밀번호를 지웠어요")).toBeInTheDocument();
  });

  test("a login that needs no password has nothing to forget", async () => {
    remembered({ mode: "none", user: "", database: 0 });
    setup();
    await connected();
    expect(topBar().queryByRole("button", { name: "저장한 비밀번호 지우기" })).not.toBeInTheDocument();
  });
});

describe("keys", () => {
  test("lists the keys as a tree: folders with their key counts first, then keys", async () => {
    setup();
    await connected();
    await screen.findByRole("tree", { name: "키 목록" });
    expect(m.scan).toHaveBeenCalledWith(kvTarget, "*", null, null, 1000);
    const labels = tree().getAllByRole("treeitem").map((e) => e.textContent);
    expect(labels).toEqual(["▸cache2", "▸queue1", "▸ratelimit1", "▸session3", "leaderboardzset—", "standalonestring—"]);
    expect(screen.getByText("읽은 키 9개 / 전체 약 1,240,000개")).toBeInTheDocument();
    expect(screen.getByText("끝까지 읽었어요")).toBeInTheDocument();
  });

  test("a folder opens and closes with a click and with the arrow keys", async () => {
    setup();
    await connected();
    fireEvent.click(await screen.findByRole("treeitem", { name: /session/ }));
    expect(item(/session/)).toHaveAttribute("aria-expanded", "true");
    expect(item(/2026/)).toBeInTheDocument();
    expect(item(/2025/)).toBeInTheDocument();
    fireEvent.click(item(/session/));
    expect(item(/session/)).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: /2026/ })).not.toBeInTheDocument();
    const box = screen.getByRole("tree", { name: "키 목록" });
    // 세션 폴더를 누른 뒤 커서가 거기 있다: 위로 가서 cache 폴더에서 →로 펴고 ←로 접는다
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "ArrowRight" });
    expect(item(/cache/)).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(box, { key: "ArrowLeft" });
    expect(item(/cache/)).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(item(/queue/)).toHaveAttribute("aria-expanded", "true");
  });

  test("a key opens its value in the detail on the right, with the common facts", async () => {
    setup();
    await connected();
    fireEvent.click(await screen.findByRole("treeitem", { name: /cache/ }));
    fireEvent.click(item(/product/));
    fireEvent.click(item(/^42/));
    const detail = await screen.findByRole("complementary", { name: "상세" });
    await waitFor(() => expect(m.key).toHaveBeenCalledWith(kvTarget, name("cache:product:42"), null));
    expect(within(detail).getByRole("heading", { name: "cache:product:42" })).toBeInTheDocument();
    const facts = await within(detail).findByText("embstr");
    expect(facts).toBeInTheDocument();
    expect(within(detail).getByText("52 바이트")).toBeInTheDocument();
    expect(within(detail).getByText("112 B")).toBeInTheDocument();
    expect(within(detail).getByText(/1분 뒤 \(/)).toBeInTheDocument();
    expect(within(detail).getByText('"id"')).toBeInTheDocument();
    // 열린 키는 목록에서 표시되고, 상세를 닫으면 사라진다
    expect(item(/^42/)).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(detail).getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("complementary", { name: "상세" })).not.toBeInTheDocument();
  });

  test("a key without expiry says 만료 없음", async () => {
    m.key.mockResolvedValue(sampleKeyView({ name: name("standalone"), ttlMs: null }));
    setup();
    await connected();
    fireEvent.click(await screen.findByRole("treeitem", { name: /standalone/ }));
    expect(await screen.findByText("만료 없음")).toBeInTheDocument();
  });

  test("a binary key name keeps its exact address and is marked", async () => {
    const bin = { text: "bin:\ufffd", base64: "YmluOv8=" };
    m.scan.mockResolvedValue({ keys: [{ name: bin, type: "string", ttlMs: null }], cursor: null, scanned: 1 });
    m.key.mockResolvedValue(sampleKeyView({ name: bin }));
    setup();
    await connected();
    fireEvent.click(await screen.findByRole("treeitem", { name: /bin/ }));
    fireEvent.click(item(/바이너리/));
    await waitFor(() => expect(m.key).toHaveBeenCalledWith(kvTarget, bin, null));
  });

  test("the pattern and the type chips go to the server", async () => {
    const user = userEvent.setup();
    setup();
    await connected();
    await screen.findByRole("tree", { name: "키 목록" });
    await user.click(screen.getByRole("button", { name: "hash" }));
    await waitFor(() => expect(m.scan).toHaveBeenLastCalledWith(kvTarget, "*", "hash", null, 1000));
    expect(screen.getByRole("button", { name: "hash" })).toHaveAttribute("aria-pressed", "true");
    await user.clear(screen.getByRole("textbox", { name: "패턴" }));
    await user.type(screen.getByRole("textbox", { name: "패턴" }), "session:*{Enter}");
    await waitFor(() => expect(m.scan).toHaveBeenLastCalledWith(kvTarget, "session:*", "hash", null, 1000));
    await user.click(screen.getByRole("button", { name: "hash" }));
    await waitFor(() => expect(m.scan).toHaveBeenLastCalledWith(kvTarget, "session:*", null, null, 1000));
  });

  test("the delimiter regroups the keys on the client, and empty means a flat list", async () => {
    setup();
    await connected();
    await screen.findByRole("tree", { name: "키 목록" });
    fireEvent.change(screen.getByRole("textbox", { name: "구분자" }), { target: { value: "" } });
    expect(tree().getAllByRole("treeitem")).toHaveLength(9);
    expect(item(/session:2026:u-1001/)).toBeInTheDocument();
    expect(m.scan).toHaveBeenCalledTimes(1);
  });

  test("[더 읽기] continues from the cursor and adds to the keys", async () => {
    m.scan
      .mockResolvedValueOnce({ keys: sampleKeys.slice(0, 3), cursor: "c1", scanned: 500 })
      .mockResolvedValueOnce({ keys: [{ name: name("zz"), type: "set", ttlMs: null }, sampleKeys[0]], cursor: null, scanned: 700 });
    setup();
    await connected();
    expect(await screen.findByText("읽은 키 3개 / 전체 약 1,240,000개")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "더 읽기" }));
    await waitFor(() => expect(m.scan).toHaveBeenLastCalledWith(kvTarget, "*", null, "c1", 1000));
    // 같은 키가 다시 와도 한 번만 센다
    expect(await screen.findByText("읽은 키 4개 / 전체 약 1,240,000개")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "더 읽기" })).not.toBeInTheDocument();
  });

  test("the fuzzy find (⌘F) narrows the keys already read and opens every folder it matches in", async () => {
    setup();
    await connected();
    await screen.findByRole("tree", { name: "키 목록" });
    findFor("u1001");
    expect(tree().getAllByRole("treeitem").map((e) => e.textContent)).toEqual(["▾session1", "▾20261", "u-1001hash1시간"]);
    findFor("zzzz");
    expect(screen.getByText("조건에 맞는 키가 없어요")).toBeInTheDocument();
    expect(m.scan).toHaveBeenCalledTimes(1);
  });

  test("no keys says so", async () => {
    m.scan.mockResolvedValue({ keys: [], cursor: null, scanned: 100 });
    setup();
    await connected();
    expect(await screen.findByText("키가 없어요")).toBeInTheDocument();
  });

  test("a scan that fails shows the error with a retry", async () => {
    m.scan.mockRejectedValueOnce({ kind: "other", message: "사용자 app-reader에게 scan 권한이 없어요" });
    setup();
    await connected();
    expect(await screen.findByText("사용자 app-reader에게 scan 권한이 없어요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });

  test("a read that finds the login gone (loginRequired) asks for it right there, and a new login reconnects", async () => {
    m.scan.mockRejectedValueOnce({ kind: "loginRequired", message: "저장한 비밀번호가 없어요" });
    const user = userEvent.setup();
    setup();
    await connected();
    expect(await screen.findByRole("alert")).toHaveTextContent("저장한 비밀번호가 없어요");
    await user.type(screen.getByLabelText("비밀번호"), "again");
    await user.click(screen.getByRole("button", { name: "연결" }));
    await waitFor(() => expect(m.open).toHaveBeenCalledTimes(2));
    expect(m.open).toHaveBeenLastCalledWith(kvTarget, expect.objectContaining({ password: "again" }));
    expect(await screen.findByRole("tree", { name: "키 목록" })).toBeInTheDocument();
  });
});

describe("history", () => {
  test("opening a key is a step in the history: back closes it, forward opens it again", async () => {
    setup();
    await connected();
    fireEvent.click(await screen.findByRole("treeitem", { name: /standalone/ }));
    await screen.findByRole("complementary", { name: "상세" });
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(screen.queryByRole("complementary", { name: "상세" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "앞으로" }));
    expect(await screen.findByRole("complementary", { name: "상세" })).toBeInTheDocument();
  });

  test("the crumb names the key that is open", async () => {
    setup();
    await connected();
    fireEvent.click(await screen.findByRole("treeitem", { name: /standalone/ }));
    const crumb = within(await screen.findByRole("navigation", { name: "현재 위치" }));
    expect(crumb.getByRole("button", { name: "키" })).toBeInTheDocument();
    expect(crumb.getByText("standalone")).toBeInTheDocument();
  });
});

describe("overview", () => {
  test("shows the cards and the node table", async () => {
    setup();
    await connected();
    openMenu("개요");
    const cards = within(await screen.findByRole("region", { name: "개요" }));
    expect(cards.getByRole("group", { name: "메모리" })).toHaveTextContent("412.0 MB / 1.0 GB");
    expect(cards.getByRole("group", { name: "히트율" })).toHaveTextContent("93.0%");
    expect(cards.getByRole("group", { name: "초당 명령" })).toHaveTextContent("4,210");
    expect(cards.getByRole("group", { name: "연결 클라이언트" })).toHaveTextContent("86");
    expect(cards.getByRole("group", { name: "키" })).toHaveTextContent("1,240,000");
    expect(cards.getByRole("group", { name: "복제 지연" })).toHaveTextContent("1초");
    const nodes = cards.getByRole("table", { name: "노드" });
    expect(within(nodes).getAllByRole("row")).toHaveLength(4);
    expect(within(nodes).getByText("10.0.2.11:6379").closest("tr")).toHaveTextContent("복제");
    expect(cards.getByRole("table", { name: "키스페이스" })).toHaveTextContent("db0");
  });
});

describe("serverless", () => {
  const info = sampleTargetInfo({ arn: "arn:aws:elasticache:ap-northeast-2:123456789012:serverlesscache:feature-flags", identifier: "feature-flags", kind: "serverlessCache", serverless: true, userGroupIds: [], users: null, readerEndpoint: null });

  beforeEach(() => {
    remembered({ mode: "none", user: "", database: 0 }, info.arn);
    m.target.mockResolvedValue(info);
    m.open.mockResolvedValue(serverlessOverview());
  });

  test("Slow log and clients are off, with the reason", async () => {
    setup();
    await connected();
    const slow = menu().getByRole("button", { name: /Slow log/ });
    const clients = menu().getByRole("button", { name: /클라이언트/ });
    expect(slow).toBeDisabled();
    expect(clients).toBeDisabled();
    expect(slow).toHaveAttribute("title", "서버리스 캐시는 Slow log를 볼 수 없어요");
    expect(menu().getByText("서버리스 캐시는 Slow log를 볼 수 없어요")).toBeInTheDocument();
    expect(menu().getByText("서버리스 캐시는 클라이언트 목록을 볼 수 없어요")).toBeInTheDocument();
    expect(menu().getByRole("button", { name: /큰 키/ })).toBeEnabled();
    expect(m.slowlog).not.toHaveBeenCalled();
    expect(m.clients).not.toHaveBeenCalled();
    expect(topBar().getByText("서버리스")).toBeInTheDocument();
    expect(topBar().queryByRole("combobox", { name: "DB 번호" })).not.toBeInTheDocument();
  });

  test("the overview shows one node, and a key shows memory and encoding as 볼 수 없음", async () => {
    m.key.mockResolvedValue(sampleKeyView({ memory: null, encoding: null }));
    setup();
    await connected();
    openMenu("개요");
    expect(await screen.findByText("서버리스 캐시는 노드 하나로 보여요")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "노드" })).getAllByRole("row")).toHaveLength(2);
    openMenu("키");
    fireEvent.click(await screen.findByRole("treeitem", { name: /standalone/ }));
    const detail = await screen.findByRole("complementary", { name: "상세" });
    await within(detail).findByText("52 바이트");
    expect(within(detail).getAllByText("볼 수 없음")).toHaveLength(2);
  });
});

describe("slow log and clients", () => {
  test("the slow log lists the commands, newest first, with the time they took", async () => {
    setup();
    await connected();
    openMenu("Slow log");
    const table = await screen.findByRole("table", { name: "Slow log 목록" });
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("SMEMBERS tags:all");
    expect(rows[1]).toHaveTextContent("18.4ms");
    expect(rows[1]).toHaveTextContent("orders-api");
    expect(rows[2]).toHaveTextContent("952µs");
  });

  test("a command is cut at 200 characters", async () => {
    m.slowlog.mockResolvedValue([{ ...slowEntries[0], args: ["MSET", "k".repeat(300)] }]);
    setup();
    await connected();
    openMenu("Slow log");
    const table = await screen.findByRole("table", { name: "Slow log 목록" });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent(`MSET ${"k".repeat(195)}…`);
  });

  test("no slow commands says so", async () => {
    m.slowlog.mockResolvedValue([]);
    setup();
    await connected();
    openMenu("Slow log");
    expect(await screen.findByText("느린 명령이 없어요")).toBeInTheDocument();
  });

  test("the clients list marks this app's own connection", async () => {
    setup();
    await connected();
    openMenu("클라이언트");
    const table = await screen.findByRole("table", { name: "클라이언트 목록" });
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("10.0.4.7:51000");
    expect(rows[1]).not.toHaveTextContent("이 앱");
    expect(rows[2]).toHaveTextContent("이 앱");
    expect(rows[2]).toHaveTextContent("magic-mirror");
  });

  test("[지도] draws the clients as hosts linked to their connection names, and [표] goes back", async () => {
    setup();
    await connected();
    openMenu("클라이언트");
    await screen.findByRole("table", { name: "클라이언트 목록" });
    fireEvent.click(screen.getByRole("button", { name: "지도" }));
    const map = screen.getByRole("img", { name: "클라이언트 지도" });
    expect(screen.queryByRole("table", { name: "클라이언트 목록" })).not.toBeInTheDocument();
    expect(within(map).getByRole("group", { name: "10.0.4.7 연결 1" })).toBeInTheDocument();
    expect(within(map).getByRole("group", { name: "magic-mirror 연결 1 · 호스트 1 · 이 앱" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "표" }));
    expect(screen.getByRole("table", { name: "클라이언트 목록" })).toBeInTheDocument();
  });

  test("[다시 읽기] reads the slow log again", async () => {
    setup();
    await connected();
    openMenu("Slow log");
    await screen.findByRole("table", { name: "Slow log 목록" });
    fireEvent.click(lastOf(screen.getAllByRole("button", { name: "다시 읽기" })));
    await waitFor(() => expect(m.slowlog).toHaveBeenCalledTimes(2));
  });
});

describe("big keys", () => {
  test("[찾기] shows the progress with a way to stop, then the biggest keys", async () => {
    let finish: () => void = () => {};
    m.bigkeys.mockImplementation(async (_t, limit, onMessage: (m: KvBigKeysMessage) => void) => {
      expect(limit).toBe(50);
      onMessage({ type: "progress", scanned: 100, total: 1000 });
      await new Promise<void>((resolve) => (finish = resolve));
      onMessage({ type: "done", basis: "memory", keys: bigKeys, scanned: 700, stopped: true, generatedAt: Date.now() });
      return null;
    });
    setup();
    await connected();
    openMenu("큰 키");
    fireEvent.click(screen.getByRole("button", { name: "찾기" }));
    expect(await screen.findByText("100 / 1,000개 훑는 중…")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "큰 키 찾기 진행" })).toHaveAttribute("aria-valuenow", "10");
    fireEvent.click(screen.getByRole("button", { name: "중단" }));
    expect(m.bigkeysStop).toHaveBeenCalledWith(kvTarget);
    expect(screen.getByText("중단하는 중…")).toBeInTheDocument();
    await act(async () => finish());
    const table = await screen.findByRole("table", { name: "큰 키 목록" });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("1leaderboardzset18.0 MB");
    expect(screen.getByText(/700개를 훑고 중단했어요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 찾기" })).toBeInTheDocument();
  });

  test("every 50,000 keys the top keys so far show under the progress bar", async () => {
    let finish: () => void = () => {};
    m.bigkeys.mockImplementation(async (_t, _l, onMessage: (m: KvBigKeysMessage) => void) => {
      onMessage({ type: "progress", scanned: 50_000, total: 390_000, keys: bigKeys });
      onMessage({ type: "progress", scanned: 51_000, total: 390_000 });
      await new Promise<void>((resolve) => (finish = resolve));
      return null;
    });
    setup();
    await connected();
    openMenu("큰 키");
    fireEvent.click(screen.getByRole("button", { name: "찾기" }));
    expect(await screen.findByText(/51,000 \/ 390,000개 훑는 중…/)).toBeInTheDocument();
    // 중간 결과는 그 결과를 만든 때(5만 개)를 밝힌다
    expect(screen.getByText("중간 결과: 50,000개까지 훑은 상위 키")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "큰 키 목록" })).getAllByRole("row")[1]).toHaveTextContent("leaderboard");
    await act(async () => finish());
  });

  test("a saved report shows on connect, without searching again, until [다시 찾기]; another DB reads its own", async () => {
    m.bigkeysReport.mockResolvedValue({ basis: "memory", keys: bigKeys, scanned: 390_000, stopped: false, generatedAt: Date.now() - 2 * 3600_000 });
    m.open.mockResolvedValueOnce(sampleOverview()).mockResolvedValueOnce(sampleOverview({ database: 1 }));
    setup();
    await connected();
    openMenu("큰 키");
    expect(await screen.findByRole("table", { name: "큰 키 목록" })).toBeInTheDocument();
    expect(screen.getByText(/390,000개를 모두 훑었어요/)).toBeInTheDocument();
    expect(screen.getByText(/^2시간 전\(.+\)에 만든 결과예요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 찾기" })).toBeInTheDocument();
    expect(m.bigkeys).not.toHaveBeenCalled();
    expect(m.bigkeysReport).toHaveBeenCalledTimes(1);
    m.bigkeysReport.mockResolvedValue(null);
    fireEvent.change(topBar().getByRole("combobox", { name: "DB 번호" }), { target: { value: "1" } });
    await waitFor(() => expect(m.bigkeysReport).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("[찾기]를 누르면 시작해요")).toBeInTheDocument();
  });

  test("the time left is estimated from the pace so far", () => {
    expect(secondsLeft(0, 1000, 5000)).toBeNull();
    expect(secondsLeft(1000, 1000, 5000)).toBeNull();
    // 10초에 1/4을 훑었으면 남은 3/4은 30초
    expect(secondsLeft(250, 1000, 10_000)).toBe(30);
  });

  test("a result by length (serverless) says it is by length and counts elements", async () => {
    m.bigkeys.mockImplementation(async (_t, _l, onMessage: (m: KvBigKeysMessage) => void) => {
      onMessage({ type: "done", basis: "length", keys: [{ name: name("queue:emails"), type: "list", size: 40_000 }, { name: name("blob"), type: "string", size: 2048 }], scanned: 5000, stopped: false, generatedAt: Date.now() });
      return null;
    });
    setup();
    await connected();
    openMenu("큰 키");
    fireEvent.click(screen.getByRole("button", { name: "찾기" }));
    const table = await screen.findByRole("table", { name: "큰 키 목록" });
    expect(screen.getByText(/길이\(원소 수·바이트\)로 대신했어요/)).toBeInTheDocument();
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("40,000개");
    expect(within(table).getAllByRole("row")[2]).toHaveTextContent("2.0 KB");
  });

  test("a key in the result opens its value in the keys screen", async () => {
    m.bigkeys.mockImplementation(async (_t, _l, onMessage: (m: KvBigKeysMessage) => void) => {
      onMessage({ type: "done", basis: "memory", keys: bigKeys, scanned: 10, stopped: false, generatedAt: Date.now() });
      return null;
    });
    m.key.mockResolvedValue(sampleKeyView({ name: name("leaderboard"), type: "zset" }));
    setup();
    await connected();
    openMenu("큰 키");
    fireEvent.click(screen.getByRole("button", { name: "찾기" }));
    fireEvent.click(await screen.findByRole("button", { name: "leaderboard" }));
    await waitFor(() => expect(m.key).toHaveBeenCalledWith(kvTarget, name("leaderboard"), null));
    expect(await screen.findByRole("complementary", { name: "상세" })).toBeInTheDocument();
  });

  test("the result stays when you look at another screen and come back", async () => {
    m.bigkeys.mockImplementation(async (_t, _l, onMessage: (m: KvBigKeysMessage) => void) => {
      onMessage({ type: "done", basis: "memory", keys: bigKeys, scanned: 10, stopped: false, generatedAt: Date.now() });
      return null;
    });
    setup();
    await connected();
    openMenu("큰 키");
    fireEvent.click(screen.getByRole("button", { name: "찾기" }));
    await screen.findByRole("table", { name: "큰 키 목록" });
    openMenu("개요");
    openMenu("큰 키");
    expect(screen.getByRole("table", { name: "큰 키 목록" })).toBeInTheDocument();
    expect(m.bigkeys).toHaveBeenCalledTimes(1);
  });
});

describe("refreshing", () => {
  test("[다시 읽기] reconnects through kv_overview and reads the keys again from the start", async () => {
    setup();
    await connected();
    await screen.findByRole("tree", { name: "키 목록" });
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(m.scan).toHaveBeenCalledTimes(2));
    expect(m.scan).toHaveBeenLastCalledWith(kvTarget, "*", null, null, 1000);
    expect(m.open).toHaveBeenCalledTimes(1);
  });

  test("when the reconnect fails the keys are not read again, and the error shows over the old screen", async () => {
    setup();
    await connected();
    await screen.findByRole("tree", { name: "키 목록" });
    m.overview.mockRejectedValue(NETWORK);
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    expect(await screen.findByText(`네트워크 오류: ${NETWORK.message}`)).toBeInTheDocument();
    expect(m.scan).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("tree", { name: "키 목록" })).toBeInTheDocument();
  });
});
