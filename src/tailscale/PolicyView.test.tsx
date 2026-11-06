import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { desktop } from "../api/desktop";
import { editorView, typeYaml } from "../test/codemirror";
import { renderWithClient } from "../test/utils";
import { tailscaleApi } from "./api";
import { PolicyView } from "./PolicyView";
import type { PolicyValidation, TsPolicy } from "./policyTypes";
import { TailscaleTabsProvider } from "./TabContext";
import { useTailscaleApi } from "./useTailscaleApi";

vi.mock("./api", () => ({ tailscaleApi: { policy: vi.fn(), policyPreview: vi.fn(), policyValidate: vi.fn(), policySave: vi.fn() } }));
vi.mock("./useTailscaleApi", () => ({ useTailscaleApi: vi.fn() }));
vi.mock("../api/desktop", () => ({ desktop: { openUrl: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

const api = vi.mocked(tailscaleApi);
const TEXT = '// 정책\n{\n  "acls": [\n    {"action": "accept", "src": ["*"], "dst": ["*:*"]},\n  ],\n}\n';
const EDITED = TEXT.replace('"src": ["*"]', '"src": ["group:ops"]');
const policy: TsPolicy = {
  text: TEXT,
  etag: '"e1"',
  externallyManaged: false,
  externalLink: null,
  findings: [
    { severity: "high", title: "모든 출발지가 모든 목적지로 열려 있어요", detail: "acls[0] 규칙이 열려 있어요", path: "acls[0]" },
    { severity: "medium", title: "정책 시험이 없어요", detail: "tests가 있으면 좋아요", path: "tests" },
  ],
};
const passed: PolicyValidation = { ok: true, message: null, issues: [] };
const CHANGED = "다른 곳에서 정책이 바뀌었어요. 다시 불러와 주세요";

const edit = (text: string) => typeYaml(text, "정책 HuJSON");
const button = (name: string) => screen.getByRole("button", { name });

async function open(over: Partial<TsPolicy> = {}) {
  api.policy.mockResolvedValue({ ...policy, ...over });
  renderWithClient(<PolicyView />);
  await screen.findByRole("region", { name: "정책 편집" });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useTailscaleApi).mockReturnValue({ tailnet: "example.com", connected: true, isLoading: false });
  api.policyValidate.mockResolvedValue(passed);
  api.policySave.mockResolvedValue({ etag: '"e2"', recordError: null });
});

test("연결하지 않았으면 API를 부르지 않고 연결 탭으로 안내해요", () => {
  vi.mocked(useTailscaleApi).mockReturnValue({ tailnet: null, connected: false, isLoading: false });
  const select = vi.fn();
  renderWithClient(
    <TailscaleTabsProvider value={{ select, deviceView: "table", setDeviceView: vi.fn() }}>
      <PolicyView />
    </TailscaleTabsProvider>,
  );
  fireEvent.click(button("연결 탭 열기"));
  expect(select).toHaveBeenCalledWith("connect");
  expect(api.policy).not.toHaveBeenCalled();
});

test("주석이 든 정책 원문을 편집기에 그대로 채우고 지적을 위험한 순서로 보여요", async () => {
  await open();
  expect(editorView("정책 HuJSON").state.doc.toString()).toBe(TEXT);
  expect(api.policy).toHaveBeenCalledWith("example.com");
  const items = within(screen.getByRole("region", { name: "지적" })).getAllByRole("listitem");
  expect(items.map((li) => li.getAttribute("data-severity"))).toEqual(["high", "medium"]);
  expect(items[0]).toHaveTextContent("acls[0]");
});

test("바꾼 것이 없으면 미리보기가 꺼져 있고, 바꾸면 켜져요", async () => {
  await open();
  expect(button("미리보기…")).toBeDisabled();
  expect(screen.getByText("바꾼 내용이 없어요")).toBeInTheDocument();
  edit(EDITED);
  expect(button("미리보기…")).toBeEnabled();
});

test("[검사]는 편집 중인 글로 부르고 결과를 보이며, 글을 고치면 옛 결과를 감춰요", async () => {
  api.policyValidate.mockResolvedValue({
    ok: false,
    message: "test(s) failed",
    issues: [{ subject: "alice@example.com", errors: ['address "tag:prod:22": want: Drop, got: Accept'], warnings: [] }],
  });
  await open();
  edit(EDITED);
  fireEvent.click(button("검사"));
  expect(await screen.findByText("검사에서 문제가 발견됐어요")).toBeInTheDocument();
  expect(screen.getByText('address "tag:prod:22": want: Drop, got: Accept')).toBeInTheDocument();
  expect(api.policyValidate).toHaveBeenCalledWith("example.com", EDITED);
  edit(EDITED + " ");
  expect(screen.queryByText("검사에서 문제가 발견됐어요")).not.toBeInTheDocument();
});

test("검사가 문법 오류로 거절되면 그 메시지를 보여요", async () => {
  api.policyValidate.mockRejectedValue({ kind: "other", message: "line 3: unexpected token" });
  await open();
  fireEvent.click(button("검사"));
  expect(await screen.findByRole("alert")).toHaveTextContent("검사하지 못했어요: line 3: unexpected token");
});

test("경고만 있는 검사는 통과로 보이되 경고를 알려요", async () => {
  api.policyValidate.mockResolvedValue({ ok: true, message: "warning(s) found", issues: [{ subject: "group:x", errors: [], warnings: ["group is not syncing"] }] });
  await open();
  fireEvent.click(button("검사"));
  expect(await screen.findByText("경고가 있어요(저장은 할 수 있어요)")).toBeInTheDocument();
  expect(screen.getByText("group is not syncing")).toBeInTheDocument();
});

describe("저장 흐름", () => {
  async function review() {
    await open();
    edit(EDITED);
    fireEvent.click(button("미리보기…"));
    return await screen.findByRole("dialog", { name: "정책 저장 미리보기" });
  }

  test("미리보기는 호출·If-Match·줄 차이를 보이고, 테일넷 이름을 쳐야 저장돼요", async () => {
    const dialog = await review();
    expect(within(dialog).getByText("POST /tailnet/-/acl")).toBeInTheDocument();
    expect(within(dialog).getByText('"e1"')).toBeInTheDocument();
    expect(within(dialog).getByText("policy_file")).toBeInTheDocument();
    const diff = within(dialog).getByLabelText("바뀌는 내용");
    expect(diff).toHaveTextContent('− {"action": "accept", "src": ["*"], "dst": ["*:*"]},');
    expect(diff).toHaveTextContent('+ {"action": "accept", "src": ["group:ops"], "dst": ["*:*"]},');
    expect(within(dialog).getByText("+1 −1")).toBeInTheDocument();

    expect(within(dialog).getByRole("button", { name: "저장" })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "example.com" } });
    expect(api.policySave).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(api.policySave).toHaveBeenCalledWith("example.com", TEXT, EDITED, '"e1"'));
  });

  test("저장하면 창을 닫고 다시 불러와 새 정책을 채워요", async () => {
    const dialog = await review();
    api.policy.mockResolvedValue({ ...policy, text: EDITED, etag: '"e2"', findings: [] });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    expect(await screen.findByText(/정책을 저장했어요/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(editorView("정책 HuJSON").state.doc.toString()).toBe(EDITED));
    expect(api.policy).toHaveBeenCalledTimes(2);
    expect(button("미리보기…")).toBeDisabled();
  });

  test("변경 기록을 남기지 못했으면 저장 뒤에 그 안내를 보여요", async () => {
    api.policySave.mockResolvedValue({ etag: '"e2"', recordError: "정책은 저장했지만 변경 기록을 남기지 못했어요 (denied)" });
    const dialog = await review();
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    expect(await screen.findByText(/변경 기록을 남기지 못했어요/)).toBeInTheDocument();
  });

  test("다른 곳에서 정책이 바뀌었으면(412) 그 문구와 다시 불러오기를 보이고 다시 저장할 수 없어요", async () => {
    api.policySave.mockRejectedValue({ kind: "other", message: CHANGED });
    const dialog = await review();
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    expect(await within(dialog).findByText(CHANGED)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "저장" })).toBeDisabled();

    api.policy.mockResolvedValue({ ...policy, text: "{ }", etag: '"e9"', findings: [] });
    fireEvent.click(within(dialog).getByRole("button", { name: "편집을 버리고 다시 불러오기" }));
    await waitFor(() => expect(editorView("정책 HuJSON").state.doc.toString()).toBe("{ }"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("테스트가 실패해 거절되면 API 메시지를 보이되 다시 불러오기는 권하지 않아요", async () => {
    api.policySave.mockRejectedValue({ kind: "other", message: "acl tests failed" });
    const dialog = await review();
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    expect(await within(dialog).findByText("acl tests failed")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "편집을 버리고 다시 불러오기" })).not.toBeInTheDocument();
  });

  test("버전(ETag)을 받지 못했으면 저장할 수 없어요", async () => {
    await open({ etag: null });
    edit(EDITED);
    fireEvent.click(button("미리보기…"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "example.com" } });
    expect(within(dialog).getByRole("button", { name: "저장" })).toBeDisabled();
  });

  test("취소하면 저장 없이 닫혀요", async () => {
    const dialog = await review();
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.policySave).not.toHaveBeenCalled();
  });
});

