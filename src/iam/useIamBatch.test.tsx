import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { iamApi } from "./api";
import { attachReadOnlyToBob, batchResult, ciBot, detachReadOnlyFromAlice, PLAN_DRIFTED, previewBatchOf, readOnlyPolicy, sampleOverview } from "./fixtures";
import { iamKeys, useIamOverview } from "./queries";
import type { BatchPreview, BatchResult, IamChange, PreviewWarning } from "./types";
import { NOTICE_MS, REFRESH_DELAY_MS } from "./useIamChange";
import { batchGate, stopMessage, useIamBatch, type BatchStartOptions } from "./useIamBatch";

vi.mock("./api", () => ({ iamApi: { previewBatch: vi.fn(), applyBatch: vi.fn(), overview: vi.fn() } }));

const m = vi.mocked(iamApi);

const attachBob = attachReadOnlyToBob;
const detachAlice = detachReadOnlyFromAlice;
const attachCi: IamChange = { op: "attachPolicy", target: ciBot.arn, policyArn: readOnlyPolicy.arn };
/** 장바구니에 담긴 순서: 떼기가 먼저 담겼다 */
const queued: IamChange[] = [detachAlice, attachBob, attachCi];

const isGrant = (c: IamChange) => c.op === "attachPolicy" || c.op === "addToGroup";
/** 백엔드가 하는 일: 붙이기·넣기를 앞에 두고, 각 무리 안에서는 받은 순서를 지킨다 */
const applyOrder = (changes: IamChange[]) => [...changes.filter(isGrant), ...changes.filter((c) => !isGrant(c))];
const CONFIRM = "변경 3개 적용";
const confirmBatch = (changes: IamChange[] = queued, text = CONFIRM) =>
  previewBatchOf(applyOrder(changes), { warnings: [{ level: "confirm", message: "관리자급 권한을 새로 얻는 주체: ci-bot" }], confirmText: text });
const stoppedAt = (index: number, extra: Partial<BatchResult> = {}) =>
  batchResult({
    logIds: Array.from({ length: index }, (_, i) => `b-${i + 1}`),
    failed: { index, summary: "ci-bot에 ReadOnlyAccess를 붙여요", message: "권한 없음 (iam:AttachUserPolicy)" },
    ...extra,
  });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(profile = "prod") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const hook = renderHook(({ p }) => ({ flow: useIamBatch(p), overview: useIamOverview(p) }), { wrapper, initialProps: { p: profile } });
  return { qc, ...hook, flow: () => hook.result.current.flow };
}

/** 미리보기가 도착해 확인을 기다리는 상태까지 간다 */
async function startAndWait(h: ReturnType<typeof setup>, changes: IamChange[] = queued, opts?: BatchStartOptions) {
  act(() => h.flow().start(changes, opts));
  await waitFor(() => expect(h.flow().pending?.phase).toBe("ready"));
}

/** 적용한 직후 IAM을 한 번, 3초 뒤 강제로 한 번 더 읽는다. 가짜 시계를 쓰는 테스트에서 부른다 */
async function expectTwoReads(prior: number) {
  await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(prior + 1));
  expect(m.overview).toHaveBeenLastCalledWith("prod", false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS - 100);
  });
  expect(m.overview).toHaveBeenCalledTimes(prior + 1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(prior + 2));
  expect(m.overview).toHaveBeenLastCalledWith("prod", true);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.overview.mockResolvedValue(sampleOverview());
  m.previewBatch.mockImplementation(async (_p, changes) => previewBatchOf(applyOrder(changes)));
  m.applyBatch.mockResolvedValue(batchResult({ logIds: ["l-1", "l-2", "l-3"] }));
});
afterEach(() => vi.useRealTimers());

