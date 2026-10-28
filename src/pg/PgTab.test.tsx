import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../api/client";
import type { Settings } from "../api/types";
import type { SsoLogin } from "../lib/useSsoLogin";
import { newQueryClient, renderWithClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { pgApi } from "./api";
import {
  LOGIN_USER,
  object,
  ordersTable,
  pgTarget,
  sampleCellDetail,
  sampleDatabaseView,
  sampleFindings,
  sampleOverview,
  sampleRoleView,
  sampleSessions,
  sampleTargetInfo,
  sampleWhoCan,
} from "./fixtures";
import { LOGIN_NAME_INVALID } from "./loginName";
import { PgTab } from "./PgTab";
import type { PgTarget } from "./types";

vi.mock("./api", () => ({
  pgApi: {
    target: vi.fn(),
    open: vi.fn(),
    database: vi.fn(),
    cell: vi.fn(),
    objects: vi.fn(),
    role: vi.fn(),
    whoCan: vi.fn(),
    sessions: vi.fn(),
    findings: vi.fn(),
    close: vi.fn(),
  },
}));
vi.mock("../api/client", () => ({ api: { getSettings: vi.fn(), saveSettings: vi.fn(), ssoLogin: vi.fn() } }));
let mouseNav: ((dir: "back" | "forward") => void) | null = null;
vi.mock("../explorer/api", () => ({
  onMouseNav: vi.fn(async (cb: (dir: "back" | "forward") => void) => {
    mouseNav = cb;
    return () => {
      if (mouseNav === cb) mouseNav = null;
    };
  }),
}));

const m = vi.mocked(pgApi);
const ARN = sampleTargetInfo().arn;
const MANAGE_REASON = "이 사용자는 rds_superuser 멤버가 아니고 CREATEROLE도 없어서 바꿀 수 없어요";
const NETWORK = { kind: "network", message: "엔드포인트에 연결하지 못했어요(orders-aurora.cluster-c9akciq32.ap-northeast-2.rds.amazonaws.com:5432). VPN이 켜져 있는지 확인하세요" };
const VPN_TEXT = `네트워크 오류: ${NETWORK.message}`;
const IAM_OFF_CLUSTER = "이 클러스터는 IAM 데이터베이스 인증이 꺼져 있어요. RDS 콘솔에서 수정해 켠 뒤 다시 열어 주세요";
const IAM_OFF_INSTANCE = "이 인스턴스는 IAM 데이터베이스 인증이 꺼져 있어요. RDS 콘솔에서 수정해 켠 뒤 다시 열어 주세요";
const PROMPT_INTRO = "IAM 인증으로 접속할 DB 사용자 이름을 입력하세요(예: iam_admin). 이 대상에 대해 기억해 둘게요";

type Props = React.ComponentProps<typeof PgTab>;
const baseProps: Props = { target: pgTarget, title: "🐘 orders-aurora", active: true, filter: "" };

function setup(extra: Partial<Props> = {}) {
  const utils = renderWithClient(<PgTab {...baseProps} {...extra} />);
  const update = (next: Partial<Props>) =>
    utils.rerender(
      <QueryClientProvider client={utils.qc as QueryClient}>
        <PgTab {...baseProps} {...extra} {...next} />
      </QueryClientProvider>,
    );
  return { ...utils, update };
}

/** 설정 파일의 내용. pgLogins를 주면 그 대상에 로그인이 기억돼 있다. */
function settingsWith(pgLogins?: Record<string, string>): Settings {
  return { enabledServices: ["ec2", "rds"], favorites: [], lastProfile: "prod", lastRegion: null, ...(pgLogins ? { pgLogins } : {}) };
}
const remembered = (user = LOGIN_USER) => vi.mocked(api.getSettings).mockResolvedValue(settingsWith({ [ARN]: user }));

const topBar = () => within(screen.getByRole("group", { name: "연결 정보" }));
const menu = () => within(screen.getByRole("navigation", { name: "PostgreSQL 메뉴" }));
const openMenu = (label: string) => fireEvent.click(menu().getByText(label).closest("button")!);
const crumb = () => within(screen.getByRole("navigation", { name: "현재 위치" }));
/** 연결이 끝나 메뉴가 보일 때까지 기다린다 */
const connected = () => screen.findByRole("navigation", { name: "PostgreSQL 메뉴" });
const promptInput = () => screen.getByRole("textbox", { name: "DB 사용자" }) as HTMLInputElement;
const metaKey = (key: "[" | "]") => fireEvent.keyDown(window, { key, metaKey: true });
const rowOf = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;
const openRole = async (name: string) => {
  fireEvent.doubleClick(await screen.findByText(name));
  return screen.findByRole("heading", { name });
};
async function type(text: string) {
  const user = userEvent.setup();
  await user.clear(promptInput());
  await user.type(promptInput(), text);
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  mouseNav = null;
  document.querySelectorAll(".modal").forEach((e) => e.remove());
  remembered();
  vi.mocked(api.saveSettings).mockResolvedValue(undefined);
  m.target.mockResolvedValue(sampleTargetInfo());
  m.open.mockResolvedValue(sampleOverview());
  m.database.mockResolvedValue(sampleDatabaseView());
  m.cell.mockImplementation(async (_t, _database, role, schema) => sampleCellDetail({ role, schema }));
  m.findings.mockResolvedValue(sampleFindings());
  m.role.mockImplementation(async (_t, role) => sampleRoleView(role));
  m.sessions.mockResolvedValue(sampleSessions());
  m.objects.mockResolvedValue([ordersTable]);
  m.whoCan.mockResolvedValue(sampleWhoCan());
  m.close.mockResolvedValue(null);
});

describe("checking the target", () => {
  test("says so until the target is known, and connects to nothing meanwhile", async () => {
    let resolve!: (v: ReturnType<typeof sampleTargetInfo>) => void;
    m.target.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    expect(screen.getByText("대상을 확인하는 중이에요")).toBeInTheDocument();
    expect(m.target).toHaveBeenCalledWith(pgTarget);
    expect(m.open).not.toHaveBeenCalled();
    await act(async () => resolve(sampleTargetInfo()));
    expect(await connected()).toBeInTheDocument();
  });

  test("an error of the check shows through the error box, and 다시 시도 checks again", async () => {
    m.target.mockRejectedValueOnce({ kind: "other", message: "RDS에서 대상을 찾지 못했어요: orders-aurora" });
    setup();
    expect(await screen.findByText("RDS에서 대상을 찾지 못했어요: orders-aurora")).toBeInTheDocument();
    expect(m.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await connected()).toBeInTheDocument();
    expect(m.target).toHaveBeenCalledTimes(2);
  });

  test("a cluster whose IAM database authentication is off shows the text for clusters, with no prompt and no connection", async () => {
    m.target.mockResolvedValue(sampleTargetInfo({ iamAuth: false }));
    setup();
    expect(await screen.findByText(IAM_OFF_CLUSTER)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "DB 사용자" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "연결" })).not.toBeInTheDocument();
    expect(m.open).not.toHaveBeenCalled();
  });

  test("an instance gets the text for instances", async () => {
    const instance: PgTarget = { ...pgTarget, kind: "instance", id: "reports-db" };
    m.target.mockResolvedValue(sampleTargetInfo({ kind: "instance", iamAuth: false, identifier: "reports-db" }));
    setup({ target: instance });
    expect(await screen.findByText(IAM_OFF_INSTANCE)).toBeInTheDocument();
    expect(screen.queryByText(IAM_OFF_CLUSTER)).not.toBeInTheDocument();
  });

  test("a remembered login does not make it connect when IAM authentication is off", async () => {
    remembered();
    m.target.mockResolvedValue(sampleTargetInfo({ iamAuth: false }));
    setup();
    await screen.findByText(IAM_OFF_CLUSTER);
    await act(async () => {});
    expect(m.open).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "바꾸기" })).not.toBeInTheDocument();
  });

  test("still shows which target it is while IAM authentication is off", async () => {
    m.target.mockResolvedValue(sampleTargetInfo({ iamAuth: false }));
    setup();
    await screen.findByText(IAM_OFF_CLUSTER);
    expect(topBar().getByText("orders-aurora")).toBeInTheDocument();
    expect(topBar().getByText("aurora-postgresql 16.4")).toBeInTheDocument();
  });
});

