import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithClient } from "../test/utils";
import { AssignmentsHarness, cellOf, grid, rowHeads, rowOf, tray } from "../test/assignmentsHarness";
import { iamApi } from "./api";
import { adminPolicy, alice, appRole, BADGES, bob, ciBot, orphanPolicy, principal, readOnlyPolicy, sampleOverview } from "./fixtures";
import type { IamOverview, PolicyRef, PolicySummary } from "./types";

vi.mock("./api", () => ({ iamApi: { listPolicies: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const m = vi.mocked(iamApi);
const refOf = (p: PolicySummary): PolicyRef => ({ arn: p.arn, name: p.name, scope: p.scope, description: null, badges: p.badges });
// 어느 주체에도 안 붙은 AWS 관리형 정책: 개요에는 없다
const s3Full: PolicyRef = { arn: "arn:aws:iam::aws:policy/AmazonS3FullAccess", name: "AmazonS3FullAccess", scope: "aws", description: null, badges: [BADGES.awsManaged] };

function setup(overview: IamOverview = sampleOverview(), extra: Partial<React.ComponentProps<typeof AssignmentsHarness>> = {}) {
  const props = { onOpen: vi.fn(), onPreview: vi.fn() };
  const utils = renderWithClient(<AssignmentsHarness overview={overview} {...props} {...extra} />);
  const update = (next: IamOverview) =>
    utils.rerender(
      <QueryClientProvider client={utils.qc as QueryClient}>
        <AssignmentsHarness overview={next} {...props} {...extra} />
      </QueryClientProvider>,
    );
  return { props, overview, update, ...utils };
}

const toolbarFilter = () => screen.getByRole("textbox", { name: "툴바 필터" });
const expandTray = () => fireEvent.click(screen.getByRole("button", { name: /^변경 \d+개 · / }));
const trayList = () => screen.getByRole("list", { name: "담긴 변경" });
const trayItems = () => within(trayList()).getAllByRole("listitem").map((li) => within(li).getByText(/ · /).textContent);
const openMenu = (row: string) => fireEvent.click(screen.getByRole("button", { name: `${row} 행 메뉴` }));
const chooseMatch = () => fireEvent.click(screen.getByRole("menuitem", { name: "다른 주체와 같게" }));
const pickSource = async (name: RegExp) => fireEvent.click(await screen.findByRole("option", { name }));
const matchDialog = () => screen.getByRole("dialog", { name: "다른 주체와 같게" });

beforeEach(() => {
  vi.clearAllMocks();
  m.listPolicies.mockResolvedValue([refOf(readOnlyPolicy), refOf(adminPolicy), refOf(orphanPolicy), s3Full]);
});

describe("tabs", () => {
  test("the policy tab is the one that opens, and switching keeps what is in the tray", () => {
    setup();
    expect(screen.getByRole("tab", { name: "정책" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "그룹 구성원" })).toHaveAttribute("aria-selected", "false");
    fireEvent.click(cellOf("bob", "ReadOnlyAccess"));
    fireEvent.click(screen.getByRole("tab", { name: "그룹 구성원" }));
    expect(screen.getByRole("tab", { name: "그룹 구성원" })).toHaveAttribute("aria-selected", "true");
    expect(tray()).toBe("변경 1개 · ReadOnlyAccess 붙이기 · bob");
    fireEvent.click(screen.getByRole("tab", { name: "정책" }));
    expect(cellOf("bob", "ReadOnlyAccess")).toHaveAccessibleName("bob · ReadOnlyAccess: 붙일 예정");
  });

  test("starts on the tab it is given", () => {
    setup(sampleOverview(), { initialTab: "members" });
    expect(screen.getByRole("tab", { name: "그룹 구성원" })).toHaveAttribute("aria-selected", "true");
    expect(cellOf("alice", "dev-team")).toBeInTheDocument();
  });
});

describe("kind chips and the toolbar filter", () => {
  test("unticking a kind hides its rows, and the filter narrows the names left", () => {
    setup();
    expect(screen.getByRole("checkbox", { name: "사용자" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "그룹" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "역할" })).toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "역할" }));
    expect(screen.getByRole("checkbox", { name: "역할" })).not.toBeChecked();
    expect(rowHeads()).toEqual(["사용자 3", "alice", "bob", "ci-bot", "그룹 2", "admins", "dev-team"]);

    // 부분 일치, 대소문자 무시: "bo"는 bob과 ci-bot에 들어 있다
    fireEvent.change(toolbarFilter(), { target: { value: "BO" } });
    expect(rowHeads()).toEqual(["사용자 2", "bob", "ci-bot"]);
    fireEvent.change(toolbarFilter(), { target: { value: "bob" } });
    expect(rowHeads()).toEqual(["사용자 1", "bob"]);

    // 종류를 다시 켜면 이름이 맞는 행만 돌아온다
    fireEvent.change(toolbarFilter(), { target: { value: "role" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "역할" }));
    expect(rowHeads()).toEqual(["역할 2", "app-role", "AWSServiceRoleForSupport"]);
  });

  test("the filter looks at the name, not the ARN", () => {
    setup();
    fireEvent.change(toolbarFilter(), { target: { value: "123456789012" } });
    expect(screen.getByText("보여줄 행이 없어요")).toBeInTheDocument();
  });

  test("with every kind unticked there is nothing to show", () => {
    setup();
    ["사용자", "그룹", "역할"].forEach((kind) => fireEvent.click(screen.getByRole("checkbox", { name: kind })));
    expect(screen.getByText("보여줄 행이 없어요")).toBeInTheDocument();
  });

  test("a pending change stays in the tray while its row is filtered away", () => {
    setup();
    fireEvent.click(cellOf("bob", "ReadOnlyAccess"));
    fireEvent.change(toolbarFilter(), { target: { value: "alice" } });
    expect(screen.queryByRole("button", { name: /^bob · / })).not.toBeInTheDocument();
    expect(tray()).toBe("변경 1개 · ReadOnlyAccess 붙이기 · bob");
  });
});

describe("adding a column", () => {
  test("opens the policy search without an intro, and a policy that is already a column cannot be picked", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "열 추가" }));
    const dialog = screen.getByRole("dialog", { name: "열 추가" });
    expect(within(dialog).queryByText(/붙일 정책을 고르세요/)).not.toBeInTheDocument();
    const shown = await screen.findByRole("option", { name: /ReadOnlyAccess/ });
    expect(m.listPolicies).toHaveBeenCalledWith("prod", "");
    expect(shown).toHaveAttribute("aria-disabled", "true");
    expect(within(shown).getByText("이미 열에 있어요")).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /AdministratorAccess/ })).toHaveAttribute("aria-disabled", "true");
    expect(await screen.findByRole("option", { name: /legacy-unused/ })).not.toHaveAttribute("aria-disabled");
    fireEvent.click(shown);
    expect(screen.getByRole("dialog", { name: "열 추가" })).toBeInTheDocument(); // 못 고르는 항목은 아무 일도 안 한다
  });

  test("a picked policy becomes the last column, with every cell empty", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "열 추가" }));
    fireEvent.click(await screen.findByRole("option", { name: /legacy-unused/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const heads = within(grid()).getAllByRole("columnheader").slice(1);
    expect(heads.map((h) => within(h).getByRole("button").textContent)).toEqual(["AdministratorAccess", "ReadOnlyAccess", "app-deploy", "legacy-unused"]);
    expect(within(heads[3]).getByText("고객 관리형")).toBeInTheDocument();
    const column = within(grid()).getAllByRole("button", { name: /· legacy-unused: / });
    expect(column).toHaveLength(8); // 사용자 3 + 그룹 2 + 역할 3
    column.forEach((cell) => expect(cell.getAttribute("aria-label")).toMatch(/: 없음$/));

    fireEvent.click(cellOf("alice", "legacy-unused"));
    expect(tray()).toBe("변경 1개 · legacy-unused 붙이기 · alice");
  });

  test("a policy the overview does not list is named by its ARN and has its scope", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "열 추가" }));
    fireEvent.click(await screen.findByRole("option", { name: /AmazonS3FullAccess/ }));
    const head = within(grid()).getAllByRole("columnheader").slice(1).pop() as HTMLElement;
    expect(within(head).getByRole("button")).toHaveTextContent("AmazonS3FullAccess");
    expect(within(head).getByText("AWS 관리형")).toBeInTheDocument();
    expect(cellOf("bob", "AmazonS3FullAccess")).toHaveAccessibleName("bob · AmazonS3FullAccess: 없음");
  });

  test("the next search cannot pick an added column again, and the columns stay when the tab changes", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "열 추가" }));
    fireEvent.click(await screen.findByRole("option", { name: /legacy-unused/ }));
    fireEvent.click(screen.getByRole("button", { name: "열 추가" }));
    expect(await screen.findByRole("option", { name: /legacy-unused/ })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "취소" }));

    fireEvent.click(screen.getByRole("tab", { name: "그룹 구성원" }));
    fireEvent.click(screen.getByRole("tab", { name: "정책" }));
    expect(cellOf("bob", "legacy-unused")).toBeInTheDocument();
  });

  test("a policy in the tray stays a column after leaving the screen and coming back", async () => {
    // 화면을 떠나면 열 목록은 사라진다. 그래도 장바구니에 담긴 붙이기가 표에서 안 보이면 안 된다
    setup();
    fireEvent.click(screen.getByRole("button", { name: "열 추가" }));
    fireEvent.click(await screen.findByRole("option", { name: /legacy-unused/ }));
    fireEvent.click(cellOf("alice", "legacy-unused"));
    fireEvent.click(screen.getByRole("button", { name: "화면 전환" }));
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "화면 전환" }));
    expect(cellOf("alice", "legacy-unused")).toHaveAccessibleName("alice · legacy-unused: 붙일 예정");
    expect(cellOf("bob", "legacy-unused")).toHaveAccessibleName("bob · legacy-unused: 없음");

    // 담긴 변경을 빼면 더한 적 없는 열은 다시 사라진다
    fireEvent.click(cellOf("alice", "legacy-unused"));
    expect(screen.queryByRole("button", { name: /· legacy-unused: / })).not.toBeInTheDocument();
  });

  test("Escape closes the search without adding anything", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "열 추가" }));
    await screen.findByRole("option", { name: /legacy-unused/ });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(grid()).getAllByRole("columnheader")).toHaveLength(4); // 행 머리 열 + 정책 3개
  });
});

