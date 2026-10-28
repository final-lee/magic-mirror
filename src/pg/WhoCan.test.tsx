import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import { customersTable, object, ordersIdSeq, ordersTable, pgTarget, sampleDatabaseView, sampleOverview, sampleWhoCan, source, touchOrderFn } from "./fixtures";
import { objectName } from "./labels";
import { pgKeys } from "./queries";
import { DEFAULT_KINDS, type RoleKindsValue } from "./RoleKinds";
import type { PgObjectKind, PgObjectRef, PgOverview, PgWhoCan, PgWhoCanRow } from "./types";
import { OBJECT_PRIVILEGES, SEARCH_DELAY_MS, WhoCan } from "./WhoCan";

vi.mock("./api", () => ({ pgApi: { objects: vi.fn(), whoCan: vi.fn(), database: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(pgApi);

const OBJECTS: PgObjectRef[] = [object("database", null, "orders"), object("schema", null, "app"), ordersTable, customersTable, ordersIdSeq, touchOrderFn];

type Props = { initialKinds?: RoleKindsValue; database?: string; overview?: PgOverview };

/** 고른 데이터베이스와 칩은 PgTab이 들고 있다. 여기서는 같은 일을 하는 작은 부모를 쓴다. */
function Harness({ initialKinds = DEFAULT_KINDS, database: initialDatabase, overview = sampleOverview() }: Props) {
  const [kinds, setKinds] = useState(initialKinds);
  const [database, setDatabase] = useState(initialDatabase);
  return <WhoCan target={pgTarget} overview={overview} database={database} onDatabase={setDatabase} kinds={kinds} onKinds={setKinds} />;
}

const setup = (props: Props = {}) => renderWithClient(<Harness {...props} />);

const form = () => screen.getByRole("search", { name: "누가 할 수 있나 검색" });
const objectButton = () => within(form()).getByRole("button");
const privilegeGroup = () => within(form()).queryByRole("radiogroup", { name: "권한" });
const privileges = () => within(privilegeGroup()!).getAllByRole("radio").map((r) => r.closest("label")!.textContent!.trim());
const checkedPrivilege = () => within(privilegeGroup()!).getAllByRole("radio").find((r) => (r as HTMLInputElement).checked)!.closest("label")!.textContent!.trim();
const privilegeRadio = (name: string) => within(privilegeGroup()!).getByRole("radio", { name });
const dialog = () => screen.getByRole("dialog", { name: "객체 고르기" });
const search = () => within(dialog()).getByRole("searchbox", { name: "객체 검색" });
const found = () => within(dialog()).queryAllByRole("option").map((o) => within(o).getByText((_, el) => el?.classList.contains("pk-name") ?? false).textContent);
const picker = () => screen.getByRole("combobox", { name: "데이터베이스" });

/** 열린 검색 창의 목록에 이름이 name인 객체가 나올 때까지 기다린다 */
const listed = (name: string) => within(dialog()).findByText(name, { selector: ".pk-name" });

/** 검색 창을 열고, 이름이 name인 객체를 고른다. 고른 뒤 창은 닫힌다. */
async function choose(name: string, results: PgObjectRef[] = OBJECTS) {
  m.objects.mockResolvedValue(results);
  fireEvent.click(objectButton());
  fireEvent.click(await within(dialog()).findByText(name, { selector: ".pk-name" }));
}

/** 찾은 결과가 그려질 때까지 기다린다 */
const results = () => screen.findByRole("table", { name: "할 수 있는 역할" }) as Promise<HTMLTableElement>;
const unusableTable = () => screen.getByRole("table", { name: "못 쓰는 역할" }) as HTMLTableElement;
/** 표의 줄을 위에서부터: 종류 머리("사용자 3")이거나 역할 이름 */
const lines = (table: HTMLElement) => within(table).getAllByRole("row").slice(1).map((r) => (r.querySelector("th")?.firstChild?.textContent ?? "").trim());
const rowOf = (table: HTMLElement, role: string) => within(table).getByText(role, { selector: "th" }).closest("tr") as HTMLElement;
const paths = (row: HTMLElement) => within(row).getAllByRole("listitem").map((li) => li.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  m.objects.mockResolvedValue(OBJECTS);
  m.whoCan.mockResolvedValue(sampleWhoCan());
});

describe("a database whose privileges were read only in part", () => {
  const NOTE = "객체가 많아 일부만 읽었어요";
  /** 권한 표가 읽어 둔 사본을 캐시에 둔다 */
  const cache = (qc: ReturnType<typeof setup>["qc"], database: string, truncated: boolean) =>
    act(() => {
      qc.setQueryData(pgKeys.database(pgTarget, database), sampleDatabaseView({ database, truncated }));
    });

  test("says so when the copy of the privileges that was read before was cut", async () => {
    const { qc } = setup();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    cache(qc, "orders", true);
    expect(await screen.findByText(NOTE)).toBeInTheDocument();
    expect(screen.getAllByText(NOTE)).toHaveLength(1);
  });

  test("says nothing when the copy was read whole, or when none was read, and does not read the privileges for this", async () => {
    const { qc } = setup();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    cache(qc, "orders", false);
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    // 다른 데이터베이스의 사본은 이 데이터베이스에 대해 말하지 않는다
    cache(qc, "analytics", true);
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    expect(m.database).not.toHaveBeenCalled();
  });

  test("follows the database that is chosen", async () => {
    const { qc } = setup();
    cache(qc, "analytics", true);
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    fireEvent.change(picker(), { target: { value: "analytics" } });
    expect(await screen.findByText(NOTE)).toBeInTheDocument();
    fireEvent.change(picker(), { target: { value: "orders" } });
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  test("keeps saying so while an object is chosen and the roles are listed", async () => {
    const { qc } = setup();
    cache(qc, "orders", true);
    await choose("app.orders");
    await results();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });
});

describe("before an object is chosen", () => {
  test("is on the default database of the target, says what to do, and reads nothing", () => {
    setup();
    expect(picker()).toHaveValue("orders");
    expect(objectButton()).toHaveTextContent("객체 고르기");
    expect(privilegeGroup()).not.toBeInTheDocument();
    expect(screen.getByText("객체를 고르면 그 객체에 권한을 가진 사용자와 그룹을 찾아요")).toBeInTheDocument();
    expect(m.objects).not.toHaveBeenCalled();
    expect(m.whoCan).not.toHaveBeenCalled();
  });

  test("has the chips and the system roles toggle of the role list next to the database", () => {
    setup();
    expect(screen.getByRole("checkbox", { name: "사용자" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "그룹" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "시스템 역할 보기" })).not.toBeChecked();
  });

  test("a cluster with no database to connect to says so, and has nothing to search in", () => {
    setup({ overview: sampleOverview({ databases: [{ name: "legacy_archive", owner: "app_owner", allowConn: false }] }) });
    expect(screen.getByText("연결할 수 있는 데이터베이스가 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
  });
});

describe("the search for an object", () => {
  test("[객체 고르기] opens it on the database that is showing, and reads the first objects of that database", async () => {
    setup();
    fireEvent.click(objectButton());
    expect(dialog()).toBeInTheDocument();
    expect(within(dialog()).getByText("orders 데이터베이스에서 찾아요. 이름의 일부를 입력하세요(예: app.orders)")).toBeInTheDocument();
    await waitFor(() => expect(m.objects).toHaveBeenCalledWith(pgTarget, "orders", ""));
    expect(m.objects).toHaveBeenCalledTimes(1);
  });

  test("the box has the focus, and the objects are listed with their kind", async () => {
    setup();
    fireEvent.click(objectButton());
    expect(search()).toHaveFocus();
    await listed("orders");
    expect(found()).toEqual(["orders", "app", "app.orders", "app.customers", "app.orders_id_seq", "app.touch_order(order_id integer)"]);
    const options = within(dialog()).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["orders데이터베이스", "app스키마", "app.orders테이블", "app.customers테이블", "app.orders_id_seq시퀀스", "app.touch_order(order_id integer)함수"]);
  });

  test("says so until the first objects come", async () => {
    let resolve!: (v: PgObjectRef[]) => void;
    m.objects.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    fireEvent.click(objectButton());
    expect(within(dialog()).getByText("찾는 중…")).toBeInTheDocument();
    await act(async () => resolve(OBJECTS));
    await listed("app.customers");
    expect(within(dialog()).queryByText("찾는 중…")).not.toBeInTheDocument();
    expect(found()).toHaveLength(6);
  });

  test("searches what was typed, once the typing has paused: only the last text of a burst is searched", async () => {
    setup();
    fireEvent.click(objectButton());
    await waitFor(() => expect(m.objects).toHaveBeenCalledTimes(1));
    fireEvent.change(search(), { target: { value: "o" } });
    fireEvent.change(search(), { target: { value: "or" } });
    fireEvent.change(search(), { target: { value: "ord" } });
    expect(m.objects).toHaveBeenCalledTimes(1); // 입력이 이어지는 동안은 읽지 않는다
    await waitFor(() => expect(m.objects).toHaveBeenCalledWith(pgTarget, "orders", "ord"));
    expect(m.objects.mock.calls.map((call) => call[2])).toEqual(["", "ord"]);
  });

  test("waits 250 ms", () => {
    expect(SEARCH_DELAY_MS).toBe(250);
  });

  test("leaves out the spaces around the text", async () => {
    setup();
    fireEvent.click(objectButton());
    await waitFor(() => expect(m.objects).toHaveBeenCalledTimes(1));
    fireEvent.change(search(), { target: { value: "  app.ord " } });
    await waitFor(() => expect(m.objects).toHaveBeenCalledWith(pgTarget, "orders", "app.ord"));
  });

  test("shows what the new text found in place of the objects of the text before", async () => {
    m.objects.mockImplementation(async (_t, _d, query) => OBJECTS.filter((o) => objectName(o).includes(query)));
    setup();
    fireEvent.click(objectButton());
    await within(dialog()).findByText("app.customers", { selector: ".pk-name" });
    fireEvent.change(search(), { target: { value: "cust" } });
    await waitFor(() => expect(found()).toEqual(["app.customers"]));
  });

  test("says so when nothing matches", async () => {
    m.objects.mockImplementation(async (_t, _d, query) => OBJECTS.filter((o) => objectName(o).includes(query)));
    setup();
    fireEvent.click(objectButton());
    await listed("app.orders");
    fireEvent.change(search(), { target: { value: "nothing like it" } });
    expect(await within(dialog()).findByText("조건에 맞는 객체가 없어요")).toBeInTheDocument();
  });

  test("tells that the list stops at 100 when it has 100, and only then", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => object("table", "app", `t${String(i).padStart(3, "0")}`));
    const NOTE = "최대 100개까지만 보여줘요. 이름을 더 입력해 좁혀 보세요";
    m.objects.mockResolvedValue(many(100));
    setup();
    fireEvent.click(objectButton());
    expect(await within(dialog()).findByText(NOTE)).toBeInTheDocument();
    fireEvent.change(search(), { target: { value: "t0" } });
    m.objects.mockResolvedValue(many(99));
    await waitFor(() => expect(within(dialog()).queryByText(NOTE)).not.toBeInTheDocument());
    expect(found()).toHaveLength(99);
  });

  test("shows why a search failed through the error box", async () => {
    m.objects.mockRejectedValue({ kind: "other", message: '"orders"에 연결하지 못했어요: too many connections' });
    setup();
    fireEvent.click(objectButton());
    expect(await within(dialog()).findByText('"orders"에 연결하지 못했어요: too many connections')).toBeInTheDocument();
    expect(within(dialog()).queryByText("조건에 맞는 객체가 없어요")).not.toBeInTheDocument();
  });

  test("[취소] and Esc close it without choosing, and the focus goes back to the button", async () => {
    setup();
    fireEvent.click(objectButton());
    await listed("orders");
    fireEvent.click(within(dialog()).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(objectButton()).toHaveFocus();
    expect(objectButton()).toHaveTextContent("객체 고르기");
    fireEvent.click(objectButton());
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(objectButton()).toHaveFocus();
    expect(m.whoCan).not.toHaveBeenCalled();
  });

  test("the arrows and Enter choose too", async () => {
    setup();
    fireEvent.click(objectButton());
    await listed("app.customers");
    for (let i = 0; i < 4; i++) fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(objectButton()).toHaveTextContent("app.customers");
  });
});

describe("the chosen object", () => {
  test("closes the search, is named on the button with its kind, and the focus is on the button", async () => {
    setup();
    await choose("app.orders");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(objectButton()).toHaveTextContent("app.orders");
    expect(objectButton()).toHaveTextContent("테이블");
    expect(objectButton()).toHaveFocus();
    expect(screen.queryByText("객체를 고르면 그 객체에 권한을 가진 사용자와 그룹을 찾아요")).not.toBeInTheDocument();
  });

  test("reads who can, in the database that is showing, for the first privilege of its kind", async () => {
    setup();
    await choose("app.orders");
    await results();
    expect(m.whoCan).toHaveBeenCalledTimes(1);
    expect(m.whoCan).toHaveBeenCalledWith(pgTarget, "orders", ordersTable, "SELECT");
  });

  test("the button can choose another one, which is read in turn", async () => {
    setup();
    await choose("app.orders");
    await results();
    await choose("app.customers");
    await waitFor(() => expect(m.whoCan).toHaveBeenCalledWith(pgTarget, "orders", customersTable, "SELECT"));
    expect(objectButton()).toHaveTextContent("app.customers");
  });

  test("searches the other database once that one is chosen, and the object of the first is forgotten", async () => {
    setup();
    await choose("app.orders");
    await results();
    fireEvent.change(picker(), { target: { value: "analytics" } });
    expect(objectButton()).toHaveTextContent("객체 고르기");
    expect(privilegeGroup()).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "할 수 있는 역할" })).not.toBeInTheDocument();
    m.objects.mockClear();
    fireEvent.click(objectButton());
    await waitFor(() => expect(m.objects).toHaveBeenCalledWith(pgTarget, "analytics", ""));
  });
});

describe("the privilege", () => {
  const OF_KIND: Record<PgObjectKind, PgObjectRef> = {
    database: object("database", null, "orders"),
    schema: object("schema", null, "app"),
    table: ordersTable,
    view: object("view", "app", "order_totals"),
    matview: object("matview", "app", "daily_sales"),
    partitioned: object("partitioned", "app", "events_p"),
    foreign: object("foreign", "app", "remote_orders"),
    sequence: ordersIdSeq,
    function: touchOrderFn,
  };
  const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
  const EXPECTED: Record<PgObjectKind, string[]> = {
    database: ["CONNECT", "CREATE", "TEMPORARY"],
    schema: ["USAGE", "CREATE"],
    table: TABLE_PRIVILEGES,
    view: TABLE_PRIVILEGES,
    matview: TABLE_PRIVILEGES,
    partitioned: TABLE_PRIVILEGES,
    foreign: TABLE_PRIVILEGES,
    sequence: ["USAGE", "SELECT", "UPDATE"],
    function: ["EXECUTE"],
  };

  test.each(Object.keys(EXPECTED) as PgObjectKind[])("a %s has the privileges of its kind, and the first one is chosen", async (kind) => {
    setup();
    await choose(objectName(OF_KIND[kind]), [OF_KIND[kind]]);
    expect(privileges()).toEqual(EXPECTED[kind]);
    expect(checkedPrivilege()).toBe(EXPECTED[kind][0]);
    await waitFor(() => expect(m.whoCan).toHaveBeenCalledWith(pgTarget, "orders", OF_KIND[kind], EXPECTED[kind][0]));
  });

  test("the lists are the ones the constraints give", () => {
    expect(OBJECT_PRIVILEGES).toEqual(EXPECTED);
  });

  test("choosing another one reads who can with it, and each is read once", async () => {
    setup();
    await choose("app.orders");
    await results();
    fireEvent.click(privilegeRadio("UPDATE"));
    await waitFor(() => expect(m.whoCan).toHaveBeenCalledWith(pgTarget, "orders", ordersTable, "UPDATE"));
    expect(checkedPrivilege()).toBe("UPDATE");
    fireEvent.click(privilegeRadio("SELECT"));
    await results();
    expect(m.whoCan).toHaveBeenCalledTimes(2); // 이미 읽은 SELECT는 다시 읽지 않는다
  });

  test("stays on the chosen privilege when the next object has it too, and starts over when it does not", async () => {
    setup();
    await choose("app.orders");
    await results();
    fireEvent.click(privilegeRadio("UPDATE"));
    await waitFor(() => expect(checkedPrivilege()).toBe("UPDATE"));
    await choose("app.orders_id_seq"); // 시퀀스도 UPDATE가 있다
    expect(checkedPrivilege()).toBe("UPDATE");
    await waitFor(() => expect(m.whoCan).toHaveBeenCalledWith(pgTarget, "orders", ordersIdSeq, "UPDATE"));
    await choose("app.touch_order(order_id integer)"); // 함수는 EXECUTE뿐이다
    expect(privileges()).toEqual(["EXECUTE"]);
    expect(checkedPrivilege()).toBe("EXECUTE");
    await waitFor(() => expect(m.whoCan).toHaveBeenCalledWith(pgTarget, "orders", touchOrderFn, "EXECUTE"));
    await choose("app.customers"); // 다시 테이블: 처음 권한부터
    expect(checkedPrivilege()).toBe("SELECT");
  });

  test("the choices are one named group of radio buttons, with the first one on", async () => {
    setup();
    await choose("app.orders");
    const radios = within(privilegeGroup()!).getAllByRole("radio") as HTMLInputElement[];
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios.map((r) => r.checked)).toEqual([true, false, false, false, false, false, false]);
  });
});

describe("the roles that can", () => {
  test("are the users and then the groups, with how many there are, each in name order", async () => {
    setup();
    await choose("app.orders");
    const table = await results();
    expect(lines(table)).toEqual(["사용자", "alice", "app_owner", "iam_admin", "그룹", "app_read", "app_write"]);
    expect(within(table).getByText("사용자", { selector: "th" })).toHaveTextContent("사용자 3");
    expect(within(table).getByText("그룹", { selector: "th" })).toHaveTextContent("그룹 2");
  });

  test("keep to name order whatever order the backend sends them in", async () => {
    const shuffled: PgWhoCan = sampleWhoCan();
    shuffled.allowed = [...shuffled.allowed].reverse();
    m.whoCan.mockResolvedValue(shuffled);
    setup();
    await choose("app.orders");
    const table = await results();
    expect(lines(table)).toEqual(["사용자", "alice", "app_owner", "iam_admin", "그룹", "app_read", "app_write"]);
  });

  test("tell the way to the privilege: through the groups, as the owner, from a predefined role and directly", async () => {
    setup();
    await choose("app.orders");
    const table = await results();
    expect(paths(rowOf(table, "alice"))).toEqual(["alice ← app_write ← app_read ← 직접 받음"]);
    expect(paths(rowOf(table, "app_owner"))).toEqual(["app_owner ← 소유자"]);
    expect(paths(rowOf(table, "iam_admin"))).toEqual(["iam_admin ← pg_read_all_data ← 미리 정의된 역할"]);
    expect(paths(rowOf(table, "app_read"))).toEqual(["app_read ← 직접 받음"]);
    expect(paths(rowOf(table, "app_write"))).toEqual(["app_write ← app_read ← 직접 받음"]);
  });

  test("a role that has the privilege in several ways has a path for each", async () => {
    const row: PgWhoCanRow = {
      role: "alice",
      kind: "user",
      system: false,
      sources: [source("group", ["app_write", "app_read"], "app_owner"), source("direct", [], "app_owner"), source("public")],
      unusable: null,
    };
    m.whoCan.mockResolvedValue(sampleWhoCan({ allowed: [row] }));
    setup();
    await choose("app.orders");
    const table = await results();
    expect(paths(rowOf(table, "alice"))).toEqual(["alice ← app_write ← app_read ← 직접 받음", "alice ← 직접 받음", "alice ← 모든 역할(PUBLIC)"]);
  });

  test("have a table with the columns 역할 and 이유", async () => {
    setup();
    await choose("app.orders");
    const table = await results();
    expect(within(table.tHead!).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["역할", "이유"]);
  });
});

describe("the roles that have the privilege but cannot use it", () => {
  test("are apart from the others, under the text of the constraints, with what is missing", async () => {
    setup();
    await choose("app.orders");
    const table = await results();
    expect(lines(table)).not.toContain("bob");
    expect(screen.getByRole("heading", { name: "권한은 있지만 실제로는 못 써요" })).toBeInTheDocument();
    const apart = unusableTable();
    expect(lines(apart)).toEqual(["사용자", "bob"]);
    const row = rowOf(apart, "bob");
    expect(within(row).getByText("CONNECT 없음")).toBeInTheDocument();
    expect(paths(row)).toEqual(["bob ← 직접 받음"]);
  });

  test("have their users first and then their groups, too", async () => {
    const rows: PgWhoCanRow[] = [
      { role: "zed_group", kind: "group", system: false, sources: [source("direct")], unusable: "USAGE 없음" },
      { role: "yan", kind: "user", system: false, sources: [source("direct")], unusable: "CONNECT 없음" },
      { role: "bob", kind: "user", system: false, sources: [source("direct")], unusable: "CONNECT 없음" },
    ];
    m.whoCan.mockResolvedValue(sampleWhoCan({ allowed: rows }));
    setup();
    await choose("app.orders");
    await screen.findByRole("heading", { name: "권한은 있지만 실제로는 못 써요" });
    expect(lines(unusableTable())).toEqual(["사용자", "bob", "yan", "그룹", "zed_group"]);
    expect(within(rowOf(unusableTable(), "zed_group")).getByText("USAGE 없음")).toBeInTheDocument();
  });

  test("have no place of their own when there are none", async () => {
    m.whoCan.mockResolvedValue(sampleWhoCan({ allowed: sampleWhoCan().allowed.filter((r) => r.unusable === null) }));
    setup();
    await choose("app.orders");
    await results();
    expect(screen.queryByRole("heading", { name: "권한은 있지만 실제로는 못 써요" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "못 쓰는 역할" })).not.toBeInTheDocument();
  });

  test("when nobody else can use it, the others say so, and these stay", async () => {
    m.whoCan.mockResolvedValue(sampleWhoCan({ allowed: sampleWhoCan().allowed.filter((r) => r.role === "bob") }));
    setup();
    await choose("app.orders");
    expect(await screen.findByText("실제로 쓸 수 있는 역할이 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "할 수 있는 역할" })).not.toBeInTheDocument();
    expect(lines(unusableTable())).toEqual(["사용자", "bob"]);
  });
});

describe("the system roles and the chips", () => {
  test("system roles are hidden until the toggle is on, and then they are there, in their kind", async () => {
    setup();
    await choose("app.orders");
    const table = await results();
    expect(lines(table)).not.toContain("pg_read_all_data");
    fireEvent.click(screen.getByRole("checkbox", { name: "시스템 역할 보기" }));
    expect(lines(table)).toEqual(["사용자", "alice", "app_owner", "iam_admin", "그룹", "app_read", "app_write", "pg_read_all_data"]);
    expect(paths(rowOf(table, "pg_read_all_data"))).toEqual(["pg_read_all_data ← 미리 정의된 역할"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "시스템 역할 보기" }));
    expect(lines(table)).not.toContain("pg_read_all_data");
  });

  test("a system role that cannot use the privilege is hidden from the other place too", async () => {
    const system: PgWhoCanRow = { role: "rds_superuser", kind: "group", system: true, sources: [source("direct")], unusable: "CONNECT 없음" };
    m.whoCan.mockResolvedValue(sampleWhoCan({ allowed: [...sampleWhoCan().allowed, system] }));
    setup();
    await choose("app.orders");
    await screen.findByRole("heading", { name: "권한은 있지만 실제로는 못 써요" });
    expect(lines(unusableTable())).toEqual(["사용자", "bob"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "시스템 역할 보기" }));
    expect(lines(unusableTable())).toEqual(["사용자", "bob", "그룹", "rds_superuser"]);
  });

  test("starts with the system roles shown when the tab has them on", async () => {
    setup({ initialKinds: { ...DEFAULT_KINDS, system: true } });
    await choose("app.orders");
    const table = await results();
    expect(lines(table)).toContain("pg_read_all_data");
  });

  test("each chip hides its kind", async () => {
    setup();
    await choose("app.orders");
    const table = await results();
    fireEvent.click(screen.getByRole("checkbox", { name: "그룹" }));
    expect(lines(table)).toEqual(["사용자", "alice", "app_owner", "iam_admin"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "그룹" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "사용자" }));
    expect(lines(table)).toEqual(["그룹", "app_read", "app_write"]);
  });

  test("when they hide every role, it says the conditions leave none", async () => {
    setup();
    await choose("app.orders");
    await results();
    fireEvent.click(screen.getByRole("checkbox", { name: "사용자" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "그룹" }));
    expect(screen.getByText("조건에 맞는 역할이 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "할 수 있는 역할" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "권한은 있지만 실제로는 못 써요" })).not.toBeInTheDocument();
  });
});

describe("the answer", () => {
  test("says so while it is read, and the form stays", async () => {
    let resolve!: (v: PgWhoCan) => void;
    m.whoCan.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    await choose("app.orders");
    expect(await screen.findByText("찾는 중…")).toBeInTheDocument();
    expect(privilegeGroup()).toBeInTheDocument();
    await act(async () => resolve(sampleWhoCan()));
    expect(await results()).toBeInTheDocument();
    expect(screen.queryByText("찾는 중…")).not.toBeInTheDocument();
  });

  test("says so when no role has the privilege", async () => {
    m.whoCan.mockResolvedValue(sampleWhoCan({ allowed: [] }));
    setup();
    await choose("app.orders");
    expect(await screen.findByText("이 권한을 가진 역할이 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  test("shows why it failed through the error box, and the form stays so another can be tried", async () => {
    m.whoCan.mockRejectedValue({ kind: "other", message: "질의가 30초 안에 끝나지 않았어요. 잠시 뒤 다시 읽어 주세요" });
    setup();
    await choose("app.orders");
    expect(await screen.findByText("질의가 30초 안에 끝나지 않았어요. 잠시 뒤 다시 읽어 주세요")).toBeInTheDocument();
    expect(privilegeGroup()).toBeInTheDocument();
    m.whoCan.mockResolvedValue(sampleWhoCan());
    fireEvent.click(privilegeRadio("INSERT"));
    expect(await results()).toBeInTheDocument();
  });

  test("keeps the roles on screen, with the error above them, when a later read fails", async () => {
    const { qc } = setup();
    await choose("app.orders");
    await results();
    m.whoCan.mockRejectedValue({ kind: "network", message: "데이터베이스 연결이 끊겼어요. 다시 읽으면 새로 연결해요" });
    await act(async () => {
      await qc.invalidateQueries({ queryKey: pgKeys.root(pgTarget) });
    });
    expect(await screen.findByText(/데이터베이스 연결이 끊겼어요/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "할 수 있는 역할" })).toBeInTheDocument();
  });
});
