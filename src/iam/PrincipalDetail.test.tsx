import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { desktop } from "../api/desktop";
import { renderWithClient } from "../test/utils";
import { iamApi } from "./api";
import {
  adminPolicy,
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
  scratchInlineView,
  supportRole,
} from "./fixtures";
import { NEW_POLICY_TEMPLATE } from "./PolicyEditor";
import { PrincipalDetail } from "./PrincipalDetail";
import type { PolicyRef, PolicySummary } from "./types";

vi.mock("./api", () => ({
  iamApi: {
    principal: vi.fn(),
    principalActions: vi.fn(),
    accessKeys: vi.fn(),
    lastAccessed: vi.fn(),
    policy: vi.fn(),
    listPolicies: vi.fn(),
    validatePolicy: vi.fn(),
  },
}));
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
    // 마지막 사용을 못 읽은 키는 "사용 기록 없음"으로 보이면 안 된다
    const third = within(rows[2]);
    expect(third.getByText("AKIAI7UNKNOWNEXAMPLE")).toBeInTheDocument();
    expect(third.getByText("마지막 사용 확인 못 함")).toBeInTheDocument();
    expect(third.queryByText("사용 기록 없음")).not.toBeInTheDocument();
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

// ── 변경 버튼 ──
const refOf = (p: PolicySummary): PolicyRef => ({ arn: p.arn, name: p.name, scope: p.scope, description: null, badges: p.badges });
const rowOf = (name: string) => screen.getByRole("button", { name }).closest("tr") as HTMLElement;
const buttonNames = (row: HTMLElement) => within(row).getAllByRole("button").map((b) => b.textContent);

