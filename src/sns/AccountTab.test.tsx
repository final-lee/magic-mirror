import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/client";
import type { Settings } from "../api/types";
import { renderWithClient } from "../test/utils";
import { snsApi } from "./api";
import { AccountTab } from "./AccountTab";
import { sampleMessaging, sampleOverview } from "./accessFixtures";
import { ACCOUNT, REGION } from "./fixtures";

vi.mock("./api", () => ({ snsApi: { accountOverview: vi.fn(), messaging: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { getSettings: vi.fn(), saveSettings: vi.fn(), ssoLogin: vi.fn() } }));

const m = vi.mocked(snsApi);
const settings = (disabled?: string[]): Settings => ({ enabledServices: ["sns"], favorites: [], lastProfile: "personal", lastRegion: REGION, ...(disabled ? { snsChecks: { disabled } } : {}) });
const section = (name: string) => within(screen.getByRole("region", { name }));
const topicRows = () => within(screen.getByRole("table", { name: "주제" })).getAllByRole("row").slice(1);
const lastSaved = () => { const calls = vi.mocked(api.saveSettings).mock.calls; return calls[calls.length - 1]?.[0]; };
const findings = () => within(screen.getByRole("list", { name: "점검 결과" })).queryAllByRole("listitem").filter((li) => li.matches(".sns-finding"));

function setup(onOpenTopic = vi.fn()) {
  renderWithClient(<AccountTab profile="personal" region={REGION} onOpenTopic={onOpenTopic} />);
  return onOpenTopic;
}
const loaded = () => screen.findByRole("table", { name: "주제" });

beforeEach(() => {
  vi.clearAllMocks();
  m.accountOverview.mockResolvedValue(sampleOverview());
  m.messaging.mockResolvedValue(sampleMessaging());
  vi.mocked(api.getSettings).mockResolvedValue(settings());
  vi.mocked(api.saveSettings).mockResolvedValue();
});

describe("topics table", () => {
  test("reads this profile and region and shows the 24 hour counts in the order the backend sent", async () => {
    setup();
    await loaded();
    expect(m.accountOverview).toHaveBeenCalledWith("personal", REGION);
    expect(screen.getByRole("group", { name: "SNS 계정 개요" })).toHaveTextContent(`${ACCOUNT} · ${REGION}`);
    const [alerts, orders] = topicRows().map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    // 주제, 발행, 배달, 실패, 걸러짐, 구독, 대기, 점검
    expect(alerts).toEqual(["alerts", "1,200", "1,190", "10", "0", "2", "1", "2"]);
    expect(orders).toEqual(["orders", "50", "50", "0", "4", "3", "0", "1"]);
  });

  test("the cost of reading the metrics is stated", async () => {
    setup();
    await loaded();
    expect(screen.getByText(/GetMetricData, 지표 1,000개에 \$0\.01/)).toBeInTheDocument();
  });

  test("a row opens the topic tab; the finding count opens its policy view", async () => {
    const open = setup();
    await loaded();
    fireEvent.click(within(topicRows()[0]).getByRole("button", { name: "alerts" }));
    expect(open).toHaveBeenLastCalledWith({ profile: "personal", region: REGION, topicArn: `arn:aws:sns:${REGION}:${ACCOUNT}:alerts`, topicName: "alerts" }, undefined);
    fireEvent.doubleClick(topicRows()[1]);
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ topicName: "orders" }), undefined);
    const count = within(topicRows()[0]).getAllByRole("button")[1];
    expect(count).toHaveTextContent("2");
    fireEvent.click(count);
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ topicName: "alerts" }), { view: "policy" });
  });

  test("metrics that could not be read leave dashes instead of zeros", async () => {
    m.accountOverview.mockResolvedValue(sampleOverview({ metricsAvailable: false }));
    setup();
    await loaded();
    expect(screen.getByText("지표를 읽지 못해서 표의 숫자는 비어 있는 값이에요")).toBeInTheDocument();
    expect(within(topicRows()[0]).getAllByRole("cell").map((c) => c.textContent).slice(1, 5)).toEqual(["–", "–", "–", "–"]);
  });

  test("a topic whose attributes could not be read is marked", async () => {
    const base = sampleOverview();
    m.accountOverview.mockResolvedValue(sampleOverview({ topics: [{ ...base.topics[0], error: { kind: "accessDenied", action: "sns:GetTopicAttributes" } }] }));
    setup();
    await loaded();
    expect(screen.getByRole("img", { name: "주제 속성을 읽지 못했어요" })).toHaveAttribute("title", expect.stringContaining("sns:GetTopicAttributes"));
  });

  test("no topics and partial errors say so", async () => {
    m.accountOverview.mockResolvedValue(sampleOverview({ topics: [], errors: [{ kind: "accessDenied", action: "sqs:ListQueues" }] }));
    setup();
    expect(await screen.findByText("이 리전에 SNS 주제가 없어요")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("일부 정보를 읽지 못했어요 (1건)");
  });
});

