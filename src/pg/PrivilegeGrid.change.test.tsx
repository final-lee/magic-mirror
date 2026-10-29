import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import { attributes, dbAspects, pgTarget, role, sampleCellDetail, sampleDatabaseView, sampleOverview, schemaAspects } from "./fixtures";
import { PrivilegeGrid, ROW_H } from "./PrivilegeGrid";
import { pgKeys } from "./queries";
import { DEFAULT_KINDS, type RoleKindsValue } from "./RoleKinds";
import type { PgChange, PgDatabaseView, PgDbPrivilegeRow, PgGrantTarget, PgRoleSummary, PgSchemaCell } from "./types";
import { usePgDraft, type PgDraft } from "./usePgDraft";

vi.mock("./api", () => ({ pgApi: { database: vi.fn(), cell: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(pgApi);
const overview = sampleOverview();

type Props = Partial<React.ComponentProps<typeof PrivilegeGrid>> & { initialKinds?: RoleKindsValue };

/** 탭이 들고 있는 것(장바구니, 칩, 고른 데이터베이스)을 작은 부모가 대신 든다. 장바구니는 시험이 읽을 수 있게 밖으로 내보낸다. */
let draft!: PgDraft;
function Harness({ initialKinds = DEFAULT_KINDS, database: initialDatabase, overview: ov = overview, editing = true, ...rest }: Props) {
  const own = usePgDraft(pgTarget, ov);
  draft = own;
  const [kinds, setKinds] = useState(initialKinds);
  const [database, setDatabase] = useState(initialDatabase);
  return (
    <PrivilegeGrid
      target={pgTarget}
      overview={ov}
      database={database}
      onDatabase={setDatabase}
      filter=""
      kinds={kinds}
      onKinds={setKinds}
      editing={editing}
      draft={own}
      {...rest}
    />
  );
}

function setup(props: Props = {}) {
  const utils = renderWithClient(<Harness {...props} />);
  /** 같은 부모를 다른 props로 다시 그린다(바꾸기 모드를 켜고 끄는 일) */
  const update = (next: Props) =>
    utils.rerender(
      <QueryClientProvider client={utils.qc as QueryClient}>
        <Harness {...props} {...next} />
      </QueryClientProvider>,
    );
  return { update, ...utils };
}

const grid = () => screen.getByRole("grid", { name: "권한 표" });
const scroller = () => grid().closest(".pg-scroll") as HTMLElement;
const cellOf = (roleName: string, schema: string) => within(grid()).getByRole("button", { name: (n) => n.startsWith(`${roleName} · ${schema}: `) });
const rowOf = (roleName: string) => within(grid()).getByRole("rowheader", { name: roleName }).closest("tr") as HTMLElement;
const dbCell = (roleName: string) => within(rowOf(roleName)).getByRole("gridcell", { name: (n) => n.startsWith(`${roleName} · 데이터베이스: `) });
const loaded = () => screen.findByRole("grid", { name: "권한 표" });
const brush = (label: string) => fireEvent.click(screen.getByRole("radio", { name: label }));
const focusCell = (el: HTMLElement) => act(() => el.focus());
const press = (el: HTMLElement) => fireEvent.pointerDown(el, { button: 0, buttons: 1 });
const over = (el: HTMLElement) => fireEvent.pointerEnter(el, { buttons: 1 });
const selected = () => within(grid()).queryAllByRole("gridcell", { selected: true });

/** 장바구니에 담긴 변경들 */
const changes = (): PgChange[] => draft.items.map((d) => d.change);
const grant = (grantee: string, target: PgGrantTarget, privileges: string[], add: boolean, database = "orders"): PgChange => ({
  kind: "grant",
  database,
  grantee,
  add,
  items: [{ target, privileges }],
});
const reading = (grantee: string, schema: string, add: boolean, database?: string) => grant(grantee, { kind: "allTables", schema }, ["SELECT"], add, database);
const onDatabase = (name: string, privilege: string, grantee: string, add: boolean) => grant(grantee, { kind: "database", name: "orders" }, [privilege], add);
/** 담긴 변경의 받는 역할들 */
const grantees = () => changes().map((c) => (c.kind === "grant" ? c.grantee : null));

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
function viewOf(roles: PgRoleSummary[], schemas: string[], extra: Partial<PgDatabaseView> = {}): PgDatabaseView {
  return sampleDatabaseView({
    dbPrivileges: roles.map((r) => dbRow(r.name)),
    schemas: schemas.map((name) => ({ name, owner: "app_owner", tableCount: 1 })),
    cells: roles.flatMap((r) => schemas.map((s) => emptyCell(r.name, s))),
    ...extra,
  });
}
const manyUsers = (n: number) => Array.from({ length: n }, (_, i) => role(`user-${String(i).padStart(3, "0")}`, { attributes: attributes({ login: true }) }));

beforeEach(() => {
  vi.clearAllMocks();
  m.database.mockImplementation(async (_t, database) => sampleDatabaseView({ database }));
  m.cell.mockImplementation(async (_t, _d, roleName, schema) => sampleCellDetail({ role: roleName, schema }));
});

// 시나리오(픽스처): 행은 사용자 alice, app_owner, bob, iam_admin, postgres 다음에 그룹 app_read, app_write. 스키마는 app과 audit.
// 읽기: app_read/app은 직접 받아서 켜져 있고, bob/app은 일부 테이블만 직접 받았고, app_owner는 소유자이고, alice·iam_admin·app_write의 app 칸은
// 그룹이나 미리 정의된 역할에서만 받는다. 나머지는 아무도 주지 않는다.
// CONNECT: app_read가 직접 받았고, app_owner는 소유자이고, bob은 없고, 나머지는 그룹이나 PUBLIC에서 받는다. CREATE는 소유자만 가진다. TEMP는 PUBLIC이 모두에게 준다.

describe("the brush group", () => {
  test("is there in 바꾸기 mode only, with the four brushes of the schema columns and the three of the database column", async () => {
    const { update } = setup({ editing: false });
    await loaded();
    expect(screen.queryByRole("group", { name: "칠할 권한" })).not.toBeInTheDocument();
    update({ editing: true });
    const group = screen.getByRole("group", { name: "칠할 권한" });
    expect(within(group).getAllByRole("radio").map((r) => r.closest("label")?.textContent?.trim())).toEqual(["사용", "만들기", "읽기", "쓰기", "CONNECT", "CREATE", "TEMP"]);
  });

  test("has exactly one brush active, 읽기 at first, and choosing another makes that the only one", async () => {
    setup();
    await loaded();
    const active = () =>
      screen
        .getAllByRole("radio")
        .filter((r) => (r as HTMLInputElement).checked)
        .map((r) => r.closest("label")?.textContent?.trim());
    expect(active()).toEqual(["읽기"]);
    brush("쓰기");
    expect(active()).toEqual(["쓰기"]);
    brush("TEMP");
    expect(active()).toEqual(["TEMP"]);
  });

  test("sits beside the database picker and the chips of the screen, which are still there", async () => {
    setup();
    await loaded();
    expect(screen.getByRole("group", { name: "종류" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "데이터베이스" })).toBeInTheDocument();
  });

  test("keeps the brush that was chosen when another database is chosen", async () => {
    setup();
    await loaded();
    brush("쓰기");
    fireEvent.change(screen.getByRole("combobox", { name: "데이터베이스" }), { target: { value: "postgres" } });
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "postgres", false));
    await loaded();
    expect(screen.getByRole("radio", { name: "쓰기" })).toBeChecked();
  });

  test("is there while the database is being read, so the brush can be chosen first", async () => {
    m.database.mockReturnValue(new Promise(() => {}));
    setup();
    expect(screen.getByRole("radio", { name: "읽기" })).toBeChecked();
  });
});

describe("a schema cell", () => {
  test("shows the one aspect of the brush, with one mark, and names it", async () => {
    setup();
    await loaded();
    const cell = cellOf("app_read", "app");
    expect(cell).toHaveAccessibleName("app_read · app: 읽기 직접 받음");
    expect(cell.querySelectorAll(".pg-mark")).toHaveLength(1);
    expect(cell).toHaveTextContent("●");
  });

  test.each([
    ["on: the role itself was given all of it", "app_read", "app", "읽기 직접 받음", "●", undefined, false],
    ["partial: only some tables were given directly", "bob", "app", "읽기 일부 테이블", "◐", undefined, false],
    ["off: nobody gives it", "alice", "audit", "읽기 없음", "○", undefined, false],
    ["held as the owner", "app_owner", "app", "읽기 소유자", "●", "소유자라서 가진 권한이에요", true],
    ["inherited only: it comes from a group or PUBLIC", "alice", "app", "읽기 그룹·PUBLIC으로만 받음", "●", "그룹·PUBLIC으로만 받음", true],
  ])("%s", async (_state, roleName, schema, name, glyph, title, cannotToggle) => {
    setup();
    await loaded();
    const cell = cellOf(roleName, schema);
    expect(cell).toHaveAccessibleName(`${roleName} · ${schema}: ${name}`);
    expect(cell).toHaveTextContent(glyph);
    if (title) expect(cell).toHaveAttribute("title", title);
    else expect(cell).not.toHaveAttribute("title");
    if (cannotToggle) {
      expect(cell).toHaveAttribute("aria-disabled", "true");
      expect(cell).toHaveClass("pg-dimmed");
    } else {
      expect(cell).not.toHaveAttribute("aria-disabled");
      expect(cell).not.toHaveClass("pg-dimmed");
    }
  });

  test("shows the same cell differently for each brush", async () => {
    setup();
    await loaded();
    // app_write/app: reads through app_read, writes to some tables directly, uses the schema through app_read
    const names: Record<string, string | null> = {};
    for (const label of ["읽기", "쓰기", "사용", "만들기"]) {
      brush(label);
      names[label] = cellOf("app_write", "app").getAttribute("aria-label");
    }
    expect(names).toEqual({
      읽기: "app_write · app: 읽기 그룹·PUBLIC으로만 받음",
      쓰기: "app_write · app: 쓰기 일부 테이블",
      사용: "app_write · app: 사용 그룹·PUBLIC으로만 받음",
      만들기: "app_write · app: 만들기 없음",
    });
  });

  test("a system role's cell shows what it holds, cannot be toggled, and says why", async () => {
    setup({ initialKinds: { users: true, groups: true, system: true } });
    await loaded();
    const cell = cellOf("pg_read_all_data", "app");
    expect(cell).toHaveAttribute("title", "시스템 역할이라 바꿀 수 없어요: pg_read_all_data");
    expect(cell).toHaveAttribute("aria-disabled", "true");
    expect(cell).toHaveTextContent("●");
    fireEvent.click(cell);
    fireEvent.click(cellOf("rds_iam", "app")); // nothing is given to it, but it is a system role all the same
    expect(changes()).toEqual([]);
  });

  test("is drawn with the four marks again once 바꾸기 mode is off, and clicking it opens the detail", async () => {
    const { update } = setup();
    await loaded();
    update({ editing: false });
    const cell = cellOf("alice", "app");
    expect(cell.querySelectorAll(".pg-mark")).toHaveLength(4);
    expect(cell).toHaveAccessibleName("alice · app: 사용 o, 만들기 x, 읽기 모든 테이블, 쓰기 일부 테이블");
    fireEvent.click(cell);
    expect(await screen.findByRole("complementary", { name: "alice · app" })).toBeInTheDocument();
    expect(changes()).toEqual([]);
  });

  test("the changes in the tray are drawn again when the mode is turned back on", async () => {
    const { update } = setup();
    await loaded();
    fireEvent.click(cellOf("alice", "audit"));
    update({ editing: false });
    expect(changes()).toHaveLength(1); // the tray keeps them
    update({ editing: true });
    expect(cellOf("alice", "audit")).toHaveAccessibleName("alice · audit: 읽기 줄 예정");
  });

  test("a screen that is given no draft stays a plain table", async () => {
    setup({ draft: undefined, editing: true });
    await loaded();
    expect(screen.queryByRole("group", { name: "칠할 권한" })).not.toBeInTheDocument();
    expect(cellOf("alice", "app").querySelectorAll(".pg-mark")).toHaveLength(4);
  });
});

describe("the database column", () => {
  test("is read-only while a brush of the schema columns is active: the three marks, dimmed", async () => {
    setup();
    await loaded();
    const cell = dbCell("app_read");
    expect(cell).toHaveAccessibleName("app_read · 데이터베이스: CONNECT o, CREATE x, TEMP o");
    expect(cell.querySelectorAll(".pg-mark")).toHaveLength(3);
    expect(cell).toHaveClass("pg-idle");
    fireEvent.click(cell);
    expect(changes()).toEqual([]);
  });

  test.each([
    ["CONNECT", "app_read", "CONNECT 직접 받음", "●", undefined],
    ["CONNECT", "bob", "CONNECT 없음", "○", undefined],
    ["CONNECT", "alice", "CONNECT 그룹·PUBLIC으로만 받음", "●", "그룹·PUBLIC으로만 받음"],
    ["CONNECT", "app_owner", "CONNECT 소유자", "●", "소유자라서 가진 권한이에요"],
    ["CREATE", "bob", "CREATE 없음", "○", undefined],
    ["CREATE", "app_owner", "CREATE 소유자", "●", "소유자라서 가진 권한이에요"],
    ["TEMP", "bob", "TEMP 그룹·PUBLIC으로만 받음", "●", "그룹·PUBLIC으로만 받음"],
  ])("with %s a database cell shows only that: %s is %s", async (label, roleName, name, glyph, title) => {
    setup();
    await loaded();
    brush(label);
    const cell = dbCell(roleName);
    expect(cell).toHaveAccessibleName(`${roleName} · 데이터베이스: ${name}`);
    expect(cell.querySelectorAll(".pg-mark")).toHaveLength(1);
    expect(cell).toHaveTextContent(glyph);
    expect(cell).not.toHaveClass("pg-idle");
    if (title) expect(cell).toHaveAttribute("title", title);
    else expect(cell).not.toHaveAttribute("title");
  });

  test("a click toggles it with the privilege of the brush, on the database that is showing", async () => {
    setup();
    await loaded();
    brush("CONNECT");
    fireEvent.click(dbCell("bob"));
    expect(changes()).toEqual([onDatabase("orders", "CONNECT", "bob", true)]);
    expect(dbCell("bob")).toHaveAccessibleName("bob · 데이터베이스: CONNECT 줄 예정");
    expect(dbCell("bob")).toHaveTextContent("＋");
    fireEvent.click(dbCell("app_read")); // given directly: take it away
    expect(changes()[1]).toEqual(onDatabase("orders", "CONNECT", "app_read", false));
    expect(dbCell("app_read")).toHaveTextContent("－");
    fireEvent.click(dbCell("bob"));
    expect(changes()).toEqual([onDatabase("orders", "CONNECT", "app_read", false)]);
  });

  test("CREATE gives CREATE", async () => {
    setup();
    await loaded();
    brush("CREATE");
    fireEvent.click(dbCell("postgres"));
    expect(changes()).toEqual([onDatabase("orders", "CREATE", "postgres", true)]);
  });

  test("TEMP gives TEMPORARY, to a role that PUBLIC does not give it to", async () => {
    const view = sampleDatabaseView();
    m.database.mockResolvedValue({ ...view, dbPrivileges: view.dbPrivileges.map((p) => (p.role === "postgres" ? { ...p, temp: false } : p)) });
    setup();
    await loaded();
    brush("TEMP");
    fireEvent.click(dbCell("postgres"));
    expect(changes()).toEqual([onDatabase("orders", "TEMPORARY", "postgres", true)]);
  });

  test("a cell held as the owner, one that is inherited only and one of a system role are not toggled", async () => {
    setup({ initialKinds: { users: true, groups: true, system: true } });
    await loaded();
    brush("CONNECT");
    for (const roleName of ["app_owner", "alice", "rds_superuser"]) fireEvent.click(dbCell(roleName));
    expect(changes()).toEqual([]);
    expect(dbCell("rds_superuser")).toHaveAttribute("title", "시스템 역할이라 바꿀 수 없어요: rds_superuser");
  });

  test("a schema cell is left alone while a database brush is active: four marks, dimmed, and a click does nothing", async () => {
    setup();
    await loaded();
    brush("CONNECT");
    const cell = cellOf("bob", "audit");
    expect(cell.querySelectorAll(".pg-mark")).toHaveLength(4);
    expect(cell).toHaveClass("pg-idle");
    fireEvent.click(cell);
    expect(changes()).toEqual([]);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  test("Space toggles a database cell, Enter does nothing, and neither scrolls the grid", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    brush("CREATE");
    focusCell(dbCell("bob"));
    expect(fireEvent.keyDown(dbCell("bob"), { key: " " })).toBe(false); // the default (scrolling) was prevented
    expect(changes()).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(changes()).toHaveLength(1);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await user.keyboard(" ");
    expect(changes()).toEqual([]);
  });
});

describe("clicking a schema cell", () => {
  test("puts the change that gives the privilege in the tray, and marks the cell ＋", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("alice", "audit"));
    expect(changes()).toEqual([reading("alice", "audit", true)]);
    expect(cellOf("alice", "audit")).toHaveAccessibleName("alice · audit: 읽기 줄 예정");
    expect(cellOf("alice", "audit")).toHaveTextContent("＋");
  });

  test("on a cell that is on it is the change that takes the privilege away, marked －", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("app_read", "app"));
    expect(changes()).toEqual([reading("app_read", "app", false)]);
    expect(cellOf("app_read", "app")).toHaveAccessibleName("app_read · app: 읽기 뺄 예정");
    expect(cellOf("app_read", "app")).toHaveTextContent("－");
  });

  test("a second click takes the change back", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("alice", "audit"));
    fireEvent.click(cellOf("alice", "audit"));
    expect(changes()).toEqual([]);
    expect(cellOf("alice", "audit")).toHaveAccessibleName("alice · audit: 읽기 없음");
    fireEvent.click(cellOf("app_read", "app"));
    fireEvent.click(cellOf("app_read", "app"));
    expect(changes()).toEqual([]);
    expect(cellOf("app_read", "app")).toHaveAccessibleName("app_read · app: 읽기 직접 받음");
  });

  test("a partial cell gets everything: the privilege on all the tables is given", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("bob", "app"));
    expect(changes()).toEqual([reading("bob", "app", true)]);
  });

  test("a real click (pointer down, up, click) toggles exactly once", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    await user.click(cellOf("alice", "audit"));
    expect(changes()).toEqual([reading("alice", "audit", true)]);
  });

  test("a cell held as the owner and a cell that is inherited only queue nothing, and open no detail", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("app_owner", "app"));
    fireEvent.click(cellOf("alice", "app"));
    fireEvent.click(cellOf("iam_admin", "app"));
    expect(changes()).toEqual([]);
    expect(m.cell).not.toHaveBeenCalled();
  });

  test("a click opens no detail on a cell that can be toggled either", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("alice", "audit"));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(m.cell).not.toHaveBeenCalled();
  });

  test.each([
    ["사용", { kind: "schema", name: "audit" }, ["USAGE"]],
    ["만들기", { kind: "schema", name: "audit" }, ["CREATE"]],
    ["읽기", { kind: "allTables", schema: "audit" }, ["SELECT"]],
    ["쓰기", { kind: "allTables", schema: "audit" }, ["INSERT", "UPDATE", "DELETE"]],
  ] as [string, PgGrantTarget, string[]][])("the brush %s puts the change on %j in the tray", async (label, target, privileges) => {
    setup();
    await loaded();
    brush(label);
    fireEvent.click(cellOf("alice", "audit"));
    expect(changes()).toEqual([grant("alice", target, privileges, true)]);
  });

  test("the change is for the database that is showing", async () => {
    setup({ database: "analytics" });
    await loaded();
    fireEvent.click(cellOf("alice", "audit"));
    expect(changes()).toEqual([reading("alice", "audit", true, "analytics")]);
  });

  test("a change for another database than the one in the tray is refused, with the notice", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("alice", "audit"));
    fireEvent.change(screen.getByRole("combobox", { name: "데이터베이스" }), { target: { value: "analytics" } });
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", false));
    await loaded();
    fireEvent.click(cellOf("alice", "audit"));
    expect(changes()).toEqual([reading("alice", "audit", true)]);
    expect(draft.notices).toEqual(["다른 데이터베이스의 변경이 담겨 있어요. 먼저 적용하거나 비워 주세요"]);
    expect(cellOf("alice", "audit")).toHaveAccessibleName("alice · audit: 읽기 없음");
  });

  test("changes of different brushes on one cell are different changes", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("alice", "audit"));
    brush("쓰기");
    fireEvent.click(cellOf("alice", "audit"));
    expect(changes().map((c) => (c.kind === "grant" ? c.items[0].privileges : null))).toEqual([["SELECT"], ["INSERT", "UPDATE", "DELETE"]]);
    brush("읽기");
    expect(cellOf("alice", "audit")).toHaveAccessibleName("alice · audit: 읽기 줄 예정");
  });

  test("a change waiting on a cell that cannot be toggled any more is still shown, and a click takes it back", async () => {
    const { qc } = setup();
    await loaded();
    fireEvent.click(cellOf("alice", "audit"));
    // the database is read again, and now a group gives alice the read
    const view = sampleDatabaseView();
    m.database.mockResolvedValue({
      ...view,
      cells: view.cells.map((c) => (c.role === "alice" && c.schema === "audit" ? { ...c, read: "all" as const, inheritedOnly: true } : c)),
    });
    await act(async () => {
      await qc.invalidateQueries({ queryKey: pgKeys.database(pgTarget, "orders") });
    });
    const cell = cellOf("alice", "audit");
    expect(cell).toHaveAccessibleName("alice · audit: 읽기 줄 예정");
    fireEvent.click(cell);
    expect(changes()).toEqual([]);
    expect(cellOf("alice", "audit")).toHaveAccessibleName("alice · audit: 읽기 그룹·PUBLIC으로만 받음");
  });
});