describe("policy changes", () => {
  async function openPolicies(view = aliceView(), arn = alice.arn) {
    m.principal.mockResolvedValue(view);
    const utils = setup(arn);
    fireEvent.click(await tab(/^정책/));
    return utils;
  }

  beforeEach(() => {
    m.listPolicies.mockResolvedValue([refOf(readOnlyPolicy), refOf(adminPolicy)]);
    m.policy.mockResolvedValue(scratchInlineView());
  });

  test("[정책 붙이기] opens the picker; the chosen policy starts attachPolicy for this principal", async () => {
    const { props } = await openPolicies();
    fireEvent.click(screen.getByRole("button", { name: "정책 붙이기" }));
    expect(await screen.findByRole("dialog", { name: "정책 붙이기" })).toBeInTheDocument();
    expect(m.listPolicies).toHaveBeenCalledWith("prod", "");
    // 이미 직접 붙은 정책은 고를 수 없다
    expect(await screen.findByRole("option", { name: /ReadOnlyAccess/ })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("option", { name: /AdministratorAccess/ }));
    expect(props.onFix).toHaveBeenCalledTimes(1);
    expect(props.onFix).toHaveBeenCalledWith({ op: "attachPolicy", target: alice.arn, policyArn: adminPolicy.arn });
    expect(screen.queryByRole("dialog", { name: "정책 붙이기" })).not.toBeInTheDocument();
  });

  test("closing the picker changes nothing", async () => {
    const { props } = await openPolicies();
    fireEvent.click(screen.getByRole("button", { name: "정책 붙이기" }));
    fireEvent.click(await screen.findByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog", { name: "정책 붙이기" })).not.toBeInTheDocument();
    expect(props.onFix).not.toHaveBeenCalled();
  });

  test("the toolbar is there even when nothing is attached yet", async () => {
    await openPolicies(aliceView({ policies: [] }));
    expect(screen.getByText("붙은 정책이 없어요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "정책 붙이기" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "인라인 정책 추가" })).toBeEnabled();
  });

  test("[떼기] on a directly attached managed policy starts detachPolicy", async () => {
    const { props } = await openPolicies();
    fireEvent.click(within(rowOf("ReadOnlyAccess")).getByRole("button", { name: "ReadOnlyAccess 떼기" }));
    expect(props.onFix).toHaveBeenCalledTimes(1);
    expect(props.onFix).toHaveBeenCalledWith({ op: "detachPolicy", target: alice.arn, policyArn: readOnlyPolicy.id });
  });

  test("a policy inherited from a group has no [떼기]: it says to detach it from the group, which is a link", async () => {
    const { props } = await openPolicies();
    const row = rowOf("app-deploy");
    expect(buttonNames(row)).toEqual(["app-deploy", "dev-team"]);
    expect(within(row).getByText("그룹 dev-team에서 떼야 해요")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "dev-team" }));
    expect(props.onOpen).toHaveBeenCalledWith({ view: "groups", id: devTeam.arn });
    expect(props.onFix).not.toHaveBeenCalled();
  });

  test("an inline policy of a group says to delete it from the group", async () => {
    const inherited = { ...scratchInline, id: "inline:arn:aws:iam::123456789012:group/dev-team:team-notes", name: "team-notes", via: "dev-team" };
    await openPolicies(aliceView({ policies: [inherited] }));
    const row = rowOf("team-notes");
    expect(within(row).getByText("그룹 dev-team에서 지워야 해요")).toBeInTheDocument();
    expect(buttonNames(row)).toEqual(["team-notes", "dev-team"]);
  });

  test("a permissions boundary has no actions: changing it is out of scope", async () => {
    await openPolicies();
    expect(buttonNames(rowOf("dev-boundary"))).toEqual(["dev-boundary"]);
  });

  test("an inline policy has [편집] and [삭제]; [삭제] starts deleteInlinePolicy", async () => {
    const { props } = await openPolicies();
    const row = rowOf("s3-scratch");
    expect(buttonNames(row)).toEqual(["s3-scratch", "편집", "삭제"]);
    fireEvent.click(within(row).getByRole("button", { name: "s3-scratch 삭제" }));
    expect(props.onFix).toHaveBeenCalledWith({ op: "deleteInlinePolicy", target: alice.arn, name: "s3-scratch" });
  });

  test("[인라인 정책 추가] opens the editor; its preview starts putInlinePolicy and the editor closes once applied", async () => {
    const { props } = await openPolicies();
    fireEvent.click(screen.getByRole("button", { name: "인라인 정책 추가" }));
    expect(screen.getByRole("heading", { name: "인라인 정책 추가" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "붙은 정책" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "정책 이름" }), { target: { value: "queue-access" } });
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    expect(props.onFix).toHaveBeenCalledTimes(1);
    expect(props.onFix).toHaveBeenCalledWith(
      { op: "putInlinePolicy", target: alice.arn, name: "queue-access", document: NEW_POLICY_TEMPLATE },
      { onApplied: expect.any(Function) },
    );
    // 미리보기를 취소하면 편집기는 그대로다. 적용에 성공하면(onApplied) 편집기가 닫힌다.
    expect(screen.getByRole("heading", { name: "인라인 정책 추가" })).toBeInTheDocument();
    act(() => props.onFix.mock.calls[0][1].onApplied());
    expect(screen.queryByRole("heading", { name: "인라인 정책 추가" })).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "붙은 정책" })).toBeInTheDocument();
  });

  test("a new inline policy cannot reuse the name of one this principal already has", async () => {
    await openPolicies();
    fireEvent.click(screen.getByRole("button", { name: "인라인 정책 추가" }));
    fireEvent.change(screen.getByRole("textbox", { name: "정책 이름" }), { target: { value: "s3-scratch" } });
    expect(screen.getByText(/같은 이름의 인라인 정책이 이미 있어요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "미리보기" })).toBeDisabled();
  });

  test("[편집] on an inline policy loads its document; the preview starts putInlinePolicy with the same name", async () => {
    const { props } = await openPolicies();
    fireEvent.click(within(rowOf("s3-scratch")).getByRole("button", { name: "s3-scratch 편집" }));
    const editor = (await screen.findByRole("textbox", { name: "정책 JSON" })) as HTMLTextAreaElement;
    expect(m.policy).toHaveBeenCalledWith("prod", scratchInline.id);
    expect(JSON.parse(editor.value)).toEqual(JSON.parse(scratchInlineView().document));
    expect(screen.getByRole("button", { name: "미리보기" })).toBeDisabled(); // 바꾼 게 없다

    const changed = editor.value.replace("s3:PutObject", "s3:PutObjectAcl");
    fireEvent.change(editor, { target: { value: changed } });
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    expect(props.onFix).toHaveBeenCalledWith(
      { op: "putInlinePolicy", target: alice.arn, name: "s3-scratch", document: changed },
      { onApplied: expect.any(Function) },
    );
  });

  test("취소 in the editor goes back to the list; a failing load can be left the same way", async () => {
    m.policy.mockRejectedValue({ kind: "accessDenied", action: "iam:GetUserPolicy" });
    const { props } = await openPolicies();
    fireEvent.click(within(rowOf("s3-scratch")).getByRole("button", { name: "s3-scratch 편집" }));
    expect(await screen.findByText("권한 없음 (iam:GetUserPolicy)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.getByRole("table", { name: "붙은 정책" })).toBeInTheDocument();
    expect(props.onFix).not.toHaveBeenCalled();
  });

  test.each([
    ["service-linked", supportRole, "서비스 연결 역할은 AWS가 관리해서 바꿀 수 없어요"],
  ])("a %s role has every change button off, with the reason on screen", async (_label, summary, reason) => {
    const { props } = await openPolicies(appRoleView({ summary }), summary.arn);
    expect(screen.getByText(reason)).toBeInTheDocument();
    for (const name of ["정책 붙이기", "인라인 정책 추가", "ReadOnlyAccess 떼기", "queue-access 편집", "queue-access 삭제"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", reason);
      fireEvent.click(button);
    }
    expect(props.onFix).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("the unused-permissions tab of a service-linked role is off as well", async () => {
    m.principal.mockResolvedValue(appRoleView({ summary: supportRole }));
    const { props } = setup(supportRole.arn);
    fireEvent.click(await tab("안 쓰는 권한"));
    fireEvent.click(screen.getByRole("button", { name: "불러오기" }));
    await screen.findByRole("table", { name: "서비스별 마지막 사용" });
    expect(within(screen.getByRole("button", { name: "ReadOnlyAccess" }).closest("tr") as HTMLElement).getByRole("button", { name: "떼기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "인라인 정책으로 저장" })).toBeDisabled();
    expect(props.onFix).not.toHaveBeenCalled();
  });

  test("an Identity Center role is off too", async () => {
    const sso = { ...appRole, name: "AWSReservedSSO_Admin_0123", arn: "arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_0123", path: "/aws-reserved/sso.amazonaws.com/" };
    await openPolicies(appRoleView({ summary: sso }), sso.arn);
    expect(screen.getByText("Identity Center가 관리하는 역할이라 바꿀 수 없어요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "정책 붙이기" })).toBeDisabled();
  });
});

describe("saving the reduced policy draft", () => {
  afterEach(() => vi.useRealTimers());

  async function saveDraft(view = aliceView()) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 26, 10, 30));
    m.principal.mockResolvedValue(view);
    const utils = setup();
    fireEvent.click(await tab("안 쓰는 권한"));
    fireEvent.click(screen.getByRole("button", { name: "불러오기" }));
    await screen.findByRole("table", { name: "서비스별 마지막 사용" });
    fireEvent.click(screen.getByRole("button", { name: "인라인 정책으로 저장" }));
    return utils;
  }
  const inlineNamed = (name: string) => ({ ...scratchInline, id: `inline:${alice.arn}:${name}`, name });

  test("uses the dated name when it is free", async () => {
    const { props } = await saveDraft();
    expect(props.onFix).toHaveBeenCalledWith(expect.objectContaining({ op: "putInlinePolicy", name: "least-privilege-20261026" }));
  });

  test("never overwrites a policy of the same name that this principal already has: the name gets a number", async () => {
    const { props } = await saveDraft(aliceView({ policies: [inlineNamed("least-privilege-20261026"), inlineNamed("least-privilege-20261026-2")] }));
    expect(props.onFix).toHaveBeenCalledTimes(1);
    expect(props.onFix).toHaveBeenCalledWith(expect.objectContaining({ op: "putInlinePolicy", target: alice.arn, name: "least-privilege-20261026-3" }));
  });

  test("an inline policy of a group with that name is a different policy and does not count", async () => {
    const { props } = await saveDraft(aliceView({ policies: [{ ...inlineNamed("least-privilege-20261026"), via: "dev-team" }] }));
    expect(props.onFix).toHaveBeenCalledWith(expect.objectContaining({ name: "least-privilege-20261026" }));
  });

  test("other changes from the tab are handed over untouched", async () => {
    const { props } = await saveDraft();
    fireEvent.click(within(screen.getByRole("button", { name: "ReadOnlyAccess" }).closest("tr") as HTMLElement).getByRole("button", { name: "떼기" }));
    expect(props.onFix).toHaveBeenLastCalledWith({ op: "detachPolicy", target: alice.arn, policyArn: readOnlyPolicy.id });
  });
});

describe("group membership changes", () => {
  test("a user's [그룹에 추가] picks from the account's groups, without the ones the user is already in", async () => {
    const { props } = setup();
    fireEvent.click(await tab(/^그룹/));
    fireEvent.click(screen.getByRole("button", { name: "그룹에 추가" }));
    expect(screen.getByRole("dialog", { name: "그룹에 추가" })).toBeInTheDocument();
    const current = screen.getByRole("option", { name: /dev-team/ });
    expect(current).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(current);
    expect(props.onFix).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: /admins/ }));
    expect(props.onFix).toHaveBeenCalledWith({ op: "addToGroup", userName: "alice", groupName: "admins" });
    expect(screen.queryByRole("dialog", { name: "그룹에 추가" })).not.toBeInTheDocument();
  });

  test("a user's [빼기] starts removeFromGroup", async () => {
    const { props } = setup();
    fireEvent.click(await tab(/^그룹/));
    fireEvent.click(screen.getByRole("button", { name: "dev-team 빼기" }));
    expect(props.onFix).toHaveBeenCalledWith({ op: "removeFromGroup", userName: "alice", groupName: "dev-team" });
  });

  test("a group's [사용자 추가] picks from the account's users, without the current members", async () => {
    m.principal.mockResolvedValue(devTeamView());
    const { props } = setup(devTeam.arn);
    fireEvent.click(await tab(/^구성원/));
    fireEvent.click(screen.getByRole("button", { name: "사용자 추가" }));
    expect(screen.getByRole("option", { name: /alice/ })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("option", { name: /ci-bot/ }));
    expect(props.onFix).toHaveBeenCalledWith({ op: "addToGroup", userName: "ci-bot", groupName: "dev-team" });
  });

  test("a group's member [빼기] starts removeFromGroup for that user", async () => {
    m.principal.mockResolvedValue(devTeamView());
    const { props } = setup(devTeam.arn);
    fireEvent.click(await tab(/^구성원/));
    fireEvent.click(screen.getByRole("button", { name: "bob 빼기" }));
    expect(props.onFix).toHaveBeenCalledWith({ op: "removeFromGroup", userName: "bob", groupName: "dev-team" });
  });

  test("names missing from the overview can still be removed", async () => {
    m.principal.mockResolvedValue(aliceView({ groups: ["ghost"] }));
    const { props } = setup();
    fireEvent.click(await tab(/^그룹/));
    fireEvent.click(screen.getByRole("button", { name: "ghost 빼기" }));
    expect(props.onFix).toHaveBeenCalledWith({ op: "removeFromGroup", userName: "alice", groupName: "ghost" });
  });
});

describe("access key changes", () => {
  async function openKeys() {
    m.principal.mockResolvedValue(aliceView({ summary: bob }));
    const utils = setup(bob.arn);
    fireEvent.click(await tab("액세스 키"));
    await screen.findByRole("table", { name: "액세스 키" });
    return utils;
  }
  const keyRow = (id: string) => screen.getByText(id).closest("tr") as HTMLElement;

  test("an active key can be deactivated", async () => {
    const { props } = await openKeys();
    expect(buttonNames(keyRow("AKIAIOSFODNN7EXAMPLE"))).toEqual(["비활성화", "삭제"]);
    fireEvent.click(within(keyRow("AKIAIOSFODNN7EXAMPLE")).getByRole("button", { name: "AKIAIOSFODNN7EXAMPLE 비활성화" }));
    expect(props.onFix).toHaveBeenCalledWith({ op: "setAccessKeyStatus", userName: "bob", accessKeyId: "AKIAIOSFODNN7EXAMPLE", status: "Inactive" });
  });

  test("an inactive key can be activated", async () => {
    const { props } = await openKeys();
    expect(buttonNames(keyRow("AKIAI44QH8DHBEXAMPLE"))).toEqual(["활성화", "삭제"]);
    fireEvent.click(within(keyRow("AKIAI44QH8DHBEXAMPLE")).getByRole("button", { name: "AKIAI44QH8DHBEXAMPLE 활성화" }));
    expect(props.onFix).toHaveBeenCalledWith({ op: "setAccessKeyStatus", userName: "bob", accessKeyId: "AKIAI44QH8DHBEXAMPLE", status: "Active" });
  });

  test("[삭제] starts deleteAccessKey", async () => {
    const { props } = await openKeys();
    fireEvent.click(within(keyRow("AKIAI44QH8DHBEXAMPLE")).getByRole("button", { name: "AKIAI44QH8DHBEXAMPLE 삭제" }));
    expect(props.onFix).toHaveBeenCalledWith({ op: "deleteAccessKey", userName: "bob", accessKeyId: "AKIAI44QH8DHBEXAMPLE" });
  });
});
