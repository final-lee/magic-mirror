import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamApi } from "./api";
import { POLL_INTERVAL_MS } from "./session";
import type { StreamPoll, StreamRecord } from "./types";
import { useStreamSession } from "./useStreamSession";

vi.mock("./api", () => ({ streamApi: { start: vi.fn(), poll: vi.fn(), stop: vi.fn() } }));

const api = vi.mocked(streamApi);

const record = (id: string): StreamRecord => ({ id, event: "INSERT", time: null, keys: null, size: null, oldImage: null, newImage: null });
const page = (...ids: string[]): StreamPoll => ({ records: ids.map(record), shards: 2, behind: 1 });

type Target = { profile: string; region: string; table: string; active: boolean };
const base: Target = { profile: "personal", region: "ap-northeast-2", table: "orders", active: true };

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  let opened = 0;
  api.start.mockImplementation(async () => ({ streamId: `s${++opened}` }));
  api.stop.mockResolvedValue(undefined);
  api.poll.mockResolvedValue(page());
});

afterEach(() => {
  vi.useRealTimers();
});

async function startedSession(target: Target = base) {
  const hook = renderHook((props: Target) => useStreamSession(props), { initialProps: target });
  act(() => hook.result.current.start("LATEST"));
  await tick(0);
  return hook;
}

describe("useStreamSession", () => {
  it("시작하기 전에는 아무것도 열지 않는다", async () => {
    const hook = renderHook((props: Target) => useStreamSession(props), { initialProps: base });
    await tick(POLL_INTERVAL_MS * 3);

    expect(hook.result.current.running).toBe(false);
    expect(api.start).not.toHaveBeenCalled();
  });

  it("시작하면 읽은 레코드를 모으고 읽는 샤드 수를 알린다", async () => {
    api.poll.mockResolvedValueOnce(page("a")).mockResolvedValueOnce(page("b"));
    const hook = await startedSession();
    await tick(POLL_INTERVAL_MS * 2);

    expect(hook.result.current.running).toBe(true);
    expect(hook.result.current.records.map((r) => r.id)).toEqual(["a", "b"]);
    expect(hook.result.current).toMatchObject({ shards: 2, behind: 1 });
  });

  it("멈추면 세션을 지운다", async () => {
    const hook = await startedSession();
    act(() => hook.result.current.stop());

    expect(hook.result.current.running).toBe(false);
    expect(api.stop.mock.calls).toEqual([["s1"]]);
  });

  it("탭이 숨으면 세션을 지우고 멈춘 채로 둔다", async () => {
    api.poll.mockResolvedValue(page("a"));
    const hook = await startedSession();
    await tick(POLL_INTERVAL_MS);
    expect(hook.result.current.records).toHaveLength(1);

    hook.rerender({ ...base, active: false });
    await tick(POLL_INTERVAL_MS * 3);
    expect(api.stop.mock.calls).toEqual([["s1"]]);
    expect(hook.result.current.running).toBe(false);
    expect(hook.result.current.records).toEqual([]);
    expect(api.poll).toHaveBeenCalledTimes(1);

    // 다시 보여도 저절로 시작하지 않는다
    hook.rerender({ ...base, active: true });
    await tick(POLL_INTERVAL_MS * 3);
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it("테이블이 바뀌면 세션을 지우고 레코드를 비운다", async () => {
    api.poll.mockResolvedValue(page("a"));
    const hook = await startedSession();
    await tick(POLL_INTERVAL_MS);

    hook.rerender({ ...base, table: "users" });
    await tick(POLL_INTERVAL_MS * 3);
    expect(api.stop.mock.calls).toEqual([["s1"]]);
    expect(hook.result.current.running).toBe(false);
    expect(hook.result.current.records).toEqual([]);
  });

  it("화면이 사라지면 세션을 지운다", async () => {
    const hook = await startedSession();
    hook.unmount();

    expect(api.stop.mock.calls).toEqual([["s1"]]);
  });

  it("읽다가 실패하면 멈추고 오류를 남기며, 다시 시작하면 오류와 레코드를 비운다", async () => {
    api.poll.mockResolvedValueOnce(page("a")).mockRejectedValueOnce({ kind: "other", message: "세션이 끝났어요" });
    const hook = await startedSession();
    await tick(POLL_INTERVAL_MS * 2);

    expect(hook.result.current.running).toBe(false);
    expect(hook.result.current.error).toEqual({ kind: "other", message: "세션이 끝났어요" });
    expect(api.stop.mock.calls).toEqual([["s1"]]);

    act(() => hook.result.current.start("TRIM_HORIZON"));
    await tick(0);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.records).toEqual([]);
    expect(api.start).toHaveBeenLastCalledWith("personal", "ap-northeast-2", "orders", "TRIM_HORIZON");
  });

  it("레코드는 가장 최근 2,000개만 모은다", async () => {
    const burst = (from: number) => ({ ...page(), records: Array.from({ length: 1500 }, (_, i) => record(String(from + i))) });
    api.poll.mockResolvedValueOnce(burst(0)).mockResolvedValueOnce(burst(1500));
    const hook = await startedSession();
    await tick(POLL_INTERVAL_MS * 2);

    const ids = hook.result.current.records.map((r) => r.id);
    expect(ids).toHaveLength(2000);
    expect(ids[0]).toBe("1000");
    expect(ids[1999]).toBe("2999");
  });
});
