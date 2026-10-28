import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { pgApi } from "./api";
import {
  LOGIN_USER,
  addBobToWriters,
  createCarol,
  grantAuditRead,
  pgTarget,
  resetAlicePassword,
  sampleDatabaseView,
  sampleOverview,
  samplePreview,
  sampleRoleView,
} from "./fixtures";
import { pgKeys, usePgChangeLog, usePgDatabase, usePgOverview, usePgRole } from "./queries";
import type { PgApplyResult, PgChange, PgPreview, PgTarget } from "./types";
import { usePgChange, type PgStartOptions } from "./usePgChange";

vi.mock("./api", () => ({
  pgApi: { preview: vi.fn(), apply: vi.fn(), overview: vi.fn(), open: vi.fn(), database: vi.fn(), role: vi.fn(), changeLog: vi.fn() },
}));

const m = vi.mocked(pgApi);
const applied: PgApplyResult = { logId: "log-9", summary: "권한 주기: app_read · audit 스키마의 모든 테이블 SELECT" };
const NEW_PASSWORD = "Xk3pQ9mZtR7vNb2WcH5yJd4a";
const REREAD = "2026-10-29T12:30:00Z";
// 전역 제약의 정확한 문구. 글이 바뀌면 시험이 알려 준다
const REFRESH_FAILED = "적용은 됐지만 목록을 다시 읽지 못했어요. [다시 읽기]를 눌러 주세요";
const confirmPreview = (change: PgChange, text = "app_read") =>
  samplePreview({ change, warnings: [{ level: "confirm", message: "되돌릴 수 없어요", add: [] }], confirmText: text });
const blockPreview = (change: PgChange) => samplePreview({ change, warnings: [{ level: "block", message: "시스템 역할이라 바꿀 수 없어요: rds_superuser", add: [] }] });

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

