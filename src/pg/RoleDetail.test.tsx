import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { formatDateTime, formatDay } from "../iam/format";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import { pgTarget, sampleDatabaseView, sampleRoleView } from "./fixtures";
import { pgKeys, refreshPg } from "./queries";
import { RoleDetail } from "./RoleDetail";
import type { PgObjectRef, PgRoleDatabase, PgRoleView, PgSchemaCell } from "./types";

vi.mock("./api", () => ({ pgApi: { role: vi.fn(), database: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(pgApi);

type Props = React.ComponentProps<typeof RoleDetail>;
function setup(role = "alice", props: Partial<Props> = {}) {
  const onOpen = vi.fn();
  const onViewState = vi.fn();
  const utils = renderWithClient(<RoleDetail target={pgTarget} role={role} onOpen={onOpen} onViewState={onViewState} {...props} />);
  return { onOpen, onViewState, ...utils };
}

/** 하위 탭을 눌러 연다 */
const openTab = async (name: string) => fireEvent.click(await screen.findByRole("tab", { name }));
/** 개요의 `이름 값` 쌍에서 값 */
const attr = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
const section = (database: string) => screen.getByRole("region", { name: database });
const cellTexts = (row: HTMLElement) => within(row).getAllByRole("cell").map((c) => c.textContent);
/** pg_database가 이 데이터베이스로 불린 일들. 읽혀 있는 데이터베이스(orders)도 상세가 열려 있는 동안 구독하니, 부른 횟수는 데이터베이스별로 센다. */
const readsOf = (database: string) => m.database.mock.calls.filter((c) => c[1] === database);
/** 이 데이터베이스의 첫 읽기만 실패하게 한다. mockRejectedValueOnce는 가장 먼저 읽는 데이터베이스가 걸린다. */
function failFirstReadOf(database: string, failure: unknown) {
  const read = m.database.getMockImplementation()!;
  let failed = false;
  m.database.mockImplementation(async (...args) => {
    if (args[1] === database && !failed) {
      failed = true;
      throw failure;
    }
    return read(...args);
  });
}

/**
 * 백엔드 대역. pg_database는 그 데이터베이스를 읽은 것으로 기억하고, pg_role은 읽은 데이터베이스마다 지금 세대의 칸(reports1, reports2 …)으로 답한다.
 * orders는 처음부터 읽혀 있다(픽스처 그대로).
 * - forget(): pg_open이 데이터베이스 스냅숏을 비우는 일. 읽혀 있던 orders도 비운다.
 * - next(): 다시 읽은 내용이 달라진다(세대가 오른다).
 * - remember(false): 읽어도 기억하지 못한다(읽자마자 스냅숏이 비워지는 경우). remember(true)로 되돌린다.
 */
function fakeBackend() {
  const loaded = new Set<string>(["orders"]);
  let generation = 1;
  let remembers = true;
  m.database.mockImplementation(async (_t, database) => {
    if (remembers) loaded.add(database);
    return sampleDatabaseView({ database });
  });
  m.role.mockImplementation(async (_t, role) => {
    const view = sampleRoleView(role);
    return {
      ...view,
      databases: view.databases.map((d) => {
        if (!loaded.has(d.database)) return { ...d, loaded: false, cells: [], owned: [], ownedOmitted: 0 };
        if (d.database === "orders" && generation === 1) return { ...d, loaded: true }; // 픽스처의 칸 그대로
        return { ...d, loaded: true, cells: [cell({ role, schema: `reports${generation}`, usage: true, read: "all" })] };
      }),
    };
  });
  return {
    forget: () => loaded.clear(),
    next: () => void generation++,
    remember: (on: boolean) => void (remembers = on),
  };
}

/** 한 데이터베이스를 읽은 것으로 바꾼 상세 */
function withLoaded(view: PgRoleView, database: string, patch: Partial<PgRoleDatabase> = {}): PgRoleView {
  return { ...view, databases: view.databases.map((d) => (d.database === database ? { ...d, loaded: true, ...patch } : d)) };
}
const cell = (extra: Partial<PgSchemaCell>): PgSchemaCell => ({
  role: "alice",
  schema: "app",
  usage: false,
  create: false,
  read: "none",
  write: "none",
  inheritedOnly: false,
  unusable: null,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.role.mockImplementation(async (_t, role) => sampleRoleView(role));
  m.database.mockImplementation(async (_t, database) => sampleDatabaseView({ database }));
});

describe("loading", () => {
  test("says so until the role arrives, and asks the backend for this role of this target", async () => {
    let resolve!: (v: PgRoleView) => void;
    m.role.mockReturnValue(new Promise((r) => (resolve = r)));
    setup("alice");
    expect(screen.getByText("불러오는 중…")).toBeInTheDocument();
    expect(m.role).toHaveBeenCalledWith(pgTarget, "alice");
    await act(async () => resolve(sampleRoleView("alice")));
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument();
  });

  test("shows why it failed, and 다시 시도 reads the role again", async () => {
    m.role.mockRejectedValueOnce({ kind: "other", message: "먼저 연결해 주세요" });
    setup("alice");
    expect(await screen.findByText("먼저 연결해 주세요")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument();
    expect(m.role).toHaveBeenCalledTimes(2);
  });

  test("a read that fails after the role was shown keeps it on screen with the error above", async () => {
    const { qc } = setup("alice");
    await screen.findByRole("heading", { name: "alice" });
    m.role.mockRejectedValueOnce({ kind: "network", message: "끊겼어요" });
    await act(async () => {
      await qc.invalidateQueries({ queryKey: pgKeys.role(pgTarget, "alice") });
    });
    expect(await screen.findByText("네트워크 오류: 끊겼어요")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "alice" })).toBeInTheDocument();
  });
});

describe("header", () => {
  test("has the name, the kind and the badges", async () => {
    setup("iam_admin");
    expect(await screen.findByRole("heading", { name: "iam_admin" })).toBeInTheDocument();
    expect(screen.getByText("사용자")).toHaveClass("iam-kind");
    expect(Array.from(document.querySelectorAll(".iam-head .iam-badge")).map((b) => b.textContent)).toEqual(["관리자급", "IAM 인증", "앱이 로그인한 역할"]);
  });

  test("a role that cannot log in is a 그룹", async () => {
    setup("app_read");
    await screen.findByRole("heading", { name: "app_read" });
    expect(screen.getByText("그룹")).toHaveClass("iam-kind");
  });
});

describe("tabs", () => {
  test("has 개요, 구성원, 권한, 소유 객체 and 세션, and opens on 개요", async () => {
    setup();
    await screen.findByRole("heading", { name: "alice" });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["개요", "구성원", "권한", "소유 객체", "세션"]);
    expect(screen.getByRole("tab", { name: "개요" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toBeInTheDocument();
  });

  test("opens on the tab it is told to, and falls back to 개요 for one it does not know", async () => {
    const first = setup("alice", { initialTab: "sessions" });
    expect(await screen.findByRole("tab", { name: "세션" })).toHaveAttribute("aria-selected", "true");
    first.unmount();
    setup("alice", { initialTab: "nonsense" });
    expect(await screen.findByRole("tab", { name: "개요" })).toHaveAttribute("aria-selected", "true");
  });

  test("tells which tab was opened, so going back can restore it", async () => {
    const { onViewState } = setup();
    await openTab("구성원");
    expect(onViewState).toHaveBeenLastCalledWith({ tab: "members" });
    expect(screen.getByRole("tab", { name: "구성원" })).toHaveAttribute("aria-selected", "true");
    await openTab("소유 객체");
    expect(onViewState).toHaveBeenLastCalledWith({ tab: "owned" });
    await openTab("개요");
    expect(onViewState).toHaveBeenLastCalledWith({ tab: "overview" });
  });
});

describe("개요", () => {
  test("lists every attribute under its SQL name, with 예 or 아니요", async () => {
    setup("postgres");
    await screen.findByRole("heading", { name: "postgres" });
    const expected = { LOGIN: "예", CREATEDB: "예", CREATEROLE: "예", INHERIT: "예", REPLICATION: "아니요", BYPASSRLS: "아니요" };
    for (const [label, value] of Object.entries(expected)) expect(attr(label), label).toHaveTextContent(value);
    expect(screen.getAllByRole("term").map((t) => t.textContent)).toEqual(["LOGIN", "CREATEDB", "CREATEROLE", "INHERIT", "REPLICATION", "BYPASSRLS", "연결 수 제한", "만료일"]);
  });

  test("a role that does not inherit says 아니요 for INHERIT", async () => {
    setup("bob");
    await screen.findByRole("heading", { name: "bob" });
    expect(attr("INHERIT")).toHaveTextContent("아니요");
  });

  test("the connection limit is the number, or 제한 없음 for -1", async () => {
    const owner = setup("app_owner");
    await screen.findByRole("heading", { name: "app_owner" });
    expect(attr("연결 수 제한")).toHaveTextContent("20");
    owner.unmount();
    setup("alice");
    await screen.findByRole("heading", { name: "alice" });
    expect(attr("연결 수 제한")).toHaveTextContent("제한 없음");
  });

  test("the expiry is the date, or 없음", async () => {
    const soon = setup("bob");
    await screen.findByRole("heading", { name: "bob" });
    expect(attr("만료일")).toHaveTextContent(formatDay(sampleRoleView("bob").summary.attributes.validUntil));
    expect(attr("만료일").textContent).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    soon.unmount();
    setup("alice");
    await screen.findByRole("heading", { name: "alice" });
    expect(attr("만료일")).toHaveTextContent("없음");
  });

  test("the settings of the role say where they apply", async () => {
    setup("app_owner");
    await screen.findByRole("heading", { name: "app_owner" });
    const items = within(screen.getByRole("list", { name: "역할별 설정" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["모든 데이터베이스search_path=app, public", "orderswork_mem=64MB"]);
  });

  test("says so when there are no settings", async () => {
    setup("alice");
    await screen.findByRole("heading", { name: "alice" });
    expect(screen.getByText("설정한 값이 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "역할별 설정" })).not.toBeInTheDocument();
  });

  test("shows the comment, or 없음", async () => {
    const admin = setup("iam_admin");
    await screen.findByRole("heading", { name: "iam_admin" });
    expect(screen.getByRole("region", { name: "주석" })).toHaveTextContent("IAM 인증으로 접속하는 관리자");
    admin.unmount();
    setup("alice");
    await screen.findByRole("heading", { name: "alice" });
    expect(screen.getByRole("region", { name: "주석" })).toHaveTextContent("없음");
  });
});

describe("구성원", () => {
  const groupsList = () => screen.getByRole("list", { name: "속한 그룹" });
  const membersList = () => screen.getByRole("list", { name: "구성원" });
  const rowText = (list: HTMLElement) => within(list).getAllByRole("listitem").map((li) => li.textContent);

  test("the groups a role belongs to say whether they are inherited", async () => {
    setup("alice");
    await openTab("구성원");
    expect(rowText(groupsList())).toEqual(["app_write상속", "rds_iam상속"]);
  });

  test("a membership that does not inherit can only be used with SET ROLE", async () => {
    setup("bob");
    await openTab("구성원");
    expect(rowText(groupsList())).toEqual(["app_readSET ROLE로만 쓸 수 있음"]);
  });

  test("an ADMIN OPTION is marked", async () => {
    setup("postgres");
    await openTab("구성원");
    expect(rowText(groupsList())).toEqual(["rds_superuser상속ADMIN OPTION"]);
  });

  test("the members of a group are listed with the same marks", async () => {
    setup("app_read");
    await openTab("구성원");
    expect(rowText(membersList())).toEqual(["app_write상속", "bobSET ROLE로만 쓸 수 있음"]);
    expect(screen.getByText("속한 그룹이 없어요")).toBeInTheDocument();
  });

  test("a member with an ADMIN OPTION in the group is marked too", async () => {
    setup("rds_superuser");
    await openTab("구성원");
    expect(rowText(membersList())).toEqual(["iam_admin상속", "postgres상속ADMIN OPTION"]);
  });

  test("says so when there are no members", async () => {
    setup("alice");
    await openTab("구성원");
    expect(screen.getByText("구성원이 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "구성원" })).not.toBeInTheDocument();
  });

  test("a member's name opens that role's detail", async () => {
    const { onOpen } = setup("app_read");
    await openTab("구성원");
    fireEvent.click(within(membersList()).getByRole("button", { name: "bob" }));
    expect(onOpen).toHaveBeenCalledWith({ view: "roles", id: "bob" });
    fireEvent.click(within(membersList()).getByRole("button", { name: "app_write" }));
    expect(onOpen).toHaveBeenLastCalledWith({ view: "roles", id: "app_write" });
  });

  test("a group's name opens the group", async () => {
    const { onOpen } = setup("alice");
    await openTab("구성원");
    fireEvent.click(within(groupsList()).getByRole("button", { name: "rds_iam" }));
    expect(onOpen).toHaveBeenCalledWith({ view: "roles", id: "rds_iam" });
  });
});

describe("권한", () => {
  test("has one section per database that can be connected to, in the order the backend gave", async () => {
    setup("alice");
    await openTab("권한");
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["analytics", "orders", "postgres"]);
    expect(within(section("orders")).queryByRole("button", { name: "불러오기" })).not.toBeInTheDocument();
    expect(within(section("analytics")).getByRole("button", { name: "불러오기" })).toBeInTheDocument();
    expect(within(section("postgres")).getByRole("button", { name: "불러오기" })).toBeInTheDocument();
    expect(within(section("analytics")).getByText("아직 읽지 않았어요")).toBeInTheDocument();
  });

  test("a read database has a row per schema with the level of each privilege and where it comes from", async () => {
    setup("alice");
    await openTab("권한");
    const table = within(section("orders")).getByRole("table", { name: "orders 권한" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["스키마", "사용 USAGE", "만들기 CREATE", "읽기 SELECT", "쓰기 INSERT·UPDATE·DELETE", "출처"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    // alice는 app_write ← app_read 그룹에서만 받았다
    expect(cellTexts(rows[0])).toEqual(["app", "있음", "없음", "모든 테이블", "일부 테이블", "그룹·PUBLIC으로만 받음"]);
  });

  test("a privilege that is held directly or through ownership is not called inherited", async () => {
    setup("app_owner");
    await openTab("권한");
    const rows = within(within(section("orders")).getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map(cellTexts)).toEqual([
      ["app", "있음", "있음", "모든 테이블", "모든 테이블", "직접 받음·소유"],
      ["audit", "있음", "있음", "모든 테이블", "모든 테이블", "직접 받음·소유"],
    ]);
  });

  test("rows are in schema order whatever order the backend sent", async () => {
    m.role.mockResolvedValue(
      withLoaded(sampleRoleView("alice"), "orders", { cells: [cell({ schema: "zeta", usage: true }), cell({ schema: "app", usage: true }), cell({ schema: "mid", usage: true })] }),
    );
    setup("alice");
    await openTab("권한");
    const rows = within(within(section("orders")).getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => cellTexts(r)[0])).toEqual(["app", "mid", "zeta"]);
  });

  test.each([
    ["USAGE", { usage: true }],
    ["CREATE", { create: true }],
    ["SELECT on some tables", { read: "some" as const }],
    ["INSERT, UPDATE and DELETE on all tables", { write: "all" as const }],
  ])("a schema with only %s is listed", async (_what, extra) => {
    m.role.mockResolvedValue(withLoaded(sampleRoleView("alice"), "orders", { cells: [cell({ schema: "app", ...extra })] }));
    setup("alice");
    await openTab("권한");
    const rows = within(within(section("orders")).getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => cellTexts(r)[0])).toEqual(["app"]);
  });

  test("a schema the role holds nothing on is not listed, even when the backend sends it", async () => {
    m.role.mockResolvedValue(
      withLoaded(sampleRoleView("alice"), "orders", {
        cells: [cell({ schema: "empty_a" }), cell({ schema: "app", usage: true }), cell({ schema: "empty_b", inheritedOnly: true })],
      }),
    );
    setup("alice");
    await openTab("권한");
    const rows = within(within(section("orders")).getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => cellTexts(r)[0])).toEqual(["app"]);
  });

  test("a database where every cell is empty says the role holds no privileges", async () => {
    m.role.mockResolvedValue(withLoaded(sampleRoleView("alice"), "orders", { cells: [cell({ schema: "empty_a" }), cell({ schema: "empty_b" })] }));
    setup("alice");
    await openTab("권한");
    expect(within(section("orders")).getByText("이 데이터베이스에서 받은 권한이 없어요")).toBeInTheDocument();
    expect(within(section("orders")).queryByRole("table")).not.toBeInTheDocument();
  });

  test("a schema the role holds privileges on but cannot use says why, with the exact words, under its name", async () => {
    setup("bob");
    await openTab("권한");
    const row = within(within(section("orders")).getByRole("table")).getAllByRole("row")[1];
    const warning = within(row).getByText("⚠ 권한은 있지만 실제로는 못 써요 (CONNECT 없음)");
    expect(warning).toHaveClass("pg-warn");
    expect(within(row).getAllByRole("cell")[0]).toContainElement(warning);
    expect(within(row).getAllByRole("cell")[0]).toHaveTextContent(/^app⚠/);
    expect(cellTexts(row).slice(1)).toEqual(["없음", "없음", "일부 테이블", "없음", "직접 받음·소유"]);
  });

  test("a USAGE-less schema gives its own reason", async () => {
    m.role.mockResolvedValue(withLoaded(sampleRoleView("alice"), "orders", { cells: [cell({ create: true, unusable: "USAGE 없음" })] }));
    setup("alice");
    await openTab("권한");
    expect(within(section("orders")).getByText("⚠ 권한은 있지만 실제로는 못 써요 (USAGE 없음)")).toBeInTheDocument();
  });

  test("a schema that is both unusable and inherited-only shows both", async () => {
    m.role.mockResolvedValue(withLoaded(sampleRoleView("alice"), "orders", { cells: [cell({ read: "all", inheritedOnly: true, unusable: "CONNECT 없음" })] }));
    setup("alice");
    await openTab("권한");
    const row = within(section("orders")).getAllByRole("row")[1];
    expect(within(row).getByText("⚠ 권한은 있지만 실제로는 못 써요 (CONNECT 없음)")).toBeInTheDocument();
    expect(cellTexts(row).slice(-1)).toEqual(["그룹·PUBLIC으로만 받음"]);
  });

  test("a schema that can be used has no warning", async () => {
    setup("alice");
    await openTab("권한");
    expect(screen.queryByText(/권한은 있지만 실제로는 못 써요/)).not.toBeInTheDocument();
  });

  test("says so when a read database holds no privileges for the role", async () => {
    setup("rds_iam");
    await openTab("권한");
    expect(within(section("orders")).getByText("이 데이터베이스에서 받은 권한이 없어요")).toBeInTheDocument();
    expect(within(section("orders")).queryByRole("table")).not.toBeInTheDocument();
  });

  test("names the roles whose privileges are left out because they need SET ROLE", async () => {
    setup("bob");
    await openTab("권한");
    expect(screen.getByText("SET ROLE을 해야 쓸 수 있는 역할의 권한은 아래에 넣지 않았어요: app_read")).toBeInTheDocument();
  });

  test("lists more than one such role", async () => {
    m.role.mockResolvedValue(sampleRoleView("bob", { setRoleOnly: ["app_read", "base_ro"] }));
    setup("bob");
    await openTab("권한");
    expect(screen.getByText("SET ROLE을 해야 쓸 수 있는 역할의 권한은 아래에 넣지 않았어요: app_read, base_ro")).toBeInTheDocument();
  });

  test("has no such note for a role that inherits everything", async () => {
    setup("alice");
    await openTab("권한");
    expect(screen.queryByText(/SET ROLE을 해야/)).not.toBeInTheDocument();
  });

  test("says so when no database can be connected to", async () => {
    m.role.mockResolvedValue(sampleRoleView("alice", { databases: [] }));
    setup("alice");
    await openTab("권한");
    expect(screen.getByText("연결할 수 있는 데이터베이스가 없어요")).toBeInTheDocument();
  });

  describe("불러오기", () => {
    test("reads that database, then reads the role again, and shows the result", async () => {
      fakeBackend();
      setup("alice");
      await openTab("권한");
      expect(m.role).toHaveBeenCalledTimes(1);
      fireEvent.click(within(section("analytics")).getByRole("button", { name: "불러오기" }));
      expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", false);
      const table = await within(section("analytics")).findByRole("table", { name: "analytics 권한" });
      expect(m.role).toHaveBeenCalledTimes(2);
      expect(m.role).toHaveBeenLastCalledWith(pgTarget, "alice");
      expect(within(table).getAllByRole("row")[1]).toHaveTextContent("reports");
      expect(within(section("analytics")).queryByRole("button", { name: "불러오기" })).not.toBeInTheDocument();
    });

    test("reads only the database that was asked for, and the role only after it", async () => {
      fakeBackend();
      const order: string[] = [];
      let finishAnalytics!: () => void;
      const readDatabase = m.database.getMockImplementation()!;
      m.database.mockImplementation(async (...args) => {
        order.push(`database ${args[1]}`);
        if (args[1] === "analytics") await new Promise<void>((r) => (finishAnalytics = r));
        return readDatabase(...args);
      });
      const readRole = m.role.getMockImplementation()!;
      m.role.mockImplementation(async (...args) => {
        order.push("role");
        return readRole(...args);
      });
      setup("alice");
      await openTab("권한");
      fireEvent.click(within(section("analytics")).getByRole("button", { name: "불러오기" }));
      await waitFor(() => expect(readsOf("analytics")).toHaveLength(1));
      expect(within(section("analytics")).getByText("불러오는 중…")).toBeInTheDocument();
      expect(within(section("postgres")).getByRole("button", { name: "불러오기" })).toBeInTheDocument();
      expect(readsOf("postgres")).toHaveLength(0); // 누르지 않은 데이터베이스는 읽지 않는다
      expect(order.filter((o) => o === "role")).toHaveLength(1); // 읽는 동안 역할은 다시 읽지 않는다
      await act(async () => finishAnalytics());
      await within(section("analytics")).findByRole("table");
      expect(order.filter((o) => o === "role")).toHaveLength(2);
      expect(order.indexOf("database analytics")).toBeLessThan(order.lastIndexOf("role"));
    });

    test("a database that was already read elsewhere is not read again, only the role", async () => {
      const { qc } = setup("alice");
      qc.setQueryData(pgKeys.database(pgTarget, "analytics"), sampleDatabaseView({ database: "analytics" }));
      await openTab("권한");
      // 백엔드는 이미 읽은 데이터베이스로 답한다
      m.role.mockImplementation(async (_t, role) => withLoaded(sampleRoleView(role), "analytics", { cells: [cell({ schema: "reports", usage: true })] }));
      fireEvent.click(within(section("analytics")).getByRole("button", { name: "불러오기" }));
      await within(section("analytics")).findByRole("table");
      expect(readsOf("analytics")).toHaveLength(0);
      expect(m.role).toHaveBeenCalledTimes(2);
    });

    test("the role is read again once, not once per render", async () => {
      fakeBackend();
      setup("alice");
      await openTab("권한");
      fireEvent.click(within(section("analytics")).getByRole("button", { name: "불러오기" }));
      await within(section("analytics")).findByRole("table");
      await act(async () => {});
      expect(m.role).toHaveBeenCalledTimes(2);
    });

    test("the role is read again once also in React's strict mode, which runs effects twice", async () => {
      const { qc } = renderWithClient(
        <StrictMode>
          <RoleDetail target={pgTarget} role="alice" onOpen={vi.fn()} />
        </StrictMode>,
      );
      qc.setQueryData(pgKeys.database(pgTarget, "analytics"), sampleDatabaseView({ database: "analytics" }));
      await openTab("권한");
      m.role.mockClear();
      m.role.mockImplementation(async (_t, role) => withLoaded(sampleRoleView(role), "analytics", { cells: [cell({ schema: "reports", usage: true })] }));
      fireEvent.click(within(section("analytics")).getByRole("button", { name: "불러오기" }));
      await within(section("analytics")).findByRole("table");
      await act(async () => {});
      expect(m.role).toHaveBeenCalledTimes(1);
    });

    test("when the database cannot be read, says why, and 다시 시도 reads it again", async () => {
      const failure = { kind: "other", message: 'analytics에 연결하지 못했어요: permission denied for database "analytics"' };
      failFirstReadOf("analytics", failure);
      setup("alice");
      await openTab("권한");
      fireEvent.click(within(section("analytics")).getByRole("button", { name: "불러오기" }));
      expect(await within(section("analytics")).findByText(failure.message)).toBeInTheDocument();
      expect(m.role).toHaveBeenCalledTimes(1); // 읽지 못했으니 역할을 다시 읽을 까닭이 없다
      fireEvent.click(within(section("analytics")).getByRole("button", { name: "다시 시도" }));
      await waitFor(() => expect(readsOf("analytics")).toHaveLength(2));
      expect(readsOf("analytics")[1]).toEqual([pgTarget, "analytics", false]); // 처음 읽기가 실패했으니 새로 읽을 사본이 없다
    });

    test("the other databases keep their own button while one has failed", async () => {
      failFirstReadOf("analytics", { kind: "other", message: "못 읽었어요" });
      setup("alice");
      await openTab("권한");
      fireEvent.click(within(section("analytics")).getByRole("button", { name: "불러오기" }));
      await within(section("analytics")).findByText("못 읽었어요");
      expect(within(section("postgres")).getByRole("button", { name: "불러오기" })).toBeEnabled();
    });

    test("a database read in this tab is read in the 소유 객체 tab too", async () => {
      const owned: PgObjectRef[] = [{ kind: "table", schema: "reports", name: "daily", signature: null }];
      m.role.mockImplementation(async (_t, role) => {
        const base = sampleRoleView(role);
        return m.database.mock.calls.some((c) => c[1] === "analytics") ? withLoaded(base, "analytics", { owned }) : base;
      });
      setup("alice");
      await openTab("권한");
      fireEvent.click(within(section("analytics")).getByRole("button", { name: "불러오기" }));
      await within(section("analytics")).findByText("이 데이터베이스에서 받은 권한이 없어요");
      await openTab("소유 객체");
      expect(within(section("analytics")).getByText("reports.daily")).toBeInTheDocument();
    });
  });
});

describe("a refresh while the detail is open", () => {
  test("a database that was loaded here is read again with force, and the role is read only after that, so the new cells show", async () => {
    const backend = fakeBackend();
    const { qc } = setup("alice");
    await openTab("권한");
    fireEvent.click(within(section("analytics")).getByRole("button", { name: "불러오기" }));
    await within(section("analytics")).findByText("reports1");
    await openTab("개요"); // 다시 읽는 일은 어느 하위 탭이 보이는지와 상관없다

    // 새로 고침: pg_open이 데이터베이스 스냅숏을 비웠고, 다시 읽으면 내용이 달라져 있다
    backend.forget();
    backend.next();
    let finishAnalytics!: () => void;
    const readDatabase = m.database.getMockImplementation()!;
    m.database.mockImplementation(async (...args) => {
      if (args[1] === "analytics" && args[2]) await new Promise<void>((r) => (finishAnalytics = r));
      return readDatabase(...args);
    });
    const rolesBefore = m.role.mock.calls.length;
    let refreshed!: Promise<void>;
    await act(async () => {
      refreshed = refreshPg(qc, pgTarget);
    });
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", true));
    expect(m.role).toHaveBeenCalledTimes(rolesBefore); // 데이터베이스를 다 읽기 전에는 역할을 읽지 않는다
    await act(async () => {
      finishAnalytics();
      await refreshed;
    });
    expect(m.role).toHaveBeenCalledTimes(rolesBefore + 1);
    await openTab("권한");
    expect(await within(section("analytics")).findByText("reports2")).toBeInTheDocument();
    expect(within(section("analytics")).queryByRole("button", { name: "불러오기" })).not.toBeInTheDocument();
  });

  test("only the databases the user loaded in this detail are read again; the others are back to 아직 읽지 않았어요, as the backend holds nothing after pg_open", async () => {
    const backend = fakeBackend();
    const { qc } = setup("alice");
    await openTab("권한");
    await within(section("orders")).findByRole("table"); // 역할이 읽은 것으로 답한 데이터베이스는 역할의 칸으로 보인다
    expect(m.database).not.toHaveBeenCalled(); // 열기만 해서는 데이터베이스 보기를 읽지 않는다
    fireEvent.click(within(section("analytics")).getByRole("button", { name: "불러오기" }));
    await within(section("analytics")).findByText("reports1");
    expect(m.database).toHaveBeenCalledTimes(1);

    backend.forget(); // pg_open
    backend.next();
    await act(async () => {
      await refreshPg(qc, pgTarget);
    });
    // 여기서 불러온 analytics만 force로 다시 읽고, 역할은 그 뒤에 읽는다
    expect(readsOf("analytics")).toHaveLength(2);
    expect(readsOf("analytics")[1]).toEqual([pgTarget, "analytics", true]);
    const roleCalls = m.role.mock.invocationCallOrder;
    expect(roleCalls[roleCalls.length - 1]).toBeGreaterThan(m.database.mock.invocationCallOrder[1]);
    expect(await within(section("analytics")).findByText("reports2")).toBeInTheDocument();
    // 불러오지 않은 데이터베이스는 읽지 않았다
    expect(readsOf("orders")).toHaveLength(0);
    expect(readsOf("postgres")).toHaveLength(0);
    expect(within(section("orders")).getByText("아직 읽지 않았어요")).toBeInTheDocument();
    expect(within(section("orders")).getByRole("button", { name: "불러오기" })).toBeInTheDocument();
  });

  test("a forced re-read that fails for a database loaded here shows its error in the section, not a silent 불러오기", async () => {
    const backend = fakeBackend();
    const { qc } = setup("alice");
    await openTab("권한");
    fireEvent.click(within(section("analytics")).getByRole("button", { name: "불러오기" }));
    await within(section("analytics")).findByText("reports1");

    backend.forget();
    const failure = { kind: "other", message: "analytics에 연결하지 못했어요: too many connections" };
    const readDatabase = m.database.getMockImplementation()!;
    m.database.mockImplementation(async (...args) => {
      if (args[1] === "analytics" && args[2]) throw failure;
      return readDatabase(...args);
    });
    await act(async () => {
      await refreshPg(qc, pgTarget);
    });
    // 역할은 analytics를 읽지 않은 것으로 답하지만, 여기서 불러온 데이터베이스라 읽지 못한 까닭이 보인다
    expect(await within(section("analytics")).findByText(failure.message)).toBeInTheDocument();
    expect(within(section("analytics")).queryByRole("button", { name: "불러오기" })).not.toBeInTheDocument();

    m.database.mockImplementation(readDatabase);
    fireEvent.click(within(section("analytics")).getByRole("button", { name: "다시 시도" }));
    expect(await within(section("analytics")).findByText("reports1")).toBeInTheDocument();
  });

  test("a copy of the database that went out of date is not taken for a finished read: the role waits for the new one", async () => {
    fakeBackend();
    const { qc } = setup("alice");
    await openTab("권한");
    // 앞서 읽어 둔 사본이 있지만 새로 고침으로 낡았고, 그 사이 백엔드는 스냅숏을 비웠다
    qc.setQueryData(pgKeys.database(pgTarget, "analytics"), sampleDatabaseView({ database: "analytics" }));
    await act(async () => {
      await qc.invalidateQueries({ queryKey: pgKeys.database(pgTarget, "analytics") });
    });
    let finish!: () => void;
    const readDatabase = m.database.getMockImplementation()!;
    m.database.mockImplementation(async (...args) => {
      if (args[1] === "analytics") await new Promise<void>((r) => (finish = r));
      return readDatabase(...args);
    });
    const rolesBefore = m.role.mock.calls.length;
    fireEvent.click(within(section("analytics")).getByRole("button", { name: "불러오기" }));
    await waitFor(() => expect(readsOf("analytics")).toHaveLength(1));
    await act(async () => {});
    expect(m.role).toHaveBeenCalledTimes(rolesBefore); // 사본이 있어도 새로 읽는 중이니 기다린다
    expect(within(section("analytics")).getByText("불러오는 중…")).toBeInTheDocument();
    await act(async () => finish());
    expect(await within(section("analytics")).findByText("reports1")).toBeInTheDocument();
    await act(async () => {});
    expect(m.role).toHaveBeenCalledTimes(rolesBefore + 1); // 다 읽은 뒤에 한 번
  });

  test("when the role still says unloaded after a read, the next finished read of that database asks for the role again", async () => {
    const backend = fakeBackend();
    backend.remember(false); // 읽어도 기억하지 못하는 백엔드(읽자마자 스냅숏이 비워지는 경우)
    const { qc } = setup("alice");
    await openTab("권한");
    fireEvent.click(within(section("analytics")).getByRole("button", { name: "불러오기" }));
    await waitFor(() => expect(readsOf("analytics")).toHaveLength(1));
    await act(async () => {});
    expect(within(section("analytics")).getByText("불러오는 중…")).toBeInTheDocument(); // 읽었지만 역할은 아직 읽지 않은 것으로 답한다
    const rolesBefore = m.role.mock.calls.length;
    backend.remember(true);
    await act(async () => {
      await qc.invalidateQueries({ queryKey: pgKeys.database(pgTarget, "analytics") });
    });
    expect(await within(section("analytics")).findByText("reports1")).toBeInTheDocument();
    expect(m.role).toHaveBeenCalledTimes(rolesBefore + 1);
  });

  test("다시 시도 after a failed load reads the database again, and the role after that", async () => {
    fakeBackend();
    failFirstReadOf("analytics", { kind: "other", message: "못 읽었어요" });
    setup("alice");
    await openTab("권한");
    fireEvent.click(within(section("analytics")).getByRole("button", { name: "불러오기" }));
    await within(section("analytics")).findByText("못 읽었어요");
    const rolesBefore = m.role.mock.calls.length;
    fireEvent.click(within(section("analytics")).getByRole("button", { name: "다시 시도" }));
    expect(await within(section("analytics")).findByRole("table")).toBeInTheDocument();
    expect(readsOf("analytics").slice(-1)[0]).toEqual([pgTarget, "analytics", false]);
    expect(m.role.mock.calls.length).toBeGreaterThan(rolesBefore);
  });
});

describe("소유 객체", () => {
  const rows = (database: string) =>
    within(within(section(database)).getByRole("table", { name: `${database} 소유 객체` }))
      .getAllByRole("row")
      .slice(1)
      .map(cellTexts);

  test("lists what the role owns with its kind", async () => {
    setup("app_owner");
    await openTab("소유 객체");
    expect(rows("orders")).toEqual([
      ["스키마", "app"],
      ["스키마", "audit"],
      ["테이블", "app.customers"],
      ["테이블", "app.order_items"],
      ["테이블", "app.orders"],
      ["테이블", "audit.events"],
      ["시퀀스", "app.orders_id_seq"],
      ["함수", "app.touch_order(order_id integer)"],
    ]);
  });

  test("starts with a count per kind: schemas, tables (views included), sequences and functions", async () => {
    setup("app_owner");
    await openTab("소유 객체");
    expect(within(section("orders")).getByText("스키마 2 · 테이블(뷰 포함) 4 · 시퀀스 1 · 함수 1")).toBeInTheDocument();
    expect(within(section("orders")).queryByText(/세지 않았어요|센 수예요/)).not.toBeInTheDocument();
  });

  test("views, materialized views, partitioned tables and foreign tables count as tables", async () => {
    const owned: PgObjectRef[] = (["table", "view", "matview", "partitioned", "foreign"] as const).map((kind, i) => ({ kind, schema: "app", name: `o${i}`, signature: null }));
    m.role.mockResolvedValue(withLoaded(sampleRoleView("app_owner"), "orders", { owned }));
    setup("app_owner");
    await openTab("소유 객체");
    expect(within(section("orders")).getByText("스키마 0 · 테이블(뷰 포함) 5 · 시퀀스 0 · 함수 0")).toBeInTheDocument();
  });

  test("a kind the role owns none of is counted as 0, and a function counts as a function", async () => {
    const owned: PgObjectRef[] = [{ kind: "function", schema: "app", name: "touch", signature: "id integer" }];
    m.role.mockResolvedValue(withLoaded(sampleRoleView("app_owner"), "orders", { owned }));
    setup("app_owner");
    await openTab("소유 객체");
    expect(within(section("orders")).getByText("스키마 0 · 테이블(뷰 포함) 0 · 시퀀스 0 · 함수 1")).toBeInTheDocument();
  });

  test("when objects were left out the counts say they cover only the list", async () => {
    const owned: PgObjectRef[] = [{ kind: "table", schema: "app", name: "orders", signature: null }];
    m.role.mockResolvedValue(withLoaded(sampleRoleView("app_owner"), "orders", { owned, ownedOmitted: 37 }));
    setup("app_owner");
    await openTab("소유 객체");
    expect(within(section("orders")).getByText("스키마 0 · 테이블(뷰 포함) 1 · 시퀀스 0 · 함수 0")).toBeInTheDocument();
    expect(within(section("orders")).getByText("(목록에 있는 객체만 센 수예요)")).toBeInTheDocument();
    expect(within(section("orders")).getByText("외 37개")).toBeInTheDocument();
  });

  test("a database that was not read has no counts, and neither has one where the role owns nothing", async () => {
    setup("alice");
    await openTab("소유 객체");
    expect(screen.queryByText(/^스키마 \d+ ·/)).not.toBeInTheDocument();
  });

  test("objects the list leaves out are counted as 외 N개", async () => {
    const owned: PgObjectRef[] = [{ kind: "table", schema: "app", name: "orders", signature: null }];
    m.role.mockResolvedValue(withLoaded(sampleRoleView("app_owner"), "orders", { owned, ownedOmitted: 37 }));
    setup("app_owner");
    await openTab("소유 객체");
    expect(rows("orders")).toEqual([["테이블", "app.orders"]]);
    expect(within(section("orders")).getByText("외 37개")).toBeInTheDocument();
  });

  test("no 외 N개 when nothing was left out", async () => {
    setup("app_owner");
    await openTab("소유 객체");
    expect(screen.queryByText(/^외 \d+개$/)).not.toBeInTheDocument();
  });

  test("says so when the role owns nothing in a read database", async () => {
    setup("alice");
    await openTab("소유 객체");
    expect(within(section("orders")).getByText("소유한 객체가 없어요")).toBeInTheDocument();
    expect(within(section("orders")).queryByRole("table")).not.toBeInTheDocument();
  });

  test("a database that was not read has the same 불러오기", async () => {
    setup("app_owner");
    await openTab("소유 객체");
    expect(within(section("analytics")).getByText("아직 읽지 않았어요")).toBeInTheDocument();
    fireEvent.click(within(section("analytics")).getByRole("button", { name: "불러오기" }));
    expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", false);
  });
});

describe("세션", () => {
  test("lists the sessions of the role with where they come from and what they are doing", async () => {
    setup("alice");
    await openTab("세션");
    const table = screen.getByRole("table", { name: "세션 목록" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["데이터베이스", "클라이언트", "application_name", "상태", "시작", "대기"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(cellTexts(rows[0])).toEqual(["orders", "172.16.4.33", "DBeaver 24.1.0 - Main <orders>", "active", formatDateTime("2026-10-28T11:42:10Z"), "—"]);
  });

  test("marks the sessions of this app", async () => {
    setup("iam_admin");
    await openTab("세션");
    const rows = within(screen.getByRole("table", { name: "세션 목록" })).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(within(row).getByText("이 앱")).toBeInTheDocument();
    expect(cellTexts(rows[0])[2]).toBe("magic-mirror이 앱");
  });

  test("does not mark the sessions of other applications", async () => {
    setup("alice");
    await openTab("세션");
    expect(screen.queryByText("이 앱")).not.toBeInTheDocument();
  });

  test("a session without a database, a client, a state or an application name shows a dash", async () => {
    m.role.mockResolvedValue(
      sampleRoleView("alice", {
        sessions: [{ pid: 7, role: "alice", database: null, clientAddr: null, applicationName: "", state: null, backendStart: null, queryStart: null, waitEvent: "ClientRead", own: false }],
      }),
    );
    setup("alice");
    await openTab("세션");
    const row = within(screen.getByRole("table", { name: "세션 목록" })).getAllByRole("row")[1];
    expect(cellTexts(row)).toEqual(["—", "—", "—", "—", "—", "ClientRead"]);
  });

  test("says so when the role has no session", async () => {
    setup("app_read");
    await openTab("세션");
    expect(screen.getByText("이 역할의 세션이 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "세션 목록" })).not.toBeInTheDocument();
  });
});
