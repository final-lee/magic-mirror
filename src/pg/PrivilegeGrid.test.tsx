import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import { ROLES, attributes, dbAspects, pgTarget, role, sampleCellDetail, sampleDatabaseView, sampleOverview, schemaAspects } from "./fixtures";
import { HEAD_H, PrivilegeGrid, ROW_H } from "./PrivilegeGrid";
import { pgKeys } from "./queries";
import { DEFAULT_KINDS, type RoleKindsValue } from "./RoleKinds";
import type { SchemaFocus } from "./route";
import type { PgDatabaseView, PgDbPrivilegeRow, PgRoleSummary, PgSchemaCell } from "./types";

vi.mock("./api", () => ({ pgApi: { database: vi.fn(), cell: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(pgApi);

const overview = sampleOverview();

type Props = Partial<React.ComponentProps<typeof PrivilegeGrid>> & { initialKinds?: RoleKindsValue };

/** 칩 상태와 고른 데이터베이스는 PgTab이 들고 있다(경로에 기억한다). 여기서는 같은 일을 하는 작은 부모를 쓴다. */
function Harness({ initialKinds = DEFAULT_KINDS, database: initialDatabase, onDatabase, ...rest }: Props) {
  const [kinds, setKinds] = useState(initialKinds);
  const [database, setDatabase] = useState(initialDatabase);
  return (
    <PrivilegeGrid
      target={pgTarget}
      overview={overview}
      database={database}
      onDatabase={(next) => {
        setDatabase(next);
        onDatabase?.(next);
      }}
      filter=""
      kinds={kinds}
      onKinds={setKinds}
      {...rest}
    />
  );
}

function setup(props: Props = {}) {
  const onDatabase = vi.fn();
  const utils = renderWithClient(<Harness onDatabase={onDatabase} {...props} />);
  const update = (next: Props) =>
    utils.rerender(
      <QueryClientProvider client={utils.qc as QueryClient}>
        <Harness onDatabase={onDatabase} {...props} {...next} />
      </QueryClientProvider>,
    );
  return { onDatabase, update, ...utils };
}

const grid = () => screen.getByRole("grid", { name: "권한 표" });
const scroller = () => grid().closest(".pg-scroll") as HTMLElement;
/** "역할 · 스키마: …"라는 이름의 칸(버튼) */
const cellOf = (roleName: string, schema: string) => within(grid()).getByRole("button", { name: (n) => n.startsWith(`${roleName} · ${schema}: `) });
const cellAt = (roleName: string, schema: string) => within(grid()).queryByRole("button", { name: (n) => n.startsWith(`${roleName} · ${schema}: `) });
const rowOf = (roleName: string) => within(grid()).getByRole("rowheader", { name: roleName }).closest("tr") as HTMLElement;
const dbCell = (roleName: string) => within(rowOf(roleName)).getByRole("gridcell", { name: (n) => n.startsWith(`${roleName} · 데이터베이스: `) });
const rowHeads = () => within(grid()).getAllByRole("rowheader").map((h) => h.textContent);
const columnHeads = () => within(grid()).getAllByRole("columnheader");
const picker = () => screen.getByRole("combobox", { name: "데이터베이스" });
const panel = () => screen.getByRole("complementary");
/** 데이터가 와서 표가 그려질 때까지 기다린다 */
const loaded = () => screen.findByRole("grid", { name: "권한 표" });
/** jsdom은 크기를 재지 못한다. 표가 머리 행 아래로 보여 주는 줄 수를 정해 준다(종류 머리도 한 줄이다). 되돌리는 일은 부르는 쪽이 한다. */
const showLines = (count: number) =>
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("pg-scroll") ? HEAD_H + count * ROW_H : 0;
  });

const emptyCell = (roleName: string, schema: string): PgSchemaCell => ({
  role: roleName,
  schema,
  usage: false,
  create: false,
  read: "none",
  write: "none",
  inheritedOnly: false,
  unusable: null,
  direct: schemaAspects(),
  owned: schemaAspects(),
});
const dbRow = (roleName: string): PgDbPrivilegeRow => ({ role: roleName, connect: true, create: false, temp: true, direct: dbAspects(), owned: dbAspects() });

/** 역할 목록과 스키마 이름에서 만든 데이터베이스 보기: 모든 칸이 비어 있다 */
function viewOf(roles: PgRoleSummary[], schemas: string[], extra: Partial<PgDatabaseView> = {}): PgDatabaseView {
  return sampleDatabaseView({
    dbPrivileges: roles.map((r) => dbRow(r.name)),
    schemas: schemas.map((name) => ({ name, owner: "app_owner", tableCount: 1 })),
    cells: roles.flatMap((r) => schemas.map((s) => emptyCell(r.name, s))),
    ...extra,
  });
}

const manyUsers = (n = 300) => Array.from({ length: n }, (_, i) => role(`user-${String(i).padStart(3, "0")}`, { attributes: attributes({ login: true }) }));

beforeEach(() => {
  vi.clearAllMocks();
  m.database.mockImplementation(async (_t, database) => sampleDatabaseView({ database }));
  m.cell.mockImplementation(async (_t, _d, roleName, schema) => sampleCellDetail({ role: roleName, schema }));
});

describe("loading", () => {
  test("reads the default database of the target, without force, and says so until it arrives", async () => {
    let resolve!: (v: PgDatabaseView) => void;
    m.database.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    expect(screen.getByText("불러오는 중…")).toBeInTheDocument();
    expect(m.database).toHaveBeenCalledTimes(1);
    expect(m.database).toHaveBeenCalledWith(pgTarget, "orders", false);
    // 읽는 동안에도 데이터베이스는 바꿀 수 있고 칩도 보인다
    expect(picker()).toHaveValue("orders");
    expect(screen.getByRole("checkbox", { name: "시스템 역할 보기" })).toBeInTheDocument();
    await act(async () => resolve(sampleDatabaseView()));
    expect(await loaded()).toBeInTheDocument();
    expect(screen.queryByText("불러오는 중…")).not.toBeInTheDocument();
  });

  test("shows why it failed through the error box, with the picker still there, and 다시 시도 reads it again", async () => {
    m.database.mockRejectedValueOnce({ kind: "other", message: '"orders"에 연결하지 못했어요: connection refused' });
    setup();
    expect(await screen.findByText('"orders"에 연결하지 못했어요: connection refused')).toBeInTheDocument();
    expect(picker()).toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    // 다시 시도는 대상 전체를 다시 읽는다(PgError). 쓰는 쪽이 없는 개요와 대상은 건너뛰고, 이 화면의 읽기는 다시 돈다
    await waitFor(() => expect(m.database).toHaveBeenCalledTimes(2));
    expect(await loaded()).toBeInTheDocument();
  });

  test("a read that fails after the grid was shown keeps it on screen with the error above", async () => {
    const { qc } = setup();
    await loaded();
    m.database.mockRejectedValueOnce({ kind: "network", message: "끊겼어요" });
    await act(async () => {
      await qc.invalidateQueries({ queryKey: pgKeys.database(pgTarget, "orders") });
    });
    expect(await screen.findByText("네트워크 오류: 끊겼어요")).toBeInTheDocument();
    expect(grid()).toBeInTheDocument();
  });
});

describe("the database", () => {
  test("is chosen from the databases that accept connections, and starts at the default one of the target", async () => {
    setup();
    await loaded();
    expect(within(picker()).getAllByRole("option").map((o) => o.textContent)).toEqual(["analytics", "orders", "postgres"]);
    expect(picker()).toHaveValue("orders");
  });

  test("a database remembered in the route is the one that is read", async () => {
    setup({ database: "analytics" });
    await loaded();
    expect(picker()).toHaveValue("analytics");
    expect(m.database).toHaveBeenCalledTimes(1);
    expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", false);
  });

  test("a remembered database that no longer accepts connections falls back to the default one", async () => {
    setup({ database: "legacy_archive" });
    await loaded();
    expect(picker()).toHaveValue("orders");
    expect(m.database).toHaveBeenCalledWith(pgTarget, "orders", false);
    expect(m.database).not.toHaveBeenCalledWith(pgTarget, "legacy_archive", expect.anything());
  });

  test("choosing another one tells the screen that remembers it, and reads that database", async () => {
    const { onDatabase } = setup();
    await loaded();
    fireEvent.change(picker(), { target: { value: "postgres" } });
    expect(onDatabase).toHaveBeenCalledTimes(1);
    expect(onDatabase).toHaveBeenCalledWith("postgres");
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "postgres", false));
    expect(picker()).toHaveValue("postgres");
  });

  test("while the other database is being read the old grid is gone, and the picker stays", async () => {
    setup();
    await loaded();
    m.database.mockImplementation((_t, database) => (database === "analytics" ? new Promise(() => {}) : Promise.resolve(sampleDatabaseView({ database }))));
    fireEvent.change(picker(), { target: { value: "analytics" } });
    expect(await screen.findByText("불러오는 중…")).toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(picker()).toHaveValue("analytics");
  });

  test("each database has its own grid: the schemas are the ones of the database that was chosen", async () => {
    m.database.mockImplementation(async (_t, database) =>
      database === "analytics" ? viewOf(ROLES, ["reports"], { database }) : sampleDatabaseView({ database }),
    );
    setup();
    await loaded();
    expect(columnHeads().map((h) => h.querySelector(".pg-colname")?.textContent)).toEqual(["역할", "데이터베이스", "app", "audit"]);
    fireEvent.change(picker(), { target: { value: "analytics" } });
    await waitFor(() => expect(cellAt("alice", "reports")).toBeInTheDocument());
    expect(columnHeads().map((h) => h.querySelector(".pg-colname")?.textContent)).toEqual(["역할", "데이터베이스", "reports"]);
  });

  test("a cluster with no database to connect to says so, and reads nothing", () => {
    setup({ overview: sampleOverview({ databases: [{ name: "legacy_archive", owner: "app_owner", allowConn: false }] }) });
    expect(screen.getByText("연결할 수 있는 데이터베이스가 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "데이터베이스" })).not.toBeInTheDocument();
    expect(m.database).not.toHaveBeenCalled();
  });
});

describe("the rows", () => {
  test("are the users and then the groups, with how many there are, and no system roles", async () => {
    setup();
    await loaded();
    expect(rowHeads()).toEqual(["사용자 5", "alice", "app_owner", "bob", "iam_admin", "postgres", "그룹 2", "app_read", "app_write"]);
  });

  test("keep to name order within a kind, whatever order the roles come in", async () => {
    setup({ overview: sampleOverview({ roles: [...ROLES].reverse() }) });
    await loaded();
    expect(rowHeads()).toEqual(["사용자 5", "alice", "app_owner", "bob", "iam_admin", "postgres", "그룹 2", "app_read", "app_write"]);
  });

  test("have the same chips as the role list: each kind can be hidden", async () => {
    setup();
    await loaded();
    expect(screen.getByRole("group", { name: "종류" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "사용자" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "그룹" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "사용자" }));
    expect(rowHeads()).toEqual(["그룹 2", "app_read", "app_write"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "사용자" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "그룹" }));
    expect(rowHeads()).toEqual(["사용자 5", "alice", "app_owner", "bob", "iam_admin", "postgres"]);
  });

  test("have the same toggle as the role list: the system roles come in as groups", async () => {
    setup();
    await loaded();
    expect(screen.getByRole("checkbox", { name: "시스템 역할 보기" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "시스템 역할 보기" }));
    expect(rowHeads()).toEqual(["사용자 5", "alice", "app_owner", "bob", "iam_admin", "postgres", "그룹 5", "app_read", "app_write", "pg_read_all_data", "rds_iam", "rds_superuser"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "시스템 역할 보기" }));
    expect(screen.queryByText("rds_superuser")).not.toBeInTheDocument();
  });

  test("the toolbar filter matches the role names, ignoring case and the spaces around it", async () => {
    const { update } = setup({ filter: "APP_" });
    await loaded();
    expect(rowHeads()).toEqual(["사용자 1", "app_owner", "그룹 2", "app_read", "app_write"]);
    update({ filter: "  ali  " });
    expect(rowHeads()).toEqual(["사용자 1", "alice"]);
  });

  test("a filter that matches nothing says so, and keeps the chips and the picker", async () => {
    setup({ filter: "zzz" });
    await loaded();
    expect(screen.getByText("조건에 맞는 역할이 없어요")).toBeInTheDocument();
    expect(within(grid()).queryAllByRole("rowheader")).toHaveLength(0);
    expect(screen.getByRole("checkbox", { name: "사용자" })).toBeInTheDocument();
    expect(picker()).toBeInTheDocument();
  });

  test("a cluster without roles says so", async () => {
    setup({ overview: sampleOverview({ roles: [] }) });
    await loaded();
    expect(screen.getByText("역할이 없어요")).toBeInTheDocument();
  });

  test("a role the database view has nothing on shows empty cells", async () => {
    setup({ overview: sampleOverview({ roles: [...ROLES, role("newcomer", { attributes: attributes({ login: true }) })] }) });
    await loaded();
    expect(cellOf("newcomer", "app")).toHaveAccessibleName("newcomer · app: 사용 x, 만들기 x, 읽기 없음, 쓰기 없음");
    expect(dbCell("newcomer")).toHaveAccessibleName("newcomer · 데이터베이스: CONNECT x, CREATE x, TEMP x");
  });
});

