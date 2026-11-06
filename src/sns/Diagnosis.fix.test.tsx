import { fireEvent, screen, within } from "@testing-library/react";
import { api } from "../api/client";
import { renderWithClient } from "../test/utils";
import { makeResource } from "../test/utils";
import { desktop } from "../api/desktop";
import { snsApi } from "./api";
import { ACCOUNT, FUNCTION_ARN, QUEUE_ARN, QUEUE_URL, REGION, TOPIC_ARN, lambdaSubscription, sampleTopic, snsTarget, sqsSubscription } from "./fixtures";
import { Diagnosis } from "./Diagnosis";
import type { SnsCheck, SnsDiagnosisReport, SnsFix, SnsPlan, SnsSubscription } from "./types";

vi.mock("./api", () => ({ snsApi: { diagnose: vi.fn(), plan: vi.fn(), apply: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { listResources: vi.fn(), ssoLogin: vi.fn(), getSettings: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(async () => {}) } }));

const m = vi.mocked(snsApi);
const q = (name: string) => makeResource(`https://sqs/${name}`, { name }, { arn: `arn:aws:sqs:${REGION}:${ACCOUNT}:${name}` });
const standardSub: SnsSubscription = { ...sqsSubscription, key: `${TOPIC_ARN}:dddd`, arn: `${TOPIC_ARN}:dddd`, dlqArn: null, endpoint: `arn:aws:sqs:${REGION}:${ACCOUNT}:std-queue`, target: { kind: "sqs", arn: `arn:aws:sqs:${REGION}:${ACCOUNT}:std-queue`, url: "u", fifo: false, kmsKey: null, policy: null, redrivePolicy: null, error: null } };

const check = (id: string, fix: SnsFix): SnsCheck => ({ id, status: "fail", summary: `${id} 문제`, detail: null, fix });
const report = (subscription: string, checks: SnsCheck[]): SnsDiagnosisReport => ({
  topicChecks: [],
  subscriptions: [{ subscription, checks, verdict: "막힌 곳이 있어요" }],
  failures: [],
  metrics: { failed: null, filteredInvalidAttributes: null, filteredInvalidBody: null, redrivenToDlq: null, delivered: null, published: null },
});
const plan = (request: SnsPlan["request"]): SnsPlan => ({ request, topicArn: TOPIC_ARN, calls: [{ api: "x:Y", target: "t", body: {} }], fields: [], impact: [], warnings: [], confirm: null, fingerprint: "f", undoOf: null });

beforeEach(() => {
  vi.clearAllMocks();
  m.plan.mockImplementation(async (_p, _r, request) => plan(request));
});

const open = async (topic = sampleTopic(), checks: SnsCheck[], sub = topic.subscriptions[0]) => {
  m.diagnose.mockResolvedValue(report(sub.key, checks));
  renderWithClient(<Diagnosis topic={topic} target={snsTarget} />);
  const region = await screen.findByRole("region", { name: "배달 진단" });
  fireEvent.click(within(region).getByText("자세히"));
  return region;
};

test("a queuePolicy fix opens the change dialog with a queuePolicy request next to the copy button", async () => {
  const region = await open(sampleTopic(), [check("queuePolicy", { kind: "queuePolicy", queueArn: QUEUE_ARN, queueUrl: QUEUE_URL, statement: { Effect: "Allow" } })]);
  expect(within(region).getByRole("button", { name: "복사" })).toBeInTheDocument();
  const fix = within(region).getByRole("button", { name: "고치기…" });
  expect(fix).toHaveClass("tone-primary");
  fireEvent.click(fix);
  await screen.findByRole("dialog", { name: "큐 정책 고치기" });
  expect(m.plan).toHaveBeenCalledWith("personal", REGION, { kind: "queuePolicy", topicArn: TOPIC_ARN, queueUrl: QUEUE_URL, queueArn: QUEUE_ARN });
});

test("a lambdaPermission fix opens the dialog with a lambdaPermission request", async () => {
  const topic = sampleTopic();
  const region = await open(topic, [check("lambdaPolicy", { kind: "lambdaPermission", functionArn: FUNCTION_ARN, statementId: "s", sourceArn: TOPIC_ARN })], lambdaSubscription);
  fireEvent.click(within(region).getByRole("button", { name: "고치기…" }));
  await screen.findByRole("dialog", { name: "Lambda 권한 고치기" });
  expect(m.plan).toHaveBeenCalledWith("personal", REGION, { kind: "lambdaPermission", topicArn: TOPIC_ARN, functionArn: FUNCTION_ARN });
});

test("a kmsStatement fix stays copy only", async () => {
  const region = await open(sampleTopic(), [check("queueKms", { kind: "kmsStatement", keyArn: "arn:key", statement: { Effect: "Allow" } })]);
  expect(within(region).queryByRole("button", { name: "고치기…" })).not.toBeInTheDocument();
  fireEvent.click(within(region).getByRole("button", { name: "복사" }));
  expect(desktop.copy).toHaveBeenCalled();
});

test("an addDlq fix opens the picker with matching queues, then the dialog with the chosen DLQ", async () => {
  vi.mocked(api.listResources).mockResolvedValue({ items: [q("std-queue"), q("dead-std"), q("dead.fifo")], truncated: false });
  const topic = sampleTopic({ fifo: false, subscriptions: [standardSub] });
  const region = await open(topic, [check("dlq", { kind: "addDlq", subscriptionArn: standardSub.arn! })], standardSub);
  fireEvent.click(within(region).getByRole("button", { name: "DLQ 붙이기…" }));
  const picker = await screen.findByRole("dialog", { name: /^DLQ 고르기/ });
  expect(api.listResources).toHaveBeenCalledWith("personal", REGION, "sqs", "queues");
  const list = await within(picker).findByRole("radiogroup", { name: "DLQ로 쓸 수 있는 큐" });
  expect(within(list).getAllByRole("radio")).toHaveLength(1);
  expect(within(list).getByText("dead-std")).toBeInTheDocument();
  expect(within(picker).getByRole("button", { name: "미리 보기…" })).toBeDisabled();
  fireEvent.click(within(list).getByRole("radio"));
  expect(within(picker).getByRole("button", { name: "미리 보기…" })).toHaveClass("tone-primary");
  fireEvent.click(within(picker).getByRole("button", { name: "미리 보기…" }));
  await screen.findByRole("dialog", { name: "DLQ 붙이기" });
  expect(screen.queryByRole("dialog", { name: /^DLQ 고르기/ })).not.toBeInTheDocument();
  expect(m.plan).toHaveBeenCalledWith("personal", REGION, { kind: "addDlq", subscriptionArn: standardSub.arn, dlqArn: `arn:aws:sqs:${REGION}:${ACCOUNT}:dead-std` });
});

test("the picker says so when no queue fits", async () => {
  vi.mocked(api.listResources).mockResolvedValue({ items: [q("dead.fifo")], truncated: false });
  const topic = sampleTopic({ fifo: false, subscriptions: [standardSub] });
  const region = await open(topic, [check("dlq", { kind: "addDlq", subscriptionArn: standardSub.arn! })], standardSub);
  fireEvent.click(within(region).getByRole("button", { name: "DLQ 붙이기…" }));
  const picker = await screen.findByRole("dialog", { name: /^DLQ 고르기/ });
  expect(await within(picker).findByText("DLQ로 쓸 수 있는 큐가 없어요")).toBeInTheDocument();
  expect(within(picker).getByText(/표준 큐만 DLQ로 쓸 수 있어요/)).toBeInTheDocument();
  expect(within(picker).getByText("종류·계정·리전이 맞지 않아 숨긴 큐 1개")).toBeInTheDocument();
});

test("an addDlq fix whose subscription is not in the snapshot is disabled with the reason", async () => {
  const region = await open(sampleTopic(), [check("dlq", { kind: "addDlq", subscriptionArn: `${TOPIC_ARN}:gone` })]);
  const button = within(region).getByRole("button", { name: "DLQ 붙이기…" });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("title", "이 구독을 찾을 수 없어서 DLQ를 붙일 수 없어요");
});

test("after applying, the diagnosis is read again", async () => {
  m.apply.mockResolvedValue({ callsRun: [{ api: "x:Y", target: "t", body: {} }], error: null, recordId: "r" });
  const region = await open(sampleTopic(), [check("queuePolicy", { kind: "queuePolicy", queueArn: QUEUE_ARN, queueUrl: QUEUE_URL, statement: {} })]);
  expect(m.diagnose).toHaveBeenCalledTimes(1);
  fireEvent.click(within(region).getByRole("button", { name: "고치기…" }));
  await screen.findByRole("dialog");
  fireEvent.click(await screen.findByRole("button", { name: "적용" }));
  await screen.findByText("적용했어요");
  await vi.waitFor(() => expect(m.diagnose).toHaveBeenCalledTimes(2));
});
