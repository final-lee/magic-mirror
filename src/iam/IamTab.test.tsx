import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { iamApi } from "./api";
import {
  alice,
  aliceView,
  appRole,
  appRoleView,
  bob,
  deployPolicy,
  deployPolicyView,
  devTeam,
  devTeamView,
  s3WriteGrants,
  sampleOverview,
} from "./fixtures";
import { IamTab } from "./IamTab";

vi.mock("./api", () => ({
  iamApi: { overview: vi.fn(), principal: vi.fn(), principalActions: vi.fn(), policy: vi.fn(), accessKeys: vi.fn() },
}));
let mouseNav: ((dir: "back" | "forward") => void) | null = null;
vi.mock("../explorer/api", () => ({
  onMouseNav: vi.fn(async (cb: (dir: "back" | "forward") => void) => {
    mouseNav = cb;
    return () => {
      if (mouseNav === cb) mouseNav = null;
    };
  }),
}));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));

const m = vi.mocked(iamApi);
type Props = React.ComponentProps<typeof IamTab>;
const baseProps: Props = { profile: "prod", active: true, filter: "", focus: null, nonce: 0 };

function setup(extra: Partial<Props> = {}) {
  const utils = renderWithClient(<IamTab {...baseProps} {...extra} />);
  const update = (next: Partial<Props>) =>
    utils.rerender(
      <QueryClientProvider client={utils.qc as QueryClient}>
        <IamTab {...baseProps} {...extra} {...next} />
      </QueryClientProvider>,
    );
  return { ...utils, update };
}

// 상세 화면에는 이동 경로(breadcrumb)에도 같은 이름의 버튼이 있어서, 메뉴는 nav 안에서만 찾는다.
const menu = () => within(screen.getByRole("navigation", { name: "IAM 메뉴" }));
const nav = async (name: RegExp) => {
  await screen.findByRole("navigation", { name: "IAM 메뉴" });
  return menu().getByRole("button", { name });
};
const listRow = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;
const openUser = async (name = "alice") => {
  fireEvent.doubleClick(await screen.findByText(name));
  return screen.findByRole("heading", { name });
};
const metaKey = (key: "[" | "]") => fireEvent.keyDown(window, { key, metaKey: true });

beforeEach(() => {
  vi.clearAllMocks();
  mouseNav = null;
  document.querySelectorAll(".modal").forEach((e) => e.remove());
  m.overview.mockResolvedValue(sampleOverview());
  m.principal.mockImplementation(async (_p, arn) =>
    arn === appRole.arn ? appRoleView() : arn === devTeam.arn ? devTeamView() : arn === bob.arn ? aliceView({ summary: bob }) : aliceView(),
  );
  m.principalActions.mockResolvedValue(s3WriteGrants);
  m.policy.mockResolvedValue(deployPolicyView());
  m.accessKeys.mockResolvedValue([]);
});

describe("loading", () => {
  test("shows a message until the overview arrives", async () => {
    let resolve!: (v: ReturnType<typeof sampleOverview>) => void;
    m.overview.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    expect(screen.getByText(/IAM 정보를 불러오는 중이에요/)).toBeInTheDocument();
    await act(async () => resolve(sampleOverview()));
    expect(await screen.findByText("alice")).toBeInTheDocument();
  });

  test("shows the error and retries", async () => {
    m.overview.mockRejectedValueOnce({ kind: "network", message: "timeout" });
    setup();
    expect(await screen.findByText("네트워크 오류: timeout")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("alice")).toBeInTheDocument();
  });

  test("loads the overview of the profile without forcing", async () => {
    setup();
    await screen.findByText("alice");
    expect(m.overview).toHaveBeenCalledWith("prod", false);
  });

  test("shows the warnings the backend collected", async () => {
    m.overview.mockResolvedValue(sampleOverview({ warnings: ["iam:GenerateCredentialReport 권한이 없어 일부 점검을 건너뛰었어요"] }));
    setup();
    expect(await screen.findByText("iam:GenerateCredentialReport 권한이 없어 일부 점검을 건너뛰었어요")).toBeInTheDocument();
  });
});