describe("the columns", () => {
  test("are the role, then the database, then one per schema in name order", async () => {
    m.database.mockResolvedValue(viewOf(ROLES, ["zeta", "app", "audit"]));
    setup();
    await loaded();
    const heads = columnHeads();
    expect(heads).toHaveLength(5);
    expect(heads[0]).toHaveAccessibleName("역할");
    expect(heads[1]).toHaveAccessibleName("데이터베이스");
    expect(heads.slice(2).map((h) => h.querySelector(".pg-colname")?.textContent)).toEqual(["app", "audit", "zeta"]);
    expect(heads[2]).toHaveAccessibleName("app");
    expect(grid()).toHaveAttribute("aria-colcount", "5");
  });

  test("tell what the marks of a cell are, for those who look at them", async () => {
    setup();
    await loaded();
    const heads = columnHeads();
    expect(within(heads[1]).getByText("CONNECT")).toBeInTheDocument();
    expect(within(heads[1]).getByText("CREATE")).toBeInTheDocument();
    expect(within(heads[1]).getByText("TEMP")).toBeInTheDocument();
    for (const head of heads.slice(2)) {
      for (const word of ["사용", "만들기", "읽기", "쓰기"]) expect(within(head).getByText(word)).toBeInTheDocument();
    }
  });

  test("a database without schemas shows the database column alone, and says so", async () => {
    m.database.mockResolvedValue(viewOf(ROLES, []));
    setup();
    await loaded();
    expect(columnHeads().map((h) => h.querySelector(".pg-colname")?.textContent)).toEqual(["역할", "데이터베이스"]);
    expect(screen.getByText("스키마가 없어요")).toBeInTheDocument();
    expect(dbCell("alice")).toBeInTheDocument();
  });
});

