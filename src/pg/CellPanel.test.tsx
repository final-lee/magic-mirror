import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import { CellPanel } from "./CellPanel";
import { object, ordersTable, pgTarget, privilege, sampleCellDetail, source } from "./fixtures";
import type { PgCellDetail, PgCellObject, PgObjectRef, PgPrivilegeGrant } from "./types";

vi.mock("./api", () => ({ pgApi: { cell: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(pgApi);

type Props = React.ComponentProps<typeof CellPanel>;
const baseProps: Props = { target: pgTarget, database: "orders", role: "alice", schema: "app", unusable: null, bypassRls: false, onClose: () => {} };

function setup(extra: Partial<Props> = {}) {
  const onClose = vi.fn();
  const props = { ...baseProps, onClose, ...extra };
  const utils = renderWithClient(<CellPanel {...props} />);
  const update = (next: Partial<Props>) =>
    utils.rerender(
      <QueryClientProvider client={utils.qc as QueryClient}>
        <CellPanel {...props} {...next} />
      </QueryClientProvider>,
    );
  return { onClose, update, ...utils };
}

const panel = () => screen.getByRole("complementary", { name: "alice · app" });
/** 이름이 맞는 객체 줄 */
const item = (name: string) => screen.getByText(name).closest("li") as HTMLElement;
/** 줄의 권한 칩들 */
const chips = (name: string) => within(item(name)).getAllByTestId("privilege");
const chip = (name: string, privilegeName: string) => chips(name).find((c) => c.textContent === privilegeName)!;
/** 탭의 이름에는 그 탭의 객체 수가 붙어 있다("테이블 3") */
const tab = (label: string) => screen.getByRole("tab", { name: new RegExp(`^${label} \\d+$`) });

const entry = (ref: PgObjectRef, privileges: PgPrivilegeGrant[], extra: Partial<PgCellObject> = {}): PgCellObject => ({
  object: ref,
  owner: "app_owner",
  rls: false,
  privileges,
  ...extra,
});
const detail = (objects: PgCellObject[], extra: Partial<PgCellDetail> = {}): PgCellDetail => ({ role: "alice", schema: "app", objects, truncated: false, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  m.cell.mockResolvedValue(sampleCellDetail());
});

describe("loading", () => {
  test("asks the backend for this cell of this database, and says so until the answer comes", async () => {
    let resolve!: (v: PgCellDetail) => void;
    m.cell.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    expect(m.cell).toHaveBeenCalledTimes(1);
    expect(m.cell).toHaveBeenCalledWith(pgTarget, "orders", "alice", "app");
    expect(within(panel()).getByText("불러오는 중…")).toBeInTheDocument();
    await act(async () => resolve(sampleCellDetail()));
    expect(await screen.findByText("app.customers")).toBeInTheDocument();
    expect(screen.queryByText("불러오는 중…")).not.toBeInTheDocument();
  });

  test("shows why it failed through the error box, and 다시 시도 is there", async () => {
    m.cell.mockRejectedValue({ kind: "other", message: "먼저 연결해 주세요" });
    setup();
    expect(await screen.findByText("먼저 연결해 주세요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });

  test("the title names the role and the schema even before the answer", () => {
    m.cell.mockReturnValue(new Promise(() => {}));
    setup({ role: "bob", schema: "audit" });
    expect(screen.getByRole("heading", { name: "bob · audit" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "bob · audit" })).toBeInTheDocument();
  });
});

describe("the objects", () => {
  test("tables come first, each with the privileges the role has on it", async () => {
    setup();
    await screen.findByText("app.customers");
    expect(tab("테이블")).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByRole("tabpanel")).getAllByRole("listitem").map((li) => li.querySelector(".pg-obj-name")?.textContent)).toEqual([
      "app.customers",
      "app.order_items",
      "app.orders",
    ]);
    expect(chips("app.customers").map((c) => c.textContent)).toEqual(["SELECT"]);
    expect(chips("app.order_items").map((c) => c.textContent)).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
    expect(chips("app.orders").map((c) => c.textContent)).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
  });

  test("views, materialized views, partitioned and foreign tables are tables too, and say what they are", async () => {
    m.cell.mockResolvedValue(
      detail([
        entry(ordersTable, [privilege("SELECT", source("direct"))]),
        entry(object("view", "app", "order_totals"), [privilege("SELECT", source("direct"))]),
        entry(object("matview", "app", "daily_sales"), [privilege("SELECT", source("direct"))]),
        entry(object("partitioned", "app", "events"), [privilege("SELECT", source("direct"))]),
        entry(object("foreign", "app", "remote_orders"), [privilege("SELECT", source("direct"))]),
      ]),
    );
    setup();
    await screen.findByText("app.orders");
    expect(tab("테이블")).toHaveTextContent("5");
    expect(within(item("app.order_totals")).getByText("뷰")).toBeInTheDocument();
    expect(within(item("app.daily_sales")).getByText("구체화 뷰")).toBeInTheDocument();
    expect(within(item("app.events")).getByText("파티션 테이블")).toBeInTheDocument();
    expect(within(item("app.remote_orders")).getByText("외부 테이블")).toBeInTheDocument();
    // 보통 테이블은 종류를 따로 적지 않는다
    expect(within(item("app.orders")).queryByText("테이블")).not.toBeInTheDocument();
  });

  test("sequences and functions are in tabs of the same panel, with how many each has", async () => {
    setup();
    await screen.findByText("app.customers");
    expect(tab("테이블")).toHaveTextContent("3");
    expect(tab("시퀀스")).toHaveTextContent("1");
    expect(tab("함수")).toHaveTextContent("1");
    expect(screen.queryByText("app.orders_id_seq")).not.toBeInTheDocument();

    fireEvent.click(tab("시퀀스"));
    expect(tab("시퀀스")).toHaveAttribute("aria-selected", "true");
    expect(tab("테이블")).toHaveAttribute("aria-selected", "false");
    expect(chips("app.orders_id_seq").map((c) => c.textContent)).toEqual(["USAGE", "SELECT"]);
    expect(screen.queryByText("app.customers")).not.toBeInTheDocument();

    fireEvent.click(tab("함수"));
    expect(chips("app.touch_order(order_id integer)").map((c) => c.textContent)).toEqual(["EXECUTE"]);
    expect(screen.queryByText("app.orders_id_seq")).not.toBeInTheDocument();
  });

  test("a tab with nothing in it says so", async () => {
    m.cell.mockResolvedValue(detail([entry(ordersTable, [privilege("SELECT", source("direct"))])]));
    setup();
    await screen.findByText("app.orders");
    fireEvent.click(tab("시퀀스"));
    expect(screen.getByText("시퀀스 권한이 없어요")).toBeInTheDocument();
    fireEvent.click(tab("함수"));
    expect(screen.getByText("함수 권한이 없어요")).toBeInTheDocument();
    fireEvent.click(tab("테이블"));
    expect(screen.getByText("app.orders")).toBeInTheDocument();
  });

  test("a cell without any object privilege says so, and still has its tabs", async () => {
    m.cell.mockResolvedValue(detail([]));
    setup();
    expect(await screen.findByText("받은 객체 권한이 없어요")).toBeInTheDocument();
    expect(tab("테이블")).toHaveTextContent("0");
  });

  test("the tab that was open stays open when the panel moves on to another cell", async () => {
    const { update } = setup();
    await screen.findByText("app.customers");
    fireEvent.click(tab("시퀀스"));
    m.cell.mockResolvedValue(detail([entry(ordersTable, [privilege("SELECT", source("direct"))])], { role: "bob" }));
    update({ role: "bob" });
    expect(await screen.findByText("시퀀스 권한이 없어요")).toBeInTheDocument();
    expect(tab("시퀀스")).toHaveAttribute("aria-selected", "true");
  });
});

describe("where a privilege comes from", () => {
  const sources = (): PgCellDetail =>
    detail([
      entry(ordersTable, [
        privilege("SELECT", source("direct", [], "app_owner")),
        privilege("INSERT", source("owner")),
        privilege("UPDATE", source("group", ["app_write", "app_read"], "app_owner")),
        privilege("DELETE", source("public")),
        privilege("TRUNCATE", source("predefined", ["pg_write_all_data"])),
        privilege("REFERENCES", source("superuser")),
      ]),
    ]);

  test("every chip says so in its title", async () => {
    m.cell.mockResolvedValue(sources());
    setup();
    await screen.findByText("app.orders");
    const titles = Object.fromEntries(chips("app.orders").map((c) => [c.textContent, c.getAttribute("title")]));
    expect(titles).toEqual({
      SELECT: "직접 받음",
      INSERT: "소유자",
      UPDATE: "app_write ← app_read 그룹에서 받음",
      DELETE: "모든 역할(PUBLIC)",
      TRUNCATE: "pg_write_all_data",
      REFERENCES: "superuser",
    });
  });

  test("a role that inherits the owner role is told so, with the way to the owner role; the owner itself is just 소유자", async () => {
    m.cell.mockResolvedValue(
      detail([
        entry(ordersTable, [
          privilege("SELECT", source("owner")),
          privilege("INSERT", source("owner", ["app_owner"], "app_owner")),
          privilege("UPDATE", source("owner", ["app_team", "app_owner"], "app_owner")),
        ]),
      ]),
    );
    setup();
    await screen.findByText("app.orders");
    const titles = Object.fromEntries(chips("app.orders").map((c) => [c.textContent, c.getAttribute("title")]));
    expect(titles).toEqual({
      SELECT: "소유자",
      INSERT: "소유자 역할(app_owner)을 물려받음",
      UPDATE: "소유자 역할(app_team ← app_owner)을 물려받음",
    });
  });

  test("a privilege that comes from the pg_read_all_data role names it", async () => {
    m.cell.mockResolvedValue(detail([entry(ordersTable, [privilege("SELECT", source("predefined", ["pg_read_all_data"]))])]));
    setup({ role: "iam_admin" });
    await screen.findByText("app.orders");
    expect(chip("app.orders", "SELECT")).toHaveAttribute("title", "pg_read_all_data");
  });

  test("the predefined role's own cell has no way in, so the role itself is the source", async () => {
    m.cell.mockResolvedValue(detail([entry(ordersTable, [privilege("SELECT", source("predefined"))])], { role: "pg_read_all_data" }));
    setup({ role: "pg_read_all_data" });
    await screen.findByText("app.orders");
    expect(chip("app.orders", "SELECT")).toHaveAttribute("title", "pg_read_all_data");
  });

  test("a privilege that comes in more than one way lists them all", async () => {
    m.cell.mockResolvedValue(
      detail([entry(ordersTable, [privilege("SELECT", source("direct"), source("group", ["app_write"]), source("public"))])]),
    );
    setup();
    await screen.findByText("app.orders");
    expect(chip("app.orders", "SELECT")).toHaveAttribute("title", "직접 받음, app_write 그룹에서 받음, 모든 역할(PUBLIC)");
  });

  test("the sample cell explains the groups on the tables, the direct grant on the sequence and PUBLIC on the function", async () => {
    setup();
    await screen.findByText("app.customers");
    expect(chip("app.orders", "INSERT")).toHaveAttribute("title", "app_write 그룹에서 받음");
    expect(chip("app.orders", "SELECT")).toHaveAttribute("title", "app_write ← app_read 그룹에서 받음");
    fireEvent.click(tab("시퀀스"));
    expect(chip("app.orders_id_seq", "USAGE")).toHaveAttribute("title", "직접 받음");
    fireEvent.click(tab("함수"));
    expect(chip("app.touch_order(order_id integer)", "EXECUTE")).toHaveAttribute("title", "모든 역할(PUBLIC)");
  });
});

describe("row level security", () => {
  test("a table with it on says so, and one without says nothing", async () => {
    setup();
    await screen.findByText("app.customers");
    expect(within(item("app.customers")).getByText("행 수준 보안 켜짐")).toBeInTheDocument();
    expect(within(item("app.orders")).queryByText(/행 수준 보안/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/행 수준 보안/)).toHaveLength(1);
  });

  test("for a role with BYPASSRLS it says that it does not apply", async () => {
    setup({ bypassRls: true });
    await screen.findByText("app.customers");
    expect(within(item("app.customers")).getByText("행 수준 보안 켜짐 · BYPASSRLS라 적용되지 않아요")).toBeInTheDocument();
    expect(screen.queryByText("행 수준 보안 켜짐")).not.toBeInTheDocument();
    expect(screen.getAllByText(/행 수준 보안/)).toHaveLength(1);
  });
});

describe("a failed read", () => {
  test("after the detail was shown keeps it on screen with the error above", async () => {
    const { qc } = setup();
    await screen.findByText("app.customers");
    m.cell.mockRejectedValueOnce({ kind: "network", message: "끊겼어요" });
    await act(async () => {
      await qc.invalidateQueries();
    });
    expect(await screen.findByText("네트워크 오류: 끊겼어요")).toBeInTheDocument();
    expect(screen.getByText("app.customers")).toBeInTheDocument();
    expect(tab("테이블")).toHaveAttribute("aria-selected", "true");
  });
});

describe("notes", () => {
  test("a detail that was cut short says so", async () => {
    m.cell.mockResolvedValue(sampleCellDetail({ truncated: true }));
    setup();
    expect(await screen.findByText("객체가 많아 일부만 읽었어요")).toBeInTheDocument();
  });

  test("a complete detail does not", async () => {
    setup();
    await screen.findByText("app.customers");
    expect(screen.queryByText("객체가 많아 일부만 읽었어요")).not.toBeInTheDocument();
  });

  test("a cell the role cannot really use says why, with the ⚠, before the answer comes and after", async () => {
    m.cell.mockReturnValue(new Promise(() => {}));
    setup({ unusable: "CONNECT 없음" });
    const warning = screen.getByText("권한은 있지만 실제로는 못 써요 (CONNECT 없음)");
    expect(warning.closest("[role=note]")).toHaveTextContent("⚠");
  });

  test("the reason is the one of the cell: no USAGE on the schema", async () => {
    setup({ unusable: "USAGE 없음" });
    expect(await screen.findByText("권한은 있지만 실제로는 못 써요 (USAGE 없음)")).toBeInTheDocument();
    expect(screen.queryByText(/CONNECT 없음/)).not.toBeInTheDocument();
  });

  test("a usable cell has no warning", async () => {
    setup();
    await screen.findByText("app.customers");
    expect(screen.queryByText(/실제로는 못 써요/)).not.toBeInTheDocument();
    expect(screen.queryByText(/⚠/)).not.toBeInTheDocument();
  });
});

describe("closing and focus", () => {
  test("[닫기] closes it", async () => {
    const { onClose } = setup();
    await screen.findByText("app.customers");
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Esc closes it from anywhere inside, also while it is still loading", async () => {
    m.cell.mockReturnValue(new Promise(() => {}));
    const { onClose } = setup();
    fireEvent.keyDown(panel(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("button", { name: "닫기" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("other keys do not close it", async () => {
    const { onClose } = setup();
    await screen.findByText("app.customers");
    fireEvent.keyDown(panel(), { key: "Enter" });
    fireEvent.keyDown(panel(), { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("takes the focus when it opens, so the keyboard lands in it", async () => {
    setup();
    expect(panel()).toHaveFocus();
    await screen.findByText("app.customers");
    expect(panel()).toHaveFocus();
  });

  test("takes the focus again when it moves on to another cell", async () => {
    const { update } = setup();
    await screen.findByText("app.customers");
    screen.getByRole("button", { name: "닫기" }).focus();
    expect(panel()).not.toHaveFocus();
    m.cell.mockResolvedValue(sampleCellDetail({ role: "bob" }));
    update({ role: "bob" });
    await waitFor(() => expect(screen.getByRole("complementary", { name: "bob · app" })).toHaveFocus());
  });

  test("a re-read or a new render of the same cell does not pull the focus away from where the user is", async () => {
    const { qc, update } = setup();
    await screen.findByText("app.customers");
    const close = screen.getByRole("button", { name: "닫기" });
    close.focus();
    await act(async () => {
      await qc.invalidateQueries();
    });
    expect(close).toHaveFocus();
    update({}); // 부르는 쪽이 다시 그릴 때(필터를 입력할 때, 스냅숏을 다시 읽을 때 …)
    expect(close).toHaveFocus();
    update({ unusable: "USAGE 없음" }); // 칸은 그대로이고 다른 것만 바뀔 때
    expect(close).toHaveFocus();
  });
});