/** 화면이 켜 둔 쿼리들(개요, orders와 analytics의 데이터베이스 보기, alice의 역할 상세, 변경 기록)과 함께 흐름을 건다 */
function setup(target: PgTarget = pgTarget) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const hook = renderHook(
    ({ t }) => ({
      flow: usePgChange(t),
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

/** 미리보기가 도착해 확인을 기다리는 상태까지 간다 */
async function startAndWait(h: ReturnType<typeof setup>, change: PgChange, opts?: PgStartOptions) {
  act(() => h.flow().start(change, opts));
  await waitFor(() => expect(h.flow().pending?.phase).toBe("ready"));
}

/** 켜 둔 쿼리가 모두 처음 읽기를 마칠 때까지 */
const settled = (h: ReturnType<typeof setup>) =>
  waitFor(() => {
    const r = h.result.current;
    expect([r.overview, r.orders, r.analytics, r.role, r.log].every((q) => q.isSuccess)).toBe(true);
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.preview.mockImplementation(async (_t, change) => samplePreview({ change }));
  m.apply.mockResolvedValue(applied);
  m.open.mockResolvedValue(sampleOverview());
  m.overview.mockResolvedValue(sampleOverview({ fetchedAt: REREAD }));
  m.database.mockImplementation(async (_t, database) => sampleDatabaseView({ database }));
  m.role.mockImplementation(async (_t, role) => sampleRoleView(role));
  m.changeLog.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("preview", () => {
  test("start asks the backend for a preview of exactly that change and opens the flow", async () => {
    const h = setup();
    expect(h.flow().pending).toBeNull();
    act(() => h.flow().start(grantAuditRead));
    expect(h.flow().pending).toMatchObject({ target: pgTarget, change: grantAuditRead, phase: "loading", preview: null, undoOf: null, error: null, stale: false, password: null });
    expect(m.preview).toHaveBeenCalledWith(pgTarget, grantAuditRead);
    await waitFor(() => expect(h.flow().pending?.phase).toBe("ready"));
    expect(h.flow().pending?.preview).toEqual(samplePreview({ change: grantAuditRead }));
    expect(m.apply).not.toHaveBeenCalled();
  });

  test("remembers which entry an undo is for", async () => {
    const h = setup();
    await startAndWait(h, addBobToWriters, { undoOf: "log-1" });
    expect(h.flow().pending?.undoOf).toBe("log-1");
  });

  test("a failing preview is kept as an error and can be asked for again", async () => {
    m.preview.mockRejectedValueOnce({ kind: "other", message: "이 데이터베이스에서는 바꿀 수 없어요: rdsadmin" });
    const h = setup();
    act(() => h.flow().start(grantAuditRead));
    await waitFor(() => expect(h.flow().pending?.error).toEqual({ kind: "preview", message: "이 데이터베이스에서는 바꿀 수 없어요: rdsadmin" }));
    expect(h.flow().pending?.preview).toBeNull();
    expect(h.flow().pending?.phase).toBe("ready");

    act(() => h.flow().apply(""));
    expect(m.apply).not.toHaveBeenCalled();

    act(() => h.flow().retryPreview());
    await waitFor(() => expect(h.flow().pending?.preview).not.toBeNull());
    expect(h.flow().pending?.error).toBeNull();
    expect(m.preview).toHaveBeenCalledTimes(2);
  });

  test("cancel closes the flow, and a preview that arrives afterwards is ignored", async () => {
    const slow = deferred<PgPreview>();
    m.preview.mockReturnValueOnce(slow.promise);
    const h = setup();
    act(() => h.flow().start(grantAuditRead));
    act(() => h.flow().cancel());
    expect(h.flow().pending).toBeNull();
    await act(async () => slow.resolve(samplePreview()));
    expect(h.flow().pending).toBeNull();
  });

  test("apply after cancel does nothing: a closed flow has no preview to apply", async () => {
    const h = setup();
    await startAndWait(h, grantAuditRead);
    act(() => h.flow().cancel());
    await act(async () => h.flow().apply(""));
    expect(m.apply).not.toHaveBeenCalled();
  });

  test("onApplied belongs to the change it was given for: a later change does not inherit it", async () => {
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, grantAuditRead, { onApplied });
    act(() => h.flow().cancel());
    await startAndWait(h, addBobToWriters);
    await act(async () => h.flow().apply(""));
    expect(m.apply).toHaveBeenCalledWith(pgTarget, addBobToWriters, null, null);
    expect(onApplied).not.toHaveBeenCalled();
  });

  test("starting another change replaces the one still loading; only the newest preview counts", async () => {
    const first = deferred<PgPreview>();
    m.preview.mockReturnValueOnce(first.promise);
    const h = setup();
    act(() => h.flow().start(grantAuditRead));
    act(() => h.flow().start(addBobToWriters));
    await waitFor(() => expect(h.flow().pending?.phase).toBe("ready"));
    expect(h.flow().pending?.change).toEqual(addBobToWriters);
    await act(async () => first.resolve(samplePreview({ summary: "낡은 미리보기" })));
    expect(h.flow().pending?.preview?.summary).not.toBe("낡은 미리보기");
    expect(h.flow().pending?.change).toEqual(addBobToWriters);
  });
});

describe("apply", () => {
  test("applies the previewed change with no confirm text and no undo", async () => {
    const h = setup();
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    expect(m.apply).toHaveBeenCalledTimes(1);
    expect(m.apply).toHaveBeenCalledWith(pgTarget, grantAuditRead, null, null);
  });

  test("sends the typed confirm text and the undo id", async () => {
    m.preview.mockImplementation(async (_t, change) => confirmPreview(change, "app_read"));
    const h = setup();
    await startAndWait(h, grantAuditRead, { undoOf: "log-1" });
    await act(async () => h.flow().apply("app_read"));
    expect(m.apply).toHaveBeenCalledWith(pgTarget, grantAuditRead, "app_read", "log-1");
  });

  test("applyGate refuses a wrong, empty or differently cased confirm text", async () => {
    m.preview.mockImplementation(async (_t, change) => confirmPreview(change, "app_read"));
    const h = setup();
    await startAndWait(h, grantAuditRead);
    for (const typed of ["", "App_read", "app_read ", "alice"]) await act(async () => h.flow().apply(typed));
    expect(m.apply).not.toHaveBeenCalled();
    expect(h.flow().pending?.phase).toBe("ready");
  });

  test("applyGate refuses a preview with a block warning, whatever was typed", async () => {
    m.preview.mockImplementation(async (_t, change) => ({ ...blockPreview(change), confirmText: "app_read" }));
    const h = setup();
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply("app_read"));
    expect(m.apply).not.toHaveBeenCalled();
  });

  test("applyGate refuses a confirm warning with no text to type", async () => {
    m.preview.mockImplementation(async (_t, change) => samplePreview({ change, warnings: [{ level: "confirm", message: "확인하세요", add: [] }], confirmText: null }));
    const h = setup();
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    expect(m.apply).not.toHaveBeenCalled();
  });

  test("warn warnings alone do not stop the apply", async () => {
    const h = setup();
    await startAndWait(h, grantAuditRead);
    expect(h.flow().pending?.preview?.warnings.map((w) => w.level)).toEqual(["warn"]);
    await act(async () => h.flow().apply(""));
    expect(m.apply).toHaveBeenCalledTimes(1);
  });

  test("never calls the backend before the preview has arrived", async () => {
    m.preview.mockReturnValueOnce(new Promise(() => {}));
    const h = setup();
    act(() => h.flow().start(grantAuditRead));
    await act(async () => h.flow().apply(""));
    expect(m.apply).not.toHaveBeenCalled();
    expect(h.flow().pending?.phase).toBe("loading");
  });

  test("a double click applies once", async () => {
    const slow = deferred<PgApplyResult>();
    m.apply.mockReturnValueOnce(slow.promise);
    const h = setup();
    await startAndWait(h, grantAuditRead);
    act(() => {
      h.flow().apply("");
      h.flow().apply("");
    });
    expect(m.apply).toHaveBeenCalledTimes(1);
    expect(h.flow().pending?.phase).toBe("applying");
    await act(async () => slow.resolve(applied));
  });

  test("while applying, cancel and a new start are ignored", async () => {
    const slow = deferred<PgApplyResult>();
    m.apply.mockReturnValueOnce(slow.promise);
    const h = setup();
    await startAndWait(h, grantAuditRead);
    act(() => h.flow().apply(""));
    act(() => h.flow().cancel());
    act(() => h.flow().start(addBobToWriters));
    expect(h.flow().pending?.change).toEqual(grantAuditRead);
    expect(h.flow().pending?.phase).toBe("applying");
    expect(m.preview).toHaveBeenCalledTimes(1);
    await act(async () => slow.resolve(applied));
    expect(h.flow().pending).toBeNull();
  });

  test("success closes the flow, announces the summary and calls onApplied", async () => {
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, grantAuditRead, { onApplied });
    expect(h.flow().notices).toEqual([]);
    await act(async () => h.flow().apply(""));
    expect(h.flow().pending).toBeNull();
    expect(h.flow().notices).toEqual([{ id: expect.any(Number), summary: applied.summary, notes: [] }]);
    expect(onApplied).toHaveBeenCalledTimes(1);
    act(() => h.flow().dismissNotice(h.flow().notices[0].id));
    expect(h.flow().notices).toEqual([]);
  });

  test("the notice carries the notes of the backend and stays until it is dismissed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const noted: PgApplyResult = { ...applied, notes: ["연결이 끊겼지만 적용된 것을 확인했어요"] };
    m.apply.mockResolvedValueOnce(noted);
    const h = setup();
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    expect(h.flow().notices).toEqual([{ id: expect.any(Number), summary: applied.summary, notes: noted.notes }]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(h.flow().notices).toHaveLength(1);
  });

  test("a plain notice fades after a while", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = setup();
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    expect(h.flow().notices).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(h.flow().notices).toEqual([]);
  });
});

describe("after a successful apply", () => {
  test("pg_overview replaces the overview, at once and without connecting again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = setup();
    await settled(h);
    expect(h.result.current.overview.data?.fetchedAt).toBe("2026-10-28T12:00:00Z");
    expect(m.open).toHaveBeenCalledTimes(1);

    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    // 기다리지 않는다: IAM의 3초 뒤 다시 읽기가 없다
    await waitFor(() => expect(h.result.current.overview.data?.fetchedAt).toBe(REREAD));
    expect(m.overview).toHaveBeenCalledTimes(1);
    expect(m.overview).toHaveBeenCalledWith(pgTarget);
    expect(h.qc.getQueryData(pgKeys.overview(pgTarget, LOGIN_USER))).toEqual(sampleOverview({ fetchedAt: REREAD }));
    expect(m.open).toHaveBeenCalledTimes(1); // refreshPg(다시 읽기)와 달리 pg_open을 다시 부르지 않는다

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(m.overview).toHaveBeenCalledTimes(1);
    expect(m.open).toHaveBeenCalledTimes(1);
  });

  test("the execution database's view is read again with force, the other database's is not forced", async () => {
    m.preview.mockImplementation(async (_t, change) => samplePreview({ change, database: "analytics" }));
    const h = setup();
    await settled(h);
    m.database.mockClear();
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "analytics", true));
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "orders", false));
    expect(m.database).toHaveBeenCalledTimes(2);
  });

  test("the role views on screen are read again, after the execution database", async () => {
    const order: string[] = [];
    const h = setup();
    await settled(h);
    m.database.mockImplementation(async (_t, database, force) => {
      order.push(`database:${database}:${force}`);
      return sampleDatabaseView({ database });
    });
    m.role.mockImplementation(async (_t, role) => {
      order.push(`role:${role}`);
      return sampleRoleView(role);
    });
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(order).toContain("role:alice"));
    expect(order.indexOf("database:orders:true")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("database:orders:true")).toBeLessThan(order.indexOf("role:alice"));
  });

  test("marks every other query of the target as stale and leaves other targets alone", async () => {
    const h = setup();
    await settled(h);
    const cell = pgKeys.cell(pgTarget, "orders", "alice", "app");
    const sessions = pgKeys.sessions(pgTarget);
    const findings = pgKeys.findings(pgTarget);
    const other = pgKeys.role(otherTarget, "alice");
    for (const key of [cell, sessions, findings, other]) h.qc.setQueryData(key, { any: "thing" });
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.overview).toHaveBeenCalled());
    for (const key of [cell, sessions, findings]) expect(h.qc.getQueryState(key)?.isInvalidated, String(key)).toBe(true);
    expect(h.qc.getQueryState(other)?.isInvalidated).toBe(false);
  });

  test("marks the change log as stale, and reads it again when it is on screen", async () => {
    const h = setup();
    await settled(h);
    expect(m.changeLog).toHaveBeenCalledTimes(1);
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.changeLog).toHaveBeenCalledTimes(2));
  });

  test("an overview nobody asked for is not created by the refresh", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => usePgChange(pgTarget), { wrapper });
    act(() => result.current.start(grantAuditRead));
    await waitFor(() => expect(result.current.pending?.phase).toBe("ready"));
    await act(async () => result.current.apply(""));
    await waitFor(() => expect(m.overview).toHaveBeenCalled());
    await act(async () => {}); // 개요를 받은 뒤의 일까지 마친다
    expect(qc.getQueryState(pgKeys.overview(pgTarget, LOGIN_USER))).toBeUndefined();
  });
});

