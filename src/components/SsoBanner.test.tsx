import { fireEvent, render, screen, within } from "@testing-library/react";
import type { SsoEntry } from "../lib/useSsoLogin";
import { SsoBanner } from "./SsoBanner";

const RUNNING = "prod: SSO 로그인 중이에요. 브라우저에서 승인해 주세요";
const FAILED = "dev: SSO 로그인에 실패했어요: aws CLI를 찾을 수 없어요";
const NO_CREDENTIALS = "로그인했는데도 자격 증명을 받지 못했어요. 프로필 설정을 확인해 주세요";

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

test("all lines live in one polite region that reads out only the line that was added", () => {
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
  // role=status는 aria-atomic이 true라서, 그대로 두면 줄이 들어올 때마다 다른 줄과 버튼까지 통째로 다시 읽는다
  expect(region).toHaveAttribute("aria-atomic", "false");
  expect(within(region).getByText(RUNNING)).toBeInTheDocument();
  expect(within(region).getByText(FAILED)).toBeInTheDocument();
  // 안쪽에 alert(assertive)를 또 두면 같은 글을 두 번 읽는다
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

describe("a line is a new node when its status changes", () => {
  const running: SsoEntry = { key: "session:a", profile: "prod", target: "prod", status: { kind: "running" } };
  const failed: SsoEntry = { key: "session:a", profile: "prod", target: "prod", status: { kind: "failed", message: "x" } };
  const other: SsoEntry = { key: "session:b", profile: "dev", target: "dev", status: { kind: "failed", message: "y" } };
  const banner = (entries: SsoEntry[]) => <SsoBanner entries={entries} onCancel={() => {}} onRetry={() => {}} onDismiss={() => {}} />;

  test("a focused cancel button does not turn into the retry button", () => {
    const { rerender } = render(banner([running]));
    const cancel = screen.getByRole("button", { name: "취소" });
    cancel.focus();
    expect(cancel).toHaveFocus();

    rerender(banner([failed]));
    const retry = screen.getByRole("button", { name: "다시 로그인" });
    expect(retry).not.toBe(cancel); // 같은 노드를 재사용하면 [취소]에서 Enter를 누르던 사용자가 [다시 로그인]을 누르게 된다
    expect(cancel).not.toBeInTheDocument();
    expect(retry).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "닫기" })).not.toHaveFocus();
  });

  test("a change in another line leaves this line's buttons and focus alone", () => {
    const { rerender } = render(banner([running]));
    const cancel = screen.getByRole("button", { name: "취소" });
    cancel.focus();

    rerender(banner([{ ...running }, other]));
    expect(screen.getByRole("button", { name: "취소" })).toBe(cancel);
    expect(cancel).toHaveFocus();
  });
});

test("a failure right after a successful login says the credentials are still missing", () => {
  const onRetry = vi.fn();
  render(
    <SsoBanner
      entries={[{ key: "session:a", profile: "prod", target: "prod", status: { kind: "failed", message: NO_CREDENTIALS, afterSuccess: true } }]}
      onCancel={() => {}}
      onRetry={onRetry}
      onDismiss={() => {}}
    />,
  );
  // 로그인은 성공했는데 "로그인에 실패했어요"로 시작하면 틀린 말이다
  expect(screen.getByText(`prod: ${NO_CREDENTIALS}`)).toBeInTheDocument();
  expect(screen.queryByText(/SSO 로그인에 실패했어요/)).not.toBeInTheDocument();
  const retry = screen.getByRole("button", { name: "다시 로그인" });
  expect(retry).toHaveAccessibleDescription(`prod: ${NO_CREDENTIALS}`);
  expect(screen.getByRole("button", { name: "닫기" })).toHaveAccessibleDescription(`prod: ${NO_CREDENTIALS}`);
  fireEvent.click(retry);
  expect(onRetry).toHaveBeenCalledWith("prod");
});

test("the flag, not the wording, picks the after-login text; an ordinary failure keeps its prefix", () => {
  render(
    <SsoBanner
      entries={[{ key: "session:a", profile: "prod", target: "prod", status: { kind: "failed", message: NO_CREDENTIALS } }]}
      onCancel={() => {}}
      onRetry={() => {}}
      onDismiss={() => {}}
    />,
  );
  expect(screen.getByText(`prod: SSO 로그인에 실패했어요: ${NO_CREDENTIALS}`)).toBeInTheDocument();
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
