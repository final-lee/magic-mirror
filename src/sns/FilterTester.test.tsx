import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi, test, expect } from "vitest";
import { snsApi } from "./api";
import { FilterTester } from "./FilterTester";
import { sampleTopic } from "./fixtures";

vi.mock("./api", () => ({ snsApi: { filterTest: vi.fn() } }));

test("표본을 시험하고 구독별 판정과 오류를 보여 준다", async () => {
  const topic = sampleTopic();
  vi.mocked(snsApi.filterTest).mockResolvedValue(topic.subscriptions.map((s, i) => ({ key: s.key, verdict: i === 2 ? null : { matched: i !== 0, key: i === 0 ? "event_type" : null, reason: i === 0 ? "값이 달라요" : null }, errors: i === 2 ? [{ path: "detail", message: "잘못된 정책" }] : [], summary: null })));
  render(<FilterTester topic={topic} tabId="filter-test" />);
  fireEvent.change(screen.getByLabelText("속성 이름 1"), { target: { value: "event_type" } });
  fireEvent.change(screen.getByLabelText("속성 값 1"), { target: { value: "paid" } });
  fireEvent.click(screen.getByRole("button", { name: "시험" }));
  await screen.findByText("걸러짐");
  expect(screen.getByText("event_type: 값이 달라요")).toBeTruthy();
  expect(screen.getByText("detail: 잘못된 정책")).toBeTruthy();
  expect(screen.getAllByText("필터 없음(받음)").length).toBeGreaterThan(0);
  expect(snsApi.filterTest).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ attributes: [{ name: "event_type", dataType: "String", value: "paid" }] }));
  fireEvent.click(screen.getByLabelText("본문 JSON"));
  await waitFor(() => expect(screen.getByLabelText("본문 JSON 입력").tagName).toBe("TEXTAREA"));
});