describe("the DB user", () => {
  beforeEach(() => {
    vi.mocked(api.getSettings).mockResolvedValue(settingsWith());
  });

  test("is asked for on the first open, with the title, the intro and the button", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "DB 사용자" })).toBeInTheDocument();
    expect(screen.getByText(PROMPT_INTRO)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "연결" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "취소" })).not.toBeInTheDocument();
    expect(m.open).not.toHaveBeenCalled();
    expect(screen.queryByRole("navigation", { name: "PostgreSQL 메뉴" })).not.toBeInTheDocument();
  });

  test("does not flash the prompt while the settings are still loading", async () => {
    let resolve!: (v: Settings) => void;
    vi.mocked(api.getSettings).mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    // 대상은 이미 알려졌고(위쪽 줄에 이름이 보인다) 설정만 기다리는 동안에는 묻지도 연결하지도 않는다
    expect(await screen.findByText("불러오는 중…")).toBeInTheDocument();
    expect(topBar().getByText("orders-aurora")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "DB 사용자" })).not.toBeInTheDocument();
    expect(m.open).not.toHaveBeenCalled();
    await act(async () => resolve(settingsWith({ [ARN]: LOGIN_USER })));
    expect(await connected()).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "DB 사용자" })).not.toBeInTheDocument();
  });

  test("submitting remembers it for this target's ARN and connects as that user", async () => {
    setup();
    await screen.findByRole("heading", { name: "DB 사용자" });
    const user = await type("iam_admin");
    await user.click(screen.getByRole("button", { name: "연결" }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ enabledServices: ["ec2", "rds"], lastProfile: "prod", pgLogins: { [ARN]: "iam_admin" } }));
    expect(await connected()).toBeInTheDocument();
    expect(m.open).toHaveBeenCalledTimes(1);
    expect(m.open).toHaveBeenCalledWith(pgTarget, "iam_admin");
    expect(screen.queryByRole("heading", { name: "DB 사용자" })).not.toBeInTheDocument();
  });

  test("keeps the logins remembered for other targets", async () => {
    const other = "arn:aws:rds:ap-northeast-2:123456789012:cluster:billing";
    vi.mocked(api.getSettings).mockResolvedValue(settingsWith({ [other]: "billing_admin" }));
    setup();
    await screen.findByRole("heading", { name: "DB 사용자" });
    const user = await type("iam_admin");
    await user.click(screen.getByRole("button", { name: "연결" }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ pgLogins: { [other]: "billing_admin", [ARN]: "iam_admin" } })));
  });

  test('"  iam_admin  " is saved and used as "iam_admin"', async () => {
    setup();
    await screen.findByRole("heading", { name: "DB 사용자" });
    const user = await type("  iam_admin  ");
    await user.click(screen.getByRole("button", { name: "연결" }));
    // 설정 파일에 남는 이름도, 서명하고 접속하는 이름도 가장자리 공백이 없다
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ pgLogins: { [ARN]: "iam_admin" } }));
    await connected();
    expect(m.open).toHaveBeenCalledTimes(1);
    expect(m.open).toHaveBeenCalledWith(pgTarget, "iam_admin");
  });

  test("[연결] waits while only spaces are typed, and nothing is saved or opened", async () => {
    setup();
    await screen.findByRole("heading", { name: "DB 사용자" });
    const user = await type("   ");
    expect(screen.getByRole("button", { name: "연결" })).toBeDisabled();
    await user.type(promptInput(), "{Enter}");
    await act(async () => {});
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(m.open).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "DB 사용자" })).toBeInTheDocument();
  });

  test("a name the backend would refuse is refused in the prompt: nothing is saved and nothing is opened", async () => {
    setup();
    await screen.findByRole("heading", { name: "DB 사용자" });
    const user = await type("iam admin");
    expect(screen.getByText(LOGIN_NAME_INVALID)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "연결" })).toBeDisabled();
    await user.type(promptInput(), "{Enter}");
    await act(async () => {});
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(m.open).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "DB 사용자" })).toBeInTheDocument();
  });

  test("a remembered login connects at once, without asking", async () => {
    remembered("alice");
    setup();
    expect(await connected()).toBeInTheDocument();
    expect(m.open).toHaveBeenCalledWith(pgTarget, "alice");
    expect(screen.queryByRole("heading", { name: "DB 사용자" })).not.toBeInTheDocument();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  test("a login remembered for another target is not used for this one", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settingsWith({ "arn:aws:rds:ap-northeast-2:123456789012:cluster:billing": "billing_admin" }));
    setup();
    expect(await screen.findByRole("heading", { name: "DB 사용자" })).toBeInTheDocument();
    expect(m.open).not.toHaveBeenCalled();
  });
});

describe("connecting", () => {
  test("says so until the overview arrives, with the target and the user already in the top bar", async () => {
    let resolve!: (v: ReturnType<typeof sampleOverview>) => void;
    m.open.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    expect(await screen.findByText("연결하는 중이에요")).toBeInTheDocument();
    expect(topBar().getByText("orders-aurora")).toBeInTheDocument();
    expect(topBar().getByText(LOGIN_USER)).toBeInTheDocument();
    expect(topBar().getByText("연결 중…")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "PostgreSQL 메뉴" })).not.toBeInTheDocument();
    await act(async () => resolve(sampleOverview()));
    expect(await connected()).toBeInTheDocument();
    expect(topBar().getByText("연결됨")).toBeInTheDocument();
  });

  test("an error of the connection shows through the error box with the network text, and 다시 시도 connects again", async () => {
    m.open.mockRejectedValueOnce(NETWORK);
    setup();
    expect(await screen.findByText(VPN_TEXT)).toBeInTheDocument();
    expect(topBar().getByText("연결 안 됨")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "PostgreSQL 메뉴" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await connected()).toBeInTheDocument();
    expect(m.open).toHaveBeenCalledTimes(2);
    expect(m.open).toHaveBeenLastCalledWith(pgTarget, LOGIN_USER);
    expect(screen.queryByText(VPN_TEXT)).not.toBeInTheDocument();
  });

  test("a wrong DB user shows the IAM failure, and 바꾸기 is still there to fix it", async () => {
    const text = `IAM 인증에 실패했어요. 프로필에 rds-db:connect 권한이 있는지, DB 사용자 ${LOGIN_USER}에게 rds_iam이 있는지 확인하세요`;
    m.open.mockRejectedValueOnce({ kind: "other", message: text });
    setup();
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(topBar().getByRole("button", { name: "바꾸기" })).toBeInTheDocument();
  });

  test("a remembered name that the backend refuses shows why, and 바꾸기 fixes it: the spaces go and it connects", async () => {
    const text = `DB 사용자 이름이 올바르지 않아요. 공백이나 " < > # & % + 같은 문자는 쓸 수 없어요`;
    remembered("iam_admin "); // 설정 파일을 손으로 고쳐 가장자리 공백이 남은 이름
    m.open.mockImplementation((_t, user) => (user === user.trim() ? Promise.resolve(sampleOverview({ loginUser: user })) : Promise.reject({ kind: "other", message: text })));
    setup();
    expect(await screen.findByText(text)).toBeInTheDocument();
    fireEvent.click(topBar().getByRole("button", { name: "바꾸기" }));
    expect(promptInput()).toHaveValue("iam_admin ");
    fireEvent.click(screen.getByRole("button", { name: "연결" }));
    expect(await connected()).toBeInTheDocument();
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ pgLogins: { [ARN]: "iam_admin" } }));
    expect(m.open).toHaveBeenLastCalledWith(pgTarget, "iam_admin");
    expect(screen.queryByText(text)).not.toBeInTheDocument();
  });

  test("an expired SSO session asks for the login of the profile, and a login done by the app's manager connects again", async () => {
    m.open.mockRejectedValueOnce({ kind: "ssoExpired" });
    const manager = ssoLoginStub();
    const tree = (sso: SsoLogin, qc: QueryClient) => withClientAndSso(<PgTab {...baseProps} />, qc, sso);
    const qc = newQueryClient();
    const view = render(tree(manager, qc));
    expect(await screen.findByText("SSO 세션이 만료됐어요 (prod)")).toBeInTheDocument();
    expect(m.open).toHaveBeenCalledTimes(1);
    // 로그인 관리자가 로그인 성공을 알린다. 관리자는 pg 쿼리를 다시 부르지 않으니 화면이 대상을 다시 읽어야 한다
    const later = Date.now() + 1000;
    await act(async () => view.rerender(tree({ ...manager, lastSuccessAt: () => later }, qc)));
    expect(await connected()).toBeInTheDocument();
    expect(m.open).toHaveBeenCalledTimes(2);
    expect(m.target).toHaveBeenCalledTimes(2); // 대상 확인부터 다시 읽는다
  });

  test("an expired SSO session in the target check is handled the same way", async () => {
    m.target.mockRejectedValueOnce({ kind: "ssoExpired" });
    const manager = ssoLoginStub();
    const tree = (sso: SsoLogin, qc: QueryClient) => withClientAndSso(<PgTab {...baseProps} />, qc, sso);
    const qc = newQueryClient();
    const view = render(tree(manager, qc));
    expect(await screen.findByText("SSO 세션이 만료됐어요 (prod)")).toBeInTheDocument();
    const later = Date.now() + 1000;
    await act(async () => view.rerender(tree({ ...manager, lastSuccessAt: () => later }, qc)));
    expect(await connected()).toBeInTheDocument();
    expect(m.open).toHaveBeenCalledWith(pgTarget, LOGIN_USER);
  });

  test("without the app's login manager the login button of the box logs in and connects again", async () => {
    m.open.mockRejectedValueOnce({ kind: "ssoExpired" });
    vi.mocked(api.ssoLogin).mockResolvedValue(undefined);
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "로그인" }));
    expect(await connected()).toBeInTheDocument();
    expect(api.ssoLogin).toHaveBeenCalledWith("prod");
    expect(m.open).toHaveBeenCalledTimes(2);
  });
});

