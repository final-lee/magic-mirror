import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ErrorState } from "./ErrorState";
import { api } from "../api/client";
import { SsoLoginContext, type SsoLogin } from "../lib/useSsoLogin";

vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

// 앞선 테스트가 api.ssoLogin을 부른 기록이 "관리자를 거치면 api.ssoLogin을 직접 부르지 않는다" 검사에 새지 않게 한다.
beforeEach(() => vi.clearAllMocks());

function manager(over: Partial<SsoLogin> = {}): SsoLogin {
  return { entries: [], statusFor: () => null, start: vi.fn(async () => true), cancel: vi.fn(), dismiss: vi.fn(), rearm: vi.fn(), ...over };
}

test("access denied shows action and no retry button", () => {
  render(<ErrorState error={{ kind: "accessDenied", action: "ec2:DescribeInstances" }} profile="p" onRetry={() => {}} />);
  expect(screen.getByText("권한 없음 (ec2:DescribeInstances)")).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("network error offers retry", () => {
  const onRetry = vi.fn();
  render(<ErrorState error={{ kind: "network", message: "timeout" }} profile="p" onRetry={onRetry} />);
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(onRetry).toHaveBeenCalled();
});

test("sso expired logs in then retries", async () => {
  vi.mocked(api.ssoLogin).mockResolvedValue(undefined);
  const onRetry = vi.fn();
  render(<ErrorState error={{ kind: "ssoExpired" }} profile="prod" onRetry={onRetry} />);
  expect(screen.getByText(/SSO 세션이 만료됐어요/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "로그인" }));
  await waitFor(() => expect(onRetry).toHaveBeenCalled());
  expect(api.ssoLogin).toHaveBeenCalledWith("prod");
});

test("sso login failure is shown", async () => {
  vi.mocked(api.ssoLogin).mockRejectedValue({ kind: "other", message: "aws CLI를 찾을 수 없어요" });
  render(<ErrorState error={{ kind: "ssoExpired" }} profile="prod" onRetry={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "로그인" }));
  expect(await screen.findByText("aws CLI를 찾을 수 없어요")).toBeInTheDocument();
});

test("inside the app the login button goes through the manager", async () => {
  const sso = manager();
  const onRetry = vi.fn();
  render(
    <SsoLoginContext.Provider value={sso}>
      <ErrorState error={{ kind: "ssoExpired" }} profile="prod" onRetry={onRetry} />
    </SsoLoginContext.Provider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "로그인" }));
  await waitFor(() => expect(onRetry).toHaveBeenCalled());
  expect(sso.start).toHaveBeenCalledWith("prod", { manual: true });
  expect(api.ssoLogin).not.toHaveBeenCalled();
});

test("a running login shows the busy button", () => {
  const sso = manager({ statusFor: () => ({ kind: "running" }) });
  render(
    <SsoLoginContext.Provider value={sso}>
      <ErrorState error={{ kind: "ssoExpired" }} profile="prod" onRetry={() => {}} />
    </SsoLoginContext.Provider>,
  );
  expect(screen.getByRole("button", { name: "브라우저에서 로그인을 완료하세요…" })).toBeDisabled();
});
