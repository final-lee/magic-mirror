import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/client";
import type { Settings } from "../api/types";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import { changeSummary } from "./changeText";
import {
  LOGIN_USER,
  defaultAuditRead,
  ordersTable,
  pgTarget,
  removeBobFromWriters,
  sampleBatchPreview,
  sampleCellDetail,
  sampleChangeLog,
  sampleDatabaseView,
  sampleFindings,
  sampleOverview,
  samplePreview,
  sampleRoleView,
  sampleSessions,
  sampleTargetInfo,
  sampleWhoCan,
} from "./fixtures";
import { PgTab } from "./PgTab";
import type { PgBatchPreview, PgChange, PgWarning } from "./types";

vi.mock("./api", () => ({
  pgApi: {
    target: vi.fn(),
    open: vi.fn(),
    database: vi.fn(),
    cell: vi.fn(),
    objects: vi.fn(),
    role: vi.fn(),
    whoCan: vi.fn(),
    sessions: vi.fn(),
    findings: vi.fn(),
    close: vi.fn(),
    overview: vi.fn(),
    preview: vi.fn(),
    apply: vi.fn(),
    previewBatch: vi.fn(),
    applyBatch: vi.fn(),
    changeLog: vi.fn(),
    undo: vi.fn(),
    undoBatch: vi.fn(),
  },
}));
vi.mock("../api/client", () => ({ api: { getSettings: vi.fn(), saveSettings: vi.fn(), ssoLogin: vi.fn() } }));
vi.mock("../explorer/api", () => ({ onMouseNav: vi.fn(async () => () => {}) }));

const m = vi.mocked(pgApi);
const ARN = sampleTargetInfo().arn;
const MANAGE_REASON = "이 사용자는 rds_superuser 멤버가 아니고 CREATEROLE도 없어서 바꿀 수 없어요";
const READ_REPLICA = "읽기 전용 복제본이라 바꿀 수 없어요";
const AFTER = "2026-10-29T12:30:00Z";

type Props = React.ComponentProps<typeof PgTab>;
const baseProps: Props = { target: pgTarget, title: "🐘 orders-aurora", active: true, filter: "" };

function setup(extra: Partial<Props> = {}) {
  const utils = renderWithClient(<PgTab {...baseProps} {...extra} />);
  const update = (next: Partial<Props>) =>
    utils.rerender(
      <QueryClientProvider client={utils.qc as QueryClient}>
        <PgTab {...baseProps} {...extra} {...next} />
      </QueryClientProvider>,
    );
  return { ...utils, update };
}

const settings: Settings = { enabledServices: ["ec2", "rds"], favorites: [], lastProfile: "prod", lastRegion: null, pgLogins: { [ARN]: LOGIN_USER } };

const topBar = () => within(screen.getByRole("group", { name: "연결 정보" }));
const menu = () => within(screen.getByRole("navigation", { name: "PostgreSQL 메뉴" }));
const openMenu = (label: string) => fireEvent.click(menu().getByText(label).closest("button")!);
const connected = () => screen.findByRole("navigation", { name: "PostgreSQL 메뉴" });
/** 연결 정보 줄의 [바꾸기](DB 사용자)와 다른 버튼이다: 모드를 켜고 끄는 버튼은 눌림 상태(aria-pressed)가 있다 */
const modeToggle = () => screen.getByRole("button", { name: "바꾸기", pressed: false });
const modeToggleOn = () => screen.getByRole("button", { name: "바꾸기", pressed: true });
const anyToggle = () => screen.getAllByRole("button", { name: "바꾸기" }).find((b) => b.hasAttribute("aria-pressed"))!;
const grid = () => screen.getByRole("grid", { name: "권한 표" });
const cellOf = (role: string, schema: string) => within(grid()).getByRole("button", { name: (n) => n.startsWith(`${role} · ${schema}: `) });
const loadedGrid = () => screen.findByRole("grid", { name: "권한 표" });
const openPrivileges = async () => {
  await connected();
  openMenu("권한");
  return loadedGrid();
};
/** 모드를 켠 권한 표 */
const editPrivileges = async () => {
  await openPrivileges();
  fireEvent.click(modeToggle());
};
const brushGroup = () => screen.queryByRole("group", { name: "칠할 권한" });
/** 아래쪽 막대의 요약 글. 장바구니가 비어 있으면 null */
const tray = () => screen.queryByText(/^변경 \d+개 · /)?.textContent ?? null;