describe("changing the DB user", () => {
  test("바꾸기 reopens the prompt with the current name, and 취소 goes back to where it was", async () => {
    setup();
    await connected();
    await openRole("alice");
    fireEvent.click(topBar().getByRole("button", { name: "바꾸기" }));
    expect(screen.getByRole("heading", { name: "DB 사용자" })).toBeInTheDocument();
    expect(promptInput()).toHaveValue(LOGIN_USER);
    expect(screen.queryByRole("navigation", { name: "PostgreSQL 메뉴" })).not.toBeInTheDocument();
    expect(topBar().queryByRole("button", { name: "바꾸기" })).not.toBeInTheDocument(); // 이미 묻는 중이다
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("heading", { name: "DB 사용자" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument(); // 보던 자리 그대로
    expect(m.open).toHaveBeenCalledTimes(1);
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  test("saving another name remembers it and reconnects as that user, without showing the previous user's overview", async () => {
    remembered("iam_admin");
    setup();
    await connected();
    fireEvent.click(topBar().getByRole("button", { name: "바꾸기" }));
    let resolve!: (v: ReturnType<typeof sampleOverview>) => void;
    m.open.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = await type("alice");
    await user.click(screen.getByRole("button", { name: "연결" }));
    await waitFor(() => expect(m.open).toHaveBeenLastCalledWith(pgTarget, "alice"));
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ pgLogins: { [ARN]: "alice" } }));
    // 새 사용자로 연결하는 동안 이전 사용자의 화면은 없다
    expect(await screen.findByText("연결하는 중이에요")).toBeInTheDocument();
    expect(topBar().getByText("alice")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "PostgreSQL 메뉴" })).not.toBeInTheDocument();
    await act(async () => resolve(sampleOverview({ loginUser: "alice", canManage: false, manageReason: MANAGE_REASON })));
    expect(await connected()).toBeInTheDocument();
    expect(screen.getByText(MANAGE_REASON)).toBeInTheDocument(); // 새 사용자의 개요
  });

  test("a refused name changes nothing: the user stays, nothing is saved, and 취소 goes back", async () => {
    setup();
    await connected();
    fireEvent.click(topBar().getByRole("button", { name: "바꾸기" }));
    const user = await type("bad name");
    expect(screen.getByText(LOGIN_NAME_INVALID)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "연결" })).toBeDisabled();
    await user.type(promptInput(), "{Enter}");
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(await connected()).toBeInTheDocument();
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(m.open).toHaveBeenCalledTimes(1);
    expect(topBar().getByText(LOGIN_USER)).toBeInTheDocument();
  });

  test("saving the same name connects again", async () => {
    setup();
    await connected();
    fireEvent.click(topBar().getByRole("button", { name: "바꾸기" }));
    fireEvent.click(screen.getByRole("button", { name: "연결" }));
    await waitFor(() => expect(m.open).toHaveBeenCalledTimes(2));
    expect(m.open).toHaveBeenLastCalledWith(pgTarget, LOGIN_USER);
    expect(await connected()).toBeInTheDocument();
  });

  test("after a failed connection, a new name gets a fresh try", async () => {
    m.open.mockRejectedValueOnce({ kind: "other", message: `DB 사용자 ${LOGIN_USER}가 없어요` });
    setup();
    await screen.findByText(`DB 사용자 ${LOGIN_USER}가 없어요`);
    fireEvent.click(topBar().getByRole("button", { name: "바꾸기" }));
    const user = await type("alice");
    await user.click(screen.getByRole("button", { name: "연결" }));
    expect(await connected()).toBeInTheDocument();
    expect(m.open).toHaveBeenLastCalledWith(pgTarget, "alice");
    expect(screen.queryByText(`DB 사용자 ${LOGIN_USER}가 없어요`)).not.toBeInTheDocument();
  });

  test("connects once as the new user, then reads again what the previous user's connection had read", async () => {
    setup();
    await connected();
    openMenu("점검");
    await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(1));
    openMenu("역할");
    await openRole("alice");
    expect(m.role).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    m.open.mockResolvedValue(sampleOverview({ loginUser: "bob" }));
    m.findings.mockResolvedValue(sampleFindings());
    m.role.mockImplementation(async (_t, role) => sampleRoleView(role));

    fireEvent.click(topBar().getByRole("button", { name: "바꾸기" }));
    const user = await type("bob");
    await user.click(screen.getByRole("button", { name: "연결" }));
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument(); // 보던 상세로 돌아온다
    await waitFor(() => expect(m.role).toHaveBeenCalledWith(pgTarget, "alice"));
    expect(m.open).toHaveBeenCalledTimes(1); // 다시 연결하지는 않는다
    expect(m.open).toHaveBeenCalledWith(pgTarget, "bob");
    expect(m.target).not.toHaveBeenCalled();
    // 점검이 보이는 화면이 아니라서 지금은 읽지 않고, 다시 열 때 새로 읽는다
    await act(async () => {});
    expect(m.findings).not.toHaveBeenCalled();
    openMenu("점검");
    await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(1));
    expect(m.findings).toHaveBeenLastCalledWith(pgTarget, true);
  });

  test("with 점검 showing, a new user reads the findings again once the new connection is up, and not before", async () => {
    setup();
    await connected();
    openMenu("점검");
    await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(1));
    let resolve!: (v: ReturnType<typeof sampleOverview>) => void;
    m.open.mockReturnValue(new Promise((r) => (resolve = r)));
    fireEvent.click(topBar().getByRole("button", { name: "바꾸기" }));
    const user = await type("bob");
    await user.click(screen.getByRole("button", { name: "연결" }));
    await screen.findByText("연결하는 중이에요");
    await act(async () => {});
    expect(m.findings).toHaveBeenCalledTimes(1); // 연결이 서기 전에는 읽지 않는다
    await act(async () => resolve(sampleOverview({ loginUser: "bob" })));
    await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(2));
    expect(m.findings).toHaveBeenLastCalledWith(pgTarget, true);
  });

  test("nothing is read again just because the connection came up the first time", async () => {
    setup();
    await connected();
    await act(async () => {});
    expect(m.findings).not.toHaveBeenCalled();
    // 첫 연결에서 다시 읽기를 걸었다면 "다음 조회는 force" 표시가 남아, 처음 여는 점검이 force로 나간다
    openMenu("점검");
    await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(1));
    expect(m.findings).toHaveBeenLastCalledWith(pgTarget, false);
  });
});