describe("when the list cannot be read again after a successful apply", () => {
  const NO_CONNECTION = { kind: "other", message: "먼저 연결해 주세요" };

  test("the success notice stays and says so with the exact words, as a note that keeps it until it is dismissed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    m.overview.mockRejectedValue(NO_CONNECTION);
    const h = setup();
    await settled(h);
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(h.flow().notices).toEqual([{ id: expect.any(Number), summary: applied.summary, notes: [REFRESH_FAILED] }]));
    expect(h.flow().pending).toBeNull(); // 적용은 성공했다
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(h.flow().notices).toHaveLength(1);
    act(() => h.flow().dismissNotice(h.flow().notices[0].id));
    expect(h.flow().notices).toEqual([]);
  });

  test("the notes of the backend come first", async () => {
    m.apply.mockResolvedValueOnce({ ...applied, notes: ["연결이 끊겼지만 적용된 것을 확인했어요"] });
    m.overview.mockRejectedValue(NO_CONNECTION);
    const h = setup();
    await settled(h);
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(h.flow().notices[0]?.notes).toEqual(["연결이 끊겼지만 적용된 것을 확인했어요", REFRESH_FAILED]));
    expect(h.flow().notices).toHaveLength(1);
  });

  test("a list that was read says nothing extra", async () => {
    const h = setup();
    await settled(h);
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(h.result.current.overview.data?.fetchedAt).toBe(REREAD));
    expect(h.flow().notices).toEqual([{ id: expect.any(Number), summary: applied.summary, notes: [] }]);
  });

  test("nothing connects again by itself: the user is told to press 다시 읽기", async () => {
    m.overview.mockRejectedValue(NO_CONNECTION);
    const h = setup();
    await settled(h);
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(h.flow().notices[0]?.notes).toEqual([REFRESH_FAILED]));
    expect(m.open).toHaveBeenCalledTimes(1);
    expect(h.result.current.overview.data?.fetchedAt).toBe("2026-10-28T12:00:00Z"); // 낡은 개요 그대로다
  });

  test("the rest of the refresh still runs", async () => {
    m.overview.mockRejectedValue(NO_CONNECTION);
    const h = setup();
    await settled(h);
    m.database.mockClear();
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "orders", true));
    await waitFor(() => expect(m.changeLog).toHaveBeenCalledTimes(2));
  });

  test("a notice that faded before the refresh gave up comes back with the note", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const slow = deferred<ReturnType<typeof sampleOverview>>();
    m.overview.mockReturnValueOnce(slow.promise);
    const h = setup();
    await settled(h);
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    expect(h.flow().notices[0]?.notes).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(h.flow().notices).toEqual([]);
    await act(async () => slow.reject(NO_CONNECTION));
    await waitFor(() => expect(h.flow().notices).toEqual([{ id: expect.any(Number), summary: applied.summary, notes: [REFRESH_FAILED] }]));
  });

  test("a failed apply never says it was applied: the dialog's own error is what shows", async () => {
    m.apply.mockRejectedValueOnce({ kind: "other", message: "적용하지 못했어요: permission denied" });
    m.overview.mockRejectedValue(NO_CONNECTION);
    const h = setup();
    await settled(h);
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.overview).toHaveBeenCalled());
    await act(async () => {});
    expect(h.flow().notices).toEqual([]);
    expect(h.flow().pending?.error?.message).toBe("적용하지 못했어요: permission denied");
  });

  test("with a new password the note is there too, and the password is still nowhere but in the pending state", async () => {
    m.apply.mockResolvedValueOnce({ logId: "log-10", summary: "역할 만들기: carol", password: NEW_PASSWORD });
    m.overview.mockRejectedValue(NO_CONNECTION);
    const h = setup();
    await settled(h);
    await startAndWait(h, createCarol);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(h.flow().notices[0]?.notes).toEqual([REFRESH_FAILED]));
    expect(h.flow().pending?.phase).toBe("password");
    expect(JSON.stringify(h.flow().notices)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(h.qc.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(NEW_PASSWORD);
  });
});

