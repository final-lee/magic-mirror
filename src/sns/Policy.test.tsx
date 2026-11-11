import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/client";
import type { Settings } from "../api/types";
import { renderWithClient } from "../test/utils";
import { snsApi } from "./api";
import { samplePolicy, signatureFinding } from "./accessFixtures";
import { TOPIC_ARN, REGION, snsTarget } from "./fixtures";
import { snsKeys } from "./queries";
import { Policy } from "./Policy";

vi.mock("./api", () => ({ snsApi: { topicPolicy: vi.fn(), checkPublicAccess: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { getSettings: vi.fn(), saveSettings: vi.fn(), ssoLogin: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(async () => {}), openUrl: vi.fn() } }));

const m = vi.mocked(snsApi);
const settings = (disabled?: string[]): Settings => ({ enabledServices: ["sns"], favorites: [], lastProfile: "personal", lastRegion: REGION, ...(disabled ? { snsChecks: { disabled } } : {}) });
const section = (name: string) => within(screen.getByRole("region", { name }));
const findings = () => Array.from(screen.getByRole("region", { name: "점검" }).querySelectorAll<HTMLElement>(".fx-items[data-check]"));

function setup(onOpenIam = vi.fn()) {
  renderWithClient(<Policy target={snsTarget} onOpenIam={onOpenIam} />);
  return onOpenIam;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.topicPolicy.mockResolvedValue(samplePolicy());
  vi.mocked(api.getSettings).mockResolvedValue(settings());
});

describe("policy view", () => {
  test("asks for the policy of this topic, lists findings by level and never calls the paid check on its own", async () => {
    setup();
    await screen.findByText("아무나(Principal *) 조건 없이 쓸 수 있는 문장이 있어요");
    expect(m.topicPolicy).toHaveBeenCalledWith("personal", REGION, TOPIC_ARN);
    expect(findings().map((li) => li.getAttribute("data-check"))).toEqual(["publicPolicy", "unencrypted", "signatureV1"]);
    expect(within(findings()[0]).getByText("높음")).toBeInTheDocument();
    expect(within(findings()[1]).getByText("중간")).toBeInTheDocument();
    expect(within(findings()[2]).getByText("낮음")).toBeInTheDocument();
    expect(m.checkPublicAccess).not.toHaveBeenCalled();
  });

  test("a check turned off in settings is hidden and the view says how many", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings(["signatureV1", "unencrypted"]));
    setup();
    await screen.findByText("꺼 둔 점검 2건은 숨겼어요. 계정 개요에서 다시 켤 수 있어요");
    expect(findings().map((li) => li.getAttribute("data-check"))).toEqual(["publicPolicy"]);
    expect(screen.queryByText("서명 버전 1(SHA1)을 쓰고 있어요")).toBeNull();
  });

  test("no findings says so", async () => {
    m.topicPolicy.mockResolvedValue(samplePolicy({ findings: [] }));
    setup();
    expect(await screen.findByText("걸리는 점검이 없어요")).toBeInTheDocument();
  });

  test("statements read as sentences with a reach badge and Deny is marked", async () => {
    setup();
    await screen.findByText("모든 주체(*)가 sns:Subscribe 가능, 조건 없음", { selector: ".sns-statement span:not(.sns-reach)" });
    const items = within(screen.getByRole("list", { name: "정책 문장" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText("공개")).toBeInTheDocument();
    expect(within(items[0]).getByText("open")).toBeInTheDocument();
    expect(within(items[1]).getByText("AWS 서비스")).toBeInTheDocument();
    expect(within(items[2]).getByText("다른 계정")).toBeInTheDocument();
    expect(within(items[2]).getByText("거부")).toBeInTheDocument();
  });

  test("a missing policy and an unreadable policy are told apart", async () => {
    m.topicPolicy.mockResolvedValue(samplePolicy({ statements: [], access: [], policy: null }));
    const { unmount } = renderWithClient(<Policy target={snsTarget} />);
    expect(await screen.findByText("이 주제에는 정책이 없어요")).toBeInTheDocument();
    unmount();
    m.topicPolicy.mockResolvedValue(samplePolicy({ statements: [], access: [], statementsError: "Statement는 객체나 배열이어야 해요" }));
    renderWithClient(<Policy target={snsTarget} />);
    expect(await screen.findByText("정책을 문장으로 풀지 못했어요: Statement는 객체나 배열이어야 해요")).toBeInTheDocument();
  });

  test("Access Analyzer findings, none, and unavailable", async () => {
    const { unmount } = renderWithClient(<Policy target={snsTarget} />);
    expect(await screen.findByText("Principal이 너무 넓어요")).toBeInTheDocument();
    expect(section("정책 검증(Access Analyzer)").getByText("보안 경고")).toBeInTheDocument();
    fireEvent.click(section("정책 검증(Access Analyzer)").getByRole("button", { name: "자세히" }));
    const { desktop } = await import("../api/desktop");
    expect(desktop.openUrl).toHaveBeenCalledWith("https://docs.aws.amazon.com/example");
    unmount();
    m.topicPolicy.mockResolvedValue(samplePolicy({ validation: [] }));
    const second = renderWithClient(<Policy target={snsTarget} />);
    expect(await screen.findByText("지적이 없어요")).toBeInTheDocument();
    second.unmount();
    m.topicPolicy.mockResolvedValue(samplePolicy({ validation: null }));
    renderWithClient(<Policy target={snsTarget} />);
    expect(await screen.findByText(/검사하지 못했어요/)).toBeInTheDocument();
  });
});

