import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { snsApi } from "./api";
import { ChangeLog, undoBlockReason } from "./ChangeLog";
import { FUNCTION_ARN, QUEUE_ARN, QUEUE_URL, REGION, TOPIC_ARN, snsTarget } from "./fixtures";
import type { SnsChangeRecord, SnsPlan } from "./types";

vi.mock("./api", () => ({ snsApi: { changes: vi.fn(), undoPlan: vi.fn(), apply: vi.fn(), plan: vi.fn() } }));
const m = vi.mocked(snsApi);

const record = (over: Partial<SnsChangeRecord>): SnsChangeRecord => ({
  id: "rec-1",
  at: "2026-11-06T09:30:00Z",
  profile: "personal",
  region: REGION,
  topicArn: TOPIC_ARN,
  request: { kind: "queuePolicy", topicArn: TOPIC_ARN, queueUrl: QUEUE_URL, queueArn: QUEUE_ARN },
  calls: [{ api: "sqs:SetQueueAttributes", target: QUEUE_URL, body: {} }],
  before: null,
  after: null,
  undoOf: null,
  undone: false,
  ...over,
});
const undoPlan: SnsPlan = { request: { kind: "undo", id: "rec-1" }, topicArn: TOPIC_ARN, calls: [{ api: "sqs:SetQueueAttributes", target: QUEUE_URL, body: {} }], fields: [], impact: [], warnings: [], confirm: null, fingerprint: "u", undoOf: "rec-1" };

beforeEach(() => {
  vi.clearAllMocks();
  m.undoPlan.mockResolvedValue(undoPlan);
});

const rows = () => within(screen.getByRole("table", { name: "변경 기록" })).getAllByRole("row").slice(1);

test("shows only this topic's records, newest first, with a Korean summary and the calls", async () => {
  m.changes.mockResolvedValue([
    record({ id: "new", request: { kind: "lambdaPermission", topicArn: TOPIC_ARN, functionArn: FUNCTION_ARN }, calls: [{ api: "lambda:AddPermission", target: FUNCTION_ARN, body: {} }] }),
    record({ id: "other-topic", topicArn: "arn:aws:sns:ap-northeast-2:123456789012:other" }),
    record({ id: "other-region", region: "us-east-1" }),
    record({ id: "old" }),
  ]);
  renderWithClient(<ChangeLog target={snsTarget} />);
  await screen.findByRole("table", { name: "변경 기록" });
  const r = rows();
  expect(r).toHaveLength(2);
  expect(within(r[0]).getByText("Lambda 함수에 이 주제의 호출 권한 추가 · order-processor")).toBeInTheDocument();
  expect(within(r[0]).getByText("lambda:AddPermission")).toBeInTheDocument();
  expect(within(r[1]).getByText("큐 정책에 이 주제의 배달 권한 추가 · orders-queue.fifo")).toBeInTheDocument();
});

test("an empty log says so", async () => {
  m.changes.mockResolvedValue([record({ topicArn: "arn:other" })]);
  renderWithClient(<ChangeLog target={snsTarget} />);
  expect(await screen.findByText("이 주제의 변경 기록이 없어요")).toBeInTheDocument();
});

test("[되돌리기…] is caution orange and opens the undo preview for that record", async () => {
  m.changes.mockResolvedValue([record({})]);
  m.apply.mockResolvedValue({ callsRun: undoPlan.calls, error: null, recordId: "rec-9" });
  renderWithClient(<ChangeLog target={snsTarget} />);
  await screen.findByRole("table", { name: "변경 기록" });
  const button = within(rows()[0]).getByRole("button", { name: "되돌리기…" });
  expect(button).toHaveClass("tone-caution");
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog", { name: "되돌리기 미리보기" });
  expect(m.undoPlan).toHaveBeenCalledWith("personal", REGION, "rec-1");
  fireEvent.click(within(dialog).getByRole("button", { name: "되돌리기" }));
  expect(await screen.findByText("되돌렸어요")).toBeInTheDocument();
  expect(m.apply).toHaveBeenCalledWith("personal", REGION, undoPlan);
  // 적용한 뒤 변경 기록을 다시 읽는다
  await vi.waitFor(() => expect(m.changes).toHaveBeenCalledTimes(2));
});

test("records that cannot be undone say why", async () => {
  m.changes.mockResolvedValue([record({ id: "a", undone: true }), record({ id: "b", undoOf: "a" }), record({ id: "c", calls: [] })]);
  renderWithClient(<ChangeLog target={snsTarget} />);
  await screen.findByRole("table", { name: "변경 기록" });
  const r = rows();
  for (const [row, why] of [[r[0], "이미 되돌렸어요"], [r[1], "되돌리기 기록은 다시 되돌릴 수 없어요"], [r[2], "실행한 호출이 없어서 되돌릴 것이 없어요"]] as const) {
    const button = within(row).getByRole("button", { name: "되돌리기…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", why);
    expect(within(row).getByText(why)).toBeInTheDocument();
  }
  expect(within(r[0]).getByText("되돌렸어요")).toBeInTheDocument();
  expect(within(r[1]).getByText("되돌리기 기록")).toBeInTheDocument();
});

test("undoBlockReason is null for a plain applied record", () => {
  expect(undoBlockReason(record({}))).toBeNull();
});

test("a read failure shows the error state", async () => {
  m.changes.mockRejectedValue({ kind: "other", message: "기록을 읽지 못했어요" });
  renderWithClient(<ChangeLog target={snsTarget} />);
  expect(await screen.findByText("기록을 읽지 못했어요")).toBeInTheDocument();
});