describe("누가 무엇에 닿나", () => {
  test("편집 중인 정책으로 이메일에 맞는 규칙을 찾고 그 줄을 보여요", async () => {
    api.policyPreview.mockResolvedValue([{ users: ["group:ops"], ports: ["tag:prod:22"], lineNumber: 4 }]);
    await open();
    edit(EDITED);
    fireEvent.change(screen.getByLabelText("찾을 이메일 또는 IP:포트"), { target: { value: "alice@example.com" } });
    expect(screen.getByText("편집 중인 정책으로 계산해요")).toBeInTheDocument();
    fireEvent.click(button("보기"));
    expect(await screen.findByText("alice@example.com에 맞는 규칙 1개")).toBeInTheDocument();
    expect(api.policyPreview).toHaveBeenCalledWith("example.com", "user", "alice@example.com", EDITED);
    const row = screen.getByRole("row", { name: /group:ops/ });
    expect(row).toHaveTextContent("tag:prod:22");
    expect(row).toHaveTextContent('{"action": "accept", "src": ["group:ops"], "dst": ["*:*"]},');
  });

  test("IP:포트를 고르면 ipport로 묻고, 맞는 규칙이 없으면 막힌다고 말해요", async () => {
    api.policyPreview.mockResolvedValue([]);
    await open();
    fireEvent.change(screen.getByLabelText("찾는 대상 종류"), { target: { value: "ipport" } });
    fireEvent.change(screen.getByLabelText("찾을 이메일 또는 IP:포트"), { target: { value: "100.64.0.7:22" } });
    fireEvent.click(button("보기"));
    expect(await screen.findByText("맞는 규칙이 없어요. 규칙이 없으면 접속이 막혀요")).toBeInTheDocument();
    expect(api.policyPreview).toHaveBeenCalledWith("example.com", "ipport", "100.64.0.7:22", TEXT);
    expect(screen.getByText("저장된 정책으로 계산해요")).toBeInTheDocument();
  });

  test("대상이 비었으면 부르지 않고, 실패하면 그 이유를 보여요", async () => {
    api.policyPreview.mockRejectedValue({ kind: "other", message: "user not found" });
    await open();
    expect(button("보기")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("찾을 이메일 또는 IP:포트"), { target: { value: "nobody@example.com" } });
    fireEvent.click(button("보기"));
    expect(await screen.findByRole("alert")).toHaveTextContent("user not found");
  });
});

