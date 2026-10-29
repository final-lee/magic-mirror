import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../api/client";
import type { Settings } from "../api/types";
import { renderWithClient } from "../test/utils";
import { pgApi } from "./api";
import {
  LOGIN_USER,
  createCarol,
  pgTarget,
  resetAlicePassword,
  sampleChangeLog,
  sampleDatabaseView,
  sampleDropPlan,
  sampleOverview,
  samplePresetSuggestion,
  samplePreview,
  sampleRoleView,
  sampleSessions,
  sampleTargetInfo,
} from "./fixtures";
import { PgTab } from "./PgTab";
import type { PgChange } from "./types";

vi.mock("./api", () => ({
  pgApi: {
    target: vi.fn(),
    open: vi.fn(),
    database: vi.fn(),
    role: vi.fn(),
    sessions: vi.fn(),
    findings: vi.fn(),
    close: vi.fn(),
    overview: vi.fn(),
    preview: vi.fn(),
    apply: vi.fn(),
    preset: vi.fn(),
    dropPlan: vi.fn(),
    applyDrop: vi.fn(),
    changeLog: vi.fn(),
  },
}));
vi.mock("../api/client", () => ({ api: { getSettings: vi.fn(), saveSettings: vi.fn(), ssoLogin: vi.fn() } }));
vi.mock("../explorer/api", () => ({ onMouseNav: vi.fn(async () => () => {}) }));

const m = vi.mocked(pgApi);
const ARN = sampleTargetInfo().arn;
const READ_REPLICA = "읽기 전용 복제본이라 바꿀 수 없어요";
const MANAGE_REASON = "이 사용자는 rds_superuser 멤버가 아니고 CREATEROLE도 없어서 바꿀 수 없어요";
const PASSWORD = "Xk3pQ9mZtR7vNb2WcH5yJd4a";
const settings: Settings = { enabledServices: ["ec2", "rds"], favorites: [], lastProfile: "prod", lastRegion: null, pgLogins: { [ARN]: LOGIN_USER } };

const setup = () => renderWithClient(<PgTab target={pgTarget} title="🐘 orders-aurora" active filter="" />);
const menu = () => within(screen.getByRole("navigation", { name: "PostgreSQL 메뉴" }));
const openMenu = (label: string) => fireEvent.click(menu().getByText(label).closest("button")!);
const connected = () => screen.findByRole("navigation", { name: "PostgreSQL 메뉴" });
const user = () => userEvent.setup();
const previewOf = (change: PgChange, extra = {}) => samplePreview({ change, summary: "미리보기", warnings: [], sql: ["-- sql"], ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  document.querySelectorAll(".modal").forEach((e) => e.remove());
  vi.mocked(api.getSettings).mockResolvedValue(settings);
  vi.mocked(api.saveSettings).mockResolvedValue(undefined);
  m.target.mockResolvedValue(sampleTargetInfo());
  m.open.mockResolvedValue(sampleOverview());
  m.overview.mockResolvedValue(sampleOverview());
  m.database.mockImplementation(async (_t, database) => sampleDatabaseView({ database }));
  m.role.mockImplementation(async (_t, role) => sampleRoleView(role));
  m.sessions.mockResolvedValue(sampleSessions());
  m.close.mockResolvedValue(null);
  m.changeLog.mockResolvedValue(sampleChangeLog());
  m.preset.mockResolvedValue(samplePresetSuggestion());
  m.dropPlan.mockResolvedValue(sampleDropPlan());
  m.preview.mockImplementation(async (_t, change) => previewOf(change));
});

describe("역할 만들기", () => {
  const openCreate = async () => {
    await connected();
    await user().click(screen.getByRole("button", { name: "역할 만들기" }));
    return screen.findByRole("dialog", { name: "역할 만들기" });
  };

  test("[미리보기] starts the createRole change; the form stays under the preview", async () => {
    setup();
    await openCreate();
    await user().type(screen.getByRole("textbox", { name: "이름" }), "carol");
    await user().click(screen.getByRole("button", { name: "미리보기" }));
    await waitFor(() => expect(m.preview).toHaveBeenCalledWith(pgTarget, { ...createCarol, groups: [] }));
    expect(await screen.findByRole("dialog", { name: "미리보기" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "역할 만들기" })).toBeInTheDocument();
    // 미리보기를 취소하면 폼이 그대로 남는다
    await user().click(within(screen.getByRole("dialog", { name: "미리보기" })).getByRole("button", { name: "취소" }));
    expect(screen.getByRole("textbox", { name: "이름" })).toHaveValue("carol");
  });

  test("a user ends in the password phase, and the form closes once the change is applied", async () => {
    m.apply.mockResolvedValue({ logId: "l1", summary: "역할 만들기: carol", password: PASSWORD });
    setup();
    await openCreate();
    await user().type(screen.getByRole("textbox", { name: "이름" }), "carol");
    await user().click(screen.getByRole("button", { name: "미리보기" }));
    const preview = await screen.findByRole("dialog", { name: "미리보기" });
    await user().click(within(preview).getByRole("button", { name: "적용" }));
    const result = await screen.findByRole("dialog", { name: "새 비밀번호" });
    expect(within(result).getByDisplayValue(PASSWORD)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "역할 만들기" })).not.toBeInTheDocument();
    await user().click(within(result).getByRole("button", { name: "닫기" }));
    expect(document.body.textContent).not.toContain(PASSWORD);
  });

  test("is off with the reason on a read replica and for a login that can not manage", async () => {
    m.open.mockResolvedValue(sampleOverview({ target: sampleTargetInfo({ readReplica: true }), canManage: false, manageReason: MANAGE_REASON }));
    setup();
    await connected();
    const button = screen.getByRole("button", { name: "역할 만들기" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", READ_REPLICA);
  });
});

