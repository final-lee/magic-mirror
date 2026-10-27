import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import { api } from "../api/client";
import { invoke, reportSsoExpired } from "../api/invoke";
import type { ProfileInfo } from "../api/types";
import { useSsoLogin } from "./useSsoLogin";

vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn(), ssoLoginCancel: vi.fn() } }));
// 쿼리 안에서는 실제 invoke 래퍼를 쓰고, 그 아래의 Tauri 호출만 가짜로 둔다
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const m = vi.mocked(api);
const raw = vi.mocked(tauriInvoke);

const PROFILES: ProfileInfo[] = [
  { name: "base", region: null, ssoLogin: "base", ssoKey: "session:corp" },
  { name: "admin", region: null, ssoLogin: "base", ssoKey: "session:corp" },
  { name: "other", region: null, ssoLogin: "other", ssoKey: "session:other" },
  { name: "keys", region: null, ssoLogin: null, ssoKey: null },
];

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-27T09:00:00Z");
const NO_CREDENTIALS = "로그인했는데도 자격 증명을 받지 못했어요. 프로필 설정을 확인해 주세요";
/** 로그인에 성공한 지 5분 안에 또 만료를 알렸을 때 생기는 실패. 배너가 일반 실패와 다른 문구로 보여 주도록 afterSuccess가 붙는다. */
const FAILED_AFTER_LOGIN = { kind: "failed", message: NO_CREDENTIALS, afterSuccess: true };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** current는 App이 지금 보여 주는 프로필이다. hook.rerender({ current })로 프로필을 바꾼다. */
function setup(current: string | null = "admin") {
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const hook = renderHook(({ current }) => useSsoLogin(PROFILES, current), { wrapper, initialProps: { current } });
  return { hook, qc };
}

/** 'admin'이 만료를 알려 로그인이 T0에 성공한 상태로 만든다. */
async function loggedInAtT0() {
  m.ssoLogin.mockResolvedValue(undefined);
  const ctx = setup();
  act(() => reportSsoExpired("admin"));
  await waitFor(() => expect(ctx.hook.result.current.entries).toEqual([]));
  expect(m.ssoLogin).toHaveBeenCalledTimes(1);
  return ctx;
}

// 시각만 가짜로 둬서(waitFor의 타이머는 그대로) "로그인한 지 얼마나 됐나"를 정확히 다룬다.
// 목은 테스트마다 비워서 앞 테스트의 구현이 새지 않게 한다.
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

test("an expiry report starts one login per SSO session", async () => {
  const d = deferred();
  m.ssoLogin.mockReturnValue(d.promise);
  const { hook } = setup();
  act(() => {
    reportSsoExpired("admin");
    reportSsoExpired("base");
    reportSsoExpired("admin");
  });
  expect(m.ssoLogin).toHaveBeenCalledTimes(1);
  expect(m.ssoLogin).toHaveBeenCalledWith("base");
  expect(hook.result.current.entries).toEqual([{ key: "session:corp", profile: "admin", target: "base", status: { kind: "running" } }]);
  await act(async () => d.resolve());
});

test("success clears the entry and reloads the profile-scoped queries of every profile in the session", async () => {
  m.ssoLogin.mockResolvedValue(undefined);
  const { hook, qc } = setup();
  const reloaded = [
    ["resources", "base", "global", "iam", "users"],
    ["account", "admin"],
    ["s3", "base", "bucket", ""],
    ["diff", "admin", "left", "right"],
    ["vpc-topology", "base", "us-east-1", "vpc-1"],
    ["iam", "admin", "overview"],
  ];
  const untouched = [
    ["account", "keys"], // 이 세션에 속하지 않는 프로필
    ["resources", "other", "global", "iam", "users"], // 다른 세션의 프로필
    ["iam", "other", "overview"],
    ["settings"],
    ["profiles"],
    ["services"],
    ["localHome"],
    ["local", "base"], // 로컬 경로가 우연히 프로필 이름과 같아도 건드리지 않는다
  ];
  for (const key of [...reloaded, ...untouched]) qc.setQueryData(key, "cached");
  act(() => reportSsoExpired("admin"));
  await waitFor(() => expect(hook.result.current.entries).toEqual([]));
  expect(reloaded.map((k) => [k.join("/"), qc.getQueryState(k)?.isInvalidated])).toEqual(reloaded.map((k) => [k.join("/"), true]));
  expect(untouched.map((k) => [k.join("/"), qc.getQueryState(k)?.isInvalidated])).toEqual(untouched.map((k) => [k.join("/"), false]));
  // 같은 세션의 프로필은 성공 시각을 함께 본다(화면이 이 값을 보고 다시 불러온다)
  expect(hook.result.current.lastSuccessAt("admin")).toEqual(expect.any(Number));
  expect(hook.result.current.lastSuccessAt("base")).toBe(hook.result.current.lastSuccessAt("admin"));
  expect(hook.result.current.lastSuccessAt("keys")).toBeNull();
});