describe("batchGate", () => {
  const warn = (level: PreviewWarning["level"]): PreviewWarning => ({ level, message: `${level} 경고` });
  /** 묶음 전체의 경고와 변경마다의 경고를 따로 줄 수 있는 미리보기 */
  const withWarnings = (batch: PreviewWarning[], perItem: PreviewWarning[][], confirmText: string | null = null): BatchPreview => {
    const p = previewBatchOf(applyOrder(queued), { warnings: batch, confirmText });
    return { ...p, changes: p.changes.map((item, i) => ({ ...item, warnings: perItem[i] ?? [] })) };
  };

  test("a batch without warnings can be applied", () => {
    expect(batchGate(previewBatchOf(applyOrder(queued)), "")).toEqual({ ok: true });
  });

  test("a block warning on the batch refuses, whatever was typed", () => {
    const p = withWarnings([warn("block")], [], CONFIRM);
    expect(batchGate(p, CONFIRM)).toEqual({ ok: false, reason: "blocked" });
    expect(batchGate(p, "")).toEqual({ ok: false, reason: "blocked" });
  });

  test("a block warning on one change refuses the whole batch, whatever was typed", () => {
    const p = withWarnings([], [[], [], [warn("block")]], CONFIRM);
    expect(batchGate(p, CONFIRM)).toEqual({ ok: false, reason: "blocked" });
    expect(batchGate(p, "")).toEqual({ ok: false, reason: "blocked" });
  });

  test("the confirm text must be typed exactly: case, spaces and extra characters all count", () => {
    const p = withWarnings([warn("confirm")], [], CONFIRM);
    expect(batchGate(p, CONFIRM)).toEqual({ ok: true });
    for (const wrong of ["", "변경 3개 적용 ", " 변경 3개 적용", "변경 3개 적용!", "변경 3개", "변경 2개 적용"]) {
      expect(batchGate(p, wrong)).toEqual({ ok: false, reason: "text" });
    }
  });

  test("a confirm warning on one change is enough to ask for the batch's text", () => {
    const p = withWarnings([], [[], [warn("confirm")], []], "ci-bot");
    expect(batchGate(p, "")).toEqual({ ok: false, reason: "text" });
    expect(batchGate(p, "ci-bot")).toEqual({ ok: true });
  });

  test("a confirm warning without a text to type cannot be applied at all, whether it is on the batch or on a change", () => {
    expect(batchGate(withWarnings([warn("confirm")], []), "")).toEqual({ ok: false, reason: "noText" });
    expect(batchGate(withWarnings([], [[], [], [warn("confirm")]]), "")).toEqual({ ok: false, reason: "noText" });
  });

  test("warn warnings alone do not stop the apply", () => {
    expect(batchGate(withWarnings([warn("warn")], [[warn("warn")]]), "")).toEqual({ ok: true });
  });
});

describe("stopMessage", () => {
  test("says how many of the batch were applied and which change stopped it", () => {
    expect(stopMessage(3, { index: 1, summary: "ci-bot에 ReadOnlyAccess를 붙여요", message: "권한 없음 (iam:AttachUserPolicy)" })).toBe(
      "3개 중 1개를 적용하고 2번째에서 멈췄어요: ci-bot에 ReadOnlyAccess를 붙여요: 권한 없음 (iam:AttachUserPolicy)",
    );
  });
});