describe("orphan and pending subscriptions", () => {
  test("orphans carry the reason; pending ones link to their topic", async () => {
    const open = setup();
    await loaded();
    const orphans = within(screen.getByRole("list", { name: "고아 구독" })).getAllByRole("listitem");
    expect(orphans).toHaveLength(2);
    expect(orphans[0]).toHaveTextContent("엔드포인트 없음");
    expect(orphans[0]).toHaveTextContent("gone-queue");
    expect(orphans[1]).toHaveTextContent("주제 없음");
    const pending = within(screen.getByRole("list", { name: "확인 대기 구독" })).getAllByRole("listitem");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toHaveTextContent("ops@example.com");
    fireEvent.click(within(pending[0]).getByRole("button", { name: "alerts" }));
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ topicName: "alerts" }), undefined);
  });

  test("empty lists say so", async () => {
    m.accountOverview.mockResolvedValue(sampleOverview({ orphans: [], pending: [] }));
    setup();
    expect(await screen.findByText("고아 구독이 없어요")).toBeInTheDocument();
    expect(screen.getByText("확인 대기 구독이 없어요")).toBeInTheDocument();
  });
});

describe("check toggles", () => {
  test("every check has a switch, on by default, with its count", async () => {
    setup();
    await loaded();
    const publicPolicy = await screen.findByRole("checkbox", { name: "정책이 공개돼 있어요 점검 켜기" });
    await waitFor(() => expect(publicPolicy).toBeEnabled());
    expect(publicPolicy).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "서명 버전 1(SHA1)이에요 점검 켜기" })).toBeChecked();
    expect(findings()).toHaveLength(3);
  });

  test("turning one off saves it to settings and drops its findings from the list and the counts", async () => {
    setup();
    await loaded();
    const box = screen.getByRole("checkbox", { name: "서명 버전 1(SHA1)이에요 점검 켜기" });
    await waitFor(() => expect(box).toBeEnabled());
    fireEvent.click(box);
    await waitFor(() => expect(lastSaved()?.snsChecks).toEqual({ disabled: ["signatureV1"] }));
    expect(box).not.toBeChecked();
    expect(findings().map((li) => li.getAttribute("data-check"))).toEqual(["publicPolicy"]);
    // 주제 표의 점검 수에서도 빠진다
    expect(within(topicRows()[0]).getAllByRole("button")[1]).toHaveTextContent("1");
    expect(within(topicRows()[1]).queryAllByRole("button")).toHaveLength(1);
    const cells = within(topicRows()[1]).getAllByRole("cell");
    expect(cells[cells.length - 1]).toHaveTextContent("0");
  });

  test("a check already off in settings starts unchecked and turning it on removes it from the list", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(settings(["signatureV1", "noDlq"]));
    setup();
    await loaded();
    const box = screen.getByRole("checkbox", { name: "서명 버전 1(SHA1)이에요 점검 켜기" });
    await waitFor(() => expect(box).not.toBeChecked());
    expect(findings()).toHaveLength(1);
    fireEvent.click(box);
    await waitFor(() => expect(lastSaved()?.snsChecks).toEqual({ disabled: ["noDlq"] }));
    expect(findings()).toHaveLength(3);
  });

  test("a finding links to the policy view of its topic", async () => {
    const open = setup();
    await loaded();
    fireEvent.click(within(findings()[0]).getByRole("button", { name: "alerts" }));
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ topicName: "alerts" }), { view: "policy" });
  });
});

