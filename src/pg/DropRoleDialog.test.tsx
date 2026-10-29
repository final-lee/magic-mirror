import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import { DropRoleDialog } from "./DropRoleDialog";
import { LOGIN_USER, pgTarget, sampleDropPlan, sampleOverview } from "./fixtures";
import type { PgDropPlan, PgDropResult } from "./types";

vi.mock("./api", () => ({ pgApi: { dropPlan: vi.fn(), applyDrop: vi.fn(), overview: vi.fn(), database: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(pgApi);
const overview = sampleOverview();

function setup(props: Partial<React.ComponentProps<typeof DropRoleDialog>> = {}) {
  const handlers = { onClose: vi.fn(), onDropped: vi.fn() };
  const utils = renderWithClient(<DropRoleDialog target={pgTarget} role="alice" overview={overview} {...handlers} {...props} />);
  return { ...handlers, ...utils };
}

const user = () => userEvent.setup();
const dialog = () => screen.getByRole("dialog", { name: "역할 삭제" });
const loaded = () => screen.findByRole("list", { name: "삭제 단계" });
const heir = () => screen.getByRole("combobox", { name: "넘겨받을 역할" }) as HTMLSelectElement;
const confirmInput = () => screen.getByLabelText("확인하려면 입력하세요: alice");
const deleteButton = () => screen.getByRole("button", { name: /^삭제$|^적용/ });
const steps = () => within(screen.getByRole("list", { name: "삭제 단계" })).getAllByRole("listitem", {}).filter((li) => li.classList.contains("pg-drop-step"));

const stoppedResult: PgDropResult = { logId: "l1", total: 3, done: 1, stopped: "3개 데이터베이스 중 1개를 정리하고 멈췄어요: 다른 작업이 객체를 잠그고 있어 적용하지 못했어요. 잠시 뒤 다시 시도하세요" };
const okResult: PgDropResult = { logId: "l1", total: 3, done: 3, stopped: null };

beforeEach(() => {
  vi.clearAllMocks();
  m.dropPlan.mockResolvedValue(sampleDropPlan());
  m.applyDrop.mockResolvedValue(okResult);
  m.overview.mockResolvedValue(overview);
  m.database.mockResolvedValue({} as never);
});

describe("the plan", () => {
  test("loads the plan for the login user by default and shows the role in a dialog titled 역할 삭제", async () => {
    setup();
    expect(dialog()).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("삭제 계획을 불러오는 중이에요…")).toBeInTheDocument();
    await loaded();
    expect(m.dropPlan).toHaveBeenCalledWith(pgTarget, "alice", LOGIN_USER);
    expect(heir().value).toBe(LOGIN_USER);
    expect(screen.getByText("적용할 DB 사용자: iam_admin")).toBeInTheDocument();
  });

  test("the heirs are the non-system roles and the login user, without the role itself", async () => {
    setup();
    await loaded();
    expect(within(heir()).getAllByRole("option").map((o) => o.textContent)).toEqual(["app_owner", "app_read", "app_write", "bob", "iam_admin", "postgres"]);
  });

  test("each step: the database (the default one's name for null), the counts and its SQL", async () => {
    setup();
    await loaded();
    const [first, second, third, last] = steps();
    expect(within(first).getByText("analytics")).toBeInTheDocument();
    expect(within(first).getByText("객체 0개 · 권한 1개 · 기본 권한 0개")).toBeInTheDocument();
    expect(within(first).getByText('REASSIGN OWNED BY "alice" TO "iam_admin"')).toBeInTheDocument();
    expect(within(first).getByText('DROP OWNED BY "alice"')).toBeInTheDocument();
    expect(within(second).getByText("orders")).toBeInTheDocument(); // 기본 데이터베이스의 이름
    expect(within(second).getByText("객체 0개 · 권한 2개 · 기본 권한 0개")).toBeInTheDocument();
    expect(within(third).getByText("postgres")).toBeInTheDocument();
    expect(within(last).getByText('DROP ROLE "alice"')).toBeInTheDocument();
  });

  test("a step that has objects shows them in the counts", async () => {
    m.dropPlan.mockResolvedValue(sampleDropPlan({ steps: [{ database: "orders", sql: ['DROP ROLE "alice"'], owned: 3, privileges: 4, defaults: 2 }] }));
    setup();
    await loaded();
    expect(screen.getByText("객체 3개 · 권한 4개 · 기본 권한 2개")).toBeInTheDocument();
  });

  test("the warnings are listed and the confirm field asks for the name", async () => {
    setup();
    await loaded();
    expect(screen.getByText("이 역할로 접속한 세션 1개는 끊기지 않아요")).toBeInTheDocument();
    expect(confirmInput()).toBeInTheDocument();
  });

  test("each choice of the heir loads the plan again", async () => {
    m.dropPlan.mockImplementation(async (_t, role, reassignTo) => sampleDropPlan({ role, reassignTo }));
    setup();
    await loaded();
    await user().selectOptions(heir(), "app_owner");
    await waitFor(() => expect(m.dropPlan).toHaveBeenLastCalledWith(pgTarget, "alice", "app_owner"));
    expect(m.dropPlan).toHaveBeenCalledTimes(2);
    await user().selectOptions(heir(), LOGIN_USER);
    await waitFor(() => expect(m.dropPlan).toHaveBeenCalledTimes(3));
    expect(m.dropPlan).toHaveBeenLastCalledWith(pgTarget, "alice", LOGIN_USER);
  });

  test("while a new plan loads the old one is not shown and 삭제 is off", async () => {
    let resolve!: (p: PgDropPlan) => void;
    setup();
    await loaded();
    m.dropPlan.mockReturnValue(new Promise((r) => (resolve = r)));
    await user().selectOptions(heir(), "app_owner");
    expect(screen.queryByRole("list", { name: "삭제 단계" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^적용/ })).toBeDisabled();
    resolve(sampleDropPlan({ reassignTo: "app_owner" }));
    await loaded();
  });

  test("a plan that could not be made says why", async () => {
    m.dropPlan.mockRejectedValue({ kind: "other", message: "질의가 30초 안에 끝나지 않았어요" });
    setup();
    expect(await screen.findByText("질의가 30초 안에 끝나지 않았어요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^적용/ })).toBeDisabled();
  });

  test("the memberships that go with it, with the ones that leave the group", async () => {
    m.dropPlan.mockResolvedValue(
      sampleDropPlan({
        grantedMemberships: [
          { member: "bob", group: "app_read", lost: true },
          { member: "carol", group: "app_read", lost: false },
        ],
      }),
    );
    setup();
    await loaded();
    const list = within(screen.getByRole("list", { name: "함께 지워지는 구성원 관계" }));
    expect(screen.getByRole("heading", { name: "함께 지워지는 구성원 관계" })).toBeInTheDocument();
    const [bob, carol] = list.getAllByRole("listitem");
    expect(bob).toHaveTextContent("bob → app_read 그룹에서 빠져요");
    expect(carol).toHaveTextContent(/^carol → app_read$/);
  });

  test("no memberships, no heading", async () => {
    setup();
    await loaded();
    expect(screen.queryByRole("heading", { name: "함께 지워지는 구성원 관계" })).not.toBeInTheDocument();
  });

  test("a blocked plan can not be applied whatever is typed", async () => {
    m.dropPlan.mockResolvedValue(sampleDropPlan({ warnings: [{ level: "block", message: "앱이 로그인한 역할은 삭제할 수 없어요", add: [] }] }));
    setup();
    await loaded();
    await user().type(confirmInput(), "alice");
    expect(screen.getByRole("button", { name: /^적용/ })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("앱이 로그인한 역할은 삭제할 수 없어요");
  });
});

describe("applying", () => {
  const typeName = async () => {
    await loaded();
    await user().type(confirmInput(), "alice");
  };

  test("needs the confirm text", async () => {
    setup();
    await loaded();
    expect(screen.getByRole("button", { name: /^적용/ })).toBeDisabled();
    await user().type(confirmInput(), "alic");
    expect(screen.getByRole("button", { name: /^적용/ })).toBeDisabled();
    await user().type(confirmInput(), "e");
    expect(screen.getByRole("button", { name: /^적용/ })).toBeEnabled();
  });

  test("calls pg_apply_drop with the role, the heir and the typed text, then refreshes and reports the drop", async () => {
    const { onDropped } = setup();
    await typeName();
    await user().click(screen.getByRole("button", { name: /^적용/ }));
    await waitFor(() => expect(onDropped).toHaveBeenCalledWith("alice", true));
    expect(m.applyDrop).toHaveBeenCalledWith(pgTarget, "alice", LOGIN_USER, "alice");
    expect(m.overview).toHaveBeenCalledWith(pgTarget);
  });

  test("a refresh that could not read the list is passed on", async () => {
    m.overview.mockRejectedValue(new Error("끊김"));
    const { onDropped } = setup();
    await typeName();
    await user().click(screen.getByRole("button", { name: /^적용/ }));
    await waitFor(() => expect(onDropped).toHaveBeenCalledWith("alice", false));
  });

  test("while it runs the dialog can not be closed and the controls are locked", async () => {
    let resolve!: (r: PgDropResult) => void;
    m.applyDrop.mockReturnValue(new Promise((r) => (resolve = r)));
    const { onClose, onDropped } = setup();
    await typeName();
    await user().click(screen.getByRole("button", { name: /^적용/ }));
    expect(await screen.findByRole("button", { name: "적용 중…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();
    expect(heir()).toBeDisabled();
    await user().keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    resolve(okResult);
    await waitFor(() => expect(onDropped).toHaveBeenCalled());
  });

  test("a second click while it runs does not apply twice", async () => {
    m.applyDrop.mockReturnValue(new Promise(() => {}));
    setup();
    await typeName();
    await user().click(screen.getByRole("button", { name: /^적용/ }));
    await user().click(await screen.findByRole("button", { name: "적용 중…" }));
    expect(m.applyDrop).toHaveBeenCalledTimes(1);
  });

  test("a drop that stopped keeps the dialog open: the text, ✓ on the finished steps and 실행하지 않음 on the rest, and it refreshes", async () => {
    m.applyDrop.mockResolvedValue(stoppedResult);
    const { onDropped, onClose } = setup();
    await typeName();
    await user().click(screen.getByRole("button", { name: /^적용/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(stoppedResult.stopped!);
    expect(onDropped).not.toHaveBeenCalled();
    expect(m.overview).toHaveBeenCalledTimes(1);
    const [first, second, third, last] = steps();
    expect(within(first).getByText("✓")).toBeInTheDocument();
    for (const row of [second, third, last]) {
      expect(within(row).getByText("실행하지 않음")).toBeInTheDocument();
      expect(within(row).queryByText("✓")).not.toBeInTheDocument();
    }
    await user().click(screen.getByRole("button", { name: "닫기" }));
    expect(onClose).toHaveBeenCalled();
  });

  test("after it stopped the steps stay as they were, even though the refresh changes the plan", async () => {
    m.applyDrop.mockResolvedValue(stoppedResult);
    m.dropPlan.mockResolvedValueOnce(sampleDropPlan()).mockResolvedValue(sampleDropPlan({ steps: [{ database: null, sql: ['DROP ROLE "alice"'], owned: 0, privileges: 0, defaults: 0 }] }));
    setup();
    await typeName();
    await user().click(screen.getByRole("button", { name: /^적용/ }));
    await screen.findByRole("alert");
    expect(steps()).toHaveLength(4);
    expect(screen.queryByLabelText("확인하려면 입력하세요: alice")).not.toBeInTheDocument();
  });

  test("a stopped drop whose list could not be read again says so", async () => {
    m.applyDrop.mockResolvedValue(stoppedResult);
    m.overview.mockRejectedValue(new Error("끊김"));
    setup();
    await typeName();
    await user().click(screen.getByRole("button", { name: /^적용/ }));
    expect(await screen.findByText("적용은 됐지만 목록을 다시 읽지 못했어요. [다시 읽기]를 눌러 주세요")).toBeInTheDocument();
  });

  test("a refused apply shows the reason, keeps the dialog open, refreshes and needs the plan again", async () => {
    m.applyDrop.mockRejectedValue({ kind: "other", message: "미리보기 뒤에 바뀌었어요. 미리보기를 다시 받아 주세요" });
    const { onDropped } = setup();
    await typeName();
    await user().click(screen.getByRole("button", { name: /^적용/ }));
    expect(await screen.findByText("미리보기 뒤에 바뀌었어요. 미리보기를 다시 받아 주세요")).toBeInTheDocument();
    expect(onDropped).not.toHaveBeenCalled();
    await waitFor(() => expect(m.overview).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /^적용/ })).toBeDisabled();
    const calls = m.dropPlan.mock.calls.length;
    await user().click(screen.getByRole("button", { name: "미리보기 다시 받기" }));
    await waitFor(() => expect(m.dropPlan.mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() => expect(screen.getByRole("button", { name: /^적용/ })).toBeEnabled());
  });

  test("nothing happens to a dialog that is gone when the answer comes", async () => {
    let resolve!: (r: PgDropResult) => void;
    m.applyDrop.mockReturnValue(new Promise((r) => (resolve = r)));
    const { onDropped, unmount } = setup();
    await typeName();
    await user().click(screen.getByRole("button", { name: /^적용/ }));
    await screen.findByRole("button", { name: "적용 중…" });
    unmount();
    resolve(okResult);
    await new Promise((r) => setTimeout(r, 20));
    expect(onDropped).not.toHaveBeenCalled();
    expect(m.overview).not.toHaveBeenCalled();
  });

  test("취소 closes it", async () => {
    const { onClose } = setup();
    await loaded();
    await user().click(screen.getByRole("button", { name: "취소" }));
    expect(onClose).toHaveBeenCalled();
  });
});