test("a failure is not retried automatically, but re-selecting the profile or a manual start retries", async () => {
  m.ssoLogin.mockRejectedValueOnce({ kind: "other", message: "aws CLI를 찾을 수 없어요" });
  const { hook } = setup();
  act(() => reportSsoExpired("base"));
  await waitFor(() => expect(hook.result.current.statusFor("base")).toEqual({ kind: "failed", message: "aws CLI를 찾을 수 없어요" }));
  act(() => reportSsoExpired("base"));
  expect(m.ssoLogin).toHaveBeenCalledTimes(1);

  m.ssoLogin.mockResolvedValue(undefined);
  act(() => hook.result.current.rearm("admin"));
  expect(hook.result.current.statusFor("base")).toBeNull();
  act(() => reportSsoExpired("base"));
  expect(m.ssoLogin).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(hook.result.current.entries).toEqual([]));

  // 로그인에 성공한 지 한참 지난 뒤의 만료는 새 만료다(바로 이어진 보고는 아래 테스트들이 다룬다)
  vi.setSystemTime(T0 + 6 * MINUTE);
  m.ssoLogin.mockRejectedValueOnce({ kind: "other", message: "x" });
  act(() => reportSsoExpired("base"));
  await waitFor(() => expect(hook.result.current.statusFor("base")?.kind).toBe("failed"));
  let ok = true;
  await act(async () => {
    ok = await hook.result.current.start("base", { manual: true });
  });
  expect(m.ssoLogin).toHaveBeenCalledTimes(4);
  expect(ok).toBe(true);
});

test("cancel stops the login and keeps it from reopening", async () => {
  const d = deferred();
  m.ssoLogin.mockReturnValue(d.promise);
  m.ssoLoginCancel.mockResolvedValue(undefined);
  const { hook } = setup();
  act(() => reportSsoExpired("admin"));
  act(() => hook.result.current.cancel("session:corp"));
  expect(m.ssoLoginCancel).toHaveBeenCalledWith("base");
  await act(async () => d.reject({ kind: "other", message: "로그인을 취소했어요" }));
  expect(hook.result.current.statusFor("admin")).toEqual({ kind: "cancelled" });
  act(() => reportSsoExpired("admin"));
  expect(m.ssoLogin).toHaveBeenCalledTimes(1);
});

test("dismissing a failure keeps it closed", async () => {
  m.ssoLogin.mockRejectedValueOnce({ kind: "other", message: "x" });
  const { hook } = setup();
  act(() => reportSsoExpired("base"));
  await waitFor(() => expect(hook.result.current.statusFor("base")?.kind).toBe("failed"));
  act(() => hook.result.current.dismiss("session:corp"));
  expect(hook.result.current.statusFor("base")).toEqual({ kind: "cancelled" });
  act(() => reportSsoExpired("base"));
  expect(m.ssoLogin).toHaveBeenCalledTimes(1);
});

// 현재 프로필이 "keys"여야 현재 세션 검사(키 비교)를 통과한다. 다른 프로필이 현재면 그 검사가 먼저 막아서 이 규칙은 시험되지 않는다.
test("a non-SSO profile never logs in automatically, even when it is the current profile", () => {
  const { hook } = setup("keys");
  act(() => reportSsoExpired("keys"));
  expect(m.ssoLogin).not.toHaveBeenCalled();
  expect(hook.result.current.entries).toEqual([]);
});

test("a manual start joins the running login", async () => {
  const d = deferred();
  m.ssoLogin.mockReturnValue(d.promise);
  const { hook } = setup();
  act(() => reportSsoExpired("admin"));
  let joined: Promise<boolean> = Promise.resolve(false);
  act(() => {
    joined = hook.result.current.start("base", { manual: true });
  });
  expect(m.ssoLogin).toHaveBeenCalledTimes(1);
  await act(async () => d.resolve());
  await expect(joined).resolves.toBe(true);
});

