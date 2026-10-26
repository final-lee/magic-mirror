import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { desktop } from "../api/desktop";
import { renderWithClient } from "../test/utils";
import { iamApi } from "./api";
import {
  alice,
  aliceView,
  appRole,
  appRoleView,
  BADGES,
  bob,
  bobKeys,
  deployPolicy,
  devTeam,
  devTeamView,
  readOnlyPolicy,
  s3WriteGrants,
  sampleLastAccessed,
  sampleOverview,
  scratchInline,
} from "./fixtures";
import { PrincipalDetail } from "./PrincipalDetail";

vi.mock("./api", () => ({ iamApi: { principal: vi.fn(), principalActions: vi.fn(), accessKeys: vi.fn(), lastAccessed: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));

const m = vi.mocked(iamApi);

function setup(arn = alice.arn, extra: Partial<React.ComponentProps<typeof PrincipalDetail>> = {}) {
  const props = { onOpen: vi.fn(), onViewState: vi.fn(), onFix: vi.fn() };
  const utils = renderWithClient(<PrincipalDetail profile="prod" arn={arn} overview={sampleOverview()} {...props} {...extra} />);
  return { props, ...utils };
}
const tab = (name: RegExp | string) => screen.findByRole("tab", { name });
const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  m.principal.mockResolvedValue(aliceView());
  m.principalActions.mockResolvedValue(s3WriteGrants);
  m.accessKeys.mockResolvedValue(bobKeys);
  m.lastAccessed.mockResolvedValue(sampleLastAccessed());
});

describe("header", () => {
  test("shows the name, kind, ARN, badges, tags and dates", async () => {
    m.principal.mockResolvedValue(aliceView({ summary: { ...alice, badges: [BADGES.noMfa] } }));
    setup();
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument();
    expect(m.principal).toHaveBeenCalledWith("prod", alice.arn);
    expect(screen.getByText("사용자")).toBeInTheDocument();
    expect(screen.getByText(alice.arn)).toBeInTheDocument();
    expect(screen.getByText("MFA 없음")).toHaveClass("danger");
    expect(screen.getByText("team=platform")).toBeInTheDocument();
    expect(screen.getByText(/만든 날 2025-01-10/)).toBeInTheDocument();
    expect(screen.getByText(/마지막 사용 2026-10-20/)).toBeInTheDocument();
  });

  test("copies the ARN", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "ARN 복사" }));
    expect(desktop.copy).toHaveBeenCalledWith(alice.arn);
  });

  test("says when there is no usage record", async () => {
    m.principal.mockResolvedValue(aliceView({ summary: { ...alice, lastUsed: null } }));
    setup();
    expect(await screen.findByText(/마지막 사용 기록 없음/)).toBeInTheDocument();
  });

  test("shows a loading message, then an error", async () => {
    m.principal.mockRejectedValue({ kind: "accessDenied", action: "iam:GetAccountAuthorizationDetails" });
    setup();
    expect(screen.getByText("불러오는 중…")).toBeInTheDocument();
    expect(await screen.findByText("권한 없음 (iam:GetAccountAuthorizationDetails)")).toBeInTheDocument();
  });
});

