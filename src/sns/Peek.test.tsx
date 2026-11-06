import { act, fireEvent, screen, within } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { renderWithClient } from "../test/utils";
import { snsTarget } from "./fixtures";
import { Peek } from "./Peek";
import { applyPeekEvent, type PeekEvent, type PeekMessage, type PeekVerdict } from "./peekSession";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const dlq: PeekVerdict = { queueArn: "arn:aws:sqs:ap-northeast-2:111122223333:orders-dlq", queueName: "orders-dlq", queueUrl: "https://sqs/orders-dlq", eligible: true, dlq: true, warning: null, reason: null };
const busy: PeekVerdict = { queueArn: "arn:aws:sqs:ap-northeast-2:111122223333:orders", queueName: "orders", queueUrl: "https://sqs/orders", eligible: false, dlq: false, warning: null, reason: "지난 1시간에 받아 간 기록이 있어요" };
const watched: PeekVerdict = { ...dlq, queueArn: "arn:aws:sqs:ap-northeast-2:111122223333:audit-dlq", queueName: "audit-dlq", warning: "이 DLQ를 읽는 소비자가 있는 것 같아요" };

const message = (id: string): PeekMessage => ({ messageId: id, body: '{"order":1}', attributes: { event: { Type: "String", Value: "order.paid" } }, topicArn: snsTarget.topicArn, timestamp: "2026-11-06T09:07:11.987Z", snsMessageId: `sns-${id}`, failureLines: [] });

let emit: (ev: PeekEvent) => void = () => {};
const unlisten = vi.fn();

function mockBackend(verdicts: PeekVerdict[], onStart?: () => void) {
  vi.mocked(listen).mockImplementation(async (_name, cb) => {
    emit = (ev) => (cb as (e: { payload: PeekEvent }) => void)({ payload: ev });
    return unlisten;
  });
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "sns_peek_eligibility") return verdicts;
    if (cmd === "sns_peek_start") {
      onStart?.();
      return "s1";
    }
    return undefined;
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset();
  unlisten.mockReset();
});

test("같은 메시지는 한 번만 두고, 오류 뒤의 끝은 오류로 남겨요", () => {
  const idle = { status: "running" as const, queueArn: dlq.queueArn, messages: [], error: null };
  const one = applyPeekEvent(idle, { session: "s1", kind: "message", message: message("m1") });
  expect(applyPeekEvent(one, { session: "s1", kind: "message", message: message("m1") }).messages).toHaveLength(1);
  const failed = applyPeekEvent(one, { session: "s1", kind: "error", error: { kind: "other", message: "x" } });
  expect(applyPeekEvent(failed, { session: "s1", kind: "done" }).status).toBe("error");
});

test("엿볼 수 있는 큐만 버튼이 켜지고 막힌 큐는 이유를 보여 줘요", async () => {
  mockBackend([dlq, busy]);
  renderWithClient(<Peek target={snsTarget} />);
  const region = await screen.findByRole("region", { name: "큐 엿보기" });
  expect(await within(region).findByRole("button", { name: "DLQ 엿보기…" })).toBeEnabled();
  const blocked = within(region).getByRole("button", { name: "큐 엿보기…" });
  expect(blocked).toBeDisabled();
  expect(blocked).toHaveAttribute("title", busy.reason);
});

test("시작 전에 확인하고, 시작 응답보다 먼저 온 메시지도 보여 줘요", async () => {
  // 백엔드가 start를 돌려주기 전에 이벤트를 보내는 경우
  mockBackend([dlq], () => emit({ session: "s1", kind: "message", message: message("m1") }));
  renderWithClient(<Peek target={snsTarget} />);
  fireEvent.click(await screen.findByRole("button", { name: "DLQ 엿보기…" }));
  const sheet = screen.getByRole("dialog", { name: "orders-dlq 엿보기" });
  expect(within(sheet).getByText(/30초 동안/)).toBeInTheDocument();
  expect(within(sheet).queryByLabelText(/계속 보기/)).toBeNull();
  await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "엿보기 시작" })));
  expect(invoke).toHaveBeenCalledWith("sns_peek_start", { profile: snsTarget.profile, region: snsTarget.region, topicArn: snsTarget.topicArn, queueArn: dlq.queueArn, follow: false, confirmedName: null });
  expect(await screen.findByRole("article", { name: "메시지 sns-m1" })).toBeInTheDocument();
  act(() => emit({ session: "s1", kind: "message", message: message("m2") }));
  act(() => emit({ session: "other", kind: "message", message: message("m3") }));
  act(() => emit({ session: "s1", kind: "done" }));
  expect(screen.getByText(/끝났어요/)).toHaveTextContent("2개");
});