describe("top bar", () => {
  test("shows the identifier, the engine and its version, the DB user and when it was read", async () => {
    setup();
    await connected();
    expect(topBar().getByText("orders-aurora")).toBeInTheDocument();
    expect(topBar().getByText("aurora-postgresql 16.4")).toBeInTheDocument();
    expect(topBar().getByText("DB 사용자")).toBeInTheDocument();
    expect(topBar().getByText(LOGIN_USER)).toBeInTheDocument();
    expect(topBar().getByText(/^읽은 시각 .*\d{1,2}:\d{2}:\d{2}$/)).toBeInTheDocument();
    expect(topBar().getByRole("button", { name: "바꾸기" })).toBeInTheDocument();
    expect(topBar().getByRole("button", { name: "다시 읽기" })).toBeInTheDocument();
    expect(topBar().getByText("연결됨")).toBeInTheDocument();
  });

  test("the time is the time of the snapshot, in the local time zone", async () => {
    m.open.mockResolvedValue(sampleOverview({ fetchedAt: "2026-10-28T12:34:56Z" }));
    setup();
    await connected();
    expect(topBar().getByText(`읽은 시각 ${new Date("2026-10-28T12:34:56Z").toLocaleTimeString("ko-KR")}`)).toBeInTheDocument();
  });

  test("다시 읽기 reads the target and the connection again, and the snapshot that is showing with force", async () => {
    setup();
    await connected();
    openMenu("점검");
    await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(1));
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(m.open).toHaveBeenCalledTimes(2));
    expect(m.open).toHaveBeenLastCalledWith(pgTarget, LOGIN_USER);
    expect(m.target).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(2));
    expect(m.findings).toHaveBeenLastCalledWith(pgTarget, true);
  });

  test("다시 읽기 on 역할 reads no findings, and 점검 opened afterwards reads them with force", async () => {
    setup();
    await connected();
    openMenu("점검");
    await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(1));
    openMenu("역할");
    m.findings.mockClear();
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(m.open).toHaveBeenCalledTimes(2));
    await topBar().findByRole("button", { name: "다시 읽기" });
    await act(async () => {});
    expect(m.findings).not.toHaveBeenCalled();
    expect(menu().getByTestId("nav-count")).toHaveTextContent("5"); // 읽어 둔 건수는 그대로다
    openMenu("점검");
    await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(1));
    expect(m.findings).toHaveBeenLastCalledWith(pgTarget, true);
  });

  test("다시 읽기 on 역할 reads no findings when 점검 was never opened", async () => {
    setup();
    await connected();
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(m.open).toHaveBeenCalledTimes(2));
    await topBar().findByRole("button", { name: "다시 읽기" });
    await act(async () => {});
    expect(m.findings).not.toHaveBeenCalled();
  });

  test("the time moves on to the new snapshot", async () => {
    setup();
    await connected();
    m.open.mockResolvedValue(sampleOverview({ fetchedAt: "2026-10-28T15:00:00Z" }));
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    expect(await topBar().findByText(`읽은 시각 ${new Date("2026-10-28T15:00:00Z").toLocaleTimeString("ko-KR")}`)).toBeInTheDocument();
  });

  test("the button is busy while the snapshot is being read", async () => {
    setup();
    await connected();
    let resolve!: (v: ReturnType<typeof sampleOverview>) => void;
    m.open.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    const busy = await topBar().findByRole("button", { name: "읽는 중…" });
    expect(busy).toBeDisabled();
    await act(async () => resolve(sampleOverview()));
    expect(await topBar().findByRole("button", { name: "다시 읽기" })).toBeEnabled();
  });

  test("a read that fails keeps what was on screen, says why above it, and 다시 시도 reads again", async () => {
    setup();
    await connected();
    await screen.findByText("alice");
    m.open.mockRejectedValueOnce(NETWORK);
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    const banner = await screen.findByText(VPN_TEXT);
    expect(banner.closest(".error-banner")).not.toBeNull();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(topBar().getByText("연결 안 됨")).toBeInTheDocument();
    expect(topBar().getByText(/^읽은 시각/)).toBeInTheDocument();
    fireEvent.click(within(banner.closest(".error-banner") as HTMLElement).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(screen.queryByText(VPN_TEXT)).not.toBeInTheDocument());
    expect(topBar().getByText("연결됨")).toBeInTheDocument();
  });

  test("a failed re-read of the target keeps the old information on screen and says why above it", async () => {
    setup();
    await connected();
    await screen.findByText("alice");
    m.target.mockRejectedValueOnce(NETWORK);
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    const banner = await screen.findByText(VPN_TEXT);
    expect(banner.closest(".error-banner")).not.toBeNull();
    expect(topBar().getByText("orders-aurora")).toBeInTheDocument();
    expect(topBar().getByText("aurora-postgresql 16.4")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(menu().getAllByRole("button")).toHaveLength(6);
    fireEvent.click(within(banner.closest(".error-banner") as HTMLElement).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(screen.queryByText(VPN_TEXT)).not.toBeInTheDocument());
  });

  test("when the target and the connection both fail to be read again, it says so once", async () => {
    setup();
    await connected();
    m.target.mockRejectedValueOnce(NETWORK);
    m.open.mockRejectedValueOnce(NETWORK);
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    await screen.findByText(VPN_TEXT);
    await act(async () => {});
    expect(screen.getAllByText(VPN_TEXT)).toHaveLength(1);
  });

  test("a target that is read for the first time and fails still shows the full error box, not a banner", async () => {
    m.target.mockRejectedValueOnce(NETWORK);
    setup();
    const text = await screen.findByText(VPN_TEXT);
    expect(text.closest(".error-banner")).toBeNull();
    expect(screen.queryByRole("group", { name: "연결 정보" })).not.toBeInTheDocument();
  });

  test("a user who cannot manage sees the reason as a hint", async () => {
    m.open.mockResolvedValue(sampleOverview({ canManage: false, manageReason: MANAGE_REASON }));
    setup();
    await connected();
    expect(screen.getByText(MANAGE_REASON)).toBeInTheDocument();
  });

  test("a user who can manage sees no hint", async () => {
    setup();
    await connected();
    expect(screen.queryByText(MANAGE_REASON)).not.toBeInTheDocument();
    expect(screen.queryByText(/바꿀 수 없어요/)).not.toBeInTheDocument();
  });

  test("the hint follows canManage, not the mere presence of a reason", async () => {
    m.open.mockResolvedValue(sampleOverview({ canManage: true, manageReason: MANAGE_REASON }));
    setup();
    await connected();
    expect(screen.queryByText(MANAGE_REASON)).not.toBeInTheDocument();
  });

  test("a user who cannot manage but has no reason text gets no empty hint", async () => {
    m.open.mockResolvedValue(sampleOverview({ canManage: false, manageReason: null }));
    setup();
    await connected();
    expect(document.querySelector(".iam-hint")).toBeNull();
  });
});

