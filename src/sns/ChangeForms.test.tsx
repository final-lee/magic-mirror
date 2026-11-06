import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/client";
import { makeResource, renderWithClient } from "../test/utils";
import { typeYaml } from "../test/codemirror";
import { snsApi } from "./api";
import { undoBlockReason } from "./ChangeLog";
import * as ct from "./changeText";
import { ACCOUNT, QUEUE_ARN, REGION, TOPIC_ARN, lambdaSubscription, pendingSubscription, sampleTopic, snsTarget, sqsSubscription } from "./fixtures";
import { recent } from "./samples";
import { PublishForm } from "./PublishForm";
import { SubscribeForm } from "./SubscribeForm";
import { LoggingForm } from "./LoggingForm";
import { FilterEdit, RawToggle, UnsubscribeButton } from "./SubscriptionEdits";
import { SubscriptionDetail } from "./SubscriptionDetail";
import { changeTone } from "./change";
import { Subscriptions } from "./Subscriptions";
import { TopicPolicyEdit } from "./TopicPolicyEdit";
import { snsTabId } from "./targets";
import type { SnsApplyResult, SnsChangeRecord, SnsChangeRequest, SnsPlan, SnsTopicPolicy } from "./types";

vi.mock("./api", () => ({ snsApi: { plan: vi.fn(), apply: vi.fn(), undoPlan: vi.fn(), filterTest: vi.fn(), validatePolicy: vi.fn(), checkPolicyDocument: vi.fn(), loggingRoles: vi.fn(), diagnose: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { listResources: vi.fn(), ssoLogin: vi.fn(), getSettings: vi.fn() } }));
const m = vi.mocked(snsApi);

const queue = (name: string) => makeResource(`https://sqs/${name}`, { name }, { arn: `arn:aws:sqs:${REGION}:${ACCOUNT}:${name}` });
const plan = (request: SnsChangeRequest, over: Partial<SnsPlan> = {}): SnsPlan => ({ request, topicArn: TOPIC_ARN, calls: [{ api: "sns:Subscribe", target: TOPIC_ARN, body: {} }], fields: [], impact: [], warnings: [], confirm: null, fingerprint: "f", undoOf: null, ...over });
const applied: SnsApplyResult = { callsRun: [], outputs: [{ messageId: "m-1" }], error: null, recordId: "r1" };
const standard = sampleTopic({ fifo: false, name: "orders", arn: TOPIC_ARN, overview: { ...sampleTopic().overview, fifo: false, contentBasedDeduplication: false } });

beforeEach(() => {
  vi.clearAllMocks();
  recent.clear();
  m.plan.mockImplementation(async (_p, _r, request) => plan(request));
  m.apply.mockResolvedValue(applied);
  m.diagnose.mockResolvedValue({ topicChecks: [], subscriptions: [], failures: [], metrics: { failed: null, filteredInvalidAttributes: null, filteredInvalidBody: null, redrivenToDlq: null, delivered: null, published: null } });
  vi.mocked(api.listResources).mockResolvedValue({ items: [queue("orders-q"), queue("dead-q"), queue("dead.fifo")], truncated: false });
});

const preview = () => screen.getByRole("button", { name: "미리 보기…" });

test("변경 종류별 입구와 확인의 색을 구분해요", () => {
  expect(changeTone({ kind: "unsubscribe" })).toBe("tone-danger");
  expect(changeTone({ kind: "subscribe" })).toBe("tone-create");
  expect(changeTone({ kind: "rawDelivery" })).toBe("tone-warn");
  expect(changeTone({ kind: "archivePolicy", retentionDays: null })).toBe("tone-danger");
  expect(changeTone({ kind: "archivePolicy", retentionDays: 30 })).toBe("tone-warn");
  expect(changeTone({ kind: "undo" })).toBe("tone-caution");
  expect(changeTone({ kind: "queuePolicy" })).toBe("tone-primary");
});

test("이미 연결된 DLQ를 다른 FIFO 큐로 바꿀 수 있어요", async () => {
  renderWithClient(<SubscriptionDetail topic={sampleTopic()} subscriptionKey={sqsSubscription.key} snsTarget={snsTarget} onBack={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "DLQ 바꾸기…" }));
  const picker = await screen.findByRole("dialog", { name: /DLQ 고르기/ });
  fireEvent.click(await within(picker).findByRole("radio", { name: /dead.fifo/ }));
  fireEvent.click(within(picker).getByRole("button", { name: "미리 보기…" }));
  await waitFor(() => expect(m.plan).toHaveBeenCalledWith("personal", REGION, { kind: "addDlq", subscriptionArn: sqsSubscription.arn, dlqArn: `arn:aws:sqs:${REGION}:${ACCOUNT}:dead.fifo` }));
});