test("소비자 흔적이 있는 DLQ는 큐 이름을 입력해야 시작해요", async () => {
  mockBackend([watched]);
  renderWithClient(<Peek target={snsTarget} />);
  fireEvent.click(await screen.findByRole("button", { name: "DLQ 엿보기…" }));
  const sheet = screen.getByRole("dialog", { name: "audit-dlq 엿보기" });
  const startButton = within(sheet).getByRole("button", { name: "엿보기 시작" });
  expect(startButton).toBeDisabled();
  fireEvent.change(within(sheet).getByRole("textbox"), { target: { value: "audit-dlq" } });
  expect(startButton).toBeEnabled();
});

test("새 소비자 경고가 발견되면 판정을 다시 읽고 큐 이름을 확인해요", async () => {
  mockBackend([dlq]);
  let checks = 0;
  let starts = 0;
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "sns_peek_eligibility") return ++checks === 1 ? [dlq] : [{ ...dlq, warning: "새 소비자 활동" }];
    if (cmd === "sns_peek_start") {
      if (++starts === 1) throw { kind: "peekConfirm", warning: "새 소비자 활동", message: "확인이 필요해요" };
      return "s1";
    }
    return undefined;
  });
  renderWithClient(<Peek target={snsTarget} />);
  fireEvent.click(await screen.findByRole("button", { name: "DLQ 엿보기…" }));
  fireEvent.click(screen.getByRole("button", { name: "엿보기 시작" }));
  const sheet = await screen.findByRole("dialog", { name: "orders-dlq 엿보기" });
  expect(within(sheet).getByText("새 소비자 활동")).toBeInTheDocument();
  expect(within(sheet).getByRole("button", { name: "엿보기 시작" })).toBeDisabled();
  fireEvent.change(within(sheet).getByRole("textbox"), { target: { value: "orders-dlq" } });
  fireEvent.click(within(sheet).getByRole("button", { name: "엿보기 시작" }));
  await screen.findByText(/받고 있어요/);
  expect(invoke).toHaveBeenLastCalledWith("sns_peek_start", expect.objectContaining({ confirmedName: "orders-dlq" }));
});

test("엿보기 시작 중에는 다시 판정과 멈추기가 꺼진 이유를 알려요", async () => {
  mockBackend([dlq]);
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) =>
    cmd === "sns_peek_start" ? new Promise<string>(() => {}) : base(cmd, args as never),
  );
  renderWithClient(<Peek target={snsTarget} />);
  fireEvent.click(await screen.findByRole("button", { name: "DLQ 엿보기…" }));
  fireEvent.click(screen.getByRole("button", { name: "엿보기 시작" }));
  const stop = await screen.findByRole("button", { name: "멈추기" });
  expect(stop).toBeDisabled();
  expect(stop).toHaveAttribute("title", "엿보기를 시작하고 있어요");
  expect(screen.getByRole("button", { name: "다시 판정" })).toHaveAttribute("title", "엿보기가 진행 중이에요");
});

test("화면을 떠나면 세션을 멈춰 메시지를 돌려놓아요", async () => {
  mockBackend([dlq]);
  const { unmount } = renderWithClient(<Peek target={snsTarget} />);
  fireEvent.click(await screen.findByRole("button", { name: "DLQ 엿보기…" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "엿보기 시작" })));
  unmount();
  expect(invoke).toHaveBeenCalledWith("sns_peek_stop", { session: "s1" });
  expect(unlisten).toHaveBeenCalled();
});

test("시작 응답 전에 화면을 떠나도 나중에 온 세션을 멈춰요", async () => {
  mockBackend([dlq]);
  let resolveStart: (id: string) => void = () => {};
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) =>
    cmd === "sns_peek_start" ? new Promise<string>((r) => (resolveStart = r)) : base(cmd, args as never),
  );
  const { unmount } = renderWithClient(<Peek target={snsTarget} />);
  fireEvent.click(await screen.findByRole("button", { name: "DLQ 엿보기…" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "엿보기 시작" })));
  unmount();
  expect(invoke).not.toHaveBeenCalledWith("sns_peek_stop", expect.anything());
  await act(async () => resolveStart("late"));
  expect(invoke).toHaveBeenCalledWith("sns_peek_stop", { session: "late" });
});