describe("right after a successful login", () => {
  test("a report from a call that started before the login finished is ignored", async () => {
    const d = deferred();
    m.ssoLogin.mockReturnValue(d.promise);
    const { hook } = setup();
    const calledAt = Date.now(); // 이 호출은 로그인이 끝나기 전에 시작했다
    act(() => reportSsoExpired("admin", calledAt));
    vi.setSystemTime(T0 + 10_000);
    await act(async () => d.resolve()); // 로그인 성공
    expect(hook.result.current.entries).toEqual([]);

    act(() => reportSsoExpired("base", calledAt)); // 그 호출의 실패가 뒤늦게 도착한다
    expect(m.ssoLogin).toHaveBeenCalledTimes(1);
    expect(hook.result.current.entries).toEqual([]); // 실패 줄도 만들지 않는다
  });

  test("a call that started in the very instant the login finished counts as fresh", async () => {
    const { hook } = await loggedInAtT0();
    act(() => reportSsoExpired("admin", T0)); // 성공을 알린 직후 무효화로 다시 부른 조회가 같은 ms에 시작할 수 있다
    expect(m.ssoLogin).toHaveBeenCalledTimes(1);
    expect(hook.result.current.statusFor("admin")).toEqual(FAILED_AFTER_LOGIN);
  });

  test("a fresh report within 5 minutes becomes a failure and does not open another login", async () => {
    const { hook } = await loggedInAtT0();
    vi.setSystemTime(T0 + 5 * MINUTE - 1);
    act(() => reportSsoExpired("admin")); // 로그인이 끝난 뒤에 시작한 호출이 또 만료로 실패했다
    expect(m.ssoLogin).toHaveBeenCalledTimes(1);
    expect(hook.result.current.entries).toEqual([
      { key: "session:corp", profile: "admin", target: "base", status: FAILED_AFTER_LOGIN },
    ]);
    // 실패 줄이 있는 동안에는 더 알려도 그대로다
    act(() => reportSsoExpired("base"));
    expect(m.ssoLogin).toHaveBeenCalledTimes(1);
  });

  test("after 5 minutes a report opens a login again", async () => {
    const { hook } = await loggedInAtT0();
    vi.setSystemTime(T0 + 5 * MINUTE);
    act(() => reportSsoExpired("admin"));
    expect(m.ssoLogin).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(hook.result.current.entries).toEqual([]));
  });

  test("a manual start inside the window still logs in", async () => {
    const { hook } = await loggedInAtT0();
    vi.setSystemTime(T0 + MINUTE);
    act(() => reportSsoExpired("admin"));
    expect(hook.result.current.statusFor("admin")?.kind).toBe("failed");
    let ok = false;
    await act(async () => {
      ok = await hook.result.current.start("admin", { manual: true });
    });
    expect(ok).toBe(true);
    expect(m.ssoLogin).toHaveBeenCalledTimes(2);
    expect(m.ssoLogin).toHaveBeenLastCalledWith("base");
    expect(hook.result.current.entries).toEqual([]);
  });

  test("a manual retry that fails afterwards shows the ordinary failure, not the credentials hint", async () => {
    const { hook } = await loggedInAtT0();
    vi.setSystemTime(T0 + MINUTE);
    act(() => reportSsoExpired("admin"));
    expect(hook.result.current.statusFor("admin")).toEqual(FAILED_AFTER_LOGIN);
    m.ssoLogin.mockRejectedValueOnce({ kind: "other", message: "aws CLI를 찾을 수 없어요" });
    await act(async () => {
      await hook.result.current.start("admin", { manual: true });
    });
    const status = hook.result.current.statusFor("admin");
    expect(status).toEqual({ kind: "failed", message: "aws CLI를 찾을 수 없어요" });
    expect(status).not.toHaveProperty("afterSuccess");
  });

  test("re-selecting the profile clears the failure line but not the window", async () => {
    const { hook } = await loggedInAtT0();
    vi.setSystemTime(T0 + MINUTE);
    act(() => reportSsoExpired("admin"));
    expect(hook.result.current.statusFor("admin")?.kind).toBe("failed");
    act(() => hook.result.current.rearm("admin"));
    expect(hook.result.current.statusFor("admin")).toBeNull();
    act(() => reportSsoExpired("admin"));
    expect(m.ssoLogin).toHaveBeenCalledTimes(1);
    expect(hook.result.current.statusFor("admin")).toEqual(FAILED_AFTER_LOGIN);
  });
});

