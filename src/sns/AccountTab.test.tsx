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
const settings = (disabled: string[] = []): Settings => ({ enabledServices: ["sns"], favorites: [], lastProfile: "personal", lastRegion: REGION, snsChecks: { disabled } });
const setup = (open = vi.fn()) => { renderWithClient(<AccountTab profile="personal" region={REGION} onOpenTopic={open} />); return open; };
const nav = (name: string) => fireEvent.click(within(screen.getByRole("navigation", { name: "SNS 계정 메뉴" })).getByRole("button", { name: new RegExp(name) }));
const rows = () => within(screen.getByRole("table", { name: "주제" })).getAllByRole("row").slice(1);
beforeEach(() => { vi.clearAllMocks(); m.accountOverview.mockResolvedValue(sampleOverview()); m.messaging.mockResolvedValue(sampleMessaging()); vi.mocked(api.getSettings).mockResolvedValue(settings()); vi.mocked(api.saveSettings).mockResolvedValue(); });

test("all four FIFO topics are rendered, sortable and clickable", async () => {
  const base = sampleOverview();
  const topics = ["dev-be", "dev-hq", "stg-be", "stg-hq"].map((name, i) => ({ ...base.topics[0], arn: `arn:aws:sns:${REGION}:${ACCOUNT}:${name}.fifo`, name: `${name}.fifo`, fifo: true, failed: i }));
  m.accountOverview.mockResolvedValue(sampleOverview({ topics }));
  const open = setup();
  await screen.findByRole("table", { name: "주제" });
  expect(rows()).toHaveLength(4);
  for (const topic of topics) expect(screen.getByRole("button", { name: topic.name })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /주제.*▲|주제.*▼|^주제$/ }));
  expect(within(rows()[0]).getByRole("button", { name: "dev-be.fifo" })).toBeInTheDocument();
  fireEvent.click(rows()[0]);
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ topicName: "dev-be.fifo" }), undefined);
  expect(screen.getByRole("group", { name: "SNS 계정 개요" })).toHaveTextContent(`${ACCOUNT} · ${REGION}`);
});

test("overview displays metrics, severity and unavailable values", async () => {
  const open = setup();
  await screen.findByRole("table", { name: "주제" });
  expect(screen.getByText(/GetMetricData, 지표 1,000개에 \$0\.01/)).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "지난 24시간 발행" })).toHaveTextContent("1,250");
  expect(screen.getByText(/NumberOfMessagesPublishedPerAccount: 1,250/)).toBeInTheDocument();
  fireEvent.click(within(rows()[0]).getByRole("button", { name: /높음 2/ }));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ topicName: "alerts" }), { view: "policy" });
});

test("partial reads and missing topic attributes remain visible", async () => {
  const base = sampleOverview();
  m.accountOverview.mockResolvedValue(sampleOverview({ metricsAvailable: false, topics: [{ ...base.topics[0], error: { kind: "accessDenied", action: "sns:GetTopicAttributes" } }], errors: [{ kind: "accessDenied", action: "sqs:ListQueues" }] }));
  setup(); await screen.findByRole("table", { name: "주제" });
  expect(screen.getByText("지표를 읽지 못해서 표의 숫자는 비어 있는 값이에요")).toBeInTheDocument();
  expect(within(rows()[0]).getByText(/sns:GetTopicAttributes/)).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("일부 정보를 읽지 못했어요 (1건)");
});

test("cleanup displays orphan reasons and pending topic links", async () => {
  const open = setup(); await screen.findByRole("table", { name: "주제" }); nav("정리할 구독");
  expect(screen.getByRole("table", { name: "고아 구독" })).toHaveTextContent("엔드포인트 없음");
  expect(screen.getByRole("table", { name: "고아 구독" })).toHaveTextContent("주제 없음");
  fireEvent.click(within(screen.getByRole("table", { name: "확인 대기 구독" })).getByRole("button", { name: "alerts" }));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ topicName: "alerts" }), undefined);
});

test("check sheet saves switches and updates grouped findings and navigation counts", async () => {
  const open = setup(); await screen.findByRole("table", { name: "주제" }); nav("점검");
  expect(screen.getByRole("table", { name: "서명 버전 1(SHA1)이에요" })).toHaveTextContent("orders");
  fireEvent.click(within(screen.getByRole("table", { name: "정책이 공개돼 있어요" })).getByRole("button", { name: "alerts" }));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ topicName: "alerts" }), { view: "policy" });
  fireEvent.click(screen.getByRole("button", { name: "점검 항목…" }));
  const box = screen.getByRole("checkbox", { name: "서명 버전 1(SHA1)이에요 점검 켜기" });
  await waitFor(() => expect(box).toBeEnabled()); fireEvent.click(box);
  await waitFor(() => expect(vi.mocked(api.saveSettings)).toHaveBeenCalledWith(expect.objectContaining({ snsChecks: { disabled: ["signatureV1"] } })));
  expect(screen.queryByRole("table", { name: "서명 버전 1(SHA1)이에요" })).not.toBeInTheDocument();
  expect(screen.getByText("점검 항목 1개가 꺼져 있어요")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "닫기" })); nav("개요");
  expect(within(rows()[0]).getByRole("button", { name: /높음 1/ })).toBeInTheDocument();
});

