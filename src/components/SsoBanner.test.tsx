import { fireEvent, render, screen } from "@testing-library/react";
import { SsoBanner } from "./SsoBanner";

test("running and failed logins get their own lines and actions", () => {
  const onCancel = vi.fn();
  const onRetry = vi.fn();
  const onDismiss = vi.fn();
  render(
    <SsoBanner
      entries={[
        { key: "session:a", profile: "prod", target: "prod", status: { kind: "running" } },
        { key: "session:b", profile: "dev", target: "dev", status: { kind: "failed", message: "aws CLI를 찾을 수 없어요" } },
        { key: "session:c", profile: "old", target: "old", status: { kind: "cancelled" } },
      ]}
      onCancel={onCancel}
      onRetry={onRetry}
      onDismiss={onDismiss}
    />,
  );
  expect(screen.getByText("prod: SSO 로그인 중이에요. 브라우저에서 승인해 주세요")).toBeInTheDocument();
  expect(screen.getByText("dev: SSO 로그인에 실패했어요: aws CLI를 찾을 수 없어요")).toBeInTheDocument();
  expect(screen.queryByText(/old/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  fireEvent.click(screen.getByRole("button", { name: "다시 로그인" }));
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(onCancel).toHaveBeenCalledWith("session:a");
  expect(onRetry).toHaveBeenCalledWith("dev");
  expect(onDismiss).toHaveBeenCalledWith("session:b");
});

test("nothing to show renders nothing", () => {
  const { container } = render(<SsoBanner entries={[]} onCancel={() => {}} onRetry={() => {}} onDismiss={() => {}} />);
  expect(container).toBeEmptyDOMElement();
});
