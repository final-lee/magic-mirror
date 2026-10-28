import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../api/client";
import type { Settings } from "../api/types";
import { SsoLoginContext, type SsoLogin } from "../lib/useSsoLogin";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import { LOGIN_USER, pgTarget, sampleDatabaseView, sampleFindings, sampleOverview, sampleRoleView, sampleSessions, sampleTargetInfo } from "./fixtures";
import { PgTab } from "./PgTab";
import { pgKeys } from "./queries";
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
  m.findings.mockResolvedValue(sampleFindings());
  m.role.mockImplementation(async (_t, role) => sampleRoleView(role));
  m.sessions.mockResolvedValue(sampleSessions());
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
    const manager: SsoLogin = {
      entries: [],
      statusFor: () => null,
      lastSuccessAt: () => null,
      start: vi.fn(async () => true),
      cancel: vi.fn(),
      dismiss: vi.fn(),
      rearm: vi.fn(),
    };
    const tree = (sso: SsoLogin, qc: QueryClient) => (
      <QueryClientProvider client={qc}>
        <SsoLoginContext.Provider value={sso}>
          <PgTab {...baseProps} />
        </SsoLoginContext.Provider>
      </QueryClientProvider>
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
    const manager: SsoLogin = {
      entries: [],
      statusFor: () => null,
      lastSuccessAt: () => null,
      start: vi.fn(async () => true),
      cancel: vi.fn(),
      dismiss: vi.fn(),
      rearm: vi.fn(),
    };
    const tree = (sso: SsoLogin, qc: QueryClient) => (
      <QueryClientProvider client={qc}>
        <SsoLoginContext.Provider value={sso}>
          <PgTab {...baseProps} />
        </SsoLoginContext.Provider>
      </QueryClientProvider>
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
    await openRole("alice");
    await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(1));
    expect(m.role).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    m.open.mockResolvedValue(sampleOverview({ loginUser: "bob" }));
    m.findings.mockResolvedValue(sampleFindings());
    m.role.mockImplementation(async (_t, role) => sampleRoleView(role));

    fireEvent.click(topBar().getByRole("button", { name: "바꾸기" }));
    const user = await type("bob");
    await user.click(screen.getByRole("button", { name: "연결" }));
    expect(await screen.findByRole("heading", { name: "alice" })).toBeInTheDocument(); // 보던 상세로 돌아온다
    await waitFor(() => expect(m.findings).toHaveBeenCalledWith(pgTarget, true));
    await waitFor(() => expect(m.role).toHaveBeenCalledWith(pgTarget, "alice"));
    expect(m.open).toHaveBeenCalledTimes(1); // 다시 연결하지는 않는다
    expect(m.open).toHaveBeenCalledWith(pgTarget, "bob");
    expect(m.target).not.toHaveBeenCalled();
  });

  test("nothing is read again just because the connection came up the first time", async () => {
    const { qc } = setup();
    await connected();
    await act(async () => {});
    expect(m.findings).toHaveBeenCalledTimes(1);
    expect(m.findings).toHaveBeenCalledWith(pgTarget, false);
    // 첫 연결에서 다시 읽기를 걸었다면 "다음 조회는 force" 표시가 남아, 다음 평범한 조회가 force로 나간다
    await act(async () => {
      await qc.invalidateQueries({ queryKey: pgKeys.findings(pgTarget) });
    });
    expect(m.findings).toHaveBeenCalledTimes(2);
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

  test("다시 읽기 reads everything again: the target, the connection, the snapshots with force", async () => {
    setup();
    await connected();
    await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(1));
    fireEvent.click(topBar().getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(m.open).toHaveBeenCalledTimes(2));
    expect(m.open).toHaveBeenLastCalledWith(pgTarget, LOGIN_USER);
    expect(m.target).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(2));
    expect(m.findings).toHaveBeenLastCalledWith(pgTarget, true);
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

  test("점검 shows the number of findings once they are loaded", async () => {
    setup();
    await connected();
    const count = await within(menu().getByRole("button", { name: /점검/ })).findByTestId("nav-count");
    expect(count).toHaveTextContent("5"); // rds_superuser 2 + SECURITY DEFINER 1 + CREATEROLE 1 + 만료 1
    expect(count).toHaveClass("alert");
    expect(m.findings).toHaveBeenCalledWith(pgTarget, false);
  });

  test("점검 shows no number while the findings are being read, or when they could not be read", async () => {
    let resolve!: (v: ReturnType<typeof sampleFindings>) => void;
    m.findings.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    await connected();
    expect(menu().queryByTestId("nav-count")).not.toBeInTheDocument();
    await act(async () => resolve(sampleFindings()));
    expect(await menu().findByTestId("nav-count")).toHaveTextContent("5");
  });

  test("the findings are not read before the connection is up", async () => {
    let resolve!: (v: ReturnType<typeof sampleOverview>) => void;
    m.open.mockReturnValue(new Promise((r) => (resolve = r)));
    setup();
    await screen.findByText("연결하는 중이에요");
    expect(m.findings).not.toHaveBeenCalled();
    await act(async () => resolve(sampleOverview()));
    await connected();
    await waitFor(() => expect(m.findings).toHaveBeenCalledTimes(1));
  });

  test("a failure of the findings does not get in the way of the other screens", async () => {
    m.findings.mockRejectedValue({ kind: "other", message: "점검을 읽지 못했어요" });
    setup();
    await connected();
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

  test("the other screens are not built yet and say so, each under its own name", async () => {
    setup();
    await connected();
    for (const label of ["점검", "권한", "기본 권한", "누가 할 수 있나", "세션"]) {
      fireEvent.click(menu().getByText(label).closest("button")!);
      expect(menu().getByText(label).closest("button")).toHaveAttribute("aria-current", "page");
      expect(crumb().getByText(label)).toBeInTheDocument();
      expect(screen.getByText(`${label} 화면은 아직 준비 중이에요`)).toBeInTheDocument();
    }
    fireEvent.click(menu().getByText("역할").closest("button")!);
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