test("발행 속성 10개 제한을 비활성 단추에 설명해요", () => {
  renderWithClient(<PublishForm topic={standard} onPreview={vi.fn()} onClose={vi.fn()} />);
  const add = screen.getByRole("button", { name: "속성 추가" });
  for (let i = 0; i < 10; i++) fireEvent.click(add);
  expect(add).toBeDisabled();
  expect(add).toHaveAttribute("title", "속성은 최대 10개까지 추가할 수 있어요");
});

describe("subscribe form", () => {
  const setup = (topic = standard) => {
    const onPreview = vi.fn();
    renderWithClient(<SubscribeForm target={snsTarget} topic={topic} onPreview={onPreview} onClose={vi.fn()} />);
    return onPreview;
  };

  test("an SQS endpoint is picked from the region's queues; the preview carries filter, raw and a same-kind DLQ", async () => {
    const onPreview = setup();
    expect(preview()).toBeDisabled();
    const pick = await screen.findByRole("combobox", { name: "엔드포인트 고르기" });
    await waitFor(() => expect(within(pick).getByText("orders-q")).toBeInTheDocument());
    fireEvent.change(pick, { target: { value: `arn:aws:sqs:${REGION}:${ACCOUNT}:orders-q` } });
    typeYaml('{"event":["created"]}', "필터 정책(JSON, 비우면 필터 없음)");
    fireEvent.click(screen.getByRole("checkbox"));
    const dlq = screen.getByRole("combobox", { name: "DLQ(RedrivePolicy)" });
    // 표준 주제라서 FIFO 큐는 DLQ 후보에서 빠진다
    expect(within(dlq).queryByText("dead.fifo")).toBeNull();
    fireEvent.change(dlq, { target: { value: `arn:aws:sqs:${REGION}:${ACCOUNT}:dead-q` } });
    fireEvent.click(preview());
    expect(onPreview).toHaveBeenCalledWith({ kind: "subscribe", topicArn: TOPIC_ARN, protocol: "sqs", endpoint: `arn:aws:sqs:${REGION}:${ACCOUNT}:orders-q`, filterPolicy: '{"event":["created"]}', filterPolicyScope: "MessageAttributes", rawMessageDelivery: true, dlqArn: `arn:aws:sqs:${REGION}:${ACCOUNT}:dead-q` });
  });

  test("a typed ARN of another account is accepted with the note that nothing there is touched", async () => {
    const onPreview = setup();
    fireEvent.change(screen.getByRole("textbox", { name: "또는 ARN 직접 입력(다른 계정·리전)" }), { target: { value: "arn:aws:sqs:us-east-1:999999999999:partner" } });
    expect(screen.getByText(/그쪽 큐 정책이나 함수 권한은 이 앱이 건드리지 않아요/)).toBeInTheDocument();
    fireEvent.click(preview());
    expect(onPreview.mock.calls[0][0]).toMatchObject({ protocol: "sqs", endpoint: "arn:aws:sqs:us-east-1:999999999999:partner", dlqArn: null });
  });

  test("email takes an address, shows the pending notice, has no raw or DLQ, and rejects a broken filter", async () => {
    const onPreview = setup();
    fireEvent.change(screen.getByRole("combobox", { name: "프로토콜" }), { target: { value: "email" } });
    expect(screen.getByText(/확인 대기로 남아요/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "DLQ(RedrivePolicy)" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "이메일 주소" }), { target: { value: "ops@example.com" } });
    typeYaml("{bad", "필터 정책(JSON, 비우면 필터 없음)");
    expect(preview()).toBeDisabled();
    typeYaml("", "필터 정책(JSON, 비우면 필터 없음)");
    fireEvent.click(preview());
    expect(onPreview.mock.calls[0][0]).toMatchObject({ kind: "subscribe", protocol: "email", endpoint: "ops@example.com", filterPolicy: null, rawMessageDelivery: false, dlqArn: null });
  });
});

