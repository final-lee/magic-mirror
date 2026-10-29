import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import { DefaultPrivileges } from "./DefaultPrivileges";
import { pgTarget, sampleDatabaseView, sampleOverview } from "./fixtures";
import type { PgChange } from "./types";
import { usePgDraft, type PgDraft } from "./usePgDraft";

vi.mock("./api", () => ({ pgApi: { database: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(pgApi);
const overview = sampleOverview();

let draft!: PgDraft;
type Props = Partial<React.ComponentProps<typeof DefaultPrivileges>>;
function Harness(props: Props) {
  const own = usePgDraft(pgTarget, overview);
  draft = own;
  return <DefaultPrivileges target={pgTarget} overview={overview} database="orders" onDatabase={() => {}} editing draft={own} {...props} />;
}
const setup = (props: Props = {}) => renderWithClient(<Harness {...props} />);
const changes = (): PgChange[] => draft.items.map((d) => d.change);
const table = () => screen.findByRole("table", { name: "기본 권한" });
const dialog = () => screen.getByRole("dialog", { name: "기본 권한 추가" });
const open = async () => {
  await table();
  fireEvent.click(screen.getByRole("button", { name: "기본 권한 추가" }));
};
const select = (name: string, value: string) => fireEvent.change(within(dialog()).getByRole("combobox", { name }), { target: { value } });
const check = (name: string) => fireEvent.click(within(dialog()).getByRole("checkbox", { name }));
const optionsOf = (name: string) => within(within(dialog()).getByRole("combobox", { name })).getAllByRole("option").map((o) => o.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  m.database.mockImplementation(async (_t, database) => sampleDatabaseView({ database }));
});

describe("each grant line", () => {
  test("has 빼기, which queues a revoke of that line", async () => {
    setup();
    const t = await table();
    const line = within(t).getAllByText("app_read")[0].closest("li") as HTMLElement;
    fireEvent.click(within(line).getByRole("button", { name: "빼기" }));
    expect(changes()).toEqual([{ kind: "defaultPrivilege", database: "orders", creator: "app_owner", schema: "app", objectType: "tables", grantee: "app_read", privileges: ["SELECT"], add: false }]);
    expect(within(line).getByRole("button", { name: "빼기" })).toHaveAttribute("aria-pressed", "true");
  });

  test("a line of all schemas and of PUBLIC revokes with schema null and grantee PUBLIC", async () => {
    setup();
    const t = await table();
    const line = within(t).getByText("모든 역할(PUBLIC)").closest("li") as HTMLElement;
    fireEvent.click(within(line).getByRole("button", { name: "빼기" }));
    expect(changes()).toEqual([{ kind: "defaultPrivilege", database: "orders", creator: "app_owner", schema: null, objectType: "types", grantee: "PUBLIC", privileges: ["USAGE"], add: false }]);
  });

  test("outside 바꾸기 mode there are no buttons", async () => {
    setup({ editing: false });
    await table();
    expect(screen.queryByRole("button", { name: "빼기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "기본 권한 추가" })).not.toBeInTheDocument();
  });
});

describe("기본 권한 추가", () => {
  test("offers the creator, schema, object type, grantee and the privileges of the type", async () => {
    setup();
    await open();
    expect(optionsOf("스키마")).toEqual(["모든 스키마", "app", "audit"]);
    expect(optionsOf("객체 종류")).toEqual(["테이블", "시퀀스", "함수", "타입", "스키마"]);
    expect(optionsOf("받는 역할")).toContain("모든 역할(PUBLIC)");
    expect(optionsOf("만드는 역할")).not.toContain("rds_superuser");
    const privileges = () => within(dialog()).getAllByRole("checkbox").map((c) => c.parentElement!.textContent!.trim());
    expect(privileges()).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]);
    select("객체 종류", "sequences");
    expect(privileges()).toEqual(["USAGE", "SELECT", "UPDATE"]);
    select("객체 종류", "functions");
    expect(privileges()).toEqual(["EXECUTE"]);
    select("객체 종류", "types");
    expect(privileges()).toEqual(["USAGE"]);
    select("객체 종류", "schemas");
    expect(privileges()).toEqual(["USAGE", "CREATE"]);
  });

  test("queues the default privilege for the chosen schema", async () => {
    setup();
    await open();
    select("만드는 역할", "app_owner");
    select("스키마", "audit");
    select("받는 역할", "app_read");
    check("SELECT");
    check("TRIGGER");
    fireEvent.click(within(dialog()).getByRole("button", { name: "담기" }));
    expect(changes()).toEqual([{ kind: "defaultPrivilege", database: "orders", creator: "app_owner", schema: "audit", objectType: "tables", grantee: "app_read", privileges: ["SELECT", "TRIGGER"], add: true }]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("all schemas queue schema null, and PUBLIC is a grantee", async () => {
    setup();
    await open();
    select("받는 역할", "PUBLIC");
    select("객체 종류", "functions");
    check("EXECUTE");
    fireEvent.click(within(dialog()).getByRole("button", { name: "담기" }));
    expect(changes()).toEqual([expect.objectContaining({ schema: null, grantee: "PUBLIC", objectType: "functions", privileges: ["EXECUTE"], add: true })]);
  });

  test("the object type 스키마 fixes the schema to 모든 스키마", async () => {
    setup();
    await open();
    select("스키마", "app");
    select("객체 종류", "schemas");
    const schema = within(dialog()).getByRole("combobox", { name: "스키마" });
    expect(schema).toBeDisabled();
    expect(schema).toHaveValue("");
    check("USAGE");
    fireEvent.click(within(dialog()).getByRole("button", { name: "담기" }));
    expect(changes()).toEqual([expect.objectContaining({ schema: null, objectType: "schemas" })]);
  });

  test("switching the type drops the privileges the new type does not have", async () => {
    setup();
    await open();
    check("SELECT");
    check("INSERT");
    select("객체 종류", "sequences");
    expect(within(dialog()).getByRole("checkbox", { name: "SELECT" })).toBeChecked();
    fireEvent.click(within(dialog()).getByRole("button", { name: "담기" }));
    expect(changes()).toEqual([expect.objectContaining({ objectType: "sequences", privileges: ["SELECT"] })]);
  });

  test("담기 needs a privilege", async () => {
    setup();
    await open();
    expect(within(dialog()).getByRole("button", { name: "담기" })).toBeDisabled();
  });

  test("a default privilege add replaces a queued revoke of the same line", async () => {
    setup();
    const t = await table();
    const line = within(t).getAllByText("app_read")[0].closest("li") as HTMLElement;
    fireEvent.click(within(line).getByRole("button", { name: "빼기" }));
    fireEvent.click(screen.getByRole("button", { name: "기본 권한 추가" }));
    select("만드는 역할", "app_owner");
    select("스키마", "app");
    select("받는 역할", "app_read");
    check("SELECT");
    fireEvent.click(within(dialog()).getByRole("button", { name: "담기" }));
    expect(changes()).toEqual([expect.objectContaining({ add: true, grantee: "app_read" })]);
  });
});
