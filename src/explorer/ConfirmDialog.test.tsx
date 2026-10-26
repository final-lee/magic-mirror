import { fireEvent, render, screen } from "@testing-library/react";
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
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(onResult).toHaveBeenLastCalledWith(null, "reports");
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(onResult).toHaveBeenLastCalledWith(null, "reports");
});