describe("dragging over schema cells", () => {
  test("paints every cell it passes with what the first cell became, and skips the ones that cannot be toggled", async () => {
    setup();
    await loaded();
    press(cellOf("alice", "audit")); // off: the target is to give it
    expect(cellOf("alice", "audit")).toHaveAccessibleName("alice · audit: 읽기 줄 예정"); // the first cell changes at once
    over(cellOf("bob", "audit")); // app_owner, between them, is held as the owner
    over(cellOf("postgres", "audit")); // iam_admin, between them, is inherited only
    fireEvent.pointerUp(window);
    expect(changes()).toEqual([reading("alice", "audit", true), reading("bob", "audit", true), reading("postgres", "audit", true)]);
  });

  test("a drag that starts on a cell that is on takes the privilege away, and the cells that do not have it are left alone", async () => {
    setup();
    await loaded();
    press(cellOf("app_read", "app"));
    over(cellOf("postgres", "app")); // off: already as wanted
    fireEvent.pointerUp(window);
    expect(changes()).toEqual([reading("app_read", "app", false)]);
  });

  test("a cell that has a change toward the target is left alone, and one that has the opposite one loses it", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("bob", "app")); // give (it has some)
    fireEvent.click(cellOf("postgres", "app")); // give
    // from a cell that is on, the target is to take away: the gives on the way are cancelled
    press(cellOf("app_read", "app"));
    over(cellOf("bob", "app"));
    over(cellOf("postgres", "app"));
    fireEvent.pointerUp(window);
    expect(changes()).toEqual([reading("app_read", "app", false)]);
    expect(cellOf("bob", "app")).toHaveAccessibleName("bob · app: 읽기 일부 테이블");
  });

  test("a fast drag that jumps over rows paints the ones in between", async () => {
    setup();
    await loaded();
    brush("만들기");
    press(cellOf("postgres", "audit"));
    over(cellOf("app_write", "audit")); // app_read, between them, was never entered
    fireEvent.pointerUp(window);
    expect(grantees()).toEqual(["postgres", "app_read", "app_write"]);
  });

  test("a drag along a row paints the schemas in between", async () => {
    m.database.mockResolvedValue(viewOf(overview.roles, ["a", "b", "c", "d"], { database: "analytics" }));
    setup({ database: "analytics" });
    await loaded();
    press(cellOf("alice", "a"));
    over(cellOf("alice", "d")); // b and c were never entered
    fireEvent.pointerUp(window);
    expect(changes().map((c) => (c.kind === "grant" && c.items[0].target.kind === "allTables" ? c.items[0].target.schema : null))).toEqual(["a", "b", "c", "d"]);
  });

  test("a press on a cell that cannot be toggled starts no paint", async () => {
    setup();
    await loaded();
    press(cellOf("alice", "app")); // inherited only
    over(cellOf("bob", "app"));
    over(cellOf("postgres", "app"));
    fireEvent.pointerUp(window);
    expect(changes()).toEqual([]);
  });

  test("stops when the button is let go", async () => {
    setup();
    await loaded();
    press(cellOf("alice", "audit"));
    fireEvent.pointerUp(window);
    over(cellOf("bob", "audit"));
    expect(changes()).toEqual([reading("alice", "audit", true)]);
  });

  test("a drag that ends on another cell leaves no click behind: the first cell still answers a later click", async () => {
    setup();
    await loaded();
    press(cellOf("alice", "audit"));
    over(cellOf("bob", "audit"));
    fireEvent.pointerUp(cellOf("bob", "audit"));
    expect(changes()).toHaveLength(2);
    fireEvent.click(cellOf("alice", "audit"));
    expect(changes()).toEqual([reading("bob", "audit", true)]);
  });

  test("a click that follows a press on the same cell is not a second toggle", async () => {
    setup();
    await loaded();
    press(cellOf("alice", "audit"));
    fireEvent.pointerUp(cellOf("alice", "audit"));
    fireEvent.click(cellOf("alice", "audit"));
    expect(changes()).toEqual([reading("alice", "audit", true)]);
  });

  test("a mouse that comes in with no button held ends the paint", async () => {
    // jsdom의 PointerEvent 대용품에는 pointerType이 없어서, 이 시험에서만 마우스인 것처럼 꾸민다
    Object.defineProperty(window.PointerEvent.prototype, "pointerType", { value: "mouse", configurable: true });
    try {
      setup();
      await loaded();
      press(cellOf("alice", "audit"));
      fireEvent.pointerEnter(cellOf("bob", "audit"), { buttons: 0 }); // the button was let go outside the window
      fireEvent.pointerEnter(cellOf("postgres", "audit"), { buttons: 1 }); // it is over: this paints nothing
      expect(changes()).toEqual([reading("alice", "audit", true)]);
      fireEvent.pointerUp(window);
    } finally {
      delete (window.PointerEvent.prototype as { pointerType?: string }).pointerType;
    }
  });

  test("only the primary button paints", async () => {
    setup();
    await loaded();
    fireEvent.pointerDown(cellOf("alice", "audit"), { button: 2, buttons: 2 });
    over(cellOf("bob", "audit"));
    expect(changes()).toEqual([]);
  });

  test("rows that are not drawn are painted too", async () => {
    const roles = manyUsers(120);
    m.database.mockResolvedValue(viewOf(roles, ["app"]));
    setup({ overview: sampleOverview({ roles }) });
    await loaded();
    press(cellOf("user-000", "app"));
    scroller().scrollTop = 30 * ROW_H;
    fireEvent.scroll(scroller());
    expect(within(grid()).queryByRole("rowheader", { name: "user-010" })).not.toBeInTheDocument(); // not drawn any more
    over(cellOf("user-040", "app"));
    fireEvent.pointerUp(window);
    expect(changes()).toHaveLength(41);
    expect(changes()[10]).toEqual(reading("user-010", "app", true));
    scroller().scrollTop = 0;
    fireEvent.scroll(scroller());
    expect(cellOf("user-010", "app")).toHaveAccessibleName("user-010 · app: 읽기 줄 예정"); // a row that was never drawn while it was painted
  });

  test("stops at 50 changes and says so once", async () => {
    const roles = manyUsers(60);
    m.database.mockResolvedValue(viewOf(roles, ["app"]));
    setup({ overview: sampleOverview({ roles }) });
    await loaded();
    press(cellOf("user-000", "app"));
    scroller().scrollTop = 50 * ROW_H;
    fireEvent.scroll(scroller());
    over(cellOf("user-055", "app"));
    fireEvent.pointerUp(window);
    expect(changes()).toHaveLength(50);
    expect(draft.notices).toEqual(["한 번에 50개까지 담을 수 있어요"]);
  });
});