const readAudit = (grantee: string, add = true): PgChange => ({
  kind: "grant",
  database: "orders",
  grantee,
  add,
  items: [{ target: { kind: "allTables", schema: "audit" }, privileges: ["SELECT"] }],
});

/** 담은 변경들을 그대로 돌려주는 묶음 미리보기 */
const batchPreview = (database: string, changes: PgChange[], warnings: PgWarning[] = []): PgBatchPreview =>
  sampleBatchPreview({
    database,
    items: changes.map((change) => ({ change, summary: changeSummary(change), sql: [`-- ${changeSummary(change)}`], warnings: [] })),
    sql: changes.map((change) => `-- ${changeSummary(change)}`),
    impacts: [],
    roles: [],
    defaults: [],
    warnings,
  });

beforeEach(() => {
  vi.clearAllMocks();
  document.querySelectorAll(".modal").forEach((e) => e.remove());
  vi.mocked(api.getSettings).mockResolvedValue(settings);
  vi.mocked(api.saveSettings).mockResolvedValue(undefined);
  m.target.mockResolvedValue(sampleTargetInfo());
  m.open.mockResolvedValue(sampleOverview());
  m.overview.mockResolvedValue(sampleOverview({ fetchedAt: AFTER }));
  m.database.mockImplementation(async (_t, database) => sampleDatabaseView({ database }));
  m.cell.mockImplementation(async (_t, _database, role, schema) => sampleCellDetail({ role, schema }));
  m.findings.mockResolvedValue(sampleFindings());
  m.role.mockImplementation(async (_t, role) => sampleRoleView(role));
  m.sessions.mockResolvedValue(sampleSessions());
  m.objects.mockResolvedValue([ordersTable]);
  m.whoCan.mockResolvedValue(sampleWhoCan());
  m.close.mockResolvedValue(null);
  m.changeLog.mockResolvedValue(sampleChangeLog());
  m.previewBatch.mockImplementation(async (_t, database, changes) => batchPreview(database, changes));
  m.applyBatch.mockResolvedValue({ batchId: "b-9", logIds: ["b-9-1"], summary: "변경 1개" });
});