describe("account metrics", () => {
  test("lists the dimensionless metrics, or says there are none", async () => {
    const { unmount } = renderWithClient(<AccountTab profile="personal" region={REGION} onOpenTopic={vi.fn()} />);
    await screen.findByText("NumberOfMessagesPublishedPerAccount");
    expect(section("계정 지표(지난 24시간)").getByText("1,250")).toBeInTheDocument();
    unmount();
    m.accountOverview.mockResolvedValue(sampleOverview({ metrics: [] }));
    renderWithClient(<AccountTab profile="personal" region={REGION} onOpenTopic={vi.fn()} />);
    expect(await screen.findByText("차원 없는 계정 지표가 없어요")).toBeInTheDocument();
  });
});

describe("SMS and mobile push", () => {
  test("shows the sandbox state, masked numbers, spend, sender numbers and attributes", async () => {
    setup();
    await loaded();
    const sms = await screen.findByRole("region", { name: "SMS" });
    expect(m.messaging).toHaveBeenCalledWith("personal", REGION);
    expect(within(sms).getByText("SMS 샌드박스 안에 있어요: 확인한 번호로만 보낼 수 있어요")).toBeInTheDocument();
    expect(within(sms).getByText("$0.50")).toBeInTheDocument();
    expect(within(sms).getByText("98.5%")).toBeInTheDocument();
    expect(within(sms).getByText("+82******1234")).toBeInTheDocument();
    expect(within(sms).getByText("+12065550100")).toBeInTheDocument();
    expect(within(sms).getByText("Transactional", { selector: "td" })).toBeInTheDocument();
  });

  test("push apps show endpoint counts, a capped count with +, disabled counts and the certificate expiry", async () => {
    setup();
    const push = await screen.findByRole("table", { name: "모바일 푸시" });
    const [ios, android] = within(push).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    expect(ios).toEqual(["ios", "APNS", "켜짐", "12", "3", expect.stringContaining("2027")]);
    expect(android).toEqual(["android", "GCM", "꺼짐", "1,000+", "7", "–"]);
  });

  test("outside the sandbox, with nothing configured, it says so", async () => {
    m.messaging.mockResolvedValue(sampleMessaging({ sms: { sandbox: false, sandboxNumbers: [], originationNumbers: [], attributes: {}, monthSpentUsd: null, successRate: null }, apps: [] }));
    setup();
    expect(await screen.findByText("SMS 샌드박스를 벗어났어요")).toBeInTheDocument();
    expect(screen.getByText("발신 번호가 없어요")).toBeInTheDocument();
    expect(screen.getByText("계정 SMS 속성이 비어 있어요")).toBeInTheDocument();
    expect(screen.getByText("플랫폼 애플리케이션이 없어요")).toBeInTheDocument();
    expect(screen.queryByText("샌드박스 번호")).toBeNull();
  });

  test("a failed messaging read does not hide the topics", async () => {
    m.messaging.mockRejectedValue({ kind: "network", message: "연결하지 못했어요" });
    setup();
    await loaded();
    expect(await screen.findByText(/연결하지 못했어요/)).toBeInTheDocument();
    expect(topicRows()).toHaveLength(2);
  });
});

describe("loading and errors", () => {
  test("a failed overview shows the error and the reread button reads it again", async () => {
    m.accountOverview.mockRejectedValueOnce({ kind: "network", message: "연결하지 못했어요" }).mockResolvedValue(sampleOverview());
    setup();
    expect(await screen.findByText(/연결하지 못했어요/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "다시 시도" })[0]);
    await loaded();
    expect(m.accountOverview).toHaveBeenCalledTimes(2);
  });

  test("[다시 읽기] reads the overview and messaging again", async () => {
    setup();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(m.accountOverview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(m.messaging).toHaveBeenCalledTimes(2));
  });
});