describe("preview", () => {
  test("start asks the backend for a preview of exactly those changes, in the order they were given, and opens the flow", async () => {
    const h = setup();
    expect(h.flow().pending).toBeNull();
    act(() => h.flow().start(queued));
    expect(h.flow().pending).toMatchObject({ profile: "prod", changes: queued, phase: "loading", preview: null, undoOf: null, error: null, stale: false, result: null });
    expect(m.previewBatch).toHaveBeenCalledWith("prod", queued);
    await waitFor(() => expect(h.flow().pending?.phase).toBe("ready"));
    expect(h.flow().pending?.preview).toEqual(previewBatchOf(applyOrder(queued)));
    expect(m.applyBatch).not.toHaveBeenCalled();
  });

  test("remembers which records an undo batch is for", async () => {
    const h = setup();
    await startAndWait(h, [attachBob, attachCi], { undoOf: ["log-1", "log-2"] });
    expect(h.flow().pending?.undoOf).toEqual(["log-1", "log-2"]);
  });

  test("a failing preview is kept as an error and can be asked for again, for the same changes", async () => {
    m.previewBatch.mockRejectedValueOnce({ kind: "accessDenied", action: "iam:GetPolicy" });
    const h = setup();
    act(() => h.flow().start(queued, { undoOf: ["u-1", "u-2", "u-3"] }));
    await waitFor(() => expect(h.flow().pending?.error).toEqual({ kind: "preview", message: "권한 없음 (iam:GetPolicy)" }));
    expect(h.flow().pending?.preview).toBeNull();
    expect(h.flow().pending?.phase).toBe("ready");

    act(() => h.flow().apply(""));
    expect(m.applyBatch).not.toHaveBeenCalled();

    act(() => h.flow().retryPreview());
    await waitFor(() => expect(h.flow().pending?.preview).not.toBeNull());
    expect(h.flow().pending?.error).toBeNull();
    expect(m.previewBatch).toHaveBeenCalledTimes(2);
    expect(m.previewBatch).toHaveBeenLastCalledWith("prod", queued);
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).toHaveBeenCalledWith("prod", queued, null, ["u-1", "u-2", "u-3"]);
  });

  test("cancel closes the flow, and a preview that arrives afterwards is ignored", async () => {
    const slow = deferred<BatchPreview>();
    m.previewBatch.mockReturnValueOnce(slow.promise);
    const h = setup();
    act(() => h.flow().start(queued));
    act(() => h.flow().cancel());
    expect(h.flow().pending).toBeNull();
    await act(async () => slow.resolve(previewBatchOf(applyOrder(queued))));
    expect(h.flow().pending).toBeNull();
  });

  test("apply after cancel does nothing: a closed flow has no preview to apply", async () => {
    const h = setup();
    await startAndWait(h);
    act(() => h.flow().cancel());
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).not.toHaveBeenCalled();
  });

  test("onApplied belongs to the batch it was given for: a later batch does not inherit it, whether the first was cancelled or replaced", async () => {
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, queued, { onApplied });
    act(() => h.flow().cancel());
    await startAndWait(h, [attachBob]);
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).toHaveBeenLastCalledWith("prod", [attachBob], null, null);

    await startAndWait(h, queued, { onApplied });
    await startAndWait(h, [attachCi]); // 닫지 않고 바로 다른 묶음을 연다
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).toHaveBeenLastCalledWith("prod", [attachCi], null, null);
    expect(onApplied).not.toHaveBeenCalled();
  });

  test("starting another batch replaces the one still loading; only the newest preview counts", async () => {
    const first = deferred<BatchPreview>();
    m.previewBatch.mockReturnValueOnce(first.promise);
    const h = setup();
    act(() => h.flow().start(queued));
    act(() => h.flow().start([attachBob]));
    await waitFor(() => expect(h.flow().pending?.phase).toBe("ready"));
    expect(h.flow().pending?.changes).toEqual([attachBob]);
    await act(async () => first.resolve(previewBatchOf(applyOrder(queued), { warnings: [{ level: "warn", message: "낡은 미리보기" }] })));
    expect(h.flow().pending?.preview?.warnings).toEqual([]);
    expect(h.flow().pending?.changes).toEqual([attachBob]);
  });
});

describe("apply", () => {
  test("sends the changes in the order they were given, not the order of the preview, with no confirm text and no undo", async () => {
    const h = setup();
    await startAndWait(h);
    // 미리보기는 붙이기를 앞에 두지만, 적용에는 받은 순서 그대로 보낸다: 백엔드가 정렬하고, undoOf는 이 순서와 짝이다
    expect(h.flow().pending?.preview?.changes.map((i) => i.change)).toEqual([attachBob, attachCi, detachAlice]);
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).toHaveBeenCalledTimes(1);
    expect(m.applyBatch).toHaveBeenCalledWith("prod", queued, null, null);
  });

  test("sends the typed confirm text and the undo ids paired with the changes as given", async () => {
    m.previewBatch.mockImplementation(async (_p, changes) => confirmBatch(changes));
    const h = setup();
    await startAndWait(h, queued, { undoOf: ["u-1", "u-2", "u-3"] });
    await act(async () => h.flow().apply(CONFIRM));
    expect(m.applyBatch).toHaveBeenCalledWith("prod", queued, CONFIRM, ["u-1", "u-2", "u-3"]);
  });

  test("never calls the backend while the confirm text is wrong, empty or differently spaced", async () => {
    m.previewBatch.mockImplementation(async (_p, changes) => confirmBatch(changes));
    const h = setup();
    await startAndWait(h);
    for (const typed of ["", "변경 3개 적용 ", "변경 2개 적용", "ci-bot"]) await act(async () => h.flow().apply(typed));
    expect(m.applyBatch).not.toHaveBeenCalled();
    expect(h.flow().pending?.phase).toBe("ready");
  });

  test("never calls the backend for a batch with a block warning, nor for one whose change has one", async () => {
    m.previewBatch.mockImplementationOnce(async (_p, changes) => previewBatchOf(applyOrder(changes), { warnings: [{ level: "block", message: "같은 대상을 바꾸는 변경이 겹쳐요" }] }));
    const h = setup();
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).not.toHaveBeenCalled();

    m.previewBatch.mockImplementationOnce(async (_p, changes) => {
      const p = previewBatchOf(applyOrder(changes));
      return { ...p, changes: p.changes.map((item, i) => (i === 1 ? { ...item, warnings: [{ level: "block", message: "서비스 연결 역할이에요" } as const] } : item)) };
    });
    act(() => h.flow().retryPreview());
    await waitFor(() => expect(h.flow().pending?.phase).toBe("ready"));
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).not.toHaveBeenCalled();
  });

  test("never calls the backend before the preview has arrived", async () => {
    m.previewBatch.mockReturnValueOnce(new Promise(() => {}));
    const h = setup();
    act(() => h.flow().start(queued));
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).not.toHaveBeenCalled();
    expect(h.flow().pending?.phase).toBe("loading");
  });

  test("a double click applies once", async () => {
    const slow = deferred<BatchResult>();
    m.applyBatch.mockReturnValueOnce(slow.promise);
    const h = setup();
    await startAndWait(h);
    act(() => {
      h.flow().apply("");
      h.flow().apply("");
    });
    expect(m.applyBatch).toHaveBeenCalledTimes(1);
    expect(h.flow().pending?.phase).toBe("applying");
    await act(async () => slow.resolve(batchResult()));
  });

  test("while applying, cancel, a new start and a retry are ignored", async () => {
    const slow = deferred<BatchResult>();
    m.applyBatch.mockReturnValueOnce(slow.promise);
    const h = setup();
    await startAndWait(h);
    act(() => h.flow().apply(""));
    act(() => h.flow().cancel());
    act(() => h.flow().start([attachBob]));
    act(() => h.flow().retryPreview());
    expect(h.flow().pending?.changes).toEqual(queued);
    expect(h.flow().pending?.phase).toBe("applying");
    expect(m.previewBatch).toHaveBeenCalledTimes(1);
    await act(async () => slow.resolve(batchResult()));
    expect(h.flow().pending).toBeNull();
  });
});

