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

test("sso expired logs in, then calls onLoggedIn and nothing else", async () => {
  vi.mocked(api.ssoLogin).mockResolvedValue(undefined);
  const onRetry = vi.fn();
  const onLoggedIn = vi.fn();
  render(<ErrorState error={{ kind: "ssoExpired" }} profile="prod" onRetry={onRetry} onLoggedIn={onLoggedIn} />);
  expect(screen.getByText(/SSO 세션이 만료됐어요/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "로그인" }));
  await waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
  expect(api.ssoLogin).toHaveBeenCalledWith("prod");
  expect(onRetry).not.toHaveBeenCalled();
});

test("without a login manager, a box without onLoggedIn reloads with onRetry after its login", async () => {
  vi.mocked(api.ssoLogin).mockResolvedValue(undefined);
  const onRetry = vi.fn();
  render(<ErrorState error={{ kind: "ssoExpired" }} profile="prod" onRetry={onRetry} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
  });
  expect(api.ssoLogin).toHaveBeenCalledWith("prod");
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test("sso login failure is shown", async () => {
  vi.mocked(api.ssoLogin).mockRejectedValue({ kind: "other", message: "aws CLI를 찾을 수 없어요" });
  render(<ErrorState error={{ kind: "ssoExpired" }} profile="prod" onRetry={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "로그인" }));
  expect(await screen.findByText("aws CLI를 찾을 수 없어요")).toBeInTheDocument();
});

/** 관리자를 거치는 상자. 관리자 객체를 바꿔 다시 그리면 로그인 성공 시각이 바뀐 것처럼 보인다. */
function boxIn(sso: SsoLogin, props: { onRetry?: () => void; onLoggedIn?: () => void; error?: unknown } = {}) {
  const { onRetry = () => {}, onLoggedIn, error = { kind: "ssoExpired" } } = props;
  return (
    <SsoLoginContext.Provider value={sso}>
      <ErrorState error={error} profile="prod" onRetry={onRetry} onLoggedIn={onLoggedIn} />
    </SsoLoginContext.Provider>
  );
}

test("inside the app the login button goes through the manager, and a later success calls onLoggedIn once", async () => {
  const sso = manager();
  const onRetry = vi.fn();
  const onLoggedIn = vi.fn();
  const view = render(boxIn(sso, { onRetry, onLoggedIn }));
  // 클릭 뒤에 이어지는 비동기 작업까지 끝낸 다음에 본다
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
  });
  expect(sso.start).toHaveBeenCalledWith("prod", { manual: true });
  expect(api.ssoLogin).not.toHaveBeenCalled();
  expect(onLoggedIn).not.toHaveBeenCalled();
  // 관리자가 성공을 알리면(성공 시각이 바뀌면) 한 번만 부른다
  const later = Date.now() + 1000;
  const succeeded = { ...sso, lastSuccessAt: () => later };
  view.rerender(boxIn(succeeded, { onRetry, onLoggedIn }));
  view.rerender(boxIn({ ...succeeded }, { onRetry, onLoggedIn }));
  expect(onLoggedIn).toHaveBeenCalledTimes(1);
  // 다시 불러오기는 onLoggedIn의 몫이다. 켜진 쿼리의 상자는 onRetry로 앱 전체를 새로 고치지 않는다
  expect(onRetry).not.toHaveBeenCalled();
});

test("a box without onLoggedIn does nothing when its session logs in", () => {
  const onRetry = vi.fn();
  const sso = manager();
  const view = render(boxIn(sso, { onRetry }));
  view.rerender(boxIn({ ...sso, lastSuccessAt: () => Date.now() + 1000 }, { onRetry }));
  expect(onRetry).not.toHaveBeenCalled();
});

test("one success calls onLoggedIn once, even when the error goes ssoExpired, network, ssoExpired", () => {
  const onLoggedIn = vi.fn();
  const sso = manager();
  const view = render(boxIn(sso, { onLoggedIn }));
  const later = Date.now() + 1000;
  const succeeded = { ...sso, lastSuccessAt: () => later };
  view.rerender(boxIn(succeeded, { onLoggedIn }));
  expect(onLoggedIn).toHaveBeenCalledTimes(1);
  // 다시 불러온 조회가 네트워크 오류로 끝났다가, 사용자가 [다시 시도]를 눌러 이번에는 다시 만료로 실패했다. 같은 성공으로 또 부르지 않는다
  view.rerender(boxIn(succeeded, { onLoggedIn, error: { kind: "network", message: "timeout" } }));
  view.rerender(boxIn(succeeded, { onLoggedIn }));
  expect(onLoggedIn).toHaveBeenCalledTimes(1);
});

