import { act, fireEvent, screen, within } from "@testing-library/react";
import { desktop } from "../api/desktop";
import { renderWithClient } from "../test/utils";
import { iamApi } from "./api";
import { alice, appRole, BADGES, deployPolicy, deployPolicyView, devTeam, inlineId, scratchInline, scratchInlineView } from "./fixtures";
import { PolicyDetail } from "./PolicyDetail";

vi.mock("./api", () => ({ iamApi: { policy: vi.fn(), validatePolicy: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));

const m = vi.mocked(iamApi);

function setup(policyId = deployPolicy.id, extra: Partial<React.ComponentProps<typeof PolicyDetail>> = {}) {
  const props = { onOpen: vi.fn(), onViewState: vi.fn(), onFix: vi.fn() };
  renderWithClient(<PolicyDetail profile="prod" policyId={policyId} {...props} {...extra} />);
  return props;
}
const tab = (name: RegExp | string) => screen.findByRole("tab", { name });
const prettyJson = () => JSON.stringify(JSON.parse(deployPolicyView().document), null, 2);

beforeEach(() => {
  vi.clearAllMocks();
  m.policy.mockResolvedValue(deployPolicyView());
});

describe("header", () => {
  test("shows the name, scope, ARN and badges", async () => {
    m.policy.mockResolvedValue(deployPolicyView({ badges: [BADGES.unattached] }));
    setup();
    expect(await screen.findByRole("heading", { name: "app-deploy" })).toBeInTheDocument();
    expect(m.policy).toHaveBeenCalledWith("prod", deployPolicy.id);
    expect(screen.getByText("고객 관리형")).toBeInTheDocument();
    expect(screen.getByText(deployPolicy.arn)).toBeInTheDocument();
    expect(screen.getByText("안 붙음")).toBeInTheDocument();
  });

  test("copies the ARN", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "ARN 복사" }));
    expect(desktop.copy).toHaveBeenCalledWith(deployPolicy.arn);
  });

  test("an inline policy has no ARN and says it is inline", async () => {
    const id = inlineId(alice.arn, "s3-scratch");
    m.policy.mockResolvedValue(deployPolicyView({ id, name: "s3-scratch", scope: "inline", arn: null }));
    setup(id);
    expect(await screen.findByRole("heading", { name: "s3-scratch" })).toBeInTheDocument();
    expect(screen.getByText("인라인")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ARN 복사" })).not.toBeInTheDocument();
  });

  test("AWS managed policies are labelled as such", async () => {
    m.policy.mockResolvedValue(deployPolicyView({ scope: "aws" }));
    setup();
    expect(await screen.findByText("AWS 관리형")).toBeInTheDocument();
  });

  test("shows a loading message, then an error", async () => {
    m.policy.mockRejectedValue({ kind: "other", message: "정책을 찾을 수 없어요" });
    setup();
    expect(screen.getByText("불러오는 중…")).toBeInTheDocument();
    expect(await screen.findByText("정책을 찾을 수 없어요")).toBeInTheDocument();
  });
});

