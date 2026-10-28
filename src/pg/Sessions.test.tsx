import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { formatDateTime } from "../iam/format";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import { pgTarget, sampleSessions } from "./fixtures";
import { Sessions, SESSIONS_FOOTNOTE } from "./Sessions";
import type { PgSession } from "./types";

vi.mock("./api", () => ({ pgApi: { sessions: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(pgApi);

const FOOTNOTE = "빈 칸은 이 DB 사용자에게 보이지 않는 정보예요. 다른 사용자의 세션을 자세히 보려면 pg_read_all_stats 권한이 필요해요";

function setup() {
  return renderWithClient(<Sessions target={pgTarget} />);
}

const loaded = () => screen.findByRole("table", { name: "세션 목록" });
const table = () => screen.getByRole("table", { name: "세션 목록" });
const bodyRows = () => within(table()).getAllByRole("row").slice(1);
const cells = (row: HTMLElement) => within(row).getAllByRole("cell");
/** 열 머리 이름으로 고른 칸 */
const cellAt = (row: HTMLElement, column: string) => {
  const heads = within(table())
    .getAllByRole("columnheader")
    .map((h) => h.textContent);
  return cells(row)[heads.indexOf(column)];
};
const roleFilter = () => screen.getByRole("combobox", { name: "역할" }) as HTMLSelectElement;
const filterChoices = () => within(roleFilter()).getAllByRole("option").map((o) => o.textContent);
const reread = () => screen.getByRole("button", { name: /^(다시 읽기|읽는 중…)$/ });

/** 상세가 가려진 다른 사용자의 세션: PostgreSQL이 상태, 클라이언트, 시작, 대기를 비워서 준다 */
const hidden = (extra: Partial<PgSession> = {}): PgSession => ({
  pid: 4001,
  role: "carol",
  database: "orders",
  clientAddr: null,
  applicationName: "psql",
  state: null,
  backendStart: null,
  queryStart: null,
  waitEvent: null,
  own: false,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.sessions.mockResolvedValue(sampleSessions());
});

describe("loading", () => {
  test("reads the sessions of the target and says so until they arrive", async () => {
    let resolve!: (v: PgSession[]) => void;
    m.sessions.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    expect(screen.getByText("불러오는 중…")).toBeInTheDocument();
    expect(m.sessions).toHaveBeenCalledWith(pgTarget);
    resolve(sampleSessions());
    expect(await loaded()).toBeInTheDocument();
    expect(screen.queryByText("불러오는 중…")).not.toBeInTheDocument();
  });

  test("shows why it failed through the error box", async () => {
    m.sessions.mockRejectedValue({ kind: "other", message: "질의가 30초 안에 끝나지 않았어요. 잠시 뒤 다시 읽어 주세요" });
    setup();
    expect(await screen.findByText("질의가 30초 안에 끝나지 않았어요. 잠시 뒤 다시 읽어 주세요")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "세션 목록" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });

  test("a read that fails after the table was shown keeps the table on screen with the error above it", async () => {
    setup();
    await loaded();
    m.sessions.mockRejectedValue({ kind: "network", message: "데이터베이스 연결이 끊겼어요. 다시 읽으면 새로 연결해요" });
    fireEvent.click(reread());
    expect(await screen.findByText(/데이터베이스 연결이 끊겼어요/)).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(5);
  });
});

describe("the table", () => {
  test("has the columns 역할, 데이터베이스, 클라이언트, application_name, 상태, 시작 and 대기", async () => {
    setup();
    await loaded();
    expect(within(table()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["역할", "데이터베이스", "클라이언트", "application_name", "상태", "시작", "대기"]);
  });

  test("has a row for every session, in the order the backend sent them", async () => {
    setup();
    await loaded();
    expect(bodyRows().map((r) => cellAt(r, "역할").textContent)).toEqual(["app_owner", "alice", "bob", "iam_admin", "iam_admin"]);
  });

  test("tells the database, the client, the application, the state, when it started and what it waits for", async () => {
    setup();
    await loaded();
    const [flyway, dbeaver] = bodyRows();
    expect(cellAt(flyway, "역할")).toHaveTextContent("app_owner");
    expect(cellAt(flyway, "데이터베이스")).toHaveTextContent("orders");
    expect(cellAt(flyway, "클라이언트")).toHaveTextContent("10.0.2.31");
    expect(cellAt(flyway, "application_name")).toHaveTextContent("flyway");
    expect(cellAt(flyway, "상태")).toHaveTextContent("idle");
    expect(cellAt(flyway, "시작")).toHaveTextContent(formatDateTime("2026-10-28T11:42:10Z"));
    expect(cellAt(flyway, "대기")).toHaveTextContent("ClientRead");
    expect(cellAt(dbeaver, "application_name")).toHaveTextContent("DBeaver 24.1.0 - Main <orders>");
    expect(cellAt(dbeaver, "상태")).toHaveTextContent("active");
  });

  test("shows a missing value as the dash the rest of the tab uses", async () => {
    setup();
    await loaded();
    const dbeaver = bodyRows()[1]; // 기다리는 이벤트가 없는 세션
    expect(cellAt(dbeaver, "대기")).toHaveTextContent("—");
    m.sessions.mockResolvedValue([{ ...sampleSessions()[0], applicationName: "", database: null, role: null, clientAddr: null }]);
    fireEvent.click(reread());
    await waitFor(() => expect(cellAt(bodyRows()[0], "역할")).toHaveTextContent("—"));
    const [row] = bodyRows();
    expect(cellAt(row, "데이터베이스")).toHaveTextContent("—");
    expect(cellAt(row, "클라이언트")).toHaveTextContent("—");
    expect(cellAt(row, "application_name")).toHaveTextContent("—");
  });

  test("marks the connections of this app with 이 앱, and only those", async () => {
    setup();
    await loaded();
    const marked = bodyRows().filter((r) => within(r).queryByText("이 앱") !== null);
    expect(marked.map((r) => cellAt(r, "데이터베이스").textContent)).toEqual(["orders", "analytics"]);
    expect(within(cellAt(marked[0], "application_name")).getByText("이 앱")).toBeInTheDocument();
    expect(cellAt(marked[0], "application_name")).toHaveTextContent("magic-mirror");
  });

  test("a table without sessions says so", async () => {
    m.sessions.mockResolvedValue([]);
    setup();
    expect(await screen.findByText("세션이 없어요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 읽기" })).toBeInTheDocument();
  });
});

describe("the role filter", () => {
  test("offers all roles, and then every role that has a session, once, in name order", async () => {
    setup();
    await loaded();
    expect(roleFilter()).toHaveValue("");
    expect(filterChoices()).toEqual(["모든 역할", "alice", "app_owner", "bob", "iam_admin"]);
  });

  test("choosing a role leaves the sessions of that role", async () => {
    setup();
    await loaded();
    fireEvent.change(roleFilter(), { target: { value: "iam_admin" } });
    expect(bodyRows().map((r) => cellAt(r, "데이터베이스").textContent)).toEqual(["orders", "analytics"]);
    fireEvent.change(roleFilter(), { target: { value: "" } });
    expect(bodyRows()).toHaveLength(5);
  });

  test("a session of no role shows the dash, is not a choice, and is left out once a role is chosen", async () => {
    m.sessions.mockResolvedValue([...sampleSessions(), { ...sampleSessions()[0], pid: 55, role: null, database: null, applicationName: "" }]);
    setup();
    await loaded();
    expect(bodyRows()).toHaveLength(6);
    expect(cellAt(bodyRows()[5], "역할")).toHaveTextContent("—");
    expect(filterChoices()).toEqual(["모든 역할", "alice", "app_owner", "bob", "iam_admin"]);
    fireEvent.change(roleFilter(), { target: { value: "alice" } });
    expect(bodyRows()).toHaveLength(1);
  });

  test("a role that has no session any more stays chosen and the table says nothing matches", async () => {
    setup();
    await loaded();
    fireEvent.change(roleFilter(), { target: { value: "bob" } });
    expect(bodyRows()).toHaveLength(1);
    m.sessions.mockResolvedValue(sampleSessions().filter((s) => s.role !== "bob"));
    fireEvent.click(reread());
    expect(await screen.findByText("조건에 맞는 세션이 없어요")).toBeInTheDocument();
    expect(roleFilter()).toHaveValue("bob");
    expect(filterChoices()).toContain("bob");
    fireEvent.change(roleFilter(), { target: { value: "" } });
    expect(bodyRows()).toHaveLength(4);
  });
});

describe("다시 읽기", () => {
  test("reads the sessions again, and shows what the new read says", async () => {
    setup();
    await loaded();
    expect(m.sessions).toHaveBeenCalledTimes(1);
    m.sessions.mockResolvedValue(sampleSessions().slice(0, 2));
    fireEvent.click(reread());
    await waitFor(() => expect(m.sessions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    expect(reread()).toHaveTextContent("다시 읽기");
  });

  test("is busy while it reads, and the old rows stay until the new ones come", async () => {
    setup();
    await loaded();
    let resolve!: (v: PgSession[]) => void;
    m.sessions.mockReturnValue(new Promise((r) => (resolve = r)));
    fireEvent.click(reread());
    await waitFor(() => expect(reread()).toHaveTextContent("읽는 중…"));
    expect(reread()).toBeDisabled();
    expect(bodyRows()).toHaveLength(5);
    resolve(sampleSessions().slice(0, 1));
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(reread()).toBeEnabled();
  });
});

describe("the footnote", () => {
  test("is the text of the constraints, word for word", () => {
    expect(SESSIONS_FOOTNOTE).toBe(FOOTNOTE);
  });

  test("is not there when every session shows its details", async () => {
    setup();
    await loaded();
    expect(screen.queryByText(FOOTNOTE)).not.toBeInTheDocument();
  });

  test("is under the table when another user's session has its details hidden, and the blank cells are dashes", async () => {
    m.sessions.mockResolvedValue([...sampleSessions(), hidden()]);
    setup();
    await loaded();
    const note = screen.getByText(FOOTNOTE);
    expect(note).toBeInTheDocument();
    expect(table().compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const row = bodyRows()[5];
    expect(cellAt(row, "역할")).toHaveTextContent("carol");
    expect(cellAt(row, "클라이언트")).toHaveTextContent("—");
    expect(cellAt(row, "상태")).toHaveTextContent("—");
    expect(cellAt(row, "시작")).toHaveTextContent("—");
    expect(cellAt(row, "대기")).toHaveTextContent("—");
  });

  test("is there once, however many sessions are hidden", async () => {
    m.sessions.mockResolvedValue([hidden(), hidden({ pid: 4002 }), hidden({ pid: 4003, role: "dave" })]);
    setup();
    await loaded();
    expect(screen.getAllByText(FOOTNOTE)).toHaveLength(1);
  });

  test("a session of this app without a state is not hidden from this DB user", async () => {
    m.sessions.mockResolvedValue([{ ...sampleSessions()[3], state: null }]);
    setup();
    await loaded();
    expect(screen.queryByText(FOOTNOTE)).not.toBeInTheDocument();
  });

  test("follows what the table shows: a filter that leaves only complete sessions takes it away", async () => {
    m.sessions.mockResolvedValue([...sampleSessions(), hidden()]);
    setup();
    await loaded();
    fireEvent.change(roleFilter(), { target: { value: "alice" } });
    expect(screen.queryByText(FOOTNOTE)).not.toBeInTheDocument();
    fireEvent.change(roleFilter(), { target: { value: "carol" } });
    expect(screen.getByText(FOOTNOTE)).toBeInTheDocument();
  });
});