describe("the members tab", () => {
  test("toggles membership of a user in a group", () => {
    setup(sampleOverview(), { initialTab: "members" });
    expect(rowHeads()).toEqual(["alice", "bob", "ci-bot"]); // 사용자만, 종류 머리 없이
    const heads = within(grid()).getAllByRole("columnheader").slice(1);
    expect(heads.map((h) => within(h).getByRole("button").textContent)).toEqual(["admins", "dev-team"]); // 이름순

    expect(cellOf("alice", "dev-team")).toHaveAccessibleName("alice · dev-team: 속함");
    expect(cellOf("bob", "admins")).toHaveAccessibleName("bob · admins: 안 속함");

    fireEvent.click(cellOf("bob", "admins"));
    expect(cellOf("bob", "admins")).toHaveAccessibleName("bob · admins: 넣을 예정");
    expect(tray()).toBe("변경 1개 · admins에 넣기 · bob");
    fireEvent.click(cellOf("alice", "dev-team"));
    expect(cellOf("alice", "dev-team")).toHaveAccessibleName("alice · dev-team: 뺄 예정");
    expect(tray()).toBe("변경 2개 · admins에 넣기 · bob 외 1개");
    fireEvent.click(cellOf("bob", "admins"));
    expect(cellOf("bob", "admins")).toHaveAccessibleName("bob · admins: 안 속함");
    expect(tray()).toBe("변경 1개 · dev-team에서 빼기 · alice");
  });

  test("has no kind chips, no column button and no end of row", () => {
    setup(sampleOverview(), { initialTab: "members" });
    expect(screen.queryByRole("checkbox", { name: "사용자" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "열 추가" })).not.toBeInTheDocument();
    expect(within(rowOf("alice")).queryByText(/인라인/)).not.toBeInTheDocument();
    expect(within(rowOf("alice")).queryByText("경계")).not.toBeInTheDocument();
  });

  test("a group header opens the group, and the filter narrows the users", () => {
    const { props } = setup(sampleOverview(), { initialTab: "members" });
    fireEvent.click(screen.getByRole("button", { name: "admins" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "groups", id: "arn:aws:iam::123456789012:group/admins" });
    fireEvent.change(toolbarFilter(), { target: { value: "ci" } });
    expect(rowHeads()).toEqual(["ci-bot"]);
  });

  test("drags paint memberships too", () => {
    setup(sampleOverview(), { initialTab: "members" });
    fireEvent.pointerDown(cellOf("alice", "admins"), { button: 0, buttons: 1 });
    fireEvent.pointerEnter(cellOf("bob", "admins"), { buttons: 1 });
    fireEvent.pointerEnter(cellOf("ci-bot", "admins"), { buttons: 1 });
    fireEvent.pointerUp(window);
    expect(tray()).toBe("변경 3개 · admins에 넣기 · alice 외 2개");
  });

  test("says so when there are no groups", () => {
    setup(sampleOverview({ groups: [] }), { initialTab: "members" });
    expect(screen.getByText("그룹이 없어요")).toBeInTheDocument();
  });
});

describe("the end of a row", () => {
  test("shows the inline policies left over and the boundary, only when there is something to show", () => {
    setup();
    // alice: policyCount 3 − 직접 붙은 관리형 1 = 인라인 2, 권한 경계 있음
    expect(within(rowOf("alice")).getByText("인라인 2")).toBeInTheDocument();
    expect(within(rowOf("alice")).getByText("경계")).toBeInTheDocument();
    // ci-bot: 1 − 1 = 0, 경계 없음
    expect(within(rowOf("ci-bot")).queryByText(/인라인/)).not.toBeInTheDocument();
    expect(within(rowOf("ci-bot")).queryByText("경계")).not.toBeInTheDocument();
    // 그룹과 역할도 같은 셈이다
    expect(within(rowOf("app-role")).getByText("인라인 1")).toBeInTheDocument();
    expect(within(rowOf("dev-team")).queryByText(/인라인/)).not.toBeInTheDocument();
  });

  test("a row whose policies are all managed ones shows nothing, even if the count looks lower", () => {
    const odd = principal("user", "odd", { policyCount: 0, attached: [readOnlyPolicy.arn] });
    setup(sampleOverview({ users: [odd] }));
    expect(within(rowOf("odd")).queryByText(/인라인/)).not.toBeInTheDocument();
  });

  test("pressing it opens the principal", () => {
    const { props } = setup();
    fireEvent.click(within(rowOf("alice")).getByText("인라인 2"));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "users", id: alice.arn });
    fireEvent.click(within(rowOf("alice")).getByText("경계"));
    expect(props.onOpen).toHaveBeenCalledTimes(2);
  });
});