describe("a failed apply", () => {
  test("keeps the flow open with the error and refuses another apply until the preview is read again", async () => {
    m.apply.mockRejectedValueOnce({ kind: "other", message: "적용하지 못했어요: permission denied for table events" });
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, grantAuditRead, { onApplied });
    await act(async () => h.flow().apply(""));

    expect(h.flow().pending).toMatchObject({ phase: "ready", stale: true, error: { kind: "apply", message: "적용하지 못했어요: permission denied for table events" } });
    expect(h.flow().notices).toEqual([]);
    expect(onApplied).not.toHaveBeenCalled();

    await act(async () => h.flow().apply(""));
    expect(m.apply).toHaveBeenCalledTimes(1); // 낡은 미리보기로는 다시 적용하지 않는다

    act(() => h.flow().retryPreview());
    await waitFor(() => expect(h.flow().pending?.stale).toBe(false));
    expect(m.preview).toHaveBeenCalledTimes(2);
    expect(h.flow().pending?.error).toBeNull();
    await act(async () => h.flow().apply(""));
    expect(m.apply).toHaveBeenCalledTimes(2);
    expect(h.flow().pending).toBeNull();
  });

  test("the backend's stale refusal leads to a fresh preview, which can then be applied", async () => {
    const STALE = "미리보기 뒤에 바뀌었어요. 미리보기를 다시 받아 주세요";
    m.apply.mockRejectedValueOnce({ kind: "other", message: STALE });
    const h = setup();
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    expect(h.flow().pending).toMatchObject({ phase: "ready", stale: true, error: { kind: "apply", message: STALE } });

    const changed = samplePreview({ change: grantAuditRead, sql: ['GRANT SELECT ON ALL TABLES IN SCHEMA "audit" TO "app_read"', 'GRANT USAGE ON SCHEMA "audit" TO "app_read"'] });
    m.preview.mockResolvedValueOnce(changed);
    act(() => h.flow().retryPreview());
    await waitFor(() => expect(h.flow().pending?.preview).toBe(changed));
    expect(h.flow().pending).toMatchObject({ stale: false, error: null });
    await act(async () => h.flow().apply(""));
    expect(m.apply).toHaveBeenCalledTimes(2);
    expect(h.flow().pending).toBeNull();
  });

  test("reads the screens and the change log again, since the log has the failure and the connection may have dropped at COMMIT", async () => {
    m.apply.mockRejectedValueOnce({ kind: "other", message: "데이터베이스 연결이 끊겨 적용됐는지 알 수 없어요. 다시 읽어서 확인해 주세요" });
    const h = setup();
    await settled(h);
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(m.database).toHaveBeenCalledWith(pgTarget, "orders", true));
    await waitFor(() => expect(m.changeLog).toHaveBeenCalledTimes(2));
    expect(h.flow().pending?.error?.message).toBe("데이터베이스 연결이 끊겨 적용됐는지 알 수 없어요. 다시 읽어서 확인해 주세요");
  });

  test("the confirm text has to be typed again for the refreshed preview", async () => {
    m.preview.mockImplementation(async (_t, change) => confirmPreview(change, "app_read"));
    m.apply.mockRejectedValueOnce({ kind: "other", message: "실패" });
    const h = setup();
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply("app_read"));
    act(() => h.flow().retryPreview());
    await waitFor(() => expect(h.flow().pending?.stale).toBe(false));
    await act(async () => h.flow().apply("")); // 비어 있으면 여전히 막힌다
    expect(m.apply).toHaveBeenCalledTimes(1);
  });
});

