import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { snsApi } from "./api";
import { QUEUE_ARN, QUEUE_URL, TOPIC_ARN, snsTarget } from "./fixtures";
import { snsKeys } from "./queries";
import { SnsChangeDialog } from "./SnsChangeDialog";
import type { SnsApplyResult, SnsChangeRequest, SnsPlan } from "./types";

vi.mock("./api", () => ({ snsApi: { plan: vi.fn(), apply: vi.fn(), undoPlan: vi.fn() } }));
const m = vi.mocked(snsApi);

const request: SnsChangeRequest = { kind: "queuePolicy", topicArn: TOPIC_ARN, queueUrl: QUEUE_URL, queueArn: QUEUE_ARN };
const call = { api: "sqs:SetQueueAttributes", target: QUEUE_URL, body: { Policy: "{}" } };
const plan = (over: Partial<SnsPlan> = {}): SnsPlan => ({
  request,
  topicArn: TOPIC_ARN,
  calls: [call],
  fields: [
    { field: "Policy", before: null, after: null, diff: '--- before\n+++ after\n@@\n {\n+  "Sid": "magic-mirror-sns-orders"\n-  "Old": 1\n }' },
    { field: "RedrivePolicy", before: null, after: { deadLetterTargetArn: "arn:dlq" }, diff: null },
  ],
  impact: [{ subscription: "orders-queue.fifo", check: "큐 정책", before: "✗ 실패", after: "✓ 정상" }],
  warnings: ["큐 정책을 고쳐요"],
  confirm: null,
  fingerprint: "fp1",
  undoOf: null,
  ...over,
});
const ok: SnsApplyResult = { callsRun: [call], error: null, recordId: "rec-1" };

function setup(props: Partial<Parameters<typeof SnsChangeDialog>[0]> = {}) {
  const onClose = vi.fn();
  const utils = renderWithClient(<SnsChangeDialog profile={snsTarget.profile} region={snsTarget.region} request={request} onClose={onClose} {...props} />);
  return { onClose, ...utils };
}
const applyButton = () => screen.getByRole("button", { name: /^(적용|되돌리기)$/ });

beforeEach(() => {
  vi.clearAllMocks();
  m.plan.mockResolvedValue(plan());
});

test("plans on open and shows calls, field changes with a line diff, impact rows and warnings", async () => {
  setup();
  expect(screen.getByRole("status")).toHaveTextContent("미리보기를 만드는 중이에요");
  const dialog = await screen.findByRole("dialog", { name: "큐 정책 고치기" });
  expect(m.plan).toHaveBeenCalledWith("personal", "ap-northeast-2", request);
  const calls = within(within(dialog).getByRole("list", { name: "호출할 API" }));
  expect(calls.getByText("sqs:SetQueueAttributes")).toBeInTheDocument();
  expect(calls.getByText(QUEUE_URL)).toBeInTheDocument();
  expect(calls.getByText(/"Policy": "\{\}"/)).toBeInTheDocument();
  const diff = within(dialog).getByLabelText("줄 차이");
  expect([...diff.querySelectorAll(".sns-diff-add")].map((n) => n.textContent)).toEqual(['+  "Sid": "magic-mirror-sns-orders"']);
  expect([...diff.querySelectorAll(".sns-diff-del")].map((n) => n.textContent)).toEqual(['-  "Old": 1']);
  const fields = within(within(dialog).getByRole("list", { name: "바뀌는 값" }));
  expect(fields.getByText("RedrivePolicy")).toBeInTheDocument();
  expect(fields.getByText("없음")).toBeInTheDocument();
  expect(fields.getByText(/deadLetterTargetArn/)).toBeInTheDocument();
  const impact = within(within(dialog).getByRole("list", { name: "진단에 생기는 변화" }));
  expect(impact.getByText("✗ 실패")).toBeInTheDocument();
  expect(impact.getByText("✓ 정상")).toBeInTheDocument();
  expect(within(dialog).getByText("큐 정책을 고쳐요")).toBeInTheDocument();
});

test("the final button is blue, [취소] is ghost, and focus starts on cancel", async () => {
  setup();
  await screen.findByRole("dialog");
  expect(applyButton()).toHaveClass("tone-primary");
  expect(screen.getByRole("button", { name: "취소" })).toHaveClass("tone-ghost");
  expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();
});

test("a typed confirmation phrase gates the final button until it matches exactly", async () => {
  m.plan.mockResolvedValue(plan({ confirm: "prod-orders" }));
  m.apply.mockResolvedValue(ok);
  setup();
  await screen.findByRole("dialog");
  const input = screen.getByLabelText(/확인하려면 prod-orders/);
  expect(applyButton()).toBeDisabled();
  fireEvent.change(input, { target: { value: "prod-order" } });
  expect(applyButton()).toBeDisabled();
  fireEvent.change(input, { target: { value: "prod-orders " } });
  expect(applyButton()).toBeDisabled();
  expect(screen.getByText("입력한 이름이 달라요")).toBeInTheDocument();
  fireEvent.change(input, { target: { value: "prod-orders" } });
  expect(applyButton()).toBeEnabled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(m.apply).not.toHaveBeenCalled();
  fireEvent.click(applyButton());
  await screen.findByText("적용했어요");
  expect(m.apply).toHaveBeenCalledWith("personal", "ap-northeast-2", expect.objectContaining({ fingerprint: "fp1", confirm: "prod-orders" }));
});