describe("matching another principal", () => {
  test("lists the others of the same tab, and only those", async () => {
    setup();
    openMenu("alice");
    chooseMatch();
    expect(screen.getByRole("dialog", { name: "원본 고르기" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /bob/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /admins/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /app-role/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /alice/ })).not.toBeInTheDocument(); // 자기 자신은 원본이 아니다
    fireEvent.change(screen.getByRole("searchbox", { name: "주체 검색" }), { target: { value: "CI" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /ci-bot/ })).toBeInTheDocument();
    // 대소문자는 가리지 않는다. 이름 쪽에 대문자가 있어도 찾는다
    fireEvent.change(screen.getByRole("searchbox", { name: "주체 검색" }), { target: { value: "service" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /AWSServiceRoleForSupport/ })).toBeInTheDocument();
  });

  test("on the members tab only users are offered", async () => {
    setup(sampleOverview(), { initialTab: "members" });
    openMenu("alice");
    chooseMatch();
    expect(await screen.findByRole("option", { name: /bob/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /admins/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /app-role/ })).not.toBeInTheDocument();
  });

  test("puts what is missing in the tray, and takes off only what is ticked", async () => {
    setup();
    openMenu("alice");
    chooseMatch();
    await pickSource(/ci-bot/);

    const dialog = matchDialog();
    expect(within(within(dialog).getByRole("list", { name: "붙일 것" })).getByText("AdministratorAccess")).toBeInTheDocument();
    const takeOff = within(dialog).getByRole("list", { name: "뗄 것" });
    expect(within(takeOff).getByRole("checkbox", { name: "ReadOnlyAccess" })).not.toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: "담기" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(tray()).toBe("변경 1개 · AdministratorAccess 붙이기 · alice");

    // 한 번 더, 이번에는 뗄 것을 고른다
    openMenu("alice");
    chooseMatch();
    await pickSource(/ci-bot/);
    fireEvent.click(within(matchDialog()).getByRole("checkbox", { name: "ReadOnlyAccess" }));
    expect(within(matchDialog()).getByRole("checkbox", { name: "ReadOnlyAccess" })).toBeChecked();
    fireEvent.click(within(matchDialog()).getByRole("button", { name: "담기" }));
    expect(tray()).toBe("변경 2개 · AdministratorAccess 붙이기 · alice 외 1개");
    expandTray();
    expect(trayItems()).toEqual(["AdministratorAccess 붙이기 · alice", "ReadOnlyAccess 떼기 · alice"]);
  });

  test("what the target gets through a group is not compared", async () => {
    // alice는 app-deploy를 dev-team에서 받는다. 원본 bob은 직접 붙인 정책이 없어서 alice에서 뗄 것은 ReadOnlyAccess뿐이다
    setup();
    openMenu("alice");
    chooseMatch();
    await pickSource(/bob/);
    const dialog = matchDialog();
    const takeOff = within(within(dialog).getByRole("list", { name: "뗄 것" })).getAllByRole("checkbox");
    expect(takeOff.map((c) => c.closest("label")?.textContent?.trim())).toEqual(["ReadOnlyAccess"]);
    expect(within(dialog).getByRole("list", { name: "붙일 것" })).toHaveTextContent("없어요");
  });

  test("with nothing to add and nothing ticked there is nothing to put in", async () => {
    setup();
    openMenu("alice");
    chooseMatch();
    await pickSource(/bob/);
    expect(within(matchDialog()).getByRole("button", { name: "담기" })).toBeDisabled();
    fireEvent.click(within(matchDialog()).getByRole("checkbox", { name: "ReadOnlyAccess" }));
    expect(within(matchDialog()).getByRole("button", { name: "담기" })).toBeEnabled();
  });

  test("cancelling or pressing Escape puts nothing in", async () => {
    setup();
    openMenu("alice");
    chooseMatch();
    await pickSource(/ci-bot/);
    fireEvent.click(within(matchDialog()).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    openMenu("alice");
    chooseMatch();
    await pickSource(/ci-bot/);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(tray()).toBeNull();
  });

  test("on the members tab it matches the groups", async () => {
    setup(sampleOverview(), { initialTab: "members" });
    openMenu("ci-bot");
    chooseMatch();
    await pickSource(/alice/);
    const dialog = matchDialog();
    expect(within(within(dialog).getByRole("list", { name: "넣을 것" })).getByText("dev-team")).toBeInTheDocument();
    expect(within(dialog).getByRole("list", { name: "뺄 것" })).toHaveTextContent("없어요");
    fireEvent.click(within(dialog).getByRole("button", { name: "담기" }));
    expect(tray()).toBe("변경 1개 · dev-team에 넣기 · ci-bot");

    openMenu("alice");
    chooseMatch();
    await pickSource(/ci-bot/);
    fireEvent.click(within(matchDialog()).getByRole("checkbox", { name: "dev-team" }));
    fireEvent.click(within(matchDialog()).getByRole("button", { name: "담기" }));
    expect(tray()).toBe("변경 2개 · dev-team에 넣기 · ci-bot 외 1개");
    expandTray();
    expect(trayItems()).toEqual(["dev-team에 넣기 · ci-bot", "dev-team에서 빼기 · alice"]);
  });

  test("the row menu is off for a locked row, and closes with Escape", async () => {
    setup();
    openMenu("AWSServiceRoleForSupport");
    expect(screen.getByRole("menuitem", { name: "다른 주체와 같게" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AWSServiceRoleForSupport 행 메뉴" })).toHaveFocus();
  });

  test("the row menu closes when something else is pressed", () => {
    setup();
    openMenu("alice");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(cellOf("bob", "ReadOnlyAccess"), { button: 0 });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  test("a row's menu opens from the keyboard, and Tab reaches it from the row's cells", async () => {
    setup();
    act(() => cellOf("alice", "ReadOnlyAccess").focus());
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "alice 행 메뉴" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "다른 주체와 같게" })).toHaveFocus();
  });
});

describe("the tray", () => {
  test("lists its items, takes one out at a time, previews them in order and clears", () => {
    const { props } = setup();
    fireEvent.click(cellOf("bob", "ReadOnlyAccess"));
    fireEvent.click(cellOf("alice", "ReadOnlyAccess"));
    fireEvent.click(cellOf("ci-bot", "ReadOnlyAccess"));
    expect(tray()).toBe("변경 3개 · ReadOnlyAccess 붙이기 · bob 외 2개");
    expect(screen.queryByRole("list", { name: "담긴 변경" })).not.toBeInTheDocument();

    expandTray();
    expect(trayItems()).toEqual(["ReadOnlyAccess 붙이기 · bob", "ReadOnlyAccess 떼기 · alice", "ReadOnlyAccess 붙이기 · ci-bot"]);
    fireEvent.click(within(trayList()).getByRole("button", { name: "ReadOnlyAccess 붙이기 · bob 취소" }));
    expect(trayItems()).toEqual(["ReadOnlyAccess 떼기 · alice", "ReadOnlyAccess 붙이기 · ci-bot"]);
    expect(tray()).toBe("변경 2개 · ReadOnlyAccess 떼기 · alice 외 1개");
    expect(cellOf("bob", "ReadOnlyAccess")).toHaveAccessibleName("bob · ReadOnlyAccess: 없음");

    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    expect(props.onPreview).toHaveBeenCalledTimes(1);
    expect(props.onPreview).toHaveBeenCalledWith([
      { op: "detachPolicy", target: alice.arn, policyArn: readOnlyPolicy.arn },
      { op: "attachPolicy", target: ciBot.arn, policyArn: readOnlyPolicy.arn },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "모두 취소" }));
    expect(tray()).toBeNull();
    expect(screen.queryByRole("list", { name: "담긴 변경" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "미리보기" })).not.toBeInTheDocument();
    expect(cellOf("alice", "ReadOnlyAccess")).toHaveAccessibleName("alice · ReadOnlyAccess: 직접 붙음");
    expect(cellOf("ci-bot", "ReadOnlyAccess")).toHaveAccessibleName("ci-bot · ReadOnlyAccess: 없음");
  });

  test("the summary button says whether the list is open", () => {
    setup();
    fireEvent.click(cellOf("bob", "ReadOnlyAccess"));
    const toggle = screen.getByRole("button", { name: /^변경 1개 · / });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(screen.queryByRole("list", { name: "담긴 변경" })).not.toBeInTheDocument();
  });

  test("an emptied tray comes back closed", () => {
    setup();
    fireEvent.click(cellOf("bob", "ReadOnlyAccess"));
    expandTray();
    fireEvent.click(within(trayList()).getByRole("button", { name: "ReadOnlyAccess 붙이기 · bob 취소" }));
    expect(tray()).toBeNull();
    fireEvent.click(cellOf("bob", "ReadOnlyAccess"));
    expect(screen.queryByRole("list", { name: "담긴 변경" })).not.toBeInTheDocument();
  });

  test("shows a membership change the way it is labelled", () => {
    setup(sampleOverview(), { initialTab: "members" });
    fireEvent.click(cellOf("bob", "admins"));
    expandTray();
    expect(trayItems()).toEqual(["admins에 넣기 · bob"]);
  });
});

describe("notices", () => {
  test("the 51st change is not queued, and the notice stays until it is dismissed", async () => {
    const users = Array.from({ length: 60 }, (_, i) => principal("user", `u${String(i).padStart(2, "0")}`));
    setup(sampleOverview({ users, groups: [], roles: [appRole] }));
    act(() => cellOf("u00", "ReadOnlyAccess").focus());
    await userEvent.keyboard(`{Shift>}${"{ArrowDown}".repeat(54)}{/Shift} `);
    expect(tray()).toBe("변경 50개 · ReadOnlyAccess 붙이기 · u00 외 49개");
    expect(screen.getByText("한 번에 50개까지 담을 수 있어요")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "안내 닫기" }));
    expect(screen.queryByText("한 번에 50개까지 담을 수 있어요")).not.toBeInTheDocument();
    expect(tray()).toBe("변경 50개 · ReadOnlyAccess 붙이기 · u00 외 49개");
  });

  test("a change the reloaded overview made pointless is dropped with a notice", () => {
    const { update } = setup();
    fireEvent.click(cellOf("bob", "ReadOnlyAccess"));
    fireEvent.click(cellOf("ci-bot", "AdministratorAccess")); // 이미 붙어 있으니 떼기
    expect(tray()).toBe("변경 2개 · ReadOnlyAccess 붙이기 · bob 외 1개");

    // 그 사이 누군가 bob에 ReadOnlyAccess를 붙였다
    update(sampleOverview({ users: [alice, { ...bob, attached: [readOnlyPolicy.arn] }, ciBot] }));
    expect(tray()).toBe("변경 1개 · AdministratorAccess 떼기 · ci-bot");
    expect(screen.getByText("이미 붙어 있어서 뺐어요: ReadOnlyAccess 붙이기 · bob")).toBeInTheDocument();
    expect(cellOf("bob", "ReadOnlyAccess")).toHaveAccessibleName("bob · ReadOnlyAccess: 직접 붙음");
    fireEvent.click(screen.getByRole("button", { name: "안내 닫기" }));
    expect(screen.queryByText(/뺐어요/)).not.toBeInTheDocument();
  });

  test("notices stay after the tray is emptied", () => {
    const { update } = setup();
    fireEvent.click(cellOf("bob", "ReadOnlyAccess"));
    update(sampleOverview({ users: [alice, { ...bob, attached: [readOnlyPolicy.arn] }, ciBot] }));
    expect(tray()).toBeNull();
    expect(screen.getByText("이미 붙어 있어서 뺐어요: ReadOnlyAccess 붙이기 · bob")).toBeInTheDocument();
  });
});

describe("empty tables", () => {
  test("a policy table with no policy attached anywhere points to adding a column", () => {
    setup(sampleOverview({ users: [principal("user", "solo")], groups: [], roles: [] }));
    expect(screen.getByText("붙은 정책이 없어요. 열 추가로 정책을 더해 보세요")).toBeInTheDocument();
  });
});