describe("sub-tabs", () => {
  test("a user has permissions, policies, groups, access keys and unused permissions", async () => {
    setup();
    await screen.findByRole("heading", { name: "alice" });
    expect(tabNames()).toEqual(["권한", "정책 4", "그룹 1", "액세스 키", "안 쓰는 권한"]);
  });

  test("a role has permissions, policies, trust and unused permissions", async () => {
    m.principal.mockResolvedValue(appRoleView());
    setup(appRole.arn);
    await screen.findByRole("heading", { name: "app-role" });
    expect(tabNames()).toEqual(["권한", "정책 2", "신뢰 3", "안 쓰는 권한"]);
  });

  test("a group has permissions, policies and members", async () => {
    m.principal.mockResolvedValue(devTeamView());
    setup(devTeam.arn);
    await screen.findByRole("heading", { name: "dev-team" });
    expect(tabNames()).toEqual(["권한", "정책 1", "구성원 2"]);
  });

  test("permissions is the default and switching reports the view state", async () => {
    const { props } = setup();
    expect(await tab("권한")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(await tab(/^정책/));
    expect(screen.getByRole("tab", { name: /^정책/ })).toHaveAttribute("aria-selected", "true");
    expect(props.onViewState).toHaveBeenLastCalledWith({ tab: "policies", cell: null });
  });

  test("restores the initial tab", async () => {
    setup(alice.arn, { initialTab: "policies" });
    expect(await tab(/^정책/)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("table", { name: "붙은 정책" })).toBeInTheDocument();
  });

  test("restores the initial cell with its drilldown", async () => {
    setup(alice.arn, { initialCell: { prefix: "s3", name: "Amazon S3", level: "write" } });
    expect(await screen.findByText("s3:PutObject")).toBeInTheDocument();
    expect(m.principalActions).toHaveBeenCalledWith("prod", alice.arn, "s3", "write");
    expect(screen.getByRole("button", { name: /Amazon S3 쓰기/ })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("permissions", () => {
  test("renders the matrix, notes and unknown actions", async () => {
    m.principal.mockResolvedValue(aliceView({ notes: ["권한 경계 dev-boundary가 적용돼요"], unknownActions: ["foo:Bar", "baz:Qux"] }));
    setup();
    expect(await screen.findByRole("table", { name: "서비스별 권한" })).toBeInTheDocument();
    expect(screen.getByText("권한 경계 dev-boundary가 적용돼요")).toBeInTheDocument();
    expect(screen.getByText("카탈로그에 없는 작업 2개")).toBeInTheDocument();
    expect(screen.getByText("foo:Bar")).toBeInTheDocument();
  });

  test("admin-like principals show the banner", async () => {
    m.principal.mockResolvedValue(aliceView({ adminLike: true }));
    setup();
    expect(await screen.findByText("모든 서비스의 모든 작업이 허용돼요")).toBeInTheDocument();
  });

  test("clicking a cell opens the drilldown; clicking it again closes it", async () => {
    const { props } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /Amazon S3 쓰기/ }));
    expect(await screen.findByText("s3:PutObject")).toBeInTheDocument();
    expect(m.principalActions).toHaveBeenCalledWith("prod", alice.arn, "s3", "write");
    expect(props.onViewState).toHaveBeenLastCalledWith({ tab: "permissions", cell: { prefix: "s3", name: "Amazon S3", level: "write" } });
    expect(screen.getByRole("button", { name: /Amazon S3 쓰기/ })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: /Amazon S3 쓰기/ }));
    expect(screen.queryByText("s3:PutObject")).not.toBeInTheDocument();
    expect(props.onViewState).toHaveBeenLastCalledWith({ tab: "permissions", cell: null });
  });

  test("choosing another cell replaces the drilldown; the close button closes it", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: /Amazon S3 쓰기/ }));
    await screen.findByText("s3:PutObject");
    fireEvent.click(screen.getByRole("button", { name: /Amazon S3 읽기/ }));
    await waitFor(() => expect(m.principalActions).toHaveBeenLastCalledWith("prod", alice.arn, "s3", "read"));
    fireEvent.click(await screen.findByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("complementary", { name: "작업 상세" })).not.toBeInTheDocument();
  });

  test("a source in the drilldown navigates to its policy; a via group to the group", async () => {
    const { props } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /Amazon S3 쓰기/ }));
    const putObject = (await screen.findByText("s3:PutObject")).closest("li") as HTMLElement;
    fireEvent.click(within(putObject).getByRole("button", { name: "app-deploy" }));
    expect(props.onOpen).toHaveBeenCalledWith({ view: "policies", id: deployPolicy.id });
    fireEvent.click(within(putObject).getByRole("button", { name: "dev-team" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "groups", id: devTeam.arn });
  });

  test("the drilldown is only shown on the permissions tab", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: /Amazon S3 쓰기/ }));
    await screen.findByText("s3:PutObject");
    fireEvent.click(await tab(/^정책/));
    expect(screen.queryByText("s3:PutObject")).not.toBeInTheDocument();
    fireEvent.click(await tab("권한"));
    expect(await screen.findByText("s3:PutObject")).toBeInTheDocument();
  });
});