describe("a new password", () => {
  const passwordResult: PgApplyResult = { logId: "log-10", summary: "역할 만들기: carol", password: NEW_PASSWORD };

  /** 비밀번호가 hook 상태, 안내, 쿼리 캐시, 변경(mutation) 캐시 어디에도 없다 */
  const nowhere = (h: ReturnType<typeof setup>) => {
    const dump = JSON.stringify({
      flow: h.flow(),
      queries: h.qc.getQueryCache().getAll().map((q) => q.state.data),
      mutations: h.qc.getMutationCache().getAll().map((x) => x.state),
    });
    expect(dump).not.toContain(NEW_PASSWORD);
  };

  test("a result with a password switches the dialog to the password phase instead of closing it", async () => {
    m.apply.mockResolvedValueOnce(passwordResult);
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, createCarol, { onApplied });
    await act(async () => h.flow().apply(""));
    expect(h.flow().pending).toMatchObject({ phase: "password", password: NEW_PASSWORD, change: createCarol, error: null, stale: false });
    expect(onApplied).toHaveBeenCalledTimes(1); // 적용은 끝났다
  });

  test("the notice names the change and never carries the password", async () => {
    m.apply.mockResolvedValueOnce(passwordResult);
    const h = setup();
    await startAndWait(h, createCarol);
    await act(async () => h.flow().apply(""));
    expect(h.flow().notices).toEqual([{ id: expect.any(Number), summary: "역할 만들기: carol", notes: [] }]);
    expect(JSON.stringify(h.flow().notices)).not.toContain(NEW_PASSWORD);
  });

  test("the password is only in the hook's pending state: not in the query cache, not in a mutation", async () => {
    m.apply.mockResolvedValueOnce(passwordResult);
    const h = setup();
    await settled(h);
    await startAndWait(h, createCarol);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.overview).toHaveBeenCalled());
    expect(JSON.stringify(h.flow().pending)).toContain(NEW_PASSWORD);
    expect(JSON.stringify(h.flow().notices)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(h.qc.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(h.qc.getMutationCache().getAll().map((x) => x.state))).not.toContain(NEW_PASSWORD);
  });

  test("closing drops it from the state: the flow is gone, and so is every trace of the password", async () => {
    m.apply.mockResolvedValueOnce(passwordResult);
    const h = setup();
    await settled(h);
    await startAndWait(h, createCarol);
    await act(async () => h.flow().apply(""));
    expect(h.flow().pending?.phase).toBe("password");
    act(() => h.flow().cancel());
    expect(h.flow().pending).toBeNull();
    nowhere(h);
  });

  test("a new flow cannot start over the password: it would be lost for good", async () => {
    m.apply.mockResolvedValueOnce(passwordResult);
    const h = setup();
    await startAndWait(h, createCarol);
    await act(async () => h.flow().apply(""));
    act(() => h.flow().start(grantAuditRead));
    expect(h.flow().pending).toMatchObject({ phase: "password", password: NEW_PASSWORD, change: createCarol });
    expect(m.preview).toHaveBeenCalledTimes(1);
    act(() => h.flow().retryPreview());
    expect(m.preview).toHaveBeenCalledTimes(1);
    expect(h.flow().pending?.password).toBe(NEW_PASSWORD);
  });

  test("a password reset ends in the password phase too, and apply does nothing there", async () => {
    m.apply.mockResolvedValueOnce({ logId: "log-11", summary: "비밀번호 재설정: alice", password: NEW_PASSWORD });
    const h = setup();
    await startAndWait(h, resetAlicePassword);
    await act(async () => h.flow().apply(""));
    expect(h.flow().pending?.phase).toBe("password");
    await act(async () => h.flow().apply(""));
    expect(m.apply).toHaveBeenCalledTimes(1);
  });

  test("a result without a password closes the flow, as before", async () => {
    const h = setup();
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    expect(h.flow().pending).toBeNull();
  });

  test("the screens are read again at once, while the password is still shown", async () => {
    m.apply.mockResolvedValueOnce(passwordResult);
    const h = setup();
    await settled(h);
    await startAndWait(h, createCarol);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(1));
    expect(h.flow().pending?.phase).toBe("password");
  });
});