test("a newer success calls onLoggedIn again", () => {
  const onLoggedIn = vi.fn();
  const sso = manager();
  const view = render(boxIn(sso, { onLoggedIn }));
  const first = Date.now() + 1000;
  view.rerender(boxIn({ ...sso, lastSuccessAt: () => first }, { onLoggedIn }));
  view.rerender(boxIn({ ...sso, lastSuccessAt: () => first + 5000 }, { onLoggedIn }));
  expect(onLoggedIn).toHaveBeenCalledTimes(2);
});

test("a success from before the box appeared does not call onLoggedIn", () => {
  const onLoggedIn = vi.fn();
  render(boxIn(manager({ lastSuccessAt: () => Date.now() - 60_000 }), { onLoggedIn }));
  expect(onLoggedIn).not.toHaveBeenCalled();
});

test("a manual start that does not log in calls neither onLoggedIn nor onRetry", async () => {
  const sso = manager({ start: vi.fn(async () => false) });
  const onRetry = vi.fn();
  const onLoggedIn = vi.fn();
  render(boxIn(sso, { onRetry, onLoggedIn }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
  });
  expect(sso.start).toHaveBeenCalledTimes(1);
  expect(onLoggedIn).not.toHaveBeenCalled();
  expect(onRetry).not.toHaveBeenCalled();
  expect(api.ssoLogin).not.toHaveBeenCalled();
});

const PROFILES = [{ name: "prod", region: null, ssoLogin: "prod", ssoKey: "session:prod" }];

// 무효화는 켜진 쿼리만 다시 부른다. 사용자가 누를 때만 도는 쿼리(enabled: false)는 그 상자가 onLoggedIn으로 자기 쿼리만 다시 불러야 화면이 풀린다.
describe("with the real manager and a query that only runs on demand", () => {
  function OnDemand({ queryFn, onRetry = () => {} }: { queryFn: () => Promise<string>; onRetry?: () => void }) {
    const sso = useSsoLogin(PROFILES, "prod");
    const q = useQuery({ queryKey: ["iam", "prod", "lastAccessed"], queryFn, enabled: false, retry: false });
    return (
      <SsoLoginContext.Provider value={sso}>
        <button onClick={() => void q.refetch()}>불러오기</button>
        {q.isError && <ErrorState error={q.error} profile="prod" onRetry={onRetry} onLoggedIn={() => void q.refetch()} />}
        {q.data && <p>{q.data}</p>}
      </SsoLoginContext.Provider>
    );
  }

  test("a manual login that succeeds loads the data and clears the error box", async () => {
    vi.mocked(api.ssoLogin).mockResolvedValue(undefined);
    const queryFn = vi.fn<() => Promise<string>>().mockRejectedValueOnce({ kind: "ssoExpired" }).mockResolvedValue("마지막 사용 시각");
    const onRetry = vi.fn();
    renderWithClient(<OnDemand queryFn={queryFn} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "불러오기" }));
    fireEvent.click(await screen.findByRole("button", { name: "로그인" }));
    expect(await screen.findByText("마지막 사용 시각")).toBeInTheDocument();
    expect(screen.queryByText(/SSO 세션이 만료됐어요/)).not.toBeInTheDocument();
    expect(api.ssoLogin).toHaveBeenCalledTimes(1);
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(onRetry).not.toHaveBeenCalled();
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

// 켜진 쿼리는 관리자가 무효화해서 다시 부른다. 그 상자는 따로 다시 부르지 않는다: 상자마다 onRetry(앱 전체 새로 고침)를 부르면
// 같은 로그인 하나에 같은 일이 상자 수만큼 겹친다.
describe("with the real manager and a query that is enabled", () => {
  function Enabled({ queryFn, onRetry }: { queryFn: () => Promise<string>; onRetry: () => void }) {
    const sso = useSsoLogin(PROFILES, "prod");
    const q = useQuery({ queryKey: ["resources", "prod", "ec2", "instances"], queryFn, retry: false });
    return (
      <SsoLoginContext.Provider value={sso}>
        {q.isError && <ErrorState error={q.error} profile="prod" onRetry={onRetry} />}
        {q.data && <p>{q.data}</p>}
      </SsoLoginContext.Provider>
    );
  }

  test("a login reloads it through the manager's invalidation, and the box never calls onRetry", async () => {
    vi.mocked(api.ssoLogin).mockResolvedValue(undefined);
    const queryFn = vi.fn<() => Promise<string>>().mockRejectedValueOnce({ kind: "ssoExpired" }).mockResolvedValue("인스턴스 목록");
    const onRetry = vi.fn();
    renderWithClient(<Enabled queryFn={queryFn} onRetry={onRetry} />);
    fireEvent.click(await screen.findByRole("button", { name: "로그인" }));
    expect(await screen.findByText("인스턴스 목록")).toBeInTheDocument();
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(onRetry).not.toHaveBeenCalled();
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