describe("when every change is applied", () => {
  test("the flow closes, the notice counts the changes, and onApplied gets all of them in the order they ran", async () => {
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, queued, { onApplied });
    expect(h.flow().notices).toEqual([]);
    await act(async () => h.flow().apply(""));
    expect(h.flow().pending).toBeNull();
    expect(h.flow().notices).toEqual([{ id: expect.any(Number), summary: "변경 3개를 적용했어요", notes: [] }]);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledWith([attachBob, attachCi, detachAlice]);
    act(() => h.flow().dismissNotice(h.flow().notices[0].id));
    expect(h.flow().notices).toEqual([]);
  });

  test("the notice counts the changes of the batch even when the last one could not be logged", async () => {
    m.applyBatch.mockResolvedValue(batchResult({ logIds: ["l-1", "l-2"], notes: ["변경 기록을 저장하지 못했어요: 디스크가 가득 찼어요"] }));
    const h = setup();
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    expect(h.flow().notices).toEqual([{ id: expect.any(Number), summary: "변경 3개를 적용했어요", notes: ["변경 기록을 저장하지 못했어요: 디스크가 가득 찼어요"] }]);
  });

  test("a notice with notes stays until it is dismissed, and the next success does not replace it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    m.applyBatch.mockResolvedValueOnce(batchResult({ notes: ["변경 기록을 저장하지 못했어요: 디스크가 가득 찼어요"] })).mockResolvedValueOnce(batchResult());
    const h = setup();
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTICE_MS + 2_000);
    });
    expect(h.flow().notices).toHaveLength(1);

    await startAndWait(h, [attachBob, attachCi]);
    await act(async () => h.flow().apply(""));
    expect(h.flow().notices.map((n) => n.summary)).toEqual(["변경 3개를 적용했어요", "변경 2개를 적용했어요"]);
    // 함께 알릴 일이 없는 안내만 저절로 사라진다
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTICE_MS + 2_000);
    });
    expect(h.flow().notices.map((n) => n.summary)).toEqual(["변경 3개를 적용했어요"]);
    act(() => h.flow().dismissNotice(h.flow().notices[0].id));
    expect(h.flow().notices).toEqual([]);
  });

  test("a plain notice fades, and the next one replaces it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = setup();
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    expect(h.flow().notices).toHaveLength(1);
    await startAndWait(h, [attachBob]);
    await act(async () => h.flow().apply(""));
    expect(h.flow().notices.map((n) => n.summary)).toEqual(["변경 1개를 적용했어요"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTICE_MS + 2_000);
    });
    expect(h.flow().notices).toEqual([]);
  });

  test("re-reads the IAM data now, and once more after 3 seconds with a forced overview", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = setup();
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    expect(m.overview).toHaveBeenCalledTimes(1);
    expect(m.overview).toHaveBeenLastCalledWith("prod", false);
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    await expectTwoReads(1);
  });

  test("marks every query under the profile and the change log as stale", async () => {
    const h = setup();
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    h.qc.setQueryData(iamKeys.principal("prod", "arn:x"), { any: "thing" });
    h.qc.setQueryData(iamKeys.principal("dev", "arn:x"), { any: "thing" });
    h.qc.setQueryData(iamKeys.changeLog, []);
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    expect(h.qc.getQueryState(iamKeys.principal("prod", "arn:x"))?.isInvalidated).toBe(true);
    expect(h.qc.getQueryState(iamKeys.changeLog)?.isInvalidated).toBe(true);
    expect(h.qc.getQueryState(iamKeys.principal("dev", "arn:x"))?.isInvalidated).toBe(false);
  });

  test("the tray is told first, before the IAM data is marked stale: a reloaded overview must not meet applied changes still in the tray", async () => {
    const h = setup();
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    h.qc.setQueryData(iamKeys.principal("prod", "arn:x"), { any: "thing" });
    const seen: { stale: boolean | undefined }[] = [];
    const onApplied = vi.fn(() => seen.push({ stale: h.qc.getQueryState(iamKeys.principal("prod", "arn:x"))?.isInvalidated }));
    await startAndWait(h, queued, { onApplied });
    await act(async () => h.flow().apply(""));
    expect(seen).toEqual([{ stale: false }]);
    expect(h.qc.getQueryState(iamKeys.principal("prod", "arn:x"))?.isInvalidated).toBe(true);
  });

  test("a closed tab does not refresh later", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = setup();
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(2));
    h.unmount();
    // 탭이 닫히면 개요를 보는 쪽이 없어서 다시 읽는지는 개요 호출로 보이지 않는다. 무효화 호출로 본다
    const invalidations = vi.spyOn(h.qc, "invalidateQueries");
    await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS + 2_000);
    expect(invalidations).not.toHaveBeenCalled();
    expect(m.overview).toHaveBeenCalledTimes(2);
  });
});