describe("target", () => {
  test("changing the target drops an open flow, so a preview is never applied to another cluster", async () => {
    const h = setup(pgTarget);
    await startAndWait(h, grantAuditRead);
    h.rerender({ t: otherTarget });
    await waitFor(() => expect(h.flow().pending).toBeNull());
    await act(async () => h.flow().apply(""));
    expect(m.apply).not.toHaveBeenCalled();
  });

  test("a new object for the same target keeps the flow", async () => {
    const h = setup(pgTarget);
    await startAndWait(h, grantAuditRead);
    h.rerender({ t: { ...pgTarget } });
    expect(h.flow().pending?.phase).toBe("ready");
  });

  test("applies with the target the preview was made for", async () => {
    const h = setup(pgTarget);
    await startAndWait(h, grantAuditRead);
    await act(async () => h.flow().apply(""));
    expect(m.preview).toHaveBeenCalledWith(pgTarget, grantAuditRead);
    expect(m.apply).toHaveBeenCalledWith(pgTarget, grantAuditRead, null, null);
  });
});

describe("a closed tab", () => {
  // 탭이 닫힌 뒤에 온 응답은 어디에도 쓰이지 않는다: 안내도, 콜백도, 다시 읽기도 없다. 성공이든 실패든 같다.
  async function closeWhileApplying(onApplied?: () => void) {
    const slow = deferred<PgApplyResult>();
    m.apply.mockReturnValueOnce(slow.promise);
    const h = setup();
    await settled(h);
    await startAndWait(h, grantAuditRead, { onApplied });
    act(() => h.flow().apply(""));
    expect(h.flow().pending?.phase).toBe("applying");
    h.unmount();
    vi.clearAllMocks();
    return slow;
  }

  test("a late success calls nothing back and reads nothing again", async () => {
    const onApplied = vi.fn();
    const slow = await closeWhileApplying(onApplied);
    await act(async () => slow.resolve(applied));
    expect(onApplied).not.toHaveBeenCalled();
    expect(m.overview).not.toHaveBeenCalled();
  });

  test("a late failure reads nothing again either", async () => {
    const slow = await closeWhileApplying();
    await act(async () => slow.reject({ kind: "other", message: "적용하지 못했어요" }));
    expect(m.overview).not.toHaveBeenCalled();
  });

  test("a late answer, either way, makes no noise: no error is logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = await closeWhileApplying();
    await act(async () => ok.resolve(applied));
    const bad = await closeWhileApplying();
    await act(async () => bad.reject(new Error("x")));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

test("start, apply and cancel are stable references, so they are safe as effect dependencies", () => {
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result, rerender } = renderHook(() => ({ flow: usePgChange(pgTarget), n: useState(0) }), { wrapper });
  const { start, apply, cancel, retryPreview } = result.current.flow;
  act(() => result.current.n[1](1));
  rerender();
  expect(result.current.flow.start).toBe(start);
  expect(result.current.flow.apply).toBe(apply);
  expect(result.current.flow.cancel).toBe(cancel);
  expect(result.current.flow.retryPreview).toBe(retryPreview);
});