describe("menu", () => {
  test("has the six items in order and opens on 역할", async () => {
    setup();
    await connected();
    expect(menu().getAllByRole("button").map((b) => b.textContent?.replace(/[^가-힣 ]/gu, "").trim())).toEqual(["점검", "역할", "권한", "기본 권한", "누가 할 수 있나", "세션"]);
    expect(menu().getByRole("button", { name: /역할/ })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("table", { name: "역할 목록" })).toBeInTheDocument();
  });

  test("connecting and staying on 역할 never reads the findings, so 점검 has no number yet", async () => {
    let resolve!: (v: ReturnType<typeof sampleOverview>) => void;
    m.open.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    await screen.findByText("연결하는 중이에요");
    expect(m.findings).not.toHaveBeenCalled();
    await act(async () => resolve(sampleOverview()));
    await connected();
    expect(await screen.findByRole("table", { name: "역할 목록" })).toBeInTheDocument();
    await act(async () => {});
    expect(m.findings).not.toHaveBeenCalled();
    expect(menu().queryByTestId("nav-count")).not.toBeInTheDocument();
  });

  test("opening 점검 reads the findings once, without force, and its number appears", async () => {
    setup();
    await connected();
    openMenu("점검");
    const count = await within(menu().getByRole("button", { name: /점검/ })).findByTestId("nav-count");
    expect(count).toHaveTextContent("5"); // rds_superuser 2 + SECURITY DEFINER 1 + CREATEROLE 1 + 만료 1
    expect(count).toHaveClass("alert");
    expect(m.findings).toHaveBeenCalledTimes(1);
    expect(m.findings).toHaveBeenCalledWith(pgTarget, false);
  });

  test("점검 shows no number while the findings are being read", async () => {
    let resolve!: (v: ReturnType<typeof sampleFindings>) => void;
    m.findings.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    await connected();
    openMenu("점검");
    await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(1));
    expect(menu().queryByTestId("nav-count")).not.toBeInTheDocument();
    await act(async () => resolve(sampleFindings()));
    expect(await menu().findByTestId("nav-count")).toHaveTextContent("5");
  });

  test("the findings are read on 점검 only, not on the other screens", async () => {
    setup();
    await connected();
    for (const label of ["권한", "기본 권한", "누가 할 수 있나", "세션"]) openMenu(label);
    await act(async () => {});
    expect(m.findings).not.toHaveBeenCalled();
    expect(menu().queryByTestId("nav-count")).not.toBeInTheDocument();
  });

  describe("while there is no connection", () => {
    // 앱은 창에 초점이 돌아와도 다시 읽지 않게 해 두었다(refetchOnWindowFocus: false). 켜 둔 쪽은 네트워크가 다시 이어질 때(refetchOnReconnect)다
    afterEach(() => onlineManager.setOnline(true));

    test("no findings are read, not even when the network comes back", async () => {
      m.findings.mockRejectedValue({ kind: "other", message: "점검을 읽지 못했어요" });
      setup();
      await connected();
      openMenu("점검");
      await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(1));
      // 다른 DB 사용자로 바꾸면 새 연결이 서기 전까지 개요가 없다. 점검은 읽지 못한 채라 낡은 것으로 치지만, 연결 없이 다시 읽지는 않는다
      m.open.mockReturnValue(new Promise(() => {}));
      fireEvent.click(topBar().getByRole("button", { name: "바꾸기" }));
      const user = await type("bob");
      await user.click(screen.getByRole("button", { name: "연결" }));
      await screen.findByText("연결하는 중이에요");
      m.findings.mockClear();
      await act(async () => {
        onlineManager.setOnline(false);
        onlineManager.setOnline(true);
      });
      await act(async () => {});
      expect(m.findings).not.toHaveBeenCalled();
    });
  });

  test("going back to 역할 keeps the number and reads nothing", async () => {
    setup();
    await connected();
    openMenu("점검");
    await within(menu().getByRole("button", { name: /점검/ })).findByTestId("nav-count");
    m.findings.mockClear();
    openMenu("역할");
    expect(await screen.findByRole("table", { name: "역할 목록" })).toBeInTheDocument();
    expect(menu().getByTestId("nav-count")).toHaveTextContent("5");
    await act(async () => {});
    expect(m.findings).not.toHaveBeenCalled();
  });

  test("opening 점검 again does not read what is up to date again", async () => {
    setup();
    await connected();
    openMenu("점검");
    await within(menu().getByRole("button", { name: /점검/ })).findByTestId("nav-count");
    openMenu("역할");
    openMenu("점검");
    await act(async () => {});
    expect(m.findings).toHaveBeenCalledTimes(1);
  });

  test("a failure of the findings does not get in the way of the other screens", async () => {
    m.findings.mockRejectedValue({ kind: "other", message: "점검을 읽지 못했어요" });
    setup();
    await connected();
    openMenu("점검");
    await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(1));
    openMenu("역할");
    expect(await screen.findByRole("table", { name: "역할 목록" })).toBeInTheDocument();
    expect(menu().queryByTestId("nav-count")).not.toBeInTheDocument();
    expect(screen.queryByText("점검을 읽지 못했어요")).not.toBeInTheDocument();
  });

  test("moving between the screens keeps the connection: the overview is not read again", async () => {
    setup();
    await connected();
    for (const label of ["점검", "권한", "세션", "역할"]) fireEvent.click(menu().getByText(label).closest("button")!);
    await openRole("alice");
    fireEvent.click(menu().getByText("세션").closest("button")!);
    await act(async () => {});
    expect(m.open).toHaveBeenCalledTimes(1);
    expect(m.target).toHaveBeenCalledTimes(1);
  });

  test("each item opens its own screen, named in the menu and above", async () => {
    setup();
    await connected();
    const screens: [string, () => Promise<unknown>][] = [
      ["점검", () => screen.findByRole("heading", { name: /rds_superuser 멤버/ })],
      ["누가 할 수 있나", async () => screen.getByRole("search", { name: "누가 할 수 있나 검색" })],
      ["세션", () => screen.findByRole("table", { name: "세션 목록" })],
    ];
    for (const [label, shown] of screens) {
      openMenu(label);
      expect(menu().getByText(label).closest("button")).toHaveAttribute("aria-current", "page");
      expect(crumb().getByText(label)).toBeInTheDocument();
      expect(await shown()).toBeInTheDocument();
    }
    expect(screen.queryByText(/화면은 아직 준비 중이에요/)).not.toBeInTheDocument();
    openMenu("역할");
    expect(await screen.findByRole("table", { name: "역할 목록" })).toBeInTheDocument();
  });
});

describe("roles", () => {
  test("lists the users and groups, and keeps the system roles out", async () => {
    setup();
    await connected();
    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(screen.getByText("app_read")).toBeInTheDocument();
    expect(screen.queryByText("rds_superuser")).not.toBeInTheDocument();
    expect(crumb().getByText("역할")).toBeInTheDocument();
  });

  test("the toolbar filter narrows the list by name", async () => {
    const { update } = setup();
    await screen.findByText("alice");
    update({ filter: "app_" });
    expect(screen.queryByText("alice")).not.toBeInTheDocument();
    expect(screen.getByText("app_owner")).toBeInTheDocument();
    expect(screen.getByText("app_read")).toBeInTheDocument();
  });

  test("double-clicking a row opens the detail, with a breadcrumb back to the list", async () => {
    setup();
    await openRole("alice");
    expect(m.role).toHaveBeenCalledWith(pgTarget, "alice");
    expect(screen.queryByRole("table", { name: "역할 목록" })).not.toBeInTheDocument();
    expect(crumb().getByRole("button", { name: "역할" })).toBeInTheDocument();
    expect(crumb().getByText("alice")).toBeInTheDocument();
    fireEvent.click(crumb().getByRole("button", { name: "역할" }));
    expect(screen.getByRole("table", { name: "역할 목록" })).toBeInTheDocument();
  });

  test("Enter opens the selected row", async () => {
    setup();
    fireEvent.click(await screen.findByText("bob"));
    fireEvent.keyDown(screen.getByTestId("iam-list"), { key: "Enter" });
    expect(await screen.findByRole("heading", { name: "bob" })).toBeInTheDocument();
  });

  test("the detail is for the role of the row, and the toolbar filter does not touch it", async () => {
    const { update } = setup();
    await openRole("app_owner");
    update({ filter: "zzz" });
    expect(screen.getByRole("heading", { name: "app_owner" })).toBeInTheDocument();
  });

  test("back and forward walk through the history and keep the selected row", async () => {
    setup();
    const back = (await screen.findByRole("button", { name: "뒤로" })) as HTMLButtonElement;
    const forward = screen.getByRole("button", { name: "앞으로" }) as HTMLButtonElement;
    expect(back).toBeDisabled();
    expect(forward).toBeDisabled();
    await openRole("alice");
    expect(back).toBeEnabled();
    fireEvent.click(back);
    expect(screen.getByRole("table", { name: "역할 목록" })).toBeInTheDocument();
    expect(rowOf("alice")).toHaveAttribute("aria-selected", "true");
    expect(forward).toBeEnabled();
    fireEvent.click(forward);
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument();
  });

  test("the chips and the system roles toggle are still as they were after a visit to a detail", async () => {
    setup();
    await screen.findByText("alice");
    fireEvent.click(screen.getByRole("checkbox", { name: "시스템 역할 보기" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "그룹" }));
    await openRole("postgres");
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(screen.getByRole("checkbox", { name: "시스템 역할 보기" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "그룹" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "사용자" })).toBeChecked();
    expect(screen.queryByText("app_read")).not.toBeInTheDocument();
  });

  test("a system role can be opened once the toggle shows it", async () => {
    setup();
    await screen.findByText("alice");
    fireEvent.click(screen.getByRole("checkbox", { name: "시스템 역할 보기" }));
    fireEvent.doubleClick(screen.getByText("rds_superuser"));
    expect(await screen.findByRole("heading", { name: "rds_superuser" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(rowOf("rds_superuser")).toHaveAttribute("aria-selected", "true");
  });

  test("a role opened after 점검 was visited reads no database view until 불러오기 is pressed", async () => {
    // 점검을 열면 백엔드는 연결할 수 있는 데이터베이스를 읽는다. 그 뒤 역할은 analytics만 빼고 읽은 것으로 답한다
    m.role.mockImplementation(async (_t, role) => {
      const view = sampleRoleView(role);
      return { ...view, databases: view.databases.map((d) => ({ ...d, loaded: d.database !== "analytics" })) };
    });
    setup();
    await connected();
    openMenu("점검");
    await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(1));
    openMenu("역할");
    await openRole("alice");
    fireEvent.click(screen.getByRole("tab", { name: "권한" }));
    await within(screen.getByRole("region", { name: "orders" })).findByRole("table");
    await act(async () => {});
    expect(m.database).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("region", { name: "analytics" })).getByRole("button", { name: "불러오기" }));
    await waitFor(() => expect(m.database).toHaveBeenCalledTimes(1));
    expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", false);
  });

  test("a group in the detail opens that role, and back restores the sub-tab that was open", async () => {
    setup();
    await openRole("alice");
    fireEvent.click(await screen.findByRole("tab", { name: "구성원" }));
    fireEvent.click(screen.getByRole("button", { name: "app_write" }));
    expect(await screen.findByRole("heading", { name: "app_write" })).toBeInTheDocument();
    expect(crumb().getByText("app_write")).toBeInTheDocument();
    // 다른 역할은 하위 탭을 처음(개요)부터 연다
    expect(screen.getByRole("tab", { name: "개요" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "구성원" })).toHaveAttribute("aria-selected", "true");
  });

  test("a role opened from a detail is the selected row when the list comes back", async () => {
    setup();
    await openRole("alice");
    fireEvent.click(await screen.findByRole("tab", { name: "구성원" }));
    fireEvent.click(screen.getByRole("button", { name: "app_write" }));
    await screen.findByRole("heading", { name: "app_write" });
    fireEvent.click(menu().getByRole("button", { name: /역할/ }));
    expect(rowOf("app_write")).toHaveAttribute("aria-selected", "true");
  });

  test("clicking 역할 in the menu from a detail goes to the list", async () => {
    setup();
    await openRole("alice");
    fireEvent.click(menu().getByRole("button", { name: /역할/ }));
    expect(screen.getByRole("table", { name: "역할 목록" })).toBeInTheDocument();
  });
});