describe("the 바꾸기 toggle", () => {
  test("is in the bar above the screens, off at first, and is not the 바꾸기 of the DB user", async () => {
    setup();
    await connected();
    expect(modeToggle()).toBeEnabled();
    expect(modeToggle()).not.toHaveAttribute("title");
    // the DB user keeps its own 바꾸기, in the line about the connection
    const own = topBar().getByRole("button", { name: "바꾸기" });
    expect(own).not.toHaveAttribute("aria-pressed");
    expect(modeToggle().closest("[aria-label='연결 정보']")).toBeNull();
    expect(modeToggle().closest(".iam-bar")).not.toBeNull();
  });

  test("is there on every screen", async () => {
    setup();
    await connected();
    for (const label of ["역할", "권한", "기본 권한", "누가 할 수 있나", "세션", "변경 기록", "점검"]) {
      openMenu(label);
      expect(anyToggle(), label).toBeInTheDocument();
    }
  });

  test("pressing it turns it on, and pressing it again turns it off", async () => {
    setup();
    await connected();
    fireEvent.click(modeToggle());
    expect(modeToggleOn()).toHaveClass("primary");
    fireEvent.click(modeToggleOn());
    expect(modeToggle()).not.toHaveClass("primary");
  });

  test("turns the brush group of the privileges on and off", async () => {
    setup();
    await openPrivileges();
    expect(brushGroup()).not.toBeInTheDocument();
    fireEvent.click(modeToggle());
    expect(brushGroup()).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "읽기" })).toBeChecked();
    fireEvent.click(modeToggleOn());
    expect(brushGroup()).not.toBeInTheDocument();
  });

  test("stays on when the user moves to other screens and back", async () => {
    setup();
    await editPrivileges();
    openMenu("기본 권한");
    await screen.findByRole("table", { name: "기본 권한" });
    expect(modeToggleOn()).toBeInTheDocument();
    openMenu("권한");
    await loadedGrid();
    expect(brushGroup()).toBeInTheDocument();
  });

  test("on a read replica it is off, with the reason as its title and description, and pressing it does nothing", async () => {
    m.open.mockResolvedValue(sampleOverview({ target: sampleTargetInfo({ readReplica: true }) }));
    setup();
    await openPrivileges();
    const toggle = modeToggle();
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("title", READ_REPLICA);
    expect(toggle).toHaveAccessibleDescription(READ_REPLICA);
    fireEvent.click(toggle);
    expect(modeToggle()).toBeInTheDocument();
    expect(brushGroup()).not.toBeInTheDocument();
  });

  test("for a login that cannot manage roles it is off with the reason the first stage gave", async () => {
    m.open.mockResolvedValue(sampleOverview({ canManage: false, manageReason: MANAGE_REASON }));
    setup();
    await connected();
    expect(modeToggle()).toBeDisabled();
    expect(modeToggle()).toHaveAttribute("title", MANAGE_REASON);
    expect(modeToggle()).toHaveAccessibleDescription(MANAGE_REASON);
  });

  test("a read replica comes before the manage reason", async () => {
    m.open.mockResolvedValue(sampleOverview({ canManage: false, manageReason: MANAGE_REASON, target: sampleTargetInfo({ readReplica: true }) }));
    setup();
    await connected();
    expect(modeToggle()).toHaveAttribute("title", READ_REPLICA);
  });

  test("goes off by itself when the login can no longer change, and stays off when it can again", async () => {
    setup();
    await editPrivileges();
    expect(brushGroup()).toBeInTheDocument();
    m.open.mockResolvedValue(sampleOverview({ canManage: false, manageReason: MANAGE_REASON }));
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(modeToggle()).toBeDisabled());
    expect(brushGroup()).not.toBeInTheDocument();
    m.open.mockResolvedValue(sampleOverview());
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(modeToggle()).toBeEnabled());
    expect(brushGroup()).not.toBeInTheDocument(); // it does not come back on by itself
  });
});

describe("the hint above the screens", () => {
  test("says why changing is off on a read replica", async () => {
    m.open.mockResolvedValue(sampleOverview({ target: sampleTargetInfo({ readReplica: true }) }));
    setup();
    await connected();
    expect(document.querySelector(".iam-hint")).toHaveTextContent(READ_REPLICA);
  });

  test("says the manage reason of the login when the target is not a replica", async () => {
    m.open.mockResolvedValue(sampleOverview({ canManage: false, manageReason: MANAGE_REASON }));
    setup();
    await connected();
    expect(document.querySelector(".iam-hint")).toHaveTextContent(MANAGE_REASON);
  });

  test("says only the replica text when both apply", async () => {
    m.open.mockResolvedValue(sampleOverview({ canManage: false, manageReason: MANAGE_REASON, target: sampleTargetInfo({ readReplica: true }) }));
    setup();
    await connected();
    expect(screen.getAllByText(READ_REPLICA)).toHaveLength(1);
    expect(screen.queryByText(MANAGE_REASON)).not.toBeInTheDocument();
  });

  test("is not there when changing is possible", async () => {
    setup();
    await connected();
    expect(document.querySelector(".iam-hint")).toBeNull();
  });
});

