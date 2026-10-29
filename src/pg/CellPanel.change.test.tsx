import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import { CellPanel } from "./CellPanel";
import { object, ordersIdSeq, ordersTable, pgTarget, privilege, sampleCellDetail, sampleDatabaseView, sampleOverview, source, touchOrderFn } from "./fixtures";
import type { PgCellDetail, PgChange, PgGrantTarget, PgObjectRef, PgSchemaCell } from "./types";
import { usePgDraft, type PgDraft } from "./usePgDraft";

vi.mock("./api", () => ({ pgApi: { cell: vi.fn(), objects: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(pgApi);
const overview = sampleOverview();

/** alice의 app 칸: 사용은 직접, 만들기는 소유자라서 */
const aliceCell: PgSchemaCell = {
  ...sampleDatabaseView().cells.find((c) => c.role === "alice" && c.schema === "app")!,
  usage: true,
  create: true,
  direct: { usage: true, create: false, read: "none", write: "none" },
  owned: { usage: false, create: true, read: "none", write: "none" },
};

/** 직접 받은 SELECT, PUBLIC으로 받은 EXECUTE, 직접과 PUBLIC 둘 다, 그룹에서 받은 것, 소유자라서 가진 것 */
function detail(): PgCellDetail {
  const entry = (ref: PgObjectRef, privileges: ReturnType<typeof privilege>[]) => ({ object: ref, owner: "app_owner", rls: false, privileges });
  return sampleCellDetail({
    objects: [
      entry(ordersTable, [privilege("SELECT", source("direct", [], "app_owner")), privilege("INSERT", source("group", ["app_write"], "app_owner")), privilege("DELETE", source("owner"))]),
      entry(ordersIdSeq, [privilege("USAGE", source("direct", [], "app_owner"), source("public"))]),
      entry(touchOrderFn, [privilege("EXECUTE", source("public"))]),
    ],
  });
}

let draft!: PgDraft;
type Props = Partial<React.ComponentProps<typeof CellPanel>>;
function Harness(props: Props) {
  const own = usePgDraft(pgTarget, overview);
  draft = own;
  return <CellPanel target={pgTarget} database="orders" role="alice" schema="app" unusable={null} bypassRls={false} draft={own} cell={aliceCell} onClose={() => {}} {...props} />;
}
const setup = (props: Props = {}) => renderWithClient(<Harness {...props} />);

const changes = (): PgChange[] => draft.items.map((d) => d.change);
const objectRow = (name: string) => screen.getByText(name).closest("li") as HTMLElement;
/** 권한 칩과 그 [빼기]들이 든 묶음 */
const privilegeGroup = (name: string, privilegeName: string) =>
  within(objectRow(name))
    .getAllByTestId("privilege-edit")
    .find((g) => within(g).getByTestId("privilege").textContent === privilegeName)!;
const tab = async (label: string) => fireEvent.click(await screen.findByRole("tab", { name: new RegExp(`^${label} \\d+$`) }));

const grantOf = (grantee: string, target: PgGrantTarget, privileges: string[], add = false): PgChange => ({
  kind: "grant",
  database: "orders",
  grantee,
  add,
  items: [{ target, privileges }],
});

beforeEach(() => {
  vi.clearAllMocks();
  m.cell.mockResolvedValue(detail());
  m.objects.mockResolvedValue([ordersTable, ordersIdSeq, touchOrderFn, object("table", "audit", "events"), { kind: "schema", schema: null, name: "app", signature: null }]);
});

describe("바꾸기 mode: held privileges", () => {
  test("a direct privilege has 빼기, which queues a one-object revoke from the cell's role", async () => {
    setup();
    await screen.findByText("app.orders");
    fireEvent.click(within(privilegeGroup("app.orders", "SELECT")).getByRole("button", { name: "빼기" }));
    expect(changes()).toEqual([grantOf("alice", { kind: "relation", schema: "app", name: "orders" }, ["SELECT"])]);
  });

  test("pressing 빼기 again takes the revoke back out", async () => {
    setup();
    await screen.findByText("app.orders");
    const revoke = () => within(privilegeGroup("app.orders", "SELECT")).getByRole("button", { name: "빼기" });
    fireEvent.click(revoke());
    expect(revoke()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(revoke());
    expect(changes()).toEqual([]);
    expect(revoke()).toHaveAttribute("aria-pressed", "false");
  });

  test("a PUBLIC privilege has 'PUBLIC에서 빼기', which queues the same revoke from PUBLIC, not from the role", async () => {
    setup();
    await tab("함수");
    await screen.findByText("app.touch_order(order_id integer)");
    fireEvent.click(within(privilegeGroup("app.touch_order(order_id integer)", "EXECUTE")).getByRole("button", { name: "PUBLIC에서 빼기" }));
    expect(changes()).toEqual([grantOf("PUBLIC", { kind: "function", schema: "app", name: "touch_order", signature: "order_id integer" }, ["EXECUTE"])]);
  });

  test("a privilege held both directly and through PUBLIC offers both revokes", async () => {
    setup();
    await tab("시퀀스");
    await screen.findByText("app.orders_id_seq");
    const group = privilegeGroup("app.orders_id_seq", "USAGE");
    fireEvent.click(within(group).getByRole("button", { name: "PUBLIC에서 빼기" }));
    fireEvent.click(within(group).getByRole("button", { name: "빼기" }));
    expect(changes()).toEqual([
      grantOf("PUBLIC", { kind: "sequence", schema: "app", name: "orders_id_seq" }, ["USAGE"]),
      grantOf("alice", { kind: "sequence", schema: "app", name: "orders_id_seq" }, ["USAGE"]),
    ]);
  });

  test("a privilege that comes from a group or from ownership has only a disabled 빼기", async () => {
    setup();
    await screen.findByText("app.orders");
    const viaGroup = within(privilegeGroup("app.orders", "INSERT")).getByRole("button", { name: "빼기" });
    const viaOwner = within(privilegeGroup("app.orders", "DELETE")).getByRole("button", { name: "빼기" });
    expect(viaGroup).toBeDisabled();
    expect(viaOwner).toBeDisabled();
    expect(viaOwner).toHaveAttribute("title", "소유자라서 가진 권한이에요");
    fireEvent.click(viaGroup);
    expect(changes()).toEqual([]);
  });

  test("outside 바꾸기 mode there are no buttons", async () => {
    setup({ draft: undefined });
    await screen.findByText("app.orders");
    expect(screen.queryByRole("button", { name: /빼기/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "객체에 권한 주기" })).not.toBeInTheDocument();
  });
});

describe("바꾸기 mode: the schema's 사용 and 만들기", () => {
  test("show as chips with their sources; a direct one can be revoked, an owner one cannot", async () => {
    setup();
    await screen.findByText("app.orders");
    const chips = screen.getAllByTestId("schema-privilege");
    expect(chips.map((c) => c.textContent)).toEqual(["사용 직접 받음빼기", "만들기 소유자빼기"]);
    expect(within(chips[1]).getByRole("button", { name: "빼기" })).toBeDisabled();
    fireEvent.click(within(chips[0]).getByRole("button", { name: "빼기" }));
    expect(changes()).toEqual([grantOf("alice", { kind: "schema", name: "app" }, ["USAGE"])]);
  });
});

describe("객체에 권한 주기", () => {
  const open = async () => {
    setup();
    await screen.findByText("app.orders");
    fireEvent.click(screen.getByRole("button", { name: "객체에 권한 주기" }));
    return screen.findByRole("dialog", { name: "객체에 권한 주기" });
  };

  test("searches the objects of this schema with the query 'schema.' and lists only that schema's objects", async () => {
    const dialog = await open();
    await waitFor(() => expect(m.objects).toHaveBeenCalledWith(pgTarget, "orders", "app."));
    const list = await within(dialog).findByRole("list", { name: "찾은 객체" });
    expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual(["app.orders 테이블", "app.orders_id_seq 시퀀스", "app.touch_order(order_id integer) 함수"]);
  });

  test("queues a grant of the checked privileges to the cell's role", async () => {
    const dialog = await open();
    fireEvent.click(await within(dialog).findByRole("button", { name: /^app\.orders 테이블$/ }));
    expect(within(dialog).getByRole("combobox", { name: "받는 역할" })).toHaveValue("alice");
    expect(within(dialog).getByRole("button", { name: "담기" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "SELECT" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "TRIGGER" }));
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(7);
    fireEvent.click(within(dialog).getByRole("button", { name: "담기" }));
    expect(changes()).toEqual([grantOf("alice", { kind: "relation", schema: "app", name: "orders" }, ["SELECT", "TRIGGER"], true)]);
    expect(screen.queryByRole("dialog", { name: "객체에 권한 주기" })).not.toBeInTheDocument();
  });

  test("can give to PUBLIC (모든 역할(PUBLIC)) instead", async () => {
    const dialog = await open();
    fireEvent.click(await within(dialog).findByRole("button", { name: /^app\.touch_order/ }));
    fireEvent.change(within(dialog).getByRole("combobox", { name: "받는 역할" }), { target: { value: "PUBLIC" } });
    expect(within(dialog).getByRole("option", { name: "모든 역할(PUBLIC)" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "EXECUTE" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "담기" }));
    expect(changes()).toEqual([grantOf("PUBLIC", { kind: "function", schema: "app", name: "touch_order", signature: "order_id integer" }, ["EXECUTE"], true)]);
  });

  test("a grant replaces a revoke that is queued for the same privilege", async () => {
    const dialog = await open();
    fireEvent.click(within(privilegeGroup("app.orders", "SELECT")).getByRole("button", { name: "빼기" }));
    expect(changes()[0]).toMatchObject({ add: false });
    fireEvent.click(await within(dialog).findByRole("button", { name: /^app\.orders 테이블$/ }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "SELECT" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "담기" }));
    expect(changes()).toEqual([grantOf("alice", { kind: "relation", schema: "app", name: "orders" }, ["SELECT"], true)]);
  });

  test("취소 queues nothing", async () => {
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(changes()).toEqual([]);
  });
});

describe("the draft's rules", () => {
  test("a revoke for another database than the draft's is not queued and the draft says so", async () => {
    setup();
    await screen.findByText("app.orders");
    act(() => draft.add([{ kind: "grant", database: "analytics", grantee: "bob", add: true, items: [{ target: { kind: "database", name: "analytics" }, privileges: ["CONNECT"] }] }]));
    fireEvent.click(within(privilegeGroup("app.orders", "SELECT")).getByRole("button", { name: "빼기" }));
    expect(changes()).toHaveLength(1);
    expect(draft.notices).toContain("다른 데이터베이스의 변경이 담겨 있어요. 먼저 적용하거나 비워 주세요");
  });
});
