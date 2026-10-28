import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithClient } from "../test/utils";
import { AssignmentsHarness, cellOf, grid, rowHeads, tray } from "../test/assignmentsHarness";
import { ROW_H, visibleRange } from "./AssignmentGrid";
import { adminPolicy, admins, alice, appRole, bob, ciBot, deployPolicy, devTeam, principal, readOnlyPolicy, sampleOverview } from "./fixtures";
import type { IamOverview } from "./types";

vi.mock("./api", () => ({ iamApi: { listPolicies: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const focusCell = (el: HTMLElement) => act(() => el.focus());
const press = (el: HTMLElement, init: PointerEventInit & { button?: number } = {}) => fireEvent.pointerDown(el, { button: 0, buttons: 1, ...init });

function setup(overview: IamOverview = sampleOverview(), extra: Partial<React.ComponentProps<typeof AssignmentsHarness>> = {}) {
  const props = { onOpen: vi.fn(), onPreview: vi.fn() };
  const utils = renderWithClient(<AssignmentsHarness overview={overview} {...props} {...extra} />);
  return { props, overview, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("visibleRange", () => {
  test("starts at the first row and reads the overscan below the viewport", () => {
    expect(visibleRange(0, 280, 28, 300, 10)).toEqual({ start: 0, end: 20 });
  });

  test("adds the overscan above and below in the middle", () => {
    expect(visibleRange(28 * 100, 280, 28, 300, 10)).toEqual({ start: 90, end: 120 });
  });

  test("a row that is only partly in view counts", () => {
    expect(visibleRange(14, 280, 28, 300, 0)).toEqual({ start: 0, end: 11 });
  });

  test("never goes past either end", () => {
    expect(visibleRange(28 * 295, 280, 28, 300, 10)).toEqual({ start: 285, end: 300 });
  });

  test("fewer rows than the window shows them all", () => {
    expect(visibleRange(0, 280, 28, 5, 10)).toEqual({ start: 0, end: 5 });
  });

  test("no rows, no range", () => {
    expect(visibleRange(0, 280, 28, 0, 10)).toEqual({ start: 0, end: 0 });
  });

  test("a negative scroll (rubber band) counts as the top", () => {
    expect(visibleRange(-50, 280, 28, 300, 10)).toEqual({ start: 0, end: 20 });
  });

  test("the row height is the one the grid lays out with", () => {
    expect(ROW_H).toBe(28);
  });
});

describe("the policy table", () => {
  test("shows the rows under their kind, the columns in order with their badges, and a state in every cell", () => {
    setup();
    expect(rowHeads()).toEqual(["사용자 3", "alice", "bob", "ci-bot", "그룹 2", "admins", "dev-team", "역할 3", "app-role", "AWSServiceRoleForSupport", "partner-access"]);

    const heads = within(grid()).getAllByRole("columnheader").slice(1); // 첫 머리는 행 머리 열의 이름
    expect(heads.map((h) => within(h).getByRole("button").textContent)).toEqual(["AdministratorAccess", "ReadOnlyAccess", "app-deploy"]);
    expect(within(heads[0]).getByText("관리자급")).toBeInTheDocument();
    expect(within(heads[0]).getAllByText("AWS 관리형")).toHaveLength(1); // 범위 칸이 알려 주는 AWS 관리형 배지는 되풀이하지 않는다
    expect(within(heads[1]).getByText("AWS 관리형")).toBeInTheDocument();
    expect(within(heads[2]).getByText("고객 관리형")).toBeInTheDocument();

    expect(cellOf("bob", "ReadOnlyAccess")).toHaveAccessibleName("bob · ReadOnlyAccess: 없음");
    expect(cellOf("alice", "ReadOnlyAccess")).toHaveAccessibleName("alice · ReadOnlyAccess: 직접 붙음");
    expect(cellOf("alice", "app-deploy")).toHaveAccessibleName("alice · app-deploy: dev-team 그룹에서 받음");
    expect(cellOf("dev-team", "app-deploy")).toHaveAccessibleName("dev-team · app-deploy: 직접 붙음");
    expect(cellOf("app-role", "ReadOnlyAccess")).toHaveAccessibleName("app-role · ReadOnlyAccess: 직접 붙음");
  });

  test("a policy attached directly and through a group says both", () => {
    const both = principal("user", "dana", { attached: [deployPolicy.arn], groups: ["dev-team"] });
    setup(sampleOverview({ users: [alice, bob, ciBot, both] }));
    expect(cellOf("dana", "app-deploy")).toHaveAccessibleName("dana · app-deploy: 직접 붙음, dev-team 그룹에서도 받음");
  });

  test("a policy that comes from two groups names both", () => {
    const zed = principal("user", "zed", { groups: ["admins", "dev-team"] });
    setup(sampleOverview({ users: [alice, zed], groups: [devTeam, { ...admins, attached: [deployPolicy.arn] }] }));
    expect(cellOf("zed", "app-deploy")).toHaveAccessibleName("zed · app-deploy: admins, dev-team 그룹에서 받음");
  });

  test("shows a message when no row matches", () => {
    setup(sampleOverview({ users: [], groups: [], roles: [] }));
    expect(screen.getByText("보여줄 행이 없어요")).toBeInTheDocument();
  });
});

describe("clicking a cell", () => {
  test("marks it and a second click takes the mark back", () => {
    setup();
    fireEvent.click(cellOf("bob", "ReadOnlyAccess"));
    expect(cellOf("bob", "ReadOnlyAccess")).toHaveAccessibleName("bob · ReadOnlyAccess: 붙일 예정");
    expect(tray()).toBe("변경 1개 · ReadOnlyAccess 붙이기 · bob");
    fireEvent.click(cellOf("bob", "ReadOnlyAccess"));
    expect(cellOf("bob", "ReadOnlyAccess")).toHaveAccessibleName("bob · ReadOnlyAccess: 없음");
    expect(tray()).toBeNull();
  });

  test("an attached cell is marked for detaching, and a second click keeps it attached", () => {
    setup();
    fireEvent.click(cellOf("alice", "ReadOnlyAccess"));
    expect(cellOf("alice", "ReadOnlyAccess")).toHaveAccessibleName("alice · ReadOnlyAccess: 뗄 예정");
    expect(tray()).toBe("변경 1개 · ReadOnlyAccess 떼기 · alice");
    fireEvent.click(cellOf("alice", "ReadOnlyAccess"));
    expect(cellOf("alice", "ReadOnlyAccess")).toHaveAccessibleName("alice · ReadOnlyAccess: 직접 붙음");
    expect(tray()).toBeNull();
  });

  test("a real click (pointer down, up, click) toggles exactly once", async () => {
    setup();
    await userEvent.click(cellOf("bob", "ReadOnlyAccess"));
    expect(cellOf("bob", "ReadOnlyAccess")).toHaveAccessibleName("bob · ReadOnlyAccess: 붙일 예정");
    expect(tray()).toBe("변경 1개 · ReadOnlyAccess 붙이기 · bob");
    await userEvent.click(cellOf("bob", "ReadOnlyAccess"));
    expect(tray()).toBeNull();
  });

  test("a group or a role can be attached to as well", () => {
    setup();
    fireEvent.click(cellOf("admins", "ReadOnlyAccess"));
    fireEvent.click(cellOf("partner-access", "app-deploy"));
    expect(tray()).toBe("변경 2개 · ReadOnlyAccess 붙이기 · admins 외 1개");
  });
});

describe("a cell that is only inherited", () => {
  test("explains where it comes from, queues nothing, and goes to the group row", () => {
    setup();
    fireEvent.click(cellOf("alice", "app-deploy"));
    expect(screen.getByText("dev-team 그룹에서 받아요")).toBeInTheDocument();
    expect(tray()).toBeNull();
    expect(cellOf("alice", "app-deploy")).toHaveAccessibleName("alice · app-deploy: dev-team 그룹에서 받음");

    fireEvent.click(screen.getByRole("button", { name: "그룹 행으로 가기" }));
    expect(screen.getByRole("button", { name: "dev-team" })).toHaveFocus();
    expect(screen.queryByText("dev-team 그룹에서 받아요")).not.toBeInTheDocument();
  });

  test("lists every group it comes from, each with its own way to the row", () => {
    const zed = principal("user", "zed", { groups: ["admins", "dev-team"] });
    setup(sampleOverview({ users: [alice, zed], groups: [devTeam, { ...admins, attached: [deployPolicy.arn] }] }));
    fireEvent.click(cellOf("zed", "app-deploy"));
    expect(screen.getByText("admins 그룹에서 받아요")).toBeInTheDocument();
    expect(screen.getByText("dev-team 그룹에서 받아요")).toBeInTheDocument();
    const [toAdmins] = screen.getAllByRole("button", { name: "그룹 행으로 가기" });
    fireEvent.click(toAdmins);
    expect(screen.getByRole("button", { name: "admins" })).toHaveFocus();
  });

  test("Escape closes the note and gives the focus back to the cell", async () => {
    setup();
    fireEvent.click(cellOf("alice", "app-deploy"));
    const toRow = screen.getByRole("button", { name: "그룹 행으로 가기" });
    expect(toRow).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("dev-team 그룹에서 받아요")).not.toBeInTheDocument();
    expect(cellOf("alice", "app-deploy")).toHaveFocus();
  });

  test("pressing somewhere else closes the note, pressing inside it does not", () => {
    setup();
    fireEvent.click(cellOf("alice", "app-deploy"));
    fireEvent.pointerDown(screen.getByText("dev-team 그룹에서 받아요"));
    expect(screen.getByText("dev-team 그룹에서 받아요")).toBeInTheDocument();
    fireEvent.pointerDown(document.body, { button: 0 }); // 초점을 가져가지 않는 곳
    expect(screen.queryByText("dev-team 그룹에서 받아요")).not.toBeInTheDocument();
  });

  test("pressing the same cell again closes the note", () => {
    setup();
    fireEvent.click(cellOf("alice", "app-deploy"));
    fireEvent.click(cellOf("alice", "app-deploy"));
    expect(screen.queryByText("dev-team 그룹에서 받아요")).not.toBeInTheDocument();
  });

  test("when the group row is hidden by the kind chip, the button opens the group instead", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("checkbox", { name: "그룹" }));
    expect(screen.queryByRole("button", { name: "dev-team" })).not.toBeInTheDocument();
    fireEvent.click(cellOf("alice", "app-deploy"));
    fireEvent.click(screen.getByRole("button", { name: "그룹 행으로 가기" }));
    expect(props.onOpen).toHaveBeenCalledWith({ view: "groups", id: devTeam.arn });
  });
});

describe("a locked row", () => {
  test("has disabled cells and shows why", () => {
    setup();
    const cells = ["AdministratorAccess", "ReadOnlyAccess", "app-deploy"].map((c) => cellOf("AWSServiceRoleForSupport", c));
    cells.forEach((c) => expect(c).toBeDisabled());
    expect(screen.getByText("서비스 연결 역할은 AWS가 관리해서 바꿀 수 없어요")).toBeVisible();
    // 다른 행은 그대로 누를 수 있다
    expect(cellOf("partner-access", "ReadOnlyAccess")).toBeEnabled();
    fireEvent.click(cells[1]);
    expect(tray()).toBeNull();
  });

  test("an Identity Center role is locked with its own reason", () => {
    const sso = principal("role", "AWSReservedSSO_Admin_1a2b3c", { path: "/aws-reserved/sso.amazonaws.com/" });
    setup(sampleOverview({ roles: [appRole, sso] }));
    expect(cellOf("AWSReservedSSO_Admin_1a2b3c", "ReadOnlyAccess")).toBeDisabled();
    expect(screen.getByText("Identity Center가 관리하는 역할이라 바꿀 수 없어요")).toBeVisible();
  });

  test("painting over it queues nothing", () => {
    setup();
    press(cellOf("bob", "ReadOnlyAccess"));
    fireEvent.pointerEnter(cellOf("AWSServiceRoleForSupport", "ReadOnlyAccess"), { buttons: 1 });
    fireEvent.pointerEnter(cellOf("partner-access", "ReadOnlyAccess"), { buttons: 1 });
    fireEvent.pointerUp(window);
    expect(tray()).toBe("변경 2개 · ReadOnlyAccess 붙이기 · bob 외 1개");
    expect(cellOf("AWSServiceRoleForSupport", "ReadOnlyAccess")).toHaveAccessibleName("AWSServiceRoleForSupport · ReadOnlyAccess: 없음");
  });
});

describe("dragging", () => {
  test("paints every cell it passes with what the first cell became", () => {
    setup();
    press(cellOf("bob", "ReadOnlyAccess"));
    expect(cellOf("bob", "ReadOnlyAccess")).toHaveAccessibleName("bob · ReadOnlyAccess: 붙일 예정"); // 처음 칸은 바로 바뀐다
    fireEvent.pointerEnter(cellOf("alice", "ReadOnlyAccess"), { buttons: 1 }); // 이미 붙어 있어서 그대로
    fireEvent.pointerEnter(cellOf("ci-bot", "ReadOnlyAccess"), { buttons: 1 });
    fireEvent.pointerUp(cellOf("ci-bot", "ReadOnlyAccess"));
    expect(cellOf("alice", "ReadOnlyAccess")).toHaveAccessibleName("alice · ReadOnlyAccess: 직접 붙음");
    expect(cellOf("ci-bot", "ReadOnlyAccess")).toHaveAccessibleName("ci-bot · ReadOnlyAccess: 붙일 예정");
    expect(tray()).toBe("변경 2개 · ReadOnlyAccess 붙이기 · bob 외 1개");
  });

  test("a drag that starts on an attached cell takes the policy off the cells it passes", () => {
    setup();
    press(cellOf("alice", "ReadOnlyAccess"));
    fireEvent.pointerEnter(cellOf("bob", "ReadOnlyAccess"), { buttons: 1 }); // 안 붙어 있어서 그대로
    fireEvent.pointerEnter(cellOf("app-role", "ReadOnlyAccess"), { buttons: 1 });
    fireEvent.pointerUp(window);
    expect(cellOf("alice", "ReadOnlyAccess")).toHaveAccessibleName("alice · ReadOnlyAccess: 뗄 예정");
    expect(cellOf("bob", "ReadOnlyAccess")).toHaveAccessibleName("bob · ReadOnlyAccess: 없음");
    expect(cellOf("app-role", "ReadOnlyAccess")).toHaveAccessibleName("app-role · ReadOnlyAccess: 뗄 예정");
    expect(tray()).toBe("변경 2개 · ReadOnlyAccess 떼기 · alice 외 1개");
  });

  test("a cell that already has a change in the wanted direction is left alone, and one that has the opposite one loses it", () => {
    setup();
    fireEvent.click(cellOf("ci-bot", "ReadOnlyAccess")); // 붙일 예정
    fireEvent.click(cellOf("partner-access", "ReadOnlyAccess")); // 붙일 예정
    // 안 붙은 칸에서 시작하면 목표는 "붙음"이다
    press(cellOf("bob", "ReadOnlyAccess"));
    fireEvent.pointerEnter(cellOf("ci-bot", "ReadOnlyAccess"), { buttons: 1 });
    fireEvent.pointerUp(window);
    expect(tray()).toBe("변경 3개 · ReadOnlyAccess 붙이기 · ci-bot 외 2개");
    // 붙은 칸에서 시작하면 목표는 "안 붙음"이라서 대기 중인 붙이기는 지워진다
    press(cellOf("alice", "ReadOnlyAccess"));
    fireEvent.pointerEnter(cellOf("ci-bot", "ReadOnlyAccess"), { buttons: 1 });
    fireEvent.pointerUp(window);
    expect(cellOf("ci-bot", "ReadOnlyAccess")).toHaveAccessibleName("ci-bot · ReadOnlyAccess: 없음");
    expect(tray()).toBe("변경 3개 · ReadOnlyAccess 붙이기 · partner-access 외 2개");
  });

  test("skips a cell that is only inherited without opening its note", () => {
    setup();
    press(cellOf("bob", "AdministratorAccess"));
    fireEvent.pointerEnter(cellOf("alice", "app-deploy"), { buttons: 1 });
    fireEvent.pointerUp(window);
    expect(tray()).toBe("변경 1개 · AdministratorAccess 붙이기 · bob");
    expect(screen.queryByText("dev-team 그룹에서 받아요")).not.toBeInTheDocument();
  });

  test("stops when the button is let go", () => {
    setup();
    press(cellOf("bob", "ReadOnlyAccess"));
    fireEvent.pointerUp(window);
    fireEvent.pointerEnter(cellOf("ci-bot", "ReadOnlyAccess"), { buttons: 0 });
    expect(tray()).toBe("변경 1개 · ReadOnlyAccess 붙이기 · bob");
  });

  test("stops when the pointer is cancelled or the window loses focus", () => {
    setup();
    press(cellOf("bob", "ReadOnlyAccess"));
    fireEvent.pointerCancel(window);
    fireEvent.pointerEnter(cellOf("ci-bot", "ReadOnlyAccess"), { buttons: 1 });
    expect(tray()).toBe("변경 1개 · ReadOnlyAccess 붙이기 · bob");

    press(cellOf("partner-access", "ReadOnlyAccess"));
    fireEvent.blur(window);
    fireEvent.pointerEnter(cellOf("ci-bot", "ReadOnlyAccess"), { buttons: 1 }); // 계속 칠하고 있다면 여기도 붙인다
    expect(tray()).toBe("변경 2개 · ReadOnlyAccess 붙이기 · bob 외 1개");
    expect(cellOf("ci-bot", "ReadOnlyAccess")).toHaveAccessibleName("ci-bot · ReadOnlyAccess: 없음");
  });

  test("a drag that ends on another cell leaves no click behind: the first cell still answers a later click", () => {
    setup();
    press(cellOf("bob", "ReadOnlyAccess"));
    fireEvent.pointerEnter(cellOf("ci-bot", "ReadOnlyAccess"), { buttons: 1 });
    fireEvent.pointerUp(cellOf("ci-bot", "ReadOnlyAccess"));
    expect(tray()).toBe("변경 2개 · ReadOnlyAccess 붙이기 · bob 외 1개");
    fireEvent.click(cellOf("bob", "ReadOnlyAccess")); // 끌기에서 이미 처리한 칸이라고 건너뛰면 안 된다
    expect(tray()).toBe("변경 1개 · ReadOnlyAccess 붙이기 · ci-bot");
  });

  test("moving over cells without pressing paints nothing", () => {
    setup();
    fireEvent.pointerEnter(cellOf("bob", "ReadOnlyAccess"), { buttons: 0 });
    expect(tray()).toBeNull();
  });

  test("only the primary button paints", () => {
    setup();
    fireEvent.pointerDown(cellOf("bob", "ReadOnlyAccess"), { button: 2, buttons: 2 });
    fireEvent.pointerEnter(cellOf("ci-bot", "ReadOnlyAccess"), { buttons: 2 });
    expect(tray()).toBeNull();
  });
});

describe("the keyboard", () => {
  test("arrows move the focus between cells and the headers, and only one cell is a tab stop", async () => {
    setup();
    focusCell(cellOf("bob", "ReadOnlyAccess"));
    await userEvent.keyboard("{ArrowDown}");
    expect(cellOf("ci-bot", "ReadOnlyAccess")).toHaveFocus();
    const stops = within(grid())
      .getAllByRole("button")
      .filter((b) => b.getAttribute("tabindex") === "0" && /· .+: /.test(b.getAttribute("aria-label") ?? ""));
    expect(stops).toEqual([cellOf("ci-bot", "ReadOnlyAccess")]);

    await userEvent.keyboard("{ArrowRight}");
    expect(cellOf("ci-bot", "app-deploy")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}"); // 끝에서는 멈춘다
    expect(cellOf("ci-bot", "app-deploy")).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("button", { name: "ci-bot" })).toHaveFocus(); // 행 머리
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("button", { name: "ci-bot" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(cellOf("alice", "AdministratorAccess")).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "AdministratorAccess" })).toHaveFocus(); // 열 머리
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("button", { name: "AdministratorAccess" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("button", { name: "AdministratorAccess" })).toHaveFocus(); // 왼쪽 위 모서리에는 갈 곳이 없다
  });

  test("Space toggles the focused cell", async () => {
    setup();
    focusCell(cellOf("bob", "ReadOnlyAccess"));
    await userEvent.keyboard("{ArrowDown} ");
    expect(cellOf("ci-bot", "ReadOnlyAccess")).toHaveAccessibleName("ci-bot · ReadOnlyAccess: 붙일 예정");
    expect(tray()).toBe("변경 1개 · ReadOnlyAccess 붙이기 · ci-bot");
    await userEvent.keyboard(" ");
    expect(tray()).toBeNull();
  });

  test("Enter presses the focused cell like a button does", async () => {
    setup();
    focusCell(cellOf("bob", "ReadOnlyAccess"));
    await userEvent.keyboard("{Enter}");
    expect(cellOf("bob", "ReadOnlyAccess")).toHaveAccessibleName("bob · ReadOnlyAccess: 붙일 예정");
    expect(tray()).toBe("변경 1개 · ReadOnlyAccess 붙이기 · bob"); // 한 번만
  });

  test("Space on an inherited cell tells where it comes from", async () => {
    setup();
    focusCell(cellOf("alice", "app-deploy"));
    await userEvent.keyboard(" ");
    expect(screen.getByText("dev-team 그룹에서 받아요")).toBeInTheDocument();
    expect(tray()).toBeNull();
  });

  test("Shift+arrows widen a range and Space paints it with what the first cell would become", async () => {
    setup();
    focusCell(cellOf("bob", "ReadOnlyAccess"));
    await userEvent.keyboard("{ArrowDown} "); // ci-bot을 먼저 붙일 예정으로
    await userEvent.keyboard("{ArrowUp}");
    expect(cellOf("bob", "ReadOnlyAccess")).toHaveFocus();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(cellOf("ci-bot", "ReadOnlyAccess")).toHaveFocus();
    const selected = () => within(grid()).queryAllByRole("gridcell", { selected: true }).map((td) => within(td).getByRole("button").getAttribute("aria-label")?.split(":")[0]);
    expect(selected()).toEqual(["bob · ReadOnlyAccess", "ci-bot · ReadOnlyAccess"]);

    await userEvent.keyboard(" "); // 기준 칸(bob)은 안 붙어 있었으니 목표는 "붙음"이다. ci-bot은 이미 그렇다
    expect(tray()).toBe("변경 2개 · ReadOnlyAccess 붙이기 · ci-bot 외 1개");
    expect(cellOf("bob", "ReadOnlyAccess")).toHaveAccessibleName("bob · ReadOnlyAccess: 붙일 예정");
    expect(selected()).toHaveLength(2); // 칠한 뒤에도 범위는 남는다

    await userEvent.keyboard(" "); // 다시 누르면 기준 칸을 한 번 더 토글한 결과(안 붙음)로 칠한다
    expect(tray()).toBeNull();
  });

  test("Escape clears the range, and a plain arrow does too", async () => {
    setup();
    focusCell(cellOf("bob", "ReadOnlyAccess"));
    await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowRight}{/Shift}");
    expect(within(grid()).queryAllByRole("gridcell", { selected: true })).toHaveLength(4);
    await userEvent.keyboard("{Escape}");
    expect(within(grid()).queryAllByRole("gridcell", { selected: true })).toHaveLength(0);
    expect(cellOf("ci-bot", "app-deploy")).toHaveFocus();
    await userEvent.keyboard(" "); // 이제 Space는 초점이 있는 칸 하나만 바꾼다
    expect(tray()).toBe("변경 1개 · app-deploy 붙이기 · ci-bot");

    await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(within(grid()).queryAllByRole("gridcell", { selected: true })).toHaveLength(2);
    await userEvent.keyboard("{ArrowLeft}");
    expect(within(grid()).queryAllByRole("gridcell", { selected: true })).toHaveLength(0);
  });

  test("a range skips the cells that cannot change", async () => {
    setup();
    focusCell(cellOf("alice", "ReadOnlyAccess"));
    // alice/ReadOnly는 붙어 있다 → 목표는 "안 붙음". 오른쪽 app-deploy는 그룹으로만 받아서 건너뛴다
    await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowDown}{/Shift} ");
    expect(cellOf("alice", "ReadOnlyAccess")).toHaveAccessibleName("alice · ReadOnlyAccess: 뗄 예정");
    expect(cellOf("alice", "app-deploy")).toHaveAccessibleName("alice · app-deploy: dev-team 그룹에서 받음");
    expect(cellOf("bob", "ReadOnlyAccess")).toHaveAccessibleName("bob · ReadOnlyAccess: 없음");
    expect(tray()).toBe("변경 1개 · ReadOnlyAccess 떼기 · alice");
  });

  test("a range that starts on a cell that cannot change does nothing", async () => {
    setup();
    focusCell(cellOf("alice", "app-deploy"));
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift} ");
    expect(tray()).toBeNull();
  });

  test("the focus passes over a locked row but stops on its header", async () => {
    setup();
    focusCell(cellOf("app-role", "ReadOnlyAccess"));
    await userEvent.keyboard("{ArrowDown}");
    expect(cellOf("partner-access", "ReadOnlyAccess")).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(cellOf("app-role", "ReadOnlyAccess")).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}"); // 첫 열을 지나 행 머리로
    expect(screen.getByRole("button", { name: "app-role" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "AWSServiceRoleForSupport" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "AWSServiceRoleForSupport" })).toHaveFocus(); // 칸은 모두 꺼져 있다
  });

  test("Enter on a header opens that principal or policy", async () => {
    const { props } = setup();
    focusCell(screen.getByRole("button", { name: "alice" }));
    await userEvent.keyboard("{Enter}");
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "users", id: alice.arn });
    focusCell(screen.getByRole("button", { name: "dev-team" }));
    await userEvent.keyboard("{Enter}");
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "groups", id: devTeam.arn });
    focusCell(screen.getByRole("button", { name: "app-role" }));
    await userEvent.keyboard("{Enter}");
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "roles", id: appRole.arn });
    focusCell(screen.getByRole("button", { name: "ReadOnlyAccess" }));
    await userEvent.keyboard("{Enter}");
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "policies", id: readOnlyPolicy.id });
    expect(props.onOpen).toHaveBeenCalledTimes(4); // 한 번에 한 번만
  });

  test("clicking a header opens it too", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "AdministratorAccess" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "policies", id: adminPolicy.id });
    fireEvent.click(screen.getByRole("button", { name: "ci-bot" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "users", id: ciBot.arn });
  });

  test("keys with ⌘, Ctrl or Alt are left to the app", async () => {
    setup();
    focusCell(cellOf("bob", "ReadOnlyAccess"));
    await userEvent.keyboard("{Meta>}{ArrowDown}{/Meta}");
    expect(cellOf("bob", "ReadOnlyAccess")).toHaveFocus();
  });

  test("Tab reaches the grid even when the cell that was active has scrolled out of the rendered rows", async () => {
    const users = Array.from({ length: 100 }, (_, i) => principal("user", `user-${String(i).padStart(3, "0")}`, { attached: [readOnlyPolicy.arn] }));
    setup(sampleOverview({ users, groups: [], roles: [] }));
    focusCell(cellOf("user-000", "ReadOnlyAccess"));
    const scroller = grid().closest(".asg-scroll") as HTMLElement;
    scroller.scrollTop = 60 * ROW_H;
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: /^user-000 · / })).not.toBeInTheDocument();
    // 초점이 있던 칸은 그려지지 않으니, 지금 그려진 첫 행의 머리가 탭이 닿는 곳이 된다
    const firstHead = within(within(grid()).getAllByRole("rowheader")[0]).getAllByRole("button")[0];
    expect(firstHead).toHaveAttribute("tabindex", "0");
    expect(
      within(grid())
        .getAllByRole("button")
        .filter((b) => b.getAttribute("tabindex") === "0" && /· .+: /.test(b.getAttribute("aria-label") ?? "")),
    ).toHaveLength(0);
  });
});

