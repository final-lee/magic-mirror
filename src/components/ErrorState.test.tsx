import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ErrorState } from "./ErrorState";
import { api } from "../api/client";

vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

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