describe("비밀번호 재설정", () => {
  test("starts a password change for the role and ends in the password phase", async () => {
    m.apply.mockResolvedValue({ logId: "l2", summary: "비밀번호 재설정: alice", password: PASSWORD });
    setup();
    await connected();
    openMenu("역할");
    await user().click(await screen.findByText("alice"));
    await user().dblClick(screen.getByText("alice"));
    await screen.findByRole("button", { name: "비밀번호 재설정" });
    await user().click(screen.getByRole("button", { name: "비밀번호 재설정" }));
    await waitFor(() => expect(m.preview).toHaveBeenCalledWith(pgTarget, resetAlicePassword));
    const preview = await screen.findByRole("dialog", { name: "미리보기" });
    await user().click(within(preview).getByRole("button", { name: "적용" }));
    expect(await screen.findByRole("dialog", { name: "새 비밀번호" })).toBeInTheDocument();
  });
});

describe("역할 삭제", () => {
  async function openDrop() {
    await connected();
    openMenu("역할");
    await user().dblClick(await screen.findByText("alice"));
    await user().click(await screen.findByRole("button", { name: "삭제" }));
    return screen.findByRole("dialog", { name: "역할 삭제" });
  }

  test("a full success closes the dialog, announces it, refreshes and goes back to the role list", async () => {
    m.applyDrop.mockResolvedValue({ logId: "l3", total: 3, done: 3, stopped: null });
    setup();
    const dialog = await openDrop();
    await user().type(await within(dialog).findByLabelText("확인하려면 입력하세요: alice"), "alice");
    await user().click(within(dialog).getByRole("button", { name: "적용" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "역할 삭제" })).not.toBeInTheDocument());
    expect(m.applyDrop).toHaveBeenCalledWith(pgTarget, "alice", LOGIN_USER, "alice");
    expect(screen.getByRole("status")).toHaveTextContent("역할 삭제: alice");
    expect(await screen.findByRole("table", { name: "역할 목록" })).toBeInTheDocument();
    expect(m.overview).toHaveBeenCalled();
  });

  test("the back button does not return to the role that is gone", async () => {
    m.applyDrop.mockResolvedValue({ logId: "l3", total: 3, done: 3, stopped: null });
    setup();
    const dialog = await openDrop();
    await user().type(await within(dialog).findByLabelText("확인하려면 입력하세요: alice"), "alice");
    await user().click(within(dialog).getByRole("button", { name: "적용" }));
    await screen.findByRole("table", { name: "역할 목록" });
    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(screen.queryByRole("heading", { name: "alice" })).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "역할 목록" })).toBeInTheDocument();
  });

  test("a drop that stopped keeps the dialog and the role page", async () => {
    m.applyDrop.mockResolvedValue({ logId: "l3", total: 3, done: 1, stopped: "3개 데이터베이스 중 1개를 정리하고 멈췄어요: 연결이 끊겼어요" });
    setup();
    const dialog = await openDrop();
    await user().type(await within(dialog).findByLabelText("확인하려면 입력하세요: alice"), "alice");
    await user().click(within(dialog).getByRole("button", { name: "적용" }));
    expect(await within(dialog).findByText("3개 데이터베이스 중 1개를 정리하고 멈췄어요: 연결이 끊겼어요")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "alice" })).toBeInTheDocument();
    await user().click(within(dialog).getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("dialog", { name: "역할 삭제" })).not.toBeInTheDocument();
  });

  test("is off with the reason on a read replica", async () => {
    m.open.mockResolvedValue(sampleOverview({ target: sampleTargetInfo({ readReplica: true }) }));
    setup();
    await connected();
    openMenu("역할");
    await user().dblClick(await screen.findByText("alice"));
    const button = await screen.findByRole("button", { name: "삭제" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", READ_REPLICA);
  });
});

describe("세션 끊기", () => {
  test("끊기 starts a terminate change for the row", async () => {
    setup();
    await connected();
    openMenu("세션");
    const table = await screen.findByRole("table", { name: "세션 목록" });
    const sessions = sampleSessions();
    const target = sessions.find((s) => !s.own && s.role)!;
    const row = within(table).getAllByRole("row").slice(1)[sessions.indexOf(target)];
    await user().click(within(row).getByRole("button", { name: "끊기" }));
    await waitFor(() => expect(m.preview).toHaveBeenCalledWith(pgTarget, { kind: "terminate", pid: target.pid, role: target.role, backendStart: target.backendStart }));
  });

  test("is off on a read replica with the reason", async () => {
    m.open.mockResolvedValue(sampleOverview({ target: sampleTargetInfo({ readReplica: true }) }));
    setup();
    await connected();
    openMenu("세션");
    await screen.findByRole("table", { name: "세션 목록" });
    for (const button of screen.getAllByRole("button", { name: "끊기" })) expect(button).toBeDisabled();
  });
});
