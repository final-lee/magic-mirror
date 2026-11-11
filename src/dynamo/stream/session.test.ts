import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamApi } from "./api";
import { POLL_INTERVAL_MS, runSession } from "./session";
import type { StreamPoll, StreamRecord } from "./types";

vi.mock("./api", () => ({ streamApi: { start: vi.fn(), poll: vi.fn(), stop: vi.fn() } }));

const api = vi.mocked(streamApi);
const target = { profile: "personal", region: "ap-northeast-2", table: "orders", from: "LATEST" as const };

const record = (id: string): StreamRecord => ({ id, event: "INSERT", time: null, keys: null, size: null, oldImage: null, newImage: null });
const page = (...ids: string[]): StreamPoll => ({ records: ids.map(record), shards: 1, behind: 0 });

function handlers() {
  return { onPage: vi.fn(), onError: vi.fn() };
}

/** 열기·읽기 응답이 마이크로태스크로 처리되도록 시간을 흘린다 */
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  api.start.mockResolvedValue({ streamId: "s1" });
  api.stop.mockResolvedValue(undefined);
  api.poll.mockResolvedValue(page());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("읽기 세션", () => {
  it("세션을 열고 2초마다 읽어서 읽은 페이지를 넘긴다", async () => {
    const h = handlers();
    api.poll.mockResolvedValueOnce(page("a")).mockResolvedValueOnce(page("b", "c"));
    runSession(target, h);
    await tick(0);

    expect(api.start).toHaveBeenCalledWith("personal", "ap-northeast-2", "orders", "LATEST");
    expect(api.poll).not.toHaveBeenCalled();

    await tick(POLL_INTERVAL_MS);
    expect(api.poll).toHaveBeenCalledTimes(1);
    expect(api.poll).toHaveBeenCalledWith("s1");
    await tick(POLL_INTERVAL_MS);
    expect(api.poll).toHaveBeenCalledTimes(2);
    expect(h.onPage.mock.calls.map(([p]) => p.records.map((r: StreamRecord) => r.id))).toEqual([["a"], ["b", "c"]]);
  });

  it("앞의 읽기가 끝나기 전에는 다음 읽기를 시작하지 않는다", async () => {
    let finish: (p: StreamPoll) => void = () => {};
    api.poll.mockReturnValueOnce(new Promise<StreamPoll>((resolve) => (finish = resolve)));
    runSession(target, handlers());
    await tick(POLL_INTERVAL_MS);
    await tick(POLL_INTERVAL_MS * 3);

    expect(api.poll).toHaveBeenCalledTimes(1);
    finish(page());
    await tick(POLL_INTERVAL_MS);
    expect(api.poll).toHaveBeenCalledTimes(2);
  });

  it("멈추면 더 읽지 않고 세션을 지운다", async () => {
    const stop = runSession(target, handlers());
    await tick(POLL_INTERVAL_MS);
    expect(api.poll).toHaveBeenCalledTimes(1);

    stop();
    expect(api.stop.mock.calls).toEqual([["s1"]]);
    await tick(POLL_INTERVAL_MS * 5);
    expect(api.poll).toHaveBeenCalledTimes(1);
  });

  it("읽는 도중에 멈추면 그 읽기의 결과를 넘기지 않고, 다음 읽기도 하지 않는다", async () => {
    const h = handlers();
    let finish: (p: StreamPoll) => void = () => {};
    api.poll.mockReturnValueOnce(new Promise<StreamPoll>((resolve) => (finish = resolve)));
    const stop = runSession(target, h);
    await tick(POLL_INTERVAL_MS);

    stop();
    finish(page("late"));
    await tick(POLL_INTERVAL_MS * 3);
    expect(h.onPage).not.toHaveBeenCalled();
    expect(api.poll).toHaveBeenCalledTimes(1);
  });

  it("세션이 열리기 전에 멈추면 열리는 대로 지운다", async () => {
    let open: (v: { streamId: string }) => void = () => {};
    api.start.mockReturnValueOnce(new Promise((resolve) => (open = resolve)));
    const stop = runSession(target, handlers());

    stop();
    expect(api.stop).not.toHaveBeenCalled();
    open({ streamId: "late" });
    await tick(POLL_INTERVAL_MS * 2);
    expect(api.stop.mock.calls).toEqual([["late"]]);
    expect(api.poll).not.toHaveBeenCalled();
  });

  it("읽다가 실패하면 오류를 한 번 알리고 더 읽지 않는다", async () => {
    const h = handlers();
    api.poll.mockRejectedValueOnce({ kind: "other", message: "세션이 끝났어요" });
    runSession(target, h);
    await tick(POLL_INTERVAL_MS);
    await tick(POLL_INTERVAL_MS * 3);

    expect(h.onError.mock.calls).toEqual([[{ kind: "other", message: "세션이 끝났어요" }]]);
    expect(api.poll).toHaveBeenCalledTimes(1);
  });

  it("세션을 열지 못하면 오류를 알리고 읽지 않는다", async () => {
    const h = handlers();
    api.start.mockRejectedValueOnce({ kind: "other", message: "테이블 스트림이 켜져 있지 않아요" });
    runSession(target, h);
    await tick(POLL_INTERVAL_MS * 2);

    expect(h.onError).toHaveBeenCalledOnce();
    expect(api.poll).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
  });

  it("멈춘 뒤에 늦게 도착한 오류는 알리지 않는다", async () => {
    const h = handlers();
    let fail: (e: unknown) => void = () => {};
    api.poll.mockReturnValueOnce(new Promise<StreamPoll>((_, reject) => (fail = reject)));
    const stop = runSession(target, h);
    await tick(POLL_INTERVAL_MS);

    stop();
    fail({ kind: "other", message: "x" });
    await tick(0);
    expect(h.onError).not.toHaveBeenCalled();
  });
});