describe("privileges", () => {
  const grid = () => screen.getByRole("grid", { name: "권한 표" });
  const picker = () => screen.getByRole("combobox", { name: "데이터베이스" });
  const loadedGrid = () => screen.findByRole("grid", { name: "권한 표" });
  const rowHeads = () => within(grid()).getAllByRole("rowheader").map((h) => h.textContent);
  const cellOf = (role: string, schema: string) => within(grid()).getByRole("button", { name: (n) => n.startsWith(`${role} · ${schema}: `) });
  const openPrivileges = async () => {
    await connected();
    openMenu("권한");
    return loadedGrid();
  };

  test("opens on the default database of the target, with the users and then the groups", async () => {
    setup();
    await openPrivileges();
    expect(m.database).toHaveBeenCalledWith(pgTarget, "orders", false);
    expect(picker()).toHaveValue("orders");
    expect(crumb().getByText("권한")).toBeInTheDocument();
    expect(rowHeads()).toEqual(["사용자 5", "alice", "app_owner", "bob", "iam_admin", "postgres", "그룹 2", "app_read", "app_write"]);
  });

  test("the toolbar filter narrows the rows by name", async () => {
    const { update } = setup();
    await openPrivileges();
    update({ filter: "app_" });
    expect(rowHeads()).toEqual(["사용자 1", "app_owner", "그룹 2", "app_read", "app_write"]);
  });

  test("the chips and the system roles toggle are those of the role list, in both directions", async () => {
    setup();
    await connected();
    await screen.findByText("alice");
    fireEvent.click(screen.getByRole("checkbox", { name: "시스템 역할 보기" }));
    openMenu("권한");
    await loadedGrid();
    expect(screen.getByRole("checkbox", { name: "시스템 역할 보기" })).toBeChecked();
    expect(within(grid()).getByRole("rowheader", { name: "rds_superuser" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "그룹" }));
    expect(rowHeads()).toEqual(["사용자 5", "alice", "app_owner", "bob", "iam_admin", "postgres"]);
    openMenu("역할");
    expect(screen.getByRole("checkbox", { name: "그룹" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "시스템 역할 보기" })).toBeChecked();
  });

  test("the database that was chosen is the choice of the tab: 기본 권한 opens on it, directly and by way of 역할", async () => {
    setup();
    await openPrivileges();
    fireEvent.change(picker(), { target: { value: "analytics" } });
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", false));
    openMenu("기본 권한");
    await screen.findByRole("table", { name: "기본 권한" });
    expect(picker()).toHaveValue("analytics");
    openMenu("역할");
    openMenu("기본 권한");
    await screen.findByRole("table", { name: "기본 권한" });
    expect(picker()).toHaveValue("analytics");
    openMenu("권한");
    await loadedGrid();
    expect(picker()).toHaveValue("analytics");
    // 세 화면이 analytics를 한 번만 읽었다(같은 읽기를 함께 쓴다)
    expect(m.database.mock.calls.filter((call) => call[1] === "analytics")).toEqual([[pgTarget, "analytics", false]]);
  });

  test("a database chosen on 기본 권한 is the one 권한 opens on", async () => {
    setup();
    await connected();
    openMenu("기본 권한");
    await screen.findByRole("table", { name: "기본 권한" });
    fireEvent.change(picker(), { target: { value: "postgres" } });
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "postgres", false));
    openMenu("권한");
    await loadedGrid();
    expect(picker()).toHaveValue("postgres");
  });

  test("the choice stays when the snapshot is read again", async () => {
    setup();
    await openPrivileges();
    fireEvent.change(picker(), { target: { value: "analytics" } });
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", false));
    m.database.mockClear();
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", true));
    expect(picker()).toHaveValue("analytics");
    expect(m.database).not.toHaveBeenCalledWith(pgTarget, "orders", expect.anything());
  });

  test("the database that was chosen stays chosen when back brings the screen again", async () => {
    setup();
    await openPrivileges();
    fireEvent.change(picker(), { target: { value: "analytics" } });
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", false));
    openMenu("세션");
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    await loadedGrid();
    expect(picker()).toHaveValue("analytics");
    fireEvent.click(screen.getByRole("button", { name: "앞으로" }));
    expect(await screen.findByRole("table", { name: "세션 목록" })).toBeInTheDocument();
  });

  test("choosing a database does not add an entry to the history", async () => {
    setup();
    await openPrivileges();
    fireEvent.change(picker(), { target: { value: "analytics" } });
    fireEvent.change(picker(), { target: { value: "postgres" } });
    expect(picker()).toHaveValue("postgres");
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(screen.getByRole("table", { name: "역할 목록" })).toBeInTheDocument();
  });

  test("a cell opens its detail beside the grid, and Esc closes it and gives the focus back", async () => {
    setup();
    await openPrivileges();
    fireEvent.click(cellOf("alice", "app"));
    expect(m.cell).toHaveBeenCalledWith(pgTarget, "orders", "alice", "app");
    expect(await screen.findByText("app.customers")).toBeInTheDocument();
    expect(grid()).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("complementary", { name: "alice · app" }), { key: "Escape" });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(cellOf("alice", "app")).toHaveFocus();
  });

  test("coming back to it reads nothing again, and 기본 권한 shares the read of the same database", async () => {
    setup();
    await openPrivileges();
    openMenu("역할");
    openMenu("권한");
    await loadedGrid();
    openMenu("기본 권한");
    await screen.findByRole("table", { name: "기본 권한" });
    expect(m.database).toHaveBeenCalledTimes(1);
  });

  test("다시 읽기 reads the database again with force, and the grid is still there", async () => {
    setup();
    await openPrivileges();
    m.database.mockClear();
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "orders", true));
    expect(await loadedGrid()).toBeInTheDocument();
    expect(m.database).toHaveBeenCalledTimes(1);
  });

  test("a database that cannot be read shows why through the error box, and the picker lets you leave it", async () => {
    m.database.mockImplementation(async (_t, database) => {
      if (database === "analytics") throw { kind: "other", message: '"analytics"에 연결하지 못했어요: permission denied' };
      return sampleDatabaseView({ database });
    });
    setup();
    await openPrivileges();
    fireEvent.change(picker(), { target: { value: "analytics" } });
    expect(await screen.findByText('"analytics"에 연결하지 못했어요: permission denied')).toBeInTheDocument();
    fireEvent.change(picker(), { target: { value: "orders" } });
    expect(await loadedGrid()).toBeInTheDocument();
  });
});