describe("policies", () => {
  async function openPolicies(view = aliceView(), arn = alice.arn) {
    m.principal.mockResolvedValue(view);
    const utils = setup(arn);
    fireEvent.click(await tab(/^정책/));
    return utils;
  }

  test("groups policies into direct, inherited, inline and boundary sections", async () => {
    await openPolicies();
    const table = within(screen.getByRole("table", { name: "붙은 정책" }));
    const sections = table.getAllByRole("columnheader").map((h) => h.textContent);
    expect(sections).toEqual(["직접 연결 1", "그룹에서 상속 1", "인라인 1", "권한 경계 1"]);
  });

  test("a row shows the type, the inheriting group and badges", async () => {
    await openPolicies();
    const readOnly = screen.getByRole("button", { name: "ReadOnlyAccess" }).closest("tr") as HTMLElement;
    expect(within(readOnly).getByText("AWS 관리형")).toBeInTheDocument();
    const deploy = screen.getByRole("button", { name: "app-deploy" }).closest("tr") as HTMLElement;
    expect(within(deploy).getByText("고객 관리형")).toBeInTheDocument();
    expect(within(deploy).getByRole("button", { name: "dev-team" })).toBeInTheDocument();
    expect(within(deploy).getByText(/에서 상속/)).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "s3-scratch" }).closest("tr") as HTMLElement).getByText("인라인")).toBeInTheDocument();
    // 종류 칸이 이미 알려 주므로 AWS 관리형/권한 경계 배지는 되풀이하지 않는다
    expect(screen.getAllByText("AWS 관리형")).toHaveLength(1);
    expect(screen.getAllByText("권한 경계")).toHaveLength(2); // 구역 제목 + 종류 칸
  });

  test("clicking a policy opens its detail; the inheriting group opens the group", async () => {
    const { props } = await openPolicies();
    fireEvent.click(screen.getByRole("button", { name: "ReadOnlyAccess" }));
    expect(props.onOpen).toHaveBeenCalledWith({ view: "policies", id: readOnlyPolicy.id });
    fireEvent.click(screen.getByRole("button", { name: "s3-scratch" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "policies", id: scratchInline.id });
    fireEvent.click(within(screen.getByRole("button", { name: "app-deploy" }).closest("tr") as HTMLElement).getByRole("button", { name: "dev-team" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "groups", id: devTeam.arn });
  });

  test("shows an empty message when nothing is attached", async () => {
    await openPolicies(aliceView({ policies: [] }));
    expect(screen.getByText("붙은 정책이 없어요")).toBeInTheDocument();
  });
});

