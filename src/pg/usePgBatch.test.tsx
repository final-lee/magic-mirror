import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { pgApi } from "./api";
import {
  LOGIN_USER,
  addBobToWriters,
  defaultAuditRead,
  grantAuditRead,
  pgTarget,
  removeBobFromWriters,
  sampleBatchPreview,
  sampleDatabaseView,
  sampleOverview,
  sampleRoleView,
} from "./fixtures";
import { pgKeys, usePgChangeLog, usePgDatabase, usePgOverview, usePgRole } from "./queries";
import type { PgBatchPreview, PgBatchResult, PgChange, PgTarget } from "./types";
import { pgBatchGate, pgBatchWarnings, usePgBatch, type PgBatchStartOptions } from "./usePgBatch";

vi.mock("./api", () => ({
  pgApi: { previewBatch: vi.fn(), applyBatch: vi.fn(), overview: vi.fn(), open: vi.fn(), database: vi.fn(), role: vi.fn(), changeLog: vi.fn() },
}));

const m = vi.mocked(pgApi);
const CHANGES: PgChange[] = [grantAuditRead, addBobToWriters];
const applied: PgBatchResult = { batchId: "b-9", logIds: ["b-9-1", "b-9-2"], summary: "변경 2개" };
const REREAD = "2026-10-29T12:30:00Z";
const BATCH_CONFIRM = "변경 2개 적용";
const confirmBatch = (extra: Partial<PgBatchPreview> = {}) =>
  sampleBatchPreview({ warnings: [{ level: "confirm", message: "모든 역할(PUBLIC)에 권한을 줘요", add: [] }], confirmText: BATCH_CONFIRM, ...extra });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const otherTarget: PgTarget = { ...pgTarget, id: "reports-aurora" };

function setup(target: PgTarget = pgTarget) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const hook = renderHook(
    ({ t }) => ({
      flow: usePgBatch(t),
      overview: usePgOverview(t, LOGIN_USER),
      orders: usePgDatabase(t, "orders"),
      analytics: usePgDatabase(t, "analytics"),
      role: usePgRole(t, "alice"),
      log: usePgChangeLog(),
    }),
    { wrapper, initialProps: { t: target } },
  );
  return { qc, ...hook, flow: () => hook.result.current.flow };
}

async function startAndWait(h: ReturnType<typeof setup>, changes: PgChange[] = CHANGES, opts?: PgBatchStartOptions, database = "orders") {
  act(() => h.flow().start(database, changes, opts));
  await waitFor(() => expect(h.flow().pending?.phase).toBe("ready"));
}