describe("when a change stops the batch", () => {
  test("the flow stays open in the result phase with the result and the preview, and says nothing was a success", async () => {
    m.applyBatch.mockResolvedValue(stoppedAt(1));
    const h = setup();
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    expect(h.flow().pending).toMatchObject({
      phase: "result",
      changes: queued,
      preview: previewBatchOf(applyOrder(queued)),
      result: stoppedAt(1),
      error: null,
      stale: false,
    });
    expect(h.flow().notices).toEqual([]);
  });

  test("onApplied gets only the changes that ran before the stop, in the order they ran, not the order they were queued", async () => {
    m.applyBatch.mockResolvedValue(stoppedAt(1));
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, queued, { onApplied });
    await act(async () => h.flow().apply(""));
    // 적용 순서는 [attachBob, attachCi, detachAlice]다. 담긴 순서의 앞(detachAlice)이 아니라 적용 순서의 앞이 적용됐다
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledWith([attachBob]);
  });

  test("the IAM data is read again, now and after 3 seconds, and the tray hears first", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    m.applyBatch.mockResolvedValue(stoppedAt(2));
    const h = setup();
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    h.qc.setQueryData(iamKeys.principal("prod", "arn:x"), { any: "thing" });
    h.qc.setQueryData(iamKeys.changeLog, []);
    const seen: (boolean | undefined)[] = [];
    const onApplied = vi.fn(() => seen.push(h.qc.getQueryState(iamKeys.principal("prod", "arn:x"))?.isInvalidated));
    await startAndWait(h, queued, { onApplied });
    await act(async () => h.flow().apply(""));
    expect(seen).toEqual([false]);
    expect(h.qc.getQueryState(iamKeys.principal("prod", "arn:x"))?.isInvalidated).toBe(true);
    expect(h.qc.getQueryState(iamKeys.changeLog)?.isInvalidated).toBe(true);
    await expectTwoReads(1);
  });

  test("when the first change is the one that stops, nothing is handed to onApplied, but the data is still read again", async () => {
    m.applyBatch.mockResolvedValue(stoppedAt(0));
    const onApplied = vi.fn();
    const h = setup();
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    h.qc.setQueryData(iamKeys.changeLog, []);
    await startAndWait(h, queued, { onApplied });
    await act(async () => h.flow().apply(""));
    expect(h.flow().pending).toMatchObject({ phase: "result", result: { failed: { index: 0 }, logIds: [] } });
    expect(onApplied).not.toHaveBeenCalled();
    // 실패한 시도도 기록에 남고, 응답을 받지 못한 호출은 적용됐을 수도 있다
    expect(h.qc.getQueryState(iamKeys.changeLog)?.isInvalidated).toBe(true);
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(2));
  });

  test("when the log stopped saving, the change before the stop still counts as applied", async () => {
    // 두 번째 변경은 적용됐지만 기록하지 못했다. 백엔드는 멈추고 세 번째를 "변경 기록을 저장하지 못해서 멈췄어요"로 실패 처리한다
    m.applyBatch.mockResolvedValue(
      batchResult({
        logIds: ["b-1"],
        failed: { index: 2, summary: "alice에서 ReadOnlyAccess를 떼요", message: "변경 기록을 저장하지 못해서 멈췄어요" },
        notes: ["변경 기록을 저장하지 못했어요: 디스크가 가득 찼어요"],
      }),
    );
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, queued, { onApplied });
    await act(async () => h.flow().apply(""));
    expect(onApplied).toHaveBeenCalledWith([attachBob, attachCi]);
    expect(h.flow().pending?.result?.logIds).toEqual(["b-1"]);
    expect(h.flow().pending?.result?.notes).toEqual(["변경 기록을 저장하지 못했어요: 디스크가 가득 찼어요"]);
  });

  test("the result can be closed", async () => {
    m.applyBatch.mockResolvedValue(stoppedAt(1));
    const h = setup();
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    act(() => h.flow().cancel());
    expect(h.flow().pending).toBeNull();
  });

  test("an undo can be started from the result: it replaces the result, takes its own undo ids and does not inherit onApplied", async () => {
    m.applyBatch.mockResolvedValueOnce(stoppedAt(1));
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, queued, { onApplied });
    await act(async () => h.flow().apply(""));
    expect(onApplied).toHaveBeenCalledTimes(1);

    const undoChanges: IamChange[] = [{ op: "detachPolicy", target: attachBob.op === "attachPolicy" ? attachBob.target : "", policyArn: readOnlyPolicy.arn }];
    await startAndWait(h, undoChanges, { undoOf: ["b-1"] });
    expect(h.flow().pending).toMatchObject({ changes: undoChanges, undoOf: ["b-1"], result: null, phase: "ready" });
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).toHaveBeenLastCalledWith("prod", undoChanges, null, ["b-1"]);
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  test("the result is not applied again, and its preview is not asked for again", async () => {
    m.applyBatch.mockResolvedValue(stoppedAt(1));
    const h = setup();
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    await act(async () => h.flow().apply(""));
    act(() => h.flow().retryPreview());
    expect(m.applyBatch).toHaveBeenCalledTimes(1);
    expect(m.previewBatch).toHaveBeenCalledTimes(1);
    expect(h.flow().pending?.phase).toBe("result");
  });
});