test("SMS and push are a separate view with cards and tables", async () => {
  setup(); await screen.findByRole("table", { name: "주제" }); nav("SMS·푸시");
  expect(await screen.findByText("$0.50")).toBeInTheDocument();
  expect(screen.getByText("98.5%")).toBeInTheDocument();
  expect(screen.getByRole("table", { name: "발신 번호" })).toHaveTextContent("+12065550100");
  expect(screen.getByRole("table", { name: "모바일 푸시" })).toHaveTextContent("1,000+");
});

test("overview errors can be retried", async () => {
  m.accountOverview.mockRejectedValueOnce({ kind: "network", message: "연결하지 못했어요" }).mockResolvedValue(sampleOverview());
  setup(); expect(await screen.findByText(/연결하지 못했어요/)).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "다시 시도" })[0]); await screen.findByRole("table", { name: "주제" });
  expect(m.accountOverview).toHaveBeenCalledTimes(2);
});

test("empty topics and cleanup lists explain their state", async () => {
  m.accountOverview.mockResolvedValue(sampleOverview({ topics: [], orphans: [], pending: [], metrics: [] }));
  setup(); expect(await screen.findByText("이 리전에 SNS 주제가 없어요")).toBeInTheDocument();
  expect(screen.getByText("차원 없는 계정 지표가 없어요")).toBeInTheDocument();
  nav("정리할 구독");
  expect(screen.getByText("고아 구독이 없어요")).toBeInTheDocument();
  expect(screen.getByText("확인 대기 구독이 없어요")).toBeInTheDocument();
});

test("previously disabled checks can be turned back on", async () => {
  vi.mocked(api.getSettings).mockResolvedValue(settings(["signatureV1", "noDlq"]));
  setup(); await screen.findByRole("table", { name: "주제" }); nav("점검");
  fireEvent.click(screen.getByRole("button", { name: "점검 항목…" }));
  const box = screen.getByRole("checkbox", { name: "서명 버전 1(SHA1)이에요 점검 켜기" });
  await waitFor(() => expect(box).not.toBeChecked());
  fireEvent.click(box);
  await waitFor(() => expect(vi.mocked(api.saveSettings)).toHaveBeenCalledWith(expect.objectContaining({ snsChecks: { disabled: ["noDlq"] } })));
  expect(screen.getByRole("table", { name: "서명 버전 1(SHA1)이에요" })).toBeInTheDocument();
});

test("empty messaging and read errors do not hide the topics", async () => {
  m.messaging.mockResolvedValue(sampleMessaging({ sms: { sandbox: false, sandboxNumbers: [], originationNumbers: [], attributes: {}, monthSpentUsd: null, successRate: null }, apps: [] }));
  setup(); await screen.findByRole("table", { name: "주제" }); nav("SMS·푸시");
  expect(await screen.findByText("SMS 샌드박스를 벗어났어요")).toBeInTheDocument();
  expect(screen.getByText("발신 번호가 없어요")).toBeInTheDocument();
  expect(screen.getByText("계정 SMS 속성이 비어 있어요")).toBeInTheDocument();
  expect(screen.getByText("플랫폼 애플리케이션이 없어요")).toBeInTheDocument();
});

test("messaging failures stay within the messaging view", async () => {
  m.messaging.mockRejectedValue({ kind: "network", message: "연결하지 못했어요" });
  setup(); await screen.findByRole("table", { name: "주제" }); nav("SMS·푸시");
  expect(await screen.findByText(/연결하지 못했어요/)).toBeInTheDocument();
  nav("개요"); expect(rows()).toHaveLength(2);
});

test("reread refreshes account and previously loaded messaging", async () => {
  setup(); await screen.findByRole("table", { name: "주제" }); nav("SMS·푸시");
  await screen.findByText("$0.50");
  fireEvent.click(screen.getByRole("button", { name: "다시 읽기" }));
  await waitFor(() => expect(m.accountOverview).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(m.messaging).toHaveBeenCalledTimes(2));
});