const settled = (h: ReturnType<typeof setup>) =>
  waitFor(() => {
    const r = h.result.current;
    expect([r.overview, r.orders, r.analytics, r.role, r.log].every((q) => q.isSuccess)).toBe(true);
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.previewBatch.mockImplementation(async (_t, database) => sampleBatchPreview({ database }));
  m.applyBatch.mockResolvedValue(applied);
  m.open.mockResolvedValue(sampleOverview());
  m.overview.mockResolvedValue(sampleOverview({ fetchedAt: REREAD }));
  m.database.mockImplementation(async (_t, database) => sampleDatabaseView({ database }));
  m.role.mockImplementation(async (_t, role) => sampleRoleView(role));
  m.changeLog.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("pgBatchGate", () => {
  const item = (warnings: PgBatchPreview["items"][number]["warnings"]) => ({ ...sampleBatchPreview().items[1], warnings });

  test("the warnings of the batch and of its changes all count", () => {
    const block = { level: "block" as const, message: "막혔어요", add: [] };
    const confirm = { level: "confirm" as const, message: "확인하세요", add: [] };
    const p = sampleBatchPreview({ warnings: [confirm], items: [sampleBatchPreview().items[0], item([block])] });
    expect(pgBatchWarnings(p).map((w) => w.message)).toEqual(["확인하세요", "새로 만드는 테이블에는 적용되지 않아요", "막혔어요"]);
    expect(pgBatchGate({ ...p, confirmText: BATCH_CONFIRM }, BATCH_CONFIRM)).toEqual({ ok: false, reason: "blocked" });
  });

  test("a block in one change blocks the whole batch", () => {
    const p = sampleBatchPreview({ items: [item([{ level: "block", message: "막혔어요", add: [] }])] });
    expect(pgBatchGate(p, "")).toEqual({ ok: false, reason: "blocked" });
  });

  test("a confirm text is typed exactly, and a confirm warning without one cannot be applied", () => {
    expect(pgBatchGate(confirmBatch(), BATCH_CONFIRM)).toEqual({ ok: true });
    expect(pgBatchGate(confirmBatch(), "변경 2개 적용 ")).toEqual({ ok: false, reason: "text" });
    expect(pgBatchGate(confirmBatch(), "")).toEqual({ ok: false, reason: "text" });
    expect(pgBatchGate(confirmBatch({ confirmText: null }), "")).toEqual({ ok: false, reason: "noText" });
  });

  test("a confirm warning inside one change needs the typed text too", () => {
    const p = sampleBatchPreview({ confirmText: null, items: [item([{ level: "confirm", message: "확인하세요", add: [] }])] });
    expect(pgBatchGate(p, "")).toEqual({ ok: false, reason: "noText" });
  });

  test("warn warnings alone do not stop it", () => {
    expect(pgBatchGate(sampleBatchPreview(), "")).toEqual({ ok: true });
  });
});

describe("preview", () => {
  test("start asks the backend for a preview of that database and those changes, in the order given", async () => {
    const h = setup();
    expect(h.flow().pending).toBeNull();
    act(() => h.flow().start("orders", CHANGES));
    expect(h.flow().pending).toMatchObject({ target: pgTarget, database: "orders", changes: CHANGES, undoOf: null, phase: "loading", preview: null, error: null, stale: false });
    expect(m.previewBatch).toHaveBeenCalledWith(pgTarget, "orders", CHANGES);
    await waitFor(() => expect(h.flow().pending?.phase).toBe("ready"));
    expect(h.flow().pending?.preview).toEqual(sampleBatchPreview());
    expect(m.applyBatch).not.toHaveBeenCalled();
  });

  test("an undo batch remembers the ids of the entries it undoes", async () => {
    const h = setup();
    await startAndWait(h, [removeBobFromWriters, { ...grantAuditRead, add: false }], { undoOf: ["b-1-2", "b-1-1"] });
    expect(h.flow().pending?.undoOf).toEqual(["b-1-2", "b-1-1"]);
  });

  test("a failing preview is kept as an error and can be asked for again", async () => {
    m.previewBatch.mockRejectedValueOnce({ kind: "other", message: "이 데이터베이스에서는 바꿀 수 없어요: rdsadmin" });
    const h = setup();
    act(() => h.flow().start("orders", CHANGES));
    await waitFor(() => expect(h.flow().pending?.error).toEqual({ kind: "preview", message: "이 데이터베이스에서는 바꿀 수 없어요: rdsadmin" }));
    expect(h.flow().pending?.preview).toBeNull();
    act(() => h.flow().apply(""));
    expect(m.applyBatch).not.toHaveBeenCalled();
    act(() => h.flow().retryPreview());
    await waitFor(() => expect(h.flow().pending?.preview).not.toBeNull());
    expect(h.flow().pending?.error).toBeNull();
    expect(m.previewBatch).toHaveBeenCalledTimes(2);
  });

  test("cancel closes the flow, and a preview that arrives afterwards is ignored", async () => {
    const slow = deferred<PgBatchPreview>();
    m.previewBatch.mockReturnValueOnce(slow.promise);
    const h = setup();
    act(() => h.flow().start("orders", CHANGES));
    act(() => h.flow().cancel());
    expect(h.flow().pending).toBeNull();
    await act(async () => slow.resolve(sampleBatchPreview()));
    expect(h.flow().pending).toBeNull();
  });

  test("starting another batch replaces the one still loading; only the newest preview counts", async () => {
    const first = deferred<PgBatchPreview>();
    m.previewBatch.mockReturnValueOnce(first.promise);
    const h = setup();
    act(() => h.flow().start("orders", CHANGES));
    act(() => h.flow().start("analytics", [grantAuditRead]));
    await waitFor(() => expect(h.flow().pending?.phase).toBe("ready"));
    expect(h.flow().pending).toMatchObject({ database: "analytics", changes: [grantAuditRead] });
    await act(async () => first.resolve(sampleBatchPreview({ database: "orders", loginUser: "낡은 미리보기" })));
    expect(h.flow().pending?.preview?.loginUser).not.toBe("낡은 미리보기");
    expect(h.flow().pending?.database).toBe("analytics");
  });

  test("the retry reads the preview of the same database and changes again", async () => {
    const h = setup();
    await startAndWait(h, CHANGES, undefined, "analytics");
    act(() => h.flow().retryPreview());
    await waitFor(() => expect(m.previewBatch).toHaveBeenCalledTimes(2));
    expect(m.previewBatch).toHaveBeenLastCalledWith(pgTarget, "analytics", CHANGES);
  });
});

describe("apply", () => {
  test("applies the previewed batch with no confirm text and no undo", async () => {
    const h = setup();
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).toHaveBeenCalledTimes(1);
    expect(m.applyBatch).toHaveBeenCalledWith(pgTarget, "orders", CHANGES, null, null);
  });

  test("sends the typed confirm text and passes the undo ids through, in the order of the changes", async () => {
    m.previewBatch.mockImplementation(async () => confirmBatch());
    const h = setup();
    await startAndWait(h, [removeBobFromWriters, { ...grantAuditRead, add: false }], { undoOf: ["b-1-2", "b-1-1"] });
    await act(async () => h.flow().apply(BATCH_CONFIRM));
    expect(m.applyBatch).toHaveBeenCalledWith(pgTarget, "orders", [removeBobFromWriters, { ...grantAuditRead, add: false }], BATCH_CONFIRM, ["b-1-2", "b-1-1"]);
  });

  test("never calls the backend while the confirm text is wrong, and never for a block in any change", async () => {
    m.previewBatch.mockImplementation(async () => confirmBatch());
    const h = setup();
    await startAndWait(h);
    for (const typed of ["", "변경 2개 적용 ", "변경 3개 적용"]) await act(async () => h.flow().apply(typed));
    expect(m.applyBatch).not.toHaveBeenCalled();

    const blocked = sampleBatchPreview();
    m.previewBatch.mockResolvedValue({ ...blocked, items: [{ ...blocked.items[0], warnings: [{ level: "block", message: "막혔어요", add: [] }] }, blocked.items[1]] });
    act(() => h.flow().retryPreview());
    await waitFor(() => expect(h.flow().pending?.preview?.items[0].warnings[0].level).toBe("block"));
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).not.toHaveBeenCalled();
  });

  test("never calls the backend before the preview has arrived", async () => {
    m.previewBatch.mockReturnValueOnce(new Promise(() => {}));
    const h = setup();
    act(() => h.flow().start("orders", CHANGES));
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).not.toHaveBeenCalled();
    expect(h.flow().pending?.phase).toBe("loading");
  });

  test("a double click applies once, and while applying cancel and a new start are ignored", async () => {
    const slow = deferred<PgBatchResult>();
    m.applyBatch.mockReturnValueOnce(slow.promise);
    const h = setup();
    await startAndWait(h);
    act(() => {
      h.flow().apply("");
      h.flow().apply("");
    });
    act(() => h.flow().cancel());
    act(() => h.flow().start("analytics", [grantAuditRead]));
    expect(m.applyBatch).toHaveBeenCalledTimes(1);
    expect(h.flow().pending).toMatchObject({ phase: "applying", database: "orders", changes: CHANGES });
    expect(m.previewBatch).toHaveBeenCalledTimes(1);
    await act(async () => slow.resolve(applied));
    expect(h.flow().pending).toBeNull();
  });

  test("success closes the flow, announces the summary of the backend and calls onApplied with the applied changes", async () => {
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, CHANGES, { onApplied });
    expect(onApplied).not.toHaveBeenCalled();
    await act(async () => h.flow().apply(""));
    expect(h.flow().pending).toBeNull();
    expect(h.flow().notices).toEqual([{ id: expect.any(Number), summary: "변경 2개", notes: [] }]);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledWith(CHANGES);
    act(() => h.flow().dismissNotice(h.flow().notices[0].id));
    expect(h.flow().notices).toEqual([]);
  });

  test("onApplied runs after the dialog is closed, so the tray is already empty when the overview comes back", async () => {
    let pendingAtCall: unknown = "unset";
    const h = setup();
    await startAndWait(h, CHANGES, {
      onApplied: () => {
        pendingAtCall = h.flow().pending;
      },
    });
    await act(async () => h.flow().apply(""));
    // 콜백이 불리는 때 흐름은 이미 닫히는 중이다(상태 갱신은 한 묶음이라 다음 렌더에 보인다): 콜백 뒤에도 닫혀 있다
    expect(pendingAtCall).not.toBe("unset");
    expect(h.flow().pending).toBeNull();
  });

  test("notes of the backend stay on the notice until it is dismissed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    m.applyBatch.mockResolvedValueOnce({ ...applied, notes: ["연결이 끊겼지만 적용된 것을 확인했어요"] });
    const h = setup();
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(h.flow().notices).toEqual([{ id: expect.any(Number), summary: "변경 2개", notes: ["연결이 끊겼지만 적용된 것을 확인했어요"] }]);
  });

  test("a callback that throws does not stop the refresh", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = setup();
    await settled(h);
    await startAndWait(h, CHANGES, {
      onApplied: () => {
        throw new Error("콜백 오류");
      },
    });
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(1));
    expect(h.flow().pending).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("onApplied belongs to the batch it was given for: a later batch does not inherit it", async () => {
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, CHANGES, { onApplied });
    act(() => h.flow().cancel());
    await startAndWait(h, [grantAuditRead]);
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).toHaveBeenCalledWith(pgTarget, "orders", [grantAuditRead], null, null);
    expect(onApplied).not.toHaveBeenCalled();
  });
});