describe("a rejected apply", () => {
  test("keeps the flow open with the error and refuses another apply until the preview is read again", async () => {
    m.applyBatch.mockRejectedValueOnce({ kind: "other", message: "한 번에 50개까지 적용할 수 있어요" });
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, queued, { onApplied });
    await act(async () => h.flow().apply(""));

    expect(h.flow().pending).toMatchObject({ phase: "ready", stale: true, error: { kind: "apply", message: "한 번에 50개까지 적용할 수 있어요" }, result: null });
    expect(h.flow().notices).toEqual([]);
    expect(onApplied).not.toHaveBeenCalled();

    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).toHaveBeenCalledTimes(1); // 낡은 미리보기로는 다시 적용하지 않는다

    act(() => h.flow().retryPreview());
    await waitFor(() => expect(h.flow().pending?.stale).toBe(false));
    expect(m.previewBatch).toHaveBeenCalledTimes(2);
    expect(h.flow().pending?.error).toBeNull();
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).toHaveBeenCalledTimes(2);
    expect(h.flow().pending).toBeNull();
    expect(onApplied).toHaveBeenCalledWith([attachBob, attachCi, detachAlice]);
  });

  test("the backend's refusal after IAM changed behind the preview leads to a fresh preview, which can then be applied", async () => {
    m.applyBatch.mockRejectedValueOnce({ kind: "other", message: PLAN_DRIFTED });
    const h = setup();
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    expect(h.flow().pending).toMatchObject({ phase: "ready", stale: true, error: { kind: "apply", message: PLAN_DRIFTED } });

    const changed = previewBatchOf(applyOrder(queued), { warnings: [{ level: "warn", message: "ci-bot에 이미 붙어 있어요" }] });
    m.previewBatch.mockResolvedValueOnce(changed);
    act(() => h.flow().retryPreview());
    await waitFor(() => expect(h.flow().pending?.preview).toBe(changed));
    expect(h.flow().pending).toMatchObject({ stale: false, error: null });
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).toHaveBeenCalledTimes(2);
    expect(m.applyBatch).toHaveBeenLastCalledWith("prod", queued, null, null);
    expect(h.flow().pending).toBeNull();
  });

  test("re-reads the IAM views of the profile and the change log, since the answer may have been lost after the changes were made", async () => {
    m.applyBatch.mockRejectedValueOnce({ kind: "network", message: "timeout" });
    const h = setup();
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    h.qc.setQueryData(iamKeys.changeLog, []);
    h.qc.setQueryData(iamKeys.policy("prod", "arn:aws:iam::123456789012:policy/x"), { any: "thing" });
    h.qc.setQueryData(iamKeys.policy("dev", "arn:aws:iam::123456789012:policy/x"), { any: "thing" });
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(2));
    // 백엔드가 실패 뒤에 스냅숏을 버렸으니 강제로 새로 읽게 하지는 않는다
    expect(m.overview).toHaveBeenLastCalledWith("prod", false);
    expect(h.qc.getQueryState(iamKeys.policy("prod", "arn:aws:iam::123456789012:policy/x"))?.isInvalidated).toBe(true);
    expect(h.qc.getQueryState(iamKeys.policy("dev", "arn:aws:iam::123456789012:policy/x"))?.isInvalidated).toBe(false);
    expect(h.qc.getQueryState(iamKeys.changeLog)?.isInvalidated).toBe(true);
    expect(h.flow().pending?.error?.message).toBe("네트워크 오류: timeout");
  });

  test("the confirm text has to be typed again for the refreshed preview", async () => {
    m.previewBatch.mockImplementation(async (_p, changes) => confirmBatch(changes));
    m.applyBatch.mockRejectedValueOnce({ kind: "other", message: "실패" });
    const h = setup();
    await startAndWait(h);
    await act(async () => h.flow().apply(CONFIRM));
    act(() => h.flow().retryPreview());
    await waitFor(() => expect(h.flow().pending?.stale).toBe(false));
    await act(async () => h.flow().apply("")); // 비어 있으면 여전히 막힌다
    expect(m.applyBatch).toHaveBeenCalledTimes(1);
  });
});