describe("다른 곳에서 관리하는 정책", () => {
  const managed = { externallyManaged: true, externalLink: "https://github.com/acme/tailnet-policy" };

  test("읽기 전용이라 편집기·검사·저장이 없고 외부 링크를 열어요", async () => {
    api.policy.mockResolvedValue({ ...policy, ...managed });
    renderWithClient(<PolicyView />);
    expect(await screen.findByText(/다른 곳에서 관리해요/)).toBeInTheDocument();
    expect(screen.getByLabelText("정책 HuJSON")).toHaveTextContent("// 정책");
    // 구문 색은 입히되 고칠 수는 없다
    expect(screen.getByLabelText("정책 HuJSON")).toHaveAttribute("aria-readonly", "true");
    expect(screen.getByLabelText("정책 HuJSON")).toHaveAttribute("contenteditable", "false");
    for (const name of ["검사", "미리보기…", "저장"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    fireEvent.click(button("관리하는 곳 열기"));
    expect(desktop.openUrl).toHaveBeenCalledWith("https://github.com/acme/tailnet-policy");
  });

  test("읽기 전용이어도 누가 무엇에 닿나는 저장된 정책으로 볼 수 있어요", async () => {
    api.policy.mockResolvedValue({ ...policy, ...managed });
    api.policyPreview.mockResolvedValue([]);
    renderWithClient(<PolicyView />);
    fireEvent.change(await screen.findByLabelText("찾을 이메일 또는 IP:포트"), { target: { value: "a@b.c" } });
    fireEvent.click(button("보기"));
    await waitFor(() => expect(api.policyPreview).toHaveBeenCalledWith("example.com", "user", "a@b.c", TEXT));
  });
});

test("정책을 읽지 못하면 이유와 다시 불러오기를 보여요", async () => {
  api.policy.mockRejectedValueOnce({ kind: "other", message: "이 자격 증명에 all:read 권한이 없어요" });
  renderWithClient(<PolicyView />);
  expect(await screen.findByRole("alert")).toHaveTextContent("all:read 권한이 없어요");
  api.policy.mockResolvedValue(policy);
  fireEvent.click(button("다시 불러오기"));
  expect(await screen.findByRole("region", { name: "정책 편집" })).toBeInTheDocument();
});