describe("after a successful apply", () => {
  test("pg_overview replaces the overview at once and the screens are read again, without connecting again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = setup();
    await settled(h);
    m.role.mockClear();
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(h.result.current.overview.data?.fetchedAt).toBe(REREAD));
    expect(m.overview).toHaveBeenCalledTimes(1);
    expect(m.overview).toHaveBeenCalledWith(pgTarget);
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "orders", true));
    await waitFor(() => expect(m.role).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(m.changeLog).toHaveBeenCalledTimes(2));
    expect(m.open).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(m.overview).toHaveBeenCalledTimes(1);
  });

  test("the execution database is the batch's own database", async () => {
    const h = setup();
    await settled(h);
    m.database.mockClear();
    await startAndWait(h, [grantAuditRead], undefined, "analytics");
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", true));
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "orders", false));
  });

  test("marks the other queries of the target as stale and leaves other targets alone", async () => {
    const h = setup();
    await settled(h);
    const sessions = pgKeys.sessions(pgTarget);
    const other = pgKeys.role(otherTarget, "alice");
    h.qc.setQueryData(sessions, []);
    h.qc.setQueryData(other, { any: "thing" });
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.overview).toHaveBeenCalled());
    expect(h.qc.getQueryState(sessions)?.isInvalidated).toBe(true);
    expect(h.qc.getQueryState(other)?.isInvalidated).toBe(false);
  });
});

