import { fireEvent, render, screen, within } from "@testing-library/react";
import { DoneNotice } from "./DoneNotice";

// IAM 탭과 PostgreSQL 탭이 함께 쓰는 완료 안내. 탭마다의 시험은 이 안내가 어느 때 뜨는지를 본다.

const plain = { summary: "변경 3개를 적용했어요", notes: [] as string[] };

describe("DoneNotice", () => {
  test("says the summary in a status region, with a check mark that screen readers skip", () => {
    render(<DoneNotice notice={plain} onDismiss={() => {}} />);
    const status = screen.getByRole("status");
    expect(status).toHaveClass("iam-done");
    expect(within(status).getByText("변경 3개를 적용했어요")).toBeInTheDocument();
    expect(within(status).getByText("✓")).toHaveAttribute("aria-hidden", "true");
  });

  test("has no hint unless the caller gives one", () => {
    render(<DoneNotice notice={plain} onDismiss={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^✓ 변경 3개를 적용했어요\s*✕$/);
  });

  test("shows the hint after the summary when the caller gives one", () => {
    render(<DoneNotice notice={plain} hint="반영까지 몇 초 걸릴 수 있어요" onDismiss={() => {}} />);
    const hint = screen.getByText("반영까지 몇 초 걸릴 수 있어요");
    expect(hint).toHaveClass("dim");
    expect(screen.getByRole("status")).toHaveTextContent("✓ 변경 3개를 적용했어요 반영까지 몇 초 걸릴 수 있어요");
  });

  test("the close button dismisses it", () => {
    const onDismiss = vi.fn();
    render(<DoneNotice notice={plain} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "알림 닫기" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("a notice without notes has no list of things to tell", () => {
    render(<DoneNotice notice={plain} onDismiss={() => {}} />);
    expect(screen.queryByRole("list", { name: "함께 알릴 일" })).not.toBeInTheDocument();
  });

  test("lists the notes, and the same note twice shows twice", () => {
    const notice = { summary: plain.summary, notes: ["되돌림 표시를 하지 못했어요", "되돌림 표시를 하지 못했어요", "변경 기록을 저장하지 못했어요"] };
    render(<DoneNotice notice={notice} onDismiss={() => {}} />);
    const items = within(screen.getByRole("list", { name: "함께 알릴 일" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(notice.notes);
  });
});