describe("publish form", () => {
  test("a standard topic needs only a message; attributes and json structure go into the request", () => {
    const onPreview = vi.fn();
    renderWithClient(<PublishForm topic={standard} onPreview={onPreview} onClose={vi.fn()} />);
    expect(preview()).toBeDisabled();
    typeYaml('{"default":"hi"}', "메시지");
    fireEvent.click(screen.getByRole("checkbox", { name: /MessageStructure=json/ }));
    fireEvent.click(screen.getByRole("button", { name: "속성 추가" }));
    fireEvent.change(screen.getByLabelText("속성 이름 1"), { target: { value: "event" } });
    fireEvent.change(screen.getByLabelText("속성 값 1"), { target: { value: "created" } });
    fireEvent.click(preview());
    expect(onPreview).toHaveBeenCalledWith({ kind: "publish", topicArn: TOPIC_ARN, message: '{"default":"hi"}', subject: null, messageStructureJson: true, attributes: [{ name: "event", dataType: "String", value: "created" }], messageGroupId: null, deduplicationId: null });
  });

  test("a FIFO topic needs a group id, and a dedup id unless content-based deduplication is on", () => {
    const fifo = sampleTopic({ overview: { ...sampleTopic().overview, contentBasedDeduplication: false } });
    const onPreview = vi.fn();
    renderWithClient(<PublishForm topic={fifo} onPreview={onPreview} onClose={vi.fn()} />);
    typeYaml("hello", "메시지");
    expect(preview()).toHaveAttribute("title", "FIFO 주제에는 메시지 그룹 ID가 필요해요");
    fireEvent.change(screen.getByLabelText("메시지 그룹 ID"), { target: { value: "g1" } });
    expect(preview()).toHaveAttribute("title", "중복 제거 ID가 필요해요");
    fireEvent.change(screen.getByLabelText("중복 제거 ID"), { target: { value: "d1" } });
    expect(preview()).toBeEnabled();
    fireEvent.click(preview());
    expect(onPreview.mock.calls[0][0]).toMatchObject({ messageGroupId: "g1", deduplicationId: "d1" });
  });

  test("json structure without a default key is blocked", () => {
    renderWithClient(<PublishForm topic={standard} onPreview={vi.fn()} onClose={vi.fn()} />);
    typeYaml('{"email":"x"}', "메시지");
    fireEvent.click(screen.getByRole("checkbox", { name: /MessageStructure=json/ }));
    expect(preview()).toBeDisabled();
  });
});

