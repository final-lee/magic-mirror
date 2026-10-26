import { fireEvent, render, screen } from "@testing-library/react";
import { TransferQueue } from "./TransferQueue";
import type { TransferItem } from "./useTransfers";

const item = (id: string, status: TransferItem["event"]["status"], extra: Partial<TransferItem["event"]> = {}): TransferItem => ({
  request: { id, direction: id === "d" ? "download" : "upload", localPath: `/l/${id}.txt`, bucket: "b", region: "r", key: `k/${id}.txt` },
  event: { id, status, transferred: 0, total: null, error: null, ...extra },
});

test("renders nothing when empty", () => {
  const { container } = render(<TransferQueue items={[]} onRetry={() => {}} onClear={() => {}} />);
  expect(container).toBeEmptyDOMElement();
});

test("shows statuses, progress, errors and actions", () => {
  const onRetry = vi.fn();
  const onClear = vi.fn();
  render(
    <TransferQueue
      items={[
        item("q", "queued"),
        item("d", "running", { transferred: 50, total: 200 }),
        item("ok", "done"),
        item("bad", "failed", { error: { kind: "accessDenied", action: "s3:PutObject" } }),
      ]}
      onRetry={onRetry}
      onClear={onClear}
    />,
  );
  expect(screen.getByText("대기")).toBeInTheDocument();
  expect(screen.getByText("25%")).toBeInTheDocument();
  expect(screen.getByText("완료")).toBeInTheDocument();
  expect(screen.getByText("권한 없음 (s3:PutObject)")).toBeInTheDocument();
  expect(screen.getByText(/전송 4개 · 진행 2 · 실패 1/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "재시도" }));
  expect(onRetry).toHaveBeenCalledWith("bad");
  fireEvent.click(screen.getByRole("button", { name: "완료 항목 지우기" }));
  expect(onClear).toHaveBeenCalled();
});