describe("tabs", () => {
  test("statements, JSON, versions and attachments with counts", async () => {
    setup();
    await screen.findByRole("heading", { name: "app-deploy" });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["문장 2", "JSON", "버전 2", "붙어 있는 대상 2"]);
    expect(screen.getByRole("tab", { name: /^문장/ })).toHaveAttribute("aria-selected", "true");
  });

  test("switching reports the view state; the initial tab is restored", async () => {
    const props = setup();
    fireEvent.click(await tab("JSON"));
    expect(props.onViewState).toHaveBeenLastCalledWith({ tab: "json" });
  });

  test("restores the initial tab", async () => {
    setup(deployPolicy.id, { initialTab: "json" });
    expect(await screen.findByTestId("policy-json")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "JSON" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("statements", () => {
  const rows = () => within(screen.getByRole("table", { name: "정책 문장" })).getAllByRole("row").slice(1);

  test("explains each statement: effect, services with levels and counts, resources, conditions", async () => {
    setup();
    await screen.findByRole("heading", { name: "app-deploy" });
    const allow = within(rows()[0]);
    expect(allow.getByText("Allow")).toHaveClass("allow");
    expect(allow.getByText("Deploy")).toBeInTheDocument();
    expect(allow.getByText("Amazon S3")).toBeInTheDocument();
    expect(allow.getByText("읽기 · 쓰기")).toBeInTheDocument();
    expect(allow.getByText("2개")).toBeInTheDocument();
    expect(allow.getByText("s3:PutObject")).toBeInTheDocument();
    expect(allow.getByText("arn:aws:s3:::assets/*")).toBeInTheDocument();
    expect(allow.getByText("조건 없음")).toBeInTheDocument();
    expect(allow.queryByText("NotAction")).not.toBeInTheDocument();
  });

  test("marks Deny, NotAction and shows conditions", async () => {
    setup();
    await screen.findByRole("heading", { name: "app-deploy" });
    const deny = within(rows()[1]);
    expect(deny.getByText("Deny")).toHaveClass("deny");
    expect(deny.getByText("NotAction")).toBeInTheDocument();
    expect(deny.getByText("목록 · 읽기 · 쓰기 · 권한 관리 · 태그")).toBeInTheDocument();
    expect(deny.getByText("124개")).toBeInTheDocument();
    expect(deny.getByText("aws:SecureTransport · Bool · false")).toBeInTheDocument();
  });

  test("marks NotResource", async () => {
    const view = deployPolicyView();
    view.statements[0] = { ...view.statements[0], notResource: true, resources: ["arn:aws:s3:::secret/*"] };
    m.policy.mockResolvedValue(view);
    setup();
    await screen.findByRole("heading", { name: "app-deploy" });
    expect(within(rows()[0]).getByText("NotResource")).toBeInTheDocument();
  });

  test("a policy without statements says so", async () => {
    m.policy.mockResolvedValue(deployPolicyView({ statements: [] }));
    setup();
    expect(await screen.findByText("문장이 없어요")).toBeInTheDocument();
  });
});

describe("JSON", () => {
  test("shows the document pretty-printed and copies it", async () => {
    setup();
    fireEvent.click(await tab("JSON"));
    expect(screen.getByTestId("policy-json").textContent).toBe(prettyJson());
    fireEvent.click(screen.getByRole("button", { name: "JSON 복사" }));
    expect(desktop.copy).toHaveBeenCalledWith(prettyJson());
  });

  test("falls back to the raw text when the document is not valid JSON", async () => {
    m.policy.mockResolvedValue(deployPolicyView({ document: "{not json" }));
    setup();
    fireEvent.click(await tab("JSON"));
    expect(screen.getByTestId("policy-json").textContent).toBe("{not json");
  });
});

describe("versions", () => {
  test("lists versions with the default one marked", async () => {
    setup();
    fireEvent.click(await tab(/^버전/));
    const rows = within(screen.getByRole("table", { name: "정책 버전" })).getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("v2")).toBeInTheDocument();
    expect(within(rows[0]).getByText("기본")).toBeInTheDocument();
    expect(within(rows[0]).getByText("2026-08-01")).toBeInTheDocument();
    expect(within(rows[1]).getByText("v1")).toBeInTheDocument();
    expect(within(rows[1]).queryByText("기본")).not.toBeInTheDocument();
  });

  test("inline policies have no versions", async () => {
    m.policy.mockResolvedValue(deployPolicyView({ versions: [] }));
    setup();
    fireEvent.click(await tab(/^버전/));
    expect(screen.getByText("버전 정보가 없어요")).toBeInTheDocument();
  });
});

describe("attached principals", () => {
  test("lists the principals and opens them", async () => {
    const props = setup();
    fireEvent.click(await tab(/^붙어 있는 대상/));
    const list = screen.getByRole("list", { name: "붙어 있는 대상" });
    const items = within(list).getAllByRole("listitem");
    expect(within(items[0]).getByText("그룹")).toBeInTheDocument();
    expect(within(items[1]).getByText("역할")).toBeInTheDocument();
    fireEvent.click(within(items[0]).getByRole("button", { name: "dev-team" }));
    expect(props.onOpen).toHaveBeenCalledWith({ view: "groups", id: devTeam.arn });
    fireEvent.click(within(items[1]).getByRole("button", { name: "app-role" }));
    expect(props.onOpen).toHaveBeenLastCalledWith({ view: "roles", id: appRole.arn });
  });

  test("an unattached policy says so", async () => {
    m.policy.mockResolvedValue(deployPolicyView({ attachedTo: [] }));
    setup();
    fireEvent.click(await tab(/^붙어 있는 대상/));
    expect(screen.getByText("붙어 있는 곳이 없어요")).toBeInTheDocument();
  });
});

describe("editing", () => {
  const editor = () => screen.findByRole("textbox", { name: "정책 JSON" }) as Promise<HTMLTextAreaElement>;
  const editButton = () => screen.findByRole("button", { name: "편집" });

  test("a customer managed policy can be edited: the editor starts from the current document", async () => {
    setup();
    fireEvent.click(await editButton());
    const box = await editor();
    expect(screen.getByRole("heading", { name: "정책 편집 · app-deploy" })).toBeInTheDocument();
    expect(box.value).toBe(prettyJson());
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "미리보기" })).toBeDisabled(); // 바꾼 게 없다
  });

  test("the preview hands updateManagedPolicy to the change flow; the editor closes once it is applied", async () => {
    const props = setup();
    fireEvent.click(await editButton());
    const box = await editor();
    const changed = box.value.replace("s3:GetObject", "s3:GetObjectVersion");
    fireEvent.change(box, { target: { value: changed } });
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    expect(props.onFix).toHaveBeenCalledTimes(1);
    expect(props.onFix).toHaveBeenCalledWith({ op: "updateManagedPolicy", policyArn: deployPolicy.arn, document: changed }, { onApplied: expect.any(Function) });
    expect(screen.getByRole("textbox", { name: "정책 JSON" })).toBeInTheDocument(); // 미리보기를 취소하면 편집기는 그대로
    act(() => props.onFix.mock.calls[0][1].onApplied());
    expect(screen.queryByRole("textbox", { name: "정책 JSON" })).not.toBeInTheDocument();
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });

  test("취소 goes back to the tabs without changing anything", async () => {
    const props = setup();
    fireEvent.click(await editButton());
    await editor();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.getByRole("tab", { name: /^문장/ })).toBeInTheDocument();
    expect(props.onFix).not.toHaveBeenCalled();
  });

  test("an inline policy is saved back with putInlinePolicy to the principal that owns it", async () => {
    m.policy.mockResolvedValue(scratchInlineView());
    const props = setup(scratchInline.id);
    fireEvent.click(await editButton());
    const box = await editor();
    expect(screen.getByRole("heading", { name: "인라인 정책 편집 · s3-scratch" })).toBeInTheDocument();
    const changed = box.value.replace("s3:PutObject", "s3:PutObjectAcl");
    fireEvent.change(box, { target: { value: changed } });
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    expect(props.onFix).toHaveBeenCalledWith({ op: "putInlinePolicy", target: alice.arn, name: "s3-scratch", document: changed }, { onApplied: expect.any(Function) });
  });

  test("no edit button when the backend says the policy is not editable (AWS managed, protected owner)", async () => {
    m.policy.mockResolvedValue(deployPolicyView({ scope: "aws", editable: false }));
    setup();
    await screen.findByRole("heading", { name: "app-deploy" });
    expect(screen.queryByRole("button", { name: "편집" })).not.toBeInTheDocument();
  });

  test("no edit button for an AWS managed policy even if it were flagged editable", async () => {
    m.policy.mockResolvedValue(deployPolicyView({ scope: "aws", editable: true }));
    setup();
    await screen.findByRole("heading", { name: "app-deploy" });
    expect(screen.queryByRole("button", { name: "편집" })).not.toBeInTheDocument();
  });

  test("no edit button for an inline policy whose owner cannot be told from its id", async () => {
    m.policy.mockResolvedValue(deployPolicyView({ id: "inline-without-owner", scope: "inline", arn: null, editable: true }));
    setup("inline-without-owner");
    await screen.findByRole("heading", { name: "app-deploy" });
    expect(screen.queryByRole("button", { name: "편집" })).not.toBeInTheDocument();
  });
});