describe("the tray", () => {
  test("is not there while nothing is queued", async () => {
    setup();
    await editPrivileges();
    expect(tray()).toBeNull();
    expect(screen.queryByRole("button", { name: "미리보기" })).not.toBeInTheDocument();
  });

  test("shows what was queued from a cell of the privileges table", async () => {
    setup();
    await editPrivileges();
    fireEvent.click(cellOf("alice", "audit"));
    expect(tray()).toBe("변경 1개 · 권한 주기: alice · audit 스키마의 모든 테이블 SELECT");
    fireEvent.click(cellOf("bob", "audit"));
    expect(tray()).toBe("변경 2개 · 권한 주기: alice · audit 스키마의 모든 테이블 SELECT 외 1개");
  });

  test("stays when the user moves to another screen, and keeps the cell marks when they come back", async () => {
    setup();
    await editPrivileges();
    fireEvent.click(cellOf("alice", "audit"));
    openMenu("역할");
    expect(tray()).toBe("변경 1개 · 권한 주기: alice · audit 스키마의 모든 테이블 SELECT");
    openMenu("권한");
    await loadedGrid();
    expect(cellOf("alice", "audit")).toHaveAccessibleName("alice · audit: 읽기 줄 예정");
  });

  test("stays when 바꾸기 mode is turned off, and its 미리보기 still works", async () => {
    setup();
    await editPrivileges();
    fireEvent.click(cellOf("alice", "audit"));
    fireEvent.click(modeToggleOn());
    expect(brushGroup()).not.toBeInTheDocument();
    expect(tray()).toBe("변경 1개 · 권한 주기: alice · audit 스키마의 모든 테이블 SELECT");
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    expect(await screen.findByRole("dialog", { name: "변경 1개" })).toBeInTheDocument();
  });

  test("모두 취소 empties it and the marks go off the cells", async () => {
    setup();
    await editPrivileges();
    fireEvent.click(cellOf("alice", "audit"));
    fireEvent.click(screen.getByRole("button", { name: "모두 취소" }));
    expect(tray()).toBeNull();
    expect(cellOf("alice", "audit")).toHaveAccessibleName("alice · audit: 읽기 없음");
  });

  test("a change is taken out from the list of the tray by its ×", async () => {
    setup();
    await editPrivileges();
    fireEvent.click(cellOf("alice", "audit"));
    fireEvent.click(cellOf("bob", "audit"));
    fireEvent.click(screen.getByRole("button", { name: /^변경 2개/ }));
    fireEvent.click(screen.getByRole("button", { name: "권한 주기: alice · audit 스키마의 모든 테이블 SELECT 취소" }));
    expect(tray()).toBe("변경 1개 · 권한 주기: bob · audit 스키마의 모든 테이블 SELECT");
  });

  test("is lost when the tab is closed", async () => {
    const first = setup();
    await editPrivileges();
    fireEvent.click(cellOf("alice", "audit"));
    expect(tray()).not.toBeNull();
    first.unmount();
    setup();
    await openPrivileges();
    expect(tray()).toBeNull();
  });
});

