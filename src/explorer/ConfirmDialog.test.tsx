import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "./ConfirmDialog";

test("shows details capped at 10 and returns the clicked action", () => {
  const onResult = vi.fn();
  const details = Array.from({ length: 13 }, (_, i) => `file${i}.txt`);
  render(
    <ConfirmDialog
      title="덮어쓸까요?"
      message="같은 이름의 파일이 있어요"
      details={details}
      actions={[
        { label: "모두 덮어쓰기", value: "overwrite", danger: true },
        { label: "충돌 건너뛰기", value: "skip", primary: true },
      ]}
      onResult={onResult}
    />,
  );
  expect(screen.getByText("file9.txt")).toBeInTheDocument();
  expect(screen.queryByText("file10.txt")).not.toBeInTheDocument();
  expect(screen.getByText("외 3개")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "충돌 건너뛰기" }));
  expect(onResult).toHaveBeenCalledWith("skip", "");
});

test("input mode passes text; Escape and 취소 cancel", () => {
  const onResult = vi.fn();
  render(
    <ConfirmDialog
      title="새 폴더"
      input={{ label: "폴더 이름", initial: "" }}
      error="이름을 입력하세요"
      actions={[{ label: "만들기", value: "ok", primary: true }]}
      onResult={onResult}
    />,
  );
  expect(screen.getByText("이름을 입력하세요")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("폴더 이름"), { target: { value: "reports" } });
  fireEvent.keyDown(screen.getByLabelText("폴더 이름"), { key: "Enter" });
  expect(onResult).toHaveBeenLastCalledWith("ok", "reports");
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(onResult).toHaveBeenLastCalledWith(null, "reports");
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(onResult).toHaveBeenLastCalledWith(null, "reports");
});

test("without input, cancel is focused (not danger) and Escape works via real focus", async () => {
  const onResult = vi.fn();
  render(
    <ConfirmDialog
      title="삭제할까요?"
      details={["a", "a"]}
      actions={[{ label: "삭제", value: "delete", danger: true }]}
      onResult={onResult}
    />,
  );
  expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  expect(screen.getByRole("button", { name: "삭제" })).not.toHaveFocus();
  expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  expect(onResult).toHaveBeenCalledWith(null, "");
  // Tab stays inside the dialog
  await userEvent.tab();
  expect(screen.getByRole("button", { name: "삭제" })).toHaveFocus();
  await userEvent.tab();
  expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();
});

test("Enter in input never falls back to a danger action", () => {
  const onResult = vi.fn();
  render(
    <ConfirmDialog
      title="이름"
      input={{ label: "파일 이름", initial: "x" }}
      actions={[{ label: "삭제", value: "delete", danger: true }]}
      onResult={onResult}
    />,
  );
  fireEvent.keyDown(screen.getByLabelText("파일 이름"), { key: "Enter" });
  expect(onResult).not.toHaveBeenCalled();
});