describe("logging form", () => {
  test("only existing roles are offered, and the request carries both roles and the rate", async () => {
    m.loggingRoles.mockResolvedValue([{ name: "sns-logs", arn: `arn:aws:iam::${ACCOUNT}:role/sns-logs` }]);
    const onPreview = vi.fn();
    renderWithClient(<LoggingForm target={snsTarget} logging={{ protocol: "SQS", successRole: null, failureRole: null, sampleRate: 0 }} onPreview={onPreview} onClose={vi.fn()} />);
    const success = await screen.findByRole("combobox", { name: "성공 로그 역할" });
    await waitFor(() => expect(within(success).getByText("sns-logs")).toBeInTheDocument());
    expect(screen.getByText(/역할을 만들지 않아요/)).toBeInTheDocument();
    fireEvent.change(success, { target: { value: `arn:aws:iam::${ACCOUNT}:role/sns-logs` } });
    fireEvent.change(screen.getByLabelText("성공 로그 표본 비율(%)"), { target: { value: "150" } });
    expect(preview()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("성공 로그 표본 비율(%)"), { target: { value: "20" } });
    fireEvent.click(preview());
    expect(onPreview).toHaveBeenCalledWith({ kind: "deliveryLogging", topicArn: TOPIC_ARN, protocol: "SQS", successRoleArn: `arn:aws:iam::${ACCOUNT}:role/sns-logs`, failureRoleArn: null, sampleRate: 20 });
    expect(m.loggingRoles).toHaveBeenCalledWith("personal", REGION);
  });
});

describe("subscription controls", () => {
  test("filter edit: editor, then a preview dialog with recent-sample verdicts before and after", async () => {
    recent.set(snsTabId(snsTarget), [{ attributes: [{ name: "event_type", dataType: "String", value: "order.paid" }], body: null }]);
    m.filterTest.mockImplementation(async (policies) => policies.map((p) => ({ key: p.key, verdict: { matched: p.key === "after", key: null, reason: null }, errors: [], summary: null })));
    m.plan.mockImplementation(async (_p, _r, request) => plan(request, { fields: [{ field: "filterPolicy", before: sqsSubscription.attributes.FilterPolicy, after: '{"event_type":["order.paid"]}', diff: "--- 이전\n+++ 이후\n-old\n+new" }] }));
    renderWithClient(<FilterEdit sub={sqsSubscription} target={snsTarget} />);
    const edit = screen.getByRole("button", { name: "필터 정책 편집" });
    expect(edit).toHaveClass("tone-secondary");
    fireEvent.click(edit);
    typeYaml('{"event_type":["order.paid"]}', "필터 정책 편집기");
    const go = screen.getByRole("button", { name: "미리 보기…" });
    expect(go).toHaveClass("tone-primary");
    fireEvent.click(go);
    const dialog = await screen.findByRole("dialog", { name: "필터 정책 바꾸기" });
    expect(m.plan).toHaveBeenCalledWith("personal", REGION, { kind: "filterPolicy", subscriptionArn: sqsSubscription.arn, filterPolicy: '{"event_type":["order.paid"]}', scope: "MessageAttributes" });
    const table = await within(dialog).findByRole("table", { name: "최근 표본의 판정" });
    const cells = within(table).getAllByRole("cell").map((c) => c.textContent);
    expect(cells[0]).toBe("event_type=order.paid");
    expect(cells[1]).toBe("걸러짐");
    expect(cells[2]).toMatch(/^받음/);
    expect(within(table).getByText(/바뀜/)).toBeInTheDocument();
  });

  test("clearing the filter editor previews the removal", async () => {
    renderWithClient(<FilterEdit sub={sqsSubscription} target={snsTarget} />);
    fireEvent.click(screen.getByRole("button", { name: "필터 정책 편집" }));
    typeYaml("", "필터 정책 편집기");
    fireEvent.click(screen.getByRole("button", { name: "미리 보기…" }));
    await screen.findByRole("dialog", { name: "필터 정책 바꾸기" });
    expect(m.plan).toHaveBeenCalledWith("personal", REGION, expect.objectContaining({ kind: "filterPolicy", filterPolicy: null }));
  });

  test("raw toggle is a single warn-coloured button whose label flips; Lambda cannot use it", async () => {
    const { unmount } = renderWithClient(<RawToggle sub={sqsSubscription} target={snsTarget} />);
    const off = screen.getByRole("button", { name: "raw 전달 끄기…" });
    expect(off).toHaveClass("tone-warn");
    fireEvent.click(off);
    await screen.findByRole("dialog", { name: "raw 전달 끄기" });
    expect(m.plan).toHaveBeenCalledWith("personal", REGION, { kind: "rawDelivery", subscriptionArn: sqsSubscription.arn, enabled: false });
    unmount();
    renderWithClient(<RawToggle sub={lambdaSubscription} target={snsTarget} />);
    const on = screen.getByRole("button", { name: "raw 전달 켜기…" });
    expect(on).toBeDisabled();
    expect(on).toHaveClass("tone-warn");
  });

  test("unsubscribe is a danger button; pending subscriptions cannot be unsubscribed", async () => {
    const { unmount } = renderWithClient(<UnsubscribeButton sub={sqsSubscription} target={snsTarget} />);
    const button = screen.getByRole("button", { name: "해지…" });
    expect(button).toHaveClass("tone-danger");
    fireEvent.click(button);
    await screen.findByRole("dialog", { name: "구독 해지" });
    expect(m.plan).toHaveBeenCalledWith("personal", REGION, { kind: "unsubscribe", subscriptionArn: sqsSubscription.arn });
    unmount();
    renderWithClient(<UnsubscribeButton sub={pendingSubscription} target={snsTarget} />);
    expect(screen.getByRole("button", { name: "해지…" })).toBeDisabled();
  });
});

