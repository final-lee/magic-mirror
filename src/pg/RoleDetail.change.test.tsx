import { act, fireEvent, screen, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import { membership, pgTarget, role, sampleDatabaseView, sampleOverview, sampleRoleView } from "./fixtures";
import { RoleDetail } from "./RoleDetail";
import type { PgChange } from "./types";
import { usePgDraft, type PgDraft } from "./usePgDraft";

vi.mock("./api", () => ({ pgApi: { role: vi.fn(), database: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(pgApi);
const overview = sampleOverview();

let draft!: PgDraft;
type Props = Partial<React.ComponentProps<typeof RoleDetail>>;
function Harness(props: Props) {
  const own = usePgDraft(pgTarget, overview);
  draft = own;
  return <RoleDetail target={pgTarget} role="alice" onOpen={() => {}} editing draft={own} roles={overview.roles} {...props} />;
}
const setup = (props: Props = {}) => renderWithClient(<Harness {...props} />);
const changes = (): PgChange[] => draft.items.map((d) => d.change);
const openTab = async (name: string) => fireEvent.click(await screen.findByRole("tab", { name }));
const checks = () => within(screen.getByRole("group", { name: "그룹에 넣기" })).getAllByRole("checkbox").map((c) => (c.parentElement!.textContent ?? "").trim());
const box = (name: string) => within(screen.getByRole("group", { name: "그룹에 넣기" })).getByRole("checkbox", { name: new RegExp(name) });

beforeEach(() => {
  vi.clearAllMocks();
  m.role.mockImplementation(async (_t, name) => sampleRoleView(name));
  m.database.mockImplementation(async (_t, database) => sampleDatabaseView({ database }));
});

describe("구성원 tab", () => {
  test("has a checkbox per non-system group and per allowed system group, never the role itself", async () => {
    setup();
    await openTab("구성원");
    // 시스템 그룹은 허용한 것만(rds_superuser, rds_iam, pg_read_all_data), 사용자 역할은 그룹이 아니다
    expect(checks()).toEqual(["app_read", "app_write", "pg_read_all_data", "rds_iam", "rds_superuser"]);
    expect(box("app_write")).toBeChecked();
    expect(box("rds_iam")).toBeChecked();
    expect(box("app_read")).not.toBeChecked();
  });

  test("checking a group queues a membership add, with a pending marker", async () => {
    setup();
    await openTab("구성원");
    fireEvent.click(box("pg_read_all_data"));
    expect(changes()).toEqual([{ kind: "membership", group: "pg_read_all_data", member: "alice", add: true, admin: false }]);
    expect(box("pg_read_all_data")).toBeChecked();
    expect(screen.getByText("넣기 예정")).toBeInTheDocument();
  });

  test("unchecking a member queues a removal; clicking again takes it back out", async () => {
    setup();
    await openTab("구성원");
    fireEvent.click(box("app_write"));
    expect(changes()).toEqual([{ kind: "membership", group: "app_write", member: "alice", add: false, admin: false }]);
    expect(box("app_write")).not.toBeChecked();
    expect(screen.getByText("빼기 예정")).toBeInTheDocument();
    fireEvent.click(box("app_write"));
    expect(changes()).toEqual([]);
    expect(box("app_write")).toBeChecked();
  });

  test("keeps the phase-1 chips with their SET marks", async () => {
    setup({ role: "bob" });
    await openTab("구성원");
    expect(await screen.findAllByText("SET ROLE로만 쓸 수 있음")).not.toHaveLength(0);
  });

  test("each existing membership has an ADMIN OPTION checkbox that queues a change with admin true", async () => {
    setup();
    await openTab("구성원");
    const row = (await screen.findByRole("list", { name: "속한 그룹" })).querySelectorAll("li")[0] as HTMLElement;
    expect(within(row).getByText("app_write")).toBeInTheDocument();
    const admin = within(row).getByRole("checkbox", { name: /ADMIN OPTION/ });
    expect(admin).not.toBeChecked();
    fireEvent.click(admin);
    expect(changes()).toEqual([{ kind: "membership", group: "app_write", member: "alice", add: true, admin: true }]);
    expect(admin).toBeChecked();
    expect(within(row).getByText("넣기 예정")).toBeInTheDocument();
  });

  test("ADMIN OPTION is off while the removal of that membership is queued, and the removal stays", async () => {
    setup();
    await openTab("구성원");
    fireEvent.click(box("app_write"));
    const row = (await screen.findByRole("list", { name: "속한 그룹" })).querySelectorAll("li")[0] as HTMLElement;
    const admin = within(row).getByRole("checkbox", { name: /ADMIN OPTION/ });
    expect(admin).toBeDisabled();
    expect(admin.closest("label")).toHaveAttribute("title", "그룹에서 빼는 변경이 담겨 있어요. ADMIN OPTION을 바꾸려면 먼저 그 변경을 거둬 주세요");
    fireEvent.click(admin);
    expect(changes()).toEqual([{ kind: "membership", group: "app_write", member: "alice", add: false, admin: false }]);
  });

  test("ADMIN OPTION of a membership in a system group that cannot be changed says which group", async () => {
    const extension = role("rds_extension");
    const view = sampleRoleView("alice");
    m.role.mockResolvedValue({ ...view, summary: { ...view.summary, memberOf: [membership("rds_extension")] } });
    setup({ roles: [...overview.roles, extension] });
    await openTab("구성원");
    const row = (await screen.findByText("rds_extension", { selector: "button" })).closest("li") as HTMLElement;
    expect(within(row).getByRole("checkbox", { name: /ADMIN OPTION/ }).closest("label")).toHaveAttribute("title", "이 시스템 역할에는 구성원을 넣거나 뺄 수 없어요: rds_extension");
  });

  test("ADMIN OPTION of a system role's membership names that role, not the group", async () => {
    const view = sampleRoleView("rds_iam");
    m.role.mockResolvedValue({ ...view, summary: { ...view.summary, memberOf: [membership("app_read")] } });
    setup({ role: "rds_iam" });
    await openTab("구성원");
    const row = (await screen.findByText("app_read", { selector: "button" })).closest("li") as HTMLElement;
    expect(within(row).getByRole("checkbox", { name: /ADMIN OPTION/ }).closest("label")).toHaveAttribute("title", "시스템 역할이라 바꿀 수 없어요: rds_iam");
  });

  test("the draft's 50-item limit applies", async () => {
    setup();
    await openTab("구성원");
    act(() => {
      draft.add(Array.from({ length: 50 }, (_, i) => ({ kind: "membership" as const, group: `g${i}`, member: "x", add: true, admin: false })));
    });
    fireEvent.click(box("pg_read_all_data"));
    expect(draft.items).toHaveLength(50);
    expect(draft.notices).toContain("한 번에 50개까지 담을 수 있어요");
  });

  test("without 바꾸기 mode there are no checkboxes", async () => {
    setup({ editing: false });
    await openTab("구성원");
    await screen.findByRole("list", { name: "속한 그룹" });
    expect(screen.queryByRole("group", { name: "그룹에 넣기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  test("a system role cannot be changed: its checkboxes are disabled", async () => {
    setup({ role: "rds_iam" });
    await openTab("구성원");
    expect(await screen.findByRole("group", { name: "그룹에 넣기" })).toBeDisabled();
  });
});

describe("개요 tab", () => {
  const form = async () => screen.findByRole("group", { name: /속성 바꾸기/ });

  test("fills the form from the role's attributes and keeps REPLICATION and BYPASSRLS read-only", async () => {
    setup({ role: "bob" });
    const f = await form();
    expect(within(f).getByRole("checkbox", { name: "LOGIN" })).toBeChecked();
    expect(within(f).getByRole("checkbox", { name: "INHERIT" })).not.toBeChecked();
    expect(within(f).getByLabelText("연결 수 제한")).toBeDisabled();
    expect(within(f).getByRole("checkbox", { name: "제한 없음" })).toBeChecked();
    expect(within(f).getByLabelText("만료일")).toHaveValue("2026-11-05");
    expect(within(f).queryByRole("checkbox", { name: "REPLICATION" })).not.toBeInTheDocument();
    expect(within(f).queryByRole("checkbox", { name: "BYPASSRLS" })).not.toBeInTheDocument();
  });

  test("담기 queues the whole wanted attribute set", async () => {
    setup();
    const f = await form();
    fireEvent.click(within(f).getByRole("checkbox", { name: "CREATEDB" }));
    fireEvent.click(within(f).getByRole("checkbox", { name: "제한 없음" }));
    fireEvent.change(within(f).getByLabelText("연결 수 제한"), { target: { value: "5" } });
    fireEvent.click(within(f).getByRole("checkbox", { name: "없음" }));
    fireEvent.change(within(f).getByLabelText("만료일"), { target: { value: "2027-01-31" } });
    fireEvent.click(within(f).getByRole("button", { name: "담기" }));
    expect(changes()).toEqual([
      { kind: "attributes", role: "alice", set: { login: true, createDb: true, createRole: false, inherit: true, connectionLimit: 5, validUntil: "2027-01-31T00:00:00Z" } },
    ]);
  });

  test("an untouched expiry is sent as it is, not as its date", async () => {
    setup({ role: "bob" });
    const f = await form();
    fireEvent.click(within(f).getByRole("checkbox", { name: "CREATEDB" }));
    fireEvent.click(within(f).getByRole("button", { name: "담기" }));
    expect(changes()).toEqual([expect.objectContaining({ set: expect.objectContaining({ validUntil: "2026-11-05T12:00:00Z", createDb: true }) })]);
  });

  test("담기 again replaces the queued attributes instead of adding a second item", async () => {
    setup();
    let f = await form();
    fireEvent.click(within(f).getByRole("checkbox", { name: "CREATEDB" }));
    fireEvent.click(within(f).getByRole("button", { name: "담기" }));
    f = await form();
    expect(within(f).getByRole("checkbox", { name: "CREATEDB" })).toBeChecked();
    fireEvent.click(within(f).getByRole("checkbox", { name: "CREATEROLE" }));
    fireEvent.click(within(f).getByRole("button", { name: "담기" }));
    expect(changes()).toEqual([expect.objectContaining({ set: expect.objectContaining({ createDb: true, createRole: true }) })]);
  });

  test("an invalid limit cannot be queued", async () => {
    setup();
    const f = await form();
    fireEvent.click(within(f).getByRole("checkbox", { name: "제한 없음" }));
    fireEvent.change(within(f).getByLabelText("연결 수 제한"), { target: { value: "" } });
    expect(within(f).getByRole("button", { name: "담기" })).toBeDisabled();
  });

  test("no form outside 바꾸기 mode", async () => {
    setup({ editing: false });
    await screen.findByText("LOGIN", { selector: "dt" });
    expect(screen.queryByRole("group", { name: /속성 바꾸기/ })).not.toBeInTheDocument();
  });
});