describe("the database column", () => {
  test("shows CONNECT, CREATE and TEMP of every role", async () => {
    setup();
    await loaded();
    expect(dbCell("alice")).toHaveAccessibleName("alice · 데이터베이스: CONNECT o, CREATE x, TEMP o");
    expect(dbCell("app_owner")).toHaveAccessibleName("app_owner · 데이터베이스: CONNECT o, CREATE o, TEMP o");
    expect(dbCell("bob")).toHaveAccessibleName("bob · 데이터베이스: CONNECT x, CREATE x, TEMP o");
  });

  test("draws them as ● and ○ in that order", async () => {
    setup();
    await loaded();
    expect(dbCell("alice")).toHaveTextContent(/^●○●$/);
    expect(dbCell("app_owner")).toHaveTextContent(/^●●●$/);
    expect(dbCell("bob")).toHaveTextContent(/^○○●$/);
  });
});

describe("a cell", () => {
  test("has four marks, and its name tells each of them", async () => {
    setup();
    await loaded();
    expect(cellOf("alice", "app")).toHaveAccessibleName("alice · app: 사용 o, 만들기 x, 읽기 모든 테이블, 쓰기 일부 테이블");
    expect(cellOf("alice", "audit")).toHaveAccessibleName("alice · audit: 사용 x, 만들기 x, 읽기 없음, 쓰기 없음");
    expect(cellOf("app_owner", "app")).toHaveAccessibleName("app_owner · app: 사용 o, 만들기 o, 읽기 모든 테이블, 쓰기 모든 테이블");
    expect(cellOf("app_read", "app")).toHaveAccessibleName("app_read · app: 사용 o, 만들기 x, 읽기 모든 테이블, 쓰기 없음");
    expect(cellOf("bob", "app")).toHaveAccessibleName("bob · app: 사용 x, 만들기 x, 읽기 일부 테이블, 쓰기 없음");
  });

  test("draws the marks as ●, ◐ and ○: all, some, none", async () => {
    setup();
    await loaded();
    // 사용 만들기 읽기 쓰기
    expect(cellOf("alice", "app")).toHaveTextContent(/^●○●◐$/);
    expect(cellOf("alice", "audit")).toHaveTextContent(/^○○○○$/);
    expect(cellOf("app_owner", "app")).toHaveTextContent(/^●●●●$/);
    expect(cellOf("app_read", "app")).toHaveTextContent(/^●○●○$/);
  });

  test("colours each mark by what it says: all, some or none", async () => {
    setup();
    await loaded();
    const tones = (el: HTMLElement) => [...el.querySelectorAll(".pg-mark")].map((mark) => [...mark.classList].find((c) => c !== "pg-mark"));
    expect(tones(cellOf("alice", "app"))).toEqual(["pg-all", "pg-none", "pg-all", "pg-some"]);
    expect(tones(cellOf("alice", "audit"))).toEqual(["pg-none", "pg-none", "pg-none", "pg-none"]);
    expect(tones(cellOf("app_owner", "app"))).toEqual(["pg-all", "pg-all", "pg-all", "pg-all"]);
    expect(tones(dbCell("bob"))).toEqual(["pg-none", "pg-none", "pg-all"]);
  });

  test("is dimmed when everything it shows comes from groups or PUBLIC, and only then", async () => {
    setup();
    await loaded();
    expect(cellOf("alice", "app")).toHaveClass("pg-dimmed");
    expect(cellOf("iam_admin", "app")).toHaveClass("pg-dimmed");
    expect(cellOf("alice", "app")).toHaveAttribute("title", "그룹·PUBLIC으로만 받음");
    for (const [roleName, schema] of [
      ["app_owner", "app"],
      ["app_write", "app"],
      ["app_read", "app"],
      ["alice", "audit"],
    ]) {
      expect(cellOf(roleName, schema)).not.toHaveClass("pg-dimmed");
      expect(cellOf(roleName, schema)).not.toHaveAttribute("title");
    }
  });

  test("shows ⚠ and the reason when the privileges cannot really be used", async () => {
    setup();
    await loaded();
    const bob = cellOf("bob", "app");
    expect(bob).toHaveTextContent("⚠");
    expect(bob).toHaveAttribute("title", "권한은 있지만 실제로는 못 써요 (CONNECT 없음)");
    expect(within(grid()).getAllByText("⚠")).toHaveLength(1);
    expect(cellOf("alice", "app")).not.toHaveTextContent("⚠");
  });

  test("tells the reason to those who do not see the ⚠, as the description of the cell", async () => {
    setup();
    await loaded();
    const bob = cellOf("bob", "app");
    expect(bob).toHaveAccessibleDescription("권한은 있지만 실제로는 못 써요 (CONNECT 없음)");
    expect(bob).toHaveAccessibleName("bob · app: 사용 x, 만들기 x, 읽기 일부 테이블, 쓰기 없음"); // 이름은 그대로다
    // 설명은 칸이 가리키는 글이다(title만으로도 설명은 읽히니, 가리키는 쪽까지 확인한다)
    const why = bob.getAttribute("aria-describedby");
    expect(why).toBeTruthy();
    expect(document.getElementById(why!)).toHaveTextContent("권한은 있지만 실제로는 못 써요 (CONNECT 없음)");
    expect(document.getElementById(why!)).toHaveClass("sr-only"); // 눈에는 보이지 않는 글이다(IAM 표의 안내와 같은 규칙)
    expect(within(grid()).getAllByText(/실제로는 못 써요/)).toHaveLength(1); // 못 쓰는 칸만 말한다
    expect(cellOf("app_owner", "app")).not.toHaveAttribute("aria-describedby");
  });

  test("has a short line with the reason for the keyboard focus, in the cell and apart from its name", async () => {
    setup();
    await loaded();
    const hint = cellOf("bob", "app").querySelector(".pg-hint");
    expect(hint).toHaveTextContent(/^CONNECT 없음$/);
    expect(hint).toHaveAttribute("aria-hidden", "true"); // 이름과 설명이 이미 읽어 준다
    expect(cellOf("bob", "app")).toHaveAccessibleName("bob · app: 사용 x, 만들기 x, 읽기 일부 테이블, 쓰기 없음");
    expect(grid().querySelectorAll(".pg-hint")).toHaveLength(1); // 못 쓰는 칸만
    expect(within(grid()).getAllByText("⚠")).toHaveLength(1);
  });

  test("says USAGE when that is what is missing", async () => {
    const cells = sampleDatabaseView().cells.map((c) => (c.role === "alice" && c.schema === "audit" ? { ...c, read: "some" as const, unusable: "USAGE 없음" } : c));
    m.database.mockResolvedValue(sampleDatabaseView({ cells }));
    setup();
    await loaded();
    expect(cellOf("alice", "audit")).toHaveAttribute("title", "권한은 있지만 실제로는 못 써요 (USAGE 없음)");
    expect(cellOf("alice", "audit").querySelector(".pg-hint")).toHaveTextContent(/^USAGE 없음$/);
  });

  test("a dimmed cell that cannot be used says both", async () => {
    const cells = sampleDatabaseView().cells.map((c) => (c.role === "alice" && c.schema === "app" ? { ...c, unusable: "CONNECT 없음" } : c));
    m.database.mockResolvedValue(sampleDatabaseView({ cells }));
    setup();
    await loaded();
    expect(cellOf("alice", "app")).toHaveClass("pg-dimmed");
    expect(cellOf("alice", "app")).toHaveAttribute("title", "그룹·PUBLIC으로만 받음 · 권한은 있지만 실제로는 못 써요 (CONNECT 없음)");
  });

  test("is a plain button in this phase: it only opens the detail", async () => {
    setup();
    await loaded();
    expect(cellOf("alice", "app")).toHaveAttribute("type", "button");
    expect(cellOf("alice", "app")).toBeEnabled();
  });
});