describe("subscriptions table entry points", () => {
  test("구독 만들기… is green, 해지… is red at the row end and does not open the detail", async () => {
    const onOpen = vi.fn();
    renderWithClient(<Subscriptions topic={sampleTopic()} target={snsTarget} active onOpen={onOpen} />);
    expect(screen.getByRole("button", { name: "구독 만들기…" })).toHaveClass("tone-create");
    const rows = within(screen.getByRole("table", { name: "구독 목록" })).getAllByRole("row").slice(1);
    const unsub = within(rows[0]).getByRole("button", { name: "해지…" });
    expect(unsub).toHaveClass("tone-danger");
    fireEvent.click(unsub);
    expect(onOpen).not.toHaveBeenCalled();
    await screen.findByRole("dialog", { name: "구독 해지" });
    expect(within(rows[3]).getByRole("button", { name: "해지…" })).toBeDisabled();
  });
});

describe("topic policy editor", () => {
  const policy: SnsTopicPolicy = { topicArn: TOPIC_ARN, policy: '{"Version":"2012-10-17","Statement":[]}', statements: [], statementsError: null, access: [], validation: [], findings: [], errors: [] };

  test("the preview carries the validation findings and the paid public-access button with its cost", async () => {
    m.plan.mockImplementation(async (_p, _r, request) => plan(request, { confirm: "orders", fields: [{ field: "topicPolicy", before: "{}", after: '{"Statement":[1]}', diff: "+x" }] }));
    m.validatePolicy.mockResolvedValue([{ level: "warning", code: "EMPTY", message: "문장이 비었어요", learnMore: null }]);
    m.checkPolicyDocument.mockResolvedValue({ result: "fail", message: "공개예요", reasons: [], finding: null });
    renderWithClient(<TopicPolicyEdit target={snsTarget} policy={policy} />);
    const edit = screen.getByRole("button", { name: "정책 편집" });
    expect(edit).toHaveClass("tone-secondary");
    fireEvent.click(edit);
    typeYaml('{"Statement":[1]}', "주제 정책 편집기");
    fireEvent.click(screen.getByRole("button", { name: "미리 보기…" }));
    const dialog = await screen.findByRole("dialog", { name: "주제 정책 저장" });
    expect(m.plan).toHaveBeenCalledWith("personal", REGION, { kind: "topicPolicy", topicArn: TOPIC_ARN, policy: '{"Statement":[1]}' });
    expect(await within(dialog).findByText("문장이 비었어요")).toBeInTheDocument();
    expect(m.validatePolicy).toHaveBeenCalledWith("personal", REGION, '{"Statement":[1]}');
    // 이름을 입력하기 전에는 적용할 수 없다
    expect(within(dialog).getByRole("button", { name: "적용" })).toBeDisabled();
    const paid = within(dialog).getByRole("button", { name: /공개 접근 검사 실행 \(\$0\.002\)/ });
    expect(m.checkPolicyDocument).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(paid));
    expect(m.checkPolicyDocument).toHaveBeenCalledWith("personal", REGION, TOPIC_ARN, '{"Statement":[1]}');
    expect(await within(dialog).findByText(/공개예요/)).toBeInTheDocument();
  });
});