describe("dragging down the database column", () => {
  test("paints the cells it passes, including those it jumped over, and not the schema cells", async () => {
    setup();
    await loaded();
    brush("CREATE");
    press(dbCell("alice"));
    over(dbCell("postgres")); // bob and iam_admin were never entered; app_owner has CREATE as the owner
    over(cellOf("postgres", "app")); // a schema cell is not painted by a database brush
    fireEvent.pointerUp(window);
    expect(grantees()).toEqual(["alice", "bob", "iam_admin", "postgres"]);
    expect(changes().every((c) => c.kind === "grant" && c.items[0].target.kind === "database")).toBe(true);
  });

  test("a drag that begins on a schema cell does not paint the database column with a schema brush", async () => {
    setup();
    await loaded();
    press(cellOf("alice", "audit"));
    over(dbCell("alice"));
    fireEvent.pointerUp(window);
    expect(changes()).toEqual([reading("alice", "audit", true)]);
  });

  test("a real click on a database cell toggles exactly once", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    brush("CREATE");
    await user.click(dbCell("bob"));
    expect(changes()).toEqual([onDatabase("orders", "CREATE", "bob", true)]);
  });
});

describe("the keyboard", () => {
  test("Space toggles the focused cell, and again takes the change back", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("alice", "audit"));
    await user.keyboard(" ");
    expect(changes()).toEqual([reading("alice", "audit", true)]);
    await user.keyboard(" ");
    expect(changes()).toEqual([]);
  });

  test("Space on a cell that cannot be toggled does nothing, and is kept from scrolling the grid", async () => {
    setup();
    await loaded();
    focusCell(cellOf("alice", "app"));
    expect(fireEvent.keyDown(cellOf("alice", "app"), { key: " " })).toBe(false);
    focusCell(cellOf("app_owner", "app"));
    expect(fireEvent.keyDown(cellOf("app_owner", "app"), { key: " " })).toBe(false);
    expect(changes()).toEqual([]);
  });

  test("Enter opens the detail of the cell, with the focus in it, and toggles nothing", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("alice", "audit"));
    await user.keyboard("{Enter}");
    expect(m.cell).toHaveBeenCalledWith(pgTarget, "orders", "alice", "audit");
    expect(await screen.findByRole("complementary", { name: "alice · audit" })).toHaveFocus();
    expect(changes()).toEqual([]);
  });

  test("Enter opens the detail of a cell that cannot be toggled too", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("app_owner", "app"));
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("complementary", { name: "app_owner · app" })).toBeInTheDocument();
  });

  test("the arrows and End move the focus as they do in 읽기 mode", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("alice", "app"));
    await user.keyboard("{ArrowRight}{ArrowDown}{ArrowLeft}{ArrowLeft}");
    expect(dbCell("app_owner")).toHaveFocus();
    await user.keyboard("{End}");
    expect(cellOf("app_owner", "audit")).toHaveFocus();
  });

  test("Shift+arrows widen a range and Space paints it with what the first cell would become", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("bob", "audit"));
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(cellOf("postgres", "audit")).toHaveFocus();
    expect(selected()).toHaveLength(3); // bob, iam_admin and postgres
    await user.keyboard(" "); // bob is off, so the target is to give it. iam_admin's cell is inherited only and is left out
    expect(changes()).toEqual([reading("bob", "audit", true), reading("postgres", "audit", true)]);
    expect(selected()).toHaveLength(3); // the range stays after it is painted
    await user.keyboard(" "); // the first cell is shown as given now, so the target is to take it back
    expect(changes()).toEqual([]);
  });

  test("a range reaches over the schemas as well as the rows", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("postgres", "app"));
    await user.keyboard("{Shift>}{ArrowRight}{/Shift} ");
    expect(changes()).toEqual([reading("postgres", "app", true), reading("postgres", "audit", true)]);
  });

  test("a range that starts on a cell that cannot be toggled does nothing", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("alice", "app")); // inherited only
    await user.keyboard("{Shift>}{ArrowDown}{/Shift} ");
    expect(changes()).toEqual([]);
  });

  test("a range over the database column and a schema column paints only the cells the brush is for", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    brush("CREATE");
    focusCell(dbCell("bob"));
    await user.keyboard("{Shift>}{ArrowRight}{ArrowDown}{/Shift} ");
    expect(selected()).toHaveLength(4); // the database cells and the app cells of bob and iam_admin
    expect(changes()).toEqual([onDatabase("orders", "CREATE", "bob", true), onDatabase("orders", "CREATE", "iam_admin", true)]);
  });

  test("Escape clears the range, and so does a plain arrow", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("postgres", "audit"));
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(selected()).toHaveLength(2);
    await user.keyboard("{Escape}");
    expect(selected()).toHaveLength(0);
    expect(cellOf("app_read", "audit")).toHaveFocus();
    await user.keyboard(" "); // now Space is for the one cell with the focus
    expect(changes()).toEqual([reading("app_read", "audit", true)]);

    await user.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(selected()).toHaveLength(2);
    await user.keyboard("{ArrowDown}");
    expect(selected()).toHaveLength(0);
    expect(cellOf("app_read", "audit")).toHaveFocus();
  });

  test("Escape with a range and a detail open clears the range first, and the next one closes the detail", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("alice", "audit"));
    await user.keyboard("{Enter}");
    await screen.findByRole("complementary", { name: "alice · audit" });
    focusCell(cellOf("bob", "audit"));
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(selected()).toHaveLength(3); // the cell of the detail, and the two of the range
    await user.keyboard("{Escape}");
    expect(screen.getByRole("complementary", { name: "alice · audit" })).toBeInTheDocument();
    expect(selected()).toHaveLength(1); // only the cell of the detail
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  test("pressing a cell with the pointer clears the range", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("bob", "audit"));
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(selected()).toHaveLength(2);
    await user.click(cellOf("alice", "audit"));
    expect(selected()).toHaveLength(0);
  });

  test("turning 바꾸기 mode off drops the range", async () => {
    const user = userEvent.setup();
    const { update } = setup();
    await loaded();
    focusCell(cellOf("bob", "audit"));
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(selected()).toHaveLength(2);
    update({ editing: false });
    update({ editing: true });
    expect(selected()).toHaveLength(0);
  });

  test("keys with ⌘, Ctrl or Alt are left to the app: the focus stays and no range starts", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("bob", "audit"));
    await user.keyboard("{Meta>}{Shift>}{ArrowDown}{/Shift}{/Meta}");
    expect(cellOf("bob", "audit")).toHaveFocus();
    expect(selected()).toHaveLength(0);
  });
});