describe("a truncated database", () => {
  test("says so above the grid", async () => {
    m.database.mockResolvedValue(sampleDatabaseView({ truncated: true }));
    setup();
    const note = await screen.findByText("객체가 많아 일부만 읽었어요");
    expect(grid()).toBeInTheDocument();
    expect(note.compareDocumentPosition(grid()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("a complete one does not", async () => {
    setup();
    await loaded();
    expect(screen.queryByText("객체가 많아 일부만 읽었어요")).not.toBeInTheDocument();
  });
});

describe("the detail of a cell", () => {
  test("opens beside the grid when the cell is clicked, for that role and schema of the database that is showing", async () => {
    setup();
    await loaded();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    fireEvent.click(cellOf("alice", "app"));
    expect(m.cell).toHaveBeenCalledWith(pgTarget, "orders", "alice", "app");
    expect(panel()).toHaveAccessibleName("alice · app");
    expect(await screen.findByText("app.customers")).toBeInTheDocument();
    expect(grid()).toBeInTheDocument(); // 표는 그대로 있다
  });

  test("marks the cell it is for", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    const selected = within(grid()).getAllByRole("gridcell", { selected: true });
    expect(selected).toHaveLength(1);
    expect(within(selected[0]).getByRole("button")).toHaveAccessibleName(/^alice · app: /);
  });

  test("moves on to another cell when that one is clicked", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    await screen.findByText("app.customers");
    fireEvent.click(cellOf("bob", "app"));
    expect(m.cell).toHaveBeenCalledWith(pgTarget, "orders", "bob", "app");
    expect(panel()).toHaveAccessibleName("bob · app");
    expect(screen.getAllByRole("complementary")).toHaveLength(1);
    expect(within(grid()).getAllByRole("gridcell", { selected: true })).toHaveLength(1);
    // bob의 칸은 쓸 수 없는 칸이다
    expect(within(panel()).getByText("권한은 있지만 실제로는 못 써요 (CONNECT 없음)")).toBeInTheDocument();
  });

  test("knows whether the role has BYPASSRLS", async () => {
    const roles = ROLES.map((r) => (r.name === "alice" ? { ...r, attributes: { ...r.attributes, bypassRls: true } } : r));
    setup({ overview: sampleOverview({ roles }) });
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    expect(await screen.findByText("행 수준 보안 켜짐 · BYPASSRLS라 적용되지 않아요")).toBeInTheDocument();
    fireEvent.click(cellOf("app_owner", "app"));
    expect(await screen.findByText("행 수준 보안 켜짐")).toBeInTheDocument();
  });

  test("shows what the backend says about the cell, with the sources in the chip titles", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    const item = (await screen.findByText("app.orders")).closest("li") as HTMLElement;
    expect(within(item).getByText("SELECT")).toHaveAttribute("title", "app_write ← app_read 그룹에서 받음");
  });

  test("[닫기] closes it and the focus goes back to the cell", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    await screen.findByText("app.customers");
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(cellOf("alice", "app")).toHaveFocus();
    expect(within(grid()).queryAllByRole("gridcell", { selected: true })).toHaveLength(0);
  });

  test("Esc inside the panel closes it, and the focus goes back to the cell", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("bob", "app"));
    expect(panel()).toHaveFocus();
    fireEvent.keyDown(panel(), { key: "Escape" });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(cellOf("bob", "app")).toHaveFocus();
  });

  test("Esc on the cell closes it too", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    act(() => cellOf("alice", "app").focus());
    fireEvent.keyDown(cellOf("alice", "app"), { key: "Escape" });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(cellOf("alice", "app")).toHaveFocus();
  });

  test("Esc on another cell closes it and leaves the focus on that cell", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    await screen.findByText("app.customers");
    act(() => cellOf("bob", "audit").focus()); // 키보드로 표로 돌아와 다른 칸에 있다
    fireEvent.keyDown(cellOf("bob", "audit"), { key: "Escape" });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(cellOf("bob", "audit")).toHaveFocus();
    expect(within(grid()).queryAllByRole("gridcell", { selected: true })).toHaveLength(0);
  });

  test("Esc inside the panel still gives the focus back to the cell it was opened from", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    await screen.findByText("app.customers");
    act(() => cellOf("bob", "audit").focus());
    act(() => panel().focus());
    fireEvent.keyDown(panel(), { key: "Escape" });
    expect(cellOf("alice", "app")).toHaveFocus();
  });

  test("Esc with nothing open does nothing", async () => {
    setup();
    await loaded();
    act(() => cellOf("alice", "app").focus());
    fireEvent.keyDown(cellOf("alice", "app"), { key: "Escape" });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(cellOf("alice", "app")).toHaveFocus();
  });

  test("closes when another database is chosen, as its cells are other cells", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    await screen.findByText("app.customers");
    fireEvent.change(picker(), { target: { value: "postgres" } });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await loaded();
    expect(within(grid()).queryAllByRole("gridcell", { selected: true })).toHaveLength(0);
  });

  test("stays open when the snapshot is read again", async () => {
    const { qc } = setup();
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    await screen.findByText("app.customers");
    await act(async () => {
      await qc.invalidateQueries({ queryKey: pgKeys.root(pgTarget) });
    });
    expect(panel()).toHaveAccessibleName("alice · app");
    expect(within(grid()).getAllByRole("gridcell", { selected: true })).toHaveLength(1);
    expect(await screen.findByText("app.customers")).toBeInTheDocument();
  });

  test("closes when the cell is gone after the snapshot was read again: the schema was dropped", async () => {
    const { qc } = setup();
    await loaded();
    fireEvent.click(cellOf("alice", "audit"));
    await screen.findByText("app.customers");
    m.database.mockResolvedValue(viewOf(ROLES, ["app"]));
    await act(async () => {
      await qc.invalidateQueries({ queryKey: pgKeys.database(pgTarget, "orders") });
    });
    await waitFor(() => expect(cellAt("alice", "audit")).not.toBeInTheDocument());
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(cellOf("alice", "app")).toBeInTheDocument();
  });

  test("closes when a filter hides its role, and does not come back when the filter does", async () => {
    const { update } = setup();
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    await screen.findByText("app.customers");
    update({ filter: "bob" });
    expect(within(grid()).queryByRole("rowheader", { name: "alice" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    const reads = m.cell.mock.calls.length;
    update({ filter: "" });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(within(grid()).queryAllByRole("gridcell", { selected: true })).toHaveLength(0);
    expect(m.cell).toHaveBeenCalledTimes(reads); // 저절로 다시 열려 읽지도 않는다
  });

  test("closes when a chip hides its role, and does not come back when the chip does", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    await screen.findByText("app.customers");
    fireEvent.click(screen.getByRole("checkbox", { name: "사용자" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "사용자" }));
    expect(within(grid()).getByRole("rowheader", { name: "alice" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(within(grid()).queryAllByRole("gridcell", { selected: true })).toHaveLength(0);
  });

  test("a schema that was dropped and then comes back in a later read does not bring the detail back", async () => {
    const { qc } = setup();
    await loaded();
    fireEvent.click(cellOf("alice", "audit"));
    await screen.findByText("app.customers");
    m.database.mockResolvedValue(viewOf(ROLES, ["app"]));
    await act(async () => {
      await qc.invalidateQueries({ queryKey: pgKeys.database(pgTarget, "orders") });
    });
    await waitFor(() => expect(cellAt("alice", "audit")).not.toBeInTheDocument());
    m.database.mockResolvedValue(sampleDatabaseView());
    await act(async () => {
      await qc.invalidateQueries({ queryKey: pgKeys.database(pgTarget, "orders") });
    });
    expect(await screen.findByRole("button", { name: (n) => n.startsWith("alice · audit: ") })).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  test("a role that was dropped and then comes back does not bring the detail back", async () => {
    const { update } = setup();
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    await screen.findByText("app.customers");
    update({ overview: sampleOverview({ roles: ROLES.filter((r) => r.name !== "alice") }) });
    update({ overview });
    expect(within(grid()).getByRole("rowheader", { name: "alice" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  test("closes when the cell is gone: the role was dropped", async () => {
    const { update } = setup();
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    await screen.findByText("app.customers");
    update({ overview: sampleOverview({ roles: ROLES.filter((r) => r.name !== "alice") }) });
    expect(within(grid()).queryByRole("rowheader", { name: "alice" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  test("typing in the toolbar filter while it is open does not take the focus from where it is", async () => {
    const { update } = setup();
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    await screen.findByText("app.customers");
    const close = screen.getByRole("button", { name: "닫기" });
    close.focus();
    update({ filter: "al" });
    expect(close).toHaveFocus();
    expect(panel()).toHaveAccessibleName("alice · app");
  });

  test("shows why it failed, in the panel and not in the place of the grid", async () => {
    m.cell.mockRejectedValue({ kind: "other", message: "먼저 연결해 주세요" });
    setup();
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    expect(await within(panel()).findByText("먼저 연결해 주세요")).toBeInTheDocument();
    expect(grid()).toBeInTheDocument();
  });
});

test("under StrictMode, as the app runs, each read is still made once and the detail takes the focus", async () => {
  renderWithClient(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  await loaded();
  fireEvent.click(cellOf("alice", "app"));
  await screen.findByText("app.customers");
  expect(m.database).toHaveBeenCalledTimes(1);
  expect(m.cell).toHaveBeenCalledTimes(1);
  expect(panel()).toHaveFocus();
  fireEvent.keyDown(panel(), { key: "Escape" });
  expect(cellOf("alice", "app")).toHaveFocus();
});

describe("the keyboard", () => {
  const focusCell = (el: HTMLElement) => act(() => el.focus());

  test("the grid is one stop for Tab: the first cell, until the focus moves", async () => {
    setup();
    await loaded();
    const stops = within(grid())
      .getAllByRole("button")
      .filter((b) => b.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveAccessibleName(/^alice · app: /);
  });

  test("the arrows move the focus one cell, and the stop goes with it", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("alice", "app"));
    await user.keyboard("{ArrowRight}");
    expect(cellOf("alice", "audit")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(cellOf("app_owner", "audit")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(cellOf("app_owner", "app")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(cellOf("alice", "app")).toHaveFocus();
    expect(cellOf("alice", "app")).toHaveAttribute("tabindex", "0");
    expect(cellOf("alice", "audit")).toHaveAttribute("tabindex", "-1");
  });

  test("they stop at the edges of the grid: the database column on the left", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("alice", "app"));
    await user.keyboard("{ArrowUp}");
    expect(cellOf("alice", "app")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(dbCell("alice")).toHaveFocus();
    await user.keyboard("{ArrowLeft}{ArrowUp}");
    expect(dbCell("alice")).toHaveFocus();
    focusCell(cellOf("app_write", "audit"));
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(cellOf("app_write", "audit")).toHaveFocus();
  });

  test("the database column is reached with the arrows too, one role after the other, and leads on to the first schema", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("alice", "app"));
    await user.keyboard("{ArrowLeft}");
    expect(dbCell("alice")).toHaveFocus();
    expect(dbCell("alice")).toHaveAccessibleName("alice · 데이터베이스: CONNECT o, CREATE x, TEMP o");
    await user.keyboard("{ArrowDown}");
    expect(dbCell("app_owner")).toHaveFocus();
    expect(dbCell("app_owner")).toHaveAccessibleName("app_owner · 데이터베이스: CONNECT o, CREATE o, TEMP o");
    await user.keyboard("{ArrowDown}");
    expect(dbCell("bob")).toHaveFocus();
    expect(dbCell("bob")).toHaveAccessibleName("bob · 데이터베이스: CONNECT x, CREATE x, TEMP o");
    await user.keyboard("{ArrowRight}");
    expect(cellOf("bob", "app")).toHaveFocus();
  });

  test("the database column goes over the heading of a kind like the schemas do", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(dbCell("postgres"));
    await user.keyboard("{ArrowDown}");
    expect(dbCell("app_read")).toHaveFocus();
  });

  test("the grid is still one stop for Tab when the database column can have the focus, and the stop goes with it", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    const stops = () => [...grid().querySelectorAll('[data-pos][tabindex="0"]')];
    expect(stops()).toHaveLength(1);
    expect(stops()[0]).toBe(cellOf("alice", "app")); // 처음 닿는 곳은 첫 스키마 칸이다
    focusCell(cellOf("alice", "app"));
    await user.keyboard("{ArrowLeft}");
    expect(stops()).toEqual([dbCell("alice")]);
    expect(cellOf("alice", "app")).toHaveAttribute("tabindex", "-1");
    focusCell(dbCell("bob")); // 화살표가 아니라 Tab이나 클릭으로 초점이 와도 탭이 닿는 칸은 그 칸이다
    expect(stops()).toEqual([dbCell("bob")]);
  });

  test("a database cell is read-only: Enter and Space open nothing, and Esc closes an open detail", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(dbCell("alice"));
    await user.keyboard("{Enter}{ }");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(m.cell).not.toHaveBeenCalled();
    expect(dbCell("alice")).toHaveFocus();
    fireEvent.click(cellOf("alice", "app"));
    await screen.findByText("app.customers");
    focusCell(dbCell("bob"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(dbCell("bob")).toHaveFocus();
  });

  test("a database without schemas still has its database column to move in, and Tab reaches it", async () => {
    const user = userEvent.setup();
    m.database.mockResolvedValue(viewOf(ROLES, []));
    setup();
    await loaded();
    expect(dbCell("alice")).toHaveAttribute("tabindex", "0");
    focusCell(dbCell("alice"));
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(dbCell("app_owner")).toHaveFocus();
  });

  test("they go over the heading of a kind", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("postgres", "app")); // 사용자의 마지막 행
    await user.keyboard("{ArrowDown}");
    expect(cellOf("app_read", "app")).toHaveFocus(); // 그룹의 첫 행
    await user.keyboard("{ArrowUp}");
    expect(cellOf("postgres", "app")).toHaveFocus();
  });

  test("Enter opens the detail of the cell, and the focus is in it", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("alice", "app"));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(m.cell).toHaveBeenCalledWith(pgTarget, "orders", "app_owner", "app");
    expect(panel()).toHaveAccessibleName("app_owner · app");
    expect(panel()).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(cellOf("app_owner", "app")).toHaveFocus(); // 초점은 칸으로 돌아온다
    await user.keyboard("{ArrowDown}"); // 거기서 이어서 움직인다
    expect(cellOf("bob", "app")).toHaveFocus();
  });

  test("keys with ⌘, Ctrl or Alt are left to the app", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("alice", "app"));
    await user.keyboard("{Meta>}{ArrowDown}{/Meta}");
    await user.keyboard("{Control>}{ArrowRight}{/Control}");
    expect(cellOf("alice", "app")).toHaveFocus();
  });

  describe("keys that would scroll the grid in a browser", () => {
    const focusCell = (el: HTMLElement) => act(() => el.focus());
    /** fireEvent는 기본 동작이 막히지 않았을 때만 true를 돌려준다 */
    const notPrevented = (el: HTMLElement, init: KeyboardEventInit) => fireEvent.keyDown(el, init);

    test("Space on a database cell is kept from scrolling the grid, with Shift too, and opens nothing", async () => {
      setup();
      await loaded();
      focusCell(dbCell("alice"));
      expect(notPrevented(dbCell("alice"), { key: " " })).toBe(false);
      expect(notPrevented(dbCell("alice"), { key: " ", shiftKey: true })).toBe(false);
      expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
      expect(dbCell("alice")).toHaveFocus();
    });

    test("Space on a schema cell is left to the button, which opens the detail", async () => {
      const user = userEvent.setup();
      setup();
      await loaded();
      focusCell(cellOf("alice", "app"));
      expect(notPrevented(cellOf("alice", "app"), { key: " " })).toBe(true);
      await user.keyboard(" ");
      expect(m.cell).toHaveBeenCalledWith(pgTarget, "orders", "alice", "app");
      expect(await screen.findByRole("complementary", { name: "alice · app" })).toBeInTheDocument();
    });

    test("End goes to the last column of the row and Home to the first one, the database column", async () => {
      const user = userEvent.setup();
      setup();
      await loaded();
      focusCell(cellOf("bob", "app"));
      await user.keyboard("{End}");
      expect(cellOf("bob", "audit")).toHaveFocus();
      await user.keyboard("{Home}");
      expect(dbCell("bob")).toHaveFocus();
      await user.keyboard("{End}");
      expect(cellOf("bob", "audit")).toHaveFocus();
      expect(cellOf("bob", "audit")).toHaveAttribute("tabindex", "0"); // 탭이 닿는 칸도 따라온다
    });

    test("Home and End stay in the row, and do nothing at the ends of it", async () => {
      const user = userEvent.setup();
      setup();
      await loaded();
      focusCell(dbCell("app_owner"));
      await user.keyboard("{Home}");
      expect(dbCell("app_owner")).toHaveFocus();
      focusCell(cellOf("app_owner", "audit"));
      await user.keyboard("{End}");
      expect(cellOf("app_owner", "audit")).toHaveFocus();
    });

    test("Home and End are kept from scrolling the grid, at the ends of the row as well", async () => {
      setup();
      await loaded();
      focusCell(cellOf("bob", "app"));
      expect(notPrevented(cellOf("bob", "app"), { key: "End" })).toBe(false);
      expect(notPrevented(cellOf("bob", "audit"), { key: "End" })).toBe(false);
      expect(notPrevented(cellOf("bob", "audit"), { key: "Home" })).toBe(false);
      expect(notPrevented(dbCell("bob"), { key: "Home" })).toBe(false);
    });

    test("a grid without schemas has its database column for both Home and End", async () => {
      const user = userEvent.setup();
      m.database.mockResolvedValue(viewOf(ROLES, []));
      setup();
      await loaded();
      focusCell(dbCell("alice"));
      await user.keyboard("{End}");
      expect(dbCell("alice")).toHaveFocus();
      await user.keyboard("{Home}");
      expect(dbCell("alice")).toHaveFocus();
    });

    test.each([
      ["Ctrl", "{Control>}", "{/Control}"],
      ["⌘", "{Meta>}", "{/Meta}"],
    ])("%s with Home goes to the first cell of the first row, and with End to the last cell of the last row", async (_name, down, up) => {
      const user = userEvent.setup();
      setup();
      await loaded();
      focusCell(cellOf("bob", "app"));
      await user.keyboard(`${down}{End}${up}`);
      expect(cellOf("app_write", "audit")).toHaveFocus(); // 그룹의 마지막 행, 마지막 스키마
      await user.keyboard(`${down}{Home}${up}`);
      expect(dbCell("alice")).toHaveFocus(); // 사용자의 첫 행, 데이터베이스 열
    });

    test.each([
      ["Ctrl", { ctrlKey: true }],
      ["⌘", { metaKey: true }],
    ])("%s with Home or End is kept from scrolling the grid, in the corners as well", async (_name, modifier) => {
      setup();
      await loaded();
      focusCell(dbCell("alice"));
      expect(notPrevented(dbCell("alice"), { key: "Home", ...modifier })).toBe(false);
      expect(notPrevented(dbCell("alice"), { key: "End", ...modifier })).toBe(false);
      focusCell(cellOf("app_write", "audit"));
      expect(notPrevented(cellOf("app_write", "audit"), { key: "End", ...modifier })).toBe(false);
    });

    test("other keys with ⌘, Ctrl or Alt stay with the app, Home and End with Alt too", async () => {
      setup();
      await loaded();
      focusCell(cellOf("bob", "app"));
      for (const init of [
        { key: "PageDown", ctrlKey: true },
        { key: "PageUp", metaKey: true },
        { key: "ArrowDown", metaKey: true },
        { key: "ArrowRight", ctrlKey: true },
        { key: " ", ctrlKey: true },
        { key: "Home", altKey: true },
        { key: "End", altKey: true },
        { key: "PageDown", altKey: true },
      ]) {
        expect(notPrevented(cellOf("bob", "app"), init)).toBe(true);
      }
      expect(cellOf("bob", "app")).toHaveFocus();
    });

    describe("PageDown and PageUp", () => {
      let viewport: ReturnType<typeof showLines> | null = null;
      afterEach(() => viewport?.mockRestore());

      test("move down and up by the rows that are in view, in the same column", async () => {
        const user = userEvent.setup();
        viewport = showLines(6); // 사용자 머리, alice, app_owner, bob, iam_admin, postgres
        setup();
        await loaded();
        focusCell(cellOf("alice", "audit")); // 줄 1
        await user.keyboard("{PageDown}");
        expect(cellOf("app_read", "audit")).toHaveFocus(); // 줄 7. 줄 1 + 6
        await user.keyboard("{PageUp}");
        expect(cellOf("alice", "audit")).toHaveFocus();
      });

      test("end on the last row and the first row when less than a page is left, and stay there", async () => {
        const user = userEvent.setup();
        viewport = showLines(6);
        setup();
        await loaded();
        focusCell(dbCell("bob")); // 줄 3
        await user.keyboard("{PageDown}"); // 줄 9는 없다: 마지막 줄(8)의 행
        expect(dbCell("app_write")).toHaveFocus();
        await user.keyboard("{PageDown}");
        expect(dbCell("app_write")).toHaveFocus();
        await user.keyboard("{PageUp}"); // 줄 8 - 6 = 줄 2
        expect(dbCell("app_owner")).toHaveFocus();
        await user.keyboard("{PageUp}"); // 줄 2 - 6 < 0: 맨 위의 행
        expect(dbCell("alice")).toHaveFocus();
        await user.keyboard("{PageUp}");
        expect(dbCell("alice")).toHaveFocus();
      });

      test("go over the heading of a kind when the page ends on it", async () => {
        const user = userEvent.setup();
        viewport = showLines(5);
        setup();
        await loaded();
        focusCell(cellOf("alice", "app")); // 줄 1
        await user.keyboard("{PageDown}"); // 줄 6은 그룹 머리라서 그 아래 행으로
        expect(cellOf("app_read", "app")).toHaveFocus();
        focusCell(cellOf("app_write", "app")); // 줄 8
        await user.keyboard("{PageUp}"); // 줄 3
        expect(cellOf("bob", "app")).toHaveFocus();
      });

      test("going up, a page that ends on the heading of a kind goes to the row above it", async () => {
        const user = userEvent.setup();
        viewport = showLines(2);
        setup();
        await loaded();
        focusCell(cellOf("app_write", "audit")); // 줄 8, 둘 위는 줄 6(그룹 머리)
        await user.keyboard("{PageUp}");
        expect(cellOf("postgres", "audit")).toHaveFocus();
      });

      test("move by one row at least, however little is in view", async () => {
        const user = userEvent.setup();
        viewport = showLines(0);
        setup();
        await loaded();
        focusCell(cellOf("alice", "app"));
        await user.keyboard("{PageDown}");
        expect(cellOf("app_owner", "app")).toHaveFocus();
      });

      test("are kept from scrolling the grid, at the ends as well, on database cells and schema cells alike", async () => {
        viewport = showLines(6);
        setup();
        await loaded();
        focusCell(cellOf("alice", "app"));
        expect(notPrevented(cellOf("alice", "app"), { key: "PageUp" })).toBe(false); // 맨 위에서도
        expect(notPrevented(dbCell("alice"), { key: "PageDown" })).toBe(false);
        await userEvent.setup().keyboard("{PageDown}{PageDown}");
        expect(notPrevented(cellOf("app_write", "app"), { key: "PageDown" })).toBe(false); // 맨 아래에서도
      });
    });
  });

  test("a click is where the stop is, also when the browser does not focus the button", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("bob", "audit")); // fireEvent는 초점을 옮기지 않는다
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(cellOf("bob", "audit")).toHaveAttribute("tabindex", "0");
    expect(cellOf("alice", "app")).toHaveAttribute("tabindex", "-1");
  });
});

describe("tall grids", () => {
  const bigOverview = () => sampleOverview({ roles: manyUsers() });
  const bigView = () => viewOf(manyUsers(), ["app", "audit"]);

  beforeEach(() => {
    m.database.mockResolvedValue(bigView());
  });

  test("render only the rows in view", async () => {
    setup({ overview: bigOverview() });
    await loaded();
    const rows = within(grid()).getAllByRole("row");
    expect(rows.length).toBeLessThan(60);
    expect(rows.length).toBeGreaterThan(10);
    expect(within(grid()).getByRole("rowheader", { name: "user-000" })).toBeInTheDocument();
    expect(within(grid()).queryByRole("rowheader", { name: "user-150" })).not.toBeInTheDocument();
    expect(grid()).toHaveAttribute("aria-rowcount", "302"); // 머리 행 + 사용자 머리 + 300명
  });

  test("scrolling moves the window, and the rows that are not drawn keep their height", async () => {
    setup({ overview: bigOverview() });
    await loaded();
    scroller().scrollTop = 150 * ROW_H;
    fireEvent.scroll(scroller());
    expect(within(grid()).getByRole("rowheader", { name: "user-150" })).toBeInTheDocument();
    expect(within(grid()).queryByRole("rowheader", { name: "user-000" })).not.toBeInTheDocument();
    expect(within(grid()).getAllByRole("row").length).toBeLessThan(60);
    const heights = [...grid().querySelectorAll("tbody > tr")].map((tr) => parseInt((tr as HTMLElement).style.height, 10));
    expect(heights.reduce((sum, h) => sum + h, 0)).toBe(301 * ROW_H); // 사용자 머리 1 + 사용자 300
    // 보이는 행은 자기 자리를 안다
    const row = rowOf("user-150");
    expect(row).toHaveAttribute("aria-rowindex", String(150 + 3)); // 머리 행 1 + 사용자 머리 1 + 1부터 세기
  });

  test("the arrow keys keep going past the rows that are drawn", async () => {
    const user = userEvent.setup();
    setup({ overview: bigOverview() });
    await loaded();
    act(() => cellOf("user-000", "app").focus());
    for (let i = 0; i < 40; i++) await user.keyboard("{ArrowDown}");
    expect(cellOf("user-040", "app")).toHaveFocus();
    expect(within(grid()).getAllByRole("row").length).toBeLessThan(60);
  });

  test("the arrow keys keep going past the rows that are drawn in the database column too", async () => {
    const user = userEvent.setup();
    setup({ overview: bigOverview() });
    await loaded();
    act(() => dbCell("user-000").focus());
    for (let i = 0; i < 40; i++) await user.keyboard("{ArrowDown}");
    expect(dbCell("user-040")).toHaveFocus();
    expect(within(grid()).getAllByRole("row").length).toBeLessThan(60);
  });

  test("Tab still reaches the grid when the cell that was the stop has scrolled out", async () => {
    setup({ overview: bigOverview() });
    await loaded();
    act(() => cellOf("user-000", "app").focus());
    scroller().scrollTop = 150 * ROW_H;
    fireEvent.scroll(scroller());
    expect(cellAt("user-000", "app")).not.toBeInTheDocument();
    const stops = within(grid())
      .getAllByRole("button")
      .filter((b) => b.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
  });

  test("Esc brings the focus back to a cell that has scrolled out while its detail was open", async () => {
    setup({ overview: bigOverview() });
    await loaded();
    fireEvent.click(cellOf("user-003", "audit"));
    await screen.findByText("app.customers");
    scroller().scrollTop = 200 * ROW_H;
    fireEvent.scroll(scroller());
    expect(cellAt("user-003", "audit")).not.toBeInTheDocument();
    expect(panel()).toHaveAccessibleName("user-003 · audit"); // 상세는 그대로 열려 있다
    fireEvent.keyDown(panel(), { key: "Escape" });
    expect(cellOf("user-003", "audit")).toHaveFocus();
  });

  test("a filter that leaves few rows while scrolled far down shows them instead of an empty page", async () => {
    const { update } = setup({ overview: bigOverview() });
    await loaded();
    scroller().scrollTop = 200 * ROW_H;
    fireEvent.scroll(scroller());
    update({ filter: "user-00" });
    expect(within(grid()).getByRole("rowheader", { name: "user-005" })).toBeInTheDocument();
  });

  test("roles named like the heading of a kind (head-user, head-group) do not clash with it", async () => {
    const roles = [role("head-user", { attributes: attributes({ login: true }) }), ...manyUsers(120), role("head-group")];
    m.database.mockResolvedValue(viewOf(roles, ["app"]));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      setup({ overview: sampleOverview({ roles }) });
      await loaded();
      expect(rowHeads().slice(0, 3)).toEqual(["사용자 121", "head-user", "user-000"]);
      scroller().scrollTop = 200 * ROW_H;
      fireEvent.scroll(scroller());
      expect(rowHeads().slice(-3)).toEqual(["user-119", "그룹 1", "head-group"]);
      expect(error).not.toHaveBeenCalled(); // 같은 키가 둘이면 React가 알린다
    } finally {
      error.mockRestore();
    }
  });

  describe("paging and the corners", () => {
    let viewport: ReturnType<typeof showLines> | null = null;
    afterEach(() => viewport?.mockRestore());

    test("PageDown and PageUp go by the page that is in view, past the rows that are drawn", async () => {
      const user = userEvent.setup();
      viewport = showLines(10);
      setup({ overview: bigOverview() });
      await loaded();
      act(() => cellOf("user-000", "app").focus()); // 줄 1
      await user.keyboard("{PageDown}");
      expect(cellOf("user-010", "app")).toHaveFocus(); // 줄 11
      for (let i = 0; i < 8; i++) await user.keyboard("{PageDown}");
      expect(cellOf("user-090", "app")).toHaveFocus();
      expect(within(grid()).getAllByRole("row").length).toBeLessThan(60);
      await user.keyboard("{PageUp}{PageUp}");
      expect(cellOf("user-070", "app")).toHaveFocus();
    });

    test("PageDown scrolls the page so that the cell it lands on is in view", async () => {
      const user = userEvent.setup();
      viewport = showLines(10);
      setup({ overview: bigOverview() });
      await loaded();
      act(() => dbCell("user-000").focus());
      for (let i = 0; i < 5; i++) await user.keyboard("{PageDown}");
      expect(dbCell("user-050")).toHaveFocus();
      expect(scroller().scrollTop).toBeGreaterThan(0);
    });

    test("Ctrl+End goes to the last row, which is not drawn, and Ctrl+Home back to the first", async () => {
      const user = userEvent.setup();
      setup({ overview: bigOverview() });
      await loaded();
      act(() => cellOf("user-000", "app").focus());
      await user.keyboard("{Control>}{End}{/Control}");
      expect(cellOf("user-299", "audit")).toHaveFocus();
      expect(within(grid()).getAllByRole("row").length).toBeLessThan(60);
      await user.keyboard("{Control>}{Home}{/Control}");
      expect(dbCell("user-000")).toHaveFocus();
    });

    test("End and Home keep the row, also a row far down", async () => {
      const user = userEvent.setup();
      setup({ overview: bigOverview() });
      await loaded();
      act(() => cellOf("user-000", "app").focus());
      for (let i = 0; i < 70; i++) await user.keyboard("{ArrowDown}");
      await user.keyboard("{End}");
      expect(cellOf("user-070", "audit")).toHaveFocus();
      await user.keyboard("{Home}");
      expect(dbCell("user-070")).toHaveFocus();
    });
  });

  test("the kind headings are in the count of rows too: users and then groups", async () => {
    const roles = [...manyUsers(120), role("grp-a"), role("grp-b")];
    m.database.mockResolvedValue(viewOf(roles, ["app"]));
    setup({ overview: sampleOverview({ roles }) });
    await loaded();
    expect(grid()).toHaveAttribute("aria-rowcount", String(1 + 1 + 120 + 1 + 2));
    scroller().scrollTop = 200 * ROW_H;
    fireEvent.scroll(scroller());
    expect(rowHeads().slice(-4)).toEqual(["user-119", "그룹 2", "grp-a", "grp-b"]);
  });
});

describe("opened from a finding", () => {
  /** PgTab이 하는 일을 하는 작은 부모: 점검이 부탁한 것을 들고 있다가, 표가 쓰고 알리면 비운다 */
  function Opened({ initialPick, onUsed, ...rest }: Props & { initialPick: SchemaFocus | null; onUsed?: () => void }) {
    const [pick, setPick] = useState(initialPick);
    return (
      <Harness
        {...rest}
        pick={pick}
        onPickUsed={() => {
          onUsed?.();
          setPick(null);
        }}
      />
    );
  }
  const open = (pick: SchemaFocus | null, extra: Props & { onUsed?: () => void } = {}) => renderWithClient(<Opened initialPick={pick} {...extra} />);
  const headOf = (schema: string) => columnHeads().find((h) => h.textContent?.startsWith(schema))!;

  test("marks the column of the schema, puts the focus on its first cell, and opens nothing when no role is named", async () => {
    open({ database: "orders", schema: "audit", role: null });
    await loaded();
    expect(headOf("audit")).toHaveAttribute("aria-selected", "true");
    expect(headOf("app")).not.toHaveAttribute("aria-selected");
    expect(cellOf("alice", "audit")).toHaveFocus();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(m.cell).not.toHaveBeenCalled();
  });

  test("opens the cell of the role it names, with the focus in the detail, and the focus goes back to the cell on Esc", async () => {
    open({ database: "orders", schema: "app", role: "bob" });
    await loaded();
    expect(await screen.findByRole("complementary", { name: "bob · app" })).toBeInTheDocument();
    expect(m.cell).toHaveBeenCalledWith(pgTarget, "orders", "bob", "app");
    expect(m.cell).toHaveBeenCalledTimes(1);
    expect(cellOf("bob", "app").closest("td")).toHaveAttribute("aria-selected", "true");
    expect(panel()).toHaveFocus();
    fireEvent.keyDown(panel(), { key: "Escape" });
    expect(cellOf("bob", "app")).toHaveFocus();
  });

  test("a role the rows do not show is not opened; the column is marked and the focus goes to its first cell", async () => {
    open({ database: "orders", schema: "app", role: "rds_superuser" }); // 시스템 역할은 토글을 켜야 보인다
    await loaded();
    expect(headOf("app")).toHaveAttribute("aria-selected", "true");
    expect(cellOf("alice", "app")).toHaveFocus();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(m.cell).not.toHaveBeenCalled();
  });

  test("a schema the database does not have marks nothing, opens nothing and takes no focus", async () => {
    open({ database: "orders", schema: "dropped", role: "bob" });
    await loaded();
    expect(columnHeads().filter((h) => h.getAttribute("aria-selected") === "true")).toHaveLength(0);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(m.cell).not.toHaveBeenCalled();
    expect(document.body).toHaveFocus();
  });

  test("is for the database it names: the grid of another database leaves it alone and does not say it was used", async () => {
    const onUsed = vi.fn();
    open({ database: "analytics", schema: "app", role: "bob" }, { onUsed });
    await loaded();
    expect(columnHeads().filter((h) => h.getAttribute("aria-selected") === "true")).toHaveLength(0);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(onUsed).not.toHaveBeenCalled();
  });

  test("a database without a schema opens the grid as it is, and is used", async () => {
    const onUsed = vi.fn();
    open({ database: "orders", schema: null, role: null }, { onUsed });
    await loaded();
    expect(columnHeads().filter((h) => h.getAttribute("aria-selected") === "true")).toHaveLength(0);
    expect(document.body).toHaveFocus();
    expect(onUsed).toHaveBeenCalledTimes(1);
  });

  test("says once that it was used, and nothing when nothing was asked", async () => {
    const onUsed = vi.fn();
    open({ database: "orders", schema: "audit", role: null }, { onUsed });
    await loaded();
    await act(async () => {});
    expect(onUsed).toHaveBeenCalledTimes(1);
    const none = vi.fn();
    open(null, { onUsed: none });
    await waitFor(() => expect(screen.getAllByRole("grid", { name: "권한 표" })).toHaveLength(2));
    expect(none).not.toHaveBeenCalled();
  });

  test("is used only on the first time: another database and then this one again start from scratch", async () => {
    open({ database: "orders", schema: "audit", role: null });
    await loaded();
    expect(headOf("audit")).toHaveAttribute("aria-selected", "true");
    fireEvent.change(picker(), { target: { value: "analytics" } });
    await loaded();
    fireEvent.change(picker(), { target: { value: "orders" } });
    await loaded();
    expect(columnHeads().filter((h) => h.getAttribute("aria-selected") === "true")).toHaveLength(0);
  });

  test("the mark goes away when a cell is pressed", async () => {
    open({ database: "orders", schema: "audit", role: null });
    await loaded();
    fireEvent.click(cellOf("alice", "app"));
    expect(columnHeads().filter((h) => h.getAttribute("aria-selected") === "true")).toHaveLength(0);
    expect(await screen.findByRole("complementary", { name: "alice · app" })).toBeInTheDocument();
  });

  test("under StrictMode it is used once and the detail still takes the focus", async () => {
    const onUsed = vi.fn();
    renderWithClient(
      <StrictMode>
        <Opened initialPick={{ database: "orders", schema: "app", role: "bob" }} onUsed={onUsed} />
      </StrictMode>,
    );
    await loaded();
    expect(await screen.findByRole("complementary", { name: "bob · app" })).toBeInTheDocument();
    expect(onUsed).toHaveBeenCalledTimes(1);
    expect(m.cell).toHaveBeenCalledTimes(1);
    expect(panel()).toHaveFocus();
  });

  test("a cell far down is brought into view: the grid scrolls to the role it names", async () => {
    m.database.mockResolvedValue(viewOf(manyUsers(), ["app", "audit"]));
    open({ database: "orders", schema: "audit", role: "user-250" }, { overview: sampleOverview({ roles: manyUsers() }) });
    await loaded();
    expect(await screen.findByRole("complementary", { name: "user-250 · audit" })).toBeInTheDocument();
    expect(within(grid()).getByRole("rowheader", { name: "user-250" })).toBeInTheDocument();
    expect(within(grid()).getAllByRole("row").length).toBeLessThan(60);
  });
});