describe("profile and unmount", () => {
  test("changing the profile drops an open flow, so a preview is never applied to another account", async () => {
    const h = setup("prod");
    await startAndWait(h);
    h.rerender({ p: "dev" });
    await waitFor(() => expect(h.flow().pending).toBeNull());
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).not.toHaveBeenCalled();
  });

  test("a preview that arrives after the profile changed is ignored", async () => {
    const slow = deferred<BatchPreview>();
    m.previewBatch.mockReturnValueOnce(slow.promise);
    const h = setup("prod");
    act(() => h.flow().start(queued));
    h.rerender({ p: "dev" });
    await waitFor(() => expect(h.flow().pending).toBeNull());
    await act(async () => slow.resolve(previewBatchOf(applyOrder(queued))));
    expect(h.flow().pending).toBeNull();
  });

  test("a preview that arrives after the tab closed does nothing", async () => {
    const slow = deferred<BatchPreview>();
    m.previewBatch.mockReturnValueOnce(slow.promise);
    const h = setup("prod");
    act(() => h.flow().start(queued));
    h.unmount();
    await act(async () => slow.resolve(previewBatchOf(applyOrder(queued))));
    expect(m.applyBatch).not.toHaveBeenCalled();
  });

  test("applies with the profile the preview was made for", async () => {
    const h = setup("prod");
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).toHaveBeenCalledWith("prod", queued, null, null);
  });

  test("a batch that finishes after the profile changed is announced, leaves the other profile's tray alone and marks only its own profile stale", async () => {
    const slow = deferred<BatchResult>();
    m.applyBatch.mockReturnValueOnce(slow.promise);
    const onApplied = vi.fn();
    const h = setup("prod");
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    h.qc.setQueryData(iamKeys.principal("prod", "arn:x"), { any: "thing" });
    h.qc.setQueryData(iamKeys.principal("dev", "arn:x"), { any: "thing" });
    await startAndWait(h, queued, { onApplied });
    act(() => h.flow().apply(""));
    h.rerender({ p: "dev" });
    expect(h.flow().pending?.phase).toBe("applying"); // 이미 보낸 요청은 거둘 수 없다
    await act(async () => slow.resolve(batchResult()));
    expect(h.flow().pending).toBeNull();
    expect(h.flow().notices.map((n) => n.summary)).toEqual(["변경 3개를 적용했어요"]);
    expect(onApplied).not.toHaveBeenCalled();
    expect(h.qc.getQueryState(iamKeys.principal("prod", "arn:x"))?.isInvalidated).toBe(true);
    expect(h.qc.getQueryState(iamKeys.principal("dev", "arn:x"))?.isInvalidated).toBe(false);
  });

  test("a batch that stops after the profile changed is not shown as a result for the new profile: it is announced, and the reason stays until dismissed", async () => {
    const slow = deferred<BatchResult>();
    m.applyBatch.mockReturnValueOnce(slow.promise);
    const h = setup("prod");
    await startAndWait(h);
    act(() => h.flow().apply(""));
    h.rerender({ p: "dev" });
    await act(async () => slow.resolve(stoppedAt(1, { notes: ["변경 기록을 저장하지 못했어요: 디스크가 가득 찼어요"] })));
    expect(h.flow().pending).toBeNull();
    // 멈춘 이유는 알릴 일로 두어서 닫을 때까지 남는다
    expect(h.flow().notices).toEqual([
      {
        id: expect.any(Number),
        summary: "변경 3개 중 1개를 적용했어요",
        notes: ["2번째에서 멈췄어요: ci-bot에 ReadOnlyAccess를 붙여요: 권한 없음 (iam:AttachUserPolicy)", "변경 기록을 저장하지 못했어요: 디스크가 가득 찼어요"],
      },
    ]);
  });

  test("a rejected apply after the profile changed closes the flow instead of showing an error for the other profile", async () => {
    const slow = deferred<BatchResult>();
    m.applyBatch.mockReturnValueOnce(slow.promise);
    const h = setup("prod");
    await startAndWait(h);
    act(() => h.flow().apply(""));
    h.rerender({ p: "dev" });
    await act(async () => slow.reject({ kind: "other", message: PLAN_DRIFTED }));
    expect(h.flow().pending).toBeNull();
    expect(h.flow().notices).toEqual([]);
  });

  test("an apply that finishes after the tab closed leaves the tray and the timers alone, but the IAM data is still marked stale", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const slow = deferred<BatchResult>();
    m.applyBatch.mockReturnValueOnce(slow.promise);
    const onApplied = vi.fn();
    const h = setup("prod");
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    h.qc.setQueryData(iamKeys.principal("prod", "arn:x"), { any: "thing" });
    await startAndWait(h, queued, { onApplied });
    act(() => h.flow().apply(""));
    h.unmount();
    await act(async () => slow.resolve(batchResult()));
    expect(onApplied).not.toHaveBeenCalled();
    expect(h.qc.getQueryState(iamKeys.principal("prod", "arn:x"))?.isInvalidated).toBe(true);
    const reads = m.overview.mock.calls.length;
    const invalidations = vi.spyOn(h.qc, "invalidateQueries");
    await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS + 2_000);
    expect(invalidations).not.toHaveBeenCalled(); // 3초 뒤 다시 읽기가 걸리지 않았다
    expect(m.overview).toHaveBeenCalledTimes(reads);
  });
});

test("a component can hold the flow in state without extra renders breaking the guards", () => {
  // start/apply/cancel/retryPreview/dismissNotice are stable references, so they are safe to use as effect dependencies
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result, rerender } = renderHook(() => ({ flow: useIamBatch("prod"), n: useState(0) }), { wrapper });
  const { start, apply, cancel, retryPreview, dismissNotice } = result.current.flow;
  act(() => result.current.n[1](1));
  rerender();
  expect(result.current.flow.start).toBe(start);
  expect(result.current.flow.apply).toBe(apply);
  expect(result.current.flow.cancel).toBe(cancel);
  expect(result.current.flow.retryPreview).toBe(retryPreview);
  expect(result.current.flow.dismissNotice).toBe(dismissNotice);
});