describe("only the current profile's session logs in automatically", () => {
  test("a late report for a session we left does nothing, the current session still logs in", () => {
    m.ssoLogin.mockReturnValue(deferred().promise);
    const { hook } = setup("admin");
    hook.rerender({ current: "other" }); // 사용자가 다른 세션의 프로필로 바꿨다
    act(() => reportSsoExpired("admin")); // 아직 돌던 이전 프로필의 호출이 뒤늦게 실패한다
    expect(m.ssoLogin).not.toHaveBeenCalled();
    expect(hook.result.current.entries).toEqual([]);
    act(() => reportSsoExpired("other"));
    expect(m.ssoLogin).toHaveBeenCalledTimes(1);
    expect(m.ssoLogin).toHaveBeenCalledWith("other");
  });

  test("another profile of the current session counts as the current session", () => {
    m.ssoLogin.mockReturnValue(deferred().promise);
    setup("admin");
    act(() => reportSsoExpired("base"));
    expect(m.ssoLogin).toHaveBeenCalledWith("base");
  });

  test("with no profile selected nothing logs in automatically", () => {
    setup(null);
    act(() => reportSsoExpired("admin"));
    expect(m.ssoLogin).not.toHaveBeenCalled();
  });

  test("a manual start works for any profile", async () => {
    m.ssoLogin.mockResolvedValue(undefined);
    const { hook } = setup("other");
    let ok = false;
    await act(async () => {
      ok = await hook.result.current.start("admin", { manual: true });
    });
    expect(ok).toBe(true);
    expect(m.ssoLogin).toHaveBeenCalledWith("base");
  });
});

test("re-selecting a profile while its login is running keeps the line, and cancel still works", async () => {
  const d = deferred();
  m.ssoLogin.mockReturnValue(d.promise);
  m.ssoLoginCancel.mockResolvedValue(undefined);
  const { hook } = setup();
  act(() => reportSsoExpired("admin"));
  act(() => hook.result.current.rearm("base")); // 같은 세션의 다른 프로필을 고른다
  expect(hook.result.current.entries).toEqual([{ key: "session:corp", profile: "admin", target: "base", status: { kind: "running" } }]);
  act(() => hook.result.current.cancel("session:corp"));
  expect(m.ssoLoginCancel).toHaveBeenCalledWith("base");
  await act(async () => d.reject({ kind: "other", message: "로그인을 취소했어요" }));
  expect(hook.result.current.statusFor("admin")).toEqual({ kind: "cancelled" });
});

test("different SSO sessions log in at the same time and finish independently", async () => {
  const corp = deferred();
  const other = deferred();
  m.ssoLogin.mockImplementation((target: string) => (target === "base" ? corp.promise : other.promise));
  m.ssoLoginCancel.mockResolvedValue(undefined);
  const { hook } = setup("admin");
  act(() => reportSsoExpired("admin"));
  hook.rerender({ current: "other" });
  act(() => reportSsoExpired("other"));
  expect(m.ssoLogin.mock.calls).toEqual([["base"], ["other"]]);
  const lines = () => hook.result.current.entries.map((e) => [e.key, e.status.kind]);
  expect(lines()).toEqual([
    ["session:corp", "running"],
    ["session:other", "running"],
  ]);

  await act(async () => other.resolve()); // 한쪽이 끝나도 다른 쪽은 그대로다
  expect(lines()).toEqual([["session:corp", "running"]]);

  act(() => hook.result.current.cancel("session:corp")); // 취소도 그 세션만 멈춘다
  expect(m.ssoLoginCancel).toHaveBeenCalledTimes(1);
  expect(m.ssoLoginCancel).toHaveBeenCalledWith("base");
  await act(async () => corp.reject({ kind: "other", message: "로그인을 취소했어요" }));
  expect(hook.result.current.statusFor("admin")).toEqual({ kind: "cancelled" });
  expect(hook.result.current.statusFor("other")).toBeNull();
});

