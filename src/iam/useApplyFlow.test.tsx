import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { iamApi } from "./api";
import { sampleOverview } from "./fixtures";
import { iamKeys, useIamOverview } from "./queries";
import { NOTICE_MS, REFRESH_DELAY_MS, useApplyNotices, useIamRefresh, usePendingFlow } from "./useApplyFlow";

// 두 흐름(useIamChange, useIamBatch)이 함께 쓰는 조각을 직접 본다. 두 흐름의 테스트는 같은 규칙을 각자의 쪽에서 본다.
vi.mock("./api", () => ({ iamApi: { overview: vi.fn() } }));

const m = vi.mocked(iamApi);

beforeEach(() => {
  vi.clearAllMocks();
  m.overview.mockResolvedValue(sampleOverview());
});
afterEach(() => vi.useRealTimers());

function clientWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, wrapper };
}

describe("useApplyNotices", () => {
  const setup = () => renderHook(() => useApplyNotices());
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  test("an announcement carries its summary and notes", () => {
    const h = setup();
    act(() => h.result.current.announce("변경을 적용했어요", ["변경 기록을 저장하지 못했어요"]));
    expect(h.result.current.notices).toEqual([{ id: expect.any(Number), summary: "변경을 적용했어요", notes: ["변경 기록을 저장하지 못했어요"] }]);
  });

  test("a plain notice fades after NOTICE_MS, not before", async () => {
    vi.useFakeTimers();
    const h = setup();
    act(() => h.result.current.announce("A", []));
    await advance(NOTICE_MS - 100);
    expect(h.result.current.notices.map((n) => n.summary)).toEqual(["A"]);
    await advance(200);
    expect(h.result.current.notices).toEqual([]);
  });

  test("a notice with notes stays until it is dismissed, and a later plain notice does not replace it", async () => {
    vi.useFakeTimers();
    const h = setup();
    act(() => h.result.current.announce("A", ["하지 못한 일"]));
    act(() => h.result.current.announce("B", []));
    expect(h.result.current.notices.map((n) => n.summary)).toEqual(["A", "B"]);
    await advance(NOTICE_MS + 1_000);
    expect(h.result.current.notices.map((n) => n.summary)).toEqual(["A"]);
    act(() => h.result.current.dismissNotice(h.result.current.notices[0].id));
    expect(h.result.current.notices).toEqual([]);
  });

  test("a new plain notice replaces the older plain one, and the older one's timer does not take the new one away early", async () => {
    vi.useFakeTimers();
    const h = setup();
    act(() => h.result.current.announce("A", []));
    await advance(NOTICE_MS - 1_000);
    act(() => h.result.current.announce("B", []));
    expect(h.result.current.notices.map((n) => n.summary)).toEqual(["B"]);
    await advance(2_000); // A의 시간이 지났다
    expect(h.result.current.notices.map((n) => n.summary)).toEqual(["B"]);
    await advance(NOTICE_MS);
    expect(h.result.current.notices).toEqual([]);
  });

  test("dismissing removes only that notice", () => {
    const h = setup();
    act(() => h.result.current.announce("A", ["x"]));
    act(() => h.result.current.announce("B", ["y"]));
    const [a, b] = h.result.current.notices;
    expect(a.id).not.toBe(b.id);
    act(() => h.result.current.dismissNotice(a.id));
    expect(h.result.current.notices.map((n) => n.summary)).toEqual(["B"]);
    act(() => h.result.current.dismissNotice(999));
    expect(h.result.current.notices.map((n) => n.summary)).toEqual(["B"]);
  });

  test("closing the tab drops the fade that was still waiting, and a replaced notice leaves no timer behind", () => {
    vi.useFakeTimers();
    const h = setup();
    act(() => h.result.current.announce("A", []));
    act(() => h.result.current.announce("B", [])); // A은 B로 바뀌었다
    expect(vi.getTimerCount()).toBe(1);
    h.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("the functions keep their identity between renders", () => {
    const h = setup();
    const { announce, dismissNotice } = h.result.current;
    act(() => h.result.current.announce("A", []));
    h.rerender();
    expect(h.result.current.announce).toBe(announce);
    expect(h.result.current.dismissNotice).toBe(dismissNotice);
  });

  describe("replacing a notice that is already shown", () => {
    /** announce가 돌려준 id를 꺼내려고 한 번 부른 값을 받아 둔다 */
    function announceOnce(h: ReturnType<typeof setup>, summary: string, notes: string[], replaces?: number) {
      let id = -1;
      act(() => {
        id = h.result.current.announce(summary, notes, replaces);
      });
      return id;
    }

    test("announce gives back the id of the notice it shows", () => {
      const h = setup();
      const a = announceOnce(h, "A", []);
      expect(h.result.current.notices.map((n) => n.id)).toEqual([a]);
      const b = announceOnce(h, "B", ["x"]);
      expect(b).not.toBe(a);
      expect(h.result.current.notices.map((n) => n.id)).toEqual([b]);
    });

    test("a plain notice can be replaced by the same notice with a note added, which then stays", async () => {
      vi.useFakeTimers();
      const h = setup();
      const first = announceOnce(h, "적용했어요", []);
      await advance(NOTICE_MS - 1_000);
      announceOnce(h, "적용했어요", ["목록을 다시 읽지 못했어요"], first);
      expect(h.result.current.notices).toEqual([{ id: expect.any(Number), summary: "적용했어요", notes: ["목록을 다시 읽지 못했어요"] }]);
      await advance(NOTICE_MS * 2); // 처음 안내의 사라질 때가 지나도 남는다
      expect(h.result.current.notices.map((n) => n.summary)).toEqual(["적용했어요"]);
      expect(vi.getTimerCount()).toBe(0);
    });

    test("a notice that has notes is replaced too, in place of adding a second one", () => {
      const h = setup();
      const first = announceOnce(h, "적용했어요", ["연결이 끊겼지만 적용된 것을 확인했어요"]);
      announceOnce(h, "적용했어요", ["연결이 끊겼지만 적용된 것을 확인했어요", "목록을 다시 읽지 못했어요"], first);
      expect(h.result.current.notices).toHaveLength(1);
      expect(h.result.current.notices[0].notes).toEqual(["연결이 끊겼지만 적용된 것을 확인했어요", "목록을 다시 읽지 못했어요"]);
    });

    test("other notices that have notes stay", () => {
      const h = setup();
      announceOnce(h, "먼저 한 일", ["하지 못한 일"]);
      const second = announceOnce(h, "나중 일", []);
      announceOnce(h, "나중 일", ["다시 읽지 못했어요"], second);
      expect(h.result.current.notices.map((n) => n.summary)).toEqual(["먼저 한 일", "나중 일"]);
    });

    test("a notice that has gone already (faded or dismissed) is not an error: the new one is simply shown", async () => {
      vi.useFakeTimers();
      const h = setup();
      const first = announceOnce(h, "적용했어요", []);
      await advance(NOTICE_MS + 1);
      expect(h.result.current.notices).toEqual([]);
      announceOnce(h, "적용했어요", ["목록을 다시 읽지 못했어요"], first);
      expect(h.result.current.notices).toEqual([{ id: expect.any(Number), summary: "적용했어요", notes: ["목록을 다시 읽지 못했어요"] }]);
    });

    test("replacing without notes keeps the usual fade", async () => {
      vi.useFakeTimers();
      const h = setup();
      const first = announceOnce(h, "A", []);
      announceOnce(h, "B", [], first);
      expect(h.result.current.notices.map((n) => n.summary)).toEqual(["B"]);
      await advance(NOTICE_MS + 1);
      expect(h.result.current.notices).toEqual([]);
    });
  });
});

describe("useIamRefresh", () => {
  function setup(profile = "prod") {
    const { qc, wrapper } = clientWrapper();
    const hook = renderHook(() => ({ refresh: useIamRefresh(), overview: useIamOverview(profile) }), { wrapper });
    return { qc, ...hook, refresh: () => hook.result.current.refresh };
  }

  test("invalidate marks the queries of that profile and the change log as stale, and no other profile's", async () => {
    const h = setup();
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    h.qc.setQueryData(iamKeys.principal("prod", "arn:x"), { any: "thing" });
    h.qc.setQueryData(iamKeys.principal("dev", "arn:x"), { any: "thing" });
    h.qc.setQueryData(iamKeys.changeLog, []);
    act(() => h.refresh().invalidate("prod"));
    expect(h.qc.getQueryState(iamKeys.principal("prod", "arn:x"))?.isInvalidated).toBe(true);
    expect(h.qc.getQueryState(iamKeys.changeLog)?.isInvalidated).toBe(true);
    expect(h.qc.getQueryState(iamKeys.principal("dev", "arn:x"))?.isInvalidated).toBe(false);
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(2)); // 보고 있는 개요는 바로 다시 읽는다
    expect(m.overview).toHaveBeenLastCalledWith("prod", false);
  });

  test("refreshLater reads the overview again with force=true after REFRESH_DELAY_MS, not before", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = setup();
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    expect(m.overview).toHaveBeenCalledTimes(1);
    act(() => h.refresh().refreshLater("prod"));
    await act(() => vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS - 100));
    expect(m.overview).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(200));
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(2));
    expect(m.overview).toHaveBeenLastCalledWith("prod", true);
  });

  test("every refresh that was asked for runs", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = setup();
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    act(() => h.refresh().refreshLater("prod"));
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    act(() => h.refresh().refreshLater("prod"));
    await act(() => vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS));
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(3));
    expect(m.overview).toHaveBeenLastCalledWith("prod", true);
  });

  test("closing the tab cancels a refresh that was still waiting", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = setup();
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    act(() => h.refresh().refreshLater("prod"));
    h.unmount();
    // 탭이 닫히면 개요를 보는 쪽이 없어서 다시 읽는지는 개요 호출로 보이지 않는다. 무효화 호출로 본다
    const invalidations = vi.spyOn(h.qc, "invalidateQueries");
    await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS + 2_000);
    expect(invalidations).not.toHaveBeenCalled();
    expect(m.overview).toHaveBeenCalledTimes(1);
  });

  test("the functions keep their identity between renders", async () => {
    const h = setup();
    const { invalidate, refreshLater } = h.refresh();
    h.rerender();
    expect(h.refresh().invalidate).toBe(invalidate);
    expect(h.refresh().refreshLater).toBe(refreshLater);
  });
});

