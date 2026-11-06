import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { desktop } from "../api/desktop";
import { snsApi } from "./api";
import { sampleTopic, snsTarget } from "./fixtures";
import { Diagnosis, diagnosisStatus } from "./Diagnosis";
import { Subscriptions } from "./Subscriptions";
import type { SnsCheck } from "./types";

vi.mock("./api", () => ({ snsApi: { diagnose: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(async () => {}) } }));

const fail: SnsCheck = { id: "queuePolicy", status: "fail", summary: "정책에 배달 권한이 없어요", detail: "권한을 확인하세요", fix: { kind: "queuePolicy", queueArn: "queue", queueUrl: "url", statement: { Effect: "Allow" } } };
const ok: SnsCheck = { id: "confirmed", status: "ok", summary: "구독이 확인됐어요", detail: null, fix: null };

test("진단을 구독별로 보여 주고 정책 문장을 복사해요", async () => {
  const topic = sampleTopic();
  vi.mocked(snsApi.diagnose).mockResolvedValue({ topicChecks: [ok], subscriptions: [{ subscription: topic.subscriptions[0].key, checks: [ok, fail], verdict: fail.summary }], failures: [], metrics: { failed: 1, filteredInvalidAttributes: 0, filteredInvalidBody: 0, redrivenToDlq: 0, delivered: 0, published: 1 } });
  renderWithClient(<Diagnosis topic={topic} target={snsTarget} />);
  const region = await screen.findByRole("region", { name: "배달 진단" });
  expect(within(region).getByText("주제 점검")).toBeInTheDocument();
  expect(within(region).getAllByText(fail.summary)).toHaveLength(2);
  fireEvent.click(within(region).getByText("자세히"));
  fireEvent.click(within(region).getByRole("button", { name: "복사" }));
  expect(desktop.copy).toHaveBeenCalledWith(JSON.stringify({ Effect: "Allow" }, null, 2));
  expect(await within(region).findByRole("button", { name: "복사했어요" })).toBeInTheDocument();
});

test("실패를 주의와 판단 불가보다 먼저 표시해요", () => {
  expect(diagnosisStatus([{ ...ok, status: "warn" }, fail])).toBe("fail");
  expect(diagnosisStatus([{ ...ok, status: "skip" }])).toBe("skip");
});

test("구독 표에 같은 진단의 배지를 표시해요", async () => {
  const topic = sampleTopic();
  vi.mocked(snsApi.diagnose).mockResolvedValue({ topicChecks: [], subscriptions: [{ subscription: topic.subscriptions[0].key, checks: [fail], verdict: fail.summary }], failures: [], metrics: { failed: 1, filteredInvalidAttributes: 0, filteredInvalidBody: 0, redrivenToDlq: 0, delivered: 0, published: 1 } });
  renderWithClient(<Subscriptions topic={topic} target={snsTarget} active onOpen={() => {}} />);
  expect(await screen.findByText("✗ 실패")).toHaveAttribute("title", fail.summary);
});