describe("the detail of a cell", () => {
  test("is opened by a double click, which leaves the cell as it was", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    await user.dblClick(cellOf("alice", "audit"));
    expect(await screen.findByRole("complementary", { name: "alice · audit" })).toBeInTheDocument();
    expect(changes()).toEqual([]); // the first press gave it and the second took it back
    expect(m.cell).toHaveBeenCalledWith(pgTarget, "orders", "alice", "audit");
  });

  test("is opened by a double click on a cell that cannot be toggled too", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    await user.dblClick(cellOf("app_owner", "app"));
    expect(await screen.findByRole("complementary", { name: "app_owner · app" })).toBeInTheDocument();
  });

  test("a double click leaves the changes of other cells in the tray", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    fireEvent.click(cellOf("bob", "audit"));
    await user.dblClick(cellOf("alice", "audit"));
    await screen.findByRole("complementary", { name: "alice · audit" });
    expect(changes()).toEqual([reading("bob", "audit", true)]);
  });

  test("marks the cell it is for, and Esc closes it", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    focusCell(cellOf("alice", "audit"));
    await user.keyboard("{Enter}");
    await screen.findByRole("complementary", { name: "alice · audit" });
    expect(selected()).toHaveLength(1);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });
});

describe("the tray, from the grid", () => {
  test("holds what was painted, in the order it was painted, with a label for each", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("postgres", "audit"));
    fireEvent.click(cellOf("alice", "audit"));
    expect(draft.items.map((d) => d.label)).toEqual(["권한 주기: postgres · audit 스키마의 모든 테이블 SELECT", "권한 주기: alice · audit 스키마의 모든 테이블 SELECT"]);
  });

  test("a change that leaves the tray leaves its mark off the cell", async () => {
    setup();
    await loaded();
    fireEvent.click(cellOf("alice", "audit"));
    act(() => draft.removeApplied([reading("alice", "audit", true)]));
    expect(changes()).toEqual([]);
    expect(cellOf("alice", "audit")).toHaveAccessibleName("alice · audit: 읽기 없음");
  });
});