describe("default privileges", () => {
  const picker = () => screen.getByRole("combobox", { name: "데이터베이스" });
  const loadedTable = () => screen.findByRole("table", { name: "기본 권한" });

  test("shows the note, the table and the sentences of the default database of the target", async () => {
    setup();
    await connected();
    openMenu("기본 권한");
    await loadedTable();
    expect(m.database).toHaveBeenCalledWith(pgTarget, "orders", false);
    expect(picker()).toHaveValue("orders");
    expect(crumb().getByText("기본 권한")).toBeInTheDocument();
    expect(screen.getByText(/^PostgreSQL 기본값: /)).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "app_owner · app" })).toBeInTheDocument();
    expect(screen.getByText("app_owner 역할이 app에 새 테이블을 만들면 app_read 역할이 SELECT 권한을 받아요")).toBeInTheDocument();
  });

  test("the database that was chosen stays chosen when back brings the screen again, here too", async () => {
    setup();
    await connected();
    openMenu("기본 권한");
    await loadedTable();
    fireEvent.change(picker(), { target: { value: "postgres" } });
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "postgres", false));
    openMenu("세션");
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    await loadedTable();
    expect(picker()).toHaveValue("postgres");
  });

  test("다시 읽기 reads the database again with force", async () => {
    setup();
    await connected();
    openMenu("기본 권한");
    await loadedTable();
    m.database.mockClear();
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "orders", true));
    expect(await loadedTable()).toBeInTheDocument();
  });
});

describe("findings", () => {
  const grid = () => screen.getByRole("grid", { name: "권한 표" });
  const picker = () => screen.getByRole("combobox", { name: "데이터베이스" });
  const itemRow = (text: string | RegExp) => screen.getByText(text).closest("tr") as HTMLElement;
  const openFindings = async () => {
    await connected();
    openMenu("점검");
    await screen.findByRole("heading", { name: /rds_superuser 멤버/ });
  };
  const markedColumns = () => within(grid()).getAllByRole("columnheader").filter((h) => h.getAttribute("aria-selected") === "true").map((h) => h.textContent?.replace(/(사용|만들기|읽기|쓰기)+$/, ""));
  const finding = (extra: Partial<ReturnType<typeof sampleFindings>["groups"][number]["items"][number]> & { detail: string }) => ({ database: null, role: null, object: null, ...extra });
  const withItems = (...items: ReturnType<typeof finding>[]) =>
    sampleFindings({ groups: [{ kind: "publicObjectGrant", level: "medium", title: "PUBLIC에 테이블·시퀀스 권한이 있어요", items }], skipped: [] });

  test("shows the groups, and the number in the menu is how many items there are in all", async () => {
    setup();
    await openFindings();
    expect(screen.getAllByRole("heading").map((h) => h.firstChild?.textContent?.trim())).toEqual([
      "rds_superuser 멤버",
      "search_path를 고정하지 않은 SECURITY DEFINER 함수",
      "CREATEROLE을 가진 역할",
      "만료됐거나 곧 만료되는 사용자",
      "점검하지 못한 데이터베이스",
    ]);
    expect(within(menu().getByRole("button", { name: /점검/ })).getByTestId("nav-count")).toHaveTextContent("5");
    expect(screen.getByText("역할별 비밀번호 해시 방식과 마지막 로그인은 RDS에서 볼 수 없어 점검하지 않아요")).toBeInTheDocument();
  });

  test("a role of an item opens its detail, and back brings the findings again without reading them again", async () => {
    setup();
    await openFindings();
    fireEvent.click(within(itemRow("bob은 2026-11-05에 만료돼요")).getByRole("button", { name: "bob" }));
    expect(await screen.findByRole("heading", { name: "bob" })).toBeInTheDocument();
    expect(m.role).toHaveBeenCalledWith(pgTarget, "bob");
    expect(crumb().getByText("역할")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(await screen.findByRole("heading", { name: /rds_superuser 멤버/ })).toBeInTheDocument();
    expect(m.findings).toHaveBeenCalledTimes(1);
  });

  test("an object of an item opens the privileges of its database with its schema marked and the focus in its column", async () => {
    setup();
    await openFindings();
    fireEvent.click(within(itemRow(/^app.touch_order는 SECURITY DEFINER/)).getByRole("button", { name: "app.touch_order(order_id integer)" }));
    await screen.findByRole("grid", { name: "권한 표" });
    expect(crumb().getByText("권한")).toBeInTheDocument();
    expect(menu().getByText("권한").closest("button")).toHaveAttribute("aria-current", "page");
    expect(picker()).toHaveValue("orders");
    expect(m.database).toHaveBeenCalledWith(pgTarget, "orders", false);
    expect(markedColumns()).toEqual(["app"]);
    expect(within(grid()).getByRole("button", { name: (n) => n.startsWith("alice · app: ") })).toHaveFocus();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  test("an object in another database makes that database the choice of the tab, for every screen that has one", async () => {
    m.findings.mockResolvedValue(withItems(finding({ database: "analytics", object: ordersTable, detail: "analytics의 app.orders" })));
    setup();
    await connected();
    openMenu("점검");
    fireEvent.click(await screen.findByRole("button", { name: "app.orders" }));
    await screen.findByRole("grid", { name: "권한 표" });
    expect(picker()).toHaveValue("analytics");
    expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", false);
    expect(m.database).not.toHaveBeenCalledWith(pgTarget, "orders", expect.anything());
    openMenu("기본 권한");
    await screen.findByRole("table", { name: "기본 권한" });
    expect(picker()).toHaveValue("analytics");
    openMenu("누가 할 수 있나");
    expect(picker()).toHaveValue("analytics");
  });

  test("an item that names a role and a schema opens that role's cell, with the detail in focus", async () => {
    m.findings.mockResolvedValue(withItems(finding({ database: "orders", role: "bob", object: object("schema", null, "app"), detail: "bob은 app의 새 테이블을 읽지 못해요" })));
    setup();
    await connected();
    openMenu("점검");
    fireEvent.click(within(await screen.findByText("bob은 app의 새 테이블을 읽지 못해요").then((el) => el.closest("tr") as HTMLElement)).getByRole("button", { name: "app" }));
    expect(await screen.findByRole("complementary", { name: "bob · app" })).toBeInTheDocument();
    expect(m.cell).toHaveBeenCalledWith(pgTarget, "orders", "bob", "app");
    expect(screen.getByRole("complementary", { name: "bob · app" })).toHaveFocus();
  });

  test("the privileges opened from the menu afterwards come as usual, and so does the next one opened from a finding", async () => {
    setup();
    await openFindings();
    fireEvent.click(within(itemRow(/^app.touch_order는 SECURITY DEFINER/)).getByRole("button", { name: "app.touch_order(order_id integer)" }));
    await screen.findByRole("grid", { name: "권한 표" });
    expect(markedColumns()).toEqual(["app"]);
    openMenu("역할");
    openMenu("권한");
    await screen.findByRole("grid", { name: "권한 표" });
    expect(markedColumns()).toEqual([]);
    // 점검에서 다시 누르면 새 부탁이라서 그 부탁은 다시 쓴다
    openMenu("점검");
    fireEvent.click(within(itemRow(/^app.touch_order는 SECURITY DEFINER/)).getByRole("button", { name: "app.touch_order(order_id integer)" }));
    await screen.findByRole("grid", { name: "권한 표" });
    expect(markedColumns()).toEqual(["app"]);
  });

  test("back from the privileges it opened is the findings, forward is the privileges again as they were left", async () => {
    setup();
    await openFindings();
    fireEvent.click(within(itemRow(/^app.touch_order는 SECURITY DEFINER/)).getByRole("button", { name: "app.touch_order(order_id integer)" }));
    await screen.findByRole("grid", { name: "권한 표" });
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(await screen.findByRole("heading", { name: /rds_superuser 멤버/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "앞으로" }));
    await screen.findByRole("grid", { name: "권한 표" });
    expect(picker()).toHaveValue("orders");
    expect(markedColumns()).toEqual([]);
  });

  test("the databases it could not read are told with their reasons", async () => {
    setup();
    await openFindings();
    const row = screen.getByRole("table", { name: "점검하지 못한 데이터베이스" });
    expect(within(row).getByText('analytics에 연결하지 못했어요: permission denied for database "analytics"')).toBeInTheDocument();
  });
});

describe("who can", () => {
  const picker = () => screen.getByRole("combobox", { name: "데이터베이스" });
  const openWhoCan = async () => {
    await connected();
    openMenu("누가 할 수 있나");
    return screen.getByRole("search", { name: "누가 할 수 있나 검색" });
  };
  const chooseObject = async (name = "app.orders") => {
    fireEvent.click(within(screen.getByRole("search", { name: "누가 할 수 있나 검색" })).getByRole("button"));
    fireEvent.click(await within(screen.getByRole("dialog", { name: "객체 고르기" })).findByText(name, { selector: ".pk-name" }));
  };

  test("opens on the default database of the target and reads nothing until an object is chosen", async () => {
    setup();
    await openWhoCan();
    expect(picker()).toHaveValue("orders");
    expect(crumb().getByText("누가 할 수 있나")).toBeInTheDocument();
    expect(m.objects).not.toHaveBeenCalled();
    expect(m.whoCan).not.toHaveBeenCalled();
  });

  test("searches the objects of the database that is showing and tells who can, with the way to the privilege", async () => {
    setup();
    await openWhoCan();
    await chooseObject();
    expect(m.objects).toHaveBeenCalledWith(pgTarget, "orders", "");
    await waitFor(() => expect(m.whoCan).toHaveBeenCalledWith(pgTarget, "orders", ordersTable, "SELECT"));
    const table = await screen.findByRole("table", { name: "할 수 있는 역할" });
    expect(within(table).getByText("alice ← app_write ← app_read ← 직접 받음")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "권한은 있지만 실제로는 못 써요" })).toBeInTheDocument();
  });

  test("the database that was chosen is the choice of the tab, in both directions", async () => {
    setup();
    await openWhoCan();
    fireEvent.change(picker(), { target: { value: "analytics" } });
    openMenu("권한");
    await screen.findByRole("grid", { name: "권한 표" });
    expect(picker()).toHaveValue("analytics");
    fireEvent.change(picker(), { target: { value: "postgres" } });
    openMenu("누가 할 수 있나");
    expect(picker()).toHaveValue("postgres");
    expect(m.database.mock.calls.filter((call) => call[1] === "analytics")).toEqual([[pgTarget, "analytics", false]]);
  });

  test("the chips and the system roles toggle are those of the role list, in both directions", async () => {
    setup();
    await connected();
    await screen.findByText("alice");
    fireEvent.click(screen.getByRole("checkbox", { name: "시스템 역할 보기" }));
    openMenu("누가 할 수 있나");
    expect(screen.getByRole("checkbox", { name: "시스템 역할 보기" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "그룹" }));
    openMenu("역할");
    expect(screen.getByRole("checkbox", { name: "그룹" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "시스템 역할 보기" })).toBeChecked();
  });

  test("shows the system roles of the answer once the toggle is on", async () => {
    setup();
    await openWhoCan();
    await chooseObject();
    const table = await screen.findByRole("table", { name: "할 수 있는 역할" });
    expect(within(table).queryByText("pg_read_all_data", { selector: "th" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "시스템 역할 보기" }));
    expect(within(table).getByText("pg_read_all_data", { selector: "th" })).toBeInTheDocument();
  });

  test("다시 읽기 reads the answer again", async () => {
    setup();
    await openWhoCan();
    await chooseObject();
    await screen.findByRole("table", { name: "할 수 있는 역할" });
    m.whoCan.mockClear();
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(m.whoCan).toHaveBeenCalledTimes(1));
    expect(m.whoCan).toHaveBeenCalledWith(pgTarget, "orders", ordersTable, "SELECT");
  });
});

