import { fireEvent, render, screen, within } from "@testing-library/react";
import { SsoBanner } from "./SsoBanner";

const RUNNING = "prod: SSO 로그인 중이에요. 브라우저에서 승인해 주세요";
const FAILED = "dev: SSO 로그인에 실패했어요: aws CLI를 찾을 수 없어요";

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
  expect(screen.getByText(RUNNING)).toBeInTheDocument();
  expect(screen.getByText(FAILED)).toBeInTheDocument();
  expect(screen.queryByText(/old/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  fireEvent.click(screen.getByRole("button", { name: "다시 로그인" }));
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(onCancel).toHaveBeenCalledWith("session:a");
  expect(onRetry).toHaveBeenCalledWith("dev");
  expect(onDismiss).toHaveBeenCalledWith("session:b");
});

test("nothing to show leaves an empty live region mounted", () => {
  render(<SsoBanner entries={[]} onCancel={() => {}} onRetry={() => {}} onDismiss={() => {}} />);
  // 줄이 없어도 컨테이너는 늘 떠 있어야 나중에 들어오는 줄을 화면 낭독기가 읽는다
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});

test("a cancelled login shows no line", () => {
  render(
    <SsoBanner
      entries={[{ key: "session:c", profile: "old", target: "old", status: { kind: "cancelled" } }]}
      onCancel={() => {}}
      onRetry={() => {}}
      onDismiss={() => {}}
    />,
  );
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});

test("the lines live in one status region and a failed line is an alert", () => {
  render(
    <SsoBanner
      entries={[
        { key: "session:a", profile: "prod", target: "prod", status: { kind: "running" } },
        { key: "session:b", profile: "dev", target: "dev", status: { kind: "failed", message: "aws CLI를 찾을 수 없어요" } },
      ]}
      onCancel={() => {}}
      onRetry={() => {}}
      onDismiss={() => {}}
    />,
  );
  const region = screen.getByRole("status");
  expect(within(region).getByText(RUNNING)).toBeInTheDocument();
  expect(within(region).getByText(FAILED)).toBeInTheDocument();
  const alerts = screen.getAllByRole("alert");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toHaveTextContent(FAILED);
  expect(alerts[0]).not.toHaveTextContent(RUNNING);
});

test("two lines get same-named buttons that each describe their own line", () => {
  render(
    <SsoBanner
      entries={[
        { key: "session:a", profile: "prod", target: "prod", status: { kind: "failed", message: "x" } },
        { key: "session:b", profile: "dev", target: "dev", status: { kind: "failed", message: "y" } },
      ]}
      onCancel={() => {}}
      onRetry={() => {}}
      onDismiss={() => {}}
    />,
  );
  for (const name of ["다시 로그인", "닫기"]) {
    const buttons = screen.getAllByRole("button", { name });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAccessibleDescription("prod: SSO 로그인에 실패했어요: x");
    expect(buttons[1]).toHaveAccessibleDescription("dev: SSO 로그인에 실패했어요: y");
  }
});

test("the cancel button describes the running line", () => {
  render(
    <SsoBanner
      entries={[{ key: "session:a", profile: "prod", target: "prod", status: { kind: "running" } }]}
      onCancel={() => {}}
      onRetry={() => {}}
      onDismiss={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: "취소" })).toHaveAccessibleDescription(RUNNING);
});