describe("groups and members", () => {
  test("a user's groups link to the group detail", async () => {
    const { props } = setup();
    fireEvent.click(await tab(/^그룹/));
    fireEvent.click(screen.getByRole("button", { name: "dev-team" }));
    expect(props.onOpen).toHaveBeenCalledWith({ view: "groups", id: devTeam.arn });
  });

  test("shows an empty message and plain text for names missing from the overview", async () => {
    m.principal.mockResolvedValue(aliceView({ groups: ["ghost"] }));
    setup();
    fireEvent.click(await tab(/^그룹/));
    expect(screen.getByText("ghost")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ghost" })).not.toBeInTheDocument();
  });

  test("a user without groups says so", async () => {
    m.principal.mockResolvedValue(aliceView({ groups: [] }));
    setup();
    fireEvent.click(await tab(/^그룹/));
    expect(screen.getByText("소속된 그룹이 없어요")).toBeInTheDocument();
  });

  test("a group's members link to the user detail", async () => {
    m.principal.mockResolvedValue(devTeamView());
    const { props } = setup(devTeam.arn);
    fireEvent.click(await tab(/^구성원/));
    fireEvent.click(screen.getByRole("button", { name: "bob" }));
    expect(props.onOpen).toHaveBeenCalledWith({ view: "users", id: bob.arn });
  });
});

describe("access keys", () => {
  test("loads the keys only when the tab is opened and shows status, age and last use", async () => {
    m.principal.mockResolvedValue(aliceView({ summary: bob }));
    setup(bob.arn);
    await screen.findByRole("heading", { name: "bob" });
    expect(m.accessKeys).not.toHaveBeenCalled();
    fireEvent.click(await tab("액세스 키"));
    const table = await screen.findByRole("table", { name: "액세스 키" });
    expect(m.accessKeys).toHaveBeenCalledWith("prod", "bob");
    const rows = within(table).getAllByRole("row").slice(1);
    const first = within(rows[0]);
    expect(first.getByText("AKIAIOSFODNN7EXAMPLE")).toBeInTheDocument();
    expect(first.getByText("Active")).toBeInTheDocument();
    expect(first.getByText("2025-01-10")).toBeInTheDocument();
    expect(first.getByText("289일")).toBeInTheDocument();
    expect(first.getByText("2026-09-01")).toBeInTheDocument();
    expect(first.getByText("s3 · ap-northeast-2")).toBeInTheDocument();
    const second = within(rows[1]);
    expect(second.getByText("Inactive")).toBeInTheDocument();
    expect(second.getByText("사용 기록 없음")).toBeInTheDocument();
  });

  test("says when the user has no keys", async () => {
    m.accessKeys.mockResolvedValue([]);
    setup();
    fireEvent.click(await tab("액세스 키"));
    expect(await screen.findByText("액세스 키가 없어요")).toBeInTheDocument();
  });

  test("shows the key error", async () => {
    m.accessKeys.mockRejectedValue({ kind: "accessDenied", action: "iam:ListAccessKeys" });
    setup();
    fireEvent.click(await tab("액세스 키"));
    expect(await screen.findByText("권한 없음 (iam:ListAccessKeys)")).toBeInTheDocument();
  });
});

describe("trust", () => {
  test("lists who can assume the role, flags external access and shows warnings", async () => {
    m.principal.mockResolvedValue(appRoleView());
    setup(appRole.arn);
    fireEvent.click(await tab(/^신뢰/));
    const list = screen.getByRole("list", { name: "신뢰 관계" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);

    const service = within(items[0]);
    expect(service.getByText("서비스")).toBeInTheDocument();
    expect(service.getByText("lambda.amazonaws.com")).toBeInTheDocument();
    expect(service.getByText("sts:AssumeRole")).toBeInTheDocument();
    expect(service.queryByText("외부")).not.toBeInTheDocument();

    const account = within(items[1]);
    expect(account.getByText("계정")).toBeInTheDocument();
    expect(account.getByText("999988887777")).toBeInTheDocument();
    expect(account.getByText("외부")).toBeInTheDocument();
    expect(account.getByText("외부 계정이고 ExternalId 조건이 없어요")).toBeInTheDocument();

    const anyone = within(items[2]);
    expect(anyone.getByText("누구나")).toBeInTheDocument();
    expect(anyone.getByText("조건 있음")).toBeInTheDocument();
    expect(anyone.getByText("누구나 이 역할을 맡을 수 있어요")).toBeInTheDocument();
  });

  test("says so when no trust entries were read", async () => {
    m.principal.mockResolvedValue(appRoleView({ trust: [] }));
    setup(appRole.arn);
    fireEvent.click(await tab(/^신뢰/));
    expect(screen.getByText("이 역할을 맡을 수 있는 대상이 없어요")).toBeInTheDocument();
  });
});

describe("unused permissions", () => {
  const unusedTab = () => tab("안 쓰는 권한");

  test("the tab asks AWS only when 불러오기 is pressed, for this principal", async () => {
    setup();
    fireEvent.click(await unusedTab());
    expect(screen.getByRole("tab", { name: "안 쓰는 권한" })).toHaveAttribute("aria-selected", "true");
    expect(m.lastAccessed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "불러오기" }));
    expect(await screen.findByRole("table", { name: "서비스별 마지막 사용" })).toBeInTheDocument();
    expect(m.lastAccessed).toHaveBeenCalledWith("prod", alice.arn);
  });

  test("works for roles too", async () => {
    m.principal.mockResolvedValue(appRoleView());
    setup(appRole.arn);
    fireEvent.click(await unusedTab());
    fireEvent.click(screen.getByRole("button", { name: "불러오기" }));
    await screen.findByRole("table", { name: "서비스별 마지막 사용" });
    expect(m.lastAccessed).toHaveBeenCalledWith("prod", appRole.arn);
  });

  test("reports the tab for the history and keeps the loaded result when switching tabs", async () => {
    const { props } = setup();
    fireEvent.click(await unusedTab());
    expect(props.onViewState).toHaveBeenLastCalledWith({ tab: "unused", cell: null });
    fireEvent.click(screen.getByRole("button", { name: "불러오기" }));
    await screen.findByRole("table", { name: "서비스별 마지막 사용" });
    fireEvent.click(await tab(/^정책/));
    fireEvent.click(await unusedTab());
    expect(await screen.findByRole("table", { name: "서비스별 마지막 사용" })).toBeInTheDocument();
    expect(m.lastAccessed).toHaveBeenCalledTimes(1);
  });

  test("restores the tab from the history", async () => {
    setup(alice.arn, { initialTab: "unused" });
    expect(await unusedTab()).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "불러오기" })).toBeInTheDocument();
  });

  test("policy and group links navigate; a fix goes to onFix", async () => {
    const { props } = setup();
    fireEvent.click(await unusedTab());
    fireEvent.click(screen.getByRole("button", { name: "불러오기" }));
    await screen.findByRole("table", { name: "서비스별 마지막 사용" });

    fireEvent.click(screen.getByRole("button", { name: "ReadOnlyAccess" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "policies", id: readOnlyPolicy.id });
    const inherited = screen.getByRole("button", { name: "app-deploy" }).closest("tr") as HTMLElement;
    fireEvent.click(within(inherited).getByRole("button", { name: "dev-team" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "groups", id: devTeam.arn });

    const direct = screen.getByRole("button", { name: "ReadOnlyAccess" }).closest("tr") as HTMLElement;
    fireEvent.click(within(direct).getByRole("button", { name: "떼기" }));
    expect(props.onFix).toHaveBeenCalledWith({ op: "detachPolicy", target: alice.arn, policyArn: readOnlyPolicy.id });
  });
});