describe("paid public access check", () => {
  test("the button states its cost and calls the check once per click", async () => {
    m.checkPublicAccess.mockResolvedValue({ result: "pass", message: null, reasons: [], finding: null });
    setup();
    const button = await screen.findByRole("button", { name: "공개 접근 검사 실행 ($0.002)" });
    expect(button).toHaveAttribute("title", "호출할 때마다 $0.002가 청구돼요");
    expect(button).toHaveClass("tone-refresh");
    expect(m.checkPublicAccess).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(await screen.findByText("통과: 공개 접근이 없어요")).toBeInTheDocument();
    expect(m.checkPublicAccess).toHaveBeenCalledTimes(1);
    expect(m.checkPublicAccess).toHaveBeenCalledWith("personal", REGION, TOPIC_ARN);
  });

  test("정책이 바뀌면 유료 검사 결과와 그 점검을 버리고 다시 검사하지 않아요", async () => {
    m.topicPolicy.mockResolvedValue(samplePolicy({ findings: [signatureFinding] }));
    m.checkPublicAccess.mockResolvedValue({
      result: "fail", message: null, reasons: [],
      finding: { check: "publicPolicy", level: "high", topicArn: TOPIC_ARN, topicName: "orders", summary: "유료 검사 발견", detail: null, items: [] },
    });
    const { qc } = renderWithClient(<Policy target={snsTarget} />);
    fireEvent.click(await screen.findByRole("button", { name: /공개 접근 검사 실행/ }));
    expect(await screen.findByText("유료 검사 발견")).toBeInTheDocument();
    qc.setQueryData(snsKeys.policy("personal", REGION, TOPIC_ARN), samplePolicy({ policy: '{"changed":true}', findings: [signatureFinding] }));
    await waitFor(() => expect(screen.queryByText("유료 검사 발견")).toBeNull());
    expect(screen.queryByText("실패: 공개 접근이 있어요")).toBeNull();
    expect(m.checkPublicAccess).toHaveBeenCalledTimes(1);
  });

  test("a FAIL adds the public-policy finding to a topic that looked fine locally", async () => {
    m.topicPolicy.mockResolvedValue(samplePolicy({ findings: [signatureFinding] }));
    m.checkPublicAccess.mockResolvedValue({
      result: "fail", message: "공개 접근이 가능해요", reasons: ["문장 0이 공개를 허용해요"],
      finding: { check: "publicPolicy", level: "high", topicArn: TOPIC_ARN, topicName: "orders-events.fifo", summary: "Access Analyzer가 공개 접근을 찾았어요", detail: "공개 접근이 가능해요", items: ["문장 0이 공개를 허용해요"] },
    });
    setup();
    await screen.findByText("서명 버전 1(SHA1)을 쓰고 있어요");
    expect(findings()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /공개 접근 검사 실행/ }));
    await waitFor(() => expect(findings()).toHaveLength(2));
    expect(findings()[0]).toHaveAttribute("data-check", "publicPolicy");
    expect(screen.getByText("실패: 공개 접근이 있어요")).toBeInTheDocument();
  });

  test("a failed call is shown and the button can be pressed again", async () => {
    m.checkPublicAccess.mockRejectedValueOnce({ kind: "accessDenied", action: "access-analyzer:CheckNoPublicAccess" }).mockResolvedValue({ result: "pass", message: null, reasons: [], finding: null });
    setup();
    fireEvent.click(await screen.findByRole("button", { name: /공개 접근 검사 실행/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("access-analyzer:CheckNoPublicAccess");
    fireEvent.click(screen.getByRole("button", { name: /공개 접근 검사 실행/ }));
    expect(await screen.findByText("통과: 공개 접근이 없어요")).toBeInTheDocument();
  });
});

describe("who can publish and subscribe", () => {
  test("lists the policy principals with publish and subscribe columns", async () => {
    setup();
    await screen.findByRole("table", { name: "누가 발행·구독할 수 있나" });
    const rows = within(screen.getByRole("table", { name: "누가 발행·구독할 수 있나" })).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("모든 주체(*)");
    expect(within(rows[0]).getAllByRole("cell").map((c) => c.textContent)).toEqual(["공개 모든 주체(*)", "–", "가능", "조건 없음"]);
    expect(within(rows[1]).getAllByRole("cell").map((c) => c.textContent)).toEqual([`AWS 서비스 서비스 events.amazonaws.com`, "가능", "–", expect.stringContaining("aws:SourceAccount")]);
  });

  test("the IAM buttons open 'who can' prefilled with the action and the topic ARN", async () => {
    const onOpenIam = setup();
    const publish = await screen.findByRole("button", { name: "IAM에서 누가 발행할 수 있나 보기" });
    expect(publish).toHaveClass("tone-nav");
    fireEvent.click(publish);
    expect(onOpenIam).toHaveBeenLastCalledWith(null, { view: "whoCan", search: { action: "sns:Publish", resource: TOPIC_ARN } });
    fireEvent.click(screen.getByRole("button", { name: "IAM에서 누가 구독할 수 있나 보기" }));
    expect(onOpenIam).toHaveBeenLastCalledWith(null, { view: "whoCan", search: { action: "sns:Subscribe", resource: TOPIC_ARN } });
  });

  test("no IAM buttons without a handler, and an empty list says so", async () => {
    m.topicPolicy.mockResolvedValue(samplePolicy({ access: [] }));
    renderWithClient(<Policy target={snsTarget} />);
    expect(await screen.findByText("정책에서 발행·구독을 허용한 주체가 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /IAM에서/ })).toBeNull();
  });
});

test("a failed read shows the error with a retry", async () => {
  m.topicPolicy.mockRejectedValueOnce({ kind: "network", message: "연결하지 못했어요" }).mockResolvedValue(samplePolicy());
  setup();
  expect(await screen.findByText(/연결하지 못했어요/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /다시/ }));
  expect(await screen.findByText("아무나(Principal *) 조건 없이 쓸 수 있는 문장이 있어요")).toBeInTheDocument();
});