describe("menu and lists", () => {
  test("opens on the users list and always shows the SCP note", async () => {
    setup();
    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(menu().getByRole("button", { name: /사용자/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("조직 SCP와 리소스 기반 정책은 반영하지 않아요")).toBeInTheDocument();
  });

  test("the menu shows counts from the overview", async () => {
    setup();
    await screen.findByText("alice");
    const count = (name: RegExp) => within(menu().getByRole("button", { name })).getByTestId("nav-count").textContent;
    expect([count(/점검/), count(/사용자/), count(/그룹/), count(/역할/), count(/정책/)]).toEqual(["4", "3", "2", "3", "4"]);
  });

  test("switches between users, groups, roles and policies", async () => {
    setup();
    fireEvent.click(await nav(/그룹/));
    expect(screen.getByText("dev-team")).toBeInTheDocument();
    expect(screen.queryByText("alice")).not.toBeInTheDocument();
    fireEvent.click(menu().getByRole("button", { name: /역할/ }));
    expect(screen.getByText("app-role")).toBeInTheDocument();
    fireEvent.click(menu().getByRole("button", { name: /정책/ }));
    expect(screen.getByText("AdministratorAccess")).toBeInTheDocument();
    fireEvent.click(menu().getByRole("button", { name: /사용자/ }));
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  test("findings, who-can and the change log are placeholders for now", async () => {
    setup();
    fireEvent.click(await nav(/점검/));
    expect(screen.getByText("점검 화면은 곧 추가돼요")).toBeInTheDocument();
    fireEvent.click(menu().getByRole("button", { name: /누가 할 수 있나/ }));
    expect(screen.getByText("누가 할 수 있나 화면은 곧 추가돼요")).toBeInTheDocument();
    fireEvent.click(menu().getByRole("button", { name: /변경 기록/ }));
    expect(screen.getByText("변경 기록 화면은 곧 추가돼요")).toBeInTheDocument();
  });

  test("the toolbar filter narrows the list", async () => {
    const { update } = setup();
    await screen.findByText("alice");
    update({ filter: "bob" });
    expect(screen.queryByText("alice")).not.toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  test("shows the item count of the list in the header", async () => {
    setup();
    await screen.findByText("alice");
    expect(screen.getByText("3개")).toBeInTheDocument();
  });
});

describe("detail and history", () => {
  test("double-clicking a row opens the detail with a breadcrumb", async () => {
    setup();
    await openUser();
    expect(m.principal).toHaveBeenCalledWith("prod", alice.arn);
    expect(screen.queryByTestId("iam-list")).not.toBeInTheDocument();
    const crumb = screen.getByRole("navigation", { name: "현재 위치" });
    expect(within(crumb).getByRole("button", { name: "사용자" })).toBeInTheDocument();
    expect(within(crumb).getByText("alice")).toBeInTheDocument();
  });

  test("Enter opens the selected row", async () => {
    setup();
    fireEvent.click(await screen.findByText("bob"));
    fireEvent.keyDown(screen.getByTestId("iam-list"), { key: "Enter" });
    expect(await screen.findByRole("heading", { name: "bob" })).toBeInTheDocument();
  });

  test("back and forward buttons walk through the history and keep the selection", async () => {
    setup();
    const back = await screen.findByRole("button", { name: "뒤로" });
    const forward = screen.getByRole("button", { name: "앞으로" });
    expect(back).toBeDisabled();
    expect(forward).toBeDisabled();

    await openUser();
    expect(back).toBeEnabled();
    fireEvent.click(back);
    expect(screen.getByTestId("iam-list")).toBeInTheDocument();
    expect(listRow("alice")).toHaveAttribute("aria-selected", "true");
    expect(forward).toBeEnabled();
    fireEvent.click(forward);
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument();
  });

  test("clicking the first breadcrumb segment returns to the list", async () => {
    setup();
    await openUser();
    fireEvent.click(within(screen.getByRole("navigation", { name: "현재 위치" })).getByRole("button", { name: "사용자" }));
    expect(screen.getByTestId("iam-list")).toBeInTheDocument();
  });

  test("a policy opens its detail from the policy list", async () => {
    setup();
    fireEvent.click(await nav(/정책/));
    fireEvent.doubleClick(screen.getByText("app-deploy"));
    expect(await screen.findByRole("heading", { name: "app-deploy" })).toBeInTheDocument();
    expect(m.policy).toHaveBeenCalledWith("prod", deployPolicy.id);
  });

  test("⌘[ and ⌘] navigate back and forward", async () => {
    setup();
    await openUser();
    metaKey("[");
    expect(screen.getByTestId("iam-list")).toBeInTheDocument();
    metaKey("]");
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument();
  });

  test("an inactive tab ignores ⌘[ and the mouse buttons", async () => {
    setup({ active: false });
    await openUser();
    metaKey("[");
    expect(screen.getByRole("heading", { name: "alice" })).toBeInTheDocument();
    expect(mouseNav).toBeNull();
  });

  test("history keys are ignored while a dialog is open or while typing", async () => {
    setup();
    await openUser();
    const modal = document.body.appendChild(document.createElement("div"));
    modal.className = "modal";
    metaKey("[");
    expect(screen.getByRole("heading", { name: "alice" })).toBeInTheDocument();
    modal.remove();

    const input = screen.getByRole("searchbox", { name: "서비스 필터" });
    input.focus();
    metaKey("[");
    expect(screen.getByRole("heading", { name: "alice" })).toBeInTheDocument();
    input.blur();
    metaKey("[");
    expect(screen.getByTestId("iam-list")).toBeInTheDocument();
  });

  test("the mouse back and forward buttons navigate (native mouse-nav event)", async () => {
    setup();
    await openUser();
    await waitFor(() => expect(mouseNav).not.toBeNull());
    act(() => mouseNav!("back"));
    expect(screen.getByTestId("iam-list")).toBeInTheDocument();
    act(() => mouseNav!("forward"));
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument();
  });

  test("mouse buttons are ignored while a dialog is open", async () => {
    setup();
    await openUser();
    await waitFor(() => expect(mouseNav).not.toBeNull());
    const modal = document.body.appendChild(document.createElement("div"));
    modal.className = "modal";
    act(() => mouseNav!("back"));
    expect(screen.getByRole("heading", { name: "alice" })).toBeInTheDocument();
    modal.remove();
  });

  test("stops listening to the mouse when the tab becomes inactive", async () => {
    const { update } = setup();
    await screen.findByText("alice");
    await waitFor(() => expect(mouseNav).not.toBeNull());
    update({ active: false });
    await waitFor(() => expect(mouseNav).toBeNull());
  });
});

describe("opening a target (focus)", () => {
  test("a user ARN opens that user's detail, with the list behind it in the history", async () => {
    setup({ focus: bob.arn, nonce: 1 });
    expect(await screen.findByRole("heading", { name: "bob" })).toBeInTheDocument();
    expect(m.principal).toHaveBeenCalledWith("prod", bob.arn);
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(screen.getByTestId("iam-list")).toBeInTheDocument();
  });

  test("a role ARN opens the roles view", async () => {
    setup({ focus: appRole.arn, nonce: 1 });
    expect(await screen.findByRole("heading", { name: "app-role" })).toBeInTheDocument();
    expect(menu().getByRole("button", { name: /역할/ })).toHaveAttribute("aria-current", "page");
  });

  test("a policy ARN opens the policy detail by its id", async () => {
    setup({ focus: deployPolicy.arn, nonce: 1 });
    expect(await screen.findByRole("heading", { name: "app-deploy" })).toBeInTheDocument();
    expect(m.policy).toHaveBeenCalledWith("prod", deployPolicy.id);
  });

  test("a target missing from the overview is still opened by its ARN type", async () => {
    const arn = "arn:aws:iam::123456789012:role/new-role";
    m.principal.mockResolvedValue(appRoleView({ summary: { ...appRole, arn, name: "new-role" } }));
    setup({ focus: arn, nonce: 1 });
    expect(await screen.findByRole("heading", { name: "new-role" })).toBeInTheDocument();
    expect(m.principal).toHaveBeenCalledWith("prod", arn);
  });

  test("something that is not an IAM target is ignored", async () => {
    setup({ focus: "arn:aws:s3:::bucket", nonce: 1 });
    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(screen.getByTestId("iam-list")).toBeInTheDocument();
  });

  test("a new nonce moves an already open tab; opening without a target keeps the place", async () => {
    const { update } = setup();
    await screen.findByText("alice");
    update({ focus: bob.arn, nonce: 1 });
    expect(await screen.findByRole("heading", { name: "bob" })).toBeInTheDocument();
    update({ focus: null, nonce: 2 });
    expect(screen.getByRole("heading", { name: "bob" })).toBeInTheDocument();
    update({ focus: devTeam.arn, nonce: 3 });
    expect(await screen.findByRole("heading", { name: "dev-team" })).toBeInTheDocument();
  });

  test("focusing again with the same nonce does not navigate again", async () => {
    const { update } = setup({ focus: bob.arn, nonce: 1 });
    await screen.findByRole("heading", { name: "bob" });
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    update({ focus: bob.arn, nonce: 1 });
    expect(screen.getByTestId("iam-list")).toBeInTheDocument();
  });
});

describe("navigating inside the details", () => {
  test("a source in the drilldown opens its policy; back restores the tab and the open cell", async () => {
    setup();
    await openUser();
    fireEvent.click(await screen.findByRole("button", { name: /Amazon S3 쓰기/ }));
    const putObject = (await screen.findByText("s3:PutObject")).closest("li") as HTMLElement;
    fireEvent.click(within(putObject).getByRole("button", { name: "app-deploy" }));
    expect(await screen.findByRole("heading", { name: "app-deploy" })).toBeInTheDocument();
    expect(m.policy).toHaveBeenCalledWith("prod", deployPolicy.id);

    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Amazon S3 쓰기/ })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("s3:PutObject")).toBeInTheDocument();
  });

  test("back restores the sub-tab that was open", async () => {
    setup();
    await openUser();
    fireEvent.click(await screen.findByRole("tab", { name: /^정책/ }));
    fireEvent.click(screen.getByRole("button", { name: "ReadOnlyAccess" }));
    expect(await screen.findByRole("heading", { name: "app-deploy" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(await screen.findByRole("tab", { name: /^정책/ })).toHaveAttribute("aria-selected", "true");
  });

  test("a policy's attached principal opens its detail", async () => {
    setup({ focus: deployPolicy.arn, nonce: 1 });
    fireEvent.click(await screen.findByRole("tab", { name: /^붙어 있는 대상/ }));
    fireEvent.click(screen.getByRole("button", { name: "dev-team" }));
    expect(await screen.findByRole("heading", { name: "dev-team" })).toBeInTheDocument();
    expect(menu().getByRole("button", { name: /그룹/ })).toHaveAttribute("aria-current", "page");
  });

  test("the group tab of a user opens the group in the groups view", async () => {
    setup();
    await openUser();
    fireEvent.click(await screen.findByRole("tab", { name: /^그룹/ }));
    fireEvent.click(screen.getByRole("button", { name: "dev-team" }));
    expect(await screen.findByRole("heading", { name: "dev-team" })).toBeInTheDocument();
  });
});

describe("refresh", () => {
  test("the refresh button rebuilds the snapshot", async () => {
    setup();
    await screen.findByText("alice");
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(m.overview).toHaveBeenLastCalledWith("prod", true));
  });

  test("shows when the data was fetched", async () => {
    setup();
    expect(await screen.findByText(/조회 .*\d{1,2}:\d{2}:\d{2}/)).toBeInTheDocument();
  });
});