describe("usePendingFlow", () => {
  type Flow = { phase: "loading" | "ready" | "applying"; id: number };
  const ready: Flow = { phase: "ready", id: 1 };
  const applying: Flow = { phase: "applying", id: 2 };
  const setup = (profile = "prod") => renderHook(({ p }) => usePendingFlow<Flow, () => void>(p), { initialProps: { p: profile } });

  test("commit sets the flow and, at once, the ref that the handlers read", () => {
    const h = setup();
    expect(h.result.current.pending).toBeNull();
    act(() => {
      h.result.current.commit(ready);
      expect(h.result.current.pendingRef.current).toBe(ready); // 같은 이벤트 안에서도 맞다
    });
    expect(h.result.current.pending).toBe(ready);
    act(() => h.result.current.commit(null));
    expect(h.result.current.pending).toBeNull();
    expect(h.result.current.pendingRef.current).toBeNull();
  });

  test("cancel closes the flow, forgets its callback and bumps the revision", () => {
    const h = setup();
    const done = vi.fn();
    act(() => h.result.current.commit(ready));
    h.result.current.onApplied.current = done;
    const before = h.result.current.seq.current;
    act(() => h.result.current.cancel());
    expect(h.result.current.pending).toBeNull();
    expect(h.result.current.onApplied.current).toBeUndefined();
    expect(h.result.current.seq.current).toBe(before + 1);
  });

  test("cancel does not close a flow whose request is out", () => {
    const h = setup();
    const done = vi.fn();
    act(() => h.result.current.commit(applying));
    h.result.current.onApplied.current = done;
    act(() => h.result.current.cancel());
    expect(h.result.current.pending).toBe(applying);
    expect(h.result.current.onApplied.current).toBe(done);
  });

  test("another profile drops the flow, its callback and bumps the revision", () => {
    const h = setup("prod");
    act(() => h.result.current.commit(ready));
    h.result.current.onApplied.current = vi.fn();
    const before = h.result.current.seq.current;
    h.rerender({ p: "dev" });
    expect(h.result.current.pending).toBeNull();
    expect(h.result.current.onApplied.current).toBeUndefined();
    expect(h.result.current.seq.current).toBeGreaterThan(before);
    expect(h.result.current.profileRef.current).toBe("dev");
  });

  test("another profile leaves a flow whose request is out, since that request cannot be taken back", () => {
    const h = setup("prod");
    act(() => h.result.current.commit(applying));
    h.rerender({ p: "dev" });
    expect(h.result.current.pending).toBe(applying);
    expect(h.result.current.onApplied.current).toBeUndefined(); // 장바구니는 새 프로필의 것이라 건드리지 않는다
  });

  test("the functions keep their identity between renders", () => {
    const h = setup();
    const { commit, cancel } = h.result.current;
    act(() => h.result.current.commit(ready));
    h.rerender({ p: "prod" });
    expect(h.result.current.commit).toBe(commit);
    expect(h.result.current.cancel).toBe(cancel);
  });

  test("alive tells whether the hook is still on screen: the late answers of a closed tab check it", () => {
    const h = setup();
    const { alive } = h.result.current;
    expect(alive.current).toBe(true);
    h.unmount();
    expect(alive.current).toBe(false);
  });

  test("under React's strict mode, which runs every effect twice, the hook is alive and commits", () => {
    const h = renderHook(() => usePendingFlow<Flow, () => void>("prod"), { reactStrictMode: true });
    expect(h.result.current.alive.current).toBe(true);
    act(() => h.result.current.commit(ready));
    expect(h.result.current.pending).toBe(ready);
    h.unmount();
    expect(h.result.current.alive.current).toBe(false);
  });

  test("commit does nothing once the hook is closed: neither the ref nor the state", () => {
    const h = setup();
    const { commit, pendingRef } = h.result.current;
    act(() => commit(ready));
    h.unmount();
    commit(applying);
    expect(pendingRef.current).toBe(ready);
    commit(null);
    expect(pendingRef.current).toBe(ready);
  });
});