test("the result lists the calls that ran, invalidates the topic queries and reports onApplied", async () => {
  m.apply.mockResolvedValue(ok);
  const onApplied = vi.fn();
  const { qc, onClose } = setup({ onApplied });
  const spy = vi.spyOn(qc, "invalidateQueries");
  await screen.findByRole("dialog");
  fireEvent.click(applyButton());
  const result = await screen.findByTestId("sns-result");
  expect(within(result).getByText("적용했어요")).toBeInTheDocument();
  expect(within(result).getByText("sqs:SetQueueAttributes")).toBeInTheDocument();
  expect(within(result).getByText("변경 기록에 남겼어요")).toBeInTheDocument();
  expect(onApplied).toHaveBeenCalledWith(ok);
  const keys = spy.mock.calls.map(([filter]) => (filter as { queryKey: unknown }).queryKey);
  expect(keys).toEqual(expect.arrayContaining([snsKeys.topic("personal", "ap-northeast-2", TOPIC_ARN), snsKeys.diagnosis("personal", "ap-northeast-2", TOPIC_ARN)]));
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(onClose).toHaveBeenCalled();
});

test("a failure after some calls ran shows both the calls and the error", async () => {
  m.apply.mockResolvedValue({ callsRun: [call], error: "권한 없음 (lambda:AddPermission)", recordId: "rec-2" });
  setup();
  await screen.findByRole("dialog");
  fireEvent.click(applyButton());
  const result = await screen.findByTestId("sns-result");
  expect(within(result).getByText("일부만 적용했어요")).toBeInTheDocument();
  expect(within(result).getByRole("alert")).toHaveTextContent("권한 없음 (lambda:AddPermission)");
  expect(within(result).getByText("sqs:SetQueueAttributes")).toBeInTheDocument();
});

test("a failure before any call ran says nothing was applied", async () => {
  m.apply.mockResolvedValue({ callsRun: [], error: "큐가 없어요", recordId: null });
  setup();
  await screen.findByRole("dialog");
  fireEvent.click(applyButton());
  const result = await screen.findByTestId("sns-result");
  expect(within(result).getByText("적용하지 못했어요", { selector: "h3" })).toBeInTheDocument();
  expect(within(result).getByText("실행한 호출이 없어요")).toBeInTheDocument();
});

test("a stale plan shows a notice, plans again and asks for the confirmation again", async () => {
  m.plan.mockResolvedValueOnce(plan({ confirm: "prod-orders", fingerprint: "old" })).mockResolvedValueOnce(plan({ confirm: "prod-orders", fingerprint: "new" }));
  m.apply.mockRejectedValueOnce({ kind: "stalePlan" });
  setup();
  await screen.findByRole("dialog");
  fireEvent.change(screen.getByLabelText(/확인하려면/), { target: { value: "prod-orders" } });
  fireEvent.click(applyButton());
  await waitFor(() => expect(m.plan).toHaveBeenCalledTimes(2));
  expect(await screen.findByText(/상태가 바뀌어서 미리보기를 다시 만들었어요/)).toBeInTheDocument();
  expect(screen.getByLabelText(/확인하려면/)).toHaveValue("");
  expect(applyButton()).toBeDisabled();
  m.apply.mockResolvedValueOnce(ok);
  fireEvent.change(screen.getByLabelText(/확인하려면/), { target: { value: "prod-orders" } });
  fireEvent.click(applyButton());
  await screen.findByText("적용했어요");
  expect(m.apply).toHaveBeenLastCalledWith("personal", "ap-northeast-2", expect.objectContaining({ fingerprint: "new" }));
});

test("a plain apply rejection keeps the preview and shows the error", async () => {
  m.apply.mockRejectedValue({ kind: "other", message: "서버가 거절했어요" });
  setup();
  await screen.findByRole("dialog");
  fireEvent.click(applyButton());
  expect(await screen.findByRole("alert")).toHaveTextContent("서버가 거절했어요");
  expect(m.plan).toHaveBeenCalledTimes(1);
  expect(applyButton()).toBeEnabled();
});

test("an expired SSO session while planning shows the login state and keeps the final button off", async () => {
  m.plan.mockRejectedValueOnce({ kind: "ssoExpired" });
  setup();
  expect(await screen.findByText(/SSO 세션이 만료됐어요/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "로그인" })).toBeInTheDocument();
  expect(applyButton()).toBeDisabled();
});

test("another plan error offers a retry", async () => {
  m.plan.mockRejectedValueOnce({ kind: "other", message: "읽지 못했어요" }).mockResolvedValueOnce(plan());
  setup();
  expect(await screen.findByText("읽지 못했어요")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(applyButton()).toBeEnabled());
  expect(m.plan).toHaveBeenCalledTimes(2);
});

test("an undo request plans through undoPlan and the final button is caution orange", async () => {
  m.undoPlan.mockResolvedValue(plan({ undoOf: "rec-1" }));
  m.apply.mockResolvedValue(ok);
  setup({ request: { kind: "undo", id: "rec-1" } });
  const dialog = await screen.findByRole("dialog", { name: "되돌리기 미리보기" });
  expect(m.undoPlan).toHaveBeenCalledWith("personal", "ap-northeast-2", "rec-1");
  expect(m.plan).not.toHaveBeenCalled();
  expect(within(dialog).getByRole("button", { name: "되돌리기" })).toHaveClass("tone-caution");
  fireEvent.click(within(dialog).getByRole("button", { name: "되돌리기" }));
  await screen.findByText("되돌렸어요");
});

test("Esc cancels while the preview is open but not while applying", async () => {
  let release: (r: SnsApplyResult) => void = () => {};
  m.apply.mockReturnValue(new Promise<SnsApplyResult>((resolve) => (release = resolve)));
  const { onClose } = setup();
  await screen.findByRole("dialog");
  fireEvent.click(applyButton());
  await screen.findByRole("button", { name: "적용 중…" });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => release(ok));
  await screen.findByText("적용했어요");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});