describe("change log text", () => {
  const record = (request: SnsChangeRequest, over: Partial<SnsChangeRecord> = {}): SnsChangeRecord => ({ id: "1", at: "2026-01-01T00:00:00Z", profile: "personal", region: REGION, topicArn: TOPIC_ARN, request, calls: [{ api: "x", target: "t", body: {} }], before: {}, after: {}, undoOf: null, undone: false, undoBlocked: null, ...over });
  const publish: SnsChangeRequest = { kind: "publish", topicArn: TOPIC_ARN, message: "[가림]", subject: null, messageStructureJson: false, attributes: [{ name: "a", dataType: "String", value: "[가림]" }], messageGroupId: null, deduplicationId: null };

  test("summaries exist for every new kind and publish shows its MessageId but cannot be undone", () => {
    const requests: SnsChangeRequest[] = [
      { kind: "subscribe", topicArn: TOPIC_ARN, protocol: "sqs", endpoint: QUEUE_ARN, filterPolicy: null, filterPolicyScope: null, rawMessageDelivery: false, dlqArn: null },
      { kind: "unsubscribe", subscriptionArn: `${TOPIC_ARN}:abcdef123` },
      { kind: "filterPolicy", subscriptionArn: `${TOPIC_ARN}:abcdef123`, filterPolicy: null, scope: "MessageAttributes" },
      { kind: "rawDelivery", subscriptionArn: `${TOPIC_ARN}:abcdef123`, enabled: true },
      { kind: "subscriptionDeliveryPolicy", subscriptionArn: `${TOPIC_ARN}:abcdef123`, deliveryPolicy: "{}" },
      { kind: "topicDeliveryPolicy", topicArn: TOPIC_ARN, deliveryPolicy: null },
      { kind: "topicPolicy", topicArn: TOPIC_ARN, policy: "{}" },
      { kind: "deliveryLogging", topicArn: TOPIC_ARN, protocol: "SQS", successRoleArn: null, failureRoleArn: null, sampleRate: 0 },
      publish,
    ];
    for (const r of requests) {
      expect(ct.requestSummary(r)).not.toBe("");
      expect(ct.requestTitle(r)).not.toBe("");
    }
    expect(ct.requestSummary(requests[0])).toBe("구독 만들기 · sqs · orders-queue.fifo");
    expect(ct.recordDetail(record(publish, { after: { messageId: "m-9" } }))).toBe("MessageId m-9");
    expect(undoBlockReason(record(publish))).toBe(ct.UNDO_WHY_PUBLISH);
    expect(undoBlockReason(record(requests[1]))).toBeNull();
  });

  test("an unsubscribe of email or http is marked as needing reconfirmation", () => {
    const unsub: SnsChangeRequest = { kind: "unsubscribe", subscriptionArn: `${TOPIC_ARN}:abc` };
    expect(ct.needsReconfirm(record(unsub, { before: { subscription: { protocol: "https", reconfirm: true } } }))).toBe(true);
    expect(ct.needsReconfirm(record(unsub, { before: { subscription: { protocol: "sqs", reconfirm: false } } }))).toBe(false);
  });
});