describe("미리보기 and 적용 of the tray", () => {
  async function queueTwo() {
    await editPrivileges();
    fireEvent.click(cellOf("alice", "audit"));
    fireEvent.click(cellOf("bob", "audit"));
  }

  test("opens the batch preview in the database the changes are for, with the changes in the order they were queued", async () => {
    setup();
    await queueTwo();
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    expect(await screen.findByRole("dialog", { name: "변경 2개" })).toBeInTheDocument();
    expect(m.previewBatch).toHaveBeenCalledWith(pgTarget, "orders", [readAudit("alice"), readAudit("bob")]);
    expect(screen.getByText("적용할 DB 사용자: iam_admin")).toBeInTheDocument();
  });

  test("applies the batch with the same database and changes, and the tray is empty afterwards", async () => {
    m.applyBatch.mockResolvedValue({ batchId: "b-9", logIds: ["b-9-1", "b-9-2"], summary: "변경 2개" });
    setup();
    await queueTwo();
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    fireEvent.click(await screen.findByRole("button", { name: "적용" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(m.applyBatch).toHaveBeenCalledWith(pgTarget, "orders", [readAudit("alice"), readAudit("bob")], null, null);
    expect(tray()).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("변경 2개");
    // the screens are read again, without connecting again
    await waitFor(() => expect(m.overview).toHaveBeenCalledWith(pgTarget));
    expect(m.open).toHaveBeenCalledTimes(1);
  });

  test("the refresh-failed note goes away when a 다시 읽기 succeeds, and stays when it fails", async () => {
    m.applyBatch.mockResolvedValue({ batchId: "b-9", logIds: ["b-9-1", "b-9-2"], summary: "변경 2개" });
    m.overview.mockRejectedValue({ kind: "other", message: "먼저 연결해 주세요" });
    setup();
    await queueTwo();
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    fireEvent.click(await screen.findByRole("button", { name: "적용" }));
    const note = "적용은 됐지만 목록을 다시 읽지 못했어요. [다시 읽기]를 눌러 주세요";
    expect(await screen.findByText(note)).toBeInTheDocument();
    m.open.mockRejectedValue({ kind: "network", message: "timeout" });
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(m.open).toHaveBeenCalledTimes(2));
    expect(screen.getByText(note)).toBeInTheDocument();
    m.open.mockResolvedValue(sampleOverview());
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(screen.queryByText(note)).not.toBeInTheDocument());
  });

  test("a failed apply keeps the dialog open and the tray as it was", async () => {
    m.applyBatch.mockRejectedValue({ kind: "other", message: "미리보기 뒤에 바뀌었어요. 미리보기를 다시 받아 주세요" });
    setup();
    await queueTwo();
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    fireEvent.click(await screen.findByRole("button", { name: "적용" }));
    expect(await screen.findByText("미리보기 뒤에 바뀌었어요. 미리보기를 다시 받아 주세요")).toBeInTheDocument();
    expect(tray()).toBe("변경 2개 · 권한 주기: alice · audit 스키마의 모든 테이블 SELECT 외 1개");
  });

  test("closing the preview leaves the tray as it was", async () => {
    setup();
    await queueTwo();
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    fireEvent.click(await screen.findByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(m.applyBatch).not.toHaveBeenCalled();
    expect(tray()).not.toBeNull();
  });

  test("a warning that carries default privileges has 기본 권한도 담기, which puts them in the tray and says how many", async () => {
    m.previewBatch.mockImplementation(async (_t, database, changes) =>
      batchPreview(database, changes, [{ level: "warn", message: "새로 만드는 테이블에는 적용되지 않아요", add: [defaultAuditRead] }]),
    );
    setup();
    await queueTwo();
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    fireEvent.click(await screen.findByRole("button", { name: "기본 권한도 담기" }));
    expect(tray()).toBe("변경 3개 · 권한 주기: alice · audit 스키마의 모든 테이블 SELECT 외 2개");
    expect(screen.getByText("기본 권한 1개를 담았어요")).toBeInTheDocument();
    // a second press adds nothing new and says nothing more
    fireEvent.click(screen.getByRole("button", { name: "기본 권한도 담기" }));
    expect(screen.getAllByText("기본 권한 1개를 담았어요")).toHaveLength(1);
    expect(tray()).toMatch(/^변경 3개/);
  });

  test("the dialog of an undo from the change log has no 기본 권한도 담기: that dialog is not for the tray", async () => {
    m.undo.mockResolvedValue({ database: "orders", changes: [removeBobFromWriters], undoOf: ["b-1-2"] });
    m.preview.mockImplementation(async (_t, change) =>
      samplePreview({ change, summary: changeSummary(change), warnings: [{ level: "warn", message: "새로 만드는 테이블에는 적용되지 않아요", add: [defaultAuditRead] }] }),
    );
    setup();
    await connected();
    openMenu("변경 기록");
    await screen.findByRole("table", { name: "변경 기록" });
    const member = screen.getAllByRole("row").find((r) => r.textContent?.includes("그룹에 넣기: bob → app_write") && !r.className.includes("cl-batch"))!;
    fireEvent.click(within(member).getByRole("button", { name: "되돌리기" }));
    await screen.findByRole("dialog", { name: "되돌리기 미리보기" });
    expect(screen.getByText("새로 만드는 테이블에는 적용되지 않아요")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "기본 권한도 담기" })).not.toBeInTheDocument();
  });

  test("the dialog of a batch undo from the change log has no 기본 권한도 담기 either", async () => {
    m.undoBatch.mockResolvedValue({ database: "orders", changes: [removeBobFromWriters], undoOf: ["b-1-2", "b-1-1"] });
    m.previewBatch.mockImplementation(async (_t, database, changes) => batchPreview(database, changes, [{ level: "warn", message: "새로 만드는 테이블에는 적용되지 않아요", add: [defaultAuditRead] }]));
    setup();
    await connected();
    openMenu("변경 기록");
    await screen.findByRole("table", { name: "변경 기록" });
    fireEvent.click(screen.getByRole("button", { name: "묶음 되돌리기" }));
    await screen.findByRole("dialog", { name: "되돌리기 미리보기" });
    expect(screen.getByText("새로 만드는 테이블에는 적용되지 않아요")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "기본 권한도 담기" })).not.toBeInTheDocument();
  });
});