describe("a fetch that is still running when the login succeeds", () => {
  const key = ["resources", "base", "ec2", "instances"];
  const watch = (qc: QueryClient, enabled = true) =>
    new QueryObserver(qc, { queryKey: key, queryFn: () => invoke<string>("list_resources", { profile: "base" }), retry: false, enabled });

  test("starts over after the login instead of ending in the expired-session error", async () => {
    const login = deferred();
    m.ssoLogin.mockReturnValue(login.promise);
    const first = deferred<string>();
    raw.mockReturnValueOnce(first.promise); // 로그인 전에 시작한 첫 조회. 아직 돌고 있다
    raw.mockResolvedValue("fresh");
    const { hook, qc } = setup();
    const observer = watch(qc);
    const stop = observer.subscribe(() => {});
    expect(raw).toHaveBeenCalledTimes(1);

    act(() => reportSsoExpired("admin")); // 다른 호출의 만료 보고로 로그인이 열린다
    vi.setSystemTime(T0 + 10_000);
    await act(async () => login.resolve()); // 로그인 성공. 첫 조회는 이 순간에도 돌고 있다

    // 무효화만으로는 돌던 첫 조회가 그대로 이어진다. 취소해야 로그인 뒤에 새로 시작한다
    await waitFor(() => expect(raw).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(observer.getCurrentResult().data).toBe("fresh"));

    // 취소된 첫 조회는 옛 세션으로 뒤늦게 실패한다
    await act(async () => first.reject({ kind: "ssoExpired" }));
    expect(observer.getCurrentResult()).toMatchObject({ status: "success", data: "fresh", isError: false });
    expect(m.ssoLogin).toHaveBeenCalledTimes(1); // 그 보고는 낡은 것이라 로그인을 또 열지 않고
    expect(hook.result.current.entries).toEqual([]); // 실패 줄도 만들지 않는다
    stop();
  });

  test("a fetch of another SSO session keeps running", async () => {
    const login = deferred();
    m.ssoLogin.mockReturnValue(login.promise);
    const otherFetch = deferred<string>();
    raw.mockReturnValueOnce(otherFetch.promise);
    const { hook, qc } = setup();
    const observer = new QueryObserver(qc, {
      queryKey: ["resources", "other", "ec2", "instances"], // corp 세션이 아니라 other 세션의 프로필
      queryFn: () => invoke<string>("list_resources", { profile: "other" }),
      retry: false,
    });
    const stop = observer.subscribe(() => {});
    act(() => reportSsoExpired("admin"));
    await act(async () => login.resolve());
    await waitFor(() => expect(hook.result.current.entries).toEqual([]));

    // 무효화하지 않는 쿼리를 취소하면 아무도 다시 시작하지 않아, 그 화면은 멈춘 채로 남는다
    expect(observer.getCurrentResult().fetchStatus).toBe("fetching");
    expect(raw).toHaveBeenCalledTimes(1);
    await act(async () => otherFetch.resolve("other-data"));
    expect(observer.getCurrentResult().data).toBe("other-data");
    expect(raw).toHaveBeenCalledTimes(1);
    stop();
  });

  test("an on-demand fetch (enabled: false) keeps running, since nothing would start it again", async () => {
    const login = deferred();
    m.ssoLogin.mockReturnValue(login.promise);
    const running = deferred<string>();
    raw.mockReturnValueOnce(running.promise);
    const { hook, qc } = setup();
    const observer = watch(qc, false); // 마지막 사용 시각처럼 사용자가 누를 때만 도는 쿼리
    const stop = observer.subscribe(() => {});
    void observer.refetch();
    expect(raw).toHaveBeenCalledTimes(1);
    act(() => reportSsoExpired("admin"));
    await act(async () => login.resolve());
    await waitFor(() => expect(hook.result.current.entries).toEqual([]));

    // 무효화는 꺼진 쿼리를 다시 부르지 않는다. 취소하면 화면은 버튼만 남고, 10~30초 걸리던 조회는 사라진다
    expect(observer.getCurrentResult().fetchStatus).toBe("fetching");
    await act(async () => running.resolve("loaded"));
    expect(observer.getCurrentResult().data).toBe("loaded");
    expect(raw).toHaveBeenCalledTimes(1);
    stop();
  });

  test("a fetch that finished before the login is left alone", async () => {
    m.ssoLogin.mockResolvedValue(undefined);
    raw.mockResolvedValue("cached");
    const { hook, qc } = setup();
    const stop = watch(qc).subscribe(() => {});
    await waitFor(() => expect(qc.getQueryData(key)).toBe("cached"));
    act(() => reportSsoExpired("admin"));
    await waitFor(() => expect(hook.result.current.entries).toEqual([]));
    // 끝난 조회는 취소할 것이 없다. 무효화로 한 번 다시 부를 뿐이다
    await waitFor(() => expect(raw).toHaveBeenCalledTimes(2));
    expect(qc.getQueryData(key)).toBe("cached");
    stop();
  });
});
