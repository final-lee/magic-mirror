import { useQuery } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ErrorState } from "./ErrorState";
import { api } from "../api/client";
import { reportSsoExpired } from "../api/invoke";
import { SsoLoginContext, useSsoLogin, type SsoLogin } from "../lib/useSsoLogin";
import { renderWithClient } from "../test/utils";

vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));

// 앞선 테스트가 api.ssoLogin을 부른 기록이 "관리자를 거치면 api.ssoLogin을 직접 부르지 않는다" 검사에 새지 않게 한다.
beforeEach(() => vi.clearAllMocks());

function manager(over: Partial<SsoLogin> = {}): SsoLogin {
  return {
    entries: [],
    statusFor: () => null,
    lastSuccessAt: () => null,
    start: vi.fn(async () => true),
    cancel: vi.fn(),
    dismiss: vi.fn(),
    rearm: vi.fn(),
    ...over,
  };
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

test("inside the app the login button goes through the manager, and a later success reloads once", async () => {
  const sso = manager();
  const onRetry = vi.fn();
  const view = render(
    <SsoLoginContext.Provider value={sso}>
      <ErrorState error={{ kind: "ssoExpired" }} profile="prod" onRetry={onRetry} />
    </SsoLoginContext.Provider>,
  );
  // 클릭 뒤에 이어지는 비동기 작업까지 끝낸 다음에 본다
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
  });
  expect(sso.start).toHaveBeenCalledWith("prod", { manual: true });
  expect(api.ssoLogin).not.toHaveBeenCalled();
  expect(onRetry).not.toHaveBeenCalled();
  // 관리자가 성공을 알리면(성공 시각이 바뀌면) 한 번만 다시 불러온다
  const later = Date.now() + 1000;
  const succeeded = { ...sso, lastSuccessAt: () => later };
  view.rerender(
    <SsoLoginContext.Provider value={succeeded}>
      <ErrorState error={{ kind: "ssoExpired" }} profile="prod" onRetry={onRetry} />
    </SsoLoginContext.Provider>,
  );
  view.rerender(
    <SsoLoginContext.Provider value={{ ...succeeded }}>
      <ErrorState error={{ kind: "ssoExpired" }} profile="prod" onRetry={onRetry} />
    </SsoLoginContext.Provider>,
  );
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test("a success from before the box appeared does not reload it", () => {
  const onRetry = vi.fn();
  render(
    <SsoLoginContext.Provider value={manager({ lastSuccessAt: () => Date.now() - 60_000 })}>
      <ErrorState error={{ kind: "ssoExpired" }} profile="prod" onRetry={onRetry} />
    </SsoLoginContext.Provider>,
  );
  expect(onRetry).not.toHaveBeenCalled();
});

test("a manual start that does not log in does not reload and calls nothing else", async () => {
  const sso = manager({ start: vi.fn(async () => false) });
  const onRetry = vi.fn();
  render(
    <SsoLoginContext.Provider value={sso}>
      <ErrorState error={{ kind: "ssoExpired" }} profile="prod" onRetry={onRetry} />
    </SsoLoginContext.Provider>,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
  });
  expect(sso.start).toHaveBeenCalledTimes(1);
  expect(onRetry).not.toHaveBeenCalled();
  expect(api.ssoLogin).not.toHaveBeenCalled();
});

// 무효화는 켜진 쿼리만 다시 부른다. 사용자가 누를 때만 도는 쿼리(enabled: false)는 ErrorState의 onRetry로 다시 불러야 화면이 풀린다.
describe("with the real manager and a query that only runs on demand", () => {
  const PROFILES = [{ name: "prod", region: null, ssoLogin: "prod", ssoKey: "session:prod" }];

  function OnDemand({ queryFn }: { queryFn: () => Promise<string> }) {
    const sso = useSsoLogin(PROFILES, "prod");
    const q = useQuery({ queryKey: ["iam", "prod", "lastAccessed"], queryFn, enabled: false, retry: false });
    return (
      <SsoLoginContext.Provider value={sso}>
        <button onClick={() => void q.refetch()}>불러오기</button>
        {q.isError && <ErrorState error={q.error} profile="prod" onRetry={() => void q.refetch()} />}
        {q.data && <p>{q.data}</p>}
      </SsoLoginContext.Provider>
    );
  }

  test("a manual login that succeeds loads the data and clears the error box", async () => {
    vi.mocked(api.ssoLogin).mockResolvedValue(undefined);
    const queryFn = vi.fn<() => Promise<string>>().mockRejectedValueOnce({ kind: "ssoExpired" }).mockResolvedValue("마지막 사용 시각");
    renderWithClient(<OnDemand queryFn={queryFn} />);
    fireEvent.click(screen.getByRole("button", { name: "불러오기" }));
    fireEvent.click(await screen.findByRole("button", { name: "로그인" }));
    expect(await screen.findByText("마지막 사용 시각")).toBeInTheDocument();
    expect(screen.queryByText(/SSO 세션이 만료됐어요/)).not.toBeInTheDocument();
    expect(api.ssoLogin).toHaveBeenCalledTimes(1);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  test("an automatic login started elsewhere also reloads the on-demand query", async () => {
    vi.mocked(api.ssoLogin).mockResolvedValue(undefined);
    const queryFn = vi.fn<() => Promise<string>>().mockRejectedValueOnce({ kind: "ssoExpired" }).mockResolvedValue("마지막 사용 시각");
    renderWithClient(<OnDemand queryFn={queryFn} />);
    fireEvent.click(screen.getByRole("button", { name: "불러오기" }));
    await screen.findByRole("button", { name: "로그인" });
    // 다른 화면의 명령이 만료로 실패해 자동 로그인이 열린 경우
    act(() => reportSsoExpired("prod"));
    expect(await screen.findByText("마지막 사용 시각")).toBeInTheDocument();
    expect(api.ssoLogin).toHaveBeenCalledTimes(1);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  test("a login that fails leaves the error box and does not load again", async () => {
    vi.mocked(api.ssoLogin).mockRejectedValue({ kind: "other", message: "로그인을 취소했어요" });
    const queryFn = vi.fn<() => Promise<string>>().mockRejectedValue({ kind: "ssoExpired" });
    renderWithClient(<OnDemand queryFn={queryFn} />);
    fireEvent.click(screen.getByRole("button", { name: "불러오기" }));
    const login = await screen.findByRole("button", { name: "로그인" });
    // 클릭 뒤에 이어지는 비동기 작업(로그인 실패 처리)까지 끝낸 다음에 본다
    await act(async () => {
      fireEvent.click(login);
    });
    expect(api.ssoLogin).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/SSO 세션이 만료됐어요/)).toBeInTheDocument();
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
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