describe("when the rows on screen change", () => {
  const toolbarFilter = () => screen.getByRole("textbox", { name: "툴바 필터" });

  test("an open row menu closes", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "bob 행 메뉴" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.change(toolbarFilter(), { target: { value: "alice" } });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  test("an open note on an inherited cell closes", () => {
    setup();
    fireEvent.click(cellOf("alice", "app-deploy"));
    fireEvent.change(toolbarFilter(), { target: { value: "ali" } });
    expect(screen.queryByText("dev-team 그룹에서 받아요")).not.toBeInTheDocument();
  });

  test("a range is dropped, because it pointed at rows by position", async () => {
    setup();
    focusCell(cellOf("bob", "ReadOnlyAccess"));
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(within(grid()).queryAllByRole("gridcell", { selected: true })).toHaveLength(2);
    fireEvent.change(toolbarFilter(), { target: { value: "o" } });
    expect(within(grid()).queryAllByRole("gridcell", { selected: true })).toHaveLength(0);
  });

  test("scrolled far down, a filter that leaves few rows shows them instead of an empty page", () => {
    const users = Array.from({ length: 300 }, (_, i) => principal("user", `user-${String(i).padStart(3, "0")}`, { attached: i === 0 ? [readOnlyPolicy.arn] : [] }));
    setup(sampleOverview({ users, groups: [], roles: [] }));
    const scroller = grid().closest(".asg-scroll") as HTMLElement;
    scroller.scrollTop = 200 * ROW_H;
    fireEvent.scroll(scroller);
    fireEvent.change(toolbarFilter(), { target: { value: "user-00" } });
    expect(screen.getByRole("button", { name: "user-005" })).toBeInTheDocument();
  });
});

describe("tall tables", () => {
  const manyUsers = () => Array.from({ length: 300 }, (_, i) => principal("user", `user-${String(i).padStart(3, "0")}`, { attached: i % 7 === 0 ? [readOnlyPolicy.arn] : [] }));

  test("render only the rows in view", () => {
    setup(sampleOverview({ users: manyUsers(), groups: [], roles: [] }));
    const rows = within(grid()).getAllByRole("row");
    expect(rows.length).toBeLessThan(60);
    expect(rows.length).toBeGreaterThan(10);
    expect(screen.getByRole("button", { name: "user-000" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "user-150" })).not.toBeInTheDocument();
    expect(grid()).toHaveAttribute("aria-rowcount", "302"); // 머리 행 + 종류 머리 + 300명
  });

  test("scrolling moves the window", () => {
    setup(sampleOverview({ users: manyUsers(), groups: [], roles: [] }));
    const scroller = grid().closest(".asg-scroll") as HTMLElement;
    scroller.scrollTop = 150 * ROW_H;
    fireEvent.scroll(scroller);
    expect(screen.getByRole("button", { name: "user-150" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "user-000" })).not.toBeInTheDocument();
    expect(within(grid()).getAllByRole("row").length).toBeLessThan(60);
    // 그리지 않은 행의 높이는 위아래 빈 줄이 채워서, 스크롤 막대와 보이는 행의 자리가 그대로다
    const heights = [...grid().querySelectorAll("tbody > tr")].map((tr) => parseInt((tr as HTMLElement).style.height, 10));
    expect(heights.reduce((sum, h) => sum + h, 0)).toBe(301 * ROW_H); // 종류 머리 1 + 사용자 300
    // 보이는 행은 자기 자리를 안다
    const row = screen.getByRole("button", { name: "user-150" }).closest("tr") as HTMLElement;
    expect(row).toHaveAttribute("aria-rowindex", String(150 + 3)); // 머리 행 1 + 종류 머리 1 + 1부터 세기
  });

  test("the arrow keys keep going past the rows that are drawn", async () => {
    setup(sampleOverview({ users: manyUsers(), groups: [], roles: [] }));
    focusCell(cellOf("user-000", "ReadOnlyAccess"));
    for (let i = 0; i < 40; i++) await userEvent.keyboard("{ArrowDown}");
    expect(cellOf("user-040", "ReadOnlyAccess")).toHaveFocus();
    expect(within(grid()).getAllByRole("row").length).toBeLessThan(60);
  });

  test("a painted cell far from the top is still painted", () => {
    setup(sampleOverview({ users: manyUsers(), groups: [], roles: [] }));
    const scroller = grid().closest(".asg-scroll") as HTMLElement;
    scroller.scrollTop = 150 * ROW_H;
    fireEvent.scroll(scroller);
    fireEvent.click(cellOf("user-151", "ReadOnlyAccess"));
    expect(tray()).toBe("변경 1개 · ReadOnlyAccess 붙이기 · user-151");
  });
});

describe("rows without attached data", () => {
  test("a principal the backend sent without attached or groups has only empty cells", () => {
    const bare = principal("user", "bare");
    setup(sampleOverview({ users: [alice, bare] }));
    expect(cellOf("bare", "ReadOnlyAccess")).toHaveAccessibleName("bare · ReadOnlyAccess: 없음");
  });
});