describe("where the tray and the notices sit", () => {
  // styles.css gives .asg-tray and .asg-notice their layout under .pg; without this ancestor they would be unstyled
  test("the tray bar is inside .pg", async () => {
    setup();
    await editPrivileges();
    fireEvent.click(cellOf("alice", "audit"));
    expect(document.querySelector(".asg-tray")?.closest(".pg")).not.toBeNull();
  });

  test("the draft notice is inside .pg", async () => {
    setup();
    await editPrivileges();
    fireEvent.click(cellOf("alice", "audit"));
    fireEvent.change(screen.getByRole("combobox", { name: "데이터베이스" }), { target: { value: "analytics" } });
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", false));
    await loadedGrid();
    fireEvent.click(cellOf("bob", "audit"));
    expect(document.querySelector(".asg-notice")?.closest(".pg")).not.toBeNull();
  });
});

describe("what the tray refuses", () => {
  test("a change for another database than the one in the tray is not queued, and the notice can be closed", async () => {
    setup();
    await editPrivileges();
    fireEvent.click(cellOf("alice", "audit"));
    fireEvent.change(screen.getByRole("combobox", { name: "데이터베이스" }), { target: { value: "analytics" } });
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", false));
    await loadedGrid();
    fireEvent.click(cellOf("bob", "audit"));
    expect(tray()).toBe("변경 1개 · 권한 주기: alice · audit 스키마의 모든 테이블 SELECT");
    const notice = screen.getByText("다른 데이터베이스의 변경이 담겨 있어요. 먼저 적용하거나 비워 주세요").closest("[role='status']") as HTMLElement;
    fireEvent.click(within(notice).getByRole("button", { name: "안내 닫기" }));
    expect(screen.queryByText("다른 데이터베이스의 변경이 담겨 있어요. 먼저 적용하거나 비워 주세요")).not.toBeInTheDocument();
  });

  test("a batch opened from the tray runs in the database of the tray, not in the one on screen", async () => {
    setup();
    await editPrivileges();
    fireEvent.click(cellOf("alice", "audit"));
    fireEvent.change(screen.getByRole("combobox", { name: "데이터베이스" }), { target: { value: "analytics" } });
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", false));
    await loadedGrid();
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    await screen.findByRole("dialog", { name: "변경 1개" });
    expect(m.previewBatch).toHaveBeenCalledWith(pgTarget, "orders", [readAudit("alice")]);
  });
});

describe("editing in the cell panel, the default privileges and the role detail", () => {
  test("a revoke from the cell panel, a default privilege and a group go into the same tray, and nothing is shown while 바꾸기 is off", async () => {
    setup();
    await openPrivileges();
    // 바꾸기 모드가 꺼져 있으면 칸 상세에는 [빼기]가 없다
    fireEvent.click(cellOf("alice", "app"));
    fireEvent.click(await screen.findByRole("tab", { name: "시퀀스 1" }));
    await screen.findByText("app.orders_id_seq");
    expect(screen.queryByRole("button", { name: "객체에 권한 주기" })).not.toBeInTheDocument();
    fireEvent.click(modeToggle());
    fireEvent.click(within(screen.getByText("USAGE").closest("[data-testid=privilege-edit]") as HTMLElement).getByRole("button", { name: "빼기" }));
    expect(tray()).toBe("변경 1개 · 권한 빼기: alice · app.orders_id_seq USAGE");

    openMenu("기본 권한");
    fireEvent.click(await screen.findByRole("button", { name: "기본 권한 추가" }));
    const form = screen.getByRole("dialog", { name: "기본 권한 추가" });
    fireEvent.change(within(form).getByRole("combobox", { name: "받는 역할" }), { target: { value: "PUBLIC" } });
    fireEvent.click(within(form).getByRole("checkbox", { name: "SELECT" }));
    fireEvent.click(within(form).getByRole("button", { name: "담기" }));
    expect(tray()).toMatch(/^변경 2개 · /);

    openMenu("역할");
    fireEvent.doubleClick(await screen.findByText("alice"));
    fireEvent.click(await screen.findByRole("tab", { name: "구성원" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /pg_read_all_data/ }));
    expect(tray()).toMatch(/^변경 3개 · /);
  });
});