describe("sessions", () => {
  const sessionTable = () => screen.findByRole("table", { name: "세션 목록" });

  test("lists the sessions of the cluster, and this app's own are marked", async () => {
    setup();
    await connected();
    openMenu("세션");
    const table = await sessionTable();
    expect(crumb().getByText("세션")).toBeInTheDocument();
    expect(m.sessions).toHaveBeenCalledWith(pgTarget);
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    expect(within(table).getAllByText("이 앱")).toHaveLength(2);
  });

  test("is read each time the screen is opened", async () => {
    setup();
    await connected();
    openMenu("세션");
    await sessionTable();
    openMenu("역할");
    openMenu("세션");
    await waitFor(() => expect(m.sessions).toHaveBeenCalledTimes(2));
  });

  test("the 다시 읽기 of the screen reads only the sessions", async () => {
    setup();
    await connected();
    openMenu("세션");
    await sessionTable();
    m.sessions.mockClear();
    m.open.mockClear();
    fireEvent.click(within(document.querySelector(".pg-screen") as HTMLElement).getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(m.sessions).toHaveBeenCalledTimes(1));
    expect(m.open).not.toHaveBeenCalled();
  });

  test("the 다시 읽기 of the top bar reads them too", async () => {
    setup();
    await connected();
    openMenu("세션");
    await sessionTable();
    m.sessions.mockClear();
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(m.sessions).toHaveBeenCalledTimes(1));
    expect(m.open).toHaveBeenCalledTimes(2);
  });

  test("a failure shows through the error box and does not get in the way of the other screens", async () => {
    m.sessions.mockRejectedValue({ kind: "other", message: "세션을 읽지 못했어요" });
    setup();
    await connected();
    openMenu("세션");
    expect(await screen.findByText("세션을 읽지 못했어요")).toBeInTheDocument();
    openMenu("역할");
    expect(await screen.findByRole("table", { name: "역할 목록" })).toBeInTheDocument();
  });
});

describe("history keys", () => {
  test("⌘[ and ⌘] navigate back and forward", async () => {
    setup();
    await openRole("alice");
    metaKey("[");
    expect(screen.getByRole("table", { name: "역할 목록" })).toBeInTheDocument();
    metaKey("]");
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument();
  });

  test("a tab that is not showing ignores ⌘[ and the mouse buttons", async () => {
    setup({ active: false });
    await openRole("alice");
    metaKey("[");
    expect(screen.getByRole("heading", { name: "alice" })).toBeInTheDocument();
    expect(mouseNav).toBeNull();
  });

  test("the mouse back and forward buttons navigate", async () => {
    setup();
    await openRole("alice");
    await waitFor(() => expect(mouseNav).not.toBeNull());
    act(() => mouseNav!("back"));
    expect(screen.getByRole("table", { name: "역할 목록" })).toBeInTheDocument();
    act(() => mouseNav!("forward"));
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument();
  });

  test("keys typed into the DB user field do not navigate", async () => {
    setup();
    await openRole("alice");
    fireEvent.click(topBar().getByRole("button", { name: "바꾸기" }));
    promptInput().focus();
    metaKey("[");
    expect(screen.getByRole("heading", { name: "DB 사용자" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument();
  });
});

describe("one tab per target", () => {
  test("another target has its own connection and its own state", async () => {
    const other: PgTarget = { ...pgTarget, id: "billing" };
    m.target.mockImplementation(async (t) => sampleTargetInfo({ identifier: t.id, arn: `arn:aws:rds:ap-northeast-2:123456789012:cluster:${t.id}` }));
    vi.mocked(api.getSettings).mockResolvedValue(settingsWith({ [ARN]: LOGIN_USER, "arn:aws:rds:ap-northeast-2:123456789012:cluster:billing": "billing_admin" }));
    setup({ target: other });
    await connected();
    expect(m.open).toHaveBeenCalledWith(other, "billing_admin");
    expect(topBar().getByText("billing")).toBeInTheDocument();
    expect(topBar().getByText("billing_admin")).toBeInTheDocument();
  });
});