describe("a failed apply", () => {
  test("keeps the flow open with the error and refuses another apply until the preview is read again", async () => {
    m.applyBatch.mockRejectedValueOnce({ kind: "other", message: "적용하지 못했어요: permission denied for table events" });
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, CHANGES, { onApplied });
    await act(async () => h.flow().apply(""));

    expect(h.flow().pending).toMatchObject({ phase: "ready", stale: true, error: { kind: "apply", message: "적용하지 못했어요: permission denied for table events" } });
    expect(h.flow().notices).toEqual([]);
    expect(onApplied).not.toHaveBeenCalled();

    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).toHaveBeenCalledTimes(1);

    act(() => h.flow().retryPreview());
    await waitFor(() => expect(h.flow().pending?.stale).toBe(false));
    expect(m.previewBatch).toHaveBeenCalledTimes(2);
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).toHaveBeenCalledTimes(2);
    expect(h.flow().pending).toBeNull();
    expect(onApplied).toHaveBeenCalledWith(CHANGES);
  });

  test("reads the screens and the change log again: the failure is in the log, and the backend read the cluster again", async () => {
    m.applyBatch.mockRejectedValueOnce({ kind: "other", message: "미리보기 뒤에 바뀌었어요. 미리보기를 다시 받아 주세요" });
    const h = setup();
    await settled(h);
    await startAndWait(h);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(m.changeLog).toHaveBeenCalledTimes(2));
  });
});

describe("target", () => {
  test("changing the target drops an open flow, so a preview is never applied to another cluster", async () => {
    const h = setup(pgTarget);
    await startAndWait(h);
    h.rerender({ t: otherTarget });
    await waitFor(() => expect(h.flow().pending).toBeNull());
    await act(async () => h.flow().apply(""));
    expect(m.applyBatch).not.toHaveBeenCalled();
  });

  test("a closed tab does not announce or empty a tray when the answer arrives late", async () => {
    const slow = deferred<PgBatchResult>();
    m.applyBatch.mockReturnValueOnce(slow.promise);
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, CHANGES, { onApplied });
    act(() => h.flow().apply(""));
    const flow = h.flow();
    h.unmount();
    await act(async () => slow.resolve(applied));
    expect(onApplied).not.toHaveBeenCalled();
    expect(flow.notices).toEqual([]);
  });
});

test("start, apply and cancel are stable references, so they are safe as effect dependencies", () => {
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result, rerender } = renderHook(() => ({ flow: usePgBatch(pgTarget), n: useState(0) }), { wrapper });
  const { start, apply, cancel, retryPreview } = result.current.flow;
  act(() => result.current.n[1](1));
  rerender();
  expect(result.current.flow.start).toBe(start);
  expect(result.current.flow.apply).toBe(apply);
  expect(result.current.flow.cancel).toBe(cancel);
  expect(result.current.flow.retryPreview).toBe(retryPreview);
});

// 기본 권한도 담기가 담는 변경이 묶음에 들어갈 수 있다: 같은 데이터베이스의 변경이면 그대로 미리보기를 받는다
test("a batch can hold a default privilege change next to a grant", async () => {
  const h = setup();
  await startAndWait(h, [grantAuditRead, defaultAuditRead]);
  expect(m.previewBatch).toHaveBeenCalledWith(pgTarget, "orders", [grantAuditRead, defaultAuditRead]);
});
