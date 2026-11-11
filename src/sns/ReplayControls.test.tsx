import { fireEvent, render, screen } from "@testing-library/react";
import { ArchiveEditor, replayError, ReplayControls } from "./ReplayControls";
import { sampleTopic, snsTarget, sqsSubscription } from "./fixtures";
import { replayPollInterval } from "./queries";

vi.mock("./SnsChangeDialog", () => ({ SnsChangeDialog: ({ request }: { request: unknown }) => <div data-testid="request">{JSON.stringify(request)}</div> }));

test("replay validates archive bounds, ordering and future times", () => {
  const now = Date.parse("2026-10-05T00:00:00Z");
  const beginning = "2026-10-01T00:00:00Z";
  expect(replayError("2026-10-02T00:00:00Z", "2026-10-03T00:00:00Z", beginning, now)).toBeNull();
  expect(replayError("2026-09-30T00:00:00Z", "", beginning, now)).toMatch(/아카이브/);
  expect(replayError("2026-10-02T00:00:00Z", "2026-10-02T00:00:00Z", beginning, now)).toMatch(/끝 시각/);
  expect(replayError("2026-10-06T00:00:00Z", "", beginning, now)).toMatch(/미래/);
});

test("replay form sends local inputs as UTC and supports resuming", () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-06T00:00:00Z"));
  const sub = { ...sqsSubscription, attributes: { ...sqsSubscription.attributes, ReplayPolicy: '{"EndingPoint":"2026-10-03T00:00:00Z"}' } };
  render(<ReplayControls topic={sampleTopic()} sub={sub} target={snsTarget} />);
  fireEvent.click(screen.getByRole("button", { name: "다시 보내기…" }));
  expect(screen.getByRole("button", { name: "미리 보기…" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("시작 시각"), { target: { value: "2026-10-02T12:00" } });
  fireEvent.click(screen.getByRole("button", { name: "미리 보기…" }));
  expect(JSON.parse(screen.getByTestId("request").textContent!)).toMatchObject({ kind: "replay", start: new Date("2026-10-02T12:00").toISOString() });
  fireEvent.click(screen.getByRole("button", { name: "이어 받기" }));
  expect(JSON.parse(screen.getByTestId("request").textContent!)).toEqual({ kind: "replay", subscriptionArn: sub.arn, start: "2026-10-03T00:00:00Z" });
  vi.restoreAllMocks();
});

test("archive editor validates retention and previews disabling", () => {
  render(<ArchiveEditor topic={sampleTopic()} target={snsTarget} />);
  fireEvent.click(screen.getByRole("button", { name: "편집" }));
  expect(screen.getByRole("button", { name: "미리 보기…" })).toHaveClass("tone-warn");
  fireEvent.change(screen.getByLabelText("보존 기간 (1~365일)"), { target: { value: "366" } });
  expect(screen.getByRole("button", { name: "미리 보기…" })).toBeDisabled();
  fireEvent.click(screen.getByLabelText("아카이브 켜기"));
  expect(screen.getByText(/보관된 메시지가 모두 삭제/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "미리 보기…" })).toHaveClass("tone-danger");
  fireEvent.click(screen.getByRole("button", { name: "미리 보기…" }));
  expect(JSON.parse(screen.getByTestId("request").textContent!)).toEqual({ kind: "archivePolicy", topicArn: snsTarget.topicArn, retentionDays: null });
});

test("replay polling runs only while a subscription is pending or in progress", () => {
  const topic = sampleTopic();
  expect(replayPollInterval(topic)).toBe(false);
  const withStatus = (status: string) => ({ ...topic, subscriptions: [{ ...sqsSubscription, attributes: { ...sqsSubscription.attributes, ReplayStatus: status } }] });
  expect(replayPollInterval(withStatus("Pending"))).toBe(10_000);
  expect(replayPollInterval(withStatus("In progress"))).toBe(10_000);
  expect(replayPollInterval(withStatus("Completed"))).toBe(false);
});
